"use strict";

/**
 * 🇰🇷 Top 100 Korean Drama Series & TV Shows Deep Ingestion
 * 
 * Purpose:
 * - Fetches Top 100 Most Popular & Highly-Rated Korean Dramas (K-Dramas) from TMDB
 * - Guaranteed 100% Authentic Korean Productions (origin_country: "KR", language: "ko")
 * - Enriches with full IMDb IDs (for immediate Torrentio & indexer matching)
 * - Deeply fetches EVERY SEASON & EVERY INDIVIDUAL EPISODE with titles, runtimes, stills, and summaries
 * - Upserts directly into Supabase `media_content` table
 */

const axios = require("axios");
const env = require("../server/config/env");
const { getSupabaseClient, MEDIA_CONTENT_TABLE } = require("../server/services/supabaseClient");

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_API_KEY = env.tmdbApiKey || process.env.TMDB_API_KEY;

if (!TMDB_API_KEY) {
  console.error("❌ ERROR: TMDB_API_KEY is not defined in your .env file!");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Discover 100 authentic, top-rated and popular Korean Dramas from TMDB
async function discover100Kdramas() {
  console.log("🔍 Discovering Top 100 Popular & Acclaimed Korean Dramas from TMDB...");
  const list = [];
  const seen = new Set();
  let page = 1;

  while (list.length < 100 && page <= 25) {
    try {
      const res = await axios.get(`${TMDB_BASE_URL}/discover/tv`, {
        params: {
          api_key: TMDB_API_KEY,
          with_origin_country: "KR",
          with_original_language: "ko",
          without_genres: "10764,10767,10763,10402,99", // Exclude Reality, Talk, News, Music, Docs
          "vote_count.gte": 40,
          sort_by: "popularity.desc",
          page,
        },
        timeout: 10000,
      });

      const results = res.data?.results || [];
      for (const r of results) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          list.push({
            id: r.id,
            name: r.name,
            original_name: r.original_name,
            first_air_date: r.first_air_date,
            vote_count: r.vote_count,
            vote_average: r.vote_average,
          });
          if (list.length >= 100) break;
        }
      }
    } catch (err) {
      console.warn(`  ⚠️ Discovery page ${page} warning:`, err.message);
    }
    page++;
    await sleep(60);
  }

  console.log(`✅ Collected exactly ${list.length} Top Korean Dramas to ingest with all episodes!\n`);
  return list;
}

// Fetch single season episodes from TMDB
async function fetchSeasonEpisodes(tvId, seasonNumber) {
  try {
    const res = await axios.get(`${TMDB_BASE_URL}/tv/${tvId}/season/${seasonNumber}`, {
      params: { api_key: TMDB_API_KEY, language: "en-US" },
      timeout: 10000,
    });
    const episodes = res.data?.episodes || [];
    return episodes.map((ep) => ({
      episode_number: ep.episode_number,
      season_number: ep.season_number,
      name: ep.name || `Episode ${ep.episode_number}`,
      overview: ep.overview || "",
      air_date: ep.air_date || "",
      still_url: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
      runtime: ep.runtime || 60,
      vote_average: ep.vote_average ? Math.round(Number(ep.vote_average) * 10) / 10 : null,
    }));
  } catch (err) {
    return [];
  }
}

