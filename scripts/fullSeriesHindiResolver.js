"use strict";

/**
 * ⚡ Full Series & Season-by-Season Episode Hindi / Dual Audio Resolver
 *
 * Capabilities:
 * 1. Scans all TV Series & Anime in Supabase `media_content`.
 * 2. Resolves Complete Season Packs & Individual Episodes (S01, S02... E01, E02).
 * 3. Strict Hindi Dubbed / Dual Audio [Hindi+Eng] torrent matching via Torrentio & Cascading Indexers.
 * 4. Automatically stores resolved streams in `media_sources` with episode/season metadata.
 * 5. Formats media_id strictly as `${mediaId}-s${sPad}e${ePad}` (e.g. 246473-s02e01) so frontend displays each episode with realistic size and correct torrent.
 * 6. Estimates per-episode sizes for season packs (e.g. ~1.8 GB) instead of copying the whole 20 GB pack size.
 * 7. 6 Parallel Workers for high-throughput execution.
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents } = require("../server/services/torrentResolver");

const CONCURRENCY = 6;
const QUERY_TIMEOUT_MS = 4500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEpSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 * 1024 * 1024) {
    return `~${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `~${Math.round(bytes / (1024 * 1024))} MB`;
}

// Load existing media_sources keys to avoid re-resolving already completed items
async function getExistingCoveredKeys(supabase) {
  const coveredSet = new Set();
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("media_id, payload")
      .range(offset, offset + limit - 1);

    if (error || !data || data.length === 0) break;
    data.forEach((r) => {
      const mid = String(r.media_id || "").trim().toLowerCase();
      const season = r.payload?.season;
      const episode = r.payload?.episode;
      if (mid) {
        coveredSet.add(mid);
        if (season != null && episode != null) {
          const sPad = String(season).padStart(2, "0");
          const ePad = String(episode).padStart(2, "0");
          const baseId = mid.replace(/-s\d+e\d+/i, "").split(":")[0];
          coveredSet.add(`${baseId}-s${sPad}e${ePad}`.toLowerCase());
          coveredSet.add(`${baseId}:s${season}:e${episode}`.toLowerCase());
        }
      }
    });
    if (data.length < limit) break;
    offset += limit;
  }
  return coveredSet;
}

async function resolveSeriesPackAndEpisodes(seriesItem, coveredSet, supabase) {
  const mediaId = Number(seriesItem.external_id || seriesItem.id);
  const details = seriesItem.details || {};
  const title = seriesItem.title || details.title;
  const year = details.year || String(details.first_air_date || details.release_date || "").slice(0, 4) || "";
  const overview = details.overview || details.description || "";
  const posterUrl = details.poster_url || (details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : "");
  const backdropUrl = details.backdrop_url || (details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : "");
  const rating = details.rating_percent || (details.vote_average ? Math.round(Number(details.vote_average) * 10) : null);
  const seasons = details.seasons || [];

  if (!title) return { status: "skipped", title: "No title" };

  const cleanTitle = String(title || "")
    .replace(/[''‘’"`“”]/g, "")
    .replace(/[:;!?.,&]/g, " ")
    .replace(/[-–—_/\\|+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let totalSaved = 0;

  // Determine list of seasons to check
  const seasonList = seasons.length > 0
    ? seasons
    : Array.from({ length: Math.min(Number(details.number_of_seasons) || 1, 10) }, (_, i) => ({
        season_number: i + 1,
        episode_count: 10,
      }));

  for (const s of seasonList) {
    const seasonNum = Number(s.season_number);
    if (!seasonNum || seasonNum <= 0) continue; // Skip season 0 specials

    const sPad = String(seasonNum).padStart(2, "0");
    const episodeCount = Math.max(1, Math.min(Number(s.episode_count) || (Array.isArray(s.episodes) ? s.episodes.length : 10), 30));

    // Check how many episodes of this season are already covered
    let missingEpisodes = [];
    for (let ep = 1; ep <= episodeCount; ep++) {
      const ePad = String(ep).padStart(2, "0");
      const epKey = `${mediaId}-s${sPad}e${ePad}`.toLowerCase();
      if (!coveredSet.has(epKey)) {
        missingEpisodes.push(ep);
      }
    }

    if (missingEpisodes.length === 0) {
      continue; // All episodes for this season are already covered!
    }

    // Step A: Attempt to find a Season Pack or first available torrent for this season
    let seasonResult = null;
    try {
      seasonResult = await discoverCascadingTorrents({
        title: cleanTitle,
        year,
        mediaType: "tv",
        season: seasonNum,
        tmdbId: mediaId,
        imdbId: details.imdb_id,
        requireDubMarker: true,
        queryTimeoutMs: QUERY_TIMEOUT_MS,
        allowEmbed: false,
        queries: [
          `${cleanTitle} Season ${seasonNum} Dual Audio`,
          `${cleanTitle} Season ${seasonNum} Hindi`,
          `${cleanTitle} S0${seasonNum} Dual Audio`,
          `${cleanTitle} S0${seasonNum} Hindi`,
          `${cleanTitle} S0${seasonNum} Complete Hindi`,
          `${cleanTitle} S0${seasonNum}`,
        ],
      });
    } catch (_) {}

    if (seasonResult && seasonResult.magnet_link && seasonResult.success !== false) {
      const releaseTitle = String(seasonResult.title || "");
      const seMatch = releaseTitle.match(/s0*(\d+)[^a-z0-9]*e0*(\d+)/i) || releaseTitle.match(/\b(\d+)x0*(\d+)\b/i);
      const isSingleEp = Boolean(seMatch);
      const singleEpNum = seMatch ? Number(seMatch[2]) : null;

      if (!isSingleEp) {
        // True Season Pack! Contains all episodes
        const packBytes = seasonResult.size_bytes || 0;
        const estEpBytes = packBytes > 0 ? Math.round(packBytes / episodeCount) : null;
        const estEpHuman = estEpBytes ? formatEpSize(estEpBytes) : (seasonResult.size_human || "");

        for (const ep of missingEpisodes) {
          const ePad = String(ep).padStart(2, "0");
          const epKey = `${mediaId}-s${sPad}e${ePad}`.toLowerCase();
          try {
            await saveTorrentRelease(
              {
                mediaId,
                title: `${title} - S${sPad}E${ePad}`,
                year,
                mediaType: "series",
                season: seasonNum,
                episode: ep,
                overview: s.overview || overview,
                posterUrl: s.poster_url || posterUrl,
                backdropUrl,
                rating,
              },
              {
                title: `${title} S${sPad}E${ePad} Hindi Dubbed`,
                magnet_link: seasonResult.magnet_link,
                download_url: seasonResult.download_url || seasonResult.magnet_link,
                quality: seasonResult.quality || "1080p",
                language_label: seasonResult.language_label || seasonResult.language || "Dual Audio [Hindi+Eng]",
                seeders: seasonResult.seeders || 10,
                size_bytes: estEpBytes,
                size_human: estEpHuman,
                season: seasonNum,
                episode: ep,
                episode_count: episodeCount,
              }
            );
            coveredSet.add(epKey);
            totalSaved++;
          } catch (_) {}
        }
        missingEpisodes = [];
      } else if (singleEpNum != null && singleEpNum >= 1 && singleEpNum <= episodeCount) {
        // Single episode torrent returned (e.g. S02E01) — ONLY save for that single episode!
        const ePad = String(singleEpNum).padStart(2, "0");
        const epKey = `${mediaId}-s${sPad}e${ePad}`.toLowerCase();
        try {
          await saveTorrentRelease(
            {
              mediaId,
              title: `${title} - S${sPad}E${ePad}`,
              year,
              mediaType: "series",
              season: seasonNum,
              episode: singleEpNum,
              overview: s.overview || overview,
              posterUrl: s.poster_url || posterUrl,
              backdropUrl,
              rating,
            },
            {
              title: seasonResult.title,
              magnet_link: seasonResult.magnet_link,
              download_url: seasonResult.download_url || seasonResult.magnet_link,
              quality: seasonResult.quality || "1080p",
              language_label: seasonResult.language_label || seasonResult.language || "Dual Audio [Hindi+Eng]",
              seeders: seasonResult.seeders || 10,
              size_bytes: seasonResult.size_bytes,
              size_human: seasonResult.size_human,
              season: seasonNum,
              episode: singleEpNum,
            }
          );
          coveredSet.add(epKey);
          totalSaved++;
          missingEpisodes = missingEpisodes.filter((num) => num !== singleEpNum);
        } catch (_) {}
      }
    }

    // Step B: For any remaining episodes that don't have a source, search individually
    for (const ep of missingEpisodes.slice(0, 15)) {
      const ePad = String(ep).padStart(2, "0");
      const epKey = `${mediaId}-s${sPad}e${ePad}`.toLowerCase();
      if (coveredSet.has(epKey)) continue;

      try {
        const epResult = await discoverCascadingTorrents({
          title: cleanTitle,
          year,
          mediaType: "tv",
          season: seasonNum,
          episode: ep,
          tmdbId: mediaId,
          imdbId: details.imdb_id,
          requireDubMarker: true,
          queryTimeoutMs: 3500,
          allowEmbed: false,
          queries: [
            `${cleanTitle} S${sPad}E${ePad} Dual Audio`,
            `${cleanTitle} S${sPad}E${ePad} Hindi`,
            `${cleanTitle} S${sPad}E${ePad}`,
            `${cleanTitle} Season ${seasonNum} Episode ${ep} Hindi`,
          ],
        });

        if (epResult && epResult.magnet_link && epResult.success !== false) {
          await saveTorrentRelease(
            {
              mediaId,
              title: `${title} - S${sPad}E${ePad}`,
              year,
              mediaType: "series",
              season: seasonNum,
              episode: ep,
              overview: s.overview || overview,
              posterUrl: s.poster_url || posterUrl,
              backdropUrl,
              rating,
            },
            {
              title: epResult.title || `${title} S${sPad}E${ePad} Hindi Dubbed`,
              magnet_link: epResult.magnet_link,
              download_url: epResult.download_url || epResult.magnet_link,
              quality: epResult.quality || "1080p",
              language_label: epResult.language_label || epResult.language || "Dual Audio [Hindi+Eng]",
              seeders: epResult.seeders || 8,
              size_bytes: epResult.size_bytes,
              size_human: epResult.size_human,
              season: seasonNum,
              episode: ep,
            }
          );
          coveredSet.add(epKey);
          totalSaved++;
        }
      } catch (_) {}
    }
  }

  return { status: totalSaved > 0 ? "saved" : "no_hindi_dub", title, count: totalSaved };
}

async function main() {
  console.log("===============================================================================");
  console.log(" 📺 Complete TV Series & Episodes Hindi & Dual Audio Resolver");
  console.log(` Concurrency: ${CONCURRENCY} parallel workers · Strict Dubbing Filter: ON`);
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();

  console.log("🔍 Loading existing media_sources index...");
  const coveredSet = await getExistingCoveredKeys(supabase);
  console.log(`✅ Loaded ${coveredSet.size} already resolved episode & season keys.\n`);

  // Load all TV Series & Shows from media_content (both 'series' and 'tv')
  let allSeries = [];
  let offset = 0;
  const batchSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, external_id, title, media_type, details")
      .in("media_type", ["series", "tv"])
      .order("id", { ascending: false })
      .range(offset, offset + batchSize - 1);

    if (error || !data || data.length === 0) break;
    allSeries = allSeries.concat(data);
    if (data.length < batchSize) break;
    offset += batchSize;
  }

  console.log(`📋 Total Series & TV Shows in Database: ${allSeries.length} shows\n`);

  let processed = 0;
  let totalSaved = 0;

  for (let i = 0; i < allSeries.length; i += CONCURRENCY) {
    const chunk = allSeries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((series) => resolveSeriesPackAndEpisodes(series, coveredSet, supabase))
    );

    results.forEach((res) => {
      processed++;
      if (res.status === "saved") {
        totalSaved += res.count;
        console.log(`✅ [${processed}/${allSeries.length}] SAVED HINDI: "${res.title}" (${res.count} sources attached)`);
      } else {
        console.log(`⏩ [${processed}/${allSeries.length}] Skipped / No Hindi Dub: "${res.title}"`);
      }
    });

    await sleep(200);
  }

  console.log("\n===============================================================================");
  console.log(`🎉 Series Hindi Dubbing Resolution Complete!`);
  console.log(`💾 Total Series Sources Added: ${totalSaved}`);
  console.log("===============================================================================");
}

main().catch((err) => {
  console.error("Fatal Error in fullSeriesHindiResolver:", err);
  process.exit(1);
});
