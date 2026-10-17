#!/usr/bin/env node
"use strict";

/**
 * Live DB test for the LIST B library (B1/B3/B4/B5/B6):
 *   1. media_torrents + media_episodes tables exist (migration applied)
 *   2. saveTorrents upsert → exactly ONE row per release, seeds refresh (B6)
 *   3. DB-fallback reads: getTorrents by scope + by title      (B1)
 *   4. saveMagnetFor on an existing row                        (B1)
 *   5. episode rows upsert never duplicates + ordered read     (B4)
 *   6. markChecked → languageAvailability / checkedAt / parts  (B3/B5)
 *   7. getLanguageMap returns the badge payload                (B3)
 *
 * All test rows live in source="tmdb-test" / show id 90001002 and are
 * deleted at the end — the real catalog is never touched.
 *
 *   npm run test:torrent-db
 */

const { getSupabaseClient } = require("../server/services/supabaseClient");
const { createTorrentLibrary, searchResultToRow, availabilityLabels } = require("../src/torrentLibrary");
const { parseTorrentReleaseMeta } = require("../src/torrentSearch");

const TEST_SOURCE = "tmdb-test";
const MOVIE_ID = 90001001;
const SHOW_ID = 90001002;

const results = { passed: 0, failed: 0 };
function check(label, condition, detail = "") {
  if (condition) results.passed += 1;
  else results.failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const supabase = getSupabaseClient();
  const lib = createTorrentLibrary({ getClient: () => supabase, source: TEST_SOURCE });

  console.log("Cinebroad — media_torrents / media_episodes live test");
  console.log("=".repeat(64));

  // 1) tables exist (migration applied + PostgREST schema cache picked it up)
  const probe = await supabase.from("media_torrents").select("id").limit(1);
  check("media_torrents table visible (migration applied)", !probe.error, probe.error ? probe.error.message : "ok");
  const probe2 = await supabase.from("media_episodes").select("id").limit(1);
  check("media_episodes table visible", !probe2.error, probe2.error ? probe2.error.message : "ok");
  if (probe.error || probe2.error) {
    console.error("\nRun the migration first: npm run db:migrate (file 20260923160000_…),");
    console.error("then wait ~10s for the PostgREST schema cache and re-run.");
    process.exit(1);
  }

  // 2) save → re-save → still exactly one row (B1 + B6)
  const releaseTitle = "Test.Movie.2020.1080p.BluRay.x264-TESTS";
  const scope = { mediaType: "movie", externalId: MOVIE_ID, source: TEST_SOURCE, queryKey: "Test Movie 2020" };
  const row = searchResultToRow(
    { title: releaseTitle, seeds: 10, provider: "test", link: "https://example.invalid/t" },
    scope
  );
  check("searchResultToRow builds a dedupe row", Boolean(row && row.dedupe_key), row ? row.dedupe_key : "null");
  check("B3 quality parsed", row && row.quality === "1080p", row ? `quality=${row.quality}` : "");

  const first = await lib.saveTorrents([row]);
  check("saveTorrents inserted", first.saved === 1, first.error || `saved=${first.saved}`);
  const second = await lib.saveTorrents([{ ...row, seeds: 77, last_refreshed_at: new Date().toISOString() }]);
  check("re-save (refresh) succeeds", second.error === null, second.error || "ok");

  const count = await supabase
    .from("media_torrents")
    .select("id, seeds", { count: "exact" })
    .eq("source", TEST_SOURCE)
    .eq("external_id", MOVIE_ID);
  check(
    "exactly ONE row per release after re-save",
    (count.data || []).length === 1,
    `rows=${(count.data || []).length}`
  );
  check(
    "B6 seeds refreshed on upsert",
    Number(count.data?.[0]?.seeds) === 77,
    `seeds=${count.data?.[0]?.seeds}`
  );

  // 3) DB-fallback reads (B1)
  const byScope = await lib.getTorrents({ ...scope });
  check("getTorrents by scope returns the row", byScope.length === 1, `rows=${byScope.length}`);
  check("fallback row flagged fromDb", byScope[0]?.fromDb === true);
  const byTitle = await lib.getTorrents({ query: "Test Movie 2020 hindi" });
  check("getTorrents by title (noise words stripped)", byTitle.length >= 1, `rows=${byTitle.length}`);

  // 4) magnet save on an existing row (B1)
  const magnetOk = await lib.saveMagnetFor({
    ...scope,
    title: releaseTitle,
    magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=test`,
  });
  check("saveMagnetFor updates the existing row", magnetOk === true);
  const withMagnet = await lib.getTorrents({ ...scope });
  check("magnet stored on the row", String(withMagnet[0]?.magnet || "").startsWith("magnet:"));

  // 5) episode rows (B4)
  const ep = await lib.saveEpisodes({
    showId: SHOW_ID,
    season: 1,
    episodes: [
      { number: 1, title: "Pilot", airDate: "2008-01-20", overview: "x" },
      { number: 2, title: "Cat's in the Bag...", airDate: "2008-01-27" },
    ],
  });
  check("saveEpisodes saved both rows", ep.saved === 2, ep.error || `saved=${ep.saved}`);
  await lib.saveEpisodes({ showId: SHOW_ID, season: 1, episodes: [{ number: 1, title: "Pilot" }] });
  const epCount = await supabase
    .from("media_episodes")
    .select("id", { count: "exact" })
    .eq("source", TEST_SOURCE)
    .eq("show_id", SHOW_ID);
  check("episode upsert never duplicates", (epCount.count || 0) === 2, `rows=${epCount.count}`);
  const readEpisodes = await lib.getEpisodes({ showId: SHOW_ID, season: 1 });
  check(
    "getEpisodes returns ordered rows",
    readEpisodes.length === 2 && Number(readEpisodes[0]?.number) === 1,
    `n=${readEpisodes.length}`
  );

  // 6) markChecked markers (B3/B5) on a test media_content row
  const detailsRow = {
    external_id: MOVIE_ID,
    source: TEST_SOURCE,
    title: "Test Movie",
    media_type: "movie",
    details: { originalLanguage: "en", year: "2020", title: "Test Movie" },
  };
  const upsertContent = await supabase
    .from("media_content")
    .upsert(detailsRow, { onConflict: "source,media_type,external_id", ignoreDuplicates: false });
  check("test media_content row ready", !upsertContent.error, upsertContent.error?.message || "ok");

  const marked = await lib.markChecked({
    mediaType: "movie",
    externalId: MOVIE_ID,
    found: 1,
    languageTags: ["hindi"],
    partsCount: 2,
  });
  check("markChecked wrote the markers", marked === true);

  const readBack = await supabase
    .from("media_content")
    .select("details")
    .eq("source", TEST_SOURCE)
    .eq("media_type", "movie")
    .eq("external_id", MOVIE_ID)
    .maybeSingle();
  const details = readBack.data?.details || {};
  check(
    "B3 languageAvailability = English + Hindi + Original",
    ["English", "Hindi", "Original"].every((l) => (details.languageAvailability || []).includes(l)),
    JSON.stringify(details.languageAvailability)
  );
  check("B3 torrentsCheckedAt stamped", Boolean(details.torrentsCheckedAt));
  check("B5 partsCount stored", Number(details.partsCount) === 2, `partsCount=${details.partsCount}`);

  // 7) getLanguageMap badge payload (B3)
  const map = await lib.getLanguageMap([{ tmdbId: MOVIE_ID, mediaType: "movie" }]);
  const info = map[`movie:${MOVIE_ID}`];
  check(
    "getLanguageMap returns badge payload",
    Array.isArray(info?.languages) && info.languages.length >= 3,
    JSON.stringify(info?.languages)
  );

  // pure helpers
  const labels = availabilityLabels(["hindi"], "en");
  check(
    "availabilityLabels union logic",
    labels.includes("Hindi") && labels.includes("English") && labels.includes("Original"),
    labels.join("+")
  );
  const meta = parseTorrentReleaseMeta("Classic.Film.1999.CD2.avi");
  check("parseTorrentReleaseMeta detects part 2 (B5)", meta.part === 2, `part=${meta.part}`);

  // cleanup — only the test scope is touched
  await supabase.from("media_torrents").delete().eq("source", TEST_SOURCE);
  await supabase.from("media_episodes").delete().eq("source", TEST_SOURCE).eq("show_id", SHOW_ID);
  await supabase
    .from("media_content")
    .delete()
    .eq("source", TEST_SOURCE)
    .eq("media_type", "movie")
    .eq("external_id", MOVIE_ID);

  console.log("=".repeat(64));
  console.log(`${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
