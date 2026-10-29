"use strict";

/**
 * 🌍 Global Top Hindi Cinema Ingest & Dead-Purge Engine
 *
 * Targets Top & Trending Cinema (Last 3 Years: 2023 - 2026):
 * - 🇮🇳 Bollywood (Hindi)
 * - 🇺🇸 Hollywood (Hindi Dubbed / Dual Audio)
 * - 🇮🇳 South Indian (Tollywood, Kollywood, Mollywood Hindi Dubbed)
 * - 🇰🇷 Korean Cinema & K-Dramas (Hindi Dubbed / Dual Audio)
 * - 🇹🇷 Turkish Cinema & Drama (Urdu / Hindi Dubbed)
 * - 🇯🇵 Japanese Anime & Cinema (Hindi Dubbed / Dual Audio)
 * - 🇨🇳 Chinese Martial Arts & Cinema (Hindi Dubbed)
 * - 🇪🇸 Spanish Thrillers & Cinema (Hindi Dubbed)
 *
 * Strict Rules:
 * 1. ZERO 0-SEEDERS: Only torrents with >= 5 live seeders on internet are saved.
 * 2. 480p, 720p, 1080p ONLY: Ignores 4K / 2160p to prevent mobile buffering and quota drain.
 * 3. AUTO-PURGE DEAD: If an existing DB movie has 0 seeds and no fresh magnet exists, it is permanently removed from Supabase.
 * 4. SKIP HEALTHY: If already in Supabase with live healthy seeds, skip to save bandwidth.
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents } = require("../server/services/torrentResolver");
const torboxService = require("../server/services/torboxService");
const env = require("../server/config/env");

const TMDB_API_KEY = env.tmdbApiKey || "40b06951f1c6497bbe2bc6d9e5ad6b47";
const DEFAULT_MIN_SEEDERS = 5;
const START_YEAR = "2023-01-01";
const END_YEAR = "2026-12-31";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const INDUSTRIES = [
  { key: "bollywood", name: "Bollywood Top Hits (2023-2026)", lang: "hi", voteMin: 15, requireDubMarker: false },
  { key: "hollywood", name: "Hollywood Hindi Dubbed (2023-2026)", lang: "en", voteMin: 50, requireDubMarker: true },
  { key: "south_indian", name: "South Indian Pan-India Hindi (2023-2026)", lang: "te", voteMin: 30, requireDubMarker: true },
  { key: "korean", name: "Korean K-Cinema Hindi Dubbed (2023-2026)", lang: "ko", voteMin: 25, requireDubMarker: true },
  { key: "turkish", name: "Turkish Hindi/Urdu Dubbed (2023-2026)", lang: "tr", voteMin: 20, requireDubMarker: true },
  { key: "japanese", name: "Japanese Anime/Cinema Hindi (2023-2026)", lang: "ja", voteMin: 30, requireDubMarker: true },
  { key: "chinese", name: "Chinese Martial Arts Hindi (2023-2026)", lang: "zh", voteMin: 20, requireDubMarker: true },
  { key: "spanish", name: "Spanish Thrillers Hindi Dubbed (2023-2026)", lang: "es", voteMin: 25, requireDubMarker: true },
];

/**
 * Fetch top movies from TMDB for a specific language and date window
 */
