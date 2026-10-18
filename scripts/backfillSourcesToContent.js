"use strict";

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");

async function backfill() {
  console.log("🚀 Starting backfill from media_sources into media_content...");
  const supabase = getSupabaseClient();
  let from = 0;
  const limit = 1000;
  let totalInserted = 0;
  const processedIds = new Set();

  while (true) {
    const { data: rows, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("media_id, media_title, year, payload")
      .range(from, from + limit - 1);

    if (error) {
      console.error("Error reading sources:", error.message);
      break;
    }
    if (!rows || rows.length === 0) break;

    const contentBatch = [];
    for (const r of rows) {
      const extId = parseInt(r.media_id, 10);
      if (!extId || isNaN(extId) || processedIds.has(extId)) continue;
      processedIds.add(extId);

      const payload = r.payload || {};
      const posterUrl = payload.poster_url || "";
      const backdropUrl = payload.backdrop_url || "";
      const posterPath = posterUrl.replace("https://image.tmdb.org/t/p/w500", "");
      const backdropPath = backdropUrl.replace("https://image.tmdb.org/t/p/w1280", "");

      contentBatch.push({
        external_id: extId,
        source: "tmdb",
        media_type: "movie",
        title: r.media_title,
        details: {
          id: extId,
          title: r.media_title,
          year: r.year,
          overview: payload.overview || "",
          poster_path: posterPath,
          poster_url: posterUrl,
          backdrop_path: backdropPath,
          backdrop_url: backdropUrl,
          vote_average: payload.rating || 7.0,
        },
        updated_at: new Date().toISOString(),
      });
    }

    if (contentBatch.length > 0) {
      // Chunk inserts of 100
      for (let i = 0; i < contentBatch.length; i += 100) {
        const chunk = contentBatch.slice(i, i + 100);
        const { error: insErr } = await supabase
          .from(MEDIA_CONTENT_TABLE)
          .upsert(chunk, { onConflict: "source,media_type,external_id" });

        if (insErr) {
          console.warn("Insert error:", insErr.message);
        } else {
          totalInserted += chunk.length;
        }
      }
    }

    console.log(`  Processed range ${from} - ${from + rows.length} (Total content: ${totalInserted})`);
    if (rows.length < limit) break;
    from += limit;
  }

  console.log(`✅ Backfill complete! Total movies added to media_content: ${totalInserted}`);
}

backfill().then(() => process.exit(0)).catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
