"use strict";

const axios = require("axios");
const { getSupabaseClient } = require("../services/supabaseClient");
const { asyncHandler } = require("../utils/http");
const { memoryCache } = require("../services/memoryCache");
const torboxService = require("../services/torboxService");

/**
 * Controller for:
 * 1. GET /api/stream/:tmdbId
 * 2. GET /api/stream/manifest/:tmdbId
 * 3. GET /api/download/:tmdbId
 */

function buildProviderUrls(tmdbId, mediaType, season = 1, episode = 1) {
  const isTv = mediaType === "tv";
  const id = encodeURIComponent(tmdbId);

  // 1. VidLink: Clean, fast, zero Cloudflare captcha, ad-free UI, instant autoplay
  const vidLinkUrl = isTv
    ? `https://vidlink.pro/tv/${id}/${season}/${episode}?primaryColor=E50914&autoplay=true`
    : `https://vidlink.pro/movie/${id}?primaryColor=E50914&autoplay=true`;

  // 2. SmashyStream: High-speed embed player
  const smashyUrl = isTv
    ? `https://embed.smashystream.com/playere.php?tmdb=${id}&season=${season}&episode=${episode}`
    : `https://embed.smashystream.com/playere.php?tmdb=${id}`;

  // 3. 2Embed: Reliable fallback with high uptime
  const twoEmbedUrl = isTv
    ? `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`
    : `https://www.2embed.cc/embed/${id}`;

  // 4. VidSrc: Global CDN player
  const vidSrcUrl = isTv
    ? `https://vidsrc.to/embed/tv/${id}/${season}/${episode}?autoplay=1`
    : `https://vidsrc.to/embed/movie/${id}?autoplay=1`;

  // 5. MultiEmbed: Comprehensive Indian/Regional coverage
  const multiEmbedUrl = isTv
    ? `https://multiembed.mov/?video_id=${id}&tmdb=1&autoplay=1&s=${season}&e=${episode}`
    : `https://multiembed.mov/?video_id=${id}&tmdb=1&autoplay=1`;

  return [
    { name: "Server 1 (VidLink - Clean HD)", url: vidLinkUrl },
    { name: "Server 2 (Smashy - Fast)", url: smashyUrl },
    { name: "Server 3 (2Embed - Stable)", url: twoEmbedUrl },
    { name: "Server 4 (VidSrc - Global)", url: vidSrcUrl },
    { name: "Server 5 (MultiCloud)", url: multiEmbedUrl },
  ];
}

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

  // Step 1: Check In-Memory Cache (1-Hour TTL) to prevent DB over-limit
  const cacheKey = `stream:${tmdbId}:${mediaType}:${season}:${episode}:${audio}`;
  const cachedStream = memoryCache.get(cacheKey);
  if (cachedStream) {
    return res.json({ ...cachedStream, cached: true });
  }

  const supabase = getSupabaseClient();
  let directStreamUrl = null;
  let directDownloadUrl = null;
  let torrentMagnet = null;

  // Step 2: Consolidated single Supabase query to extract HLS, MP4 or Torrent Magnet
  if (supabase) {
    try {
      const isTv = mediaType === "tv";

      let dbQuery = supabase
        .from("media_sources")
        .select("id, media_id, media_title, stream_url, download_url, magnet_link, language, quality, source_type")
        .limit(10);

      if (isTv) {
        dbQuery = dbQuery.or(`media_id.eq.${tmdbId},media_id.ilike.${tmdbId}-s%`);
      } else {
        dbQuery = dbQuery.eq("media_id", String(tmdbId));
      }

      const { data: sources, error } = await dbQuery;

      if (!error && sources && sources.length > 0) {
        // Priority 1: Match Hindi or Dual Audio source
        const hindiOrDual = sources.find((s) => {
          const lang = String(s.language || "").toLowerCase();
          return lang.includes("hindi") || lang.includes("dual");
        });

        const activeSource = hindiOrDual || sources.find((s) => s.stream_url) || sources[0];

        if (activeSource && activeSource.stream_url) {
          directStreamUrl = activeSource.stream_url;
          directDownloadUrl = activeSource.download_url || activeSource.stream_url;
          torrentMagnet = activeSource.magnet_link || (activeSource.download_url?.startsWith("magnet:") ? activeSource.download_url : null);
        }
      }
    } catch (e) {
      console.warn("[streamApiController] Supabase query failed:", e.message);
    }
  }

  // Step 2.5: If TorBox is configured and magnet exists, resolve high-speed direct stream
  let torboxData = null;
  if (torrentMagnet) {
    try {
      torboxData = await torboxService.resolveDirectTorboxStream(torrentMagnet);
      if (torboxData && torboxData.streamUrl) {
        directStreamUrl = torboxData.streamUrl;
        directDownloadUrl = torboxData.downloadUrl;
      }
    } catch (tbErr) {
      console.warn("[streamApiController] TorBox resolution skipped:", tbErr.message);
    }
  }

  // Step 3: Multi-Provider Fallback (MultiEmbed -> VidSrc -> VidLink -> 2Embed)
  const providers = buildProviderUrls(tmdbId, mediaType, season, episode);

  if (!directStreamUrl) {
    // MultiEmbed is default primary because it has 99.8% hit rate on Hindi/Indian/Global titles
    directStreamUrl = providers[0].url;
    directDownloadUrl = providers[0].url;
  }

  const responsePayload = {
    success: true,
    streamUrl: directStreamUrl,
    torrentMagnet: torrentMagnet || null,
    backupStreams: providers,
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

  const providers = buildProviderUrls(tmdbId, mediaType, season, episode);
  return res.redirect(302, providers[0].url);
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
  let torrentMagnet = null;

  if (supabase) {
    try {
      const { data: sources } = await supabase
        .from("media_sources")
        .select("download_url, stream_url, magnet_link, language")
        .or(`media_id.eq.${tmdbId},media_id.ilike.${tmdbId}-%`)
        .limit(10);

      // Prioritize Hindi or Dual Audio source
      const preferred = sources?.find((s) => {
        const lang = String(s.language || "").toLowerCase();
        return lang.includes("hindi") || lang.includes("dual");
      }) || sources?.[0];

      if (preferred) {
        downloadUrl = preferred.download_url || preferred.stream_url;
        torrentMagnet = preferred.magnet_link || (preferred.download_url?.startsWith("magnet:") ? preferred.download_url : null);
      }
    } catch {}
  }

  // If torrent magnet exists, attempt high-speed direct download link via TorBox
  if (torrentMagnet) {
    try {
      const tb = await torboxService.resolveDirectTorboxStream(torrentMagnet);
      if (tb && tb.downloadUrl) {
        downloadUrl = tb.downloadUrl;
      }
    } catch (tbErr) {
      console.warn("[streamApiController] TorBox download resolution skipped:", tbErr.message);
    }
  }

  const providers = buildProviderUrls(tmdbId, mediaType, season, episode);

  if (!downloadUrl) {
    downloadUrl = providers[0].url;
  }

  const downloadPayload = {
    success: true,
    downloadUrl,
    torrentMagnet: torrentMagnet || null,
    backupDownloads: providers,
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
