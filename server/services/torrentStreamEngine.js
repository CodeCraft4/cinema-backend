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
};

// Use project virtual disk instead of os.tmpdir() (/tmp is mounted as tmpfs in RAM on Railway/Docker, which caused the 512MB OOM crash!)
const CACHE_DIR = process.env.TORRENT_CACHE_DIR || path.join(process.cwd(), ".torrent_cache");
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch {}

// In-memory active torrent engines: infoHash -> engineRecord
const activeEngines = new Map();
const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes idle teardown

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
  // Force video/mp4 MIME type for maximum iOS AVPlayer and ExoPlayer streaming compatibility
  if (ext === ".mkv" || ext === ".mp4" || ext === ".m4v" || ext === ".mov") {
    return "video/mp4";
  }
  return MIME_TYPES[ext] || "video/mp4";
}

const ALLOWED_VIDEO_REGEX = /\.(mp4|mkv|webm|avi|m4v|mov)$/i;
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

/**
 * Finds the exact video file matching a requested episode number (e.g. ep=2)
 * Supports S01E02, 1x02, EP02, Episode 02, Part 2, and natural alphanumeric sort.
 */
function findEpisodeFile(files = [], ep, season = null) {
  const cleanFiles = (files || []).filter((f) => isCleanVideo(f.name || f.path));
  if (!cleanFiles.length) return null;
  if (cleanFiles.length === 1) return cleanFiles[0];

  const epNum = parseInt(ep, 10);
  if (isNaN(epNum) || epNum <= 0) return null;
  const epPadded = String(epNum).padStart(2, "0");
  const sNum = season ? parseInt(season, 10) : null;
  const sPadded = sNum ? String(sNum).padStart(2, "0") : "\\d+";

  // 1. Season + Episode pattern: S01E03, S1E3, 1x03, 01x03, S01.E03
  const sEpRegex = new RegExp(`(?:S${sPadded}[._ -]*E0?${epNum}\\b|${sNum || "\\d+"}x0?${epNum}\\b|S${sPadded}E${epPadded}\\b)`, "i");
  let matched = cleanFiles.find((f) => sEpRegex.test(f.name) || sEpRegex.test(f.path));
  if (matched) return matched;

  // 2. Episode prefix: E03, EP03, Ep 03, Ep.03, Episode 03, Part 03
  const epPrefixRegex = new RegExp(`(?:[._ -]E0?${epNum}[._ -]|[._ -]EP0?${epNum}[._ -]|(?:Episode|Ep|Part)[._ -]*0?${epNum}\\b)`, "i");
  matched = cleanFiles.find((f) => epPrefixRegex.test(f.name) || epPrefixRegex.test(f.path));
  if (matched) return matched;

  // 3. Standalone episode number in delimiters: " - 03 - ", " [03] ", " (03) ", " 03.mkv "
  const standaloneEpRegex = new RegExp(`(?:[._ -[\(]0?${epNum}[._ -\\]\)])`, "i");
  matched = cleanFiles.find((f) => standaloneEpRegex.test(f.name) || standaloneEpRegex.test(f.path));
  if (matched) return matched;

  // 4. Fallback: Natural alphanumeric sort of clean video files
  const sorted = [...cleanFiles].sort((a, b) =>
    (a.name || a.path || "").localeCompare(b.name || b.path || "", undefined, { numeric: true, sensitivity: "base" })
  );
  if (sorted[epNum - 1]) {
    return sorted[epNum - 1];
  }

  return cleanFiles[0];
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
        .or(`stream_url.ilike.%${infoHash}%,download_url.ilike.%${infoHash}%,magnet_link.ilike.%${infoHash}%`)
        .limit(1);
      if (data && data[0]?.magnet_link) {
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

    // Buffers parse in <100ms; magnets get up to 15s for DHT peer discovery before cloud failover
    const effectiveTimeout = torrentSource instanceof Buffer ? 5000 : 15000;
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      record.status = "error";
      activeEngines.delete(infoHash);
      try {
        engine.destroy();
      } catch {}
      reject(new Error(`Timeout waiting for torrent metadata (${Math.round(effectiveTimeout / 1000)}s). Swarm may have few or slow seeders.`));
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
        try {
          engine.destroy();
        } catch {}
        reject(new Error("No valid media files found in torrent."));
        return;
      }

      // Deselect other files (samples, nfo, images) so bandwidth is dedicated to main video
      for (const f of files) {
        if (f !== mainFile && typeof f.deselect === "function") {
          try {
            f.deselect();
          } catch {}
        }
      }

      // Select main video and prioritize the initial pieces (head buffer for instant playback)
      if (typeof mainFile.select === "function") {
        try {
          mainFile.select();
        } catch {}
      }

      // Priority download for video header (first 5MB - 10MB) to start video instantly
      try {
        const pieceLength = engine.torrent?.pieceLength || 1048576;
        const initialPieces = Math.min(10, Math.ceil(mainFile.length / pieceLength));
        for (let i = 0; i < initialPieces; i++) {
          engine.critical?.(i);
        }
      } catch {}

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
        reject(err);
      }
    });
  });

  activeEngines.set(infoHash, record);
  return record.readyPromise;
}

