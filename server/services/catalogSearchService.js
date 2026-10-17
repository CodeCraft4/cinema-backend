"use strict";

/**
 * Customer search miss path.
 * Supabase first. If the title is missing, fetch TMDb + OMDb (TVMaze for series),
 * store media_content, then resolve Hindi, Dual Audio, and English torrents
 * together and store them in media_sources.
 */

const axios = require("axios");
const env = require("../config/env");
const { HttpError } = require("../utils/http");
const { getSupabaseClient, toFriendlySupabaseError, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("./supabaseClient");
const { saveCachedSource } = require("./mediaSourceService");
const { normalizeSourceLinks, publicSize } = require("./torrentResolver");
const { collectCatalogTorrents } = require("./streamResolver");

const ROW_COLUMNS = "id, external_id, source, title, media_type, details, created_at, updated_at";
const WANTED_LANGUAGES = ["Hindi", "Dual Audio [Hindi+Eng]", "English"];

function safeDelay(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 8000;
  return Math.max(100, Math.floor(value));
}

function yearFrom(value) {
  return String(value || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
}

function isFutureRelease(details) {
  const raw = details?.release_date || details?.premiered || details?.first_air_date || "";
  if (!raw) return false;
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.getTime() > Date.now();
}

async function findStoredTitle(title, mediaType) {
  const supabase = getSupabaseClient();
  const escaped = title.replace(/[\\%_]/g, "\\$&");
  let query = supabase.from(MEDIA_CONTENT_TABLE).select(ROW_COLUMNS).ilike("title", escaped).limit(8);
  if (mediaType === "movie" || mediaType === "tv") query = query.eq("media_type", mediaType);
  const { data, error } = await query;
  if (error) throw toFriendlySupabaseError(error, "search media_content");
  const rows = Array.isArray(data) ? data : [];
  const exact = rows.find((row) => String(row.title || "").toLowerCase() === title.toLowerCase());
  return exact || null;
}

async function searchTmdb(title, mediaType) {
  if (!env.tmdbApiKey) return [];
  const kind = mediaType === "tv" ? "tv" : mediaType === "movie" ? "movie" : "multi";
  const { data } = await axios.get(`https://api.themoviedb.org/3/search/${kind}`, {
    timeout: safeDelay(env.requestTimeoutMs),
    params: { api_key: env.tmdbApiKey, query: title, include_adult: false, language: "en-US" },
  });
  return (data?.results || []).filter((item) => {
    const type = item.media_type || (kind === "multi" ? "" : kind);
    return type === "movie" || type === "tv";
  });
}

function pickTmdbHit(results, title, year, mediaType) {
  const wanted = title.toLowerCase();
  const ranked = results
    .map((item) => {
      const name = String(item.title || item.name || "");
      const type = item.media_type || (item.first_air_date && !item.release_date ? "tv" : "movie");
      const itemYear = yearFrom(item.release_date || item.first_air_date);
      let score = Number(item.popularity) || 0;
      if (name.toLowerCase() === wanted) score += 1000;
      else if (name.toLowerCase().includes(wanted)) score += 200;
      if (year && itemYear === String(year)) score += 100;
      if (mediaType && type === mediaType) score += 50;
      return { item, type, name, itemYear, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

async function tmdbExternalId(tmdbId, mediaType) {
  if (!env.tmdbApiKey || !tmdbId) return "";
  try {
    const { data } = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids`, {
      timeout: safeDelay(env.requestTimeoutMs),
      params: { api_key: env.tmdbApiKey },
    });
    return data?.imdb_id && data.imdb_id !== "N/A" ? String(data.imdb_id) : "";
  } catch (error) {
    console.warn("[catalog-search] TMDb external id failed:", error.message);
    return "";
  }
}

async function fetchOmdb({ title, year, imdbId, mediaType }) {
  if (!env.omdbApiKey) return null;
  try {
    const params = { apikey: env.omdbApiKey };
    if (imdbId) params.i = imdbId;
    else {
      params.t = title;
      if (year) params.y = year;
      params.type = mediaType === "tv" ? "series" : "movie";
    }
    const { data } = await axios.get("https://www.omdbapi.com/", {
      timeout: safeDelay(env.requestTimeoutMs),
      params,
    });
    if (!data || data.Response === "False") return null;
    return data;
  } catch (error) {
    console.warn("[catalog-search] OMDb lookup failed:", error.message);
    return null;
  }
}

async function fetchTvmazeId(title) {
  try {
    const { data } = await axios.get("https://api.tvmaze.com/search/shows", {
      timeout: safeDelay(4000),
      params: { q: title },
    });
    const hit = (Array.isArray(data) ? data : []).find(
      (entry) => String(entry?.show?.name || "").toLowerCase() === title.toLowerCase()
    );
    return hit?.show?.id || null;
  } catch (error) {
    console.warn("[catalog-search] TVMaze lookup failed:", error.message);
    return null;
  }
}

function buildContentRow(hit, omdb, imdbId, tvmazeId) {
  const posterPath = hit.item.poster_path
    ? `https://image.tmdb.org/t/p/w500${hit.item.poster_path}`
    : hit.item.poster || null;
  const backdropPath = hit.item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${hit.item.backdrop_path}` : null;
  const releaseDate = hit.item.release_date || hit.item.first_air_date || omdb?.Released || "";
  const overview = hit.item.overview || hit.item.description || omdb?.Plot || "";
  const rating = Number(hit.item.vote_average) || Number(omdb?.imdbRating) || null;
  return {
    external_id: Number(hit.item.id),
    source: "tmdb",
    media_type: hit.type === "tv" ? "tv" : "movie",
    title: String(hit.name || "Untitled").slice(0, 255),
    details: {
      provider: "tmdb",
      externalId: Number(hit.item.id),
      title: hit.name,
      mediaType: hit.type === "tv" ? "tv" : "movie",
      year: hit.itemYear || yearFrom(omdb?.Year),
      release_date: releaseDate,
      popularity: Number(hit.item.popularity) || 0,
      rating,
      poster: posterPath,
      backdrop: backdropPath,
      overview,
      originalLanguage: hit.item.original_language || "",
      originCountry: Array.isArray(hit.item.origin_country) ? hit.item.origin_country : [],
      imdb_id: imdbId || omdb?.imdbID || "",
      tvmaze_id: tvmazeId,
      omdb: omdb
        ? { rated: omdb.Rated || "", genre: omdb.Genre || "", imdbRating: omdb.imdbRating || "", runtime: omdb.Runtime || "" }
        : null,
      storedAt: new Date().toISOString(),
    },
  };
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

async function existingSourceLanguages(mediaId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("language, quality, source_type, download_url, magnet_link, stream_url, seeders, size_bytes, size_human, payload, status")
    .eq("media_id", String(mediaId))
    .eq("status", "ready");
  if (error) {
    console.warn("[catalog-search] source lookup failed:", error.message);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

function presentSource(row) {
  const links = normalizeSourceLinks(row);
  const size = publicSize(row);
  return {
    language: row.language,
    quality: row.quality,
    source_type: links.source_type,
    download_url: links.download_url,
    magnet_link: links.magnet_link,
    stream_url: links.stream_url,
    seeders: row.seeders == null ? 0 : Number(row.seeders),
    size_bytes: size.size_bytes,
    size_human: size.size_human,
    size: size.size,
    status: row.status || "ready",
  };
}

async function storeTorrents(content, sources) {
  const mediaId = String(content.external_id);
  const year = content.details?.year || yearFrom(content.details?.release_date);
  const saved = [];
  for (const source of sources) {
    const row = await saveCachedSource(
      {
        mediaId,
        imdbId: content.details?.imdb_id || null,
        title: content.title,
        year,
        language: source.language,
        quality: source.quality,
        overview: content.details?.overview || content.details?.description || "",
        posterUrl: content.details?.poster || null,
        backdropUrl: content.details?.backdrop || null,
        rating: content.details?.rating != null ? Number(content.details.rating) : null,
      },
      source
    );
    if (row) saved.push(row);
  }
  return saved;
}

async function ensureTorrents(content) {
  const mediaId = String(content.external_id || "");
  const have = mediaId ? await existingSourceLanguages(mediaId) : [];
  const haveLanguages = new Set(have.map((row) => row.language));
  const missing = WANTED_LANGUAGES.filter((language) => !haveLanguages.has(language));
  if (!missing.length || isFutureRelease(content.details || {})) {
    return have.map(presentSource);
  }
  let found = [];
  try {
    found = await collectCatalogTorrents(content.title, content.details?.year || "", { timeoutMs: 8000 });
  } catch (error) {
    console.warn("[catalog-search] torrent pass failed:", error.message);
  }
  const fresh = found.filter((source) => missing.includes(source.language));
  if (fresh.length) await storeTorrents(content, fresh);
  const after = mediaId ? await existingSourceLanguages(mediaId) : [];
  return after.map(presentSource);
}

async function fetchAndStore(title, { year = "", mediaType = "" } = {}) {
  let hits = [];
  try {
    hits = await searchTmdb(title, mediaType);
  } catch (error) {
    console.warn("[catalog-search] TMDb search failed:", error.message);
  }
  const hit = pickTmdbHit(hits, title, year, mediaType);
  if (!hit) {
    throw new HttpError(404, `No TMDb match for "${title}"`, "NOT_FOUND");
  }
  const imdbId = await tmdbExternalId(hit.item.id, hit.type);
  const omdb = await fetchOmdb({ title: hit.name, year: year || hit.itemYear, imdbId, mediaType: hit.type });
  const tvmazeId = hit.type === "tv" ? await fetchTvmazeId(hit.name) : null;
  const stored = await upsertContent(buildContentRow(hit, omdb, imdbId, tvmazeId));
  return stored;
}

/**
 * Search one title. Hits return from Supabase. Misses are fetched and stored,
 * then Hindi, Dual Audio, and English torrents are resolved together.
 */
async function searchCatalogTitle(title, options = {}) {
  const query = String(title || "").trim();
  if (!query) throw new HttpError(400, "Title is required", "MISSING_TITLE");
  const mediaType = options.mediaType === "tv" || options.mediaType === "movie" ? options.mediaType : "";
  const existing = await findStoredTitle(query, mediaType);
  if (existing) {
    const sources = await ensureTorrents(existing);
    return {
      cached: true,
      stored: false,
      upstream: [],
      item: publicItem(existing),
      sources,
    };
  }
  const stored = await fetchAndStore(query, { year: options.year || "", mediaType });
  const sources = await ensureTorrents(stored);
  return {
    cached: false,
    stored: true,
    upstream: ["tmdb", env.omdbApiKey ? "omdb" : null, stored.media_type === "tv" ? "tvmaze" : null].filter(Boolean),
    item: publicItem(stored),
    sources,
  };
}

function publicItem(row) {
  const details = row.details || {};
  return {
    id: row.id,
    media_id: String(row.external_id),
    title: row.title,
    year: details.year || yearFrom(details.release_date),
    media_type: row.media_type,
    source: row.source,
    imdb_id: details.imdb_id || "",
    poster: details.poster || null,
    overview: details.overview || "",
  };
}

/** Used by the desktop search after a TMDb miss. Stores that card plus its torrents. */
async function ensureStoredTitle(item) {
  const title = String(item?.title || item?.name || "").trim();
  const tmdbId = Number(item?.tmdbId || item?.external_id);
  if (!title || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const mediaType = item.mediaType === "tv" ? "tv" : "movie";
  const existing = await findStoredTitle(title, mediaType);
  const content =
    existing ||
    (await upsertContent(
      buildContentRow(
        {
          item: {
            id: tmdbId,
            poster_path: null,
            poster: item.poster || null,
            backdrop_path: null,
            overview: item.overview || "",
            original_language: item.originalLanguage || "",
            origin_country: item.originCountry || [],
            popularity: 0,
            vote_average: typeof item.rating === "number" ? item.rating / 10 : null,
            release_date: item.year ? `${item.year}-01-01` : "",
            first_air_date: mediaType === "tv" && item.year ? `${item.year}-01-01` : "",
          },
          type: mediaType,
          name: title,
          itemYear: String(item.year || ""),
        },
        null,
        "",
        null
      )
    ));
  if (item.poster && content?.details && !content.details.poster) {
    content.details.poster = item.poster;
  }
  const sources = await ensureTorrents(content);
  return { item: publicItem(content), sources };
}

module.exports = {
  searchCatalogTitle,
  ensureStoredTitle,
};
