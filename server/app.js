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
const { apiRateLimiter } = require("./middleware/rateLimiter");
const env = require("./config/env");
const streamRoutes = require("./routes/streamRoutes");

const app = express();

app.disable("x-powered-by");

// Global CORS & Preflight Middleware for Web (localhost:8081, PWA) & Mobile
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization"
  );
  res.header(
    "Access-Control-Expose-Headers",
    "Content-Range, Accept-Ranges, Content-Length, ETag"
  );

  // Preflight OPTIONS requests must immediately return 204 No Content
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

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

// Protect API routes with rate limiter against infinite loop requests
app.use("/api", apiRateLimiter);

app.use("/api/tv-shows", tvShowsRoutes);
app.use("/api/media", mediaRoutes);
// Plural + list aliases — frontend may call either spelling.
app.use("/api/media/download-sources", downloadSourceRouter);
app.get("/api/media/sources", getMediaSources);

// Clean direct HLS & Download Resolver routes: /api/stream/:tmdbId, /api/download/:tmdbId
app.use("/api", streamRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;