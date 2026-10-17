"use strict";

const { Router } = require("express");
const controller = require("../controllers/tvShowsController");

const router = Router();

// Static paths first so they are never captured by the ":id" route below.
router.get("/health", controller.health);
router.get("/cache", controller.listCached);
router.get("/discover", controller.discoverShows);

router.get("/search", controller.searchShows);

router.get("/", controller.getShowByTitle); // /api/tv-shows?title=Breaking Bad
router.post("/prefetch", controller.prefetchShow);
router.get("/:id", controller.getShowById); // /api/tv-shows/431

module.exports = router;