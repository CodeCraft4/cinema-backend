"use strict";

/**
 * TorBox Debrid Cloud Caching & Instant Streaming Service.
 *
 * Converts BitTorrent magnet links into high-speed, direct HTTPS streaming
 * and downloading URLs (up to 1-80 Gbps) with zero VPS bandwidth and zero seeder waits.
 */

const env = require("../config/env");
const { memoryCache } = require("./memoryCache");
const { episodeScope } = require("./releaseAudio");

const TORBOX_BASE_URL = "https://api.torbox.app/v1/api";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch + JSON for TorBox. TorBox answers bursts with 429 or a plain-text
 * "rate limit exceeded" body; wait and retry instead of failing the stream.
 */
async function tbRequest(url, options = {}, timeoutMs = 6000, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const limited = res.status === 429 || /rate limit/i.test(text);
    if (limited && attempt < retries) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body (rate limit page / gateway error)
    }
    return { ok: res.ok, status: res.status, json, limited };
  }
}

function getApiKey() {
  return env.torboxApiKey || process.env.TORBOX_API_KEY || "";
}

/**
 * Extract clean 40-character InfoHash from a magnet link or hash string.
 */
function extractInfoHash(magnetOrHash) {
  if (!magnetOrHash) return null;
  const str = String(magnetOrHash).trim();
  const hexMatch = str.match(/(?:urn:btih:)?([a-fA-F0-9]{40})/i);
  if (hexMatch) return hexMatch[1].toLowerCase();
  const b32Match = str.match(/(?:urn:btih:)?([a-zA-Z2-7]{32})/i);
  if (b32Match) return b32Match[1].toLowerCase();
  return null;
}

/**
 * Clean magnet link to avoid header/newline injection issues.
 */
function sanitizeMagnet(magnet) {
  if (!magnet) return "";
  return String(magnet).replace(/[\r\n\t]+/g, "").trim();
}

/**
 * Check if a torrent hash is already 100% cached on TorBox.
 * @param {string} hash - 40-char infoHash
 * @returns {Promise<boolean>}
 */
async function checkCached(hash) {
  const apiKey = getApiKey();
  if (!apiKey || !hash) return false;
  const lower = String(hash).toLowerCase();
  const key = `torbox:cached:${lower}`;
  const known = memoryCache.get(key);
  if (known === "yes") return true;
  if (known === "no") return false;

  try {
    const { json } = await tbRequest(
      `${TORBOX_BASE_URL}/torrents/checkcached?hash=${lower}&format=object`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      8000
    );
    // No usable answer (rate limited / outage): unknown, the caller decides.
    if (!json || !json.success) return null;
    const entry = json.data && (json.data[lower] || json.data[lower.toUpperCase()]);
    const isCached = Boolean(entry);
    memoryCache.set(key, isCached ? "yes" : "no", isCached ? 60 * 60 * 1000 : 3 * 60 * 1000);
    return isCached;
  } catch (err) {
    console.warn("[TorboxService] checkCached error:", err.message);
    return null;
  }
}

/**
 * Submit magnet link to TorBox.
 * @param {string} magnet - Magnet URI
 * @returns {Promise<{ torrent_id: number, hash: string } | null>}
 */
