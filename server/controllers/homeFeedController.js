"use strict";

const { asyncHandler } = require("../utils/http");
const { memoryCache } = require("../services/memoryCache");
const { getSupabaseClient } = require("../services/supabaseClient");

/**
 * GET /api/home
 * The whole home screen in ONE request: new movies, Bollywood, Hollywood and popular series.
 * Items match the app's MediaItem shape. Built from ready media_sources (light columns) plus
 * media_content details, cached 10 minutes on the server and by the CDN/app via Cache-Control,
 * so opening the app costs Supabase two small queries per 10 minutes instead of dozens per user.
 */
const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
  10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
  878: "Sci-Fi", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
  10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy",
  10766: "Soap", 10767: "Talk", 10768: "War & Politics",
};
const QUALITY_ORDER = ["480p", "720p", "1080p", "2160p"];
const ROW_LIMIT = 40;

function badgeOf(languages) {
  const text = [...languages].join(" ").toLowerCase();
  if (/dual/.test(text)) return "Dual Audio";
  if (/hindi/.test(text)) return "Hindi";
  return undefined;
}

function toItem(content, type, sources) {
  const d = content.details || {};
  const date = d.release_date || d.first_air_date || null;
  const year = Number(String(date || d.year || "").slice(0, 4)) || 0;
  const rating = Number(d.vote_average) || 0;
  const qualities = QUALITY_ORDER.filter((q) => sources.some((s) => s.quality === q));
  const languages = [...new Set(sources.map((s) => s.language).filter(Boolean))];
  const top = [...qualities].reverse().find((q) => q === "1080p" || q === "720p");
  return {
    id: String(content.external_id),
    externalId: Number(content.external_id),
    title: content.title || d.title || d.name || "",
    type,
    posterUrl: d.poster_url || (d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : ""),
    backdropUrl: d.backdrop_url || (d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : ""),
    rating: Math.round(rating * 10) / 10,
    ratingPercent: Math.round(rating * 10),
    releaseYear: year,
    releaseDate: date || undefined,
    quality: top,
    genres: (d.genre_ids || []).map((id) => GENRES[id]).filter(Boolean),
    overview: d.overview || "",
    languages,
    originalLanguage: d.original_language || undefined,
    qualities,
    audioBadge: badgeOf(languages),
    qualityLabel: qualities.length ? qualities[0] : undefined,
    hasDownload: true,
    sourceKind: "torrent",
  };
}

async function buildHome() {
  const sb = getSupabaseClient();
  // Every playable row (light columns only, paginated); the result is cached for 10 minutes.
  const rows = [];
  for (let from = 0; from < 12000; from += 1000) {
    const { data, error } = await sb
      .from("media_sources")
      .select("media_id, quality, language")
      .eq("status", "ready")
      .range(from, from + 999)
      .order("id");
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const movieSources = new Map();
  const showSources = new Map();
  for (const r of rows || []) {
    const m = /^(\d+)-s\d+e\d+$/i.exec(r.media_id);
    const map = m ? showSources : movieSources;
    const id = m ? m[1] : r.media_id;
    if (!/^\d+$/.test(String(id))) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(r);
  }

  const wanted = async (type, ids) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await sb
        .from("media_content")
        .select("external_id, title, media_type, details")
        .eq("media_type", type)
        .in("external_id", ids.slice(i, i + 200).map(Number));
      out.push(...(data || []));
    }
    return out;
  };
  const [movieContent, tvContent] = await Promise.all([wanted("movie", [...movieSources.keys()]), wanted("tv", [...showSources.keys()])]);

  const today = new Date().toISOString().slice(0, 10);
  const movies = movieContent
    .map((c) => toItem(c, "movie", movieSources.get(String(c.external_id)) || []))
    .filter((i) => i.posterUrl && (!i.releaseDate || i.releaseDate <= today));
  const shows = tvContent
    .map((c) => toItem(c, "tv", showSources.get(String(c.external_id)) || []))
    .filter((i) => i.posterUrl);

  const newest = (a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || "");
  const byIndustry = (lang) => movies.filter((i) => i.originalLanguage === lang).sort(newest).slice(0, ROW_LIMIT);
  const fiveYearsAgo = new Date().getFullYear() - 5;
  const newMovies = movies.filter((i) => i.releaseYear >= fiveYearsAgo).sort(newest).slice(0, ROW_LIMIT);
  const popularTv = shows.sort((a, b) => b.rating - a.rating).slice(0, ROW_LIMIT);

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    newMovies,
    bollywood: byIndustry("hi"),
    hollywood: byIndustry("en"),
    popularTv,
  };
}

let inflight = null;

async function refreshHomeFeed() {
  // One build at a time: a burst of app opens shares the same Supabase work.
  inflight ||= buildHome().finally(() => {
    inflight = null;
  });
  const payload = await inflight;
  memoryCache.set("home:feed", payload, 10 * 60 * 1000);
  return payload;
}

const getHomeFeed = asyncHandler(async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
  const hit = memoryCache.get("home:feed");
  if (hit) return res.json({ ...hit, cached: true });
  return res.json(await refreshHomeFeed());
});

// Keep the cache warm so the first user after a restart / expiry never waits for the build.
if (process.env.NODE_ENV !== "test") {
  setTimeout(() => refreshHomeFeed().catch(() => {}), 8000).unref();
  setInterval(() => refreshHomeFeed().catch(() => {}), 9 * 60 * 1000).unref();
}

module.exports = { getHomeFeed };
