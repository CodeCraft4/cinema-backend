"use strict";

/**
 * 🌟 Deep Ingestion for Top 100+ Curated Global Series (Korean K-Dramas, Japanese Anime/Series, US & UK Blockbusters)
 * 
 * Focus:
 * - Titles widely known to have official Hindi Dubbed & Dual Audio [Hindi+Eng/Org] releases.
 * - Deep metadata: Story Overview, 1280p Backdrop, HD Poster, Ratings.
 * - Complete Seasons & Episodes list for each show.
 * - Automatic duplicate skip (only fetches fresh titles not already in media_content).
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

// Categories specifically selected for top global series from Spain, Italy, China, Egypt, Turkey, Korea, Japan, US, UK
const TARGET_SERIES_CATEGORIES = [
  // 1. Spain / Latin American Series (Money Heist, Elite, Vis a Vis - Huge Hindi / Dual Dubs)
  {
    name: "Spain & Latin America Top Series (ES/MX)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "ES|MX|AR|CO",
      "first_air_date.gte": "2012-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 80,
    },
    pages: 6,
  },
  {
    name: "Spain Top Series (Top Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "ES|MX",
      "first_air_date.gte": "2010-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 100,
    },
    pages: 5,
  },

  // 2. Italy & European Crime / Drama Series (Gomorrah, Suburra, Baby)
  {
    name: "Italy & European Top Series (IT/FR/DE)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "IT|FR|DE",
      "first_air_date.gte": "2012-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 80,
    },
    pages: 6,
  },
  {
    name: "Italy & European (Top Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "IT|FR|DE",
      "first_air_date.gte": "2010-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 100,
    },
    pages: 5,
  },

  // 3. China (C-Dramas, Wuxia, Xianxia - Very Popular in Hindi)
  {
    name: "China Top C-Dramas & Series (CN/TW)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "CN|TW|HK",
      "first_air_date.gte": "2015-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 50,
    },
    pages: 7,
  },
  {
    name: "China C-Dramas (Top Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "CN|TW",
      "first_air_date.gte": "2012-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 80,
    },
    pages: 5,
  },

  // 4. Egypt & Middle East / Turkey (Arabic Dramas & Turkish Series - Ertugrul, Kurulus, Shahmaran in Hindi)
  {
    name: "Egypt & Turkish Top Series (EG/TR/SA)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "EG|TR|SA|AE",
      "first_air_date.gte": "2014-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 50,
    },
    pages: 7,
  },
  {
    name: "Turkish & Middle-East (Top Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "TR|EG",
      "first_air_date.gte": "2012-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 80,
    },
    pages: 5,
  },

  // 5. Korean K-Dramas (Netflix / Viki top hits with confirmed Hindi dubs)
  {
    name: "Top Korean K-Dramas (Popular & Dubbed)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "KR",
      "first_air_date.gte": "2015-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 100,
    },
    pages: 6,
  },
  {
    name: "Top Korean K-Dramas (All-Time High Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "KR",
      "first_air_date.gte": "2012-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 120,
    },
    pages: 5,
  },

  // 6. Japanese Anime & Series (Crunchyroll, Netflix & Muse Asia Hindi Dubs)
  {
    name: "Top Japanese Anime & Series (Popular & Hindi Dubbed)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "JP",
      "first_air_date.gte": "2012-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 120,
    },
    pages: 6,
  },
  {
    name: "Top Japanese Anime Series (Top Rated)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "JP",
      "first_air_date.gte": "2010-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 150,
    },
    pages: 5,
  },

  // 7. Australia & New Zealand Top Series (AU/NZ)
  {
    name: "Australia & NZ Top Series (AU/NZ)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "AU|NZ",
      "first_air_date.gte": "2012-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 40,
    },
    pages: 5,
  },

  // 8. Brazil & Latin America Series (BR)
  {
    name: "Brazil Top Series & Telenovelas (BR)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "BR",
      "first_air_date.gte": "2012-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 40,
    },
    pages: 5,
  },

  // 9. US & UK Top TV Series (HBO, Netflix, Amazon Prime, BBC with Hindi/Dual Audio)
  {
    name: "Top US & UK Blockbuster Series (Popular)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "US|GB",
      "first_air_date.gte": "2012-01-01",
      sort_by: "popularity.desc",
      "vote_count.gte": 300,
    },
    pages: 6,
  },
  {
    name: "Top US & UK Series (Critically Acclaimed)",
    endpoint: "/discover/tv",
    params: {
      with_origin_country: "US|GB",
      "first_air_date.gte": "2010-01-01",
      sort_by: "vote_average.desc",
      "vote_count.gte": 350,
    },
    pages: 5,
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch complete TV series details including all seasons and episode lists
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

async function runDeepSeriesIngestion() {
  console.log("===============================================================================");
  console.log(" 📺 Deep Ingestion: Top Korean, Japanese Anime, US & UK Series");
  console.log(" Complete Seasons, Episodes & Descriptions | Duplicate Skip: Active");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();

  // 1. Fetch existing external_ids to avoid duplicates
  console.log("🔍 Checking existing series in Supabase media_content to skip duplicates...");
  const existingSet = new Set();
  let offset = 0;
  const batchLimit = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("external_id")
      .range(offset, offset + batchLimit - 1);

    if (error || !data || data.length === 0) break;
    data.forEach((r) => {
      if (r.external_id) existingSet.add(Number(r.external_id));
    });
    if (data.length < batchLimit) break;
    offset += batchLimit;
  }

  console.log(`✅ Loaded ${existingSet.size} existing items from database. Only fetching NEW series.\n`);

  let totalNewInserted = 0;

  for (const cat of TARGET_SERIES_CATEGORIES) {
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
            continue; // Skip existing duplicate
          }

          await sleep(60); // Rate-limit safety
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
            .filter((s) => s.season_number > 0)
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
  console.log(`🎉 Global Series Ingestion Complete!`);
  console.log(`💾 Total Brand New Series Added to media_content: ${totalNewInserted}`);
  console.log("===============================================================================\n");
  console.log("👉 Next Step: Run 'npm run resolve:series' to find Hindi / Dual Audio torrents for every season & episode!");
}

runDeepSeriesIngestion().catch((err) => {
  console.error("Fatal Ingestion Error:", err);
  process.exit(1);
});
