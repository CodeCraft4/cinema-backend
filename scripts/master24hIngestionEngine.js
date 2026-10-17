#!/usr/bin/env node
"use strict";

/**
 * 👑 Master 24-Hour Autonomous Media Ingestion & Multi-Quality Engine
 * 
 * Rules Enforced:
 * 1. Years: 2000 to 2026.
 * 2. Real-Action ONLY: ANIMATION & ANIME (Genre 16) ARE 100% BLOCKED.
 * 3. Scope: Hollywood, Bollywood, Tollywood/Kollywood (South), K-Dramas, C/J-Dramas, Indian Web Series.
 * 4. Audio: STRICT Hindi Dubbed & Dual Audio [Hindi+Eng].
 * 5. Qualities: 1080p (max 2.8GB), 720p (max 1.6GB), 480p (max 800MB).
 * 6. 🚫 4K / 2160p is FULLY IGNORED.
 * 7. Deduplication: TMDB ID unique checks (never inserts duplicate movies or series).
 * 8. Resilient: Automatic checkpoint auto-resume for 24/7 PM2 execution.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE, MEDIA_EPISODES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents, cleanSearchTitle } = require("../server/services/torrentResolver");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "40b06951f1c6497bbe2bc6d9e5ad6b47";
const VPS_BASE_URL = process.env.BASE_URL || "http://168.144.249.68:4555";
const CHECKPOINT_FILE = path.join(__dirname, ".master-24h-checkpoint.json");

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
  if (unit.startsWith("g")) return val * 1024 * 1024 * 1024;
  if (unit.startsWith("m")) return val * 1024 * 1024;
  if (unit.startsWith("k")) return val * 1024;
  return 0;
}

function readCheckpoint() {
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
  { name: "Hollywood (English Popular)", lang: "en" },
  { name: "Bollywood (Hindi)", lang: "hi" },
  { name: "South Indian (Tollywood / Kollywood)", lang: "te|ta|ml|kn" },
];

const TV_CATEGORIES = [
  { name: "Hollywood Web Series", lang: "en" },
  { name: "Korean Dramas (K-Drama)", lang: "ko" },
  { name: "Chinese & Japanese Dramas", lang: "zh|ja" },
  { name: "Desi Hindi Web Series", lang: "hi" },
];

async function fetchTorrentioTiers(imdbId, title) {
  if (!imdbId && !title) return {};
  const tiers = { "1080p": null, "720p": null, "480p": null };

  if (imdbId) {
    try {
      const cleanImdb = imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;
      const res = await axios.get(`https://torrentio.strem.fun/stream/movie/${cleanImdb}.json`, { timeout: 4500 });
      const streams = res.data?.streams || [];

      for (const s of streams) {
        const raw = `${s.name || ""} ${s.title || ""}`.toLowerCase();
        const isHindi = raw.includes("hindi") || raw.includes("dual") || raw.includes("multi");
        if (!isHindi) continue;

        const seedMatch = raw.match(/👤\s*(\d+)/);
        const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 5;
        if (seeds < 3) continue;

        const sizeMatch = raw.match(/💾\s*([\d.]+\s*[gm]b)/);
        const sizeBytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0;
        const sizeHuman = sizeMatch ? sizeMatch[1].toUpperCase() : "";

        // STRICT SIZE CAPS: Skip oversized files
        if (sizeBytes > 3.2 * 1024 * 1024 * 1024) continue;

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

        if ((raw.includes("1080p") || raw.includes("fhd")) && !tiers["1080p"] && sizeBytes <= 2.8 * 1024 * 1024 * 1024) {
          tiers["1080p"] = candidate;
        } else if ((raw.includes("720p") || raw.includes("hd")) && !tiers["720p"] && sizeBytes <= 1.6 * 1024 * 1024 * 1024) {
          tiers["720p"] = candidate;
        } else if ((raw.includes("480p") || raw.includes("dvdrip") || raw.includes("sd")) && !tiers["480p"] && sizeBytes <= 800 * 1024 * 1024) {
          tiers["480p"] = candidate;
        }
      }
    } catch (_) {}
  }

  return tiers;
}

async function resolveMovieQualities(movie) {
  const mediaId = String(movie.id);
  const title = cleanSearchTitle(movie.title);
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  let imdbId = movie.imdb_id || "";
  if (!imdbId && mediaId) {
    try {
      const ext = await axios.get(`https://api.themoviedb.org/3/movie/${mediaId}/external_ids?api_key=${TMDB_API_KEY}`, { timeout: 3500 });
      imdbId = ext.data?.imdb_id || "";
    } catch (_) {}
  }

  process.stdout.write(`  ⏳ Resolving: "${title}" (${year || "N/A"})...\n`);
  const torrentioTiers = await fetchTorrentioTiers(imdbId, title);
  const added = [];

  for (const tier of ["1080p", "720p", "480p"]) {
    let chosen = torrentioTiers[tier];

    if (!chosen) {
      try {
        const found = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "movie",
          tmdbId: mediaId,
          imdbId,
          requireDubMarker: true,
          queryTimeoutMs: 3500,
          allowEmbed: false,
          queries: [`${title} ${tier} Hindi`, `${title} ${tier} Dual Audio`],
        });

        if (found && found.magnet_link) {
          const bytes = Number(found.size_bytes || found.sizeBytes) || 0;
          const maxAllowed = tier === "1080p" ? 2.8 * 1024 * 1024 * 1024 : tier === "720p" ? 1.6 * 1024 * 1024 * 1024 : 800 * 1024 * 1024;
          if (bytes <= maxAllowed || bytes === 0) {
            chosen = {
              title: found.title || `${title} [${tier} Hindi]`,
              magnet_link: found.magnet_link,
              download_url: found.magnet_link,
              seeders: found.seeders || 10,
              size_bytes: bytes || null,
              size_human: found.size_human || "",
            };
          }
        }
      } catch (_) {}
    }

    if (chosen && chosen.magnet_link) {
      try {
        await saveTorrentRelease(
          {
            mediaId,
            imdbId,
            title: movie.title,
            year,
            mediaType: "movie",
            language: "Hindi",
            quality: tier,
            overview,
            posterUrl,
            backdropUrl,
            rating,
            baseUrl: VPS_BASE_URL,
          },
          chosen
        );
        added.push(tier);
      } catch (_) {}
    }
  }

  return added;
}

async function ingestMovie(supabase, tmdbMovie) {
  const mediaId = String(tmdbMovie.id);
  const title = tmdbMovie.title;
  const year = tmdbMovie.release_date ? tmdbMovie.release_date.slice(0, 4) : "";
  const posterUrl = tmdbMovie.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbMovie.poster_path}` : "";
  const backdropUrl = tmdbMovie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbMovie.backdrop_path}` : "";

  // 1. Upsert into media_content
  const { error: insErr } = await supabase.from(MEDIA_CONTENT_TABLE).upsert({
    external_id: mediaId,
    source: "tmdb",
    title,
    media_type: "movie",
    details: {
      id: tmdbMovie.id,
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
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: "external_id,source" });

  if (insErr) {
    return { status: "error", message: insErr.message };
  }

  // 2. Fetch multi-qualities (1080p, 720p, 480p)
  const added = await resolveMovieQualities(tmdbMovie);
  return { status: "ok", title, added };
}

async function ingestTvShow(supabase, tmdbShow) {
  const showId = String(tmdbShow.id);
  const title = tmdbShow.name;
  const year = tmdbShow.first_air_date ? tmdbShow.first_air_date.slice(0, 4) : "";
  const posterUrl = tmdbShow.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbShow.poster_path}` : "";
  const backdropUrl = tmdbShow.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbShow.backdrop_path}` : "";
  process.stdout.write(`  📺 Ingesting TV Show: "${title}" (${year || "N/A"})...\n`);
  // 1. Upsert into media_content
  await supabase.from(MEDIA_CONTENT_TABLE).upsert({
    external_id: showId,
    source: "tmdb",
    title,
    media_type: "tv",
    details: {
      id: tmdbShow.id,
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
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: "external_id,source" });

  // 2. Fetch seasons details from TMDB
  try {
    const detailRes = await axios.get(`https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}`, { timeout: 5000 });
    const seasons = detailRes.data?.seasons || [];

    for (const season of seasons) {
      if (!season.season_number || season.season_number === 0) continue;
      const sNum = season.season_number;

      // Fetch season episodes
      try {
        const sRes = await axios.get(`https://api.themoviedb.org/3/tv/${showId}/season/${sNum}?api_key=${TMDB_API_KEY}`, { timeout: 5000 });
        const episodes = sRes.data?.episodes || [];

        // Try resolving season pack or episodes in Hindi
        const packQuery = `${title} Season ${sNum} Hindi`;
        const packRelease = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "tv",
          tmdbId: showId,
          requireDubMarker: true,
          queryTimeoutMs: 3500,
          allowEmbed: false,
          queries: [packQuery, `${title} S${String(sNum).padStart(2, "0")} Dual Audio`],
        });

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
          }, { onConflict: "show_id,season,episode" });

          // If season pack found, link to each episode
          if (packRelease && packRelease.magnet_link) {
            await saveTorrentRelease(
              {
                mediaId: epMediaId,
                title: `${title} S${sPad}E${ePad}`,
                year,
                mediaType: "tv",
                language: "Hindi",
                quality: "720p",
                overview: ep.overview,
                posterUrl: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : posterUrl,
                backdropUrl,
                baseUrl: VPS_BASE_URL,
              },
              {
                title: `${title} - S${sPad}E${ePad} [Hindi]`,
                magnet_link: packRelease.magnet_link,
                download_url: packRelease.magnet_link,
                seeders: packRelease.seeders || 10,
                size_bytes: Math.round(Number(packRelease.size_bytes || 1.5 * 1024 * 1024 * 1024) / Math.max(episodes.length, 1)),
                size_human: "~800 MB",
              }
            );
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  return { status: "ok", title };
}

async function main() {
  console.log("===============================================================================");
  console.log(" 👑 Master 24-Hour Autonomous Ingestion & Multi-Quality Engine");
  console.log(" 🚫 NO ANIMATION / ANIME · 🎯 2000-2026 · ⚡ 480p, 720p, 1080p Hindi");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  const cp = readCheckpoint();

  console.log(`📌 Starting with Checkpoint: Movie Category [${cp.movieCategoryIndex}], Movie Page [${cp.moviePage}]`);

  // --- LOOP 1: MOVIES ---
  console.log("\n🎬 --- PHASE 1: DISCOVERING & INGESTING MOVIES (2000 - 2026) ---");
  for (let catIdx = cp.movieCategoryIndex; catIdx < MOVIE_CATEGORIES.length; catIdx++) {
    const cat = MOVIE_CATEGORIES[catIdx];
    console.log(`\n📂 Category: ${cat.name} (Lang: ${cat.lang})`);

    const startPage = catIdx === cp.movieCategoryIndex ? cp.moviePage : 1;
    const maxPages = 250; // 250 pages * 20 = 5,000 movies per category

    for (let page = startPage; page <= maxPages; page++) {
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
              cp.totalSourcesAdded += out.added?.length || 0;
              console.log(`  ✅ [Movie #${cp.totalMoviesAdded}] "${out.title}" -> Qualities: [${out.added?.join(", ") || "Cloud Stream"}]`);
            }
          }
          await sleep(200);
        }

        cp.moviePage = page;
        cp.movieCategoryIndex = catIdx;
        writeCheckpoint(cp);
      } catch (err) {
        console.warn(`  ⚠️ Page ${page} error: ${err.message}. Retrying in 3s...`);
        await sleep(3000);
      }
    }
  }

  // --- LOOP 2: SERIES & TV SHOWS ---
  console.log("\n📺 --- PHASE 2: DISCOVERING & INGESTING WEB SERIES & DRAMAS ---");
  for (let catIdx = cp.seriesCategoryIndex; catIdx < TV_CATEGORIES.length; catIdx++) {
    const cat = TV_CATEGORIES[catIdx];
    console.log(`\n📂 Series Category: ${cat.name} (Lang: ${cat.lang})`);

    const startPage = catIdx === cp.seriesCategoryIndex ? cp.seriesPage : 1;
    const maxPages = 150; // 150 pages * 20 = 3,000 series per category

    for (let page = startPage; page <= maxPages; page++) {
      try {
        const url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&first_air_date.gte=2000-01-01&first_air_date.lte=2026-12-31&without_genres=16&with_original_language=${cat.lang}&sort_by=popularity.desc&page=${page}`;
        const res = await axios.get(url, { timeout: 6000 });
        const results = res.data?.results || [];

        if (results.length === 0) break;

        for (let i = 0; i < results.length; i += CONCURRENCY) {
          const chunk = results.slice(i, i + CONCURRENCY);
          const outcomes = await Promise.all(chunk.map((s) => ingestTvShow(supabase, s)));

          for (const out of outcomes) {
            if (out.status === "ok") {
              cp.totalSeriesAdded++;
              console.log(`  📺 [Series #${cp.totalSeriesAdded}] "${out.title}" -> Ingested with Episodes & Hindi Sources`);
            }
          }
          await sleep(300);
        }

        cp.seriesPage = page;
        cp.seriesCategoryIndex = catIdx;
        writeCheckpoint(cp);
      } catch (err) {
        console.warn(`  ⚠️ Series page ${page} error: ${err.message}. Retrying in 3s...`);
        await sleep(3000);
      }
    }
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
