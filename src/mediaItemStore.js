"use strict";

/**
 * Shared Supabase item store for the `media_content` table.
 * ---------------------------------------------------------------------------
 * Contract (what the app guarantees to the user):
 *   1. Every fetched movie / series is saved in Supabase.
 *   2. Nothing is ever stored twice — not inside one batch, not across pages,
 *      not across restarts, not across devices.
 *   3. A row that already exists is NEVER re-written ("already in DB → skip").
 *   4. Reading is DB-first: if the data is in Supabase, it is served from there.
 *
 * Duplicate protection is three-layered:
 *   • in-batch de-dupe on (media_type, external_id)
 *   • a SELECT of the ids that already exist → only the missing ones are sent
 *   • `ignoreDuplicates: true` (ON CONFLICT DO NOTHING) against the
 *     UNIQUE (source, media_type, external_id) constraint, so even a race
 *     between two app instances cannot create a duplicate row.
 *
 * Usage:
 *   const store = createMediaItemStore({ getClient: () => supabaseClient });
 *   await store.storeItems(items);                        // movies + series
 *   await store.storeItems(items, { mediaType: "tv" });   // series only
 *   await store.searchItems("matrix", { limit: 20 });     // DB-first search
 */

const MEDIA_CONTENT_TABLE = "media_content";
const ITEM_CHUNK_SIZE = 100;
const WRITE_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalises a TMDb card item into a media_content row (or null when unusable). */
function itemToMediaRow(item, source = "tmdb") {
  const externalId = Number(item?.tmdbId ?? item?.external_id ?? item?.id);
  if (!Number.isInteger(externalId) || externalId <= 0) return null;

  const isTv = item?.mediaType === "tv" || item?.typeLabel === "SERIES";
  const title = String(item?.title || item?.name || "Untitled").slice(0, 255);
  return {
    external_id: externalId,
    source,
    media_type: isTv ? "tv" : "movie",
    title,
    details: {
      provider: source,
      externalId,
      title,
      mediaType: isTv ? "tv" : "movie",
      year: item?.year || "",
      rating: typeof item?.rating === "number" ? item.rating : null,
      poster: item?.poster || null,
      backdrop: item?.backdrop || null,
      overview: item?.overview || "",
      originalLanguage: item?.originalLanguage || "",
      originCountry: Array.isArray(item?.originCountry) ? item.originCountry : [],
      storedAt: new Date().toISOString(),
    },
  };
}

/** Converts a stored media_content row back into a UI card item. */
function mediaRowToCardItem(row) {
  if (!row?.external_id) return null;
  const d = row.details || {};
  const isTv = row.media_type === "tv";
  return {
    id: `tmdb-${row.media_type}-${row.external_id}`,
    tmdbId: Number(row.external_id),
    title: row.title || d.title || "Untitled",
    year: d.year || "",
    typeLabel: isTv ? "SERIES" : "MOVIE",
    mediaType: isTv ? "tv" : "movie",
    originalLanguage: d.originalLanguage || "",
    originCountry: Array.isArray(d.originCountry) ? d.originCountry : [],
    rating: typeof d.rating === "number" ? d.rating : null,
    poster: d.poster || null,
    backdrop: d.backdrop || null,
    overview: d.overview || "",
  };
}

