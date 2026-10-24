"use strict";

const torrentStream = require("torrent-stream");
const axios = require("axios");
const path = require("path");
const os = require("os");
const fs = require("fs");

const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://p4p.arenabg.com:1337/announce",
  "udp://9.rarbg.to:2920/announce",
  "udp://tracker.cyberia.is:6969/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://retracker.lanta-net.ru:2710/announce",
  "udp://tracker.internetwarriors.net:1337/announce",
  "http://tracker.opentrackr.org:1337/announce",
  "http://tracker.openbittorrent.com:80/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.webtorrent.io",
];

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
  ".mov",
  ".flv",
  ".ts",
  ".wmv",
]);

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ts": "video/mp2t",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
};

// Use project virtual disk instead of os.tmpdir() (/tmp is mounted as tmpfs in RAM on Railway/Docker, which caused the 512MB OOM crash!)
const CACHE_DIR = process.env.TORRENT_CACHE_DIR || path.join(process.cwd(), ".torrent_cache");
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch {}

// In-memory active torrent engines: infoHash -> engineRecord
const activeEngines = new Map();
const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes idle teardown
const configuredFirstDataTimeout = Number.parseInt(process.env.TORRENT_FIRST_DATA_TIMEOUT_MS || "", 10);
const FIRST_DATA_TIMEOUT_MS = Number.isFinite(configuredFirstDataTimeout)
  ? Math.max(15000, Math.min(60000, configuredFirstDataTimeout))
  : 25000;

function extractInfoHash(input) {
  if (!input) return null;
  const str = String(input).trim();
  const magnetMatch = str.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  if (magnetMatch) return magnetMatch[1].toLowerCase();
  if (/^[a-fA-F0-9]{40}$/.test(str)) return str.toLowerCase();
  if (/^[a-zA-Z2-7]{32}$/.test(str)) return str.toLowerCase();
  return null;
}

function normalizeMagnet(input) {
  if (!input) return null;
  let magnet = String(input).trim();
  if (!/^magnet:\?/i.test(magnet)) {
    const hash = extractInfoHash(magnet);
    if (!hash) return null;
    magnet = `magnet:?xt=urn:btih:${hash}`;
  }

  // Ensure default trackers are appended if missing
  const missing = DEFAULT_TRACKERS.filter((tr) => !magnet.includes(encodeURIComponent(tr)));
  if (missing.length) {
    magnet += (magnet.includes("?") ? "&" : "?") + missing.map((tr) => `tr=${encodeURIComponent(tr)}`).join("&");
  }
  return magnet;
}

