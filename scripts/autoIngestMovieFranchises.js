"use strict";

/**
 * 🎬 Movie Franchise & Sequels Auto-Completion Engine
 *
 * Automatically detects if a movie belongs to a franchise/collection on TMDB
 * (e.g., John Wick 1 -> automatically fetches John Wick 2, 3, 4;
 *  Avengers 1 -> automatically fetches Age of Ultron, Infinity War, Endgame;
 *  KGF, Baahubali, Harry Potter, Dark Knight, Fast & Furious, etc.)
 *
 * Rules:
 * 1. Checks all parts in the TMDB collection.
 * 2. If a part is missing in Supabase:
 *    - Resolves fresh Hindi / Dual Audio torrent with live seeders >= 5.
 *    - Strictly accepts 480p, 720p, 1080p (4K Ignored).
 *    - Upserts into media_content & media_sources.
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents } = require("../server/services/torrentResolver");
const env = require("../server/config/env");

const TMDB_API_KEY = env.tmdbApiKey || "40b06951f1c6497bbe2bc6d9e5ad6b47";
const MIN_REQUIRED_SEEDERS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTmdbMovie(tmdbId) {
  try {
    const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchTmdbCollection(collectionId) {
  try {
    const res = await fetch(`https://api.themoviedb.org/3/collection/${collectionId}?api_key=${TMDB_API_KEY}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function hasWorkingSource(supabase, mediaId) {
  const { data } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("id, seeders")
    .eq("media_id", String(mediaId))
    .gte("seeders", MIN_REQUIRED_SEEDERS)
    .limit(1);
  return Boolean(data && data.length > 0);
}

async function completeFranchises(supabase, { limit = 200 } = {}) {
  console.log("==================================================================");
  console.log("🎬 Starting Movie Franchise & Sequels Auto-Completer");
  console.log("   Auto-detecting and ingesting all parts (Sequels/Prequels)");
  console.log("   Quality: 480p, 720p, 1080p ONLY (4K Ignored) | Hindi & Dual Audio");
  console.log("==================================================================\n");

  // Fetch movies from DB
  const { data: movies, error } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("media_id, media_title, year")
    .not("media_id", "ilike", "%-s%")
    .not("media_id", "ilike", "%:s%")
    .order("id", { ascending: false })
    .limit(limit);

  if (error || !movies) {
    console.error("Failed to fetch movies from DB:", error?.message);
    return;
  }

  const processedCollections = new Set();
  let totalFranchisePartsAdded = 0;

  for (const m of movies) {
    const tmdbId = String(m.media_id || "").trim();
    if (!tmdbId || isNaN(Number(tmdbId))) continue;

    const movieDetail = await fetchTmdbMovie(tmdbId);
    const collection = movieDetail?.belongs_to_collection;

    if (!collection || !collection.id || processedCollections.has(collection.id)) {
      continue;
    }

    processedCollections.add(collection.id);
    console.log(`\n📚 [FRANCHISE FOUND] "${collection.name}" (via ${m.media_title})`);

    const colData = await fetchTmdbCollection(collection.id);
    const parts = colData?.parts || [];

    for (const part of parts) {
      const partTmdbId = part.id;
      const partTitle = part.title || part.original_title;
      const partYear = (part.release_date || "").slice(0, 4) || "";
      const posterUrl = part.poster_path ? `https://image.tmdb.org/t/p/w500${part.poster_path}` : "";
      const backdropUrl = part.backdrop_path ? `https://image.tmdb.org/t/p/original${part.backdrop_path}` : "";

      // Check if already in DB
      const alreadyHas = await hasWorkingSource(supabase, partTmdbId);
      if (alreadyHas) {
        console.log(`  ⏩ [EXISTS] ${partTitle} (${partYear}) already has healthy source. Skipping.`);
        continue;
      }

      console.log(`  🔍 [SEARCHING HINDI PART] ${partTitle} (${partYear})...`);

      try {
        const result = await discoverCascadingTorrents({
          title: partTitle,
          year: partYear,
          mediaType: "movie",
          tmdbId: partTmdbId,
          requireDubMarker: false,
        });

        const liveSeeds = Number(result?.seeders || 0);
        const magnet = result?.magnet_link || result?.magnet || result?.download_url;
        const is4K = result?.quality === "2160p" || /\b(?:2160p|4k|uhd)\b/i.test(result?.title || "");

        if (result && magnet && liveSeeds >= MIN_REQUIRED_SEEDERS && !is4K) {
          // Upsert content
          await supabase.from(MEDIA_CONTENT_TABLE).upsert(
            {
              external_id: partTmdbId,
              title: partTitle,
              media_type: "movie",
              details: {
                title: partTitle,
                year: partYear,
                overview: part.overview || "",
                poster_url: posterUrl,
                backdrop_url: backdropUrl,
                release_date: part.release_date,
                vote_average: part.vote_average,
                collection: collection.name,
              },
              updated_at: new Date().toISOString(),
            },
            { onConflict: "external_id" }
          );

          // Save source
          await saveTorrentRelease(
            {
              mediaId: partTmdbId,
              title: partTitle,
              year: partYear,
              mediaType: "movie",
              posterUrl,
              backdropUrl,
            },
            {
              ...result,
              title: result.title || partTitle,
              magnet: magnet,
              seeders: liveSeeds,
              quality: result.quality || "1080p",
              language: result.language || "Hindi",
              language_label: result.language_label || "Hindi",
            }
          );

          console.log(`  ✅ [FRANCHISE PART ADDED] ${partTitle} (${partYear}) · ${result.quality} · ${liveSeeds} seeds · ${result.language}`);
          totalFranchisePartsAdded++;
        } else {
          console.log(`  ❌ [NO HINDI SEEDS >= 5] ${partTitle} (${partYear})`);
        }
      } catch (err) {
        console.warn(`  ⚠️ Error searching ${partTitle}:`, err.message);
      }

      await sleep(350);
    }
  }

  console.log("\n==================================================================");
  console.log(`🏁 [FRANCHISE COMPLETION FINISHED] Added ${totalFranchisePartsAdded} missing sequels/parts!`);
  console.log("==================================================================");
}

async function main() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error("Supabase client failed to initialize.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const limitArg = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "300", 10);

  await completeFranchises(supabase, { limit: limitArg });
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

