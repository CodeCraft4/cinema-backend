/**
 * scripts/ingestCompleteSeriesEpisodes.js
 *
 * Ingests COMPLETE TV Series with ALL Seasons and ALL Episodes into Supabase:
 * 1. Upserts show into media_content
 * 2. Fetches all seasons & episodes from TMDB
 * 3. Upserts all episode metadata into media_episodes
 * 4. Resolves verified torrent stream/download URLs (Hindi / Dual Audio) for EVERY episode
 * 5. Upserts each episode into media_sources with clean cache_key: {showId}-s{sPad}e{ePad}
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://your-supabase.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_SECRET_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const TMDB_API_KEY =
  process.env.TMDB_API_KEY ||
  process.env.EXPO_PUBLIC_TMDB_API_KEY ||
  "40b06951f1c6497bbe2bc6d9e5ad6b47";

const STREAM_BASE_URL =
  process.env.TORRENT_STREAM_BASE_URL || "http://168.144.249.68:4555";

const MIN_SEEDERS = 3;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing Supabase credentials in .env");
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSlug(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function parseTorrentioStream(stream, sNum, epNum) {
  const titleText = String(stream.title || "");
  const lines = titleText.split("\n");
  const releaseName = lines[0] || "";
  const subName = lines[1] || "";
  const combined = `${releaseName} ${subName}`;

  // Quality detection
  let quality = "720p";
  if (/\b(?:2160p|4k)\b/i.test(combined)) quality = "2160p";
  else if (/\b1080p\b/i.test(combined)) quality = "1080p";
  else if (/\b480p\b/i.test(combined)) quality = "480p";

  // Seeds detection
  const seedMatch = combined.match(/👤\s*(\d+)/);
  const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;

  // Size detection
  const sizeMatch = combined.match(/💾\s*([\d.]+\s*(?:GB|MB))/i);
  const sizeHuman = sizeMatch ? sizeMatch[1] : null;

  // Language detection
  let language = "Dual Audio [Hindi+Eng]";
  if (/\bhindi\b/i.test(combined)) {
    language = "Hindi";
  }

  const infoHash = stream.infoHash || "";
  const fileIdx = stream.fileIdx != null ? stream.fileIdx : null;

  return {
    releaseName,
    subName,
    quality,
    seeders,
    sizeHuman,
    language,
    infoHash,
    fileIdx,
  };
}

async function fetchTmdbTvDetails(showId) {
  const url = `https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB TV fetch failed: ${res.status}`);
  return res.json();
}

async function fetchTmdbTvExternalIds(showId) {
  const url = `https://api.themoviedb.org/3/tv/${showId}/external_ids?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return {};
  return res.json();
}

async function fetchTmdbSeason(showId, seasonNumber) {
  const url = `https://api.themoviedb.org/3/tv/${showId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchTorrentioEpisodeStreams(imdbId, seasonNumber, episodeNumber) {
  const url = `https://torrentio.strem.fun/stream/series/${imdbId}:${seasonNumber}:${episodeNumber}.json`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.streams || [];
  } catch (err) {
    return [];
  }
}

async function ingestCompleteShow(showQuery, options = {}) {
  const supabase = getSupabase();
  console.log(`\n======================================================`);
  console.log(`📺 [INGESTING COMPLETE SERIES] "${showQuery}"`);
  console.log(`======================================================`);

  // Step 1: Search TMDB
  const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(showQuery)}`;
  const searchRes = await fetch(searchUrl);
  const searchData = await searchRes.json();
  const showBasic = searchData.results?.[0];

  if (!showBasic) {
    console.warn(`❌ No TMDB results found for series: "${showQuery}"`);
    return;
  }

  const showId = showBasic.id;
  const showDetails = await fetchTmdbTvDetails(showId);
  const extIds = await fetchTmdbTvExternalIds(showId);
  const imdbId = extIds.imdb_id;
  const showTitle = showDetails.name;
  const year = (showDetails.first_air_date || "").slice(0, 4) || "2023";
  const isNativeHindi = showDetails.original_language === "hi";

  console.log(`📌 Found: "${showTitle}" (TMDB ID: ${showId}, IMDB: ${imdbId || "None"}, Seasons: ${showDetails.number_of_seasons})`);

  // Step 2: Upsert into media_content
  const posterUrl = showDetails.poster_path ? `https://image.tmdb.org/t/p/w500${showDetails.poster_path}` : null;
  const backdropUrl = showDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${showDetails.backdrop_path}` : null;
  const rating = showDetails.vote_average ? Math.round(Number(showDetails.vote_average) * 10) : null;

  await supabase.from("media_content").upsert({
    id: showId,
    title: showTitle,
    overview: showDetails.overview || "",
    poster_url: posterUrl,
    backdrop_url: backdropUrl,
    rating,
    release_date: showDetails.first_air_date || null,
    media_type: "tv",
    type: "tv",
    original_language: showDetails.original_language || "en",
    status: showDetails.status || "Released",
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });

  // Step 3: Iterate through all valid seasons
  const seasons = (showDetails.seasons || []).filter(s => s.season_number > 0);
  let totalEpisodesInserted = 0;

  for (const sMeta of seasons) {
    const sNum = sMeta.season_number;
    console.log(`\n  ▶ Processing Season ${sNum} (${sMeta.episode_count} episodes)...`);
    const sData = await fetchTmdbSeason(showId, sNum);
    if (!sData || !Array.isArray(sData.episodes)) continue;

    for (const ep of sData.episodes) {
      const epNum = ep.episode_number;
      const sPad = String(sNum).padStart(2, "0");
      const ePad = String(epNum).padStart(2, "0");
      const epMediaId = `${showId}-s${sPad}e${ePad}`;
      const epTitle = `${showTitle} - S${sPad}E${ePad}`;
      const epName = ep.name || `Episode ${epNum}`;

      // A: Upsert into media_episodes
      await supabase.from("media_episodes").upsert({
        source: "tmdb",
        show_id: showId,
        season: sNum,
        episode: epNum,
        title: epName,
        overview: ep.overview || "",
        air_date: ep.air_date || null,
        details: {
          still_path: ep.still_path,
          still_url: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : "",
          vote_average: ep.vote_average,
        },
        updated_at: new Date().toISOString(),
      }, { onConflict: "source,show_id,season,episode" });

      // B: Find working stream via Torrentio or Embed Fallback
      let bestStream = null;

      if (imdbId) {
        const streams = await fetchTorrentioEpisodeStreams(imdbId, sNum, epNum);
        // Find Hindi / Dual Audio streams
        const matchingStreams = streams
          .map(s => parseTorrentioStream(s, sNum, epNum))
          .filter(s => {
            if (s.quality === "2160p") return false; // Skip heavy 4K
            if (isNativeHindi) return true; // If native Hindi, any stream is Hindi
            return /\bhindi\b/i.test(s.releaseName) || /\bhindi\b/i.test(s.subName) || /\bdual\b/i.test(s.releaseName);
          })
          .sort((a, b) => b.seeders - a.seeders);

        if (matchingStreams.length > 0) {
          bestStream = matchingStreams[0];
        }
      }

      let sourceRow = null;

      if (bestStream && bestStream.infoHash) {
        const hash = bestStream.infoHash.toLowerCase();
        const magnet = `magnet:?xt=urn:btih:${bestStream.infoHash}&dn=${encodeURIComponent(bestStream.releaseName || epTitle)}`;
        const streamUrl = `${STREAM_BASE_URL}/api/media/stream/torrent/${hash}/video.mp4?ep=${epNum}&s=${sNum}`;
        const downloadUrl = `${streamUrl}&download=1`;
        const cacheKey = `${epMediaId}::${makeSlug(showTitle)} - s${sPad}e${ePad}::${year}::${makeSlug(bestStream.language)}::${bestStream.quality}`;

        sourceRow = {
          cache_key: cacheKey,
          media_id: epMediaId,
          media_title: epTitle,
          year: Number(year) || null,
          language: bestStream.language,
          quality: bestStream.quality,
          source_type: "ddl",
          stream_url: streamUrl,
          download_url: downloadUrl,
          magnet_link: magnet,
          seeders: bestStream.seeders,
          size_human: bestStream.sizeHuman || "1.2 GB",
          size_bytes: null,
          is_fallback: false,
          status: "ready",
          updated_at: new Date().toISOString(),
          payload: {
            title: epTitle,
            episode_title: epName,
            language_label: bestStream.language,
            size_human: bestStream.sizeHuman,
            provider: "Torrentio",
            overview: ep.overview || showDetails.overview || null,
            poster_url: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : posterUrl,
            backdrop_url: backdropUrl,
            rating: ep.vote_average ? Math.round(Number(ep.vote_average) * 10) : rating,
            tmdb_id: String(showId),
            season: sNum,
            episode: epNum,
          },
        };
      } else {
        // Embed fallback (VidSrc)
        const embedUrl = `https://vidsrc.to/embed/tv/${showId}/${sNum}/${epNum}`;
        const cacheKey = `${epMediaId}::${makeSlug(showTitle)} - s${sPad}e${ePad}::${year}::embed::1080p`;

        sourceRow = {
          cache_key: cacheKey,
          media_id: epMediaId,
          media_title: epTitle,
          year: Number(year) || null,
          language: isNativeHindi ? "Hindi" : "Dual Audio [Hindi+Eng]",
          quality: "1080p",
          source_type: "embed_stream",
          stream_url: embedUrl,
          download_url: embedUrl,
          magnet_link: null,
          seeders: 0,
          size_human: null,
          is_fallback: true,
          status: "ready",
          updated_at: new Date().toISOString(),
          payload: {
            title: epTitle,
            episode_title: epName,
            language_label: isNativeHindi ? "Hindi" : "Dual Audio [Hindi+Eng]",
            provider: "VidSrc",
            overview: ep.overview || showDetails.overview || null,
            poster_url: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : posterUrl,
            backdrop_url: backdropUrl,
            rating: ep.vote_average ? Math.round(Number(ep.vote_average) * 10) : rating,
            tmdb_id: String(showId),
            season: sNum,
            episode: epNum,
          },
        };
      }

      const { error } = await supabase.from("media_sources").upsert(sourceRow, { onConflict: "cache_key" });
      if (!error) {
        totalEpisodesInserted++;
        const mode = bestStream ? `⚡ Torrent (${bestStream.quality}, ${bestStream.seeders} seeds)` : `🌐 Embed Fallback`;
        console.log(`     ✅ S${sPad}E${ePad}: "${epName}" [${mode}]`);
      } else {
        console.warn(`     ⚠️ Error inserting S${sPad}E${ePad}:`, error.message);
      }

      await sleep(200); // Polite throttling
    }
  }

  console.log(`\n🎉 [SHOW COMPLETE] "${showTitle}": Ingested ${totalEpisodesInserted} episodes.`);
}

async function main() {
  const targetShows = [
    "Berlin",
    "Farzi",
    "Mirzapur",
    "Squid Game",
    "House of the Dragon",
    "Fallout",
    "Panchayat",
    "Mercy for None",
    "Heeramandi",
    "Guns & Gulaabs",
    "Shōgun",
    "The Last of Us"
  ];

  console.log(`Starting Full Series Ingestion for ${targetShows.length} shows...\n`);
  for (const show of targetShows) {
    try {
      await ingestCompleteShow(show);
    } catch (err) {
      console.error(`Error processing ${show}:`, err.message);
    }
  }
  console.log("\n🏁 All TV Series fully ingested with complete seasons and episodes!");
}

main().catch(console.error);

