"use strict";

/**
 * 🧹 Purge Non-Hindi / English-only Records from Supabase media_sources
 */

const { getSupabaseClient } = require("../server/services/supabaseClient");

async function purgeNonHindiSources() {
  console.log("===============================================================================");
  console.log(" 🧹 Purging English-Only & Non-Hindi/Dual Sources from media_sources");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  let offset = 0;
  const toDeleteIds = [];

  while (true) {
    const { data, error } = await supabase
      .from("media_sources")
      .select("id, media_title, language")
      .range(offset, offset + 999);

    if (error || !data || data.length === 0) break;

    data.forEach((r) => {
      const l = String(r.language || "").trim().toLowerCase();
      const isEnglish = l === "english" || l === "en" || l === "original" || l === "all";
      const hasDub = l.includes("hindi") || l.includes("urdu") || l.includes("dual") || l.includes("turkish");

      if (isEnglish && !hasDub) {
        toDeleteIds.push({ id: r.id, title: r.media_title, lang: r.language });
      }
    });

    if (data.length < 1000) break;
    offset += 1000;
  }

  console.log(`Found ${toDeleteIds.length} English / non-dubbed rows to purge.`);

  if (toDeleteIds.length === 0) {
    console.log("✅ Zero English sources found! Database is already 100% clean Hindi/Dual/Urdu.");
    return;
  }

  // Delete in batches of 50
  let deletedCount = 0;
  for (let i = 0; i < toDeleteIds.length; i += 50) {
    const batch = toDeleteIds.slice(i, i + 50);
    const ids = batch.map((b) => b.id);
    const { error } = await supabase.from("media_sources").delete().in("id", ids);

    if (error) {
      console.error("❌ Failed to delete batch:", error.message);
    } else {
      deletedCount += ids.length;
      batch.forEach((b) => console.log(`🗑️ Deleted [${b.id}] "${b.title}" (${b.lang})`));
    }
  }

  console.log(`\n===============================================================================`);
  console.log(`🎉 Successfully Purged ${deletedCount} English-only records from media_sources!`);
  console.log(`===============================================================================\n`);
}

purgeNonHindiSources().catch((err) => {
  console.error("Fatal Error:", err.message);
  process.exit(1);
});
