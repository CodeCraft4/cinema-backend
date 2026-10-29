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

  // 1. MultiEmbed: Comprehensive Indian/Regional/Global coverage with 10+ mirror hosts (StreamWish, Filelions, etc.)
  const multiEmbedUrl = isTv
    ? `https://multiembed.mov/?video_id=${id}&tmdb=1&autoplay=1&s=${season}&e=${episode}`
    : `https://multiembed.mov/?video_id=${id}&tmdb=1&autoplay=1`;

  // 2. VidSrc: Global CDN player with broad coverage
  const vidSrcUrl = isTv
    ? `https://vidsrc.to/embed/tv/${id}/${season}/${episode}?autoplay=1`
    : `https://vidsrc.to/embed/movie/${id}?autoplay=1`;

  // 3. SmashyStream: High-speed embed player
  const smashyUrl = isTv
    ? `https://embed.smashystream.com/playere.php?tmdb=${id}&season=${season}&episode=${episode}`
    : `https://embed.smashystream.com/playere.php?tmdb=${id}`;

  // 4. VidLink: Clean, fast, zero Cloudflare captcha, ad-free UI, instant autoplay
  const vidLinkUrl = isTv
    ? `https://vidlink.pro/tv/${id}/${season}/${episode}?primaryColor=E50914&autoplay=true`
    : `https://vidlink.pro/movie/${id}?primaryColor=E50914&autoplay=true`;

  // 5. 2Embed: Reliable fallback with high uptime
  const twoEmbedUrl = isTv
    ? `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`
    : `https://www.2embed.cc/embed/${id}`;

  return [
    { name: 'Server 1 (MultiCloud - 99% Hit Rate)', url: multiEmbedUrl },
    { name: 'Server 2 (VidSrc - Global)', url: vidSrcUrl },
    { name: 'Server 3 (Smashy - Fast)', url: smashyUrl },
    { name: 'Server 4 (VidLink - Clean HD)', url: vidLinkUrl },
    { name: 'Server 5 (2Embed - Stable)', url: twoEmbedUrl },
  ];
}

const getStream = asyncHandler(async (req, res) => {
  const { tmdbId } = req.params;
  const mediaType = req.query.mediaType === "tv" ? "tv" : "movie";
  const season = req.query.season ? Number(req.query.season) : 1;
  const episode = req.query.episode ? Number(req.query.episode) : 1;
  const audio = String(req.query.audio || "hi").toLowerCase();
  const quality = String(req.query.quality || "auto").toLowerCase();

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
  const cacheKey = `stream:${tmdbId}:${mediaType}:${season}:${episode}:${audio}:${quality}`;
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
        // Helper: verify that audio release is genuinely Hindi / Hindi Dual, not foreign dual
        const isForeignNonHindi = (text) => {
          const lower = String(text || "").toLowerCase();
          if (lower.includes("hindi") || lower.includes("hin")) return false;
          return /codigo|vinganca|portugues|latino|french|spanish|russian|italian|german|polish|brazilian/.test(lower);
        };

        const isGenuineHindiOrDual = (s) => {
          const lang = String(s.language || "").toLowerCase();
          const title = String(s.media_title || "").toLowerCase();
          const magnet = String(s.magnet_link || s.download_url || "").toLowerCase();

          if (isForeignNonHindi(magnet) || isForeignNonHindi(lang)) {
            return false;
          }

          // South Indian movies (Tamil, Telugu, Malayalam, Kannada) must explicitly have Hindi dubbing/dual
          const isSouth = /tamil|telugu|malayalam|kannada/.test(magnet) || /tamil|telugu|malayalam|kannada/.test(lang);
          if (isSouth) {
            return /hindi|\bhin\b|dubbed/.test(magnet) || /hindi|\bhin\b|dubbed/.test(lang) || /hindi/.test(title);
          }

          return (
            lang.includes("hindi") ||
            (lang.includes("dual") && (lang.includes("hindi") || magnet.includes("hindi") || !/foreign/.test(lang))) ||
            title.includes("hindi") ||
            magnet.includes("hindi") ||
            magnet.includes("dubbed")
          );
        };

        // Priority 1: Match genuine Hindi or Dual Audio source
        const hindiOrDual = sources.find(isGenuineHindiOrDual);

        // Priority 1.5: If user specifically requested 720p or 480p, pick matching source
        let matchingQuality = null;
        if (quality !== "auto") {
          matchingQuality = sources.find((s) => {
            const q = String(s.quality || "").toLowerCase();
            return isGenuineHindiOrDual(s) && q.includes(quality);
          });
        }

        let activeSource = null;
        if (matchingQuality) {
          activeSource = matchingQuality;
        } else if (hindiOrDual) {
          activeSource = hindiOrDual;
        } else if (audio !== "hi") {
          // Only pick English/original sources if the user did not specifically request Hindi
          activeSource = sources.find((s) => s.stream_url) || sources[0];
        }

        if (activeSource) {
          // Only assign directStreamUrl if it's a real direct CDN/HLS URL, NOT the internal VPS torrent bridge
          if (
            activeSource.stream_url &&
            !activeSource.stream_url.includes("/api/media/stream/torrent/")
          ) {
            directStreamUrl = activeSource.stream_url;
            directDownloadUrl = activeSource.download_url || activeSource.stream_url;
          }
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

  // Step 4: Save in Memory Cache
  // If direct TorBox 1Gbps stream is resolved, cache for 2 Hours (matches TorBox link expiry)
  // If temporary fallback was used because TorBox is still downloading, cache for only 30 seconds so it switches to TorBox as soon as it's ready!
  const isDirectTorbox = Boolean(torboxData && torboxData.streamUrl);
  const cacheTtl = isDirectTorbox ? 2 * 60 * 60 * 1000 : 30 * 1000;
  memoryCache.set(cacheKey, responsePayload, cacheTtl);

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
        const rawUrl = preferred.download_url || preferred.stream_url;
        if (rawUrl && !rawUrl.includes("/api/media/stream/torrent/")) {
          downloadUrl = rawUrl;
        }
        torrentMagnet = preferred.magnet_link || (preferred.download_url?.startsWith("magnet:") ? preferred.download_url : null);
      }
    } catch {}
  }

  // If torrent magnet exists, attempt high-speed direct download link via TorBox
  let tb = null;
  if (torrentMagnet) {
    try {
      tb = await torboxService.resolveDirectTorboxStream(torrentMagnet);
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

  const isDirectTbDownload = Boolean(tb && tb.downloadUrl);
  const dlCacheTtl = isDirectTbDownload ? 2 * 60 * 60 * 1000 : 30 * 1000;
  memoryCache.set(cacheKey, downloadPayload, dlCacheTtl);

  return res.json(downloadPayload);
});

module.exports = {
  getStream,
  getManifest,
  getDownload,
};