// Fetch complete series details including all seasons and episodes
async function fetchFullKoreanSeries(tvId) {
  try {
    const res = await axios.get(`${TMDB_BASE_URL}/tv/${tvId}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: "en-US",
        append_to_response: "external_ids",
      },
      timeout: 10000,
    });

    const data = res.data;
    if (!data || !data.id) return null;

    const title = String(data.name || data.original_name || "Untitled K-Drama").trim();
    const firstAirDate = data.first_air_date || "";
    const year = String(firstAirDate).match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
    const posterUrl = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null;
    const backdropUrl = data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null;
    const overview = data.overview || "";
    const rating = data.vote_average != null ? Math.round(Number(data.vote_average) * 10) : null;
    const imdbId = data.external_ids?.imdb_id || null;

    // Filter valid seasons (exclude specials / Season 0)
    const validSeasons = (data.seasons || []).filter((s) => s.season_number > 0);

    // Fetch every episode for every season
    const enrichedSeasons = [];
    let totalEpisodesCount = 0;

    for (const s of validSeasons) {
      await sleep(40); // Prevent rate limit
      const episodesList = await fetchSeasonEpisodes(tvId, s.season_number);
      totalEpisodesCount += episodesList.length;

      enrichedSeasons.push({
        season_number: s.season_number,
        name: s.name || `Season ${s.season_number}`,
        episode_count: episodesList.length || s.episode_count || 0,
        air_date: s.air_date || "",
        poster_url: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null,
        overview: s.overview || "",
        episodes: episodesList,
      });
    }

    return {
      external_id: Number(data.id),
      source: "tmdb",
      media_type: "series",
      title,
      details: {
        provider: "tmdb",
        tmdb_id: Number(data.id),
        imdb_id: imdbId,
        title,
        original_title: data.original_name || title,
        year,
        release_date: firstAirDate,
        first_air_date: firstAirDate,
        poster_url: posterUrl,
        backdrop_url: backdropUrl,
        overview,
        description: overview,
        rating_percent: rating,
        vote_average: data.vote_average,
        vote_count: data.vote_count,
        media_type: "series",
        origin_country: ["KR"],
        original_language: "ko",
        genres: data.genres ? data.genres.map((g) => g.name) : [],
        number_of_seasons: enrichedSeasons.length,
        number_of_episodes: totalEpisodesCount || data.number_of_episodes || 0,
        seasons: enrichedSeasons,
        status: data.status || "",
      },
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`  ❌ Error fetching series TV ID ${tvId}:`, err.message);
    return null;
  }
}

async function run() {
  console.log("===============================================================================");
  console.log(" 🇰🇷 Top 100 Korean Series & TV Shows Ingestion (With Every Episode)");
  console.log(" Storing deep seasons & episode lists into Supabase media_content");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  const kdramas = await discover100Kdramas();

  // Load existing external_ids from media_content
  console.log("🔍 Checking existing titles in media_content...");
  const existingMap = new Map();
  let offset = 0;
  const batchLimit = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, external_id, title")
      .range(offset, offset + batchLimit - 1);

    if (error || !data || data.length === 0) break;
    data.forEach((r) => {
      if (r.external_id) existingMap.set(Number(r.external_id), r.id);
    });
    if (data.length < batchLimit) break;
    offset += batchLimit;
  }
  console.log(`✅ Database currently has ${existingMap.size} titles.\n`);

  let savedCount = 0;
  let updatedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < kdramas.length; i++) {
    const item = kdramas[i];
    const tvId = item.id;
    const indexStr = String(i + 1).padStart(3, " ");

    const fullSeries = await fetchFullKoreanSeries(tvId);
    if (!fullSeries) {
      errorCount++;
      continue;
    }

    const { title, details } = fullSeries;
    const existingDbId = existingMap.get(tvId);
    const seasonsCount = details.seasons.length;
    const epsCount = details.number_of_episodes;
    const imdb = details.imdb_id || "N/A";

    if (existingDbId) {
      // Update existing record so it has full episodes list & imdb_id
      const { error: updateErr } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .update({
          title,
          details,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingDbId);

      if (updateErr) {
        console.warn(`  [${indexStr}/100] ⚠️ Update failed for "${title}":`, updateErr.message);
        errorCount++;
      } else {
        updatedCount++;
        console.log(`  [${indexStr}/100] 🔄 Updated: "${title}" (${details.year}) | IMDb: ${imdb} | S:${seasonsCount} E:${epsCount}`);
      }
    } else {
      // Insert brand new record
      const { error: insertErr } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .insert({
          ...fullSeries,
          created_at: new Date().toISOString(),
        });

      if (insertErr) {
        console.warn(`  [${indexStr}/100] ⚠️ Insert failed for "${title}":`, insertErr.message);
        errorCount++;
      } else {
        savedCount++;
        console.log(`  [${indexStr}/100] ➕ Added:   "${title}" (${details.year}) | IMDb: ${imdb} | S:${seasonsCount} E:${epsCount}`);
      }
    }
  }

  console.log("\n===============================================================================");
  console.log(" 🎉 Top 100 Korean Series Ingestion Completed!");
  console.log(` ➕ Newly Added Series  : ${savedCount}`);
  console.log(` 🔄 Enriched / Updated  : ${updatedCount}`);
  console.log(` ❌ Errors / Skipped    : ${errorCount}`);
  console.log(` 📺 Total Series in DB  : ${savedCount + updatedCount} / 100`);
  console.log("===============================================================================");
  console.log("\n👉 Agla Step:");
  console.log("   Ab aap 'npm run find:hindi' chala sakte hain Hindi/Dual Audio dubs find karne ke liye!");
  console.log("   Commands:");
  console.log("     npm run find:hindi     (Ultra-fast Hindi finder for all missing titles)");
  console.log("     npm run resolve:series (Detailed season & episode Hindi streams)\n");
}

run().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
