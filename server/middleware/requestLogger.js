"use strict";

/** Compact request logger so cache-hit vs API-call traffic is visible in the console. */
function requestLogger(req, res, next) {
  const startedAt = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    console.log(`[http  ] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
}

module.exports = { requestLogger };