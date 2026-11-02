"use strict";

const { asyncHandler } = require("../utils/http");
const { memoryCache } = require("../services/memoryCache");
const { getSupabaseClient } = require("../services/supabaseClient");
const env = require("../config/env");

/**
 * GET /api/title/:type/:tmdbId/ratings
 * IMDb rating (via OMDb) for a movie / series. One small request per title, cached 24h on the
 * server (and the app caches it too), so details pages never hit OMDb or Supabase repeatedly.
 */
async function imdbIdFor(type, tmdbId) {
  try {
    const { data } = await getSupabaseClient()
      .from("media_content")
      .select("details")
      .eq("media_type", type)
      .eq("external_id", Number(tmdbId))
      .limit(1);
    const stored = data?.[0]?.details?.imdb_id;
    if (stored) return stored;
  } catch {
    // fall through to TMDB
  }
  try {
    const key = process.env.TMDB_API_KEY || env.tmdbApiKey;
    const res = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${key}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()).imdb_id || null;
  } catch {
    return null;
  }
}

const getTitleRatings = asyncHandler(async (req, res) => {
  const type = req.params.type === "tv" ? "tv" : "movie";
  const { tmdbId } = req.params;
  if (!/^\d+$/.test(String(tmdbId))) return res.status(400).json({ success: false, error: "Invalid tmdbId" });

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");

  const cacheKey = `ratings:${type}:${tmdbId}`;
  const hit = memoryCache.get(cacheKey);
  if (hit) return res.json({ ...hit, cached: true });

  const imdbId = await imdbIdFor(type, tmdbId);
  let payload = { success: true, imdbId: imdbId || null, imdbRating: null, imdbVotes: null };
  const omdbKey = env.omdbApiKey || process.env.OMDB_API_KEY;
  if (imdbId && omdbKey) {
    try {
      const r = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbKey}`, { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      const rating = parseFloat(j.imdbRating);
      if (Number.isFinite(rating)) payload = { ...payload, imdbRating: rating, imdbVotes: j.imdbVotes || null };
    } catch {
      // keep the empty payload; the app just hides the badge
    }
  }
  // A miss is cached shorter so a transient OMDb failure heals quickly.
  memoryCache.set(cacheKey, payload, payload.imdbRating ? 24 * 3600 * 1000 : 10 * 60 * 1000);
  return res.json(payload);
});

module.exports = { getTitleRatings };