async function fetchTmdbIndustry({ lang, page = 1, voteMin = 20 } = {}) {
  try {
    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_original_language=${encodeURIComponent(
      lang
    )}&primary_release_date.gte=${START_YEAR}&primary_release_date.lte=${END_YEAR}&sort_by=popularity.desc&page=${page}&vote_count.gte=${voteMin}`;
    
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) return [];
    const json = await res.json();
    return json.results || [];
  } catch (err) {
    console.warn(`[TMDB] Discover failed for lang=${lang} page=${page}:`, err.message);
    return [];
  }
}

/**
 * Inspect existing sources in Supabase for this movie
 */
async function checkExistingSource(supabase, mediaId) {
  const { data } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("id, seeders, magnet_link, download_url, quality, language")
    .eq("media_id", String(mediaId))
    .limit(3);
  return data || [];
}

/**
 * Ingest or Heal one industry
 */
async function processIndustry(supabase, industry, { pages = 2, minSeeders = DEFAULT_MIN_SEEDERS } = {}) {
  console.log(`\n======================================================`);
  console.log(`🌟 [INDUSTRY] ${industry.name} | Pages 1 to ${pages}`);
  console.log(`   Filter: Released ${START_YEAR.slice(0, 4)}-${END_YEAR.slice(0, 4)} | Min Live Seeds: ${minSeeders}`);
  console.log(`======================================================`);

  let addedCount = 0;
  let skippedHealthyCount = 0;
  let healedCount = 0;
  let purgedDeadCount = 0;

  for (let page = 1; page <= pages; page++) {
    console.log(`\n📄 [PAGE ${page}/${pages}] Fetching ${industry.name}...`);
    const movies = await fetchTmdbIndustry({ lang: industry.lang, page, voteMin: industry.voteMin });

    if (!movies || movies.length === 0) {
      console.log(`  ℹ️ No more movies found on page ${page}.`);
      break;
    }

    for (const movie of movies) {
      const tmdbId = movie.id;
      const title = movie.title || movie.original_title;
      const year = (movie.release_date || "").slice(0, 4) || "";
      const overview = movie.overview || "";
      const posterUrl = movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : "";
      const backdropUrl = movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : "";

      // Step 1: Check existing status in DB
      const existing = await checkExistingSource(supabase, tmdbId);
      const healthyExisting = existing.find((s) => Number(s.seeders || 0) >= minSeeders);

      if (healthyExisting) {
        console.log(`  ⏩ [EXISTS & HEALTHY] ${title} (${year}) - Seeds: ${healthyExisting.seeders}. Skipping.`);
        skippedHealthyCount++;
        continue;
      }

      // If it exists in DB but seeders are dead (<= 3), we need to heal or purge it!
      const deadRows = existing.filter((s) => Number(s.seeders || 0) <= 3);

      console.log(`  🔍 [SEARCHING HINDI] ${title} (${year}) · [${industry.key.toUpperCase()}]...`);

      try {
        const result = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "movie",
          tmdbId,
          requireDubMarker: industry.requireDubMarker,
        });

        const liveSeeds = Number(result?.seeders || 0);
        const magnet = result?.magnet_link || result?.magnet || result?.download_url;
        const is4K = result?.quality === "2160p" || /\b(?:2160p|4k|uhd)\b/i.test(result?.title || "");

        // Only accept if seeds >= minSeeders AND NOT 4K (480p, 720p, 1080p only)
        if (result && magnet && liveSeeds >= minSeeders && !is4K) {
          // Healthy torrent found with >= minSeeders!
          // Upsert content
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
                industry: industry.name,
              },
              updated_at: new Date().toISOString(),
            },
            { onConflict: "external_id" }
          );

          // Save fresh torrent release
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
              magnet: magnet,
              seeders: liveSeeds,
              quality: result.quality || "1080p",
              language: result.language || "Hindi",
              language_label: result.language_label || "Hindi",
            }
          );

          console.log(`  ✅ [INGESTED] ${title} (${year}) · ${result.quality || "1080p"} · ${liveSeeds} seeds · ${result.language}`);
          if (deadRows.length > 0) healedCount++;
          else addedCount++;
        } else {
          // No healthy Hindi torrent found on internet
          if (deadRows.length > 0) {
            // Purge dead rows from Supabase
            const deadIds = deadRows.map((r) => r.id);
            await supabase.from(MEDIA_SOURCES_TABLE).delete().in("id", deadIds);
            console.log(`  🗑️ [PURGED DEAD ROW] ${title} (${year}) has 0 live working seeds. Removed from DB.`);
            purgedDeadCount += deadIds.length;
          } else {
            console.log(`  ❌ [SKIPPED - NO HINDI SEEDS >= ${minSeeders}] ${title} (${year})`);
          }
        }
      } catch (err) {
        console.warn(`  ⚠️ Error processing ${title}:`, err.message);
      }

      await sleep(400); // Friendly rate limit
    }
  }

  console.log(`\n📊 [SUMMARY - ${industry.name}]`);
  console.log(`   • Fresh Ingested: ${addedCount}`);
  console.log(`   • Existing Healthy Skipped: ${skippedHealthyCount}`);
  console.log(`   • Healed with Fresh Magnet: ${healedCount}`);
  console.log(`   • Purged Dead (0 seeds): ${purgedDeadCount}`);

  return { addedCount, skippedHealthyCount, healedCount, purgedDeadCount };
}

async function main() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error("Supabase client failed to initialize.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const industryArg = args.find((a) => a.startsWith("--industry="))?.split("=")[1]?.toLowerCase() || "all";
  const pagesArg = parseInt(args.find((a) => a.startsWith("--pages="))?.split("=")[1] || "2", 10);
  const minSeedsArg = parseInt(args.find((a) => a.startsWith("--min-seeds="))?.split("=")[1] || String(DEFAULT_MIN_SEEDERS), 10);

  console.log("==================================================================");
  console.log("🚀 Starting Global Top Hindi Cinema Ingest & Dead-Purge Engine");
  console.log(`   Filter: Released ${START_YEAR.slice(0, 4)} - ${END_YEAR.slice(0, 4)}`);
  console.log(`   Qualities Accepted: 480p, 720p, 1080p (4K Ignored)`);
  console.log(`   Pages per Category: ${pagesArg} | Min Required Live Seeds: ${minSeedsArg}`);
  console.log(`   Target Industry: ${industryArg.toUpperCase()}`);
  console.log("==================================================================");

  let targetList = INDUSTRIES;
  if (industryArg !== "all") {
    targetList = INDUSTRIES.filter((i) => i.key === industryArg || i.key.includes(industryArg));
    if (targetList.length === 0) {
      console.error(`Invalid industry "${industryArg}". Available: all, bollywood, hollywood, south_indian, korean, turkish, japanese, chinese, spanish`);
      process.exit(1);
    }
  }

  const totals = { added: 0, skipped: 0, healed: 0, purged: 0 };

  for (const ind of targetList) {
    const stats = await processIndustry(supabase, ind, { pages: pagesArg, minSeeders: minSeedsArg });
    totals.added += stats.addedCount;
    totals.skipped += stats.skippedHealthyCount;
    totals.healed += stats.healedCount;
    totals.purged += stats.purgedDeadCount;
  }

  console.log("\n==================================================================");
  console.log("🏁 [GLOBAL INGESTION & PURGE COMPLETE]");
  console.log(`   • Total Fresh Movies Added: ${totals.added}`);
  console.log(`   • Total Dead Rows Purged from Supabase: ${totals.purged}`);
  console.log(`   • Total Movies Healed: ${totals.healed}`);
  console.log(`   • Total Healthy Kept/Skipped: ${totals.skipped}`);
  console.log("==================================================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error in global ingest engine:", err);
  process.exit(1);
});
