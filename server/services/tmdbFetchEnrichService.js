"use strict";

/**
 * One-click TMDB fetch + auto-enrich.
 * 1) Pull popular/trending movies from TMDB into media_content
 * 2) Immediately resolve Hindi / Dual Audio via Torrentio (+ cascade)
 * 3) Store as streamable DDL URLs in media_sources (magnet kept in magnet_link)
 */

const axios = require("axios");
const env = require("../config/env");
const { HttpError } = require("../utils/http");
const { getSupabaseClient, toFriendlySupabaseError, MEDIA_CONTENT_TABLE } = require("./supabaseClient");
const { saveTorrentRelease } = require("./mediaSourceService");
const { discoverCascadingTorrents, normalizeSourceLinks, publicSize } = require("./torrentResolver");

const ROW_COLUMNS = "id, external_id, source, title, media_type, details, created_at, updated_at";
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 20;
const ENRICH_WORKERS = 3;
const ENRICH_TIMEOUT_MS = 6000;

const LIST_PATHS = {
  popular: "/movie/popular",
  trending: "/trending/movie/week",
  now_playing: "/movie/now_playing",
  top_rated: "/movie/top_rated",
};

let jobRunning = false;

function yearFrom(value) {
  return String(value || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
}

function isFutureRelease(details) {
  const raw = details?.release_date || "";
  if (!raw) {
    const year = Number(details?.year);
    return Number.isFinite(year) && year > new Date().getFullYear();
  }
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.getTime() > Date.now();
}

function buildContentRow(item) {
  const title = String(item.title || item.name || "Untitled").slice(0, 255);
  const releaseDate = item.release_date || item.first_air_date || "";
  const year = yearFrom(releaseDate);
  const posterPath = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
  const backdropPath = item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null;
  const overview = item.overview || item.description || "";
  const rating = item.vote_average != null ? Math.round(Number(item.vote_average) * 100) / 10 : null;
  return {
    external_id: Number(item.id),
    source: "tmdb",
    media_type: "movie",
    title,
    details: {
      provider: "tmdb",
      externalId: Number(item.id),
      title,
      mediaType: "movie",
      year,
      release_date: releaseDate,
      popularity: Number(item.popularity) || 0,
      rating,
      poster: posterPath,
      backdrop: backdropPath,
      overview,
      originalLanguage: item.original_language || "",
      originCountry: Array.isArray(item.origin_country) ? item.origin_country : [],
      imdb_id: "",
      storedAt: new Date().toISOString(),
      fromFetchTmdb: true,
    },
  };
}

async function fetchImdbId(tmdbId) {
  if (!env.tmdbApiKey || !tmdbId) return "";
  try {
    const { data } = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`, {
      timeout: 5000,
      params: { api_key: env.tmdbApiKey },
    });
    return data?.imdb_id && data.imdb_id !== "N/A" ? String(data.imdb_id) : "";
  } catch {
    return "";
  }
}

async function fetchTmdbList({ list = "popular", page = 1, limit = DEFAULT_LIMIT } = {}) {
  if (!env.tmdbApiKey) {
    throw new HttpError(503, "TMDB_API_KEY is not configured", "TMDB_NOT_CONFIGURED");
  }
  const path = LIST_PATHS[String(list || "popular").toLowerCase()] || LIST_PATHS.popular;
  const safePage = Math.max(1, Math.min(20, Number(page) || 1));
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));

  const { data } = await axios.get(`https://api.themoviedb.org/3${path}`, {
    timeout: 12000,
    params: { api_key: env.tmdbApiKey, language: "en-US", page: safePage },
  });

  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((item) => item && item.id && (item.title || item.name))
    .slice(0, safeLimit);
}

async function upsertContent(row) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .upsert(row, { onConflict: "source,media_type,external_id" })
    .select(ROW_COLUMNS)
    .single();
  if (error) throw toFriendlySupabaseError(error, "upsert media_content");

  try {
    const details = row.details || {};
    await supabase
      .from("catalog_titles")
      .update({
        overview: details.overview || null,
        poster_url: details.poster || null,
        backdrop_url: details.backdrop || null,
        rating_percent: details.rating != null ? Number(details.rating) : null,
      })
      .eq("external_id", row.external_id);
  } catch (_) {}

  return data;
}

