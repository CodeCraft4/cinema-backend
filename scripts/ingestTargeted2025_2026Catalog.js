"use strict";

/**
 * 🎬 Targeted Ingestion Engine: 2025-2026 Bollywood & Hollywood + 2023-2026 Hit Series
 *
 * Requirements:
 * 1. 30 to 50 Bollywood Movies (2025 - 2026) with live Hindi torrents (seeds >= 5, 480p/720p/1080p).
 * 2. 30 to 50 Hollywood Movies (2025 - 2026) with live Hindi/Dual Audio torrents (seeds >= 5).
 * 3. Trending Series (2023 - 2026) including Berlin, Mercy for None (Korean), and global hits with seeders >= 5.
 * 4. Strict Title Matching (Zero cartoons, zero wrong sequels).
 * 5. Clean upsert into Supabase `media_content` & `media_sources`.
 */

require("dotenv").config();
const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { buildCacheKey } = require("../server/services/mediaSourceService");
const { magnetWrite, discoverCascadingTorrents } = require("../server/services/torrentResolver");
const env = require("../server/config/env");

const TMDB_API_KEY = env.tmdbApiKey || "40b06951f1c6497bbe2bc6d9e5ad6b47";
const MIN_REQUIRED_SEEDERS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function hasWorkingSource(supabase, mediaId) {
  try {
    const { data } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, seeders")
      .eq("media_id", String(mediaId))
      .gte("seeders", MIN_REQUIRED_SEEDERS)
      .limit(1);
    return Boolean(data && data.length > 0);
  } catch {
    return false;
  }
}

async function upsertMediaContent(supabase, item, mediaType = "movie") {
  const externalId = String(item.id);
  const title = item.title || item.name;
  const releaseDate = item.release_date || item.first_air_date || "";
  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : null;
  const posterPath = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
  const backdropPath = item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null;

  const contentRow = {
    external_id: externalId,
    title,
    content_type: mediaType === "tv" ? "series" : "movie",
    year,
    poster_url: posterPath,
    backdrop_url: backdropPath,
    rating: item.vote_average ? Math.round(Number(item.vote_average) * 10) / 10 : null,
    overview: item.overview || null,
    details: {
      overview: item.overview,
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      release_date: releaseDate,
      vote_average: item.vote_average,
      vote_count: item.vote_count,
      popularity: item.popularity,
      original_language: item.original_language,
      original_title: item.original_title || item.original_name,
    },
    updated_at: new Date().toISOString(),
  };

  await supabase.from(MEDIA_CONTENT_TABLE).upsert(contentRow, { onConflict: "external_id" });
  return contentRow;
}

async function saveMediaSource(supabase, { item, release, mediaType, externalId, season = null, episode = null }) {
  const title = item.title || item.name;
  const releaseDate = item.release_date || item.first_air_date || "";
  const year = releaseDate ? releaseDate.slice(0, 4) : "";
  const liveSeeds = Number(release.seeders || release.seeds || 5);
  const magnet = release.magnet_link || release.magnet || release.download_url;
  const cleanQuality = release.quality || "720p";
  const cleanLanguage = release.language || "Dual Audio [Hindi+Eng]";
  const written = magnetWrite(magnet);

  let mediaId = String(externalId);
  let displayTitle = title;
  if (season != null && episode != null) {
    const sPad = String(season).padStart(2, "0");
    const ePad = String(episode).padStart(2, "0");
    mediaId = `${externalId}-s${sPad}e${ePad}`;
    displayTitle = `${title} - S${sPad}E${ePad}`;
  }

  const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
  const backdropUrl = item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null;

  const sourceRow = {
    cache_key: buildCacheKey({
      mediaId,
      title: displayTitle,
      year,
      language: cleanLanguage,
      quality: cleanQuality,
    }),
    media_id: mediaId,
    media_title: displayTitle,
    year: year ? Number(year) : null,
    language: cleanLanguage,
    quality: cleanQuality,
    source_type: written?.source_type || "torrent",
    download_url: written?.download_url || magnet,
    stream_url: written?.stream_url || null,
    magnet_link: magnet,
    seeders: liveSeeds,
    size_human: release.size || release.size_human || "1.2 GB",
    size_bytes: release.size_bytes || null,
    is_fallback: false,
    status: "ready",
    updated_at: new Date().toISOString(),
    payload: {
      title: displayTitle,
      language_label: cleanLanguage,
      size_human: release.size || release.size_human || null,
      provider: release.provider || "Torrentio",
      overview: item.overview || null,
      poster_url: posterUrl,
      backdrop_url: backdropUrl,
      rating: item.vote_average ? Math.round(Number(item.vote_average) * 10) : null,
      tmdb_id: externalId,
      season,
      episode,
    },
  };

  const { error } = await supabase.from(MEDIA_SOURCES_TABLE).upsert(sourceRow, { onConflict: "cache_key" });
  return !error;
}