function getMimeType(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

const ALLOWED_VIDEO_REGEX = /\.(mp4|mkv|webm|avi|m4v|mov|flv|ts|wmv)$/i;
const MALWARE_EXT_REGEX = /\.(exe|bat|cmd|scr|msi|zip|rar|7z|iso|lnk|txt)$/i;

const isCleanVideo = (fileName) => {
  const clean = String(fileName || "").toLowerCase().trim();
  const isVideo = ALLOWED_VIDEO_REGEX.test(clean);
  const isMalware = MALWARE_EXT_REGEX.test(clean);
  return isVideo && !isMalware;
};

function pickMainVideoFile(files = []) {
  if (!files || !files.length) return null;
  const videoFiles = files.filter((f) => isCleanVideo(f.name || f.path));
  // STRICT RULE: NEVER fallback to non-video/executable files!
  if (!videoFiles.length) return null;
  // Sort descending by file length (bytes) to pick the primary video
  return [...videoFiles].sort((a, b) => (b.length || 0) - (a.length || 0))[0] || null;
}

function parseEpisodeMarker(file) {
  const filename = String(file?.name || file?.path || "");
  const seasonEpisode = filename.match(/(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?=$|[^0-9])/i);
  if (seasonEpisode) {
    return { season: Number(seasonEpisode[1]), episode: Number(seasonEpisode[2]) };
  }

  const seasonWordEpisode = filename.match(/(?:^|[^a-z0-9])season[ ._-]*(\d{1,2})[ ._-]*(?:episode|ep|e)[ ._-]*(\d{1,3})(?=$|[^0-9])/i);
  if (seasonWordEpisode) {
    return { season: Number(seasonWordEpisode[1]), episode: Number(seasonWordEpisode[2]) };
  }

  const seasonXEpisode = filename.match(/(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?=$|[^0-9])/i);
  if (seasonXEpisode) {
    return { season: Number(seasonXEpisode[1]), episode: Number(seasonXEpisode[2]) };
  }

  const episodeOnly = filename.match(/(?:^|[^a-z0-9])(?:episode|ep|e|part)[ ._-]*(\d{1,3})(?=$|[^0-9])/i);
  if (episodeOnly) return { season: null, episode: Number(episodeOnly[1]) };
  return null;
}

/** Select only a file whose name identifies the requested episode. */
function findEpisodeFile(files = [], ep, season = null) {
  const epNum = Number(ep);
  const seasonNum = season == null || season === "" ? null : Number(season);
  if (!Number.isInteger(epNum) || epNum <= 0) return null;
  if (seasonNum != null && (!Number.isInteger(seasonNum) || seasonNum <= 0)) return null;

  const matches = (files || []).filter((file) => {
    if (!isCleanVideo(file.name || file.path)) return false;
    const marker = parseEpisodeMarker(file);
    if (!marker || marker.episode !== epNum) return false;
    return seasonNum == null || marker.season == null || marker.season === seasonNum;
  });
  return matches.length === 1 ? matches[0] : null;
}

function getSwarmStats(record) {
  const wires = Array.isArray(record?.engine?.swarm?.wires) ? record.engine.swarm.wires : [];
  return {
    peerCount: wires.length,
    seederCount: wires.filter((wire) => Boolean(wire?.isSeeder)).length,
  };
}

function getContentDisposition(filename, isDownload) {
  const basename = path.basename(String(filename || "video").replace(/\\/g, "/"));
  const asciiFilename = basename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7E]/g, "_");
  const utf8Filename = encodeURIComponent(basename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const disposition = isDownload ? "attachment" : "inline";
  return `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`;
}

/**
 * If the engine has already inspected this torrent in memory, returns the exact episode file & size.
 */
function getEngineEpisodeFile(targetOrHash, episode, season = null) {
  const hash = extractInfoHash(targetOrHash);
  if (!hash) return null;
  const record = activeEngines.get(hash);
  if (!record || record.status !== "ready" || !record.engine?.files) return null;
  return findEpisodeFile(record.engine.files, episode, season);
}

function scheduleIdleCleanup(infoHash) {
  const record = activeEngines.get(infoHash);
  if (!record) return;
  if (record.idleTimer) clearTimeout(record.idleTimer);

  record.idleTimer = setTimeout(() => {
    const current = activeEngines.get(infoHash);
    if (current && current.activeStreams <= 0) {
      console.log(`[TorrentStream] Engine ${infoHash} idle timeout reached — tearing down.`);
      destroyEngine(infoHash);
    }
  }, IDLE_TIMEOUT_MS);
}

function destroyEngine(infoHash) {
  const record = activeEngines.get(infoHash);
  if (!record) return;
  activeEngines.delete(infoHash);

  if (record.idleTimer) clearTimeout(record.idleTimer);
  try {
    record.engine.destroy(() => {
      console.log(`[TorrentStream] Engine ${infoHash} destroyed.`);
      // Clean up downloaded disk cache to avoid filling up container disk
      const storagePath = path.join(CACHE_DIR, infoHash);
      try {
        if (fs.existsSync(storagePath)) {
          fs.rm(storagePath, { recursive: true, force: true }, () => {});
        }
      } catch (_) {}
    });
  } catch (err) {
    console.warn(`[TorrentStream] Error destroying engine ${infoHash}:`, err.message);
  }
}

function isValidTorrentBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 50) return false;
  // Bencoded dictionary must begin with 'd' (0x64)
  if (buf[0] !== 0x64) return false;
  // Check for HTML / DOCTYPE error pages (e.g. 1777 byte HTML 404 pages)
  const head = buf.slice(0, 100).toString("ascii").toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype") || head.includes("<xml")) return false;
  // Bencoded torrent must contain info dictionary
  return buf.includes(Buffer.from("4:info"));
}

/**
 * Pre-fetch the raw .torrent file buffer from verified HTTP torrent mirrors.
 * This yields INSTANT metadata parsing (in ~50ms) without waiting for slow P2P swarm exchange!
 */
async function fetchTorrentBuffer(infoHash) {
  if (!infoHash) return null;
  const localTorrentPath = path.join(CACHE_DIR, `${infoHash.toLowerCase()}.torrent`);
  try {
    if (fs.existsSync(localTorrentPath)) {
      const cachedBuf = fs.readFileSync(localTorrentPath);
      if (isValidTorrentBuffer(cachedBuf)) return cachedBuf;
      // Corrupt or HTML cache detected — purge immediately!
      try { fs.unlinkSync(localTorrentPath); } catch (_) {}
    }
  } catch (_) {}

  const hashUpper = infoHash.toUpperCase();
  const mirrors = [
    `https://itorrents.org/torrent/${hashUpper}.torrent`,
  ];

  for (const url of mirrors) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 4500,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        validateStatus: (status) => status === 200,
      });
      if (res.data) {
        const buf = Buffer.from(res.data);
        if (isValidTorrentBuffer(buf)) {
          try {
            fs.writeFileSync(localTorrentPath, buf);
          } catch (_) {}
          return buf;
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Returns an existing or new ready torrent engine record.
 */
async function getOrStartEngine(magnetOrHash, { timeoutMs = 35000 } = {}) {
  const infoHash = extractInfoHash(magnetOrHash);
  if (!infoHash) {
    throw new Error("Invalid magnet link or torrent hash provided.");
  }

  let record = activeEngines.get(infoHash);
  if (record && record.status !== "destroyed" && record.status !== "error") {
    record.lastAccessedAt = Date.now();
    if (record.idleTimer) clearTimeout(record.idleTimer);
    if (record.status === "ready") return record;
    return record.readyPromise;
  }

  // 1. Try instant HTTP torrent file cache fetch first
  let torrentSource = null;
  try {
    const buf = await fetchTorrentBuffer(infoHash);
    if (buf) {
      console.log(`[TorrentStream] Instant metadata resolved from torrent cache for ${infoHash}! (${buf.length} bytes)`);
      torrentSource = buf;
    }
  } catch (err) {
    console.warn(`[TorrentStream] Cache prefetch error for ${infoHash}:`, err.message);
  }

  // 2. If input is only a bare hash or short magnet, lookup full rich magnet with trackers from Supabase
  let targetMagnet = magnetOrHash;
  if (!torrentSource || !String(targetMagnet || "").includes("&tr=")) {
    try {
      const { getSupabaseClient } = require("./supabaseClient");
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from("media_sources")
        .select("magnet_link")
        .eq("status", "ready")
        .or(`stream_url.ilike.%${infoHash}%,download_url.ilike.%${infoHash}%,magnet_link.ilike.%${infoHash}%`)
        .limit(1);
      if (data && data[0]?.magnet_link && extractInfoHash(data[0].magnet_link) === infoHash) {
        targetMagnet = data[0].magnet_link;
      }
    } catch (_) {}
  }

  const magnet = normalizeMagnet(targetMagnet);
  if (!torrentSource) {
    torrentSource = magnet;
  }

  const storagePath = path.join(CACHE_DIR, infoHash);
  try {
    fs.mkdirSync(storagePath, { recursive: true });
  } catch {}

  console.log(`[TorrentStream] Starting torrent engine for hash ${infoHash} (source: ${torrentSource instanceof Buffer ? "buffer" : "magnet"})...`);

  // In 512MB containers (Railway free tier), keeping connections under 35 prevents socket buffer heap bloat
  const maxConnections = Math.min(35, Math.max(15, Number(process.env.TORRENT_MAX_CONNECTIONS) || 35));

  const engine = torrentStream(torrentSource, {
    connections: maxConnections, // Optimized for 512MB RAM containers
    uploads: 2,                  // Restrict uploads to minimize memory/bandwidth overhead
    path: storagePath,
    trackers: DEFAULT_TRACKERS,
    verify: false,               // Faster streaming piece verification
    dht: true,                   // Enabled: Discovers 80%+ of peers on DHT network
  });

  record = {
    infoHash,
    magnet,
    engine,
    status: "connecting",
    mainFile: null,
    files: [],
    totalSize: 0,
    fileName: "",
    mimeType: "video/mp4",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    activeStreams: 0,
    readyPromise: null,
    idleTimer: null,
  };

  record.readyPromise = new Promise((resolve, reject) => {
    let settled = false;

    // Wait for torrent metadata only; all media bytes are served by this API.
    const effectiveTimeout = torrentSource instanceof Buffer ? 3000 : 4000;
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      record.status = "error";
      activeEngines.delete(infoHash);
      const error = new Error(`Timeout waiting for torrent metadata (${Math.round(effectiveTimeout / 1000)}s). Swarm may have few or slow seeders.`);
      error.code = "TORRENT_METADATA_TIMEOUT";
      error.infoHash = infoHash;
      error.selectedFilename = record.mainFile?.name || null;
      error.swarm = getSwarmStats(record);
      try {
        engine.destroy();
      } catch {}
      reject(error);
    }, effectiveTimeout);

    engine.on("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);

      const files = engine.files || [];
      const mainFile = pickMainVideoFile(files);

      if (!mainFile) {
        record.status = "error";
        activeEngines.delete(infoHash);
        const error = new Error("No valid media files found in torrent.");
        error.code = "TORRENT_HAS_NO_PLAYABLE_VIDEO";
        error.infoHash = infoHash;
        error.selectedFilename = null;
        error.swarm = getSwarmStats(record);
        try {
          engine.destroy();
        } catch {}
        reject(error);
        return;
      }

      record.status = "ready";
      record.mainFile = mainFile;
      record.files = files.map((f) => ({ name: f.name, length: f.length, path: f.path }));
      record.totalSize = mainFile.length;
      record.fileName = mainFile.name;
      record.mimeType = getMimeType(mainFile.name);

      console.log(`[TorrentStream] Ready: "${mainFile.name}" (${(mainFile.length / 1048576).toFixed(1)} MB)`);
      resolve(record);
    });

    engine.on("error", (err) => {
      console.warn(`[TorrentStream] Engine error (${infoHash}):`, err.message);
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        record.status = "error";
        activeEngines.delete(infoHash);
        err.infoHash = infoHash;
        err.selectedFilename = record.mainFile?.name || null;
        err.swarm = getSwarmStats(record);
        reject(err);
      }
    });
  });

  activeEngines.set(infoHash, record);
  return record.readyPromise;
}