async function eachLimit(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function presentStoredSource(source) {
  if (!source) return null;
  const links = normalizeSourceLinks(source);
  const size = publicSize(source);
  return {
    language: source.language_label || source.language || "",
    quality: source.quality || "",
    source_type: links.source_type,
    download_url: links.download_url,
    stream_url: links.stream_url,
    magnet_link: links.magnet_link,
    size_bytes: size.size_bytes,
    size_human: size.size_human,
    seeders: source.seeders == null ? 0 : Number(source.seeders),
    provider: source.provider || source.payload?.provider || null,
    status: "ready",
  };
}

async function enrichOne(content, { baseUrl } = {}) {
  const title = String(content.title || "").trim();
  const year = content.details?.year || yearFrom(content.details?.release_date);
  const mediaId = String(content.external_id);
  const imdbId = content.details?.imdb_id || "";

  if (!title) return { status: "skipped", reason: "missing_title" };
  if (isFutureRelease(content.details || {})) {
    return { status: "skipped", reason: "unreleased", title, media_id: mediaId };
  }

  const found = await discoverCascadingTorrents({
    title,
    year,
    mediaType: "movie",
    imdbId,
    tmdbId: mediaId,
    originalLanguage: content.details?.originalLanguage || "",
    country: Array.isArray(content.details?.originCountry) ? content.details.originCountry.join(",") : "",
    timeoutMs: ENRICH_TIMEOUT_MS,
    allowEmbed: false,
    requireDubMarker: true,
  });

  if (!found || found.source_type === "embed_stream" || !found.magnet_link) {
    return { status: "no_torrent", title, media_id: mediaId, year };
  }

  const stored = await saveTorrentRelease(
    {
      mediaId,
      imdbId,
      title,
      year,
      language: found.language_label || found.language,
      quality: found.quality,
      mediaType: "movie",
      baseUrl,
      overview: content.details?.overview || content.details?.description || "",
      posterUrl: content.details?.poster || null,
      backdropUrl: content.details?.backdrop || null,
      rating: content.details?.rating != null ? Number(content.details.rating) : null,
    },
    found
  );

  if (!stored) {
    return { status: "no_torrent", title, media_id: mediaId, year, reason: "save_rejected" };
  }

  // Re-normalize with request base URL so clients get LAN/Railway stream links.
  const links = normalizeSourceLinks(stored, baseUrl);
  return {
    status: "enriched",
    title,
    media_id: mediaId,
    year,
    source: presentStoredSource({ ...stored, ...links }),
  };
}

/**
 * Fetch TMDB list → upsert media_content → auto-enrich torrents into media_sources.
 */
async function fetchTmdbAndEnrich({
  list = "popular",
  page = 1,
  limit = DEFAULT_LIMIT,
  skipEnrich = false,
  baseUrl = null,
} = {}) {
  if (jobRunning) {
    throw new HttpError(409, "A Fetch TMDB job is already running", "JOB_IN_PROGRESS");
  }
  jobRunning = true;
  const started = Date.now();

  try {
    const movies = await fetchTmdbList({ list, page, limit });
    const summary = {
      ok: true,
      list: LIST_PATHS[String(list || "popular").toLowerCase()] ? String(list).toLowerCase() : "popular",
      page: Math.max(1, Number(page) || 1),
      requested: Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT)),
      fetched: movies.length,
      inserted: 0,
      enriched: 0,
      skipped: 0,
      no_torrent: 0,
      failed: 0,
      elapsed_ms: 0,
      items: [],
    };

    const contents = [];
    for (const movie of movies) {
      try {
        const row = buildContentRow(movie);
        const imdbId = await fetchImdbId(row.external_id);
        if (imdbId) row.details.imdb_id = imdbId;
        const stored = await upsertContent(row);
        summary.inserted += 1;
        contents.push(stored);
        summary.items.push({
          media_id: String(stored.external_id),
          title: stored.title,
          year: stored.details?.year || "",
          status: "stored",
        });
      } catch (error) {
        summary.failed += 1;
        summary.items.push({
          media_id: String(movie.id),
          title: movie.title || movie.name || "",
          status: "failed",
          error: error.message,
        });
      }
    }

    if (skipEnrich || !contents.length) {
      summary.elapsed_ms = Date.now() - started;
      return summary;
    }

    console.log(
      `[fetch-tmdb] stored ${contents.length} titles · enriching Hindi/Dual via Torrentio (workers=${ENRICH_WORKERS})`
    );

    await eachLimit(contents, ENRICH_WORKERS, async (content) => {
      const mediaId = String(content.external_id);
      const item = summary.items.find((row) => row.media_id === mediaId) || {
        media_id: mediaId,
        title: content.title,
      };
      try {
        const result = await enrichOne(content, { baseUrl });
        item.status = result.status;
        item.year = result.year || item.year || "";
        if (result.source) item.source = result.source;
        if (result.reason) item.reason = result.reason;
        if (result.status === "enriched") summary.enriched += 1;
        else if (result.status === "skipped") summary.skipped += 1;
        else if (result.status === "no_torrent") summary.no_torrent += 1;
        else summary.failed += 1;
      } catch (error) {
        summary.failed += 1;
        item.status = "failed";
        item.error = error.message;
        console.warn(`[fetch-tmdb] enrich failed for "${content.title}":`, error.message);
      }
    });

    summary.elapsed_ms = Date.now() - started;
    console.log(
      `[fetch-tmdb] done · inserted ${summary.inserted} · enriched ${summary.enriched} · ` +
        `no_torrent ${summary.no_torrent} · skipped ${summary.skipped} · failed ${summary.failed} · ${summary.elapsed_ms}ms`
    );
    return summary;
  } finally {
    jobRunning = false;
  }
}

module.exports = {
  fetchTmdbAndEnrich,
  fetchTmdbList,
  LIST_PATHS,
  MAX_LIMIT,
  DEFAULT_LIMIT,
};
