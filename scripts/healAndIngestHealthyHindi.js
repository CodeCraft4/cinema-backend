"use strict";

/**
 * ⚡ Heal & Ingest Healthy Hindi/Dual-Audio Torrents Engine
 *
 * Capabilities:
 * 1. Heal & Purge:
 *    - Scans existing DB torrents
 *    - Checks if cached on Torbox (instant 1Gbps)
 *    - If dead (0 seeds & uncached): re-resolves fresh Hindi magnet with >= 5 seeders
 *    - If no healthy magnet exists on internet: deletes the dead row from DB
 * 2. Ingest Top Hits:
 *    - Fetches top trending Hollywood, Bollywood, and South Indian hits from TMDB
 *    - Finds high-health Hindi / Dual Audio torrents with live seeders (>= 5)
 *    - Saves clean metadata and working sources to Supabase
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents } = require("../server/services/torrentResolver");
const torboxService = require("../server/services/torboxService");
const env = require("../server/config/env");

const TMDB_API_KEY = env.tmdbApiKey || "40b06951f1c6497bbe2bc6d9e5ad6b47";
const MIN_REQUIRED_SEEDERS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch top movies from TMDB by language filter
 */
async function fetchTmdbDiscover({ language = "hi", page = 1 } = {}) {
  try {
    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_original_language=${encodeURIComponent(
      language
    )}&sort_by=popularity.desc&page=${page}&vote_count.gte=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    return json.results || [];
  } catch (err) {
    console.warn(`[TMDB] Discover failed for lang=${language}:`, err.message);
    return [];
  }
}

/**
 * Check if a movie already has an active source in DB
 */
async function hasWorkingSource(supabase, mediaId) {
  const { data } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("id, seeders")
    .eq("media_id", String(mediaId))
    .limit(1);
  return Boolean(data && data.length > 0);
}

/**
 * Ingest fresh top movies from TMDB with live healthy Hindi torrents
 */
async function ingestTopMovies(supabase, { category, lang, pages = 2 } = {}) {
  console.log(`\n======================================================`);
  console.log(`🌟 [INGEST] Starting Ingestion for ${category} (Pages: 1 to ${pages})...`);
  console.log(`======================================================`);

  let addedCount = 0;
  let skippedCount = 0;

  for (let page = 1; page <= pages; page++) {
    console.log(`\n📄 Fetching ${category} Page ${page}...`);
    const movies = await fetchTmdbDiscover({ language: lang, page });

    for (const movie of movies) {
      const tmdbId = movie.id;
      const title = movie.title || movie.original_title;
      const year = (movie.release_date || "").slice(0, 4) || "";
      const overview = movie.overview || "";
      const posterUrl = movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : "";
      const backdropUrl = movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : "";

      // Check if already in DB
      const alreadyHas = await hasWorkingSource(supabase, tmdbId);
      if (alreadyHas) {
        console.log(`  ⏩ [EXISTS] ${title} (${year}) already in DB. Skipping.`);
        skippedCount++;
        continue;
      }

      console.log(`  🔍 [SEARCHING] ${title} (${year}) for healthy Hindi torrents...`);

      try {
        const result = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "movie",
          tmdbId,
          requireDubMarker: lang !== "hi", // Bollywood movies don't need "dubbed" marker
        });

        if (result && result.magnet && (result.seeders || 0) >= MIN_REQUIRED_SEEDERS) {
          // Upsert into media_content first
          await supabase.from(MEDIA_CONTENT_TABLE).upsert(
            {
              external_id: tmdbId,
              title,
              media_type: "movie",
              details: {
                title,
                year,
                overview,
                poster_url: posterUrl,
                backdrop_url: backdropUrl,
                release_date: movie.release_date,
                vote_average: movie.vote_average,
                industry: category,
              },
              updated_at: new Date().toISOString(),
            },
            { onConflict: "external_id" }
          );

          // Save into media_sources
          await saveTorrentRelease(
            {
              mediaId: tmdbId,
              title,
              year,
              mediaType: "movie",
              posterUrl,
              backdropUrl,
            },
            {
              ...result,
              title: result.title || title,
              magnet: result.magnet,
              seeders: result.seeders,
              quality: result.quality || "1080p",
              language: result.language || "Hindi",
              language_label: result.language_label || "Hindi",
            }
          );

          console.log(`  ✅ [SAVED] ${title} (${year}) · ${result.quality} · ${result.seeders} seeds · ${result.language}`);
          addedCount++;
        } else {
          console.log(`  ❌ [NO LIVE SEEDERS] ${title} (${year}) - seeders below ${MIN_REQUIRED_SEEDERS}.`);
        }
      } catch (err) {
        console.warn(`  ⚠️ Error searching ${title}:`, err.message);
      }

      await sleep(600); // Friendly rate limit
    }
  }

  console.log(`\n🎉 [${category} FINISHED] Added: ${addedCount} new healthy movies | Skipped: ${skippedCount}`);
}

