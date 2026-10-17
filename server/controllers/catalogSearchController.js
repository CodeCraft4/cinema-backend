"use strict";

const { asyncHandler, HttpError } = require("../utils/http");
const { searchCatalogTitle } = require("../services/catalogSearchService");

/** GET /api/media/search?q=Title — DB first, otherwise TMDb + OMDb + torrents. */
const searchCatalog = asyncHandler(async (req, res) => {
  const query = String(req.query.q || req.query.title || req.query.query || "").trim();
  if (!query) throw new HttpError(400, "Query parameter `q` is required", "MISSING_QUERY");
  const result = await searchCatalogTitle(query, {
    year: req.query.year || "",
    mediaType: req.query.type || req.query.media_type || "",
  });
  return res.json({ ok: true, ...result });
});

module.exports = { searchCatalog };
