"use strict";

/**
 * 🧹 Clean Duplicates in `media_sources`
 *
 * Rules:
 * 1. If a movie/episode has DIFFERENT qualities (e.g. 1080p, 720p, 480p) -> KEEP THEM (Multi-quality).
 * 2. If a movie/episode has the SAME quality duplicated (e.g. two 1080p rows) -> KEEP BEST (highest seeds), DELETE OTHERS.
 */

require("dotenv").config();
const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");

async function main() {
  const sb = getSupabaseClient();
  console.log("==================================================================");
  console.log("🧹 [DEDUPLICATION ENGINE: media_sources]");
  console.log("   Rule: Keep multi-quality (1080p/720p/480p), purge same-quality duplicates.");
  console.log("==================================================================\n");

  let lastSeenId = 0;
  const groups = new Map();
  let totalRows = 0;

  console.log("🔍 Scanning all rows in media_sources...");
  while (true) {
    const { data: rows, error } = await sb
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, quality, seeders, updated_at, magnet_link")
      .gt("id", lastSeenId)
      .order("id", { ascending: true })
      .limit(1000);

    if (error) {
      console.error("DB error:", error.message);
      break;
    }
    if (!rows || rows.length === 0) break;

    lastSeenId = rows[rows.length - 1].id;
    totalRows += rows.length;

    for (const r of rows) {
      const mid = String(r.media_id || "").toLowerCase().trim();
      const q = String(r.quality || "auto").toLowerCase().replace(/[^a-z0-9]/g, "");
      const key = `${mid}::${q}`;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
  }

  console.log(`📊 Total rows scanned: ${totalRows}`);

  const idsToDelete = [];
  let duplicateGroupsCount = 0;

  for (const [key, list] of groups.entries()) {
    if (list.length > 1) {
      duplicateGroupsCount++;

      // Sort descending: highest seeders first, then newest updated_at, then highest ID
      list.sort((a, b) => {
        const seedA = Number(a.seeders || 0);
        const seedB = Number(b.seeders || 0);
        if (seedB !== seedA) return seedB - seedA;
        return Number(b.id) - Number(a.id);
      });

      const best = list[0];
      const duplicates = list.slice(1);

      console.log(`\n📌 [DUPLICATE FOUND] "${best.media_title}" (${key}):`);
      console.log(`   ✅ KEEPING: [ID ${best.id}] ${best.quality} · ${best.seeders} seeds`);
      for (const dup of duplicates) {
        console.log(`   ❌ DELETING: [ID ${dup.id}] ${dup.quality} · ${dup.seeders} seeds`);
        idsToDelete.push(dup.id);
      }
    }
  }

  console.log(`\n📊 Total Duplicate Groups: ${duplicateGroupsCount}`);
  console.log(`🗑️ Total Duplicate Rows to Delete: ${idsToDelete.length}`);

  if (idsToDelete.length > 0) {
    console.log(`\nDeleting ${idsToDelete.length} duplicate rows in chunks of 50...`);
    for (let i = 0; i < idsToDelete.length; i += 50) {
      const chunk = idsToDelete.slice(i, i + 50);
      const { error: delErr } = await sb.from(MEDIA_SOURCES_TABLE).delete().in("id", chunk);
      if (delErr) {
        console.error("Chunk deletion error:", delErr.message);
      }
    }
    console.log(`✅ Successfully deleted ${idsToDelete.length} duplicates from media_sources!`);
  } else {
    console.log("✨ Zero duplicates found! Database is already clean.");
  }

  console.log("\n==================================================================");
  console.log("🏁 [DEDUPLICATION COMPLETED]");
  console.log("==================================================================");
}

main().catch(console.error);
