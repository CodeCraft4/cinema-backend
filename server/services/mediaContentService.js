"use strict";

/**
 * Lazy caching layer for external media metadata.
 *
 * Flow for every lookup:
 *   1. SELECT the record in Supabase by `external_id`.
 *   2. Fresh hit  → return it straight from Supabase (no refresh, no API call).
 *      Stale hit  → re-fetch upstream, then UPSERT the same row (still 1 row).
 *   3. Miss       → fetch TVMaze, normalize, UPSERT with
 *                   { onConflict: "external_id" } so duplicates are impossible.
 */

const env = require("../config/env");
const { HttpError } = require("../utils/http");
const { getSupabaseClient, toFriendlySupabaseError, MEDIA_CONTENT_TABLE } = require("./supabaseClient");
const tvmaze = require("./tvmazeService");

const TITLE_MAX_LENGTH = 255;
const SOURCE = "tvmaze";
const MEDIA_TYPE = "tv";
const ROW_COLUMNS = "id, external_id, source, title, media_type, details, created_at, updated_at";

function log(prefix, message, extra) {
  if (extra === undefined) console.log(`${prefix} ${message}`);
  else console.log(`${prefix} ${message}`, extra);
}

function isStale(updatedAt) {
  if (!updatedAt) return true;
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(updated)) return true;
  return Date.now() - updated > env.cacheTtlMs;
}

/** Builds the exact row shape that is upserted into media_content. */
function buildRow(details) {
  if (!details?.externalId) {
    throw new HttpError(502, "Upstream payload has no external id", "BAD_UPSTREAM_PAYLOAD");
  }
  return {
    external_id: Number(details.externalId),
    source: details.provider || SOURCE,
    title: String(details.title || "Untitled").slice(0, TITLE_MAX_LENGTH),
    media_type: details.mediaType || MEDIA_TYPE,
    details,
  };
}

async function findCachedRow(externalId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select(ROW_COLUMNS)
    .eq("source", SOURCE)
    .eq("media_type", MEDIA_TYPE)
    .eq("external_id", Number(externalId))
    .maybeSingle();

  if (error) throw toFriendlySupabaseError(error, "read the cache");
  return data || null;
}

/** Idempotent write: one row per (source, media_type, external_id). */
async function upsertShowRow(details) {
  const supabase = getSupabaseClient();
  const row = buildRow(details);

  const { data, error } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .upsert(row, { onConflict: "source,media_type,external_id", ignoreDuplicates: false })
    .select(ROW_COLUMNS)
    .single();

  if (error) throw toFriendlySupabaseError(error, "upsert the show");
  return data;
}

/** How many rows exist for an id — proves no duplicates were created. */
async function countRowsForExternalId(externalId) {
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("source", SOURCE)
    .eq("media_type", MEDIA_TYPE)
    .eq("external_id", Number(externalId));

  if (error) throw toFriendlySupabaseError(error, "count cached rows");
  return count ?? 0;
}

/**
 * Case-insensitive exact-title lookup.
 * `%`/`_` are backslash-escaped so a title can never act as a LIKE wildcard,
 * and the row is only accepted when the titles match exactly (otherwise the
 * caller simply falls through to the TVMaze search, which is the safe default).
 */
async function findFreshRowByTitle(title) {
  const supabase = getSupabaseClient();
  const wanted = String(title || "").trim().toLowerCase();
  if (!wanted) return null;

  const pattern = String(title).trim().replace(/[\\%_]/g, "\\$&");
  const { data, error } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select(ROW_COLUMNS)
    .eq("source", SOURCE)
    .eq("media_type", MEDIA_TYPE)
    .ilike("title", pattern)
    .limit(5);

  if (error) throw toFriendlySupabaseError(error, "search the cache by title");
  const rows = Array.isArray(data) ? data : [];
  return (
    rows.find(
      (row) => !isStale(row.updated_at) && String(row.title || "").trim().toLowerCase() === wanted
    ) || null
  );
}

/**
 * Lazy cache lookup by external id (main entry point).
 * @param {number|string} externalId TVMaze show id
 * @param {{ refresh?: boolean }} options `refresh: true` forces an upstream re-fetch
 */
async function getTvShowByExternalId(externalId, options = {}) {
  const id = Number(externalId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, `Invalid TV show id: ${externalId}`, "INVALID_ID");
  }

  const cached = await findCachedRow(id);
  const stale = cached ? isStale(cached.updated_at) : true;

  if (cached && !options.refresh && !stale) {
    log("[cache HIT ]", `show ${id} served from Supabase`, {
      title: cached.title,
      updated_at: cached.updated_at,
    });
    return { row: cached, cacheHit: true, upstreamCalled: false, stale: false, stored: false };
  }

  log(
    "[cache MISS]",
    `show ${id} is not fresh in Supabase — calling the TVMaze API`,
    cached
      ? { reason: options.refresh ? "refresh requested" : "stale entry", updated_at: cached.updated_at }
      : { reason: "no row found" }
  );

  let details;
  try {
    details = await tvmaze.fetchShowPayload(id);
  } catch (error) {
    if (cached) {
      log("[cache STALE]", `TVMaze failed for ${id} — serving the previous cached copy`, {
        error: error.message,
      });
      return {
        row: cached,
        cacheHit: true,
        upstreamCalled: true,
        stale: true,
        stored: false,
        upstreamError: error.message,
      };
    }
    throw error;
  }

  if (!details) {
    if (cached) {
      log("[cache STALE]", `TVMaze has no record for ${id} — serving the previous cached copy`);
      return { row: cached, cacheHit: true, upstreamCalled: true, stale: true, stored: false };
    }
    throw new HttpError(404, `TV show ${id} was not found on TVMaze`, "NOT_FOUND");
  }

  const row = await upsertShowRow(details);
  log(`[cache ${cached ? "REFRESH" : "UPSERT "}]`, `stored show ${id} via upsert (onConflict=external_id)`, {
    row_id: row.id,
    title: row.title,
  });

  return { row, cacheHit: false, upstreamCalled: true, stale: false, stored: true };
}

