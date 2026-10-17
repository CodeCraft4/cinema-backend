"use strict";

/** Feature film. 500 MiB. Anything smaller is a trailer, sample, or torrent file. */
const MIN_VIDEO_BYTES = 500 * 1024 * 1024;
/** TV episode floor. Still above a 40MB sample. */
const MIN_EPISODE_BYTES = 80 * 1024 * 1024;

const VIDEO_EXT_RE = /\.(mp4|mkv|webm)(?:$|[?#])/i;
const TRAILER_NAME_RE = /(^|[^a-z0-9])(trailer|teaser|sample|clip|thumb|official[-_ ]?trailer)([^a-z0-9]|$)/i;
const TRAILER_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|vimeo\.com|vimeocdn\.com|themoviedb\.org|tmdb\.org)$/i;

function isTorrentArtifactUrl(url) {
  const text = String(url || "").trim();
  if (!text) return false;
  if (/^magnet:/i.test(text)) return true;
  if (/\.torrent(?:$|[?#])/i.test(text)) return true;
  if (/itorrents\.org\/torrent\//i.test(text)) return true;
  if (/\/torrent\/[a-f0-9]{32,40}(?:$|[/?#])/i.test(text)) return true;
  return false;
}

function isVideoFilename(name) {
  return VIDEO_EXT_RE.test(String(name || "").split("?")[0]);
}

function fileExtension(url) {
  const path = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  if (path.endsWith(".mp4")) return "mp4";
  if (path.endsWith(".mkv")) return "mkv";
  if (path.endsWith(".webm")) return "webm";
  return "";
}

function isTrailerName(name) {
  const base = decodeURIComponent(String(name || "").split("?")[0].split("/").pop() || "");
  return TRAILER_NAME_RE.test(base);
}

function isTrailerMediaUrl(url) {
  const text = String(url || "").trim();
  if (!text) return false;
  if (isTrailerName(text)) return true;
  try {
    const host = new URL(text).hostname;
    if (TRAILER_HOST_RE.test(host)) return true;
  } catch {
    return false;
  }
  return false;
}

/** HTTPS URL whose path is an mp4, mkv, or webm file. */
function isVideoFileUrl(url) {
  const text = String(url || "").trim();
  if (!/^https?:\/\//i.test(text) || isTorrentArtifactUrl(text) || isTrailerMediaUrl(text)) return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  if (TRAILER_HOST_RE.test(parsed.hostname)) return false;
  return isVideoFilename(decodeURIComponent(parsed.pathname || ""));
}

function minVideoBytes(mediaType) {
  return mediaType === "tv" ? MIN_EPISODE_BYTES : MIN_VIDEO_BYTES;
}

function isFullVideoSize(sizeBytes, mediaType) {
  const bytes = Number(sizeBytes);
  return Number.isFinite(bytes) && bytes >= minVideoBytes(mediaType);
}

function contentTypeForExtension(ext, contentType) {
  const value = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (ext === "mp4") return value === "video/mp4";
  if (ext === "mkv") return value === "video/x-matroska";
  if (ext === "webm") return value === "video/webm";
  return false;
}

/** True when ftyp is first and moov appears before mdat, so preview can start early. */
function mp4HasFaststart(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 16) return false;
  const ftyp = buf.indexOf("ftyp");
  if (ftyp < 4 || ftyp > 32) return false;
  const moov = buf.indexOf("moov");
  if (moov < 0) return false;
  const mdat = buf.indexOf("mdat");
  if (mdat >= 0 && mdat < moov) return false;
  return true;
}

function videoMagicOk(ext, buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 4) return false;
  if (ext === "mp4") return mp4HasFaststart(buf);
  if (ext === "mkv" || ext === "webm") return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  return false;
}

/** Ready only when download_url and stream_url are the same full movie file. */
function isReadyVideoFile(source, mediaType) {
  if (!source) return false;
  const url = source.download_url || "";
  const stream = source.stream_url || url;
  if (!url || url !== stream) return false;
  return isVideoFileUrl(url) && isFullVideoSize(source.size_bytes, mediaType || source.media_type);
}

module.exports = {
  MIN_VIDEO_BYTES,
  MIN_EPISODE_BYTES,
  isTorrentArtifactUrl,
  isVideoFilename,
  isTrailerName,
  isTrailerMediaUrl,
  isVideoFileUrl,
  fileExtension,
  minVideoBytes,
  isFullVideoSize,
  contentTypeForExtension,
  mp4HasFaststart,
  videoMagicOk,
  isReadyVideoFile,
};
