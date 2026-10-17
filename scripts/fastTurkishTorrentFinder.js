"use strict";

/**
 * ⚡ Ultra-Fast Turkish Series & Movies Urdu / Hindi Torrent Finder & Saver
 * 
 * Purpose:
 * - Scans Turkish titles in Supabase `media_content` (origin_country includes "TR")
 * - Discovers Urdu Dubbed, Hindi Dubbed & Dual Audio streams via Torrentio & Cascading Indexers
 * - Uses both English and Original Turkish titles (e.g., "Diriliş: Ertuğrul" / "Kuruluş Osman")
 * - Saves high-speed Railway streaming & download URLs directly to Supabase `media_sources`
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents } = require("../server/services/torrentResolver");

const CONCURRENCY = 6;
const QUERY_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TURKISH_KNOWN_ALIASES = {
  34899: ["Mera Sultan", "Muhtesem Yuzyil Urdu"], // The Magnificent Century
  67570: ["Pyaar Lafzon Mein Kahan", "Pyar Lafzon Mein Kahan", "Ask Laftan Anlamaz Hindi"], // Aşk Laftan Anlamaz
  66433: ["Dirilis Ertugrul Urdu", "Ertugrul Ghazi Urdu", "Ertugrul Urdu"], // Diriliş: Ertuğrul
  95603: ["Kurulus Osman Urdu", "Kurulus Osman Hindi", "Kurulus Osman S01 Urdu"], // Kuruluş Osman
  80411: ["Daydreamer Hindi Dubbed", "Day Dreamer Hindi", "Erkenci Kus Hindi"], // Erkenci Kuş
  65555: ["Kara Sevda Hindi", "Kara Sevda Urdu", "Endless Love Hindi Dubbed"], // Endless Love
  104877: ["Sen Cal Kapimi Hindi", "Sen Cal Kapimi Urdu", "Love Is In The Air Hindi Dubbed"], // Love Is in the Air
  70783: ["Payitaht Abdulhamid Urdu", "Abdul Hamid Urdu"], // Payitaht Abdülhamid
  72637: ["Yunus Emre Urdu", "Rah e Ishq Urdu"], // Yunus Emre
  87623: ["Hercai Urdu", "Hercai Hindi Dubbed"], // Hercai
  138171: ["Alparslan Buyuk Selcuklu Urdu", "Alparslan Urdu"], // Alparslan: The Great Seljuks
  110655: ["Uyanis Buyuk Selcuklu Urdu", "The Great Seljuks Urdu"], // The Great Seljuks
  637920: ["Miracle in Cell No 7 Hindi", "Miracle in Cell No 7 Dual Audio"], // Miracle in Cell No. 7
  7723: ["The Promise Urdu", "Yemin Urdu"], // The Promise
  73506: ["Dolunay Hindi Dubbed", "Dolunay Urdu", "Full Moon Hindi"], // Full Moon
  63549: ["Kiralik Ask Hindi", "Kiralik Ask Urdu"], // Love for Rent
  119806: ["Teskilat Urdu", "The Shadow Team Urdu"], // The Shadow Team
  213194: ["Kizilcik Serbeti Urdu", "Kizilcik Serbeti Hindi"], // Kızılcık Şerbeti
  231503: ["Yabani Urdu", "Yabani Hindi"], // Wild Heart
  241020: ["Kizil Goncalar Urdu", "Kizil Goncalar Hindi"], // Red Roses
  70798: ["Istanbullu Gelin Urdu", "Bride of Istanbul Urdu"], // Bride of Istanbul
  77026: ["Sen Anlat Karadeniz Urdu", "Sen Anlat Karadeniz Hindi"], // Sen Anlat Karadeniz
  76560: ["Fazilet Hanim ve Kizlari Urdu", "Mrs Fazilet Urdu"], // Mrs. Fazilet and Her Daughters
  110562: ["Sadakatsiz Urdu", "A Woman Scorned Urdu"], // A Woman Scorned
  133490: ["Yargi Urdu", "Family Secrets Urdu"], // Family Secrets
};

async function getExistingCoveredIds(supabase) {
  const coveredSet = new Set();
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("media_sources")
      .select("media_id, language")
      .range(offset, offset + limit - 1);

    if (error || !data || data.length === 0) break;
    data.forEach((r) => {
      // ONLY consider covered if it's an authentic Hindi, Urdu, or Dual Audio source!
      if (r.media_id && r.language && r.language !== "English") {
        const baseId = String(r.media_id).split(":")[0];
        coveredSet.add(Number(baseId));
      }
    });
    if (data.length < limit) break;
    offset += limit;
  }
  return coveredSet;
}

function cleanTurkishTitle(str) {
  if (!str) return "";
  return String(str)
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[:;!?.,&'"`~@#$%^*()_+\-=[\]{}|\\/<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function processTurkishItem(item, supabase) {
  const mediaId = Number(item.id);
  const details = item.details || {};
  const tmdbId = item.external_id || details.tmdb_id;
  const title = item.title || details.title;
  const origTitle = details.original_title || title;
  const mediaType = item.media_type || details.media_type || "series";
  const year = details.year || String(details.release_date || details.first_air_date || "").slice(0, 4) || "";
  const overview = details.overview || details.description || "";
  const posterUrl =
    details.poster_url ||
    details.poster ||
    (details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : "");
  const backdropUrl =
    details.backdrop_url ||
    details.backdrop ||
    (details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : "");
  const rating = details.rating_percent || (details.vote_average ? Math.round(Number(details.vote_average) * 10) : null);
  const imdbId = details.imdb_id;
  const seasons = details.seasons || [];

  if (!title) return { status: "skipped", reason: "no title" };

  try {
    const isSeries = mediaType === "series" || mediaType === "tv";
    const cleanOrig = cleanTurkishTitle(origTitle);
    const cleanEng = cleanTurkishTitle(title);
    const aliases = TURKISH_KNOWN_ALIASES[tmdbId] || TURKISH_KNOWN_ALIASES[mediaId] || [];

    const queries = isSeries
      ? [
          ...aliases,
          `${cleanOrig} Urdu`,
          `${cleanEng} Urdu`,
          `${cleanOrig} Urdu Dubbed`,
          `${cleanEng} Urdu Dubbed`,
          `${cleanOrig} Hindi Dubbed`,
          `${cleanEng} Hindi Dubbed`,
          `${cleanOrig} Dual Audio`,
          `${cleanEng} Dual Audio`,
          `${cleanOrig} Hindi`,
          `${cleanEng} Hindi`,
        ]
      : [
          ...aliases,
          `${cleanOrig} Urdu`,
          `${cleanEng} Urdu`,
          `${cleanOrig} Hindi Dubbed`,
          `${cleanEng} Hindi Dubbed`,
          `${cleanOrig} Dual Audio`,
          `${cleanEng} Dual Audio`,
          `${cleanOrig} Urdu Dubbed`,
          `${cleanEng} Urdu Dubbed`,
          `${cleanOrig} Hindi`,
          `${cleanEng} Hindi`,
        ];

    // Remove duplicates
    const uniqueQueries = [...new Set(queries.filter(Boolean))];

    const result = await discoverCascadingTorrents({
      title: cleanOrig || cleanEng || title,
      year,
      mediaType: isSeries ? "tv" : "movie",
      tmdbId,
      imdbId,
      requireDubMarker: true, // STRICT Hindi, Dual Audio, or Urdu only! NEVER English!
      queryTimeoutMs: QUERY_TIMEOUT_MS,
      allowEmbed: false,
      queries: uniqueQueries,
    });

    if (!result || result.success === false) {
      return { status: "not_found", title };
    }

    const best = Array.isArray(result) ? result[0] : result;
    const magnet = best.magnet_link || best.magnet || best.download_url;
    if (!magnet || !/^magnet:/i.test(magnet)) {
      return { status: "not_found", title };
    }

    const language = best.language || best.language_label || "Hindi";
    if (language === "English") {
      return { status: "not_found", title }; // Absolutely skip English!
    }

    // 1. Save directly to media_sources table for the overall mediaId
    await saveTorrentRelease(
      {
        mediaId: tmdbId || mediaId,
        imdbId,
        title,
        year,
        mediaType,
        overview,
        posterUrl,
        backdropUrl,
        rating,
      },
      {
        title: best.title || best.name || `${title} (${language})`,
        magnet_link: magnet,
        download_url: magnet,
        quality: best.quality || best.resolution || "1080p",
        language_label: language,
        seeders: best.seeds || best.seeders || 10,
        size_bytes: best.sizeBytes || best.size_bytes || null,
        size_human: best.sizeHuman || best.size_human || "",
      }
    );

    // 2. If it's a TV series, also map Season 1 row so episode queries match immediately
    if (isSeries && seasons.length > 0) {
      try {
        await saveTorrentRelease(
          {
            mediaId: tmdbId || mediaId,
            imdbId,
            title: `${title} - Season 1`,
            year,
            mediaType: "series",
            season: 1,
            overview: seasons[0]?.overview || overview,
            posterUrl: seasons[0]?.poster_url || posterUrl,
            backdropUrl,
            rating,
          },
          {
            title: best.title || `${title} S01 (${language})`,
            magnet_link: magnet,
            download_url: magnet,
            quality: best.quality || "1080p",
            language_label: language,
            seeders: best.seeds || best.seeders || 10,
            size_bytes: best.sizeBytes || best.size_bytes || null,
            size_human: best.sizeHuman || "",
            season: 1,
          }
        );
      } catch (_) {}
    }

    return {
      status: "saved",
      title,
      release: best.title,
      language,
      quality: best.quality || "1080p",
      seeds: best.seeds || best.seeders || 5,
    };
  } catch (err) {
    return { status: "error", title, error: err.message };
  }
}

async function run() {
  console.log("===============================================================================");
  console.log(" ⚡ Fast Turkish Series & Movies Urdu / Hindi Torrent Resolver");
  console.log(` Concurrency: ${CONCURRENCY} parallel workers | Streams point to Railway Backend`);
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();

  console.log("🔍 Scanning existing media_sources in Supabase to avoid re-resolving...");
  const coveredSet = await getExistingCoveredIds(supabase);
  console.log(`✅ Found ${coveredSet.size} already covered titles in media_sources.\n`);

  // Load all Turkish titles from media_content
  console.log("🔍 Loading Turkish titles from media_content...");
  let offset = 0;
  const batchSize = 1000;
  let allTurkish = [];

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, external_id, title, media_type, details")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error || !data || data.length === 0) break;

    const filtered = data.filter((row) => {
      const origCountry = row.details?.origin_country || [];
      const origLang = row.details?.original_language || "";
      return origCountry.includes("TR") || origLang === "tr";
    });

    allTurkish = allTurkish.concat(filtered);
    if (data.length < batchSize) break;
    offset += batchSize;
  }

  const missingItems = allTurkish.filter((it) => {
    const tmdbId = it.external_id ? Number(it.external_id) : null;
    const internalId = it.id ? Number(it.id) : null;
    return (!tmdbId || !coveredSet.has(tmdbId)) && (!internalId || !coveredSet.has(internalId));
  });

  console.log(`📋 Total Turkish Titles in DB : ${allTurkish.length}`);
  console.log(`⏳ Titles Pending Torrent Resolution: ${missingItems.length}\n`);

  if (!missingItems.length) {
    console.log("🎉 All Turkish titles already have streamable sources in media_sources!");
    return;
  }

  let savedCount = 0;
  let notFoundCount = 0;
  let errorCount = 0;

  // Process with concurrency
  for (let i = 0; i < missingItems.length; i += CONCURRENCY) {
    const batch = missingItems.slice(i, i + CONCURRENCY);
    const promises = batch.map((item) => processTurkishItem(item, supabase));
    const results = await Promise.all(promises);

    results.forEach((res) => {
      if (res.status === "saved") {
        savedCount++;
        console.log(`  [+] "${res.title}" -> ${res.language} [${res.quality}] (${res.seeds} seeds) ✅`);
      } else if (res.status === "not_found") {
        notFoundCount++;
        console.log(`  [-] "${res.title}" -> No stream found ⏳`);
      } else if (res.status === "error") {
        errorCount++;
        console.warn(`  [!] "${res.title}" -> Error: ${res.error}`);
      }
    });

    await sleep(50);
  }

  console.log("\n===============================================================================");
  console.log(" 🎉 Turkish Torrent Resolution Completed!");
  console.log(` ✅ Newly Saved Streams : ${savedCount}`);
  console.log(` ⏳ Not Found / Pending : ${notFoundCount}`);
  console.log(` ⚠️ Errors              : ${errorCount}`);
  console.log("===============================================================================");
}

run().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
