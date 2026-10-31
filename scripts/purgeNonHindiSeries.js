/**
 * scripts/purgeNonHindiSeries.js
 *
 * Removes all series episodes from media_sources that are NOT Hindi or Dual Audio.
 * Keeps all Pure Hindi and Dual Audio (Hindi+Eng / Original+Hindi) intact!
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_SECRET_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing Supabase credentials in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function purgeNonHindiSeries() {
  console.log("======================================================");
  console.log("🧹 PURGING NON-HINDI / ENGLISH-ONLY / KOREAN-ONLY SERIES...");
  console.log("   STRICTLY KEEPING: Hindi, Dual Audio [Hindi+Eng], Original+Hindi");
  console.log("======================================================");

  let deletedTotal = 0;
  const batchSize = 1000;

  while (true) {
    // Select batch of IDs that are TV series but have NO Hindi and NO Dual Audio
    const { data, error } = await supabase
      .from("media_sources")
      .select("id")
      .like("media_id", "%-s%e%")
      .not("language", "ilike", "%hindi%")
      .not("language", "ilike", "%dual%")
      .limit(batchSize);

    if (error) {
      console.error("Error fetching non-Hindi series IDs:", error.message);
      break;
    }

    if (!data || data.length === 0) {
      console.log(`\n✅ No more non-Hindi series found! Total purged: ${deletedTotal}\n`);
      break;
    }

    const ids = data.map((d) => d.id);
    const { error: delErr } = await supabase
      .from("media_sources")
      .delete()
      .in("id", ids);

    if (delErr) {
      console.error("Error deleting batch:", delErr.message);
      await sleep(1000);
      continue;
    }

    deletedTotal += ids.length;
    process.stdout.write(`  🗑️ Purged ${deletedTotal} non-Hindi series episodes...\r`);
    await sleep(50);
  }

  const { count: remainingSeries } = await supabase
    .from("media_sources")
    .select("*", { count: "exact", head: true })
    .like("media_id", "%-s%e%");

  console.log("======================================================");
  console.log(`🎉 PURGE COMPLETE!`);
  console.log(`   Remaining 100% Hindi & Dual Audio Series Episodes: ${remainingSeries}`);
  console.log("======================================================\n");
}

purgeNonHindiSeries().catch(console.error);