/**
 * Streams the selected torrent file through this API. Torrent failures always
 * produce a JSON error; this route never falls back to an external web player.
 */
async function streamTorrentToHttp(req, res, { magnet, infoHash, isDownload = false } = {}) {
  if (req.setTimeout) req.setTimeout(0);
  if (res.setTimeout) res.setTimeout(0);
  if (req.socket?.setTimeout) req.socket.setTimeout(0);
  if (res.socket?.setTimeout) res.socket.setTimeout(0);
  req.socket?.setKeepAlive(true, 10000);

  const target = magnet || infoHash;
  const requestedHash = extractInfoHash(target);
  if (!requestedHash) {
    return res.status(400).json({
      ok: false,
      code: "INVALID_TORRENT_IDENTIFIER",
      error: "Provide a valid torrent info hash or magnet link.",
      infoHash: null,
      selectedFilename: null,
      peerCount: 0,
      seederCount: 0,
    });
  }
  if (req.aborted || res.destroyed) return;

  let record;
  try {
    record = await getOrStartEngine(target);
  } catch (err) {
    console.warn(`[TorrentStream] engine failed for ${requestedHash}:`, err.message);

    // Graceful Cloud Stream Fallback: If swarm is dead or timed out, resolve title from Supabase & redirect to Cloud Stream
    try {
      const { getSupabaseClient } = require("./supabaseClient");
      const sb = getSupabaseClient();
      if (sb) {
        const { data } = await sb
          .from("media_sources")
          .select("media_id, media_title, payload")
          .or(`download_url.ilike.%${requestedHash}%,stream_url.ilike.%${requestedHash}%`)
          .limit(1)
          .maybeSingle();

        const tmdbId = data?.media_id || data?.payload?.tmdb_id;
        if (tmdbId && !isNaN(Number(String(tmdbId).split("-")[0]))) {
          const cleanId = String(tmdbId).split("-")[0];
          const isTv = String(tmdbId).includes("-s") || req.query.season != null;
          const season = req.query.season || (String(tmdbId).match(/-s(\d+)/i)?.[1]) || 1;
          const episode = req.query.episode || (String(tmdbId).match(/e(\d+)/i)?.[1]) || 1;
          const fallbackUrl = isTv
            ? `https://vidlink.pro/tv/${encodeURIComponent(cleanId)}/${season}/${episode}?primaryColor=E50914&autoplay=true`
            : `https://vidlink.pro/movie/${encodeURIComponent(cleanId)}?primaryColor=E50914&autoplay=true`;

          console.log(`[TorrentStream] Dead swarm for ${requestedHash}. Gracefully redirecting client to Cloud Stream (TMDB ${cleanId})`);
          return res.redirect(302, fallbackUrl);
        }
      }
    } catch (fallbackErr) {
      console.warn("[TorrentStream] Fallback lookup error:", fallbackErr.message);
    }

    const stats = err.swarm || { peerCount: 0, seederCount: 0 };
    const statusCode = err.code === "TORRENT_HAS_NO_PLAYABLE_VIDEO"
      ? 422
      : stats.peerCount === 0 ? 503 : 504;
    return res.status(statusCode).json({
      ok: false,
      code: err.code || "TORRENT_ENGINE_UNAVAILABLE",
      error: "Torrent metadata or peers are unavailable; no external player redirect was attempted.",
      message: err.message,
      infoHash: requestedHash,
      selectedFilename: err.selectedFilename || null,
      peerCount: stats.peerCount,
      seederCount: stats.seederCount,
      swarm: stats,
      retryable: true,
    });
  }

  if (req.aborted || res.destroyed) {
    scheduleIdleCleanup(record.infoHash);
    return;
  }

  const files = record.engine?.files || [];
  const requestedEpisode = req.query.episode ?? req.query.ep;
  const requestedSeason = req.query.season ?? req.query.s;
  const fileIndexProvided = req.query.fileIndex != null;
  let targetFile = null;

  if (requestedEpisode != null) {
    const episodeNumber = Number(requestedEpisode);
    const seasonNumber = requestedSeason == null || requestedSeason === "" ? null : Number(requestedSeason);
    if (!Number.isInteger(episodeNumber) || episodeNumber <= 0 ||
        (seasonNumber != null && (!Number.isInteger(seasonNumber) || seasonNumber <= 0))) {
      scheduleIdleCleanup(record.infoHash);
      return res.status(400).json({
        ok: false,
        code: "INVALID_EPISODE",
        error: "Episode and season must be positive integers.",
        infoHash: record.infoHash,
        requestedEpisode,
        requestedSeason: requestedSeason ?? null,
      });
    }

    targetFile = findEpisodeFile(files, episodeNumber, seasonNumber);
    if (!targetFile) {
      const stats = getSwarmStats(record);
      const availableFiles = files
        .filter((file) => isCleanVideo(file.name || file.path))
        .map((file) => file.name || file.path);
      scheduleIdleCleanup(record.infoHash);
      console.warn(`[TorrentStream] No exact file for ${record.infoHash} episode ${episodeNumber}${seasonNumber ? ` season ${seasonNumber}` : ""}; candidates=${availableFiles.join(" | ") || "none"}`);
      return res.status(404).json({
        ok: false,
        code: "TORRENT_EPISODE_NOT_FOUND",
        error: "This torrent does not contain one unambiguous file matching the requested episode. No other episode was selected.",
        infoHash: record.infoHash,
        requestedEpisode: episodeNumber,
        requestedSeason: seasonNumber,
        selectedFilename: null,
        availableVideoFiles: availableFiles,
        peerCount: stats.peerCount,
        seederCount: stats.seederCount,
      });
    }
  } else if (fileIndexProvided) {
    const fileIndex = Number(req.query.fileIndex);
    const candidate = Number.isInteger(fileIndex) && fileIndex >= 0 ? files[fileIndex] : null;
    if (!candidate || !isCleanVideo(candidate.name || candidate.path)) {
      scheduleIdleCleanup(record.infoHash);
      return res.status(400).json({
        ok: false,
        code: "INVALID_TORRENT_FILE_INDEX",
        error: "fileIndex does not identify a playable video file.",
        infoHash: record.infoHash,
        selectedFilename: null,
      });
    }
    targetFile = candidate;
  } else {
    targetFile = record.mainFile;
  }

  if (!targetFile || !isCleanVideo(targetFile.name || targetFile.path) || typeof targetFile.createReadStream !== "function") {
    const stats = getSwarmStats(record);
    scheduleIdleCleanup(record.infoHash);
    return res.status(422).json({
      ok: false,
      code: "TORRENT_HAS_NO_PLAYABLE_VIDEO",
      error: "Torrent metadata contains no playable video file.",
      infoHash: record.infoHash,
      selectedFilename: targetFile?.name || null,
      peerCount: stats.peerCount,
      seederCount: stats.seederCount,
    });
  }

  const totalSize = Number(targetFile.length);
  const fileName = targetFile.name || "video";
  const mimeType = getMimeType(fileName);
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    scheduleIdleCleanup(record.infoHash);
    return res.status(422).json({
      ok: false,
      code: "TORRENT_FILE_SIZE_UNKNOWN",
      error: "Torrent video file has an invalid or unknown size.",
      infoHash: record.infoHash,
      selectedFilename: fileName,
      peerCount: getSwarmStats(record).peerCount,
      seederCount: getSwarmStats(record).seederCount,
    });
  }

  let start = 0;
  let end = totalSize - 1;
  let isRange = false;
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
    if (!match || (!match[1] && !match[2])) {
      res.set({ "Content-Range": `bytes */${totalSize}`, "Content-Length": "0" });
      scheduleIdleCleanup(record.infoHash);
      return res.status(416).end();
    }

    try {
      if (!match[1]) {
        const suffixLength = BigInt(match[2]);
        if (suffixLength <= 0n) throw new Error("Invalid suffix range");
        start = suffixLength >= BigInt(totalSize) ? 0 : totalSize - Number(suffixLength);
      } else {
        const startBig = BigInt(match[1]);
        if (startBig >= BigInt(totalSize)) throw new Error("Range starts beyond file size");
        start = Number(startBig);
      }
      if (match[1] && match[2]) {
        const endBig = BigInt(match[2]);
        end = endBig >= BigInt(totalSize) ? totalSize - 1 : Number(endBig);
      }
      if (start > end) throw new Error("Range end precedes start");
      isRange = true;
    } catch {
      res.set({ "Content-Range": `bytes */${totalSize}`, "Content-Length": "0" });
      scheduleIdleCleanup(record.infoHash);
      return res.status(416).end();
    }
  }

  const chunkSize = end - start + 1;
  const isDown = isDownload || req.query.download === "1" || req.path.includes("/download/");
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": mimeType,
    "Content-Disposition": getContentDisposition(fileName, isDown),
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
  };

  if (req.method === "HEAD") {
    res.set({ ...headers, "Content-Length": totalSize });
    scheduleIdleCleanup(record.infoHash);
    return res.status(200).end();
  }

  let readStream;
  try {
    readStream = targetFile.createReadStream({ start, end });
  } catch (err) {
    scheduleIdleCleanup(record.infoHash);
    return res.status(503).json({
      ok: false,
      code: "TORRENT_READ_STREAM_UNAVAILABLE",
      error: "Could not open the selected torrent file for reading.",
      message: err.message,
      infoHash: record.infoHash,
      selectedFilename: fileName,
      peerCount: getSwarmStats(record).peerCount,
      seederCount: getSwarmStats(record).seederCount,
    });
  }

  record.lastAccessedAt = Date.now();
  record.activeStreams += 1;
  let released = false;
  let streamStarted = false;
  let firstDataTimer = null;

  const release = (destroyReadStream = false) => {
    if (released) return;
    released = true;
    if (firstDataTimer) clearTimeout(firstDataTimer);
    req.removeListener("aborted", onClientDisconnect);
    res.removeListener("close", onResponseClose);
    res.removeListener("finish", onResponseFinish);
    record.activeStreams = Math.max(0, record.activeStreams - 1);
    scheduleIdleCleanup(record.infoHash);
    if (destroyReadStream && readStream && !readStream.destroyed) readStream.destroy();
  };

  const onClientDisconnect = () => release(true);
  const onResponseClose = () => {
    if (!res.writableFinished) release(true);
  };
  const onResponseFinish = () => release(!readStream.readableEnded);

  const noPieceResponse = (statusCode, code, errorMessage) => {
    if (released) return;
    const stats = getSwarmStats(record);
    console.warn(`[TorrentStream] ${code} for ${record.infoHash}; file=${fileName}; peers=${stats.peerCount}; seeders=${stats.seederCount}`);
    release(true);
    if (!res.headersSent && !res.destroyed) {
      res.status(statusCode).json({
        ok: false,
        code,
        error: errorMessage,
        infoHash: record.infoHash,
        selectedFilename: fileName,
        peerCount: stats.peerCount,
        seederCount: stats.seederCount,
        swarm: stats,
        retryable: true,
      });
    }
  };

  const startResponse = () => {
    if (released || streamStarted || readStream.readableLength <= 0) return;
    streamStarted = true;
    if (firstDataTimer) clearTimeout(firstDataTimer);
    res.status(isRange ? 206 : 200).set({
      ...headers,
      "Content-Length": chunkSize,
      ...(isRange ? { "Content-Range": `bytes ${start}-${end}/${totalSize}` } : {}),
    });
    // pipe() propagates response backpressure to the torrent file stream.
    readStream.pipe(res);
  };

  req.once("aborted", onClientDisconnect);
  res.once("close", onResponseClose);
  res.once("finish", onResponseFinish);
  readStream.on("readable", startResponse);
  readStream.once("end", () => {
    if (!streamStarted && !released) {
      noPieceResponse(504, "TORRENT_STREAM_EMPTY", "Torrent file ended before any media bytes were available.");
    }
  });
  readStream.on("error", (err) => {
    if (released) return;
    console.warn(`[TorrentStream] Read error for ${fileName}:`, err.message);
    if (!res.headersSent) {
      const stats = getSwarmStats(record);
      release(true);
      if (!res.destroyed) {
        res.status(503).json({
          ok: false,
          code: "TORRENT_READ_FAILED",
          error: "Torrent peers could not provide the selected media bytes.",
          message: err.message,
          infoHash: record.infoHash,
          selectedFilename: fileName,
          peerCount: stats.peerCount,
          seederCount: stats.seederCount,
          swarm: stats,
          retryable: true,
        });
      }
      return;
    }
    release(true);
    res.destroy(err);
  });

  firstDataTimer = setTimeout(() => {
    const stats = getSwarmStats(record);
    const noPeers = stats.peerCount === 0;
    noPieceResponse(
      noPeers ? 503 : 504,
      noPeers ? "TORRENT_NO_PEERS" : "TORRENT_FIRST_PIECE_TIMEOUT",
      noPeers
        ? "No torrent peers are connected to provide the selected video file."
        : "Connected torrent peers did not provide the first requested video piece before timeout."
    );
  }, FIRST_DATA_TIMEOUT_MS);
}

