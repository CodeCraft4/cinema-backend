"use strict";

const axios = require("axios");
const { getSupabaseClient } = require("../services/supabaseClient");
const { asyncHandler } = require("../utils/http");
const { memoryCache } = require("../services/memoryCache");

/**
 * Controller for:
 * 1. GET /api/stream/:tmdbId
 * 2. GET /api/stream/manifest/:tmdbId
 * 3. GET /api/download/:tmdbId
 */

const getStream = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;
  const audio = String(req.query.audio || "hi").toLowerCase();

  if (!tmdbId) {
    return res.status(400).json({ success: false, error: "Missing tmdbId" });
  }

  // Set explicit media streaming & CORS headers on every response
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.header("Content-Type", "application/json; charset=utf-8");

  // Step 1: Check In-Memory Cache (1-Hour TTL) to prevent Supabase over-limit
  const cacheKey = `stream:${tmdbId}:${mediaType}:${season}:${episode}:${audio}`;
  const cachedStream = memoryCache.get(cacheKey);
  if (cachedStream) {
    return res.json({ ...cachedStream, cached: true });
  }

  const supabase = getSupabaseClient();
  let directStreamUrl = null;
  let directDownloadUrl = null;

  // Step 2: Consolidated single Supabase query
  if (supabase) {
    try {
      const isTv = mediaType === "tv";
      const epPattern = isTv ? `${tmdbId}-s%e${episode}` : null;

      let dbQuery = supabase
        .from("media_sources")
        .select("id, media_id, media_title, stream_url, download_url, language, quality, source_type")
        .limit(10);

      if (isTv) {
        dbQuery = dbQuery.or(`media_id.eq.${tmdbId},media_id.ilike.${tmdbId}-s%`);
      } else {
        dbQuery = dbQuery.eq("media_id", String(tmdbId));
      }

      const { data: sources, error } = await dbQuery;

      if (!error && sources && sources.length > 0) {
        // Find ready direct HLS or MP4 stream if not a raw magnet
        const hlsSource = sources.find(
          (s) =>
            s.stream_url &&
            !s.stream_url.includes("/stream/torrent/") &&
            (s.stream_url.includes(".m3u8") || s.stream_url.startsWith("https://"))
        );

        if (hlsSource) {
          directStreamUrl = hlsSource.stream_url;
          directDownloadUrl = hlsSource.download_url || hlsSource.stream_url;
        }
      }
    } catch (e) {
      console.warn("[streamApiController] Consolidated Supabase query failed:", e.message);
    }
  }

  // Step 3: High-speed clean HLS / Embed fallback if not in DB
  if (!directStreamUrl) {
    if (mediaType === "tv") {
      directStreamUrl = `https://vidlink.pro/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}?primaryColor=E50914&autoplay=true`;
      directDownloadUrl = `https://vidlink.pro/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}`;
    } else {
      directStreamUrl = `https://vidlink.pro/movie/${encodeURIComponent(tmdbId)}?primaryColor=E50914&autoplay=true`;
      directDownloadUrl = `https://vidlink.pro/movie/${encodeURIComponent(tmdbId)}`;
    }
  }

  const responsePayload = {
    success: true,
    streamUrl: directStreamUrl,
    defaultAudio: "hi",
    availableAudios: [
      { label: "Hindi", code: "hi" },
      { label: "English", code: "en" },
      { label: "Original", code: "orig" },
    ],
    qualities: ["auto", "1080p", "720p", "480p"],
  };

  // Step 4: Save in Memory Cache (1 Hour = 3600000 ms)
  memoryCache.set(cacheKey, responsePayload, 3600000);

  return res.json(responsePayload);
});

const getManifest = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  if (!tmdbId) {
    return res.status(400).send("#EXTM3U\n#EXT-X-ERROR: Missing tmdbId\n");
  }

  const directStreamUrl = mediaType === "tv"
    ? `https://vidlink.pro/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}?primaryColor=E50914&autoplay=true`
    : `https://vidlink.pro/movie/${encodeURIComponent(tmdbId)}?primaryColor=E50914&autoplay=true`;

  return res.redirect(302, directStreamUrl);
});

const getDownload = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.header("Content-Type", "application/json; charset=utf-8");

  const cacheKey = `download:${tmdbId}:${mediaType}:${season}:${episode}`;
  const cachedDownload = memoryCache.get(cacheKey);
  if (cachedDownload) {
    return res.json({ ...cachedDownload, cached: true });
  }

  const supabase = getSupabaseClient();
  let downloadUrl = null;

  if (supabase) {
    try {
      const { data: sources } = await supabase
        .from("media_sources")
        .select("download_url")
        .or(`media_id.eq.${tmdbId},media_id.ilike.${tmdbId}-%`)
        .limit(5);

      const ddlSource = sources?.find(
        (s) =>
          s.download_url &&
          !s.download_url.startsWith("magnet:") &&
          !s.download_url.includes("/stream/torrent/")
      );

      if (ddlSource) {
        downloadUrl = ddlSource.download_url;
      }
    } catch {}
  }

  if (!downloadUrl) {
    if (mediaType === "tv") {
      downloadUrl = `https://vidlink.pro/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}`;
    } else {
      downloadUrl = `https://vidlink.pro/movie/${encodeURIComponent(tmdbId)}`;
    }
  }

  const downloadPayload = {
    success: true,
    downloadUrl,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    supportsResume: true,
  };

  memoryCache.set(cacheKey, downloadPayload, 3600000);

  return res.json(downloadPayload);
});

module.exports = {
  getStream,
  getManifest,
  getDownload,
};
