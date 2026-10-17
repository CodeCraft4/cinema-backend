"use strict";

/**
 * Single shared Supabase client for the Express service.
 * Uses the service-role key, therefore RLS is bypassed (server-side only —
 * never ship this key to the renderer / browser).
 */

// Polyfill WebSocket in environments (like Node.js 20 or serverless) without native WebSocket
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = class WebSocketPolyfill {
    constructor() {
      this.readyState = 0;
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  };
}

const { createClient } = require("@supabase/supabase-js");
const env = require("../config/env");
const { HttpError } = require("../utils/http");

let client = null;

function getSupabaseClient() {
  if (client) return client;

  const { supabaseUrl, supabaseKey } = env.assertSupabaseConfig();

  client = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "cinebroad-media-service" } },
  });

  return client;
}

/** Table names are centralised so a rename only has to happen here. */
const MEDIA_CONTENT_TABLE = "media_content";
const MEDIA_SOURCES_TABLE = "media_sources";
const DOWNLOAD_REQUESTS_TABLE = "download_requests";

/** Translates raw Supabase/Postgres errors into actionable HTTP errors. */
function toFriendlySupabaseError(error, action = "query media_content") {
  if (!error) return null;
  const code = error.code || "";
  const message = error.message || String(error);

  if (code === "PGRST205" || code === "42P01" || /relation .* does not exist/i.test(message)) {
    const named = /relation ["']?([a-z0-9_]+)/i.exec(message)?.[1];
    const table = named || MEDIA_CONTENT_TABLE;
    const migration =
      table === MEDIA_SOURCES_TABLE || table === DOWNLOAD_REQUESTS_TABLE
        ? "supabase/migrations/20260927120000_create_media_sources_download_requests.sql"
        : "supabase/migrations/20260923120000_create_media_content.sql";
    return new HttpError(
      503,
      `The "${table}" table is missing. Run the migration in ${migration} ` +
        "(Supabase Dashboard → SQL Editor, or `npm run db:migrate`).",
      "CACHE_NOT_READY",
      { table, migration }
    );
  }
  if (code === "42P10" || /no unique or exclusion constraint/i.test(message)) {
    return new HttpError(
      503,
      `Upsert needs the UNIQUE constraint on ` +
        `${MEDIA_CONTENT_TABLE} (source, media_type, external_id) — apply ` +
        `supabase/migrations/20260923120002_media_content_scope_unique.sql first. (${message})`,
      "CACHE_SCHEMA_INVALID"
    );
  }
  if (code === "23505") {
    return new HttpError(
      409,
      `Duplicate row prevented by the UNIQUE constraint while trying to ${action}. (${message})`,
      "DUPLICATE_ROW"
    );
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|network|timeout/i.test(message)) {
    return new HttpError(502, `Could not reach Supabase while trying to ${action}: ${message}`, "SUPABASE_UNREACHABLE");
  }
  return new HttpError(500, `Supabase error while trying to ${action}: ${message}`, "SUPABASE_ERROR");
}

/**
 * Lightweight connectivity check used by /health and the verify script.
 *
 * IMPORTANT: a `HEAD` request (`.select(..., { head: true })`) returns 204 with
 * no error from PostgREST even when the table does NOT exist, so this probe
 * deliberately performs a real GET and inspects the returned error.
 *
 * Returns { ok, tableReady, rowCount, error }.
 */
async function checkSupabaseConnection() {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from(MEDIA_CONTENT_TABLE).select("id").limit(1);

    if (error) {
      const friendly = toFriendlySupabaseError(error, "read the cache");
      const tableReady = !["CACHE_NOT_READY", "CACHE_SCHEMA_INVALID"].includes(friendly.code);
      return { ok: true, tableReady, rowCount: null, error: friendly };
    }

    const { count, error: countError } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id", { count: "exact" });

    return {
      ok: true,
      tableReady: true,
      rowCount: countError ? (Array.isArray(data) ? data.length : 0) : count ?? 0,
      error: null,
    };
  } catch (error) {
    return { ok: false, tableReady: false, rowCount: null, error };
  }
}

module.exports = {
  getSupabaseClient,
  checkSupabaseConnection,
  toFriendlySupabaseError,
  MEDIA_CONTENT_TABLE,
  MEDIA_SOURCES_TABLE,
  DOWNLOAD_REQUESTS_TABLE,
};