/**
 * Heal or Purge dead torrents from existing DB
 */
/**
 * Exhaustive Purge & Heal Engine:
 * Batches through the database, scans lowest-seeder items,
 * heals with fresh Hindi magnets if available, or permanently purges dead rows.
 */
async function healAndPurgeAllDeadTorrents(supabase, { batchSize = 40, maxTotal = 15000 } = {}) {
  console.log(`\n======================================================`);
  console.log(`🩺 [EXHAUSTIVE DB CLEANER] Continuous Purge & Heal Engine`);
  console.log(`   Target: All dead/stale torrents in media_sources`);
  console.log(`======================================================\n`);

  let totalProcessed = 0;
  let totalHealed = 0;
  let totalPurged = 0;
  let totalHealthy = 0;
  let batchNum = 1;

  while (totalProcessed < maxTotal) {
    // Query media sources with lowest seeders first
    const { data: rows, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, year, quality, language, magnet_link, download_url, seeders")
      .not("magnet_link", "is", null)
      .order("seeders", { ascending: true })
      .limit(batchSize);

    if (error) {
      console.error(`[DB ERROR] Batch ${batchNum} fetch failed:`, error.message);
      await sleep(3000);
      continue;
    }

    if (!rows || rows.length === 0) {
      console.log(`✅ [COMPLETE] No more rows with low seeders found in media_sources.`);
      break;
    }

    const minSeeds = Number(rows[0]?.seeders || 0);
    const maxSeeds = Number(rows[rows.length - 1]?.seeders || 0);

    // If lowest seeders are already >= 15 and we've processed batches, database is healthy
    if (minSeeds >= 15 && totalProcessed > 50) {
      console.log(`🎉 [DATABASE HEALTHY] All remaining rows have >= ${minSeeds} seeds! Database is fully clean.`);
      break;
    }

    console.log(`\n📦 [BATCH ${batchNum}] Fetched ${rows.length} rows (Seeders range: ${minSeeds} to ${maxSeeds})...`);
    const batchDeadIds = [];

    for (const row of rows) {
      totalProcessed++;
      const magnet = row.magnet_link || row.download_url;
      const title = row.media_title || "Unknown";
      const year = row.year || "";
      const currentSeeders = Number(row.seeders || 0);
      const infoHash = torboxService.extractInfoHash(magnet);

      // 1. Check if cached on TorBox
      let isCached = false;
      if (infoHash) {
        try {
          isCached = await torboxService.checkCached(infoHash);
        } catch {}
      }

      if (isCached) {
        console.log(`  🟢 [HEALTHY / TORBOX CACHED] ${title} (${year}) - 1Gbps Ready. Keeping.`);
        totalHealthy++;
        if (currentSeeders < 50) {
          // Promote seeder score to 99 so it moves out of low-seeder queue
          await supabase
            .from(MEDIA_SOURCES_TABLE)
            .update({ seeders: 99, status: "ready", updated_at: new Date().toISOString() })
            .eq("id", row.id);
        }
        continue;
      }

      // 2. Check live indexers for fresh healthy torrent
      console.log(`  🔎 [VERIFYING] ${title} (${year}) - DB seeds: ${currentSeeders}. Checking live indexers...`);
      let healed = false;

      try {
        const fresh = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "movie",
          requireDubMarker: false,
        });

        if (fresh && fresh.magnet && (fresh.seeders || 0) >= MIN_REQUIRED_SEEDERS) {
          await supabase
            .from(MEDIA_SOURCES_TABLE)
            .update({
              magnet_link: fresh.magnet,
              download_url: fresh.magnet,
              stream_url: `http://168.144.249.68:4555/api/media/stream/torrent/${fresh.infoHash || infoHash}/video.mp4`,
              seeders: fresh.seeders,
              quality: fresh.quality || row.quality,
              size_human: fresh.size_human || row.size_human,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);

          console.log(`  ✨ [HEALED] ${title} updated with fresh magnet (${fresh.seeders} live seeders).`);
          totalHealed++;
          healed = true;
        }
      } catch (e) {
        console.warn(`  ⚠️ Search error for ${title}:`, e.message);
      }

      // 3. If no working torrent exists and seeders are dead/stale, collect for batch purge
      if (!healed && currentSeeders <= 3 && !isCached) {
        console.log(`  🗑️ [MARKED DEAD] ${title} (${year}) - no seeds (DB had ${currentSeeders}). Will purge in batch.`);
        batchDeadIds.push(row.id);
        totalPurged++;
      } else if (!healed && currentSeeders > 3 && !isCached) {
        console.log(`  ⚠️ [NO FRESH TORRENT] ${title} (${year}) kept with existing ${currentSeeders} seeds.`);
      }

      await sleep(300);
    }

    // Execute single batch delete for all dead rows in this batch to minimize Supabase Log Ingestion
    if (batchDeadIds.length > 0) {
      console.log(`  🔥 [BATCH PURGE] Purging ${batchDeadIds.length} dead rows in single Supabase request...`);
      const { error: delErr } = await supabase.from(MEDIA_SOURCES_TABLE).delete().in("id", batchDeadIds);
      if (delErr) {
        console.warn(`  ⚠️ Batch purge error:`, delErr.message);
      }
    }

    console.log(`\n📊 [PROGRESS BATCH ${batchNum}] Total Processed: ${totalProcessed} | Purged: ${totalPurged} | Healed: ${totalHealed} | Cached/Healthy: ${totalHealthy}`);
    batchNum++;
    await sleep(500);
  }

  console.log(`\n🏁 [EXHAUSTIVE CLEAN COMPLETE]`);
  console.log(`   • Total Rows Processed: ${totalProcessed}`);
  console.log(`   • Purged Dead Rows: ${totalPurged}`);
  console.log(`   • Healed with Fresh Magnet: ${totalHealed}`);
  console.log(`   • Verified TorBox Healthy: ${totalHealthy}`);
}

async function main() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error("Supabase client failed to initialize.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const doHealAll = args.includes("--heal-all");
  const doHeal = args.includes("--heal") || doHealAll || args.length === 0;
  const doIngest = args.includes("--ingest");

  console.log("🚀 Starting Heal & Ingest Healthy Hindi Engine...");

  // 1. Ingest Top Hollywood Blockbusters (Hindi Dubbed)
  if (doIngest) {
    await ingestTopMovies(supabase, { category: "Hollywood Hindi Dubbed", lang: "en", pages: 3 });
    await ingestTopMovies(supabase, { category: "Bollywood Top Hits", lang: "hi", pages: 3 });
    await ingestTopMovies(supabase, { category: "South Indian Hindi Dubbed", lang: "te", pages: 2 });
  }

  // 2. Heal existing rows & purge dead torrents
  if (doHealAll) {
    await healAndPurgeAllDeadTorrents(supabase, { batchSize: 40, maxTotal: 15000 });
  } else if (doHeal) {
    await healAndPurgeAllDeadTorrents(supabase, { batchSize: 40, maxTotal: 120 });
  }

  console.log("\n✨ All operations finished successfully!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
