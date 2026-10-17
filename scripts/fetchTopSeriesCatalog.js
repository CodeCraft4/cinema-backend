
"use strict";

/**
 * Fetch Top Series (Korean K-Dramas, Japanese Anime/Live-Action, Hollywood)
 * Covers the last 15 years (2011 - 2026), popular & top rated series.
 * Extracts:
 *  - Series Info (TMDB ID, Title, Overview, Poster, 1280p Backdrop, Rating, First Air Date)
 *  - Complete Seasons & Episodes list (Season numbers, episode counts, names, air dates)
 *  - Skips duplicates already existing in Supabase media_content
 */

const axios = require("axios");
const env = require("../server/config/env");
const { getSupabaseClient, MEDIA_CONTENT_TABLE } = require("../server/services/supabaseClient");

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_API_KEY = env.tmdbApiKey;

if (!TMDB_API_KEY) {
  console.error("❌ ERROR: TMDB_API_KEY is not defined in your .env file!");
  process.exit(1);
}

// Target categories for the last 15 years (2011-2026)
const SERIES_CATEGORIES = [
  // 1. Korean K-Dramas (Most popular & highly rated with Hindi dubs available everywhere)
  {
    name: "Korean Top K-Dramas (Popular)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "KR",
      "first_air_date.gte": "2011-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 100,
    },
    pages: 12, // Deep scan ~240 series
  },
  {
    name: "Korean Top K-Dramas (Top Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "KR",
      "first_air_date.gte": "2011-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 80,
    },
    pages: 10, // Deep scan ~200 series
  },

  // 2. Japanese Anime & Drama Series (Famous Shonen, Isekai, Seinen with Hindi/Dual Audio)
  {
    name: "Japanese Anime & Live-Action Series (Popular)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "JP",
      "first_air_date.gte": "2011-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 80,
    },
    pages: 12, // Deep scan ~240 series
  },
  {
    name: "Japanese Top Anime Series (Top Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "JP",
      "first_air_date.gte": "2011-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 100,
    },
    pages: 10, // Deep scan ~200 series
  },

  // 3. Hollywood & International Top Series (HBO, Netflix, Disney+, Prime with Hindi/Dual dubs)
  {
    name: "Hollywood Top TV Series (Popular)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "US|GB",
      "first_air_date.gte": "2011-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 150,
    },
    pages: 12, // Deep scan ~240 series
  },
  {
    name: "Hollywood Top TV Series (Top Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "US|GB",
      "first_air_date.gte": "2011-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 250,
    },
    pages: 10, // Deep scan ~200 series
  }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch detailed TV series info including seasons and episodes
async function fetchSeriesDetailWithSeasons(tvId) {
  try {
    const res = await axios.get(`${TMDB_BASE_URL}/tv/${tvId}`, {
      params: { api_key: TMDB_API_KEY, language: "en-US" },
      timeout: 8000,
    });
    return res.data;
  } catch (err) {
    return null;
  }
}

async function runSeriesIngestion() {
  console.log("===============================================================================");
  console.log(" 📺 TMDB Top Series (Korean K-Drama, Japanese Anime, Hollywood) [2011 - 2026]");
  console.log(" Complete Seasons, Episodes & Descriptions | Duplicate Prevention Active");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();

  // 1. Fetch all existing external_ids from media_content to avoid duplicates
  console.log("🔍 Checking existing titles in Supabase media_content to skip duplicates...");
  const existingSet = new Set();
  let offset = 0;
  const batchLimit = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("external_id")
      .range(offset, offset + batchLimit - 1);

    if (error) {
      console.warn("⚠️ Could not pre-fetch external_ids, fallback to insert check:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    data.forEach((r) => {
      if (r.external_id) existingSet.add(Number(r.external_id));
    });
    if (data.length < batchLimit) break;
    offset += batchLimit;
  }

  console.log(`✅ Loaded ${existingSet.size} existing items from database. Only fetching NEW titles.\n`);

  let totalNewInserted = 0;

  for (const cat of SERIES_CATEGORIES) {
    console.log(`⏳ Fetching: ${cat.name} (${cat.pages} pages)...`);
    let catCount = 0;

    for (let p = 1; p <= cat.pages; p++) {
      try {
        const res = await axios.get(`${TMDB_BASE_URL}${cat.endpoint}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: "en-US",
            page: p,
            ...cat.params,
          },
          timeout: 10000,
        });

        const results = res.data?.results || [];
        for (const item of results) {
          const tmdbId = Number(item.id);
          if (!tmdbId || existingSet.has(tmdbId)) {
            continue; // Skip duplicate
          }

          // Fetch deep seasons detail from TMDB
          await sleep(50); // slight rate-limit prevention
          const details = await fetchSeriesDetailWithSeasons(tmdbId);
          const title = String(item.name || item.original_name || "Untitled Series").slice(0, 255);
          const firstAirDate = item.first_air_date || "";
          const year = String(firstAirDate).match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
          const posterPath = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
          const backdropPath = item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null;
          const overview = item.overview || details?.overview || "";
          const rating = item.vote_average != null ? Math.round(Number(item.vote_average) * 100) / 10 : null;

          // Format seasons & episodes summary
          const rawSeasons = details?.seasons || [];
          const seasonsList = rawSeasons
            .filter((s) => s.season_number > 0) // exclude specials / Season 0
            .map((s) => ({
              season_number: s.season_number,
              name: s.name,
              episode_count: s.episode_count,
              air_date: s.air_date,
              poster_url: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null,
              overview: s.overview || "",
            }));

          const totalEpisodes = details?.number_of_episodes || seasonsList.reduce((acc, s) => acc + (s.episode_count || 0), 0);
          const totalSeasons = details?.number_of_seasons || seasonsList.length;

          const row = {
            external_id: tmdbId,
            source: "tmdb",
            media_type: "series",
            title,
            details: {
              provider: "tmdb",
              tmdb_id: tmdbId,
              title,
              original_title: item.original_name || title,
              year,
              release_date: firstAirDate,
              first_air_date: firstAirDate,
              poster_url: posterPath,
              backdrop_url: backdropPath,
              overview,
              description: overview,
              rating_percent: rating,
              vote_average: item.vote_average,
              vote_count: item.vote_count,
              media_type: "series",
              number_of_seasons: totalSeasons,
              number_of_episodes: totalEpisodes,
              seasons: seasonsList,
              origin_country: item.origin_country || details?.origin_country || [],
              genres: details?.genres ? details.genres.map((g) => g.name) : (item.genre_ids || []),
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          const { error: insertErr } = await supabase
            .from(MEDIA_CONTENT_TABLE)
            .insert(row);

          if (!insertErr) {
            existingSet.add(tmdbId);
            totalNewInserted++;
            catCount++;
            process.stdout.write(`  [+] "${title}" (${year}) - S:${totalSeasons} E:${totalEpisodes}\n`);
          }
        }
      } catch (err) {
        console.error(`  ❌ Error fetching page ${p} for ${cat.name}:`, err.message);
      }
    }
    console.log(`✅ Saved ${catCount} new series for "${cat.name}"\n`);
  }

  console.log("===============================================================================");
  console.log(`🎉 Series Ingestion Complete!`);
  console.log(`💾 Total Brand New Series Added to media_content: ${totalNewInserted}`);
  console.log("===============================================================================\n");
  console.log("👉 Next Step: Run 'npm run enrich' to search and attach Hindi / Dual Audio torrents!");
}

runSeriesIngestion().catch((err) => {
  console.error("Fatal Ingestion Error:", err);
  process.exit(1);
});
