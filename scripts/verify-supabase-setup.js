#!/usr/bin/env node
"use strict";

/**
 * End-to-end verification for the Supabase + TVMaze lazy-cache service.
 *
 *   npm run verify:supabase
 *
 * Checks performed:
 *   1. .env resolution (which variable names are present) without printing secrets.
 *   2. Migration file exists and declares external_id as UNIQUE.
 *   3. Supabase reachable + media_content table ready.
 *   4. TVMaze reachable.
 *   5. Round trip: MISS → upsert (TVMaze), then HIT → Supabase only.
 *   6. Duplicate protection: repeated upserts keep exactly ONE row per external_id.
 *
 * NOTE: step 5/6 intentionally caches one real TVMaze show (id 1 — "Under the
 * Dome") plus every show id passed via --id=<n>, which is the service's normal
 * behaviour. Nothing else is written and no rows are deleted.
 */

const fs = require("fs");
const path = require("path");

const env = require("../server/config/env");
const { checkSupabaseConnection } = require("../server/services/supabaseClient");
const tvmaze = require("../server/services/tvmazeService");
const mediaContent = require("../server/services/mediaContentService");

const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATION_FILE = path.join(
  ROOT_DIR,
  "supabase",
  "migrations",
  "20260923120000_create_media_content.sql"
);
const SUPABASE_ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_ANON_KEY",
];