/** Title lookup: Supabase first, otherwise TVMaze search → same caching path. */
async function getTvShowByTitle(title, options = {}) {
  const term = String(title || "").trim();
  if (!term) throw new HttpError(400, "Query parameter `title` is required", "MISSING_TITLE");

  if (!options.refresh) {
    const direct = await findFreshRowByTitle(term);
    if (direct) {
      log("[cache HIT ]", `"${term}" served from Supabase (title match)`, {
        title: direct.title,
        external_id: direct.external_id,
      });
      return {
        row: direct,
        cacheHit: true,
        upstreamCalled: false,
        stale: false,
        stored: false,
        matchedBy: "title",
      };
    }
  }

  log("[cache MISS]", `"${term}" is not fresh in Supabase — searching TVMaze`);
  const payload = await tvmaze.fetchShowPayloadByTitle(term);
  if (!payload) throw new HttpError(404, `No TV show matched "${term}" on TVMaze`, "NOT_FOUND");

  const result = await getTvShowByExternalId(payload.externalId, options);
  return { ...result, matchedBy: "tvmaze-search", searchScore: payload.searchScore ?? null };
}

/** Paginated read of everything already cached — never touches the upstream API. */
async function listCachedShows({ page = 1, limit = 20 } = {}) {
  const supabase = getSupabaseClient();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
  const from = (safePage - 1) * safeLimit;

  const { data, error, count } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select(ROW_COLUMNS, { count: "exact" })
    .eq("media_type", MEDIA_TYPE)
    .order("updated_at", { ascending: false })
    .range(from, from + safeLimit - 1);

  if (error) throw toFriendlySupabaseError(error, "list cached shows");

  const total = count ?? 0;
  log("[cache LIST ]", `returned ${(data || []).length} of ${total} cached shows (0 upstream calls)`);

  return {
    items: data || [],
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

module.exports = {
  getTvShowByExternalId,
  getTvShowByTitle,
  listCachedShows,
  discoverTvShows,
  upsertShowRow,
  buildRow,
  findCachedRow,
  findFreshRowByTitle,
  countRowsForExternalId,
  isStale,
};


/** Paginated TMDb-compatible TV discovery from the shared Supabase catalog. */
async function discoverTvShows({ page = 1, limit = 16, year = null, genreId = null, sort = "popularity.desc", query = "" } = {}) {
  const supabase = getSupabaseClient();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 16), 50);
  const term = String(query || "").trim();
  let builder = supabase.from(MEDIA_CONTENT_TABLE)
    .select("id, external_id, source, title, media_type, details, updated_at")
    .eq("source", "tmdb").eq("media_type", MEDIA_TYPE)
    .order("updated_at", { ascending: false }).limit(5000);
  if (term) builder = builder.ilike("title", `%${term.replace(/[\\%_]/g, "\\$&")}%`);
  const { data, error } = await builder;
  if (error) throw toFriendlySupabaseError(error, "discover cached TV shows");

  let items = (data || []).map((row) => {
    const details = row.details || {};
    return { id: `tmdb-tv-${row.external_id}`, tmdbId: Number(row.external_id),
      title: row.title || details.title || "Untitled", year: String(details.year || ""),
      typeLabel: "SERIES", mediaType: "tv", originalLanguage: details.originalLanguage || "",
      originCountry: Array.isArray(details.originCountry) ? details.originCountry : [],
      rating: typeof details.rating === "number" ? details.rating : null,
      poster: details.poster || null, backdrop: details.backdrop || null,
      overview: details.overview || "", page: safePage, updated_at: row.updated_at };
  }).filter((item) => item.title);
  if (year != null && year !== "") items = items.filter((item) => item.year === String(year));
  const sortKey = String(sort || "popularity.desc");
  items.sort((a, b) => sortKey.startsWith("first_air_date")
    ? String(b.year).localeCompare(String(a.year))
    : sortKey.startsWith("vote_average")
      ? Number(b.rating || 0) - Number(a.rating || 0)
      : String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  const total = items.length;
  const from = (safePage - 1) * safeLimit;
  return { items: items.slice(from, from + safeLimit), page: safePage, total,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)), source: "supabase",
    cached: true, upstreamCalled: false };
}
