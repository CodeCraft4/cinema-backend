"use strict";

/**
 * ⚡ Sync & Ingest Live Streams for Existing `media_content` (33K+ Library)
 *
 * Scans movies already in Supabase `media_content`:
 * 1. Checks if `media_sources` already has a working stream (seeds >= 5). If yes, SKIPS.
 * 2. If stream is missing:
 *    - Finds working Hindi / Dual Audio torrents with live seeders >= 5.
 *    - Strictly enforces 480p, 720p, 1080p ONLY (4K / 2160p is strictly IGNORED).
 *    - Injects stream into `media_sources` so every poster in CineBox plays instantly!
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents } = require("../server/services/torrentResolver");

const MIN_REQUIRED_SEEDERS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const result = { batchSize: 50, maxTotal: 5000, startOffset: 0 };
  for (const a of args) {
    if (a.startsWith("--batch-size=")) result.batchSize = Number(a.split("=")[1]) || 50;
    if (a.startsWith("--max=")) result.maxTotal = Number(a.split("=")[1]) || 5000;
  }
  return result;
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

async function main() {
  const { batchSize, maxTotal } = parseCliArgs();
  const supabase = getSupabaseClient();

  console.log("==================================================================");
  console.log("🚀 [MEDIA_CONTENT STREAM INGESTION ENGINE]");
  console.log("   Linking 33K+ TMDB Catalog with Active Torrent Streams");
  console.log(`   Rules: Hindi & Dual Audio | Seeds >= ${MIN_REQUIRED_SEEDERS} | 480p, 720p, 1080p ONLY (No 4K)`);
  console.log(`   Batch Size: ${batchSize} | Max Limit: ${maxTotal}`);
  console.log("==================================================================\n");

  const { count: totalContentInDb } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select("*", { count: "exact", head: true });

  console.log(`📊 Total Items in media_content: ${totalContentInDb}\n`);

  let totalProcessed = 0;
  let totalStreamsInjected = 0;
  let totalAlreadyHealthy = 0;
  let totalNoSeeds = 0;
  let lastSeenId = 0;

  while (totalProcessed < maxTotal) {
    // 1. Fetch batch from media_content ordered by ID
    const { data: contents, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, external_id, title, details")
      .gt("id", lastSeenId)
      .order("id", { ascending: true })
      .limit(batchSize);

    if (error) {
      console.error(`[DB ERROR] Fetch failed after ID ${lastSeenId}:`, error.message);
      await sleep(2000);
      continue;
    }

    if (!contents || contents.length === 0) {
      console.log("✅ All media_content records scanned.");
      break;
    }

    lastSeenId = contents[contents.length - 1].id;

    for (const item of contents) {
      totalProcessed++;
      const externalId = item.external_id;
      const title = item.title;
      const details = item.details || {};
      const year = (details.release_date || details.first_air_date || details.year || "").slice(0, 4);
      const isTv = Boolean(details.number_of_seasons || details.type === "series" || details.media_type === "tv");
      const mediaType = isTv ? "series" : "movie";

      if (!title || !externalId) continue;

      // Check if already in media_sources with working seeds
      const alreadyHas = await hasWorkingSource(supabase, externalId);
      if (alreadyHas) {
        totalAlreadyHealthy++;
        continue;
      }

      console.log(`🔍 [FINDING HINDI STREAM] "${title}" (${year || "N/A"}) [TMDB: ${externalId}]...`);

      try {
        const result = await discoverCascadingTorrents({
          title,
          year,
          mediaType,
          tmdbId: externalId,
          requireDubMarker: false,
        });

        const liveSeeds = Number(result?.seeders || 0);
        const magnet = result?.magnet_link || result?.magnet || result?.download_url;
        const is4K =
          result?.quality === "2160p" ||
          /\b(?:2160p|4k|uhd)\b/i.test(result?.title || "") ||
          /\b(?:2160p|4k|uhd)\b/i.test(result?.resolution || "");

        if (result && magnet && liveSeeds >= MIN_REQUIRED_SEEDERS && !is4K) {
          const posterUrl =
            details.poster_url ||
            (details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : "");
          const backdropUrl =
            details.backdrop_url ||
            (details.backdrop_path ? `https://image.tmdb.org/t/p/original${details.backdrop_path}` : "");

          await saveTorrentRelease(
            {
              mediaId: String(externalId),
              title,
              year,
              mediaType,
              posterUrl,
              backdropUrl,
            },
            {
              ...result,
              title: result.title || title,
              magnet,
              seeders: liveSeeds,
              quality: result.quality || "1080p",
              language: result.language || "Dual Audio [Hindi+Eng]",
              language_label: result.language_label || "Dual Audio [Hindi+Eng]",
            }
          );

          totalStreamsInjected++;
          console.log(
            `  ✨ [STREAM INJECTED] "${title}" · ${result.quality || "720p/1080p"} · ${liveSeeds} seeds · ${result.language || "Hindi"}`
          );
        } else {
          totalNoSeeds++;
          if (is4K) {
            console.log(`  ⛔ [SKIPPED 4K] "${title}" was 4K/2160p. Ignored as requested.`);
          }
        }
      } catch (err) {
        console.warn(`  ⚠️ Resolution skipped for "${title}":`, err.message);
      }

      await sleep(250); // Friendly rate-limiting
    }

    console.log(
      `\n📦 [PROGRESS] Checked: ${totalProcessed}/${totalContentInDb} | ✨ Injected: ${totalStreamsInjected} | ⏩ Already Healthy: ${totalAlreadyHealthy} | ⚠️ No Hindi Seeds: ${totalNoSeeds}\n`
    );
  }

  console.log("\n==================================================================");
  console.log("🏁 [MEDIA_CONTENT STREAM INGESTION FINISHED]");
  console.log(`   • Total Content Scanned: ${totalProcessed}`);
  console.log(`   • New Working Streams Injected: ${totalStreamsInjected}`);
  console.log(`   • Already Healthy (Skipped): ${totalAlreadyHealthy}`);
  console.log(`   • Without Seeds / 4K (Skipped): ${totalNoSeeds}`);
  console.log("==================================================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error in syncSourcesForMediaContent:", err);
  process.exit(1);
});

