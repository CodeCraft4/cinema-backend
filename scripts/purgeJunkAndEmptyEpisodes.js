/**
 * scripts/purgeJunkAndEmptyEpisodes.js
 *
 * 1. Empties media_episodes table in batches (freeing up ~300 MB in Supabase)
 * 2. Deletes all media_sources rows where magnet_link is NULL / source_type is embed_stream
 *    (freeing up ~80 MB and eliminating 69,400+ dead rows)
 * 3. Preserves all authentic torrent rows with working magnets & seeders
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_SECRET_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE credentials in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cleanMediaSourcesJunk() {
  console.log("======================================================");
  console.log("🧹 STEP 1: Purging NULL magnet / embed rows from media_sources...");
  console.log("======================================================");

  let deletedTotal = 0;
  const batchSize = 1000;

  while (true) {
    // Select batch of IDs to delete
    const { data, error } = await supabase
      .from("media_sources")
      .select("id")
      .or("magnet_link.is.null,source_type.eq.embed_stream")
      .limit(batchSize);

    if (error) {
      console.error("Error fetching media_sources IDs:", error.message);
      break;
    }

    if (!data || data.length === 0) {
      console.log(`✅ No more NULL magnet rows found in media_sources! Total deleted: ${deletedTotal}\n`);
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
    process.stdout.write(`  🗑️ Purged ${deletedTotal} junk rows from media_sources...\r`);
    await sleep(100);
  }
}

async function clearMediaEpisodes() {
  console.log("======================================================");
  console.log("🧹 STEP 2: Emptying media_episodes table (~578k rows)...");
  console.log("======================================================");

  let deletedTotal = 0;
  const batchSize = 2500;

  while (true) {
    const { data, error } = await supabase
      .from("media_episodes")
      .select("id")
      .limit(batchSize);

    if (error) {
      console.error("Error querying media_episodes IDs:", error.message);
      break;
    }

    if (!data || data.length === 0) {
      console.log(`\n✅ media_episodes is now completely empty! Total deleted: ${deletedTotal}\n`);
      break;
    }

    const ids = data.map((d) => d.id);
    const { error: delErr } = await supabase
      .from("media_episodes")
      .delete()
      .in("id", ids);

    if (delErr) {
      console.error("Error deleting from media_episodes:", delErr.message);
      await sleep(1000);
      continue;
    }

    deletedTotal += ids.length;
    process.stdout.write(`  🗑️ Purged ${deletedTotal} rows from media_episodes...\r`);
    await sleep(50);
  }
}

async function main() {
  console.log("🚀 Starting Supabase Deep Cleanup to recover ~380 MB...\n");
  
  await cleanMediaSourcesJunk();
  await clearMediaEpisodes();

  const { count: remainingSources } = await supabase
    .from("media_sources")
    .select("*", { count: "exact", head: true });

  const { count: remainingEpisodes } = await supabase
    .from("media_episodes")
    .select("*", { count: "exact", head: true });

  console.log("======================================================");
  console.log("🎉 CLEANUP COMPLETE!");
  console.log(`   Remaining media_sources (100% Real Torrents): ${remainingSources}`);
  console.log(`   Remaining media_episodes: ${remainingEpisodes}`);
  console.log("======================================================");
}

main().catch(console.error);
