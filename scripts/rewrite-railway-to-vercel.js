"use strict";

const { getSupabaseClient } = require("../server/services/supabaseClient");

const OLD_URL = "https://cinebroadcast-production.up.railway.app";
const NEW_URL = "https://cinemaapi.vercel.app";
const BATCH_SIZE = 50;

async function run() {
  const supabase = getSupabaseClient();
  console.log(`[Migrate] Starting URL rewrite: ${OLD_URL} -> ${NEW_URL}`);

  let totalUpdated = 0;
  while (true) {
    const { data, error } = await supabase
      .from("media_sources")
      .select("id, download_url, stream_url")
      .ilike("download_url", `%${OLD_URL}%`)
      .limit(BATCH_SIZE);

    if (error) {
      console.error("[Migrate] Error fetching batch:", error.message);
      break;
    }

    if (!data || data.length === 0) {
      console.log(`[Migrate] No more rows with ${OLD_URL} found!`);
      break;
    }

    await Promise.all(
      data.map((row) => {
        const newDl = row.download_url ? row.download_url.replace(OLD_URL, NEW_URL) : row.download_url;
        const newSt = row.stream_url ? row.stream_url.replace(OLD_URL, NEW_URL) : row.stream_url;
        return supabase
          .from("media_sources")
          .update({
            download_url: newDl,
            stream_url: newSt,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      })
    );

    totalUpdated += data.length;
    console.log(`[Migrate] Updated ${totalUpdated} sources...`);
  }

  // Also check if any stream_url still has OLD_URL while download_url didn't
  const { data: streamRows } = await supabase
    .from("media_sources")
    .select("id, download_url, stream_url")
    .ilike("stream_url", `%${OLD_URL}%`)
    .limit(BATCH_SIZE);

  if (streamRows && streamRows.length > 0) {
    await Promise.all(
      streamRows.map((row) => {
        const newSt = row.stream_url ? row.stream_url.replace(OLD_URL, NEW_URL) : row.stream_url;
        return supabase
          .from("media_sources")
          .update({
            stream_url: newSt,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      })
    );
  }

  console.log(`[Migrate] Done! Total sources updated: ${totalUpdated}`);
}

run().catch((err) => {
  console.error("[Migrate] Fatal:", err);
  process.exit(1);
});