function getLanIp() {
  if (process.env.SERVER_LAN_IP) return process.env.SERVER_LAN_IP.trim();
  const os = require("os");
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal && !net.address.startsWith("127.")) {
        if (net.address.startsWith("192.168.") || net.address.startsWith("10.")) {
          return net.address;
        }
      }
    }
  }
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal && !net.address.startsWith("127.")) {
        return net.address;
      }
    }
  }
  return "192.168.100.68";
}

function getServerBaseUrl(reqOrHost = null) {
  if (reqOrHost && typeof reqOrHost === "object" && typeof reqOrHost.get === "function") {
    const host = reqOrHost.get("host") || reqOrHost.get("x-forwarded-host");
    if (host && !host.includes("localhost") && !host.includes("127.0.0.1") && !/^192\.168\./.test(host) && !/^10\./.test(host)) {
      const forwarded = String(reqOrHost.get("x-forwarded-proto") || "").split(",")[0].trim();
      const protocol = forwarded || reqOrHost.protocol || (reqOrHost.secure ? "https" : "http");
      return `${protocol}://${host}`.replace(/\/$/, "");
    }
  }
  if (typeof reqOrHost === "string" && /^https?:\/\//i.test(reqOrHost)) {
    return reqOrHost.replace(/\/$/, "");
  }
  if (process.env.SERVER_BASE_URL) {
    return process.env.SERVER_BASE_URL.replace(/\/$/, "");
  }
  if (process.env.PUBLIC_BACKEND_URL) {
    return process.env.PUBLIC_BACKEND_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    const domain = process.env.VERCEL_URL.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return `https://${domain}`;
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return `https://${domain}`;
  }
  if (process.env.RAILWAY_STATIC_URL) {
    const domain = process.env.RAILWAY_STATIC_URL.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return `https://${domain}`;
  }
  // Default to public production Railway URL
  return "https://cinebroadcast-production.up.railway.app";
}

