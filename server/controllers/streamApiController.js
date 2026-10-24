"use strict";

const axios = require("axios");
const { getSupabaseClient } = require("../services/supabaseClient");
const { asyncHandler } = require("../utils/http");

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

  const supabase = getSupabaseClient();
  let directStreamUrl = null;
  let directDownloadUrl = null;

  // 1. Try to find direct stream from Supabase media_sources table
  if (supabase) {
    try {
      const { data: sources } = await supabase
        .from("media_sources")
        .select("*")
        .or(`media_id.eq.${tmdbId},tmdb_id.eq.${tmdbId}`)
        .limit(10);

      if (sources && sources.length > 0) {
        // Find direct HLS or MP4 stream if not a raw torrent URL
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
      console.warn("[streamApiController] Supabase lookup error:", e.message);
    }
  }

  // 2. Fallback to high-speed clean HLS / Embed provider stream if not directly in DB
  if (!directStreamUrl) {
    // Generate clean embed / HLS provider URL
    if (mediaType === "tv") {
      directStreamUrl = `https://vidlink.pro/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}?primaryColor=E50914&autoplay=true`;
      directDownloadUrl = `https://vidlink.pro/tv/${encodeURIComponent(tmdbId)}/${season}/${episode}`;
    } else {
      directStreamUrl = `https://vidlink.pro/movie/${encodeURIComponent(tmdbId)}?primaryColor=E50914&autoplay=true`;
      directDownloadUrl = `https://vidlink.pro/movie/${encodeURIComponent(tmdbId)}`;
    }
  }

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Content-Type", "application/json; charset=utf-8");

  return res.json({
    success: true,
    streamUrl: directStreamUrl,
    defaultAudio: "hi",
    availableAudios: [
      { label: "Hindi", code: "hi" },
      { label: "English", code: "en" },
      { label: "Original", code: "orig" },
    ],
    qualities: ["auto", "1080p", "720p", "480p"],
  });
});

const getManifest = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;
  const audio = String(req.query.audio || "hi").toLowerCase();

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
  res.header("Cache-Control", "no-cache");

  // Master playlist template with Hindi audio track DEFAULT=YES
  const manifest = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-INDEPENDENT-SEGMENTS

# Audio Tracks
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="Hindi",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="hi",URI="stream_hi.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="English",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="en",URI="stream_en.m3u8"

# Video Variants (Adaptive Bitrate)
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio-aac"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio-aac"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio-aac"
480p/index.m3u8
`;

  return res.send(manifest);
});

const getDownload = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Content-Type", "application/json; charset=utf-8");

  const supabase = getSupabaseClient();
  let downloadUrl = null;

  if (supabase) {
    try {
      const { data: sources } = await supabase
        .from("media_sources")
        .select("*")
        .or(`media_id.eq.${tmdbId},tmdb_id.eq.${tmdbId}`)
        .limit(10);

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

  return res.json({
    success: true,
    downloadUrl,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    supportsResume: true,
  });
});

module.exports = {
  getStream,
  getManifest,
  getDownload,
};
