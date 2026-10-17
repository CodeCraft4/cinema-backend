"use strict";

/**
 * Shared Supabase page-payload cache for the `media_page_cache` table.
 * ---------------------------------------------------------------------------
 * One row per `cache_key` (UNIQUE). Every write is an upsert on that key, so a
 * page payload can never be duplicated — re-fetching the same Home / Movies /
 * TV / Search page just refreshes the existing row. A page that is already
 * stored is served straight from the DB on the next request (zero API calls).
 *
 * Schema (supabase/migrations/20260923120001_create_media_page_cache.sql):
 *   id bigserial, cache_key text unique, provider varchar, page_data jsonb,
 *   created_at timestamptz, updated_at timestamptz
 */

const PAGE_CACHE_TABLE = "media_page_cache";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function createPageCache({ getClient, ttlMs = DEFAULT_TTL_MS, logger = console } = {}) {
  const log = logger || console;
  const client = () => (typeof getClient === "function" ? getClient() : null) || null;

  /**
   * Read a cached page payload.
   * @returns {Promise<object|null>} the stored payload, or null on miss / stale /
   *   unavailable Supabase (callers then fall back to disk / the API).
   */
  async function read(cacheKey) {
    const supabase = client();
    if (!supabase || !cacheKey) return null;

    try {
      const { data, error } = await supabase
        .from(PAGE_CACHE_TABLE)
        .select("page_data, created_at")
        .eq("cache_key", cacheKey)
        .maybeSingle();

      if (error || !data) return null;
      const age = Date.now() - new Date(data.created_at).getTime();
      if (Number.isFinite(age) && age > ttlMs) return null; // stale
      return data.page_data ?? null;
    } catch {
      return null;
    }
  }

  /** Upsert a page payload (idempotent — one row per cache_key). */
  async function write(cacheKey, value, { attempts = 2, retryDelayMs = 250 } = {}) {
    const supabase = client();
    if (!supabase || !cacheKey || value == null) return false;

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { error } = await supabase
          .from(PAGE_CACHE_TABLE)
          .upsert({ cache_key: cacheKey, page_data: value }, { onConflict: "cache_key" });
        if (!error) return true;
        lastError = error;
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }

    log.warn?.("[page cache] write failed:", lastError?.message || lastError);
    return false;
  }

  /** Drop one cached page (used by tests and cache invalidation). */
  async function remove(cacheKey) {
    const supabase = client();
    if (!supabase || !cacheKey) return false;
    const { error } = await supabase.from(PAGE_CACHE_TABLE).delete().eq("cache_key", cacheKey);
    return !error;
  }

  return { read, write, remove };
}

module.exports = { createPageCache, PAGE_CACHE_TABLE, DEFAULT_TTL_MS };
