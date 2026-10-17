"use strict";

/**
 * Express application for the media caching API.
 * Kept separate from server/index.js so it can be started or unit-tested directly.
 */

const express = require("express");
const tvShowsRoutes = require("./routes/tvShowsRoutes");
const mediaRoutes = require("./routes/mediaRoutes");
const downloadSourceRouter = require("./routes/downloadSourceRoutes");
const { getMediaSources } = require("./controllers/mediaDownloadController");
const { requestLogger } = require("./middleware/requestLogger");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const env = require("./config/env");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(requestLogger);

// A friendly root response prevents Railway/proxy probes from receiving a
// misleading 404. The health endpoint below remains the recommended probe.
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "cinebroad-media-service",
    status: "running",
    health: "/health",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "cinebroad-media-service",
    supabaseConfigured: env.isSupabaseConfigured(),
    tvmazeBaseUrl: env.tvmazeBaseUrl,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use("/api/tv-shows", tvShowsRoutes);
app.use("/api/media", mediaRoutes);
// Plural + list aliases — frontend may call either spelling.
app.use("/api/media/download-sources", downloadSourceRouter);
app.get("/api/media/sources", getMediaSources);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;