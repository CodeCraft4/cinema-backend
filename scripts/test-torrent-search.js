#!/usr/bin/env node
"use strict";

/**
 * Terminal test — torrent search across MULTIPLE movies + series (B7).
 *   npm run test:torrent-search                 → one pass over all queries
 *   node scripts/test-torrent-search.js --runs=3 → repeat passes ("test again by again")
 *   ... --persist     → also save results into Supabase media_torrents (B1)
 *   ... --no-magnet   → skip magnet resolution (pure search check)
 *
 * PASS criteria per query: ≥1 result. Magnet resolution for the top result is
 * attempted and reported. Exit code 0 = all queries returned torrents.
 * Uses the EXACT same src/torrentSearch.js code the Electron app runs.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), override: true });

const TorrentSearchApi = require("torrent-search-api");
const { initTorrentProviders, fetchTorrentSearch, parseTorrentReleaseMeta } = require("../src/torrentSearch");

const args = process.argv.slice(2);
const RUNS = Math.max(1, Number((args.find((a) => a.startsWith("--runs=")) || "--runs=1").split("=")[1]) || 1);
const PERSIST = args.includes("--persist");
const NO_MAGNET = args.includes("--no-magnet");

const QUERIES = [
  { kind: "movie", query: "Inception 2010", scope: { mediaType: "movie", externalId: 27205 } },
  { kind: "movie", query: "Interstellar 2014", scope: { mediaType: "movie", externalId: 157336 } },
  {
    kind: "series",
    query: "Breaking Bad S01E01",
    scope: { mediaType: "tv", externalId: 1396, season: 1, episode: 1 },
  },
  {
    kind: "series",
    query: "Stranger Things S01E01",
    scope: { mediaType: "tv", externalId: 66732, season: 1, episode: 1 },
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveMagnet(item, timeoutMs = 12000) {
  if (String(item?.magnet || "").startsWith("magnet:")) return item.magnet;
  if (!item?.desc && !item?.link && !item?.provider) return null;
  try {
    const magnet = await Promise.race([
      TorrentSearchApi.getMagnet(item),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return magnet && String(magnet).startsWith("magnet:") ? magnet : null;
  } catch {
    return null;
  }
}

async function getPersistLibrary() {
  const { getSupabaseClient } = require("../server/services/supabaseClient");
  const { createTorrentLibrary } = require("../src/torrentLibrary");
  const supabase = getSupabaseClient();
  return createTorrentLibrary({ getClient: () => supabase });
}

async function main() {
  console.log("Cinebroad — torrent search test (multiple movies + series)");
  console.log("=".repeat(64));
  const providers = initTorrentProviders();
  console.log(`Providers (${providers.length}): ${providers.join(", ") || "(public fallback)"}\n`);

  let library = null;
  if (PERSIST) {
    try {
      library = await getPersistLibrary();
      console.log("--persist: top results will be saved to media_torrents (B1)\n");
    } catch (error) {
      console.error("Persist setup failed:", error.message);
      process.exit(1);
    }
  }

  const tally = new Map(QUERIES.map((q) => [q.query, { hits: 0, tries: 0, magnets: 0 }]));
  let savedTotal = 0;
  let persistErrors = 0;

  for (let run = 1; run <= RUNS; run += 1) {
    if (run > 1) {
      console.log("-".repeat(64));
      console.log(`run ${run}/${RUNS}`);
      await sleep(2000); // polite gap between repeats
    }
    for (const entry of QUERIES) {
      const t0 = Date.now();
      const results = (await fetchTorrentSearch(entry.query, { maxTitles: 4 }).catch(() => [])) || [];
      const ms = Date.now() - t0;
      const stat = tally.get(entry.query);
      stat.tries += 1;
      if (results.length) stat.hits += 1;

      console.log(`[run ${run}] ${entry.kind.padEnd(6)} "${entry.query}" → ${results.length} result(s) in ${ms}ms`);
      for (const item of results.slice(0, 3)) {
        const meta = parseTorrentReleaseMeta(item.title);
        console.log(
          `    · ${String(item.title).slice(0, 78)} | ${item.provider || "?"} | seeds=${item.seeds || 0} | ${meta.quality}` +
            (meta.languageTags.length ? ` | ${meta.languageTags.join("+")}` : "") +
            (meta.part > 0 ? ` | part${meta.part}` : "")
        );
      }
      if (!results.length) console.log("    ✗ NO RESULTS");

      if (!NO_MAGNET && results[0]) {
        const magnet = await resolveMagnet(results[0]);
        if (magnet) {
          stat.magnets += 1;
          console.log(`    ✓ magnet OK: ${String(magnet).slice(0, 72)}…`);
        } else {
          console.log("    ! magnet resolve failed for top result (another may still resolve)");
        }
      }

      if (PERSIST && results.length && library) {
        const save = await library.saveSearchResults(results.slice(0, 5), {
          ...entry.scope,
          queryKey: entry.query,
        });
        savedTotal += save.saved || 0;
        if (save.error) persistErrors += 1;
        console.log(
          `    ⇅ persisted ${save.saved || 0} row(s) → media_torrents${save.error ? ` — ERROR: ${save.error}` : ""}`
        );
      }
    }
  }

  console.log("\n" + "=".repeat(64));
  console.log("Summary:");
  let failed = 0;
  let magnetAny = false;
  for (const entry of QUERIES) {
    const stat = tally.get(entry.query);
    const ok = stat.hits > 0;
    if (!ok) failed += 1;
    if (stat.magnets > 0) magnetAny = true;
    console.log(
      `  ${ok ? "PASS" : "FAIL"} | ${entry.kind.padEnd(6)} "${entry.query}" — results in ${stat.hits}/${stat.tries} run(s), magnets ${stat.magnets}/${stat.tries}`
    );
  }

  if (PERSIST && library) {
    const back = await library.getTorrents({ query: QUERIES[0].query, ...QUERIES[0].scope }).catch(() => []);
    console.log(`  DB fallback read-back: ${back.length} row(s) for "${QUERIES[0].query}"`);
    if (!back.length) failed += 1;
    console.log(`  saved rows total this run: ${savedTotal}`);
    if (persistErrors) {
      console.log(`  FAIL | ${persistErrors} persist error(s) during save`);
      failed += persistErrors;
    } else if (savedTotal) {
      console.log("  PASS | all persists clean (no upsert errors)");
    }
  }
  if (!NO_MAGNET && !magnetAny && failed === 0) {
    console.log("  WARN: no magnet resolved this pass (results exist — re-run may resolve).");
  }

  console.log(failed ? `\n✗ ${failed} check(s) failed` : "\n✓ all queries returned torrents");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
