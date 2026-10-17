"use strict";

const { Router } = require("express");
const controller = require("../controllers/mediaDownloadController");
const { searchCatalog } = require("../controllers/catalogSearchController");
const { handleTorrentStream } = require("../controllers/torrentStreamController");
const { fetchTmdbCatalog } = require("../controllers/tmdbFetchController");
const { enrichMissing, enrichMissingStatus, stopEnrichMissing } = require("../controllers/enrichMissingController");

const router = Router();

router.get("/search", searchCatalog);
router.get("/catalog", controller.getPlayableCatalog);
// One-click: TMDB metadata → media_content → Torrentio Hindi/Dual → DDL media_sources
router.post("/fetch-tmdb", fetchTmdbCatalog);
router.get("/fetch-tmdb", fetchTmdbCatalog);
// Fill remaining media_content titles that still have no ready DDL/torrent (Railway-safe continuous background job)
router.post("/enrich-missing", enrichMissing);
router.get("/enrich-missing", enrichMissingStatus);
router.post("/enrich-stop", stopEnrichMissing);
// Singular + plural aliases so the client never 404s on either spelling.
router.post("/download-source", controller.downloadSource);
router.post("/download-sources", controller.downloadSource);
router.post("/request-download", controller.downloadSource);
router.post("/resolve-source", controller.resolveSource);
router.get("/sources", controller.getMediaSources);
router.get("/sources/:mediaId", controller.getMediaSources);
router.get("/download-sources", controller.getMediaSources);
router.get("/download-source", controller.getMediaSources);

// On-The-Fly Torrent-to-HTTP Streaming & Download Engine (GET & HEAD)
router.get("/stream/torrent", handleTorrentStream);
router.head("/stream/torrent", handleTorrentStream);
router.get("/stream/torrent/:hash", handleTorrentStream);
router.head("/stream/torrent/:hash", handleTorrentStream);
router.get("/stream/torrent/:hash/:filename", handleTorrentStream);
router.head("/stream/torrent/:hash/:filename", handleTorrentStream);
router.get("/download/torrent/:hash", handleTorrentStream);
router.head("/download/torrent/:hash", handleTorrentStream);
router.get("/download/torrent/:hash/:filename", handleTorrentStream);
router.head("/download/torrent/:hash/:filename", handleTorrentStream);

module.exports = router;

