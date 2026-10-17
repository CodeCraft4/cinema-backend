"use strict";

const { asyncHandler, HttpError } = require("../utils/http");
const { fetchTmdbAndEnrich, LIST_PATHS, MAX_LIMIT, DEFAULT_LIMIT } = require("../services/tmdbFetchEnrichService");

function readOptions(req) {
  const body = req.body || {};
  const query = req.query || {};
  const list = String(body.list || query.list || "popular").toLowerCase();
  if (!LIST_PATHS[list]) {
    throw new HttpError(400, `list must be one of: ${Object.keys(LIST_PATHS).join(", ")}`, "BAD_LIST");
  }
  return {
    list,
    page: body.page ?? query.page ?? 1,
    limit: body.limit ?? query.limit ?? DEFAULT_LIMIT,
    skipEnrich: Boolean(body.skip_enrich ?? body.skipEnrich ?? query.skip_enrich),
  };
}

/**
 * POST /api/media/fetch-tmdb
 * One-click: TMDB metadata → media_content → Torrentio Hindi/Dual → DDL media_sources.
 * Also accepts GET for easy browser/button testing.
 */
const fetchTmdbCatalog = asyncHandler(async (req, res) => {
  const options = readOptions(req);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT));
  const result = await fetchTmdbAndEnrich({
    ...options,
    limit,
    baseUrl: req,
  });
  return res.json({
    ...result,
    message:
      "Fetched TMDB metadata into media_content, then auto-enriched Hindi/Dual Audio torrents into media_sources as streamable DDL URLs.",
  });
});

module.exports = { fetchTmdbCatalog };
