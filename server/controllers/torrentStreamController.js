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
  // Serve torrent media only from this API. Never send native clients to embed players.
  const enableP2P = process.env.ENABLE_P2P_TORRENT !== "false";
  if (!enableP2P && infoHash) {
    return res.status(503).json({
      ok: false,
      code: "P2P_TORRENT_DISABLED",
      error: "P2P torrent streaming is disabled on this server.",
      infoHash,
      retryable: false,
    });
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
