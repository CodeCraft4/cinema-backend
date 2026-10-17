"use strict";

/**
 * ⚡ Ultra-Fast Direct Hindi & Dual Audio Torrent Finder & Saver
 * 
 * Purpose:
 * - Scans missing titles in Supabase `media_content` (where media_sources has no Hindi source)
 * - Directly finds 1080p/720p Hindi Dubbed & Dual Audio torrent magnets (via Torrentio + Multi-Indexers)
 * - Persists magnet, title, resolution, overview, poster, backdrop directly to Supabase `media_sources`
 * - Runs with high concurrency (8-10 parallel workers) with zero waiting/delays
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents } = require("../server/services/torrentResolver");

const CONCURRENCY = 8; // High speed parallel workers
const QUERY_TIMEOUT_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getExistingCoveredIds(supabase) {
  const coveredSet = new Set();
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("media_sources")
      .select("media_id, source_type, status")
      .range(offset, offset + limit - 1);

    if (error || !data || data.length === 0) break;
    data.forEach((r) => {
      if (r.media_id) {
        const raw = String(r.media_id).trim();
        coveredSet.add(raw);
        const base = raw.split(":")[0];
        coveredSet.add(base);
        if (/^\d+$/.test(base)) coveredSet.add(Number(base));
      }
    });
    if (data.length < limit) break;
    offset += limit;
  }
  return coveredSet;
}

async function processItem(item, supabase) {
  const mediaId = Number(item.id);
  const details = item.details || {};
  const tmdbId = item.external_id || details.tmdb_id;
  const title = item.title || details.title;
  const mediaType = item.media_type || details.media_type || "movie";
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

  if (!title) return { status: "skipped", reason: "no title" };

  try {
    const cleanTitle = String(title || "")
      .replace(/[''‘’"`“”]/g, "")
      .replace(/[:;!?.,&]/g, " ")
      .replace(/[-–—_/\\|+]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const isSeries = mediaType === "series" || mediaType === "tv";
    const queriesOverride = isSeries
      ? [
          `${cleanTitle} Dual Audio`,
          `${cleanTitle} Hindi Dubbed`,
          `${cleanTitle} S01 Dual Audio`,
          `${cleanTitle} S01 Hindi`,
          `${cleanTitle} Season 1 Dual Audio`,
          `${cleanTitle} Season 1 Hindi`,
          `${cleanTitle} Complete Hindi`,
          `${cleanTitle} Hindi`,
          `${cleanTitle} Urdu`,
        ]
      : [
          `${cleanTitle} Dual Audio`,
          `${cleanTitle} Hindi Dubbed`,
          year ? `${cleanTitle} ${year} Dual Audio` : null,
          year ? `${cleanTitle} ${year} Hindi Dubbed` : null,
          `${cleanTitle} Multi Audio`,
          `${cleanTitle} Hindi`,
          `${cleanTitle} Urdu`,
        ].filter(Boolean);

    const result = await discoverCascadingTorrents({
      title,
      year,
      mediaType,
      tmdbId,
      imdbId: details.imdb_id,
      requireDubMarker: true, // STRICT Hindi / Dual Audio only!
      queryTimeoutMs: QUERY_TIMEOUT_MS,
      allowEmbed: false,
      queries: queriesOverride,
    });

    if (!result || result.success === false) {
      return { status: "not_found", title };
    }

    const best = Array.isArray(result) ? result[0] : result;
    const magnet = best.magnet_link || best.magnet || best.download_url;
    if (!magnet || !/^magnet:/i.test(magnet)) {
      return { status: "not_found", title };
    }

    // Save directly to media_sources table
    await saveTorrentRelease(
      {
        mediaId: tmdbId || mediaId,
        imdbId: details.imdb_id,
        title,
        year,
        mediaType,
        overview,
        posterUrl,
        backdropUrl,
        rating,
      },
      {
        title: best.title || best.name || `${title} Hindi Dubbed`,
        magnet_link: magnet,
        download_url: magnet,
        quality: best.resolution || "1080p",
        language_label: "Hindi",
        seeders: best.seeds || best.seeders || 10,
        size_bytes: best.sizeBytes || best.size_bytes || null,
        size_human: best.sizeHuman || best.size_human || "",
      }
    );

    return { status: "saved", title, release: best.title, seeds: best.seeds || best.seeders };
  } catch (err) {
    return { status: "error", title, error: err.message };
  }
}

async function main() {
  console.log("===============================================================================");
  console.log(" ⚡ Fast Direct Hindi & Dual Audio Torrent Finder & Saver");
  console.log(` Concurrency: ${CONCURRENCY} parallel workers | Strict Hindi/Dual Dub Filter: ON`);
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();

  console.log("🔍 Scanning existing sources in Supabase to find missing titles...");
  const coveredSet = await getExistingCoveredIds(supabase);
  console.log(`✅ Found ${coveredSet.size} already resolved media_sources.`);

  // Load all media_content items
  let allItems = [];
  let offset = 0;
  const batchSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, external_id, title, media_type, details")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error("❌ Failed to load media_content:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allItems = allItems.concat(data);
    if (data.length < batchSize) break;
    offset += batchSize;
  }

  const missingItems = allItems.filter((it) => {
    const isSeries = it.media_type === "series" || it.media_type === "tv" || it.details?.media_type === "tv";
    if (isSeries) return false; // Handled exclusively and properly by fullSeriesHindiResolver.js
    const tmdbId = it.external_id ? Number(it.external_id) : null;
    const internalId = it.id ? Number(it.id) : null;
    const extStr = it.external_id ? String(it.external_id).trim() : null;
    const intStr = it.id ? String(it.id).trim() : null;
    return (!tmdbId || !coveredSet.has(tmdbId)) &&
           (!internalId || !coveredSet.has(internalId)) &&
           (!extStr || !coveredSet.has(extStr)) &&
           (!intStr || !coveredSet.has(intStr));
  });
  console.log(`\n📋 Total Titles in Database : ${allItems.length}`);
  console.log(`🎯 Missing Hindi Sources     : ${missingItems.length} titles to process\n`);

  if (missingItems.length === 0) {
    console.log("🎉 All movies & series already have Hindi/Dual Audio sources!");
    return;
  }

  let processedCount = 0;
  let savedCount = 0;
  let notFoundCount = 0;

  // Run in chunks of CONCURRENCY
  for (let i = 0; i < missingItems.length; i += CONCURRENCY) {
    const chunk = missingItems.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((item) => processItem(item, supabase)));

    results.forEach((res) => {
      processedCount++;
      if (res.status === "saved") {
        savedCount++;
        console.log(`✅ [${processedCount}/${missingItems.length}] SAVED HINDI: "${res.title}" -> ${res.release || ""}`);
      } else if (res.status === "not_found") {
        notFoundCount++;
        console.log(`⏩ [${processedCount}/${missingItems.length}] No Hindi Torrent: "${res.title}"`);
      } else {
        console.log(`⚠️ [${processedCount}/${missingItems.length}] ${res.status}: "${res.title}"`);
      }
    });

    await sleep(200); // Small cooldown
  }

  console.log("\n===============================================================================");
  console.log(`🎉 Direct Hindi Magnet Resolution Complete!`);
  console.log(`💾 Successfully Saved: ${savedCount} Hindi/Dual sources`);
  console.log(`⏩ Skipped / Not Found: ${notFoundCount} titles`);
  console.log("===============================================================================");
}

main().catch((err) => {
  console.error("Fatal Error in directHindiMagnetFinder:", err);
  process.exit(1);
});
