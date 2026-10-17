"use strict";

const { getSupabaseClient } = require("../server/services/supabaseClient");

async function clearTableInBatches(supabase, tableName) {
  console.log(`\n🧹 Cleaning table "${tableName}"...`);
  let totalDeleted = 0;
  while (true) {
    const { data, error } = await supabase
      .from(tableName)
      .select("id")
      .limit(500);

    if (error) {
      console.error(`❌ Error querying ${tableName}:`, error.message);
      break;
    }

    if (!data || data.length === 0) break;

    const ids = data.map((r) => r.id);
    const { error: delErr } = await supabase
      .from(tableName)
      .delete()
      .in("id", ids);

    if (delErr) {
      console.error(`❌ Error deleting batch from ${tableName}:`, delErr.message);
      break;
    }

    totalDeleted += ids.length;
    process.stdout.write(`\r🗑️ Deleted ${totalDeleted} rows from ${tableName}...`);
  }
  console.log(`\n✅ "${tableName}" cleared. (Total deleted: ${totalDeleted})`);
}

async function main() {
  console.log("===============================================================================");
  console.log(" 🧹 Clean Database For Fresh Master Ingestion");
  console.log(" 🔒 Profiles & App Versions are 100% PROTECTED");
  console.log("===============================================================================");

  const supabase = getSupabaseClient();

  // 1. Delete media_sources
  await clearTableInBatches(supabase, "media_sources");

  // 2. Delete media_episodes
  await clearTableInBatches(supabase, "media_episodes");

  // 3. Delete media_content
  await clearTableInBatches(supabase, "media_content");

  // Verify
  const { count: mc } = await supabase.from("media_content").select("*", { count: "exact", head: true });
  const { count: me } = await supabase.from("media_episodes").select("*", { count: "exact", head: true });
  const { count: ms } = await supabase.from("media_sources").select("*", { count: "exact", head: true });
  const { count: prof } = await supabase.from("profiles").select("*", { count: "exact", head: true });
  const { count: vers } = await supabase.from("app_versions").select("*", { count: "exact", head: true });

  console.log("\n===============================================================================");
  console.log(" 📊 Final Database Status:");
  console.log(` - media_sources:  ${ms} (Fresh & Empty)`);
  console.log(` - media_episodes: ${me} (Fresh & Empty)`);
  console.log(` - media_content:  ${mc} (Fresh & Empty)`);
  console.log(` - profiles:       ${prof} (SAFE & PRESERVED)`);
  console.log(` - app_versions:   ${vers} (SAFE & PRESERVED)`);
  console.log("===============================================================================\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