async function createTorrent(magnet) {
  const apiKey = getApiKey();
  if (!apiKey || !magnet) return null;

  try {
    const clean = sanitizeMagnet(magnet);
    const body = new URLSearchParams();
    body.append("magnet", clean);
    body.append("seed", "1"); // Auto seed
    body.append("allow_zip", "false");

    const { json } = await tbRequest(`${TORBOX_BASE_URL}/torrents/createtorrent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (json?.success && json.data) {
      return json.data;
    }
    console.warn("[TorboxService] createtorrent failed:", json?.detail || json?.error || "no response");
    return null;
  } catch (err) {
    console.warn("[TorboxService] createtorrent request error:", err.message);
    return null;
  }
}

/**
 * Retrieve file list for an added torrent.
 * @param {number} torrentId
 * @returns {Promise<Array<object> | null>}
 */
async function getTorrentFiles(torrentId) {
  const apiKey = getApiKey();
  if (!apiKey || !torrentId) return null;

  try {
    const { json } = await tbRequest(
      `${TORBOX_BASE_URL}/torrents/mylist?id=${torrentId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      5000
    );
    if (json?.success && json.data) {
      const item = Array.isArray(json.data) ? json.data[0] : json.data;
      // If torrent has 0 seeds / 0% progress and is not cached (like 3 months ETA), return null to trigger instant server fallback
      if (item && !item.cached && !item.download_present && item.progress !== 1) {
        console.warn(`[TorboxService] Torrent ${torrentId} not ready/cached yet (progress: ${item.progress ?? 0}). Falling back to cloud servers.`);
        return null;
      }
      return item?.files || null;
    }
    return null;
  } catch (err) {
    console.warn("[TorboxService] getTorrentFiles error:", err.message);
    return null;
  }
}

/**
 * Pick the largest primary media/video file (ignoring samples, txt, nfo).
 */
function pickPrimaryVideoFile(files, season = null, episode = null, options = {}) {
  if (!Array.isArray(files) || files.length === 0) return null;

  if (options && options.fileIndex != null) {
    const idx = Number(options.fileIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx < files.length) {
      return files[idx];
    }
  }

  const videoFiles = files.filter((f) => {
    const name = String(f.name || f.short_name || "").toLowerCase();
    const isVideo =
      name.endsWith(".mp4") ||
      name.endsWith(".mkv") ||
      name.endsWith(".avi") ||
      name.endsWith(".mov") ||
      name.endsWith(".webm");
    const isSample = name.includes("sample") || (f.size && f.size < 50 * 1024 * 1024);
    return isVideo && !isSample;
  });

  if (videoFiles.length === 0) {
    const sorted = [...files].sort((a, b) => (b.size || 0) - (a.size || 0));
    return sorted[0] || null;
  }

  // If episode is provided (TV show), only the matching episode file inside the pack is valid.
  // Never fall back to the largest/first file: that served S01E01 for every episode.
  if (episode != null) {
    const epNum = Number(episode);
    const sNum = season != null ? Number(season) : 1;
    const fileName = (f) => String(f.name || f.short_name || "");

    // The episode's own file name, stored from Torrentio's per-episode index ("EP05.mkv").
    if (options.fileName) {
      const named = videoFiles.find((f) => baseName(fileName(f)) === baseName(options.fileName));
      if (named) return named;
    }

    // Files carrying their own SxxEyy tag must match season and episode exactly.
    const exact = videoFiles.find((f) => episodeScope(fileName(f), sNum, epNum) === "exact");
    if (exact) return exact;

    // Untagged files (e.g. "Season 1/05 - Title.mkv", "1x05", "Episode 5").
    const patterns = [
      new RegExp(`\\b${sNum}x0*${epNum}(?!\\d)`, "i"),
      new RegExp(`\\bep(?:isode)?[._ -]*0*${epNum}(?!\\d)`, "i"),
      new RegExp(`\\be0*${epNum}(?!\\d)`, "i"),
      new RegExp(`(?:^|[\\s._\\-\\[\\(])(?:ep|episode|e)?0*${epNum}(?:[\\s._\\-\\]\\)]|$)`, "i"),
      new RegExp(`(?:^|/)0*${epNum}(?!\\d)[^/]*$`, "i"),
    ];
    const untagged = videoFiles.filter((f) => episodeScope(fileName(f), sNum, epNum) === "pack");
    for (const pattern of patterns) {
      const match = untagged.find((f) => pattern.test(fileName(f)));
      if (match) return match;
    }

    // A single-file torrent already scoped to this episode by its release name.
    if (options.singleEpisode && videoFiles.length === 1) return videoFiles[0];

    // Last resort for a one-season pack whose files carry no episode number at all:
    // files in natural name order are the episodes in order.
    if (untagged.length === videoFiles.length && videoFiles.length >= epNum && videoFiles.length <= 40) {
      const ordered = [...videoFiles].sort((a, b) =>
        fileName(a).localeCompare(fileName(b), undefined, { numeric: true, sensitivity: "base" })
      );
      return ordered[epNum - 1] || null;
    }
    return null;
  }

  // Multi-film pack: only the named file is this film. The largest file would be another part.
  if (options.fileName) {
    const wanted = baseName(options.fileName);
    return videoFiles.find((f) => baseName(f.name || f.short_name) === wanted) || null;
  }

  // Fallback to largest video file
  videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
  return videoFiles[0];
}

function baseName(name) {
  return String(name || "").split(/[\\/]/).pop().trim().toLowerCase();
}

/**
 * Request high-speed direct download & streaming URL for a specific file.
 * @param {number} torrentId
 * @param {number} fileId
 * @returns {Promise<string | null>} Direct HTTPS URL
 */
async function requestDownloadLink(torrentId, fileId) {
  const apiKey = getApiKey();
  if (!apiKey || !torrentId) return null;

  try {
    const targetFile = fileId != null ? `&file_id=${fileId}` : "";
    const { json } = await tbRequest(
      `${TORBOX_BASE_URL}/torrents/requestdl?token=${encodeURIComponent(
        apiKey
      )}&torrent_id=${torrentId}${targetFile}&zip=false`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (json?.success && json.data) {
      return typeof json.data === "string" ? json.data : json.data.url || null;
    }
    return null;
  } catch (err) {
    console.warn("[TorboxService] requestDownloadLink error:", err.message);
    return null;
  }
}

/**
 * Torrent id + file list of a magnet, cached per info hash. All episodes of a season pack
 * share one hash, so the 2nd..Nth episode skips createtorrent + mylist (fewer TorBox calls,
 * far less rate limiting, and a faster start).
 */
async function getPackFiles(magnet) {
  const hash = extractInfoHash(magnet);
  if (!hash) return null;
  const key = `torbox:pack:${hash}`;
  const hit = memoryCache.get(key);
  if (hit) return hit;
  // Never add a torrent TorBox has not cached: it would sit in the account's queue (slots +
  // storage) without ever being playable. false = not cached; null = unknown -> try anyway.
  if ((await checkCached(hash)) === false) return null;
  const created = await createTorrent(magnet);
  if (!created || !created.torrent_id) return null;
  let files = await getTorrentFiles(created.torrent_id);
  if (!files || files.length === 0) {
    await sleep(800);
    files = await getTorrentFiles(created.torrent_id);
  }
  if (!files || files.length === 0) return null;
  const pack = { torrentId: created.torrent_id, name: created.name || null, files };
  memoryCache.set(key, pack, 30 * 60 * 1000);
  return pack;
}

// ── On-demand caching: a title TorBox has not cached yet is added when a user opens it ──────
const warming = new Map(); // info hash -> { torrentId, at }
const MAX_WARMING = 3; // = TorBox active download slots: more would only sit in its waiting queue
const WARM_STALE_MS = 30 * 60 * 1000;

function activeWarmCount() {
  const now = Date.now();
  for (const [hash, w] of warming) if (now - w.at > WARM_STALE_MS) warming.delete(hash);
  return warming.size;
}

/**
 * Ask TorBox to cache a magnet the user wants to watch, and report how far it is.
 * state: "ready" (cached, play it) | "caching" (progress 0..1) | "busy" | "stalled" | "error"
 */
async function ensureCaching(magnet) {
  const apiKey = getApiKey();
  const hash = extractInfoHash(magnet);
  if (!apiKey || !hash) return { state: "error" };

  if (memoryCache.get(`torbox:dead:${hash}`)) return { state: "stalled" }; // dead swarm: never re-add it
  const known = warming.get(hash);
  if (!known) {
    // Cached after all (e.g. another user's request finished it)?
    if ((await checkCached(hash)) === true) return { state: "ready" };
    if (activeWarmCount() >= MAX_WARMING) return { state: "busy" };
    const created = await createTorrent(magnet);
    if (!created || !created.torrent_id) return { state: "error" };
    warming.set(hash, { torrentId: created.torrent_id, at: Date.now() });
    return { state: "caching", progress: 0 };
  }

  // Already added: read its live status (no cache).
  const { json } = await tbRequest(
    `${TORBOX_BASE_URL}/torrents/mylist?id=${known.torrentId}&bypass_cache=true`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    5000
  );
  const item = json?.success ? (Array.isArray(json.data) ? json.data[0] : json.data) : null;
  if (!item) {
    warming.delete(hash);
    return { state: "error" };
  }
  if (item.cached || item.download_present || item.progress === 1) {
    warming.delete(hash);
    memoryCache.set(`torbox:cached:${hash}`, "yes", 60 * 60 * 1000);
    return { state: "ready" };
  }
  const stateText = String(item.download_state || "").toLowerCase();
  const waitedMs = Date.now() - known.at;
  if (/stalled|failed|error/.test(stateText) || (waitedMs > 4 * 60 * 1000 && !(item.progress > 0))) {
    // Dead swarm: remove the torrent we added so its slot is free for the next movie.
    warming.delete(hash);
    await tbRequest(
      `${TORBOX_BASE_URL}/torrents/controltorrent`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ torrent_id: known.torrentId, operation: "delete" }),
      },
      5000
    ).catch(() => null);
    memoryCache.set(`torbox:cached:${hash}`, "no", 30 * 60 * 1000);
    memoryCache.set(`torbox:dead:${hash}`, true, 6 * 60 * 60 * 1000);
    return { state: "stalled", progress: Number(item.progress) || 0 };
  }
  return {
    state: "caching",
    progress: Number(item.progress) || 0,
    etaSeconds: Number(item.eta) > 0 ? Number(item.eta) : null,
    seeds: Number(item.seeds) || 0,
  };
}

