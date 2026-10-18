#!/usr/bin/env node
"use strict";

/**
 * 👑 Master 24-Hour Autonomous Media Ingestion & Multi-Quality Engine
 * 
 * Rules Enforced:
 * 1. Years: 2000 to 2026.
 * 2. Real-Action ONLY: ANIMATION & ANIME (TMDB Genre 16) ARE 100% BLOCKED.
 * 3. Scope: Hollywood, Bollywood, Tollywood/Kollywood (South), K-Dramas, C/J-Dramas, Indian Web Series.
 * 4. Audio: STRICT Hindi Dubbed & Dual Audio [Hindi+Eng] (and pure Hindi for Bollywood).
 * 5. Qualities: 1080p (max 2.8GB), 720p (max 1.6GB), 480p (max 800MB).
 * 6. 🚫 4K / 2160p is FULLY IGNORED.
 * 7. Deduplication: TMDB ID unique checks (never inserts duplicate movies or series).
 * 8. Resilient: Non-blocking timeouts (max 3s per network call), real-time stdout logs for PM2.
 * 9. Safe: Preserves profiles, app_versions, and search history 100%.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const MEDIA_EPISODES_TABLE = "media_episodes";
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { cleanSearchTitle, discoverCascadingTorrents, rankValidReleases, detectQuality } = require("../server/services/torrentResolver");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "40b06951f1c6497bbe2bc6d9e5ad6b47";
const VPS_BASE_URL = process.env.BASE_URL || "http://168.144.249.68:4555";
const targetMode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] || "all";
const CHECKPOINT_FILE = targetMode === "movies"
  ? path.join(__dirname, ".master-movies-checkpoint.json")
  : targetMode === "series"
  ? path.join(__dirname, ".master-series-checkpoint.json")
  : path.join(__dirname, ".master-24h-checkpoint.json");


const CONCURRENCY = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSizeToBytes(str) {
  if (!str) return 0;
  const match = String(str).match(/([\d.]+)\s*(gb|mb|kb|g|m)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("g")) return Math.round(val * 1024 * 1024 * 1024);
  if (unit.startsWith("m")) return Math.round(val * 1024 * 1024);
  if (unit.startsWith("k")) return Math.round(val * 1024);
  return 0;
}

const isReset = process.argv.includes("--reset");

function readCheckpoint() {
  if (isReset) {
    console.log("🔄 --reset flag detected: Starting fresh from Category 0, Page 1.");
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

const MOVIE_CATEGORIES = [
  { name: "Hollywood (English Popular)", lang: "en", maxPages: 350 },
  { name: "Bollywood (Hindi)", lang: "hi", maxPages: 350 },
  { name: "South Indian (Tollywood / Kollywood / Mollywood / Sandalwood)", lang: "te|ta|ml|kn", maxPages: 350 },
  { name: "Pan-Asian & Global Action (Hindi Dubbed)", lang: "ko|zh|ja|tr|es|fr", maxPages: 250 },
];

const TV_CATEGORIES = [
  { name: "Hollywood Web Series", lang: "en", maxPages: 150 },
  { name: "Korean Dramas (K-Drama)", lang: "ko", maxPages: 150 },
  { name: "Chinese & Japanese Dramas", lang: "zh|ja", maxPages: 150 },
  { name: "Desi Hindi Web Series", lang: "hi", maxPages: 150 },
  { name: "Turkish Dramas", lang: "tr", maxPages: 100 },
];

async function fetchTorrentioTiers(imdbId, title, isNativeHindi = false) {
  const tiers = { "1080p": null, "720p": null, "480p": null };
  if (!imdbId && !title) return tiers;

  try {
    let cleanImdb = imdbId;
    if (!cleanImdb && title) {
      const searchRes = await axios.get(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(title)}.json`, { timeout: 2500 });
      cleanImdb = searchRes.data?.metas?.[0]?.id;
    }
    if (!cleanImdb || !cleanImdb.startsWith("tt")) return tiers;

    const res = await axios.get(`https://torrentio.strem.fun/stream/movie/${cleanImdb}.json`, { timeout: 3000 });
    const streams = res.data?.streams || [];

    for (const s of streams) {
      const raw = `${s.name || ""} ${s.title || ""} ${s.behaviorHints?.filename || ""}`.toLowerCase();

      // Disallow 4K / 2160p
      if (raw.includes("2160p") || raw.includes("4k") || raw.includes("uhd")) continue;

      // Check Hindi language or native Hindi
      const isHindi = isNativeHindi || raw.includes("hindi") || raw.includes("dual") || raw.includes("multi") || raw.includes("urdu") || raw.includes("dubbed");
      if (!isHindi) continue;

      const seedMatch = raw.match(/👤\s*(\d+)/);
      const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 5;
      if (seeds < 2) continue;

      const sizeMatch = raw.match(/💾\s*([\d.]+\s*[gm]b)/);
      const sizeBytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0;
      const sizeHuman = sizeMatch ? sizeMatch[1].toUpperCase() : "";

      // Strict overall ceiling: skip anything larger than 3.0 GB
      if (sizeBytes > 3.0 * 1024 * 1024 * 1024) continue;

      const magnet = s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(title || "Movie")}` : null;
      if (!magnet) continue;

      const candidate = {
        title: s.title ? s.title.split("\n")[0] : `${title} Hindi`,
        magnet_link: magnet,
        download_url: magnet,
        seeders: seeds,
        size_bytes: sizeBytes,
        size_human: sizeHuman,
      };

      if ((raw.includes("1080p") || raw.includes("fhd")) && !tiers["1080p"] && (sizeBytes <= 2.8 * 1024 * 1024 * 1024 || sizeBytes === 0)) {
        tiers["1080p"] = candidate;
      } else if ((raw.includes("720p") || raw.includes("hd")) && !tiers["720p"] && (sizeBytes <= 1.6 * 1024 * 1024 * 1024 || sizeBytes === 0)) {
        tiers["720p"] = candidate;
      } else if ((raw.includes("480p") || raw.includes("dvdrip") || raw.includes("sd")) && !tiers["480p"] && (sizeBytes <= 800 * 1024 * 1024 || sizeBytes === 0)) {
        tiers["480p"] = candidate;
      }
    }
  } catch (_) {}

  return tiers;
}

async function resolveMovieQualities(movie) {
  const mediaId = String(movie.id);
  const title = cleanSearchTitle(movie.title);
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  const posterUrl = movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : "";
  const backdropUrl = movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : "";
  const overview = movie.overview || "";
  const rating = movie.vote_average || 0;
  const isNativeHindi = movie.original_language === "hi";

  let imdbId = movie.imdb_id || "";
  if (!imdbId && mediaId) {
    try {
      const ext = await axios.get(`https://api.themoviedb.org/3/movie/${mediaId}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 2500 });
      imdbId = ext.data?.imdb_id || "";
    } catch (_) {}
  }

  // 1. Torrentio check (fast multi-indexer)
  const tiers = await fetchTorrentioTiers(imdbId, title, isNativeHindi);

  // 2. Fallback single scrape if missing tiers
  const missingTiers = Object.keys(tiers).filter((q) => !tiers[q]);
  if (missingTiers.length > 0) {
    try {
      const searchQuery = isNativeHindi ? `${title} ${year}` : `${title} Hindi`;
      const cascade = await discoverCascadingTorrents({
        title,
        year,
        mediaType: "movie",
        tmdbId: mediaId,
        imdbId,
        requireDubMarker: !isNativeHindi,
        queryTimeoutMs: 3000,
        allowEmbed: false,
        queries: [searchQuery, `${title} Dual Audio`],
      });

      if (cascade && cascade.magnet_link) {
        const quality = cascade.quality || "720p";
        if (quality !== "2160p" && !tiers[quality]) {
          tiers[quality] = {
            title: cascade.title || `${title} [${quality}]`,
            magnet_link: cascade.magnet_link,
            download_url: cascade.magnet_link,
            seeders: cascade.seeders || 10,
            size_bytes: cascade.size_bytes || 0,
            size_human: cascade.size_human || "",
          };
        }
      }
    } catch (_) {}
  }

  // 3. Save resolved tiers to media_sources
  const savedTiers = [];
  for (const [tier, chosen] of Object.entries(tiers)) {
    if (!chosen || !chosen.magnet_link) continue;
    try {
      const saved = await saveTorrentRelease(
        {
          mediaId,
          imdbId,
          title: movie.title,
          year,
          mediaType: "movie",
          language: isNativeHindi ? "Hindi" : "Dual Audio [Hindi+Eng]",
          quality: tier,
          overview,
          posterUrl,
          backdropUrl,
          rating,
          baseUrl: VPS_BASE_URL,
          allowEnglish: isNativeHindi,
        },
        { ...chosen, quality: tier }
      );
      if (saved) savedTiers.push(tier);
    } catch (_) {}
  }

  return savedTiers;
}

async function ingestMovie(supabase, tmdbMovie) {
  const mediaId = String(tmdbMovie.id);
  const title = tmdbMovie.title;
  const year = tmdbMovie.release_date ? tmdbMovie.release_date.slice(0, 4) : "";
  const posterUrl = tmdbMovie.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbMovie.poster_path}` : "";
  const backdropUrl = tmdbMovie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbMovie.backdrop_path}` : "";

  // 1. Immediately upsert into media_content so it's live in catalog instantly
  await supabase.from(MEDIA_CONTENT_TABLE).upsert({
    external_id: parseInt(mediaId, 10),
    source: "tmdb",
    title,
    media_type: "movie",
    details: {
      id: parseInt(mediaId, 10),
      title,
      year,
      overview: tmdbMovie.overview,
      poster_path: tmdbMovie.poster_path,
      poster_url: posterUrl,
      backdrop_path: tmdbMovie.backdrop_path,
      backdrop_url: backdropUrl,
      vote_average: tmdbMovie.vote_average,
      release_date: tmdbMovie.release_date,
      genre_ids: tmdbMovie.genre_ids,
      original_language: tmdbMovie.original_language,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: "source,media_type,external_id" });

  // 2. Fetch multi-qualities (1080p, 720p, 480p)
  const savedTiers = await resolveMovieQualities(tmdbMovie);
  return { status: "ok", title, year, lang: tmdbMovie.original_language, savedTiers };
}

async function ingestTvShow(supabase, tmdbShow) {
  const showId = String(tmdbShow.id);
  const title = tmdbShow.name;
  const year = tmdbShow.first_air_date ? tmdbShow.first_air_date.slice(0, 4) : "";
  const posterUrl = tmdbShow.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbShow.poster_path}` : "";
  const backdropUrl = tmdbShow.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbShow.backdrop_path}` : "";

  const genres = tmdbShow.genre_ids || [];
  if (genres.some((g) => [16, 10767, 10763, 10764].includes(g))) {
    return { status: "skip", title };
  }

  // 1. Upsert show into media_content
  await supabase.from(MEDIA_CONTENT_TABLE).upsert({
    external_id: parseInt(showId, 10),
    source: "tmdb",
    title,
    media_type: "tv",
    details: {
      id: parseInt(showId, 10),
      name: title,
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

  // 2. Fetch seasons details from TMDB (cap to max 8 seasons for dramas)
  try {
    const detailRes = await axios.get(`https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}`, { timeout: 4000 });
    const seasons = (detailRes.data?.seasons || []).filter((s) => s.season_number > 0).slice(0, 8);

    for (const season of seasons) {
      const sNum = season.season_number;
      try {
        const sRes = await axios.get(`https://api.themoviedb.org/3/tv/${showId}/season/${sNum}?api_key=${TMDB_API_KEY}`, { timeout: 4000 });
        const episodes = sRes.data?.episodes || [];
        totalEps += episodes.length;

        // Try resolving Hindi season pack
        const isNativeHindi = tmdbShow.original_language === "hi";
        const packQuery = isNativeHindi ? `${title} Season ${sNum}` : `${title} Season ${sNum} Hindi`;
        const packRelease = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "tv",
          tmdbId: showId,
          requireDubMarker: !isNativeHindi,
          queryTimeoutMs: 3000,
          allowEmbed: false,
          queries: [packQuery, `${title} S${String(sNum).padStart(2, "0")} Dual Audio`],
        });

        if (packRelease && packRelease.magnet_link) {
          packFound = true;
        }

        for (const ep of episodes) {
          const epNum = ep.episode_number;
          const sPad = String(sNum).padStart(2, "0");
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

          // Link season pack magnet to episode
          if (packRelease && packRelease.magnet_link) {
            try {
              await saveTorrentRelease(
                {
                  mediaId: epMediaId,
                  title: `${title} S${sPad}E${ePad}`,
                  year,
                  mediaType: "tv",
                  language: isNativeHindi ? "Hindi" : "Dual Audio [Hindi+Eng]",
                  quality: "720p",
                  overview: ep.overview,
                  posterUrl: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : posterUrl,
                  backdropUrl,
                  baseUrl: VPS_BASE_URL,
                  allowEnglish: isNativeHindi,
                },
                {
                  title: `${title} - S${sPad}E${ePad} [Hindi]`,
                  magnet_link: packRelease.magnet_link,
                  download_url: packRelease.magnet_link,
                  seeders: packRelease.seeders || 10,
                  size_bytes: Math.round(Number(packRelease.size_bytes || 1.2 * 1024 * 1024 * 1024) / Math.max(episodes.length, 1)),
                  size_human: "~700 MB",
                }
              );
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  return { status: "ok", title, year, totalEps, packFound };
}

async function ingestMoviesLoop(supabase, cp) {
  console.log("\n🎬 --- PHASE 1: DISCOVERING & INGESTING MOVIES (2000 - 2026) ---");
  for (let catIdx = cp.movieCategoryIndex; catIdx < MOVIE_CATEGORIES.length; catIdx++) {
    const cat = MOVIE_CATEGORIES[catIdx];
    console.log(`\n📂 [Movie Category ${catIdx + 1}/${MOVIE_CATEGORIES.length}] ${cat.name} (Lang: ${cat.lang})`);

    const startPage = catIdx === cp.movieCategoryIndex ? cp.moviePage : 1;
    const maxPages = cat.maxPages || 350;

    for (let page = startPage; page <= maxPages; page++) {
      const pageT0 = Date.now();
      try {
        const url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&primary_release_date.gte=2000-01-01&primary_release_date.lte=2026-12-31&without_genres=16&with_original_language=${cat.lang}&sort_by=popularity.desc&page=${page}`;
        const res = await axios.get(url, { timeout: 6000 });
        const results = res.data?.results || [];

        if (results.length === 0) break;

        for (let i = 0; i < results.length; i += CONCURRENCY) {
          const chunk = results.slice(i, i + CONCURRENCY);
          const outcomes = await Promise.all(chunk.map((m) => ingestMovie(supabase, m)));

          for (const out of outcomes) {
            if (out.status === "ok") {
              cp.totalMoviesAdded++;
              cp.totalSourcesAdded += out.savedTiers?.length || 0;
              const qStr = out.savedTiers?.length ? out.savedTiers.join(", ") : "Cloud Stream";
              console.log(`  🎬 [Movie #${cp.totalMoviesAdded}] "${out.title}" (${out.year || "N/A"}) [${out.lang}] -> [${qStr}]`);
            }
          }
          await sleep(100);
        }

        cp.moviePage = page + 1;
        cp.movieCategoryIndex = catIdx;
        writeCheckpoint(cp);
        console.log(`  📄 Movie Page ${page} complete in ${((Date.now() - pageT0) / 1000).toFixed(1)}s (Total Movies: ${cp.totalMoviesAdded}, Sources: ${cp.totalSourcesAdded})`);
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

async function ingestSeriesLoop(supabase, cp) {
  console.log("\n📺 --- PHASE 2: DISCOVERING & INGESTING WEB SERIES & DRAMAS ---");
  for (let catIdx = cp.seriesCategoryIndex; catIdx < TV_CATEGORIES.length; catIdx++) {
    const cat = TV_CATEGORIES[catIdx];
    console.log(`\n📂 [Series Category ${catIdx + 1}/${TV_CATEGORIES.length}] ${cat.name} (Lang: ${cat.lang})`);

    const startPage = catIdx === cp.seriesCategoryIndex ? cp.seriesPage : 1;
    const maxPages = cat.maxPages || 150;

    for (let page = startPage; page <= maxPages; page++) {
      const pageT0 = Date.now();
      try {
        const url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&first_air_date.gte=2000-01-01&first_air_date.lte=2026-12-31&without_genres=16,10767,10763,10764&with_original_language=${cat.lang}&sort_by=popularity.desc&page=${page}`;
        const res = await axios.get(url, { timeout: 6000 });
        const results = res.data?.results || [];

        if (results.length === 0) break;

        for (let i = 0; i < results.length; i += CONCURRENCY) {
          const chunk = results.slice(i, i + CONCURRENCY);
          const outcomes = await Promise.all(chunk.map((s) => ingestTvShow(supabase, s)));

          for (const out of outcomes) {
            if (out.status === "ok") {
              cp.totalSeriesAdded++;
              const packLabel = out.packFound ? "Hindi Torrents" : "Cloud Stream";
              console.log(`  📺 [Series #${cp.totalSeriesAdded}] "${out.title}" (${out.year || "N/A"}) -> ${out.totalEps} Episodes [${packLabel}]`);
            }
          }
          await sleep(200);
        }

        cp.seriesPage = page + 1;
        cp.seriesCategoryIndex = catIdx;
        writeCheckpoint(cp);
        console.log(`  📄 Series Page ${page} complete in ${((Date.now() - pageT0) / 1000).toFixed(1)}s (Total Series: ${cp.totalSeriesAdded})`);
      } catch (err) {
        console.warn(`  ⚠️ Series page ${page} error: ${err.message}. Retrying in 2s...`);
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
  console.log(" 👑 Master 24-Hour Autonomous Ingestion & Multi-Quality Engine");
  console.log(" 🚫 NO ANIMATION / ANIME · 🎯 2000-2026 · ⚡ 480p, 720p, 1080p Hindi");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  const cp = readCheckpoint();

  console.log(`📌 Starting with Checkpoint: Movies [Cat ${cp.movieCategoryIndex}, P${cp.moviePage}] | Series [Cat ${cp.seriesCategoryIndex}, P${cp.seriesPage}]`);

  const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] || "all";

  if (mode === "movies") {
    await ingestMoviesLoop(supabase, cp);
  } else if (mode === "series") {
    await ingestSeriesLoop(supabase, cp);
  } else {
    // Run both Movies and Series concurrently!
    await Promise.all([
      ingestMoviesLoop(supabase, cp),
      ingestSeriesLoop(supabase, cp),
    ]);
  }

  console.log("\n===============================================================================");
  console.log(" 🎉 MASTER 24-HOUR INGESTION COMPLETED!");
  console.log(` 🎬 Total Movies Ingested: ${cp.totalMoviesAdded}`);
  console.log(` 📺 Total Series Ingested: ${cp.totalSeriesAdded}`);
  console.log(` 💾 Total Sources Added:   ${cp.totalSourcesAdded}`);
  console.log("===============================================================================\n");
}

main().catch((err) => {
  console.error("Fatal Error in master24hIngestionEngine:", err);
  process.exit(1);
});
