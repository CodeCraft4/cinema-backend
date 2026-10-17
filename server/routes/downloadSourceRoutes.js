"use strict";

/**
 * Mounted at /api/media/download-sources so POST /api/media/download-sources
 * works without an extra path segment.
 */
const { Router } = require("express");
const controller = require("../controllers/mediaDownloadController");

const router = Router();

router.post("/", controller.downloadSource);
router.get("/", controller.getMediaSources);

module.exports = router;
