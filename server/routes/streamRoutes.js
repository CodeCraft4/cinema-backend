"use strict";

const { Router } = require("express");
const { getStream, getManifest, getDownload } = require("../controllers/streamApiController");

const router = Router();

router.get("/stream/manifest/:tmdbId", getManifest);
router.get("/stream/:tmdbId", getStream);
router.get("/download/:tmdbId", getDownload);

module.exports = router;
