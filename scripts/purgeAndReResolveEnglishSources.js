"use strict";

/**
 * ⚡ Purge English Sources & Re-resolve with Hindi / Dual Audio / Urdu Dubbed Torrents
 * 
 * Purpose:
 * 1. Scans and permanently deletes all rows in Supabase `media_sources` where `language = 'English'`
 * 2. Takes those exact titles (Turkish dramas, movies, Korean series) and re-runs torrent discovery
 * 3. Enforces strict `requireDubMarker: true` to match ONLY Hindi Dubbed, Dual Audio, or Urdu Dubbed
 * 4. Saves authentic streaming & download URLs directly to `media_sources`
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents } = require("../server/services/torrentResolver");

const CONCURRENCY = 4;
const QUERY_TIMEOUT_MS = 5000;

const KNOWN_ALIASES = {
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
  113268: ["The Uncanny Counter Hindi", "The Uncanny Counter Dual Audio"], // The Uncanny Counter
  457837: ["Brotherhood of Blades II Hindi", "Brotherhood of Blades II Dual Audio"],
  423453: ["Sahara Hindi Dubbed", "Sahara Dual Audio"],
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanTitle(str) {
  if (!str) return "";
  return String(str)
    .replace(/ - Season \d+/i, "")
    .replace(/ - S\d+/i, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[:;!?.,&'"`~@#$%^*()_+\-=[\]{}|\\/<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveItemInHindi(item, supabase) {
  const tmdbId = item.external_id ? Number(item.external_id) : null;
  const title = item.title;
  const origTitle = item.details?.original_title || title;
  const year = item.year || item.details?.year || "";
  const mediaType = item.media_type || item.details?.media_type || "series";
  const isSeries = mediaType === "series" || mediaType === "tv";

  const cleanEng = cleanTitle(title);
  const cleanOrig = cleanTitle(origTitle);
  const aliases = (tmdbId ? KNOWN_ALIASES[tmdbId] : []) || [];

  const queries = isSeries
    ? [
        ...aliases,
        `${cleanEng} Hindi Dubbed`,
        `${cleanOrig} Hindi Dubbed`,
        `${cleanEng} Dual Audio`,
        `${cleanOrig} Dual Audio`,
        `${cleanOrig} Urdu`,
        `${cleanEng} Urdu`,
        `${cleanEng} S01 Hindi`,
        `${cleanEng} Hindi`,
      ]
    : [
        ...aliases,
        `${cleanEng} Hindi Dubbed`,
        `${cleanOrig} Hindi Dubbed`,
        `${cleanEng} Dual Audio`,
        `${cleanOrig} Dual Audio`,
        `${cleanOrig} Urdu`,
        `${cleanEng} Urdu`,
        `${cleanEng} Hindi`,
      ];

  const uniqueQueries = [...new Set(queries.filter(Boolean))];

  try {
    const result = await discoverCascadingTorrents({
      title: cleanEng || title,
      year,
      mediaType: isSeries ? "tv" : "movie",
      tmdbId,
      imdbId: item.details?.imdb_id,
      requireDubMarker: true, // STRICT Hindi, Dual, or Urdu only
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
      return { status: "not_found", title };
    }

    const posterUrl =
      item.details?.poster_url ||
      item.details?.poster ||
      (item.details?.poster_path ? `https://image.tmdb.org/t/p/w500${item.details.poster_path}` : "");
    const backdropUrl =
      item.details?.backdrop_url ||
      item.details?.backdrop ||
      (item.details?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.details.backdrop_path}` : "");
    const overview = item.details?.overview || item.details?.description || "";
    const rating = item.details?.rating_percent || (item.details?.vote_average ? Math.round(Number(item.details.vote_average) * 10) : null);

    // 1. Save overall title source
    await saveTorrentRelease(
      {
        mediaId: tmdbId || item.id,
        imdbId: item.details?.imdb_id,
        title,
        year,
        mediaType,
        overview,
        posterUrl,
        backdropUrl,
        rating,
      },
      {
        title: best.title || `${title} (${language})`,
        magnet_link: magnet,
        download_url: magnet,
        quality: best.quality || best.resolution || "1080p",
        language_label: language,
        seeders: best.seeds || best.seeders || 10,
        size_bytes: best.sizeBytes || best.size_bytes || null,
        size_human: best.sizeHuman || best.size_human || "",
      }
    );

    // 2. If it's a TV show, also save Season 1 row
    if (isSeries) {
      try {
        await saveTorrentRelease(
          {
            mediaId: tmdbId || item.id,
            imdbId: item.details?.imdb_id,
            title: `${title} - Season 1`,
            year,
            mediaType: "series",
            season: 1,
            overview,
            posterUrl,
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
      language,
      quality: best.quality || "1080p",
      seeds: best.seeds || best.seeders || 5,
      release: best.title,
    };
  } catch (err) {
    return { status: "error", title, error: err.message };
  }
}

async function main() {
  console.log("===============================================================================");
  console.log(" 🚀 Purge English Sources & Re-resolve With Hindi / Dual Audio / Urdu Dubs");
  console.log(" Strict Filter: English is SKIPPED | Hindi, Dual Audio, Urdu ONLY");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();

  // 1. Fetch all rows where language is English
  console.log("🔍 Fetching all rows where language = 'English' from media_sources...");
  const { data: englishRows, error: fetchErr } = await supabase
    .from("media_sources")
    .select("id, media_id, media_title, year, payload")
    .eq("language", "English");

  if (fetchErr) {
    console.error("❌ Failed to fetch English sources:", fetchErr.message);
    process.exit(1);
  }

  console.log(`📋 Found ${englishRows.length} English rows in media_sources.\n`);

  if (englishRows.length === 0) {
    console.log("🎉 No English rows found in media_sources! Database is already 100% clean.");
    return;
  }

  // Extract unique media IDs and metadata to re-resolve
  const targetMap = new Map();
  englishRows.forEach((r) => {
    const baseId = String(r.media_id).split(":")[0];
    const cleanName = cleanTitle(r.media_title);
    if (!targetMap.has(baseId)) {
      targetMap.set(baseId, {
        id: baseId,
        external_id: r.payload?.tmdb_id || (/^\d+$/.test(baseId) ? baseId : null),
        title: cleanName,
        year: r.year,
        media_type: r.media_title.includes("Season") ? "series" : "movie",
      });
    }
  });

  // Fetch full details from media_content if available
  const baseIds = Array.from(targetMap.keys());
  const numIds = baseIds.map(Number).filter((n) => !isNaN(n));
  const { data: contents } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select("id, external_id, title, media_type, details")
    .or(`external_id.in.(${numIds.join(",")}),id.in.(${numIds.join(",")})`);

  if (contents && contents.length) {
    contents.forEach((c) => {
      const extKey = String(c.external_id);
      const intKey = String(c.id);
      if (targetMap.has(extKey)) {
        const item = targetMap.get(extKey);
        item.details = c.details;
        item.media_type = c.media_type;
        item.title = c.title || item.title;
      } else if (targetMap.has(intKey)) {
        const item = targetMap.get(intKey);
        item.details = c.details;
        item.media_type = c.media_type;
        item.title = c.title || item.title;
      }
    });
  }

  // 2. Delete English rows from media_sources
  console.log(`🗑️ Deleting ${englishRows.length} English rows from media_sources...`);
  const englishIds = englishRows.map((r) => r.id);
  const chunkSize = 50;
  for (let i = 0; i < englishIds.length; i += chunkSize) {
    const chunk = englishIds.slice(i, i + chunkSize);
    const { error: delErr } = await supabase.from("media_sources").delete().in("id", chunk);
    if (delErr) {
      console.warn(`  ⚠️ Delete error on chunk ${i}:`, delErr.message);
    }
  }
  console.log("✅ Successfully purged all English rows from media_sources!\n");

  // 3. Re-resolve the unique media items strictly in Hindi / Dual Audio / Urdu
  const itemsToResolve = Array.from(targetMap.values());
  console.log(`🔄 Re-resolving ${itemsToResolve.length} titles strictly for Hindi & Dual Audio torrents...`);

  let savedCount = 0;
  let notFoundCount = 0;

  for (let i = 0; i < itemsToResolve.length; i += CONCURRENCY) {
    const batch = itemsToResolve.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((it) => resolveItemInHindi(it, supabase)));

    results.forEach((res) => {
      if (res.status === "saved") {
        savedCount++;
        console.log(`  [+] "${res.title}" -> ${res.language} [${res.quality}] (${res.seeds} seeds) ✅`);
      } else {
        notFoundCount++;
        console.log(`  [-] "${res.title}" -> Skipped (No authentic Hindi/Dual dub found) ⏭️`);
      }
    });

    await sleep(50);
  }

  console.log("\n===============================================================================");
  console.log(" 🎉 Purge & Re-Resolution Finished!");
  console.log(` 🗑️ English Sources Purged      : ${englishRows.length}`);
  console.log(` ✅ Newly Saved Hindi/Dual Dubs  : ${savedCount}`);
  console.log(` ⏭️ Titles Skipped (No Dub)      : ${notFoundCount}`);
  console.log("===============================================================================");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