function createMediaItemStore({ getClient, logger = console } = {}) {
  const log = logger || console;
  const client = () => (typeof getClient === "function" ? getClient() : null) || null;

  /**
   * Store fetched items WITHOUT duplicates. Never throws.
   * @returns {Promise<{checked:number, stored:number, skipped:number, storedRows:Array<{externalId:number, mediaType:string, title:string, year:string}>}>}
   */
  async function storeItems(items, options = {}) {
    const {
      source = "tmdb",
      mediaType = null,
      chunkSize = ITEM_CHUNK_SIZE,
      writeAttempts = WRITE_ATTEMPTS,
      retryDelayMs = RETRY_DELAY_MS,
    } = options;
    const empty = { checked: 0, stored: 0, skipped: 0, storedRows: [] };

    const supabase = client();
    if (!supabase || !Array.isArray(items) || !items.length) return empty;

    try {
      // 1) normalise + in-batch de-dupe
      const byKey = new Map();
      for (const item of items) {
        const row = itemToMediaRow(item, source);
        if (!row) continue;
        if (mediaType && row.media_type !== mediaType) continue;
        const key = `${row.media_type}:${row.external_id}`;
        if (!byKey.has(key)) byKey.set(key, row);
      }
      if (!byKey.size) return empty;

      let stored = 0;
      let skipped = 0;
      const storedRows = [];

      for (const type of ["movie", "tv"]) {
        const rows = [...byKey.values()].filter((row) => row.media_type === type);
        if (!rows.length) continue;

        // 2) which ids already exist? (one read per media type)
        const { data, error } = await supabase
          .from(MEDIA_CONTENT_TABLE)
          .select("external_id")
          .eq("source", source)
          .eq("media_type", type)
          .in(
            "external_id",
            rows.map((row) => row.external_id)
          );

        if (error) log.warn?.("[supabase store] existence check failed:", error.message);
        const existing = error
          ? new Set()
          : new Set((data || []).map((row) => Number(row.external_id)));

        // 3) insert ONLY the new ones — existing rows are left untouched
        const missing = rows.filter((row) => !existing.has(row.external_id));
        skipped += rows.length - missing.length;

        for (let i = 0; i < missing.length; i += chunkSize) {
          const chunk = missing.slice(i, i + chunkSize);
          let lastError = null;

          // Retry once: a dropped connection must never silently lose a row.
          for (let attempt = 1; attempt <= writeAttempts; attempt += 1) {
            const { error: upsertError } = await supabase
              .from(MEDIA_CONTENT_TABLE)
              .upsert(chunk, {
                onConflict: "source,media_type,external_id",
                ignoreDuplicates: true, // ON CONFLICT DO NOTHING
              });

            if (!upsertError) {
              lastError = null;
              break;
            }
            lastError = upsertError;
            if (attempt < writeAttempts) await sleep(retryDelayMs * attempt);
          }

          if (lastError) {
            log.warn?.("[supabase store] write failed:", lastError.message);
            continue;
          }
          for (const row of chunk) {
            storedRows.push({
              externalId: row.external_id,
              mediaType: row.media_type,
              title: row.title,
              year: row.details?.year || "",
            });
          }
          stored += chunk.length;
        }
      }

      if (stored || skipped) {
        log.log?.(`[supabase store] new=${stored}, already-stored=${skipped} (skipped)`);
      }
      return { checked: byKey.size, stored, skipped, storedRows };
    } catch (error) {
      log.warn?.("[supabase store] skipped:", error?.message || error);
      return empty;
    }
  }

  /** DB-first lookup: serve already stored movies/series straight from Supabase. */
  async function searchItems(query, options = {}) {
    const { limit = 20, source = "tmdb", mediaType = null } = options;
    const empty = { items: [], fromCache: true, source: "supabase" };

    const supabase = client();
    if (!supabase) return empty;

    const term = String(query || "").trim();
    if (term.length < 2) return empty;

    try {
      const pattern = term.replace(/[\\%_]/g, "\\$&");
      let builder = supabase
        .from(MEDIA_CONTENT_TABLE)
        .select("external_id, source, media_type, title, details")
        .eq("source", source);
      if (mediaType === "movie" || mediaType === "tv") builder = builder.eq("media_type", mediaType);
      const { data, error } = await builder
        .ilike("title", `%${pattern}%`)
        .order("updated_at", { ascending: false })
        .limit(Math.min(Math.max(Number(limit) || 20, 1), 100));

      if (error || !Array.isArray(data)) return empty;
      const items = data.map(mediaRowToCardItem).filter((item) => item && item.title);
      log.log?.(`[supabase search] "${term}" → ${items.length} cached item(s)`);
      return { items, fromCache: true, source: "supabase" };
    } catch {
      return empty;
    }
  }

  /**
   * List stored items — the DB fallback for pages whose payload is not in
   * `media_page_cache` while the APIs are down (or the key is missing), so the
   * UI is never empty when the DB already holds data.
   * Returns the same shape as `searchItems`: { items, fromCache, source }.
   */
  async function listItems(options = {}) {
    const { source = "tmdb", mediaType = null, limit = 50 } = options;
    const empty = { items: [], fromCache: true, source: "supabase" };

    const supabase = client();
    if (!supabase) return empty;

    try {
      let builder = supabase
        .from(MEDIA_CONTENT_TABLE)
        .select("external_id, source, media_type, title, details")
        .eq("source", source);
      if (mediaType === "movie" || mediaType === "tv") builder = builder.eq("media_type", mediaType);
      const { data, error } = await builder
        .order("updated_at", { ascending: false })
        .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));

      if (error || !Array.isArray(data)) return empty;
      const items = data.map(mediaRowToCardItem).filter((item) => item && item.title);
      log.log?.(`[supabase list] ${items.length} stored item(s) (mediaType=${mediaType || "all"})`);
      return { items, fromCache: true, source: "supabase" };
    } catch {
      return empty;
    }
  }

  return { storeItems, searchItems, listItems };
}

module.exports = {
  createMediaItemStore,
  itemToMediaRow,
  mediaRowToCardItem,
  MEDIA_CONTENT_TABLE,
  ITEM_CHUNK_SIZE,
};
