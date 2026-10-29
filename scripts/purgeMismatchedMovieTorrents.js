"use strict";

/**
 * 🧹 Purge Mismatched & Fake Movie Torrents from Supabase
 *
 * Removes torrents where:
 * 1. A Movie row was mistakenly assigned a TV Series / Anime Episode (e.g., S01E02, S02, Ep40).
 *    (e.g., "One Man" playing "[ToonsHub] One-Punch Man S03E02", "The Flash" playing "S01E13", etc.)
 * 2. Anime / Toons torrents attached to live-action movies.
 */

const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");

async function main() {
  const supabase = getSupabaseClient();

  console.log("==================================================================");
  console.log("🧹 [PURGING MISMATCHED & FAKE MOVIE TORRENTS]");
  console.log("   Detecting TV Episodes / Cartoon Anime mistakenly assigned to Movies");
  console.log("==================================================================\n");

  let from = 0;
  const batchSize = 1000;
  let allMovies = [];

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, year, payload, magnet_link")
      .not("media_id", "ilike", "%-s%")
      .not("media_id", "ilike", "%:s%")
      .range(from, from + batchSize - 1);

    if (error || !data || data.length === 0) break;
    allMovies = allMovies.concat(data);
    from += batchSize;
  }

  console.log(`📊 Total Movies scanned: ${allMovies.length}`);

  const badIds = [];
  const badSamples = [];

  for (const m of allMovies) {
    const rawReleaseTitle = (m.payload?.title || m.magnet_link || "").toLowerCase();
    const mediaTitle = (m.media_title || "").toLowerCase();

    // 1. A movie has a TV season/episode torrent (e.g. S01, S02, Ep 1, etc.)
    const hasEpTag = /\b(?:s\d{1,2}e\d{1,2}|s0\d|s1\d|season\s*\d+|ep\s*\d+|episode\s*\d+)\b/i.test(rawReleaseTitle);

    // 2. Anime mismatch (e.g. One-Punch Man for One Man)
    const isAnimeMismatch =
      (rawReleaseTitle.includes("one-punch") && !mediaTitle.includes("punch")) ||
      (rawReleaseTitle.includes("naruto") && !mediaTitle.includes("naruto")) ||
      (rawReleaseTitle.includes("dragon ball") && !mediaTitle.includes("dragon")) ||
      (rawReleaseTitle.includes("jujutsu") && !mediaTitle.includes("jujutsu")) ||
      (rawReleaseTitle.includes("toonshub") && !mediaTitle.includes("cartoon") && !mediaTitle.includes("animated"));

    if (hasEpTag || isAnimeMismatch) {
      badIds.push(m.id);
      if (badSamples.length < 15) {
        badSamples.push({
          id: m.id,
          movie: m.media_title,
          torrent: m.payload?.title || m.magnet_link?.slice(0, 60),
          reason: isAnimeMismatch ? "Anime Mismatch" : "TV Episode attached to Movie",
        });
      }
    }
  }

  console.log(`⚠️ Found ${badIds.length} mismatched / fake movie torrents!`);

  if (badSamples.length > 0) {
    console.log("\n📋 Sample of bad rows being purged:");
    badSamples.forEach((s) => {
      console.log(`   • [ID: ${s.id}] "${s.movie}" -> "${s.torrent}" (${s.reason})`);
    });
    console.log("");
  }

  // Purge in batches of 100
  if (badIds.length > 0) {
    let deletedCount = 0;
    for (let i = 0; i < badIds.length; i += 100) {
      const slice = badIds.slice(i, i + 100);
      const { error } = await supabase.from(MEDIA_SOURCES_TABLE).delete().in("id", slice);
      if (!error) deletedCount += slice.length;
    }
    console.log(`✅ Successfully purged ${deletedCount} mismatched movie rows from Supabase!`);
  } else {
    console.log("✅ No mismatched movie rows found. Database is clean!");
  }

  console.log("\n==================================================================");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