const results = [];
function record(label, passed, detail = "") {
  results.push({ label, passed, detail });
  const icon = passed ? "PASS" : "FAIL";
  console.log(`${icon.padEnd(4)} | ${label}${detail ? ` — ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 54 - title.length))}`);
}

function parseArgs() {
  const idArg = process.argv.find((arg) => arg.startsWith("--id="));
  return { showId: idArg ? Number(idArg.split("=")[1]) : 1 };
}

function checkEnvFile() {
  section("1. .env resolution");
  const envPath = path.join(ROOT_DIR, ".env");
  const present = fs.existsSync(envPath)
    ? fs
        .readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes("="))
        .map((line) => line.slice(0, line.indexOf("=")).trim())
    : [];

  record(".env file exists", fs.existsSync(envPath), envPath);
  const found = SUPABASE_ENV_NAMES.filter((name) => present.includes(name));
  record("Supabase env names found", found.length > 0, found.join(", ") || "none");
  record("TVMaze base URL found", present.includes("TV_MAZ_API_URL") || present.includes("TVMAZE_API_URL"));

  const description = env.describeEnv();
  console.log(`       Supabase URL  : ${description.supabaseUrl} (${description.supabaseUrlSource})`);
  console.log(`       Supabase key  : ${description.supabaseKey} (${description.supabaseKeySource}, role=${description.supabaseKeyRole})`);
  console.log(`       TVMaze base   : ${description.tvmazeBaseUrl}`);
  description.envWarnings.forEach((warning) => console.log(`       ! ${warning}`));

  record("Supabase credentials resolved", env.isSupabaseConfigured(), description.supabaseUrlSource || "missing");
  record(
    "Service-role key in use",
    description.supabaseKeyRole === "service_role" || description.supabaseKeyRole === "unknown",
    `role=${description.supabaseKeyRole}`
  );
  return description;
}

function checkMigrationFile() {
  section("2. Migration / schema");
  const exists = fs.existsSync(MIGRATION_FILE);
  record("Migration file present", exists, path.relative(ROOT_DIR, MIGRATION_FILE));
  if (!exists) return;

  const sql = fs.readFileSync(MIGRATION_FILE, "utf8");
  record("Creates media_content table", /CREATE TABLE IF NOT EXISTS public\.media_content/i.test(sql));
  record("external_id declared UNIQUE", /external_id\s+INT\s+UNIQUE\s+NOT NULL/i.test(sql));
  record("details is JSONB NOT NULL", /details\s+JSONB\s+NOT NULL/i.test(sql));
  record("updated_at trigger defined", /media_content_set_updated_at/i.test(sql));
}

async function checkConnectivity() {
  section("3. Connectivity");
  const db = await checkSupabaseConnection();
  record("Supabase reachable", db.ok, db.ok ? "client created" : db.error?.message || "unreachable");
  record("media_content table ready", db.tableReady, db.error ? db.error.message : `cached rows: ${db.rowCount}`);

  try {
    const matches = await tvmaze.searchShows("Breaking Bad", 1);
    record("TVMaze reachable", matches.length > 0, matches[0]?.show?.name || "no results");
  } catch (error) {
    record("TVMaze reachable", false, error.message);
  }

  return db;
}

async function checkLazyCacheRoundTrip(showId) {
  section("4. Lazy caching round trip (TVMaze id " + showId + ")");

  const before = await mediaContent.countRowsForExternalId(showId);
  console.log(`       rows for external_id=${showId} before: ${before}`);

  // Force the upstream fetch so this check is deterministic even when a
  // previous run already cached a fresh copy of this show (TTL is 7 days).
  // The row itself must still be reused in place — never duplicated.
  const first = await mediaContent.getTvShowByExternalId(showId, { refresh: true });
  record(
    "First call fetched from TVMaze (cache MISS)",
    first.upstreamCalled && !first.cacheHit && first.stored,
    `title="${first.row.title}", stored=${first.stored}, refreshed=${before > 0}`
  );
  record("Row contains JSONB details", Boolean(first.row.details?.title), `provider=${first.row.details?.provider}`);
  record(
    "external_id persisted as integer",
    Number.isInteger(Number(first.row.external_id)) && Number(first.row.external_id) === showId,
    `external_id=${first.row.external_id}`
  );

  const second = await mediaContent.getTvShowByExternalId(showId);
  record(
    "Second call served from Supabase (cache HIT, no API call)",
    second.cacheHit && !second.upstreamCalled && second.row.id === first.row.id,
    `row_id=${second.row.id}`
  );

  section("5. Duplicate protection (upsert onConflict=external_id)");
  await mediaContent.upsertShowRow(first.row.details); // re-upsert same payload
  const details = await tvmaze.fetchShowPayload(showId);
  await mediaContent.upsertShowRow(details); // upsert a freshly fetched payload

  const after = await mediaContent.countRowsForExternalId(showId);
  record("Exactly one row after repeated upserts", after === 1, `rows for external_id=${showId}: ${after}`);
  record("Same row id reused (no new row inserted)", second.row.id === first.row.id, `row_id=${second.row.id}`);

  const refreshed = await mediaContent.getTvShowByExternalId(showId, { refresh: true });
  record("Forced refresh re-upserts in place", refreshed.upstreamCalled && refreshed.row.id === first.row.id, `row_id=${refreshed.row.id}`);

  const stillOne = await mediaContent.countRowsForExternalId(showId);
  record("Still exactly one row after forced refresh", stillOne === 1, `rows for external_id=${showId}: ${stillOne}`);
}

async function checkHttpSurface(showId, tableReady) {
  section("6. Live HTTP surface (real requests against the Express app)");
  const app = require("../server/app");

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = async (path) => {
    const response = await fetch(`${base}${path}`);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };

  try {
    const root = await call("/health");
    record("GET /health", root.status === 200 && root.body?.ok === true, `status ${root.status}`);

    if (!tableReady) {
      console.log("       ! media_content is not ready — DB-backed routes should report 503 CACHE_NOT_READY.");
      const pending = await call(`/api/tv-shows/${showId}`);
      record(
        "Missing table degrades to 503 CACHE_NOT_READY (no crash)",
        pending.status === 503 && pending.body?.error?.code === "CACHE_NOT_READY",
        `status ${pending.status}, code=${pending.body?.error?.code}`
      );
    }

    const svcHealth = await call("/api/tv-shows/health");
    record(
      "GET /api/tv-shows/health responds with a JSON status",
      [200, 503].includes(svcHealth.status) && typeof svcHealth.body?.database?.tableReady === "boolean",
      `status ${svcHealth.status}, tableReady=${svcHealth.body?.database?.tableReady}`
    );

    const missing = await call("/api/tv-shows/99999999");
    if (tableReady) {
      record(
        "Unknown TVMaze id → clean 404 JSON",
        missing.status === 404 && missing.body?.error?.code === "NOT_FOUND",
        `status ${missing.status}, code=${missing.body?.error?.code}`
      );
    } else {
      console.log(
        `       (skipped 404 check — needs the table; got ${missing.status} ${missing.body?.error?.code || ""})`
      );
    }

    const badId = await call("/api/tv-shows/not-a-number");
    record(
      "Non-numeric id → 400 JSON",
      badId.status === 400 && badId.body?.error?.code === "INVALID_ID",
      `status ${badId.status}, code=${badId.body?.error?.code}`
    );

    const route404 = await call("/api/does-not-exist");
    record(
      "Unknown route → ROUTE_NOT_FOUND",
      route404.status === 404 && route404.body?.error?.code === "ROUTE_NOT_FOUND",
      `status ${route404.status}`
    );

    if (tableReady) {
      const byId = await call(`/api/tv-shows/${showId}`);
      record(
        `GET /api/tv-shows/${showId} returns a cached row`,
        byId.status === 200 && byId.body?.ok === true && Boolean(byId.body?.data?.details),
        `cached=${byId.body?.cached}, upstreamCalled=${byId.body?.upstreamCalled}`
      );

      const cachedAgain = await call(`/api/tv-shows/${showId}`);
      record(
        `Second GET /api/tv-shows/${showId} is a cache hit`,
        cachedAgain.status === 200 && cachedAgain.body?.cached === true && cachedAgain.body?.upstreamCalled === false,
        `cached=${cachedAgain.body?.cached}`
      );

      const byTitle = await call(`/api/tv-shows?title=${encodeURIComponent("Under the Dome")}`);
      record(
        "GET /api/tv-shows?title=… resolves via the cache",
        byTitle.status === 200 && byTitle.body?.ok === true,
        `matchedBy=${byTitle.body?.matchedBy}, cached=${byTitle.body?.cached}`
      );

      const list = await call("/api/tv-shows/cache?limit=5");
      record(
        "GET /api/tv-shows/cache lists stored rows (0 upstream calls)",
        list.status === 200 && Array.isArray(list.body?.items) && list.body?.upstreamCalled === false,
        `items=${list.body?.items?.length}, total=${list.body?.total}`
      );

      const search = await call("/api/tv-shows/search?q=breaking");
      record(
        "GET /api/tv-shows/search?q=… proxies TVMaze",
        search.status === 200 && Array.isArray(search.body?.items) && search.body.items.length > 0,
        `items=${search.body?.items?.length}`
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const { showId } = parseArgs();
  console.log("Cinebroad — Supabase + TVMaze lazy-cache verification\n" + "=".repeat(58));

  const description = checkEnvFile();
  checkMigrationFile();

  if (!env.isSupabaseConfigured()) {
    section("Result");
    console.log("FAIL — Supabase credentials are missing, so DB checks were skipped.");
    console.log("Add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to .env and re-run.");
    process.exit(1);
  }

  const db = await checkConnectivity();

  if (db.tableReady) {
    try {
      await checkLazyCacheRoundTrip(showId);
    } catch (error) {
      record("Lazy cache round trip", false, error.message);
    }
  } else {
    section("4. Lazy caching round trip");
    record("Skipped — apply the migration first", false, db.error?.message || "table not ready");
    console.log("Run supabase/migrations/20260923120000_create_media_content.sql in the SQL Editor.");
  }

  await checkHttpSurface(showId, db.tableReady);

  section("Result");
  const failed = results.filter((entry) => !entry.passed);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  console.log(`env: ${description.supabaseUrl}`);

  if (!db.tableReady) {
    console.log("\nACTION REQUIRED — apply the migration once:");
    console.log("  Supabase Dashboard → SQL Editor → paste the contents of");
    console.log(`  ${path.relative(ROOT_DIR, MIGRATION_FILE)}`);
    console.log("  (or run: npx supabase db push)");
    console.log("Then re-run: npm run verify:supabase");
  }

  if (failed.length) {
    console.log("\nFailed checks:");
    failed.forEach((entry) => console.log(`  - ${entry.label}: ${entry.detail}`));
    process.exit(1);
  }
  console.log("PASS — Supabase caching, upsert de-duplication and the Express API all work.");
  process.exit(0);
}

main().catch((error) => {
  console.error("\nFatal verification error:", error);
  process.exit(1);
});