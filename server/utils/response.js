"use strict";

/** Shared response envelope: { ok, cached, source, upstreamCalled, data } */
function sendMediaResult(res, result, extra = {}) {
  return res.json({
    ok: true,
    cached: result.cacheHit,
    source: result.cacheHit ? "supabase" : "tvmaze",
    upstreamCalled: result.upstreamCalled,
    stale: Boolean(result.stale),
    stored: Boolean(result.stored),
    ...extra,
    data: result.row,
  });
}

module.exports = { sendMediaResult };