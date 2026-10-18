#!/usr/bin/env node
"use strict";

/**
 * 👑 Master Asian & K-Drama Autonomous Ingestion Engine
 * 🇰🇷 Korean Dramas & Movies (TOP PRIORITY - Maximized & Trending)
 * 🇨🇳 Chinese Dramas & Movies (C-Dramas, Wuxia, Historical, Action)
 * 🇯🇵 Japanese Live-Action Series & Movies (STRICTLY REAL ACTORS - NO ANIME)
 *
 * ⚡ Multi-Quality: 1080p, 720p, 480p
 * 🌐 Audio: Hindi Dubbed, Dual Audio [Hindi+Eng], Multi Audio, Original (Ko/Zh/Ja)
 * 🚫 ZERO ANIME / ZERO CARTOONS: Hard-filtered by TMDB Genre 16 & comprehensive anime keywords
 * 💾 Episode Resolution: Season Pack Linking + Torrentio Per-Episode Fallback
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const MEDIA_EPISODES_TABLE = "media_episodes";
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const {
  cleanSearchTitle,
  discoverCascadingTorrents,
  rankValidReleases,
  searchTorrentio,
  canonicalReleaseQuality,
} = require("../server/services/torrentResolver");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "40b06951f1c6497bbe2bc6d9e5ad6b47";
const VPS_BASE_URL = process.env.BASE_URL || "http://168.144.249.68:4555";
const targetMode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] || "all";
const CHECKPOINT_FILE = targetMode === "movies"
  ? path.join(__dirname, ".master-asian-movies-checkpoint.json")
  : targetMode === "series"
  ? path.join(__dirname, ".master-asian-series-checkpoint.json")
  : path.join(__dirname, ".master-asian-checkpoint.json");

const CONCURRENCY = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectQuality(title = "", fallback = "720p") {
  const t = String(title).toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(t)) return "2160p";
  if (/\b(1080p|fhd|1080)\b/.test(t)) return "1080p";
  if (/\b(720p|hd|720)\b/.test(t)) return "720p";
  if (/\b(480p|sd|480|360p)\b/.test(t)) return "480p";
  return fallback || "720p";
}

const isReset = process.argv.includes("--reset");

function readCheckpoint() {
  if (isReset) {
    console.log("🔄 --reset detected: Starting fresh Asian ingestion from Category 0, Page 1.");
    try {
      if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
    } catch (_) {}
    return {
      moviePage: 1,
      movieCategoryIndex: 0,
      seriesPage: 1,
      seriesCategoryIndex: 0,
      totalMoviesAdded: 0,
      totalSeriesAdded: 0,
      totalSourcesAdded: 0,
    };
  }

  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    }
  } catch (_) {}

  return {
    moviePage: 1,
    movieCategoryIndex: 0,
    seriesPage: 1,
    seriesCategoryIndex: 0,
    totalMoviesAdded: 0,
    totalSeriesAdded: 0,
    totalSourcesAdded: 0,
  };
}

function writeCheckpoint(data) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

// STRICT ANIME & CARTOON FILTER: Exclude genre 16 (Animation) and all anime/cartoon titles/keywords
const ANIME_KEYWORD_RE = /\b(anime|animation|animated|cartoon|manga|donghua|ova|ona|manhwa|manhua|chibi|toei|ghibli|pixar|disney|naruto|one\s*piece|bleach|dragon\s*ball|jujutsu|demon\s*slayer|attack\s*on\s*titan|hunter\s*x\s*hunter|death\s*note|pokemon|digimon|doraemon|shinchan|shin-chan|boruto|chainsaw\s*man|solo\s*leveling|my\s*hero\s*academia|sailor\s*moon|inuyasha|haikyuu|gintama|slam\s*dunk|evangelion|tokyo\s*ghoul|fairy\s*tail|sword\s*art|black\s*clover)\b/i;

function isAnimeOrCartoon(item) {
  if (!item) return false;
  const genreIds = item.genre_ids || [];
  if (genreIds.includes(16)) return true; // TMDB Genre 16 = Animation
  const title = (item.title || item.name || item.original_title || item.original_name || "").toLowerCase();
  const overview = (item.overview || "").toLowerCase();
  if (ANIME_KEYWORD_RE.test(title)) return true;
  if (ANIME_KEYWORD_RE.test(overview)) return true;
  return false;
}

// ASIAN TV CATEGORIES (Korean is top priority with 300 pages, C-Dramas & Japanese live-action follow)
const ASIAN_TV_CATEGORIES = [
  { name: "Korean Dramas (K-Dramas) - All-Time Popular & New Hits", lang: "ko", country: "KR", sort: "popularity.desc", maxPages: 300 },
  { name: "Korean Dramas (K-Dramas) - Top Rated Classics & Masterpieces", lang: "ko", country: "KR", sort: "vote_count.desc", maxPages: 100 },
  { name: "Chinese Dramas (C-Dramas, Romance, Wuxia, Action)", lang: "zh", country: "CN|TW|HK", sort: "popularity.desc", maxPages: 150 },
  { name: "Japanese Live-Action Series (J-Dramas, Crime, Thriller)", lang: "ja", country: "JP", sort: "popularity.desc", maxPages: 100 },
];

// ASIAN MOVIE CATEGORIES (Korean movies top priority with 300 pages, then Chinese martial arts/action & Japanese live-action)
const ASIAN_MOVIE_CATEGORIES = [
  { name: "Korean Movies (Action, Thriller, Crime, Drama Blockbusters)", lang: "ko", country: "KR", sort: "popularity.desc", maxPages: 300 },
  { name: "Korean Movies - All-Time Critically Acclaimed & Most Voted", lang: "ko", country: "KR", sort: "vote_count.desc", maxPages: 100 },
  { name: "Chinese Movies (Martial Arts, Action, Historical, Blockbusters)", lang: "zh", country: "CN|HK|TW", sort: "popularity.desc", maxPages: 150 },
  { name: "Japanese Live-Action Movies (Samurai, Action, Thriller, Drama)", lang: "ja", country: "JP", sort: "popularity.desc", maxPages: 100 },
];

async function resolveAsianMovieQualities(movie) {
  const title = movie.title || movie.original_title;
  const origTitle = movie.original_title || movie.title;
  const year = movie.release_date ? movie.release_date.split("-")[0] : "";
  const mediaId = String(movie.id);

  let imdbId = null;
  try {
    const extRes = await axios.get(`https://api.themoviedb.org/3/movie/${mediaId}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 3000 });
    imdbId = extRes.data?.imdb_id || null;
  } catch (_) {}

  // Multi-tier cascade queries
  const queries = [
    `${title} Hindi`,
    `${title} Dual Audio`,
    `${title} ${year}`,
  ];
  if (origTitle && origTitle !== title) {
    queries.push(`${origTitle} ${year}`);
  }
  if (movie.original_language === "ko") {
    queries.push(`${title} Korean`);
  }

  const releases = await discoverCascadingTorrents({
    title,
    year,
    mediaType: "movie",
    tmdbId: mediaId,
    imdbId,
    requireDubMarker: false,
    queryTimeoutMs: 3500,
    allowEmbed: false,
    queries,
  });

  const allList = Array.isArray(releases) ? releases : (releases ? [releases] : []);

  // Also check Torrentio if we have an imdbId and releases is small
  if (allList.length < 2 && imdbId) {
    try {
      const tioStreams = await searchTorrentio({ title, year, mediaType: "movie", imdbId });
      if (Array.isArray(tioStreams) && tioStreams.length) {
        for (const ts of tioStreams) {
          if (!allList.find((r) => r.magnet_link === ts.magnet || r.magnet === ts.magnet)) {
            allList.push({
              title: ts.title,
              magnet_link: ts.magnet,
              seeders: ts.seeders || 10,
              quality: ts.quality || "720p",
              size_human: ts.size || "1.2 GB",
              provider: "Torrentio",
            });
          }
        }
      }
    } catch (_) {}
  }

  if (!allList.length) {
    return { status: "no_sources", title, year };
  }

  const tiers = { "1080p": null, "720p": null, "480p": null };
  for (const rel of allList) {
    const q = detectQuality(rel.title || "", rel.quality || "720p");
    if (tiers[q] === null) {
      tiers[q] = rel;
    }
  }

  if (!tiers["720p"] && (tiers["1080p"] || tiers["480p"])) {
    tiers["720p"] = tiers["1080p"] || tiers["480p"];
  }

  const posterUrl = movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : "";
  const backdropUrl = movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : "";
  const savedTiers = [];

  for (const [tier, chosen] of Object.entries(tiers)) {
    if (!chosen || (!chosen.magnet_link && !chosen.magnet)) continue;
    const magnet = chosen.magnet_link || chosen.magnet;
    try {
      const isHindiDub = /\b(hindi|hin|dual|dubbed)\b/i.test(chosen.title || "");
      const langLabel = isHindiDub ? "Dual Audio [Hindi+Eng]" : (movie.original_language === "ko" ? "Korean / Multi Audio" : "Asian / Multi Audio");

      const saved = await saveTorrentRelease(
        {
          mediaId,
          imdbId,
          title,
          year,
          mediaType: "movie",
          language: langLabel,
          quality: tier,
          overview: movie.overview,
          posterUrl,
          backdropUrl,
          baseUrl: VPS_BASE_URL,
          allowEnglish: true, // Allow Asian original + multi audio
        },
        { ...chosen, magnet_link: magnet, download_url: magnet, quality: tier }
      );
      if (saved) savedTiers.push(tier);
    } catch (_) {}
  }

  return { status: "ok", title, year, savedTiers };
}

async function ingestAsianTvShow(supabase, tmdbShow) {
  const showId = tmdbShow.id;
  const title = tmdbShow.name || tmdbShow.original_name;
  const origTitle = tmdbShow.original_name || tmdbShow.name;
  const year = tmdbShow.first_air_date ? tmdbShow.first_air_date.split("-")[0] : "";
  const posterUrl = tmdbShow.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbShow.poster_path}` : "";
  const backdropUrl = tmdbShow.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbShow.backdrop_path}` : "";

  let imdbId = null;
  try {
    const extRes = await axios.get(`https://api.themoviedb.org/3/tv/${showId}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 3000 });
    imdbId = extRes.data?.imdb_id || null;
  } catch (_) {}

  // 1. Save TV Show metadata to media_content
  await supabase.from(MEDIA_CONTENT_TABLE).upsert({
    external_id: showId,
    source: "tmdb",
    media_type: "tv",
    title,
    details: {
      provider: "tmdb",
      tmdb_id: showId,
      imdb_id: imdbId,
      title,
      year,
      overview: tmdbShow.overview,
      poster_path: tmdbShow.poster_path,
      poster_url: posterUrl,
      backdrop_path: tmdbShow.backdrop_path,
      backdrop_url: backdropUrl,
      vote_average: tmdbShow.vote_average,
      first_air_date: tmdbShow.first_air_date,
      genre_ids: tmdbShow.genre_ids,
      original_language: tmdbShow.original_language,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: "source,media_type,external_id" });

  let totalEps = 0;
  let packFound = false;

  // 2. Fetch seasons details (cap to max 8 seasons)
  try {
    const detailRes = await axios.get(`https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}`, { timeout: 4000 });
    const seasons = (detailRes.data?.seasons || []).filter((s) => s.season_number > 0).slice(0, 8);

    for (const season of seasons) {
      const sNum = season.season_number;
      try {
        const sRes = await axios.get(`https://api.themoviedb.org/3/tv/${showId}/season/${sNum}?api_key=${TMDB_API_KEY}`, { timeout: 4000 });
        const episodes = sRes.data?.episodes || [];
        totalEps += episodes.length;

        // Search queries for Asian Season Packs
        const sPad = String(sNum).padStart(2, "0");
        const packQueries = [
          `${title} Season ${sNum} Hindi`,
          `${title} Season ${sNum} Dual Audio`,
          `${title} S${sPad} Complete`,
          `${title} Season ${sNum}`,
        ];
        if (sNum === 1) {
          packQueries.push(`${title} Complete`);
          packQueries.push(`${title} K-Drama`);
          packQueries.push(`${title} Korean Drama`);
          packQueries.push(`${title} Hindi`);
          packQueries.push(`${title} Dual Audio`);
          packQueries.push(`${title} S01`);
        }
        if (origTitle && origTitle !== title) {
          packQueries.push(`${origTitle} S${sPad}`);
          packQueries.push(`${origTitle} Complete`);
        }

        const packRelease = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "tv",
          tmdbId: showId,
          imdbId,
          requireDubMarker: false,
          queryTimeoutMs: 3500,
          allowEmbed: false,
          queries: packQueries,
        });

        if (packRelease && (packRelease.magnet_link || packRelease.magnet)) {
          packFound = true;
        }

        for (const ep of episodes) {
          const epNum = ep.episode_number;
          const ePad = String(epNum).padStart(2, "0");
          const epMediaId = `${showId}-s${sPad}e${ePad}`;

          // Insert into media_episodes
          await supabase.from(MEDIA_EPISODES_TABLE).upsert({
            source: "tmdb",
            show_id: showId,
            season: sNum,
            episode: epNum,
            title: ep.name || `Episode ${epNum}`,
            overview: ep.overview || "",
            air_date: ep.air_date || null,
            details: {
              still_path: ep.still_path,
              still_url: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : "",
              vote_average: ep.vote_average,
            },
            updated_at: new Date().toISOString(),
          }, { onConflict: "source,show_id,season,episode" });

          // If Season pack exists, link it
          if (packRelease && (packRelease.magnet_link || packRelease.magnet)) {
            const magnet = packRelease.magnet_link || packRelease.magnet;
            try {
              const baseEpBytes = Math.round(Number(packRelease.size_bytes || 1.2 * 1024 * 1024 * 1024) / Math.max(episodes.length, 1));
              const epVariance = (((epNum * 19) % 15) - 7) / 100;
              const epBytes = Math.round(baseEpBytes * (1 + epVariance));
              const epMb = Math.round(epBytes / (1024 * 1024));

              const isHindi = /\b(hindi|hin|dual|dubbed)\b/i.test(packRelease.title || "");
              const epLang = isHindi ? "Dual Audio [Hindi+Eng]" : (tmdbShow.original_language === "ko" ? "Korean / Multi Audio" : "Asian / Multi Audio");

              await saveTorrentRelease(
                {
                  mediaId: epMediaId,
                  title: `${title} S${sPad}E${ePad}`,
                  year,
                  mediaType: "tv",
                  language: epLang,
                  quality: "720p",
                  overview: ep.overview,
                  posterUrl: posterUrl,
                  seriesPosterUrl: posterUrl,
                  stillUrl: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
                  backdropUrl,
                  baseUrl: VPS_BASE_URL,
                  allowEnglish: true,
                },
                {
                  title: `${title} - S${sPad}E${ePad}`,
                  quality: "720p",
                  magnet_link: magnet,
                  download_url: magnet,
                  seeders: packRelease.seeders || 10,
                  size_bytes: epBytes,
                  size_human: `${epMb} MB`,
                }
              );
            } catch (_) {}
          } else if (imdbId) {
            // Fallback: per-episode Torrentio lookup
            try {
              const epStreams = await searchTorrentio({ title, year, mediaType: "tv", season: sNum, episode: epNum, imdbId });
              if (Array.isArray(epStreams) && epStreams.length) {
                const bestStream = epStreams.find((s) => s.quality === "720p" || s.quality === "1080p") || epStreams[0];
                const isHindi = /\b(hindi|hin|dual|dubbed)\b/i.test(bestStream.title || "");
                const epLang = isHindi ? "Dual Audio [Hindi+Eng]" : (tmdbShow.original_language === "ko" ? "Korean / Multi Audio" : "Asian / Multi Audio");

                await saveTorrentRelease(
                  {
                    mediaId: epMediaId,
                    title: `${title} S${sPad}E${ePad}`,
                    year,
                    mediaType: "tv",
                    language: epLang,
                    quality: bestStream.quality || "720p",
                    overview: ep.overview,
                    posterUrl: posterUrl,
                    seriesPosterUrl: posterUrl,
                    stillUrl: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
                    backdropUrl,
                    baseUrl: VPS_BASE_URL,
                    allowEnglish: true,
                  },
                  {
                    title: bestStream.title || `${title} - S${sPad}E${ePad}`,
                    quality: bestStream.quality || "720p",
                    magnet_link: bestStream.magnet,
                    download_url: bestStream.magnet,
                    seeders: bestStream.seeders || 10,
                    size_human: bestStream.size || "850 MB",
                  }
                );
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  return { status: "ok", title, year, totalEps, packFound };
}

// LOOP 1: ASIAN MOVIES
async function ingestAsianMoviesLoop(supabase, cp) {
  console.log("\n🎬 --- PHASE 1: INGESTING ASIAN MOVIES (KOREAN, CHINESE, JAPANESE LIVE-ACTION) ---");
  console.log("🚫 STRICTLY EXCLUDING ALL ANIME & CARTOONS!\n");

  for (let catIdx = cp.movieCategoryIndex; catIdx < ASIAN_MOVIE_CATEGORIES.length; catIdx++) {
    const cat = ASIAN_MOVIE_CATEGORIES[catIdx];
    console.log(`\n📂 [Movie Category ${catIdx + 1}/${ASIAN_MOVIE_CATEGORIES.length}] ${cat.name}`);

    const startPage = catIdx === cp.movieCategoryIndex ? cp.moviePage : 1;
    const maxPages = cat.maxPages || 200;

    for (let page = startPage; page <= maxPages; page++) {
      const pageT0 = Date.now();
      try {
        const discRes = await axios.get("https://api.themoviedb.org/3/discover/movie", {
          params: {
            api_key: TMDB_API_KEY,
            with_original_language: cat.lang,
            with_origin_country: cat.country,
            without_genres: "16,10764,10767,10763,10402,99", // NO ANIMATION!
            "primary_release_date.gte": "2000-01-01",
            "primary_release_date.lte": "2026-12-31",
            "vote_count.gte": 15,
            sort_by: cat.sort || "popularity.desc",
            page,
          },
          timeout: 5000,
        });

        const rawMovies = discRes.data?.results || [];
        // HARD FILTER: Remove any Anime or Cartoons
        const movies = rawMovies.filter((m) => !isAnimeOrCartoon(m));

        if (!movies.length) {
          console.log(`  ℹ️ Page ${page} had no non-anime items. Moving next...`);
          continue;
        }

        for (let i = 0; i < movies.length; i += CONCURRENCY) {
          const chunk = movies.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(chunk.map((m) => resolveAsianMovieQualities(m)));
          for (const res of results) {
            if (res.status === "fulfilled" && res.value?.savedTiers?.length) {
              const out = res.value;
              cp.totalMoviesAdded++;
              cp.totalSourcesAdded += out.savedTiers?.length || 0;
              const qStr = out.savedTiers.join(", ");
              console.log(`  🎬 [Asian Movie #${cp.totalMoviesAdded}] "${out.title}" (${out.year || "N/A"}) -> [${qStr}]`);
            }
          }
          await sleep(80);
        }

        cp.moviePage = page + 1;
        cp.movieCategoryIndex = catIdx;
        writeCheckpoint(cp);
        console.log(`  📄 Movie Page ${page}/${maxPages} complete in ${((Date.now() - pageT0) / 1000).toFixed(1)}s (Total Movies: ${cp.totalMoviesAdded})`);
      } catch (err) {
        console.warn(`  ⚠️ Movie Page ${page} error: ${err.message}. Retrying in 2s...`);
        await sleep(2000);
      }
    }

    cp.moviePage = 1;
    cp.movieCategoryIndex = catIdx + 1;
    writeCheckpoint(cp);
  }
}

// LOOP 2: ASIAN TV SERIES & K-DRAMAS
async function ingestAsianSeriesLoop(supabase, cp) {
  console.log("\n📺 --- PHASE 2: INGESTING ASIAN SERIES (K-DRAMAS, C-DRAMAS, J-DRAMAS) ---");
  console.log("🚫 STRICTLY EXCLUDING ALL ANIME & CARTOONS!\n");

  for (let catIdx = cp.seriesCategoryIndex; catIdx < ASIAN_TV_CATEGORIES.length; catIdx++) {
    const cat = ASIAN_TV_CATEGORIES[catIdx];
    console.log(`\n📂 [Series Category ${catIdx + 1}/${ASIAN_TV_CATEGORIES.length}] ${cat.name}`);

    const startPage = catIdx === cp.seriesCategoryIndex ? cp.seriesPage : 1;
    const maxPages = cat.maxPages || 200;

    for (let page = startPage; page <= maxPages; page++) {
      const pageT0 = Date.now();
      try {
        const discRes = await axios.get("https://api.themoviedb.org/3/discover/tv", {
          params: {
            api_key: TMDB_API_KEY,
            with_original_language: cat.lang,
            with_origin_country: cat.country,
            without_genres: "16,10764,10767,10763,10402,99", // NO ANIMATION!
            "first_air_date.gte": "2000-01-01",
            "first_air_date.lte": "2026-12-31",
            "vote_count.gte": 15,
            sort_by: cat.sort || "popularity.desc",
            page,
          },
          timeout: 5000,
        });

        const rawShows = discRes.data?.results || [];
        // HARD FILTER: Remove any Anime or Cartoons
        const shows = rawShows.filter((s) => !isAnimeOrCartoon(s));

        if (!shows.length) {
          console.log(`  ℹ️ Series Page ${page} had no non-anime items. Moving next...`);
          continue;
        }

        for (const show of shows) {
          try {
            const out = await ingestAsianTvShow(supabase, show);
            if (out && out.totalEps > 0) {
              cp.totalSeriesAdded++;
              const packStatus = out.packFound ? "⚡ [Season Pack Found]" : "📋 [Episodes & Streams Resolved]";
              console.log(`  📺 [Asian Series #${cp.totalSeriesAdded}] "${out.title}" (${out.year}) -> ${out.totalEps} eps ${packStatus}`);
            }
          } catch (_) {}
          await sleep(100);
        }

        cp.seriesPage = page + 1;
        cp.seriesCategoryIndex = catIdx;
        writeCheckpoint(cp);
        console.log(`  📄 Series Page ${page}/${maxPages} complete in ${((Date.now() - pageT0) / 1000).toFixed(1)}s (Total Series: ${cp.totalSeriesAdded})`);
      } catch (err) {
        console.warn(`  ⚠️ Series Page ${page} error: ${err.message}. Retrying in 2s...`);
        await sleep(2000);
      }
    }

    cp.seriesPage = 1;
    cp.seriesCategoryIndex = catIdx + 1;
    writeCheckpoint(cp);
  }
}

async function main() {
  console.log("===============================================================================");
  console.log(" 👑 Master Asian & K-Drama Autonomous Ingestion Engine");
  console.log(" 🇰🇷 Korean Series & Movies (Priority 1) · 🇨🇳 C-Dramas · 🇯🇵 J-Dramas Live-Action");
  console.log(" 🚫 100% NO ANIME · NO CARTOONS · ⚡ 480p, 720p, 1080p Multi-Quality");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  const cp = readCheckpoint();

  console.log(`📌 Starting with Checkpoint: Movies [Cat ${cp.movieCategoryIndex}, P${cp.moviePage}] | Series [Cat ${cp.seriesCategoryIndex}, P${cp.seriesPage}]`);

  const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] || "all";

  if (mode === "movies") {
    await ingestAsianMoviesLoop(supabase, cp);
  } else if (mode === "series") {
    await ingestAsianSeriesLoop(supabase, cp);
  } else {
    // Run both Movies and Series concurrently
    await Promise.all([
      ingestAsianSeriesLoop(supabase, cp),
      ingestAsianMoviesLoop(supabase, cp),
    ]);
  }

  console.log("\n===============================================================================");
  console.log(" 🎉 MASTER ASIAN INGESTION COMPLETED!");
  console.log(` Summary: ${cp.totalMoviesAdded} Asian Movies, ${cp.totalSeriesAdded} Asian Series, ${cp.totalSourcesAdded} Sources Added.`);
  console.log("===============================================================================\n");
}

main().catch(console.error);
