"use strict";

/**
 * Central environment resolution for the Express media service.
 *
 * The repository's .env does not use the plain `SUPABASE_URL` /
 * `SUPABASE_SERVICE_ROLE_KEY` names, so every lookup falls back through the
 * names that actually exist in the project. Nothing is ever hardcoded:
 * if a value cannot be resolved we fail with an actionable message instead.
 */

const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
require("dotenv").config({ path: path.join(ROOT_DIR, ".env"), quiet: true });

const DEFAULT_TVMAZE_BASE_URL = "https://api.tvmaze.com";
const DEFAULT_PORT = 4555;
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TIMEOUT_MS = 10000;

// Ordered candidate names — first usable value wins.
const SUPABASE_URL_NAMES = [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_URL_KEY", // project uses this name for a *key*, guarded by the URL check
];

const SUPABASE_KEY_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_SECRET_KEY",
  "SUPABASE_SECRET_KEY",
];

function readEnv(name) {
  const value = process.env[name];
  if (value == null) return "";
  return String(value).trim().replace(/^['"]|['"]$/g, "");
}

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value || ""));
}

/** Decode a JWT payload without verifying it (we only need the `ref`/`role` claims). */
function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Fallback: derive https://<project-ref>.supabase.co from a Supabase JWT. */
function deriveSupabaseUrlFromKeys() {
  for (const name of SUPABASE_KEY_NAMES) {
    const claims = decodeJwtPayload(readEnv(name));
    if (claims?.ref) return { url: `https://${claims.ref}.supabase.co`, from: `${name} (ref claim)` };
  }
  return null;
}

function maskSecret(value) {
  const secret = String(value || "");
  if (!secret) return "(missing)";
  if (secret.length <= 12) return `${secret.slice(0, 3)}…(${secret.length})`;
  return `${secret.slice(0, 6)}…${secret.slice(-4)} (len ${secret.length})`;
}

function resolveSupabaseUrl(warnings) {
  for (const name of SUPABASE_URL_NAMES) {
    const value = readEnv(name);
    if (!value) continue;
    if (isHttpUrl(value)) return { url: value.replace(/\/+$/, ""), from: name };
    warnings.push(
      `${name} is set but is not an http(s) URL (looks like an API key) — skipping it for the project URL.`
    );
  }
  const derived = deriveSupabaseUrlFromKeys();
  if (derived) {
    warnings.push(`SUPABASE_URL was not found; derived the project URL from the ${derived.from}.`);
    return derived;
  }
  return { url: "", from: null };
}

function resolveSupabaseKey(warnings) {
  for (const name of SUPABASE_KEY_NAMES) {
    const value = readEnv(name);
    if (!value) continue;
    const claims = decodeJwtPayload(value);
    if (claims?.role && claims.role !== "service_role") {
      warnings.push(
        `${name} carries role="${claims.role}" instead of "service_role" — ` +
          "RLS-protected writes may fail; prefer the service-role key."
      );
    }
    return { key: value, from: name, role: claims?.role || "unknown" };
  }
  return { key: "", from: null, role: "unknown" };
}

const warnings = [];
const resolvedUrl = resolveSupabaseUrl(warnings);
const resolvedKey = resolveSupabaseKey(warnings);

/**
 * Project ref — needed by the Management API
 * (POST https://api.supabase.com/v1/projects/{ref}/database/query).
 * Read from SUPABASE_PROJECT_REF, else parsed from the project URL host.
 */
