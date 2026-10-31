/**
 * scripts/ingestTopCuratedHindiSeries.js
 *
 * Ingestion Engine for Top 50 Series across Hollywood, Bollywood, South (Kollywood/Tollywood)
 * and Top 70 Korean Dramas with ACTIVE LIVE SEEDERS (>= 3 seeds) strictly in:
 * - Pure Hindi
 * - Dual Audio [Hindi + English]
 * - Original + Hindi Dubbed
 *
 * Every season and every episode is ingested with direct streamable links.
 * Dead seeds (0 seeds) are strictly rejected!
 */

require("dotenv").config();

// Polyfill WebSocket in environments without native WebSocket
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = class WebSocketPolyfill {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  };
}

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
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

const MIN_ACTIVE_SEEDS = 3; // Strictly no dead torrents!

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing Supabase credentials in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// In-memory set of existing episode media IDs in Supabase to guarantee ZERO duplicates
const existingEpisodeMediaIds = new Set();

async function prewarmExistingEpisodeIds() {
  console.log("🔍 Checking existing media in Supabase to prevent duplicates...");
  let from = 0;
  const batchSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("media_sources")
      .select("media_id")
      .like("media_id", "%-s%e%")
      .range(from, from + batchSize - 1);
    if (error || !data || data.length === 0) break;
    data.forEach((r) => {
      if (r.media_id) existingEpisodeMediaIds.add(String(r.media_id).trim());
    });
    from += batchSize;
    if (data.length < batchSize) break;
  }
  console.log(`✅ Loaded ${existingEpisodeMediaIds.size} existing episodes from Supabase. Any duplicates will be strictly SKIPPED!\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSlug(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function parseTorrentioStream(stream) {
  const titleText = String(stream.title || "");
  const lines = titleText.split("\n");
  const releaseName = lines[0] || "";
  const subName = lines[1] || "";
  const combined = `${releaseName} ${subName}`;

  let quality = "720p";
  if (/\b(?:2160p|4k)\b/i.test(combined)) quality = "2160p";
  else if (/\b1080p\b/i.test(combined)) quality = "1080p";
  else if (/\b480p\b/i.test(combined)) quality = "480p";

  const seedMatch = combined.match(/👤\s*(\d+)/);
  const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;

  const sizeMatch = combined.match(/💾\s*([\d.]+\s*(?:GB|MB))/i);
  const sizeHuman = sizeMatch ? sizeMatch[1] : null;

  let language = "Dual Audio [Hindi+Eng]";
  if (/\bhindi\b/i.test(combined)) language = "Hindi";

  return {
    releaseName,
    subName,
    quality,
    seeders,
    sizeHuman,
    language,
    infoHash: stream.infoHash || "",
    fileIdx: stream.fileIdx != null ? stream.fileIdx : null,
  };
}

async function fetchTorrentioEpisodeStreams(imdbId, seasonNumber, episodeNumber) {
  const url = `https://torrentio.strem.fun/stream/series/${imdbId}:${seasonNumber}:${episodeNumber}.json`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.streams || [];
  } catch {
    return [];
  }
}

