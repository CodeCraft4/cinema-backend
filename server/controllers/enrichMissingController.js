"use strict";

const { asyncHandler } = require("../utils/http");
const {
  startEnrichMissing,
  stopEnrichMissing: stopJob,
  getEnrichMissingStatus,
  DEFAULT_BATCH,
  MAX_BATCH,
} = require("../services/enrichMissingService");

function readOptions(req) {
  const body = req.body || {};
  const query = req.query || {};
  return {
    limit: body.limit ?? query.limit ?? DEFAULT_BATCH,
    afterId: body.after_id ?? body.afterId ?? query.after_id ?? 0,
    workers: body.workers ?? query.workers ?? 4,
    continuous: body.continuous !== undefined ? Boolean(body.continuous) : query.continuous !== undefined ? query.continuous === "true" : true,
  };
}

/**
 * POST /api/media/enrich-missing
 * Background enrich for media_content rows that still have no ready DDL/torrent.
 * Safe on Railway: runs continuously in background until all ~7,000 items are evaluated.
 */
const enrichMissing = asyncHandler(async (req, res) => {
  const options = readOptions(req);
  const status = await startEnrichMissing({
    ...options,
    baseUrl: req,
  });
  return res.status(202).json({
    ok: true,
    message: "Enrich-missing continuous background job started. Check GET /api/media/enrich-missing for real-time progress.",
    max_batch: MAX_BATCH,
    ...status,
  });
});

const enrichMissingStatus = asyncHandler(async (_req, res) => {
  return res.json({ ok: true, ...getEnrichMissingStatus() });
});

const stopEnrichMissing = asyncHandler(async (_req, res) => {
  stopJob();
  return res.json({ ok: true, message: "Enrichment job stopped." });
});

module.exports = { enrichMissing, enrichMissingStatus, stopEnrichMissing };