function resolveProjectRef(url) {
  const explicit = readEnv("SUPABASE_PROJECT_REF");
  if (explicit) return explicit;
  const match = String(url || "").match(/^https?:\/\/([a-z0-9-]+)\.supabase\.(?:co|in)/i);
  if (match) return match[1];
  const derived = deriveSupabaseUrlFromKeys();
  if (derived) return derived.url.replace(/^https?:\/\//, "").split(".")[0];
  return "";
}

// Supabase Personal Access Token (sbp_…) — only needed to APPLY migrations
// via the Management API. Never required at runtime by the app itself.
const SUPABASE_ACCESS_TOKEN_NAMES = ["SUPABASE_ACCESS_TOKEN", "SUPABASE_ACCESS_TOKEN_KEY"];

function resolveAccessToken() {
  for (const name of SUPABASE_ACCESS_TOKEN_NAMES) {
    const value = readEnv(name);
    if (value) return { token: value, from: name };
  }
  return { token: "", from: null };
}

const resolvedAccessToken = resolveAccessToken();

const config = {
  rootDir: ROOT_DIR,
  supabaseUrl: resolvedUrl.url,
  supabaseUrlSource: resolvedUrl.from,
  supabaseKey: resolvedKey.key,
  supabaseKeySource: resolvedKey.from,
  supabaseKeyRole: resolvedKey.role,
  supabaseProjectRef: resolveProjectRef(resolvedUrl.url),
  supabaseAccessToken: resolvedAccessToken.token,
  supabaseAccessTokenSource: resolvedAccessToken.from,
  tvmazeBaseUrl: readEnv("TV_MAZ_API_URL") || readEnv("TVMAZE_API_URL") || DEFAULT_TVMAZE_BASE_URL,
  tvmazeApiKey: readEnv("TVMAZE_API_KEY"),
  // Internal Railway service URL for other Railway services. It is not a
  // browser/public URL; use the generated public Railway domain externally.
  backendInternalUrl: readEnv("BACKEND_INTERNAL_URL"),
  port: Number(readEnv("SERVER_PORT") || readEnv("PORT")) || DEFAULT_PORT,
  cacheTtlMs: Number(readEnv("MEDIA_CACHE_TTL_MS")) || DEFAULT_CACHE_TTL_MS,
  requestTimeoutMs: Number(readEnv("TVMAZE_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
  streamMinSeeders: Number(readEnv("STREAM_MIN_SEEDERS")) || 3,
  streamResolverTimeoutMs: Number(readEnv("STREAM_RESOLVER_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
  torrentIndexerEndpoints: readEnv("TORRENT_INDEXER_ENDPOINTS") || readEnv("TORRENT_INDEXER_API_URL"),
  torrentIndexerApiKey: readEnv("TORRENT_INDEXER_API_KEY"),
  ddlFallbackEndpoints: readEnv("STREAM_DDL_ENDPOINTS") || readEnv("STREAM_DDL_API_URL"),
  ddlFallbackApiKey: readEnv("STREAM_DDL_API_KEY") || readEnv("STREAMING_API_KEY"),
  streamingApiKey: readEnv("STREAMING_API_KEY"),
  tmdbApiKey: readEnv("TMDB_API_KEY"),
  omdbApiKey: readEnv("OMDB_API_KEY"),
  serverBaseUrl: (
    readEnv("SERVER_BASE_URL") ||
    readEnv("PUBLIC_BACKEND_URL") ||
    (readEnv("VERCEL_URL")
      ? `https://${readEnv("VERCEL_URL").replace(/^https?:\/\//i, "").replace(/\/$/, "")}`
      : "") ||
    (readEnv("RAILWAY_PUBLIC_DOMAIN")
      ? `https://${readEnv("RAILWAY_PUBLIC_DOMAIN").replace(/^https?:\/\//i, "").replace(/\/$/, "")}`
      : "") ||
    "https://cinebroadcast-production.up.railway.app"
  ).replace(/\/$/, ""),
  ytsApiUrl: (readEnv("YTS_API_URL") || "https://yts.mx/api/v2").replace(/\/+$/, ""),
  fallbackEmbedProviders: readEnv("FALLBACK_EMBED_PROVIDERS") || "vidsrc,2embed,multiembed",
  internetArchiveAccessKey: readEnv("INTERNET_ARCHIVE_API_ACCESS_KEY"),
  internetArchiveSecretKey: readEnv("INTERNET_ARCHIVE_API_SECRET_KEY"),
  envWarnings: warnings,
};

function isSupabaseConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseKey);
}

/** True when migrations can be applied automatically through the Management API. */
function canApplyMigrations() {
  return Boolean(config.supabaseAccessToken && config.supabaseProjectRef);
}

/** Returns a human readable (secret-free) snapshot for logs / the verify script. */
function describeEnv() {
  return {
    supabaseUrl: config.supabaseUrl || "(missing)",
    supabaseUrlSource: config.supabaseUrlSource || "not found",
    supabaseProjectRef: config.supabaseProjectRef || "(unknown)",
    supabaseKey: maskSecret(config.supabaseKey),
    supabaseKeySource: config.supabaseKeySource || "not found",
    supabaseKeyRole: config.supabaseKeyRole,
    supabaseAccessToken: config.supabaseAccessToken
      ? maskSecret(config.supabaseAccessToken)
      : "(not set — set SUPABASE_ACCESS_TOKEN to apply migrations automatically)",
    supabaseAccessTokenSource: config.supabaseAccessTokenSource || "not found",
    tvmazeBaseUrl: config.tvmazeBaseUrl,
    tvmazeApiKey: config.tvmazeApiKey ? maskSecret(config.tvmazeApiKey) : "(not set — public API)",
    backendInternalUrl: config.backendInternalUrl || "(not set)",
    port: config.port,
    cacheTtlMs: config.cacheTtlMs,
    envWarnings: config.envWarnings,
  };
}

/** Throws with an actionable message when Supabase credentials cannot be resolved. */
function assertSupabaseConfig() {
  if (isSupabaseConfigured()) return config;
  throw new Error(
    "Supabase credentials are missing. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY " +
      `to ${path.join(ROOT_DIR, ".env")} (a service-role JWT with a "ref" claim is also accepted — ` +
      "the project URL is then derived automatically)."
  );
}

module.exports = {
  ...config,
  isSupabaseConfigured,
  canApplyMigrations,
  describeEnv,
  assertSupabaseConfig,
  isHttpUrl,
  decodeJwtPayload,
  maskSecret,
};