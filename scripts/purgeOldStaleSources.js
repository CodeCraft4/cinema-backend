"use strict";

const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");

async function purgeOldStaleSources() {
  console.log("🧹 Purging old dead sources from Supabase media_sources (created before today)...");
  const supabase = getSupabaseClient();

  let totalDeleted = 0;
  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id")
      .lt("created_at", "2026-10-17T00:00:00Z")
      .limit(200);

    if (error) {
      console.error("❌ Error querying old sources:", error.message);
      break;
    }

    if (!data || data.length === 0) {
      break;
    }

    const ids = data.map((r) => r.id);
    const { error: delErr } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .delete()
      .in("id", ids);

    if (delErr) {
      console.error("❌ Error deleting batch:", delErr.message);
      break;
    }

    totalDeleted += ids.length;
    process.stdout.write(`\r🗑️ Deleted ${totalDeleted} stale sources...`);
  }

  console.log(`\n✅ Finished! Total stale sources deleted: ${totalDeleted}`);

  const { count } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("*", { count: "exact", head: true });

  console.log(`📊 Remaining fresh verified sources in media_sources: ${count}`);
}

purgeOldStaleSources().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