/**
 * Handles HTTP Range streaming of the main torrent video file.
 * Compatible with standard HTTP 206 Partial Content and 200 OK.
 */
async function streamTorrentToHttp(req, res, { magnet, infoHash, isDownload = false } = {}) {
  // 1. Disable Node.js request and socket timeouts for large 1GB-5GB+ files
  if (req.setTimeout) req.setTimeout(0);
  if (res.setTimeout) res.setTimeout(0);
  if (req.socket?.setTimeout) req.socket.setTimeout(0);
  if (res.socket?.setTimeout) res.socket.setTimeout(0);
  req.socket?.setKeepAlive(true, 10000);

  const target = magnet || infoHash;
  if (!target) {
    return res.status(400).json({ error: "Missing magnet or hash parameter" });
  }

  let record;
  try {
    record = await getOrStartEngine(target);
  } catch (err) {
    console.warn(`[TorrentStream] engine failed for ${extractInfoHash(target) || "unknown"}:`, err.message);

    // Automatic 504 Recovery: Look up title/tmdbId from Supabase and redirect to high-speed embed stream!
    try {
      const hash = extractInfoHash(target);
      const { getSupabaseClient } = require("./supabaseClient");
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from("media_sources")
        .select("media_id, media_title, payload")
        .or(`stream_url.ilike.%${hash}%,download_url.ilike.%${hash}%,magnet_link.ilike.%${hash}%`)
        .limit(1);

      const item = data?.[0];
      const tmdbId = req.query.tmdbId || req.query.id || item?.payload?.tmdb_id || item?.media_id;
      const season = req.query.season || req.query.s || item?.payload?.season;
      const episode = req.query.episode || req.query.ep || item?.payload?.episode;

      if (tmdbId) {
        const cleanId = String(tmdbId).replace(/^[^\d]+/, "");
        const fallbackUrl = season && episode
          ? `https://vidlink.pro/tv/${cleanId}/${season}/${episode}`
          : `https://vidlink.pro/movie/${cleanId}`;
        console.log(`[TorrentStream] 504 recovery: redirecting to embed stream -> ${fallbackUrl}`);
        return res.redirect(302, fallbackUrl);
      }
    } catch (fallbackErr) {
      console.warn("[TorrentStream] Embed recovery error:", fallbackErr.message);
    }

    return res.status(504).json({
      ok: false,
      error: "Could not initialize torrent stream",
      message: err.message,
      infoHash: extractInfoHash(target),
    });
  }

  let targetFile = record.mainFile;
  const ep = req.query.episode || req.query.ep;
  const season = req.query.season || req.query.s;
  const fileIndex = req.query.fileIndex != null ? Number(req.query.fileIndex) : null;

  if (fileIndex != null && Number.isInteger(fileIndex) && record.engine?.files?.[fileIndex]) {
    const candidate = record.engine.files[fileIndex];
    if (isCleanVideo(candidate.name || candidate.path)) {
      targetFile = candidate;
    } else {
      scheduleIdleCleanup(record.infoHash);
      return res.status(400).json({
        error: "Invalid torrent: No playable video stream found. (Executable/Spam blocked)",
        infoHash: record.infoHash,
      });
    }
  } else if (ep != null) {
    const matched = findEpisodeFile(record.engine?.files || [], ep, season);
    if (matched) targetFile = matched;
  }

  // Strictly block .exe, malware, or empty non-video torrents
  if (!targetFile || !isCleanVideo(targetFile.name || targetFile.path) || typeof targetFile.createReadStream !== "function") {
    scheduleIdleCleanup(record.infoHash);
    return res.status(400).json({
      error: "Invalid torrent: No playable video stream found. (Executable/Spam blocked)",
      infoHash: record.infoHash,
    });
  }

  if (typeof targetFile.select === "function") {
    try {
      targetFile.select();
    } catch {}
  }

  const totalSize = Number(targetFile.length) || 0;
  const fileName = targetFile.name || "video.mp4";
  const mimeType = getMimeType(fileName);

  if (!totalSize) {
    scheduleIdleCleanup(record.infoHash);
    return res.status(404).json({
      error: "Torrent video file has unknown size",
      fileName,
      infoHash: record.infoHash,
    });
  }

  record.lastAccessedAt = Date.now();
  record.activeStreams += 1;

  const isDown = isDownload || req.query.download === "1" || req.path.includes("/download/");
  const cleanFilename = (fileName || "movie.mp4").replace(/["\r\n]/g, "");
  const disposition = isDown
    ? `attachment; filename="${cleanFilename}"`
    : `inline; filename="${cleanFilename}"`;

  // Base CORS, Range & Cache response headers
  res.set({
    "Accept-Ranges": "bytes",
    "Content-Type": mimeType,
    "Content-Disposition": disposition,
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Accept-Ranges, Content-Range, Content-Type, Content-Length",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  });

  // Handle HEAD requests
  if (req.method === "HEAD") {
    res.set("Content-Length", totalSize);
    record.activeStreams = Math.max(0, record.activeStreams - 1);
    scheduleIdleCleanup(record.infoHash);
    return res.status(200).end();
  }

  const rangeHeader = req.headers.range;
  let start = 0;
  let end = totalSize - 1;
  let isRange = false;

  if (rangeHeader) {
    const matches = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (matches) {
      isRange = true;
      const rStart = matches[1];
      const rEnd = matches[2];

      if (rStart === "" && rEnd !== "") {
        // Suffix range: -N means last N bytes
        const suffix = parseInt(rEnd, 10);
        start = Math.max(0, totalSize - suffix);
        end = totalSize - 1;
      } else {
        start = rStart !== "" ? parseInt(rStart, 10) : 0;
        end = rEnd !== "" ? parseInt(rEnd, 10) : totalSize - 1;
      }
    }
  }

  // Validate range
  if (isNaN(start) || isNaN(end) || start > end || start >= totalSize || end >= totalSize || start < 0) {
    res.set({
      "Content-Range": `bytes */${totalSize}`,
      "Content-Length": 0,
    });
    record.activeStreams = Math.max(0, record.activeStreams - 1);
    scheduleIdleCleanup(record.infoHash);
    return res.status(416).end();
  }

  const chunkSize = end - start + 1;

  const readStream = targetFile.createReadStream({ start, end });

  let closed = false;
  let receivedAnyData = false;
  let chunkTimer = null;

  const onDone = () => {
    if (closed) return;
    closed = true;
    if (chunkTimer) clearTimeout(chunkTimer);
    record.activeStreams = Math.max(0, record.activeStreams - 1);
    scheduleIdleCleanup(record.infoHash);
    if (readStream && typeof readStream.destroy === "function") {
      try {
        readStream.destroy();
      } catch {}
    }
  };

  // Watchdog: If swarm doesn't emit any data in 8 seconds, fallback cleanly to Cloud Stream
  chunkTimer = setTimeout(async () => {
    if (receivedAnyData || closed) return;
    console.warn(`[TorrentStream] Swarm timeout (8s without data) for ${record.infoHash}. Auto-redirecting to Cloud Stream.`);
    onDone();
    if (!res.headersSent) {
      try {
        const { getSupabaseClient } = require("./supabaseClient");
        const supabase = getSupabaseClient();
        const { data } = await supabase
          .from("media_sources")
          .select("media_id, media_title, payload")
          .or(`stream_url.ilike.%${record.infoHash}%,download_url.ilike.%${record.infoHash}%,magnet_link.ilike.%${record.infoHash}%`)
          .limit(1);

        const item = data?.[0];
        const tmdbId = req.query.tmdbId || req.query.id || item?.payload?.tmdb_id || item?.media_id;
        const season = req.query.season || req.query.s || item?.payload?.season;
        const episode = req.query.episode || req.query.ep || item?.payload?.episode;

        if (tmdbId) {
          const cleanId = String(tmdbId).replace(/^[^\d]+/, "");
          const fallbackUrl = season && episode
            ? `https://vidlink.pro/tv/${cleanId}/${season}/${episode}`
            : `https://vidlink.pro/movie/${cleanId}`;
          return res.redirect(302, fallbackUrl);
        }
      } catch (_) {}

      res.status(504).json({
        ok: false,
        error: "Torrent swarm is currently inactive. Please choose another quality or language.",
        infoHash: record.infoHash,
      });
    }
  }, 6000);

  req.on("close", onDone);
  res.on("close", onDone);
  res.on("finish", onDone);

  readStream.on("error", (err) => {
    console.warn(`[TorrentStream] Stream error for ${fileName}:`, err.message);
    onDone();
    if (!res.headersSent) {
      res.status(500).end();
    }
  });

  readStream.on("data", (chunk) => {
    if (!receivedAnyData) {
      receivedAnyData = true;
      if (chunkTimer) clearTimeout(chunkTimer);
      if (!res.headersSent) {
        if (isRange) {
          res.status(206);
          res.set({
            "Content-Range": `bytes ${start}-${end}/${totalSize}`,
            "Content-Length": chunkSize,
          });
        } else {
          res.status(200);
          res.set("Content-Length", totalSize);
        }
      }
    }
    res.write(chunk);
  });

  readStream.on("end", () => {
    if (chunkTimer) clearTimeout(chunkTimer);
    res.end();
  });
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
