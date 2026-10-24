"use strict";

const { Router } = require("express");
const { getStream, getManifest, getDownload } = require("../controllers/streamApiController");

const router = Router();

// Handle preflight OPTIONS & HEAD for all stream endpoints
router.options("/stream/manifest/:tmdbId", (req, res) => res.status(204).end());
router.get("/stream/manifest/:tmdbId", getManifest);
router.head("/stream/manifest/:tmdbId", getManifest);

router.options("/stream/:tmdbId", (req, res) => res.status(204).end());
router.get("/stream/:tmdbId", getStream);
router.head("/stream/:tmdbId", getStream);

router.options("/download/:tmdbId", (req, res) => res.status(204).end());
router.get("/download/:tmdbId", getDownload);
router.head("/download/:tmdbId", getDownload);

module.exports = router;