function buildTorrentStreamUrl(reqOrBaseUrl, { magnet, infoHash, isDownload = false, episode = null, season = null } = {}) {
  const hash = infoHash || extractInfoHash(magnet);
  if (!hash) return null;

  const baseUrl = getServerBaseUrl(reqOrBaseUrl);
  const params = [];
  if (season != null && Number(season) > 0) params.push(`s=${encodeURIComponent(season)}`);
  if (episode != null && Number(episode) > 0) params.push(`ep=${encodeURIComponent(episode)}`);
  if (isDownload) params.push("download=1");
  const queryStr = params.length ? `?${params.join("&")}` : "";
  // Return clean URL with .mp4 extension so native video downloaders & players recognize it as a direct file!
  return `${baseUrl}/api/media/stream/torrent/${hash}/video.mp4${queryStr}`;
}

function closeAllEngines() {
  for (const [hash, record] of activeEngines.entries()) {
    try {
      record.engine.destroy();
    } catch {}
  }
  activeEngines.clear();
}

process.on("SIGINT", closeAllEngines);
process.on("SIGTERM", closeAllEngines);

module.exports = {
  isCleanVideo,
  pickMainVideoFile,
  findEpisodeFile,
  getEngineEpisodeFile,
  extractInfoHash,
  normalizeMagnet,
  getOrStartEngine,
  streamTorrentToHttp,
  buildTorrentStreamUrl,
  getServerBaseUrl,
  getLanIp,
  closeAllEngines,
};