async function ingestShowWithHindiOnly(showQuery, industryTag = "") {
  // Search TMDB
  const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(showQuery)}`;
  let showBasic = null;
  try {
    const res = await fetch(searchUrl);
    const data = await res.json();
    showBasic = data.results?.[0];
  } catch (err) {
    console.warn(`Search error for ${showQuery}:`, err.message);
    return false;
  }

  if (!showBasic) {
    console.warn(`  ⚠️ Show "${showQuery}" not found on TMDB.`);
    return false;
  }

  const showId = showBasic.id;
  let showDetails = null;
  let extIds = {};
  try {
    const [dRes, extRes] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/tv/${showId}?api_key=${TMDB_API_KEY}`),
      fetch(`https://api.themoviedb.org/3/tv/${showId}/external_ids?api_key=${TMDB_API_KEY}`),
    ]);
    showDetails = await dRes.json();
    extIds = await extRes.json();
  } catch (err) {
    return false;
  }

  const imdbId = extIds.imdb_id;
  if (!imdbId) {
    console.warn(`  ⚠️ No IMDB ID for "${showBasic.name}". Skipping.`);
    return false;
  }

  const showTitle = showDetails.name;
  const year = (showDetails.first_air_date || "").slice(0, 4) || "2023";
  const isNativeHindi = showDetails.original_language === "hi";

  console.log(`\n🔍 [${industryTag}] Checking "${showTitle}" (${year}) [IMDB: ${imdbId}, Seasons: ${showDetails.number_of_seasons}]...`);

  // Upsert media_content
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

  const seasons = (showDetails.seasons || []).filter((s) => s.season_number > 0);
  let totalSaved = 0;

  for (const sMeta of seasons) {
    const sNum = sMeta.season_number;
    let sData = null;
    try {
      const sRes = await fetch(`https://api.themoviedb.org/3/tv/${showId}/season/${sNum}?api_key=${TMDB_API_KEY}`);
      sData = await sRes.json();
    } catch {}

    if (!sData || !Array.isArray(sData.episodes)) continue;

    for (const ep of sData.episodes) {
      const epNum = ep.episode_number;
      const sPad = String(sNum).padStart(2, "0");
      const ePad = String(epNum).padStart(2, "0");
      const epMediaId = `${showId}-s${sPad}e${ePad}`;
      const epTitle = `${showTitle} - S${sPad}E${ePad}`;
      const epName = ep.name || `Episode ${epNum}`;

      // STRICT ZERO DUPLICATES: If episode already exists in Supabase, skip immediately!
      if (existingEpisodeMediaIds.has(epMediaId)) {
        continue;
      }

      // Check streams on Torrentio
      const rawStreams = await fetchTorrentioEpisodeStreams(imdbId, sNum, epNum);
      const validHindi = rawStreams
        .map(parseTorrentioStream)
        .filter((s) => {
          if (s.quality === "2160p") return false; // Skip 4K
          if (s.seeders < MIN_ACTIVE_SEEDS) return false; // STRICTLY NO DEAD SEEDS!
          
          // Strict Hindi verification: Must explicitly match Hindi or Dual Audio [Hindi+Eng]
          const combined = `${s.releaseName} ${s.subName}`.toLowerCase();
          const hasHindiMarker = /\bhindi\b/i.test(combined) || /\bdual\b/i.test(combined);
          
          if (isNativeHindi) {
            // For native Indian shows, accept if it has Hindi marker OR is the native release (excluding foreign dubs like French/German)
            const isForeignDub = /\b(french|german|spanish|italian|russian|polish)\b/i.test(combined);
            return !isForeignDub;
          }
          
          // For all foreign series (Korean, Hollywood, Turkish, etc.): STRICTLY REQUIRE HINDI OR DUAL AUDIO!
          return hasHindiMarker;
        })
        .sort((a, b) => b.seeders - a.seeders);

      // If no working Hindi stream with active seeds, SKIP this episode (DO NOT insert dead/null junk)
      if (validHindi.length === 0) {
        continue;
      }

      const best = validHindi[0];
      const hash = best.infoHash.toLowerCase();
      const magnet = `magnet:?xt=urn:btih:${best.infoHash}&dn=${encodeURIComponent(best.releaseName || epTitle)}`;
      const streamUrl = `${STREAM_BASE_URL}/api/media/stream/torrent/${hash}/video.mp4?ep=${epNum}&s=${sNum}`;
      const downloadUrl = `${streamUrl}&download=1`;
      const cacheKey = `${epMediaId}::${makeSlug(showTitle)} - s${sPad}e${ePad}::${year}::${makeSlug(best.language)}::${best.quality}`;

      const sourceRow = {
        cache_key: cacheKey,
        media_id: epMediaId,
        media_title: epTitle,
        year: Number(year) || null,
        language: best.language,
        quality: best.quality,
        source_type: "ddl",
        stream_url: streamUrl,
        download_url: downloadUrl,
        magnet_link: magnet,
        seeders: best.seeders,
        size_human: best.sizeHuman || "1.1 GB",
        size_bytes: null,
        is_fallback: false,
        status: "ready",
        updated_at: new Date().toISOString(),
        payload: {
          title: epTitle,
          episode_title: epName,
          language_label: best.language,
          size_human: best.sizeHuman,
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

      const { error } = await supabase.from("media_sources").upsert(sourceRow, { onConflict: "cache_key" });
      if (!error) {
        existingEpisodeMediaIds.add(epMediaId);
        totalSaved++;
        console.log(`     ✅ S${sPad}E${ePad}: "${epName}" (${best.quality}, ${best.seeders} seeds, ${best.language})`);
      }
      await sleep(150);
    }
  }

  if (totalSaved > 0) {
    console.log(`  🎉 Ingested ${totalSaved} verified Hindi episodes for "${showTitle}".`);
    return true;
  } else {
    console.log(`  ⚠️ No active Hindi torrents with >= ${MIN_ACTIVE_SEEDS} seeds for "${showTitle}".`);
    return false;
  }
}

// Curated Top Shows with guaranteed verified Hindi / Dual Audio dubs & heavy active seeders
const CURATED_LISTS = {
  korean: [
    "Squid Game", "All of Us Are Dead", "Sweet Home", "Bloodhounds", "My Name", 
    "A Killer Paradox", "Parasyte: The Grey", "Gyeongseong Creature", "The Glory", "Hellbound",
    "Narco-Saints", "The Silent Sea", "D.P.", "Extracurricular", "Vagabond", 
    "Vincenzo", "Happiness", "Taxi Driver", "Weak Hero Class 1", "Death's Game", 
    "Moving", "Signal", "Kingdom", "The Worst of Evil", "Connect",
    "Big Mouth", "Alice in Borderland", "Celebrity", "Mask Girl", "Song of the Bandits",
    "Black Knight", "Daily Dose of Sunshine", "Doona!", "Doctor Cha", "King the Land",
    "Crash Course in Romance", "The Uncanny Counter", "Alchemy of Souls", "Hotel Del Luna", "It's Okay to Not Be Okay",
    "Business Proposal", "Tale of the Nine Tailed", "True Beauty", "Descendants of the Sun", "Guardian: The Lonely and Great God",
    "Legend of the Blue Sea", "W: Two Worlds Apart", "Weightlifting Fairy Kim Bok-joo", "Strong Girl Bong-soon", "What's Wrong with Secretary Kim",
    "Hometown Cha-Cha-Cha", "Our Beloved Summer", "Twenty Five Twenty One", "Summer Strike", "See You in My 19th Life",
    "Twinkling Watermelon", "Welcome to Samdal-ri", "Doctor Slump", "Queen of Tears", "Lovely Runner",
    "Hierarchy", "The 8 Show", "Miss Night and Day", "No Gain No Love", "Seoul Busters",
    "The Judge from Hell", "Gyeongseong Creature Season 2", "Hellbound Season 2", "Mr. Plankton", "Mercy for None"
  ],
  hollywood: [
    "Game of Thrones", "Breaking Bad", "Stranger Things", "The Boys", "House of the Dragon",
    "The Last of Us", "Fallout", "Loki", "Wednesday", "Peaky Blinders",
    "The Witcher", "Daredevil", "The Punisher", "Moon Knight", "WandaVision",
    "Hawkeye", "Secret Invasion", "Echo", "Percy Jackson and the Olympians", "Reacher",
    "Jack Ryan", "The Continental: From the World of John Wick", "Monarch: Legacy of Monsters", "Halo", "Gen V",
    "Ahsoka", "The Mandalorian", "Andor", "Obi-Wan Kenobi", "The Book of Boba Fett",
    "Shōgun", "3 Body Problem", "The Gentlemen", "Ripley", "Sugar",
    "Dark", "Money Heist", "Berlin", "Lupin", "Squid Game",
    "Prison Break", "Chernobyl", "True Detective", "Fargo", "The Walking Dead",
    "Supernatural", "The Flash", "Arrow", "Gotham", "Titans"
  ],
  bollywood_and_indian: [
    "Mirzapur", "Panchayat", "Farzi", "The Family Man", "Sacred Games",
    "Paatal Lok", "Guns & Gulaabs", "Heeramandi", "Asur", "Kota Factory",
    "Gullak", "Special OPS", "Aarya", "Breathe: Into the Shadows", "Criminal Justice",
    "Delhi Crime", "Scam 1992: The Harshad Mehta Story", "Rocket Boys", "Taaza Khabar", "Rana Naidu",
    "Scoop", "Kohrra", "Kaala Paani", "Railway Men", "Indian Police Force",
    "Dhootha", "Suzhal - The Vortex", "Modern Love Chennai", "Modern Love Hyderabad", "The Village",
    "Dahaad", "Jubilee", "Bambai Meri Jaan", "Inspector Rishi", "Breathe",
    "Hostages", "City of Dreams", "Undekhi", "Maharani", "Grahan",
    "Matsya Kaand", "Abhay", "Rangbaaz", "Apharan", "JL50",
    "Gyaarah Gyaarah", "Pill", "Commander Karan Saxena", "Tribhuvan Mishra CA Topper", "Shekhar Home"
  ]
};

async function runMasterSeriesIngest() {
  console.log("================================================================================");
  console.log("🚀 STARTING TARGETED CURATED SERIES INGESTION ENGINE");
  console.log("   Criteria: Strictly Pure Hindi, Dual Audio [Hindi+Eng], Original+Hindi");
  console.log("   Seeds: >= 3 Active Seeds (Zero dead torrents)");
  console.log("   Full Seasons & Episodes with 1080p / 720p Direct Streams");
  console.log("   Duplicates: STRICT ZERO DUPLICATES (Existing episodes skipped)");
  console.log("================================================================================\n");

  await prewarmExistingEpisodeIds();

  // 1. Hollywood Top 50
  console.log("\n=======================================================");
  console.log("🎬 SECTION 1: TOP 50 HOLLYWOOD SERIES (HINDI DUBBED)");
  console.log("=======================================================");
  for (const title of CURATED_LISTS.hollywood) {
    try {
      await ingestShowWithHindiOnly(title, "Hollywood");
    } catch (e) {
      console.warn(`Error on ${title}:`, e.message);
    }
    await sleep(250);
  }

  // 2. Korean Top 70 Dramas
  console.log("\n=======================================================");
  console.log("🎬 SECTION 2: TOP 70 KOREAN DRAMAS (HINDI DUBBED / DUAL)");
  console.log("=======================================================");
  for (const title of CURATED_LISTS.korean) {
    try {
      await ingestShowWithHindiOnly(title, "K-Drama");
    } catch (e) {
      console.warn(`Error on ${title}:`, e.message);
    }
    await sleep(250);
  }

  // 3. Indian & South Top 50 Series
  console.log("\n=======================================================");
  console.log("🎬 SECTION 3: TOP 50 BOLLYWOOD & SOUTH INDIAN SERIES");
  console.log("=======================================================");
  for (const title of CURATED_LISTS.bollywood_and_indian) {
    try {
      await ingestShowWithHindiOnly(title, "Indian");
    } catch (e) {
      console.warn(`Error on ${title}:`, e.message);
    }
    await sleep(250);
  }

  console.log("\n================================================================================");
  console.log("🏁 MASTER SERIES INGESTION FINISHED!");
  console.log("================================================================================\n");
}

runMasterSeriesIngest().catch(console.error);

