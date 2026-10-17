"use strict";

/**
 * 🇹🇷 Top & Trending Turkish Dramas, Islamic History Series & Movies Deep Ingestion
 * 
 * Covers:
 * - Islamic History & Ottoman Empires (Diriliş: Ertuğrul, Kuruluş Osman, Payitaht Abdülhamid, Yunus Emre, Alparslan, Uyanış, Selahaddin Eyyubi, Mehmed Fetihler Sultanı, Barbaroslar, Destan, etc.)
 * - Famous Lovely Romance & Modern Dramas (Kara Sevda, Sen Çal Kapımı, Aşk Laftan Anlamaz, Erkenci Kuş, Hercai, Yargı, Çukur, İçerde, Yalı Çapkını, Aşk-ı Memnu, etc.)
 * - Blockbuster Turkish Movies (Fetih 1453, Miracle in Cell No. 7, Malazgirt 1071, Deliler, Ayla, Türkler Geliyor, etc.)
 * - Deep Seasons & EVERY SINGLE EPISODE with titles, overviews, still images, runtimes
 * - Persists directly to Supabase `media_content` table
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

// 1. Curated Turkish Series Search Targets (Guaranteed Islamic History & Lovely Romance)
const CURATED_SEARCH_TITLES = [
  // Islamic & Ottoman History
  "Diriliş: Ertuğrul",
  "Kuruluş Osman",
  "Payitaht Abdülhamid",
  "Yunus Emre",
  "Alparslan Büyük Selçuklu",
  "Uyanış Büyük Selçuklu",
  "Kudüs Fatihi Selahaddin Eyyubi",
  "Mehmed: Fetihler Sultanı",
  "Destan",
  "Barbaroslar: Akdeniz'in Kılıcı",
  "Mendirman Jaloliddin",
  "Muhteşem Yüzyıl",
  "Muhteşem Yüzyıl: Kösem",
  "Filinta",
  "Mehmetçik Kut'ül Amare",
  "Aşkın Yolculuğu: Hacı Bayram Veli",
  "Mavera: Hâce Ahmed Yesevî",
  "Seddülbahir 32 Saat",

  // Romance & Drama Blockbusters
  "Kara Sevda",
  "Sen Çal Kapımı",
  "Aşk Laftan Anlamaz",
  "Erkenci Kuş",
  "Hercai",
  "Yargı",
  "Çukur",
  "İçerde",
  "Yalı Çapkını",
  "Kızılcık Şerbeti",
  "Aşk-ı Memnu",
  "Kiralık Aşk",
  "Dolunay",
  "Bay Yanlış",
  "Afili Aşk",
  "Siyah Beyaz Aşk",
  "Kurtlar Vadisi",
  "Teşkilat",
  "Söz",
  "Maraşlı",
  "Kızıl Goncalar",
  "Bahar",
  "Deha",
  "Aile",
  "Gaddar",
  "Şahmaran",
  "The Protector",
  "Terzi",
  "Kuş Uçuşu",
  "Zeytin Ağacı",
  "Bir Zamanlar Çukurova",
  "Fazilet Hanım ve Kızları",
  "Ezel",
  "Kuzey Güney",
  "Fatmagül'ün Suçu Ne?"
];

// 2. Curated Blockbuster Turkish Movies
const CURATED_TURKISH_MOVIES = [
  { id: 89584, name: "Fetih 1453 (Conquest 1453)" },
  { id: 637920, name: "7. Koğuştaki Mucize (Miracle in Cell No. 7)" },
  { id: 540841, name: "Deliler: Fatih'in Fermanı (Vlad the Impaler)" },
  { id: 699395, name: "Malazgirt 1071" },
  { id: 457837, name: "Ayla: The Daughter of War" },
  { id: 526233, name: "Müslüm" },
  { id: 554316, name: "Bizim İçin Şampiyon (Bold Pilot)" },
  { id: 639352, name: "Cep Herkülü: Naim Süleymanoğlu" },
  { id: 504383, name: "Direniş Karatay" },
  { id: 651667, name: "Türkler Geliyor: Adaletin Kılıcı" },
  { id: 423453, name: "Dağ II (The Mountain II)" },
  { id: 29013, name: "Nefes: Vatan Sağolsun" },
  { id: 172922, name: "Kelebeğin Rüyası (The Butterfly's Dream)" },
  { id: 254472, name: "Kış Uykusu (Winter Sleep)" },
  { id: 10757, name: "Babam ve Oğlum (My Father and My Son)" },
  { id: 11655, name: "Eşkıya (The Bandit)" },
  { id: 9426, name: "G.O.R.A." },
];

// Discover verified Turkish series IDs
async function collectTurkishSeriesIds() {
  const discovered = new Set();

  console.log("🔍 Searching verified IDs for famous Islamic history & romance Turkish titles...");
  for (const query of CURATED_SEARCH_TITLES) {
    try {
      const res = await axios.get(`${TMDB_BASE_URL}/search/tv`, {
        params: { api_key: TMDB_API_KEY, query },
        timeout: 10000,
      });
      const match = (res.data?.results || []).find((r) => {
        const origCountry = r.origin_country || [];
        const origLang = r.original_language || "";
        return origCountry.includes("TR") || origLang === "tr";
      });
      if (match && match.id) {
        discovered.add(Number(match.id));
      }
    } catch (_) {}
    await sleep(35);
  }
  console.log(`✅ Verified ${discovered.size} curated Turkish titles.`);

  // Dynamic discovery for trending/popular Turkish series
  console.log("🔍 Fetching trending and popular Turkish scripted series from TMDB...");
  for (let page = 1; page <= 6 && discovered.size < 90; page++) {
    try {
      const res = await axios.get(`${TMDB_BASE_URL}/discover/tv`, {
        params: {
          api_key: TMDB_API_KEY,
          with_origin_country: "TR",
          with_original_language: "tr",
          without_genres: "10764,10767,10763,10402,99",
          sort_by: "popularity.desc",
          page,
        },
        timeout: 10000,
      });

      (res.data?.results || []).forEach((r) => {
        if (r.id) discovered.add(Number(r.id));
      });
    } catch (err) {
      console.warn(`  ⚠️ Discovery page ${page} warning:`, err.message);
    }
    await sleep(50);
  }

  console.log(`✅ Total verified Turkish TV Series to process: ${discovered.size}\n`);
  return Array.from(discovered);
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
      runtime: ep.runtime || 120,
      vote_average: ep.vote_average ? Math.round(Number(ep.vote_average) * 10) / 10 : null,
    }));
  } catch (err) {
    return [];
  }
}

// Fetch complete TV series details with all seasons and individual episodes
async function fetchFullTurkishSeries(tvId) {
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

    // Strict validation: Must be authentic Turkish production
    const origin = data.origin_country || [];
    const origLang = data.original_language || "";
    if (!origin.includes("TR") && origLang !== "tr") {
      return null;
    }

    const title = String(data.name || data.original_name || "Untitled Turkish Drama").trim();
    const firstAirDate = data.first_air_date || "";
    const year = String(firstAirDate).match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
    const posterUrl = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null;
    const backdropUrl = data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null;
    const overview = data.overview || "";
    const rating = data.vote_average != null ? Math.round(Number(data.vote_average) * 10) : null;
    const imdbId = data.external_ids?.imdb_id || null;

    // Filter valid seasons (exclude specials / Season 0)
    const validSeasons = (data.seasons || []).filter((s) => s.season_number > 0);

    const enrichedSeasons = [];
    let totalEpisodesCount = 0;

    for (const s of validSeasons) {
      await sleep(35); // Rate-limit safety
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
        origin_country: ["TR"],
        original_language: "tr",
        genres: data.genres ? data.genres.map((g) => g.name) : [],
        number_of_seasons: enrichedSeasons.length,
        number_of_episodes: totalEpisodesCount || data.number_of_episodes || 0,
        seasons: enrichedSeasons,
        status: data.status || "",
      },
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`  ❌ Error fetching Turkish TV ID ${tvId}:`, err.message);
    return null;
  }
}

// Fetch complete Movie details
async function fetchTurkishMovie(movieId) {
  try {
    const res = await axios.get(`${TMDB_BASE_URL}/movie/${movieId}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: "en-US",
        append_to_response: "external_ids",
      },
      timeout: 10000,
    });

    const data = res.data;
    if (!data || !data.id) return null;

    const title = String(data.title || data.original_title || "Untitled Turkish Movie").trim();
    const releaseDate = data.release_date || "";
    const year = String(releaseDate).match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
    const posterUrl = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null;
    const backdropUrl = data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null;
    const overview = data.overview || "";
    const rating = data.vote_average != null ? Math.round(Number(data.vote_average) * 10) : null;
    const imdbId = data.external_ids?.imdb_id || data.imdb_id || null;

    return {
      external_id: Number(data.id),
      source: "tmdb",
      media_type: "movie",
      title,
      details: {
        provider: "tmdb",
        tmdb_id: Number(data.id),
        imdb_id: imdbId,
        title,
        original_title: data.original_title || title,
        year,
        release_date: releaseDate,
        poster_url: posterUrl,
        backdrop_url: backdropUrl,
        overview,
        description: overview,
        rating_percent: rating,
        vote_average: data.vote_average,
        vote_count: data.vote_count,
        media_type: "movie",
        origin_country: ["TR"],
        original_language: "tr",
        genres: data.genres ? data.genres.map((g) => g.name) : [],
        runtime: data.runtime || 120,
        tagline: data.tagline || "",
      },
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`  ❌ Error fetching Turkish Movie ID ${movieId}:`, err.message);
    return null;
  }
}

async function run() {
  console.log("===============================================================================");
  console.log(" 🇹🇷 Top & Trending Turkish Dramas, Islamic History Series & Movies");
  console.log(" Deep Ingestion: Seasons, Every Episode, Posters & IMDb IDs -> media_content");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();

  // Load existing external_ids from media_content to update or insert
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

  // Collect verified Turkish series IDs
  const allSeriesIds = await collectTurkishSeriesIds();

  let savedSeries = 0;
  let updatedSeries = 0;
  let savedMovies = 0;
  let updatedMovies = 0;
  let errors = 0;

  // 1. Process Turkish Series (With Every Season & Episode)
  console.log(`📺 Ingesting ${allSeriesIds.length} Turkish Dramas & Series...`);
  for (let i = 0; i < allSeriesIds.length; i++) {
    const tvId = allSeriesIds[i];
    const indexStr = String(i + 1).padStart(3, " ");

    const fullSeries = await fetchFullTurkishSeries(tvId);
    if (!fullSeries) {
      errors++;
      continue;
    }

    const { title, details } = fullSeries;
    const existingDbId = existingMap.get(tvId);
    const seasonsCount = details.seasons.length;
    const epsCount = details.number_of_episodes;
    const imdb = details.imdb_id || "N/A";

    if (existingDbId) {
      const { error: updateErr } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .update({ title, details, updated_at: new Date().toISOString() })
        .eq("id", existingDbId);

      if (updateErr) {
        console.warn(`  [${indexStr}/${allSeriesIds.length}] ⚠️ Update failed for "${title}":`, updateErr.message);
        errors++;
      } else {
        updatedSeries++;
        console.log(`  [${indexStr}/${allSeriesIds.length}] 🔄 Updated: "${title}" (${details.year}) | IMDb: ${imdb} | S:${seasonsCount} E:${epsCount}`);
      }
    } else {
      const { error: insertErr } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .insert({ ...fullSeries, created_at: new Date().toISOString() });

      if (insertErr) {
        console.warn(`  [${indexStr}/${allSeriesIds.length}] ⚠️ Insert failed for "${title}":`, insertErr.message);
        errors++;
      } else {
        savedSeries++;
        console.log(`  [${indexStr}/${allSeriesIds.length}] ➕ Added:   "${title}" (${details.year}) | IMDb: ${imdb} | S:${seasonsCount} E:${epsCount}`);
      }
    }
  }

  // 2. Process Turkish Blockbuster Movies
  console.log(`\n🎬 Ingesting ${CURATED_TURKISH_MOVIES.length} Turkish Blockbuster & Historical Movies...`);
  for (let j = 0; j < CURATED_TURKISH_MOVIES.length; j++) {
    const movieObj = CURATED_TURKISH_MOVIES[j];
    const movieId = movieObj.id;
    const indexStr = String(j + 1).padStart(2, " ");

    const movieRow = await fetchTurkishMovie(movieId);
    if (!movieRow) {
      errors++;
      continue;
    }

    const { title, details } = movieRow;
    const existingDbId = existingMap.get(movieId);
    const imdb = details.imdb_id || "N/A";

    if (existingDbId) {
      const { error: updateErr } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .update({ title, details, updated_at: new Date().toISOString() })
        .eq("id", existingDbId);

      if (updateErr) {
        errors++;
      } else {
        updatedMovies++;
        console.log(`  [${indexStr}/${CURATED_TURKISH_MOVIES.length}] 🔄 Updated Movie: "${title}" (${details.year}) | IMDb: ${imdb}`);
      }
    } else {
      const { error: insertErr } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .insert({ ...movieRow, created_at: new Date().toISOString() });

      if (insertErr) {
        errors++;
      } else {
        savedMovies++;
        console.log(`  [${indexStr}/${CURATED_TURKISH_MOVIES.length}] ➕ Added Movie:   "${title}" (${details.year}) | IMDb: ${imdb}`);
      }
    }
    await sleep(40);
  }

  console.log("\n===============================================================================");
  console.log(" 🎉 Turkish Series & Movies Ingestion Completed!");
  console.log(` 📺 Turkish Series Processed : ${savedSeries + updatedSeries} (${savedSeries} new, ${updatedSeries} updated)`);
  console.log(` 🎬 Turkish Movies Processed : ${savedMovies + updatedMovies} (${savedMovies} new, ${updatedMovies} updated)`);
  console.log(` ❌ Errors / Skipped         : ${errors}`);
  console.log("===============================================================================");
  console.log("\n👉 Agla Step (Torrent Finding):");
  console.log("   Ab aap 'npm run find:turkish' ya 'npm run find:hindi' run karein Urdu/Hindi/Dual streams find karne ke liye!");
  console.log("   Command: npm run find:turkish\n");
}

run().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
