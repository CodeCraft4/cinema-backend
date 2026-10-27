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
async function healAndPurgeDeadTorrents(supabase, { maxRows = 200 } = {}) {
  console.log(`\n======================================================`);
  console.log(`🩺 [HEAL & PURGE] Scanning up to ${maxRows} rows in media_sources...`);
  console.log(`======================================================`);

  // Query media sources with lowest seeders first
  const { data: rows, error } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("id, media_id, media_title, year, quality, language, magnet_link, download_url, seeders")
    .not("magnet_link", "is", null)
    .order("seeders", { ascending: true })
    .limit(maxRows);

  if (error || !rows || rows.length === 0) {
    console.log("No rows found to inspect.");
    return;
  }

  console.log(`Fetched ${rows.length} rows for health verification.`);
  let healthyKept = 0;
  let healedCount = 0;
  let purgedCount = 0;

  for (const row of rows) {
    const magnet = row.magnet_link || row.download_url;
    const title = row.media_title || "Unknown";
    const year = row.year || "";
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
      healthyKept++;
      continue;
    }

    // 2. If seeders reported as 0 or 1, verify if healthy or dead
    const currentSeeders = Number(row.seeders || 0);

    // If it's potentially stale/dead, attempt re-resolution
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
        // Update DB row with healthy fresh torrent
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
        healedCount++;
        healed = true;
      }
    } catch (e) {
      console.warn(`  ⚠️ Search error for ${title}:`, e.message);
    }

    // 3. If no working torrent exists and seeders are dead/stale, PURGE from database
    if (!healed && currentSeeders <= 3 && !isCached) {
      console.log(`  🗑️ [PURGING DEAD ROW] ${title} (${year}) has 0 working seeds on internet (DB had ${currentSeeders}). Removing from DB.`);
      await supabase.from(MEDIA_SOURCES_TABLE).delete().eq("id", row.id);
      purgedCount++;
    }

    await sleep(400);
  }

  console.log(`\n🏁 [HEAL & PURGE COMPLETE]`);
  console.log(`   • Kept Healthy/Cached: ${healthyKept}`);
  console.log(`   • Healed with Fresh Magnet: ${healedCount}`);
  console.log(`   • Purged Dead (0 seeds): ${purgedCount}`);
}

async function main() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error("Supabase client failed to initialize.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const doHeal = args.includes("--heal") || args.length === 0;
  const doIngest = args.includes("--ingest") || args.length === 0;

  console.log("🚀 Starting Heal & Ingest Healthy Hindi Engine...");

  // 1. Ingest Top Hollywood Blockbusters (Hindi Dubbed)
  if (doIngest) {
    await ingestTopMovies(supabase, { category: "Hollywood Hindi Dubbed", lang: "en", pages: 2 });
    await ingestTopMovies(supabase, { category: "Bollywood Top Hits", lang: "hi", pages: 2 });
    await ingestTopMovies(supabase, { category: "South Indian Hindi Dubbed", lang: "te", pages: 1 });
  }

  // 2. Heal existing rows & purge 0-seeder dead torrents
  if (doHeal) {
    await healAndPurgeDeadTorrents(supabase, { maxRows: 150 });
  }

  console.log("\n✨ All operations finished successfully!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
