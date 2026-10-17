"use strict";

/**
 * Cleanup script to remove pure English / Non-Hindi media sources from Supabase.
 * Keeps only sources that contain Hindi, Dual Audio, Multi Audio, or Hindi Dubbed audio.
 */

const { getSupabaseClient } = require("../server/services/supabaseClient");

async function cleanupNonHindi() {
  const supabase = getSupabaseClient();
  console.log("🔍 Scanning media_sources table for non-Hindi entries...");

  let allRows = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("media_sources")
      .select("id, media_id, media_title, language, magnet_link, payload, cache_key")
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error("❌ Error fetching media_sources:", error);
      process.exit(1);
    }
    allRows.push(...data);
    if (data.length < pageSize) break;
    page++;
  }

  console.log(`📊 Total media_sources found in DB: ${allRows.length}`);

  const toDeleteIds = [];
  const keptRows = [];

  allRows.forEach((row) => {
    const lang = (row.language || "").toLowerCase();
    const cacheKey = (row.cache_key || "").toLowerCase();
    const payloadTitle = (row.payload?.title || "").toLowerCase();
    const magnet = (row.magnet_link || "").toLowerCase();
    const payloadLang = (row.payload?.language_label || "").toLowerCase();

    const textToSearch = [lang, cacheKey, payloadTitle, magnet, payloadLang].join(" ");

    const isHindi =
      textToSearch.includes("hindi") ||
      textToSearch.includes("hin") ||
      textToSearch.includes("dual") ||
      textToSearch.includes("multi") ||
      textToSearch.includes("dub");

    if (!isHindi) {
      toDeleteIds.push(row.id);
    } else {
      keptRows.push(row);
    }
  });

  console.log(`✅ Kept (Hindi / Dual Audio): ${keptRows.length}`);
  console.log(`🗑️ Marked for deletion (Pure English / Non-Hindi): ${toDeleteIds.length}`);

  if (toDeleteIds.length === 0) {
    console.log("🎉 No non-Hindi rows found to delete!");
    return;
  }

  // Batch delete in chunks of 100
  const batchSize = 100;
  let deletedCount = 0;

  for (let i = 0; i < toDeleteIds.length; i += batchSize) {
    const chunk = toDeleteIds.slice(i, i + batchSize);
    const { error: delError } = await supabase
      .from("media_sources")
      .delete()
      .in("id", chunk);

    if (delError) {
      console.error(`❌ Error deleting chunk starting at index ${i}:`, delError);
    } else {
      deletedCount += chunk.length;
      console.log(`  Progress: Deleted ${deletedCount} / ${toDeleteIds.length} non-Hindi sources`);
    }
  }

  console.log(`\n🎉 Success! Removed ${deletedCount} pure English entries from media_sources.`);

  // Verify final count
  const { count: finalCount } = await supabase
    .from("media_sources")
    .select("id", { count: "exact", head: true });

  console.log(`📌 Final media_sources count in DB: ${finalCount}`);
}

cleanupNonHindi().catch(console.error);