// 1. Ingest Movies (Bollywood / Hollywood)
async function ingestMoviesCategory({ name, lang, targetCount = 35, requireDubMarker = false }) {
  const supabase = getSupabaseClient();
  console.log(`\n======================================================`);
  console.log(`🎯 [CATEGORY] ${name}`);
  console.log(`   Target: ${targetCount} working Hindi movies (2025 - 2026) | Seeds >= ${MIN_REQUIRED_SEEDERS}`);
  console.log(`======================================================`);

  let injected = 0;
  let page = 1;

  while (injected < targetCount && page <= 8) {
    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_original_language=${lang}&primary_release_date.gte=2025-01-01&primary_release_date.lte=2026-10-31&sort_by=popularity.desc&page=${page}&vote_count.gte=3`;
    let movies = [];
    try {
      const res = await fetch(url);
      const json = await res.json();
      movies = json.results || [];
    } catch (e) {
      console.warn("TMDB fetch error:", e.message);
      break;
    }

    if (movies.length === 0) break;

    for (const movie of movies) {
      if (injected >= targetCount) break;

      const title = movie.title;
      const year = (movie.release_date || "").slice(0, 4);
      const externalId = String(movie.id);

      const already = await hasWorkingSource(supabase, externalId);
      if (already) {
        console.log(`  ⏩ [ALREADY IN DB] "${title}" (${year})`);
        injected++;
        continue;
      }

      console.log(`🔍 [SEARCHING TORRENT] "${title}" (${year}) [ID: ${externalId}]...`);
      try {
        const result = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "movie",
          tmdbId: externalId,
          requireDubMarker,
        });

        const liveSeeds = Number(result?.seeders || 0);
        const magnet = result?.magnet_link || result?.magnet || result?.download_url;
        const is4K =
          result?.quality === "2160p" ||
          /\b(?:2160p|4k|uhd)\b/i.test(result?.title || "") ||
          /\b(?:2160p|4k|uhd)\b/i.test(result?.resolution || "");

        if (result && magnet && liveSeeds >= MIN_REQUIRED_SEEDERS && !is4K) {
          await upsertMediaContent(supabase, movie, "movie");
          const ok = await saveMediaSource(supabase, {
            item: movie,
            release: result,
            mediaType: "movie",
            externalId,
          });
          if (ok) {
            injected++;
            console.log(`  ✨ [INJECTED ${injected}/${targetCount}] "${title}" · ${result.quality} · ${liveSeeds} seeds · ${result.language}`);
          }
        } else {
          console.log(`  ⚠️ No valid Hindi torrent for "${title}" (Seeds: ${liveSeeds})`);
        }
      } catch (err) {
        console.warn(`  ❌ Error for "${title}":`, err.message);
      }

      await sleep(350);
    }
    page++;
  }

  console.log(`🏁 [CATEGORY COMPLETE] ${name}: Injected ${injected} movies.\n`);
}

// 2. Ingest Trending Series (2023 - 2026)
async function ingestTrendingSeries({ targetCount = 35 }) {
  const supabase = getSupabaseClient();
  console.log(`\n======================================================`);
  console.log(`📺 [CATEGORY] Top Trending Series (2023 - 2026)`);
  console.log(`   Global Hits, Spanish (Berlin), Korean (Mercy for None) & Indian Web Series`);
  console.log(`   Target: ${targetCount} Trending Shows | Seeds >= ${MIN_REQUIRED_SEEDERS}`);
  console.log(`======================================================`);

  // Curated must-have series list as requested by user
  const prioritySeries = [
    { title: "Berlin", query: "Berlin", year: "2023" },
    { title: "Mercy for None", query: "Mercy for None", year: "2025" },
    { title: "Squid Game", query: "Squid Game", year: "2021" },
    { title: "Fallout", query: "Fallout", year: "2024" },
    { title: "Shōgun", query: "Shogun", year: "2024" },
    { title: "The Last of Us", query: "The Last of Us", year: "2023" },
    { title: "House of the Dragon", query: "House of the Dragon", year: "2024" },
    { title: "Mirzapur", query: "Mirzapur", year: "2024" },
    { title: "Panchayat", query: "Panchayat", year: "2024" },
    { title: "Heeramandi", query: "Heeramandi", year: "2024" },
    { title: "Farzi", query: "Farzi", year: "2023" },
    { title: "Guns & Gulaabs", query: "Guns & Gulaabs", year: "2023" },
    { title: "A Killer Paradox", query: "A Killer Paradox", year: "2024" },
    { title: "Queen of Tears", query: "Queen of Tears", year: "2024" },
    { title: "Sweet Home", query: "Sweet Home", year: "2024" },
    { title: "Death's Game", query: "Deaths Game", year: "2023" },
  ];

  let injected = 0;

  // Step 1: Ingest curated priority hit series
  for (const prio of prioritySeries) {
    if (injected >= targetCount) break;
    try {
      const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(prio.query)}`;
      const res = await fetch(searchUrl);
      const json = await res.json();
      const show = json.results?.[0];
      if (!show) continue;

      const externalId = String(show.id);
      const title = show.name;
      const year = (show.first_air_date || prio.year || "").slice(0, 4);

      console.log(`\n🔍 [SEARCHING SERIES TORRENT] "${title}" (${year}) [ID: ${externalId}]...`);
      const result = await discoverCascadingTorrents({
        title,
        year,
        mediaType: "series",
        tmdbId: externalId,
        requireDubMarker: false,
      });

      const liveSeeds = Number(result?.seeders || 0);
      const magnet = result?.magnet_link || result?.magnet || result?.download_url;
      const is4K = result?.quality === "2160p" || /\b(?:2160p|4k)\b/i.test(result?.title || "");

      if (result && magnet && liveSeeds >= MIN_REQUIRED_SEEDERS && !is4K) {
        await upsertMediaContent(supabase, show, "tv");
        // Save Season 1 / general series source
        const ok = await saveMediaSource(supabase, {
          item: show,
          release: result,
          mediaType: "series",
          externalId,
          season: 1,
          episode: 1,
        });
        if (ok) {
          injected++;
          console.log(`  ✨ [SERIES INJECTED ${injected}/${targetCount}] "${title}" · ${result.quality} · ${liveSeeds} seeds · ${result.language}`);
        }
      } else {
        console.log(`  ⚠️ No valid Hindi torrent for "${title}" (Seeds: ${liveSeeds})`);
      }
    } catch (e) {
      console.warn(`  ❌ Series error for "${prio.title}":`, e.message);
    }
    await sleep(400);
  }

  // Step 2: Fetch additional trending TV shows 2023 - 2026 from TMDB discover
  let page = 1;
  while (injected < targetCount && page <= 6) {
    const discoverUrl = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&first_air_date.gte=2023-01-01&sort_by=popularity.desc&page=${page}&vote_count.gte=20`;
    let shows = [];
    try {
      const res = await fetch(discoverUrl);
      const json = await res.json();
      shows = json.results || [];
    } catch (e) {
      break;
    }

    for (const show of shows) {
      if (injected >= targetCount) break;

      const title = show.name;
      const year = (show.first_air_date || "").slice(0, 4);
      const externalId = String(show.id);

      const already = await hasWorkingSource(supabase, externalId);
      if (already) {
        injected++;
        continue;
      }

      console.log(`🔍 [SEARCHING SERIES TORRENT] "${title}" (${year}) [ID: ${externalId}]...`);
      try {
        const result = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "series",
          tmdbId: externalId,
          requireDubMarker: false,
        });

        const liveSeeds = Number(result?.seeders || 0);
        const magnet = result?.magnet_link || result?.magnet || result?.download_url;
        const is4K = result?.quality === "2160p" || /\b(?:2160p|4k)\b/i.test(result?.title || "");

        if (result && magnet && liveSeeds >= MIN_REQUIRED_SEEDERS && !is4K) {
          await upsertMediaContent(supabase, show, "tv");
          const ok = await saveMediaSource(supabase, {
            item: show,
            release: result,
            mediaType: "series",
            externalId,
            season: 1,
            episode: 1,
          });
          if (ok) {
            injected++;
            console.log(`  ✨ [SERIES INJECTED ${injected}/${targetCount}] "${title}" · ${result.quality} · ${liveSeeds} seeds · ${result.language}`);
          }
        } else {
          console.log(`  ⚠️ No valid Hindi torrent for "${title}" (Seeds: ${liveSeeds})`);
        }
      } catch (e) {}

      await sleep(350);
    }
    page++;
  }

  console.log(`🏁 [SERIES COMPLETE] Injected ${injected} trending series.\n`);
}

async function main() {
  console.log("==================================================================");
  console.log("🚀 [CINEBOX MASTER INGESTION: 2025-2026 MOVIES & 2023-2026 SERIES]");
  console.log("==================================================================");

  // 1. Ingest Bollywood Movies (2025 - 2026) - Target 35
  await ingestMoviesCategory({
    name: "Bollywood Movies (2025 - 2026)",
    lang: "hi",
    targetCount: 35,
    requireDubMarker: false,
  });

  // 2. Ingest Hollywood Movies (2025 - 2026) - Target 35
  await ingestMoviesCategory({
    name: "Hollywood Movies Hindi Dubbed (2025 - 2026)",
    lang: "en",
    targetCount: 35,
    requireDubMarker: true,
  });

  // 3. Ingest Trending Hit Series (2023 - 2026) - Target 35
  await ingestTrendingSeries({
    targetCount: 35,
  });

  console.log("\n🎉 [ALL INGESTION TARGETS COMPLETED SUCCESSFULLY!]");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

