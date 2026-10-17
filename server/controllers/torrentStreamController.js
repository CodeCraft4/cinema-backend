"use strict";

const { asyncHandler } = require("../utils/http");
const { streamTorrentToHttp, extractInfoHash, normalizeMagnet } = require("../services/torrentStreamEngine");

/**
 * Controller for GET / HEAD /api/media/stream/torrent...
 */
const handleTorrentStream = asyncHandler(async (req, res) => {
  // 1. Disable Node.js request and socket timeouts for large 1GB-5GB+ files
  if (req.setTimeout) req.setTimeout(0);
  if (res.setTimeout) res.setTimeout(0);
  if (req.socket?.setTimeout) req.socket.setTimeout(0);
  if (res.socket?.setTimeout) res.socket.setTimeout(0);
  req.socket?.setKeepAlive(true, 10000);

  const hashParam = req.params.hash;
  const magnetQuery = req.query.magnet;
  const hashQuery = req.query.hash || req.query.infoHash;

  const target = hashParam || hashQuery || magnetQuery;
  if (!target) {
    return res.status(400).json({
      error: "Missing torrent identifier. Provide /:hash or ?magnet=... or ?hash=...",
    });
  }

  const infoHash = extractInfoHash(target);
  const magnet = normalizeMagnet(magnetQuery || target);

  const isDownload = req.query.download === "1" || req.path.includes("/download/");
  const ep = req.query.episode || req.query.ep;
  const s = req.query.season || req.query.s;

  // Safe Cloud Mode (Railway Protected):
  // Railway and shared cloud hosts ban P2P BitTorrent traffic with "ToS Violation".
  // Unless explicitly enabled (ENABLE_P2P_TORRENT=true on dedicated VPS), instantly route to direct high-speed CDN stream!
  const enableP2P = process.env.ENABLE_P2P_TORRENT === "true";
  if (!enableP2P && infoHash) {
    try {
      const { getSupabaseClient } = require("../services/supabaseClient");
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from("media_sources")
        .select("media_id, media_title, payload")
        .or(`stream_url.ilike.%${infoHash}%,download_url.ilike.%${infoHash}%,magnet_link.ilike.%${infoHash}%`)
        .limit(1);

      const item = data?.[0];
      const tmdbId = item?.payload?.tmdb_id || item?.media_id;
      const season = s || item?.payload?.season;
      const episode = ep || item?.payload?.episode;

      if (tmdbId) {
        const cleanId = String(tmdbId).replace(/^[^\d]+/, "");
        const streamUrl = season && episode
          ? `https://vidlink.pro/tv/${cleanId}/${season}/${episode}`
          : `https://vidlink.pro/movie/${cleanId}`;
        console.log(`[SafeCloudMode] Railway protected: redirecting ${infoHash} to CDN stream -> ${streamUrl}`);
        return res.redirect(302, streamUrl);
      }

      // If tmdbId is not found in database, redirect to autoembed rather than hanging on torrent swarm
      console.warn(`[SafeCloudMode] tmdbId not found for ${infoHash}, redirecting to fallback embed stream`);
      return res.redirect(302, `https://player.autoembed.cc/embed/movie/${infoHash}`);
    } catch (err) {
      console.warn("[SafeCloudMode] Lookup error:", err.message);
      return res.redirect(302, `https://player.autoembed.cc/embed/movie/${infoHash}`);
    }
  }

  return streamTorrentToHttp(req, res, {
    magnet,
    infoHash,
    isDownload,
  });
});

module.exports = {
  handleTorrentStream,
};
