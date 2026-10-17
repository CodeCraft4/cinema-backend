#!/usr/bin/env node
"use strict";

/**
 * Deterministic logic test for the lazy-cache / upsert layer.
 *
 *   npm run test:media-cache
 *
 * The real TVMaze client is used (so the JSON formatter runs against a live
 * payload), while Supabase is replaced by an in-memory fake of the small part
 * of the query-builder API the service uses. That makes it possible to prove
 * the de-duplication behaviour even before the migration is applied:
 *
 *   • cache MISS  → TVMaze call + upsert(onConflict: 'source,media_type,external_id')
 *   • cache HIT   → served from the store, zero upstream calls
 *   • repeated upserts / forced refresh → still exactly ONE row per external_id
 */

const assert = { tests: 0, failures: [] };

function check(label, condition, detail = "") {
  assert.tests += 1;
  if (!condition) assert.failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${condition ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// In-memory fake of the supabase-js surface used by mediaContentService
// ---------------------------------------------------------------------------
function createFakeSupabase() {
  const state = {
    rows: [],
    nextId: 1,
    upsertCalls: 0,
    inserts: 0,
    updates: 0,
    conflictsUsed: new Set(),
    selectCalls: 0,
  };

  const nowIso = () => new Date().toISOString();
  const rowsFor = (table) => state.rows.filter((row) => row.__table === table);

  class Builder {
    constructor(table, mode, columns, options = {}) {
      this.table = table;
      this.mode = mode; // select | upsert
      this.columns = columns;
      this.options = options;
      this.filters = [];
      this.orderBy = null;
      this.rangeArgs = null;
      this.limitCount = null;
      this.payload = null;
    }
    select(columns, options = {}) {
      this.columns = columns;
      this.options = { ...this.options, ...options };
      return this;
    }
    eq(column, value) {
      this.filters.push({ op: "eq", column, value });
      return this;
    }
    ilike(column, value) {
      this.filters.push({ op: "ilike", column, value });
      return this;
    }
    order(column, options = {}) {
      this.orderBy = { column, ascending: options.ascending !== false };
      return this;
    }
    range(from, to) {
      this.rangeArgs = { from, to };
      return this;
    }
    limit(count) {
      this.limitCount = count;
      return this;
    }
    maybeSingle() {
      return this.run().then((result) => ({ ...result, data: result.data?.[0] ?? null }));
    }
    single() {
      return this.run().then((result) => ({
        ...result,
        data: result.data?.[0] ?? null,
        error: result.data?.length ? result.error : result.error || { code: "PGRST116", message: "no rows" },
      }));
    }
    then(resolve, reject) {
      return this.run().then(resolve, reject);
    }

    matches(row) {
      return this.filters.every(({ op, column, value }) => {
        const actual = row[column];
        if (op === "eq") return String(actual) === String(value);
        // ilike: case-insensitive, honouring the escaping done by the service.
        const unescaped = String(value).replace(/\\([\\%_])/g, "$1");
        return String(actual ?? "").toLowerCase() === unescaped.toLowerCase();
      });
    }

    run() {
      if (this.mode === "upsert") return Promise.resolve(this.runUpsert());
      state.selectCalls += 1;
      let rows = rowsFor(this.table).filter((row) => this.matches(row));
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        rows = rows
          .slice()
          .sort((a, b) => (String(a[column]) > String(b[column]) ? 1 : -1) * (ascending ? 1 : -1));
      }
      const total = rows.length;
      if (this.rangeArgs) rows = rows.slice(this.rangeArgs.from, this.rangeArgs.to + 1);
      else if (this.limitCount) rows = rows.slice(0, this.limitCount);
      const data = rows.map(({ __table, ...row }) => row);
      if (this.options.head) return Promise.resolve({ data: null, error: null, count: total, status: 204 });
      return Promise.resolve({ data, error: null, count: total, status: 200 });
    }

    /** Mirrors the DB guarantee: one row per onConflict column tuple (comma lists supported). */
    runUpsert() {
      const onConflict = this.options.onConflict;
      const conflictColumns = String(onConflict || "id")
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean);
      state.upsertCalls += 1;
      state.conflictsUsed.add(onConflict);

      const conflicting = state.rows.filter(
        (row) =>
          row.__table === this.table &&
          conflictColumns.every((column) => String(row[column]) === String(this.payload[column]))
      );
      if (conflicting.length > 1) {
        return { data: null, error: { code: "PGRST999", message: "duplicate rows detected" } };
      }

      if (conflicting.length === 1) {
        Object.assign(conflicting[0], this.payload, { updated_at: nowIso() });
        state.updates += 1;
        const { __table, ...row } = conflicting[0];
        return { data: [row], error: null, status: 200 };
      }

      const row = {
        ...this.payload,
        __table: this.table,
        id: state.nextId++,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      state.rows.push(row);
      state.inserts += 1;
      const { __table, ...publicRow } = row;
      return { data: [publicRow], error: null, status: 201 };
    }
  }

  const client = {
    from: (table) => ({
      select: (columns, options) => new Builder(table, "select", columns, options),
      upsert: (payload, options) => {
        const builder = new Builder(table, "upsert", "*", options);
        builder.payload = payload;
        return builder;
      },
    }),
  };

  return { client, state, rowsFor };
}

// ---------------------------------------------------------------------------
// Patch the module cache so mediaContentService talks to the fake
// ---------------------------------------------------------------------------
const SUPABASE_MODULE = require.resolve("../server/services/supabaseClient");
const realSupabaseModule = require(SUPABASE_MODULE);
const fake = createFakeSupabase();

require.cache[SUPABASE_MODULE] = {
  id: SUPABASE_MODULE,
  filename: SUPABASE_MODULE,
  loaded: true,
  exports: { ...realSupabaseModule, getSupabaseClient: () => fake.client },
};

const mediaContent = require("../server/services/mediaContentService");
const tvmaze = require("../server/services/tvmazeService");

module.exports = { check, assert, fake, mediaContent, tvmaze };

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------
const TEST_SHOW_ID = 1; // "Under the Dome" on TVMaze
const rowsForId = (id) => fake.state.rows.filter((row) => Number(row.external_id) === Number(id));

async function run() {
  console.log("Cinebroad — media cache logic test (TVMaze live, Supabase faked)\n" + "=".repeat(62));

  // 1. MISS → upstream fetch + upsert
  const first = await mediaContent.getTvShowByExternalId(TEST_SHOW_ID);
  check(
    "1. First call is a cache MISS that hits TVMaze and stores the row",
    first.cacheHit === false && first.upstreamCalled === true && first.stored === true,
    `title="${first.row.title}", stored=${first.stored}`
  );
  check(
    "2. Upsert used onConflict='source,media_type,external_id'",
    fake.state.conflictsUsed.size === 1 &&
      fake.state.conflictsUsed.has("source,media_type,external_id"),
    `conflicts used: ${[...fake.state.conflictsUsed].join(", ") || "none"}`
  );
  check(
    "3. Exactly one INSERT happened for the first lookup",
    fake.state.inserts === 1 && rowsForId(TEST_SHOW_ID).length === 1,
    `inserts=${fake.state.inserts}, rows=${rowsForId(TEST_SHOW_ID).length}`
  );
  check(
    "4. Row shape matches the schema (details JSONB, source, media_type)",
    first.row.details?.provider === "tvmaze" &&
      first.row.source === "tvmaze" &&
      first.row.media_type === "tv" &&
      Number.isInteger(Number(first.row.external_id)),
    `source=${first.row.source}, media_type=${first.row.media_type}, external_id=${first.row.external_id}`
  );
  check(
    "5. TVMaze payload was normalized (title, genres, summary, images)",
    Boolean(first.row.details.title) &&
      first.row.details.title === first.row.title &&
      Array.isArray(first.row.details.genres) &&
      "summary" in first.row.details,
    `genres=${JSON.stringify(first.row.details.genres)}`
  );

  // 2. HIT → no upstream call
  const upsertsAfterFirst = fake.state.upsertCalls;
  const second = await mediaContent.getTvShowByExternalId(TEST_SHOW_ID);
  check(
    "6. Second call is a cache HIT with zero upstream calls",
    second.cacheHit === true && second.upstreamCalled === false && second.row.id === first.row.id,
    `cached=${second.cacheHit}, upstream=${second.upstreamCalled}, row_id=${second.row.id}`
  );
  check(
    "7. Cache hit wrote nothing (upsert count unchanged)",
    fake.state.upsertCalls === upsertsAfterFirst,
    `upserts=${fake.state.upsertCalls}`
  );

  // 3. Duplicate protection under repeated writes
  const fresh = await tvmaze.fetchShowPayload(TEST_SHOW_ID);
  await mediaContent.upsertShowRow(fresh);
  await mediaContent.upsertShowRow(fresh);
  await mediaContent.upsertShowRow(first.row.details);
  check(
    "8. Three extra upserts still leave exactly ONE row (no duplicates)",
    rowsForId(TEST_SHOW_ID).length === 1,
    `rows=${rowsForId(TEST_SHOW_ID).length}, inserts=${fake.state.inserts}, updates=${fake.state.updates}`
  );
  check(
    "9. Updates reused the original row id (never inserted again)",
    fake.state.inserts === 1 && fake.state.updates === 3 && rowsForId(TEST_SHOW_ID)[0].id === first.row.id,
    `inserts=${fake.state.inserts}, updates=${fake.state.updates}, row_id=${rowsForId(TEST_SHOW_ID)[0].id}`
  );

  // 4. Forced refresh keeps a single row
  const refreshed = await mediaContent.getTvShowByExternalId(TEST_SHOW_ID, { refresh: true });
  check(
    "10. Forced refresh re-fetches and updates in place",
    refreshed.upstreamCalled === true && refreshed.row.id === first.row.id && rowsForId(TEST_SHOW_ID).length === 1,
    `row_id=${refreshed.row.id}, rows=${rowsForId(TEST_SHOW_ID).length}`
  );

  // 5. Stale entry triggers a refresh instead of a second row
  rowsForId(TEST_SHOW_ID).forEach((row) => {
    row.updated_at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  });
  const afterStale = await mediaContent.getTvShowByExternalId(TEST_SHOW_ID);
  check(
    "11. Stale cache entry is refreshed and still one row",
    afterStale.upstreamCalled === true && afterStale.cacheHit === false && rowsForId(TEST_SHOW_ID).length === 1,
    `upstream=${afterStale.upstreamCalled}, rows=${rowsForId(TEST_SHOW_ID).length}`
  );

  // 6. Title lookup path
  const byTitle = await mediaContent.getTvShowByTitle("under the dome");
  check(
    "12. Title lookup resolves from the cache (case-insensitive, no API call)",
    byTitle.cacheHit === true && byTitle.upstreamCalled === false && byTitle.matchedBy === "title",
    `matchedBy=${byTitle.matchedBy}, cached=${byTitle.cacheHit}`
  );

  const newByTitle = await mediaContent.getTvShowByTitle("Breaking Bad");
  check(
    "13. Unknown title falls through to TVMaze and is cached",
    newByTitle.upstreamCalled === true &&
      newByTitle.matchedBy === "tvmaze-search" &&
      Number(newByTitle.row.external_id) > 0,
    `title="${newByTitle.row.title}", id=${newByTitle.row.external_id}`
  );
  check(
    "14. Each unique show created exactly one row",
    fake.state.rows.length === 2 && fake.state.inserts === 2,
    `rows=${fake.state.rows.length}, inserts=${fake.state.inserts}`
  );

  // 7. Validation + listing
  let invalidId = null;
  try {
    await mediaContent.getTvShowByExternalId("not-a-number");
  } catch (error) {
    invalidId = error;
  }
  check(
    "15. Invalid id rejected with 400 INVALID_ID",
    invalidId?.status === 400 && invalidId?.code === "INVALID_ID",
    invalidId?.message
  );

  let missingTitle = null;
  try {
    await mediaContent.getTvShowByTitle("   ");
  } catch (error) {
    missingTitle = error;
  }
  check(
    "16. Blank title rejected with 400 MISSING_TITLE",
    missingTitle?.status === 400 && missingTitle?.code === "MISSING_TITLE",
    missingTitle?.message
  );

  const list = await mediaContent.listCachedShows({ page: 1, limit: 10 });
  check(
    "17. listCachedShows returns pagination metadata from the store",
    list.items.length === 2 &&
      list.total === 2 &&
      list.totalPages === 1 &&
      list.page === 1 &&
      list.limit === 10,
    `items=${list.items.length}, total=${list.total}, totalPages=${list.totalPages}`
  );

  const uniqueIds = new Set(fake.state.rows.map((row) => row.external_id));
  check(
    "18. Every stored row has a unique external_id",
    fake.state.rows.length === uniqueIds.size,
    `rows=${fake.state.rows.length}, unique=${uniqueIds.size}`
  );

  console.log("\n" + "=".repeat(62));
  const failed = assert.failures.length;
  console.log(
    `${assert.tests - failed}/${assert.tests} checks passed  |  upserts=${fake.state.upsertCalls}, inserts=${fake.state.inserts}, updates=${fake.state.updates}`
  );
  if (failed) {
    console.log("\nFailed:");
    assert.failures.forEach((failure) => console.log(`  - ${failure}`));
    process.exit(1);
  }
  console.log("PASS — lazy caching, upsert de-duplication and store reuse all verified.");
  process.exit(0);
}

run().catch((error) => {
  console.error("\nFatal test error:", error);
  process.exit(1);
});