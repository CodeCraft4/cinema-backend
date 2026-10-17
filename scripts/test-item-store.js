#!/usr/bin/env node
"use strict";

/**
 * Live proof that fetched items are stored in Supabase EXACTLY ONCE.
 *
 *   npm run test:item-store
 *
 * Runs against the real project with the service-role key, but every row it
 * creates lives in its own scope (source = "tmdb-test"), so the real movie /
 * series cache is never touched. All test rows are deleted at the end.
 *
 * Proves:
 *   1. new items are inserted                        (movie + series)
 *   2. re-running the same batch inserts NOTHING     (already in DB → skipped)
 *   3. an existing row is never overwritten          (no churn, no duplicate)
 *   4. duplicates inside one batch collapse          (same id twice → 1 row)
 *   5. movie & series may share a numeric id         (composite UNIQUE works)
 *   6. no duplicate (source, media_type, external_id) group exists in the table
 *   7. DB-first search returns stored rows in UI shape
 */

const { getSupabaseClient } = require("../server/services/supabaseClient");
const { createMediaItemStore } = require("../src/mediaItemStore");
const { createPageCache } = require("../src/supabasePageCache");

const TEST_SOURCE = "tmdb-test";
const BASE_ID = 90001000;
const TABLE = "media_content";

const results = { passed: 0, failed: 0 };
function check(label, condition, detail = "") {
  if (condition) results.passed += 1;
  else results.failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
}

function movie(id, title) {
  return { tmdbId: id, title, year: "1999", mediaType: "movie", typeLabel: "MOVIE", rating: 75 };
}
function series(id, title) {
  return { tmdbId: id, title, year: "2001", mediaType: "tv", typeLabel: "SERIES", rating: 81 };
}

/** Reads every row of a source (paged, so it also works past 1000 rows). */
async function fetchAllRows(supabase, source) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("external_id, source, media_type, title, details")
      .eq("source", source)
      .order("external_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

/** Reads the whole table's keys to prove there is no duplicate anywhere. */
async function fetchAllKeys(supabase) {
  const pageSize = 1000;
  const keys = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("external_id, source, media_type")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    keys.push(...data.map((row) => `${row.source}|${row.media_type}|${row.external_id}`));
    if (data.length < pageSize) break;
  }
  return keys;
}