/**
 * High-Level Orchestrator:
 * Resolves a BitTorrent Magnet Link into an instant high-speed HTTPS Stream & Download URL.
 *
 * @param {string} magnetLink
 * @returns {Promise<{ success: boolean, streamUrl: string, downloadUrl: string, fileName: string, isCached: boolean } | null>}
 */
async function resolveDirectTorboxStream(magnetLink, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey || !magnetLink) return null;

  const hash = extractInfoHash(magnetLink);
  if (!hash) return null;

  const season = options?.season ?? null;
  const episode = options?.episode ?? null;
  const fileIndex = options?.fileIndex ?? options?.fileIdx ?? null;

  // 1. Check in-memory cache first (2-hour TTL to match link validity)
  const epKey = episode != null ? `:s${season ?? 1}e${episode}` : "";
  const fileIdxKey = fileIndex != null ? `:idx${fileIndex}` : "";
  // Films of one pack share a hash, so the file name is part of the key.
  const fileKey = options?.fileName ? `:f:${baseName(options.fileName)}` : "";
  const cacheKey = `torbox:link:${hash}${epKey}${fileIdxKey}${fileKey}`;
  const cached = memoryCache.get(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  try {
    // 2-3. Add the torrent (or reuse it) and read its files; cached per pack.
    const pack = await getPackFiles(magnetLink);
    if (!pack) return null;
    const created = { torrent_id: pack.torrentId, name: pack.name };
    const files = pack.files;
    const primaryFile = pickPrimaryVideoFile(files, season, episode, {
      singleEpisode: options?.singleEpisode,
      fileName: options?.fileName,
      fileIndex,
    });
    if (!primaryFile || primaryFile.id == null) {
      if (episode != null) console.warn(`[TorboxService] S${season}E${episode} not found in torrent ${created.torrent_id}`);
      else if (options?.fileName) console.warn(`[TorboxService] "${options.fileName}" not found in torrent ${created.torrent_id}`);
      return null;
    }

    // 4. Request direct download URL
    const directUrl = await requestDownloadLink(created.torrent_id, primaryFile.id);
    if (!directUrl) return null;

    const result = {
      success: true,
      streamUrl: directUrl,
      downloadUrl: directUrl,
      fileName: primaryFile?.name || created.name || "video.mp4",
      fileSize: primaryFile?.size || 0,
      isCached: true,
      provider: "torbox",
    };

    // Cache for 2 hours (TorBox presigned links are valid for 3 hours)
    memoryCache.set(cacheKey, result, 2 * 60 * 60 * 1000);
    return result;
  } catch (err) {
    console.warn("[TorboxService] resolveDirectTorboxStream failed:", err.message);
    return null;
  }
}

module.exports = {
  checkCached,
  createTorrent,
  getTorrentFiles,
  getPackFiles,
  ensureCaching,
  requestDownloadLink,
  resolveDirectTorboxStream,
  extractInfoHash,
  pickPrimaryVideoFile,
};
