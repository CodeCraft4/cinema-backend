"use strict";

const rateLimit = require("express-rate-limit");

/**
 * Global rate limiter to protect against scraping, DDOS, and infinite fetching loops.
 */
const apiRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // Max 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please wait a moment before trying again.",
    code: "RATE_LIMIT_EXCEEDED",
  },
  skip: (req) => {
    // Never rate limit internal probes or health checks
    return req.path === "/" || req.path === "/health";
  },
});

/**
 * Specific rate limiter for streaming / sources endpoints
 */
const streamRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Max 60 stream lookups per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Streaming request limit reached. Please wait a moment.",
    code: "STREAM_RATE_LIMIT",
  },
});

module.exports = {
  apiRateLimiter,
  streamRateLimiter,
};