async function main() {
  const supabase = getSupabaseClient();
  const store = createMediaItemStore({
    getClient: () => supabase,
    logger: { log() {}, warn: (...args) => console.warn(...args) },
  });

  console.log("Cinebroad — media_content duplicate-safety test (live)");
  console.log("=".repeat(64));

  // ── clean slate for this test scope ──────────────────────────────────────
  const { error: cleanError } = await supabase.from(TABLE).delete().eq("source", TEST_SOURCE);
  if (cleanError) {
    console.error(`Could not clear the "${TEST_SOURCE}" test scope: ${cleanError.message}`);
    process.exitCode = 1;
    return;
  }
  check("test scope is empty before we start", (await fetchAllRows(supabase, TEST_SOURCE)).length === 0);

  // ── 1. first fetch → everything new is stored ────────────────────────────
  const batch = [
    movie(BASE_ID + 1, "Test Movie One"),
    movie(BASE_ID + 1, "Test Movie One (same batch duplicate)"),
    series(BASE_ID + 2, "Test Series Two"),
    movie(BASE_ID + 2, "Test Movie Two (same numeric id as the series)"),
  ];
  const first = await store.storeItems(batch, { source: TEST_SOURCE });
  check(
    "first fetch stores every unique item (new data → DB)",
    first.stored === 3 && first.checked === 3,
    `stored=${first.stored}, checked=${first.checked}`
  );
  check(
    "duplicate inside one batch is collapsed",
    batch.length - first.checked === 1,
    `${batch.length} items → ${first.checked} unique`
  );

  const afterFirst = await fetchAllRows(supabase, TEST_SOURCE);
  check("3 rows exist in the DB after the first fetch", afterFirst.length === 3, `rows=${afterFirst.length}`);

  // ── 2. same items fetched again → nothing is stored ──────────────────────
  const second = await store.storeItems(batch, { source: TEST_SOURCE });
  check(
    "already-stored items are NOT stored again",
    second.stored === 0 && second.skipped === 3,
    `stored=${second.stored}, skipped=${second.skipped}`
  );
  check("row count unchanged after a repeat fetch", (await fetchAllRows(supabase, TEST_SOURCE)).length === 3);

  // ── 3. an existing row is never overwritten ──────────────────────────────
  const mutated = await store.storeItems([movie(BASE_ID + 1, "SHOULD NOT OVERWRITE")], { source: TEST_SOURCE });
  const storedRow = (await fetchAllRows(supabase, TEST_SOURCE)).find(
    (row) => Number(row.external_id) === BASE_ID + 1
  );
  check("existing row is skipped, not rewritten", mutated.stored === 0 && mutated.skipped === 1);
  check("stored title is untouched", storedRow?.title === "Test Movie One", `title="${storedRow?.title}"`);

  // ── 4. movie & series can share one numeric id ───────────────────────────
  const ids = (await fetchAllRows(supabase, TEST_SOURCE)).map((row) => `${row.media_type}:${row.external_id}`);
  check(
    "same id stored once as movie and once as series",
    ids.includes(`movie:${BASE_ID + 2}`) && ids.includes(`tv:${BASE_ID + 2}`)
  );

  // ── 5. no duplicate anywhere in the table ────────────────────────────────
  const keys = await fetchAllKeys(supabase);
  const unique = new Set(keys);
  check(
    "table holds zero duplicate (source, media_type, external_id) rows",
    keys.length === unique.size,
    `${keys.length} rows, ${unique.size} unique`
  );

  // ── 6. DB-first search returns UI cards ──────────────────────────────────
  const found = await store.searchItems("Test Series Two", { source: TEST_SOURCE });
  check(
    "DB-first search finds the stored series",
    found.items.length === 1 && found.items[0].typeLabel === "SERIES" && found.items[0].tmdbId === BASE_ID + 2,
    JSON.stringify(found.items[0] || null)
  );

  // ── cleanup ─────────────────────────────────────────────────────────────
  await supabase.from(TABLE).delete().eq("source", TEST_SOURCE);
  check("test rows cleaned up", (await fetchAllRows(supabase, TEST_SOURCE)).length === 0);

  // ── 7. page payload cache (media_page_cache): one row per cache_key ──────
  const pageCache = createPageCache({ getClient: () => supabase, logger: { log() {}, warn() {} } });
  const pageKey = `test-page-${Date.now()}`;
  const pagePayload = { items: [movie(BASE_ID + 5, "Page Cache Movie")], page: 1, totalPages: 3 };

  await pageCache.remove(pageKey);
  const writeOk = await pageCache.write(pageKey, pagePayload);
  const readBack = await pageCache.read(pageKey);
  check("page payload is written to media_page_cache", writeOk === true);
  check("stored page payload is served back from the DB", readBack?.items?.[0]?.tmdbId === BASE_ID + 5);

  await pageCache.write(pageKey, pagePayload); // same key a second time
  const { count: pageRows } = await supabase
    .from("media_page_cache")
    .select("id", { count: "exact", head: true })
    .eq("cache_key", pageKey);
  check("re-writing the same page keeps exactly ONE row", pageRows === 1, `rows=${pageRows}`);

  check("unknown cache key is a clean miss", (await pageCache.read(`test-page-missing-${Date.now()}`)) === null);

  await pageCache.remove(pageKey);
  check("page cache test row cleaned up", (await pageCache.read(pageKey)) === null);

  // ── 8. transient write failure → retried (deterministic, no network) ─────
  let upsertAttempts = 0;
  const written = [];
  const flakyChain = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    in() {
      return this;
    },
    upsert(payload) {
      upsertAttempts += 1;
      if (upsertAttempts === 1) {
        return Promise.resolve({ error: { message: "TypeError: fetch failed" } });
      }
      written.push(...(Array.isArray(payload) ? payload : [payload]));
      return Promise.resolve({ error: null });
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
    },
  };
  const flakyStore = createMediaItemStore({
    getClient: () => ({ from: () => flakyChain }),
    logger: { log() {}, warn() {} },
  });
  const flaky = await flakyStore.storeItems([series(BASE_ID + 9, "Flaky Series")], {
    source: TEST_SOURCE,
    retryDelayMs: 1,
  });
  check(
    "a dropped write is retried and recovered",
    flaky.stored === 1 && upsertAttempts === 2,
    `attempts=${upsertAttempts}`
  );
  check("the retried write stored exactly one row", written.length === 1, `rows=${written.length}`);

  console.log("=".repeat(64));
  console.log(`${results.passed} passed, ${results.failed} failed`);
  if (results.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nFatal error:", error.message);
  process.exitCode = 1;
});
