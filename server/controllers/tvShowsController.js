"use strict";

/**
 * TV Show controller — thin HTTP layer over mediaContentService.
 * Every handler is wrapped so rejections flow into the error middleware.
 */

const { asyncHandler, HttpError } = require("../utils/http");
const { sendMediaResult } = require("../utils/response");
const mediaContent = require("../services/mediaContentService");
const tvmaze = require("../services/tvmazeService");
const { checkSupabaseConnection } = require("../services/supabaseClient");
const env = require("../config/env");

/** GET /api/tv-shows/:id — lazy cached lookup by TVMaze id. */
const getShowById = asyncHandler(async (req, res) => {
  const result = await mediaContent.getTvShowByExternalId(req.params.id, {
    refresh: isTruthy(req.query.refresh),
  });
  return sendMediaResult(res, result, { externalId: Number(result.row.external_id) });
});



/** GET /api/tv-shows/discover — TMDb-shaped category/search feed for the desktop client. */
const discoverShows = asyncHandler(async (req, res) => {
  const payload = await mediaContent.discoverTvShows({
    page: req.query.page, limit: req.query.limit, year: req.query.year,
    genreId: req.query.genreId, sort: req.query.sort, query: req.query.q || req.query.query,
  });
  return res.json({ ok: true, ...payload });
});

/** GET /api/tv-shows?title=… — cached title lookup with TVMaze fallback. */
const getShowByTitle = asyncHandler(async (req, res) => {
  const title = String(req.query.title || req.query.q || "").trim();
  if (!title) throw new HttpError(400, "Query parameter `title` is required", "MISSING_TITLE");

  const result = await mediaContent.getTvShowByTitle(title, {
    refresh: isTruthy(req.query.refresh),
  });
  return sendMediaResult(res, result, {
    query: title,
    matchedBy: result.matchedBy,
    searchScore: result.searchScore ?? null,
  });
});

/** GET /api/tv-shows/cache — everything already stored (never calls TVMaze). */
const listCached = asyncHandler(async (req, res) => {
  const payload = await mediaContent.listCachedShows({
    page: req.query.page,
    limit: req.query.limit,
  });
  return res.json({ ok: true, cached: true, source: "supabase", upstreamCalled: false, ...payload });
});

/** GET /api/tv-shows/search?q=… — TVMaze search results (not persisted). */
const searchShows = asyncHandler(async (req, res) => {
  const query = String(req.query.q || req.query.title || "").trim();
  if (!query) throw new HttpError(400, "Query parameter `q` is required", "MISSING_QUERY");

  const matches = await tvmaze.searchShows(query, Number(req.query.limit) || 10);
  return res.json({
    ok: true,
    cached: false,
    source: "tvmaze",
    upstreamCalled: true,
    query,
    total: matches.length,
    items: matches.map((entry) => ({
      score: entry.score,
      ...tvmaze.formatShowPayload(entry.show),
    })),
  });
});

/** POST /api/tv-shows/prefetch — warm the cache without an immediate read. */
const prefetchShow = asyncHandler(async (req, res) => {
  const id = Number(req.body?.id ?? req.body?.externalId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "Body must contain a positive numeric `id`", "INVALID_ID");
  }
  const result = await mediaContent.getTvShowByExternalId(id, { refresh: isTruthy(req.query.refresh) });
  return sendMediaResult(res, result, { prefetched: true });
});

/** GET /api/tv-shows/health — configuration + database reachability. */
const health = asyncHandler(async (req, res) => {
  const db = await checkSupabaseConnection();
  const payload = {
    ok: Boolean(db.ok && db.tableReady),
    service: "tv-shows",
    config: env.describeEnv(),
    database: {
      reachable: db.ok,
      tableReady: db.tableReady,
      cachedRows: db.rowCount,
      error: db.error ? db.error.message : null,
    },
  };
  return res.status(payload.ok ? 200 : 503).json(payload);
});

function isTruthy(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

module.exports = {
  getShowById,
  getShowByTitle,
  listCached,
  searchShows,
  discoverShows,
  prefetchShow,
  health,
};