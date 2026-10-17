/**
 * Latency benchmark for the DB-first fast path.
 * Measures how fast a page payload + item search is served straight from
 * Supabase (target: well under 2 seconds per call).
 *
 *   node scripts/bench-db-fastpath.js
 */
require("dotenv").config({ path: ".env" });

const env = require("../server/config/env");
const { createClient } = require("@supabase/supabase-js");
const { createPageCache } = require("../src/supabasePageCache");
const { createMediaItemStore } = require("../src/mediaItemStore");

const TARGET_MS = 2000;
const silent = { log() {}, warn() {} };

async function main() {
  const supabase = createClient(env.supabaseUrl, env.supabaseKey);
  const pageCache = createPageCache({ getClient: () => supabase, logger: silent });
  const store = createMediaItemStore({ getClient: () => supabase, logger: silent });

  const results = [];

  async function bench(label, fn) {
    const t0 = Date.now();
    const value = await fn();
    const ms = Date.now() - t0;
    results.push({ label, ms, ok: ms < TARGET_MS });
    return { value, ms };
  }

  const pageKey = "movie-2025-vote_average.desc-8-p1";
  const { value: page, ms: msPage } = await bench("page-cache read (" + pageKey + ")", () =>
    pageCache.read(pageKey)
  );
  console.log(
    "1) page-cache read  : " + msPage + "ms -> " +
      (page ? "HIT, items=" + ((page.items || []).length) : "MISS")
  );

  const { value: r1, ms: ms1 } = await bench('DB search "batman"', () =>
    store.searchItems("batman")
  );
  console.log("2) DB search batman : " + ms1 + "ms -> items=" + r1.items.length);

  const { value: r2, ms: ms2 } = await bench('DB search "batman" (tv only)', () =>
    store.searchItems("batman", { mediaType: "tv" })
  );
  console.log(
    "3) DB search tv-only: " + ms2 + "ms -> items=" + r2.items.length +
      (r2.items.length ? " (" + r2.items[0].title + ")" : "")
  );

  const { value: r3, ms: ms3 } = await bench('DB search "avatar"', () =>
    store.searchItems("avatar")
  );
  console.log(
    "4) DB search avatar : " + ms3 + "ms -> items=" + r3.items.length +
      (r3.items.length ? " (" + r3.items[0].title + ")" : "")
  );

  console.log("--------------------------------------------------");
  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length
      ? "FAIL: " + failed.map((r) => r.label + "=" + r.ms + "ms").join(", ")
      : "PASS: all " + results.length + " calls < " + TARGET_MS + "ms (DB-first is fast)"
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("FAIL:", error.message);
  process.exit(1);
});
