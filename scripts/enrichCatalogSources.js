#!/usr/bin/env node
"use strict";

/**
 * High-Throughput Batch Catalog Enrichment & Torrent-to-DDL Pre-Conversion Engine
 *
 * Requirements:
 * 1. Batch Chunking & Keyset Pagination (50 items per batch).
 * 2. Deduplication & Idempotency: Skip titles with source_type='ddl' and status='ready'.
 * 3. Concurrency Limiter: 3-5 concurrent workers.
 * 4. Auto-Resume: Persists last_processed_id in enrichment-checkpoint.json.
 * 5. Pre-converted DDL: All torrents stored as direct HTTP .mp4 endpoints.
 * 6. Progress Counter:
 *    [Batch X/Y] Processed: {title} | Converted to DDL: {Yes/No} | Seeders: {count} | Total DDL Ready in DB: {total}
 *
 * Usage:
 *   npm run enrich
 *   npm run enrich -- --limit 50
 *   npm run enrich -- --reset
 *   npm run enrich -- --workers 4 --batch 50
 */

const fs = require("fs");
const path = require("path");

const env = require("../server/config/env");
const {
  getSupabaseClient,
  MEDIA_CONTENT_TABLE,
  MEDIA_SOURCES_TABLE,
} = require("../server/services/supabaseClient");
const { describeRelease, MIN_SEEDERS } = require("../server/services/streamResolver");
const { acceptTorrentRelease, magnetWrite, discoverCascadingTorrents, cleanSearchTitle } = require("../server/services/torrentResolver");
const { initTorrentProviders } = require("../src/torrentSearch");

const CHECKPOINT_PATH = path.join(__dirname, "enrichment-checkpoint.json");
const DEFAULT_WORKERS = 3;
const DEFAULT_BATCH = 50;
const WORKER_DELAY_MS = 250;

let stopRequested = false;

function parseArgs(argv) {
  const args = {
    force: false,
    reset: false,
    limit: 0,
    workers: DEFAULT_WORKERS,
    batch: DEFAULT_BATCH,
    timeout: 5000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--force") args.force = true;
    else if (token === "--reset") args.reset = true;
    else if (token === "--limit") args.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (token === "--workers") args.workers = Math.max(1, Math.min(5, Number(argv[++i]) || DEFAULT_WORKERS));
    else if (token === "--batch") args.batch = Math.max(10, Math.min(200, Number(argv[++i]) || DEFAULT_BATCH));
    else if (token === "--timeout") args.timeout = Math.max(100, Math.min(10000, Number(argv[++i]) || 5000));
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(10, Number(ms) || 10)));
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function readCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
      return {
        last_processed_id: Number(parsed.last_processed_id) || 0,
        batch_index: Number(parsed.batch_index) || 0,
        total_processed: Number(parsed.total_processed) || 0,
        total_ddl_converted: Number(parsed.total_ddl_converted) || 0,
        updated_at: parsed.updated_at || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn(`[enrich] Warning reading checkpoint: ${err.message}`);
  }
  return {
    last_processed_id: 0,
    batch_index: 0,
    total_processed: 0,
    total_ddl_converted: 0,
    updated_at: new Date().toISOString(),
  };
}

function writeCheckpoint(state) {
  try {
    const payload = {
      last_processed_id: state.last_processed_id || 0,
      batch_index: state.batch_index || 0,
      total_processed: state.total_processed || 0,
      total_ddl_converted: state.total_ddl_converted || 0,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(payload, null, 2) + "\n");
  } catch (err) {
    console.warn(`[enrich] Warning writing checkpoint: ${err.message}`);
  }
}

function mediaIdOf(row) {
  const id = row?.external_id == null ? "" : String(row.external_id).trim();
  return id || (row?.id != null ? String(row.id) : "");
}

function yearOf(row) {
  const details = row?.details || {};
  const raw = details.year || details.release_date || details.premiered || details.first_air_date || "";
  return String(raw).match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
}

function releaseDateOf(row) {
  const details = row?.details || {};
  const raw = details.release_date || details.premiered || details.first_air_date || "";
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUnreleased(row, now = new Date()) {
  const date = releaseDateOf(row);
  if (date) return date.getTime() > now.getTime();
  const year = Number(yearOf(row));
  if (!Number.isInteger(year) || year <= 0) return true;
  return year > 2025;
}

function buildEnrichQueries(title, year, mediaType = "movie") {
  const name = cleanSearchTitle(title);
  if (!name) return [];
  const yr = String(year || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
  const withYear = yr ? `${name} ${yr}` : name;

  if (String(mediaType).toLowerCase() === "tv") {
    return [
      `${name} Season 1 Dual Audio`,
      `${name} S01 Dual Audio`,
      `${name} Season 1 Hindi Dubbed`,
      `${name} S01 Hindi`,
      `${name} Complete Dual Audio`,
      `${name} Complete Hindi`,
      `${name} Season 1`,
      `${name} S01`,
      `${name} Dual Audio`,
      `${name} Hindi`,
      withYear,
      name,
    ];
  }

  return [
    `${withYear} Dual Audio`,
    `${withYear} Hindi Dubbed`,
    `${name} Dual Audio`,
    `${name} Hindi`,
    `${name} Urdu`,
    withYear,
  ];
}

function countryText(details = {}) {
  const raw = details.origin_country || details.production_countries || details.country || "";
  if (Array.isArray(raw)) {
    return raw.map((item) => (typeof item === "string" ? item : item?.name || item?.iso_3166_1 || "")).join(" ");
  }
  return String(raw || "");
}

async function discoverSources(title, year, timeoutMs, mediaType = "movie", details = {}, tmdbId = null) {
  const found = await discoverCascadingTorrents({
    title,
    year,
    mediaType,
    tmdbId: tmdbId || details.tmdb_id,
    imdbId: details.imdb_id,
    timeoutMs: Math.min(6000, Math.max(100, Number(timeoutMs) || 5000)),
    queries: buildEnrichQueries(title, year, mediaType),
    allowEmbed: false,
    requireDubMarker: true,
    industry: details.industry,
    country: countryText(details),
    originalLanguage: details.original_language || details.originalLanguage || "",
    shouldStop: () => stopRequested,
  });
  if (stopRequested || !found || found.source_type !== "ddl" || found.status !== "ready") {
    return [];
  }
  return [found];
}

function cacheKey(mediaId, title, year, language, quality) {
  return [mediaId, String(title || "").trim().toLowerCase(), year || "-", (language || "Hindi").toLowerCase(), (quality || "1080p").toLowerCase()].join("::");
}

async function upsertSource(supabase, row) {
  const attempts = [{ ...row }];
  const withoutSize = { ...row };
  delete withoutSize.size_human;
  delete withoutSize.size_bytes;
  attempts.push(withoutSize);

  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const payload = attempts[index];
    const { error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .upsert(payload, { onConflict: "media_id,quality,language" });
    if (!error) return true;
    lastError = error;
    if (!/size_human|size_bytes|status|stream_url|column/i.test(error.message || "")) break;
  }
  console.warn(`[enrich] upsert failed for ${row.media_id} (${row.media_title}): ${lastError?.message || "unknown"}`);
  return false;
}

async function saveSources(supabase, content, sources) {
  const mediaId = mediaIdOf(content);
  const year = yearOf(content);
  let saved = 0;
  for (const source of sources) {
    const magnet = source.magnet_link || source.download_url;
    const written = magnetWrite(magnet);
    if (!written) continue;
    const row = {
      cache_key: cacheKey(mediaId, content.title, year, source.language, source.quality),
      media_id: mediaId,
      media_title: String(content.title || source.title || "Untitled").slice(0, 255),
      year: year || null,
      language: source.language || "Hindi / Dual Audio",
      quality: source.quality || "1080p",
      source_type: written.source_type, // "ddl"
      download_url: written.download_url,
      stream_url: written.stream_url,
      magnet_link: written.magnet_link,
      seeders: Number.isFinite(Number(source.seeders)) ? Number(source.seeders) : null,
      size_human: source.size_human || null,
      size_bytes: source.size_bytes || null,
      is_fallback: false,
      status: "ready",
      updated_at: new Date().toISOString(),
      payload: {
        provider: source.provider || null,
        title: source.title || content.title,
        language_label: source.language || "Hindi / Dual Audio",
        size_human: source.size_human || null,
        size_bytes: source.size_bytes || null,
        primary: Boolean(source.primary),
        resolvedAt: new Date().toISOString(),
        overview: content.details?.overview || content.details?.description || "",
        poster_url: content.details?.poster || null,
        backdrop_url: content.details?.backdrop || null,
        rating: content.details?.rating != null ? Number(content.details.rating) : null,
      },
    };
    if (await upsertSource(supabase, row)) {
      saved += 1;
      try {
        await supabase
          .from("catalog_titles")
          .update({
            overview: content.details?.overview || null,
            poster_url: content.details?.poster || null,
            backdrop_url: content.details?.backdrop || null,
            rating_percent: content.details?.rating != null ? Number(content.details.rating) : null,
          })
          .eq("external_id", mediaId);
      } catch (_) {}
    }
  }
  return saved;
}

async function countContent(supabase) {
  const { count, error } = await supabase.from(MEDIA_CONTENT_TABLE).select("id", { count: "exact", head: true });
  if (error) return 7000;
  return count || 7000;
}

async function countReadyDdlSources(supabase) {
  const { count, error } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("source_type", "ddl")
    .eq("status", "ready");
  if (error) return 0;
  return count || 0;
}

async function fetchNextBatch(supabase, afterId, batchSize) {
  let query = supabase
    .from(MEDIA_CONTENT_TABLE)
    .select("id, external_id, source, title, media_type, details")
    .order("id", { ascending: true })
    .limit(batchSize);

  if (afterId > 0) {
    query = query.gt("id", afterId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`media_content fetch failed: ${error.message}`);
  return data || [];
}

async function getReadyDdlIds(supabase, batch) {
  const ids = batch.map(mediaIdOf).filter(Boolean);
  if (!ids.length) return new Set();

  const { data, error } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("media_id")
    .in("media_id", ids)
    .eq("source_type", "ddl")
    .eq("status", "ready");

  if (error) {
    console.warn(`[enrich] Deduplication lookup failed: ${error.message}`);
    return new Set();
  }
  return new Set((data || []).map((row) => String(row.media_id)));
}

async function eachLimit(items, limit, worker) {
  const queue = items.slice();
  const size = Math.max(1, Math.min(limit, queue.length || 1));
  const runners = Array.from({ length: size }, async () => {
    while (queue.length && !stopRequested) {
      const item = queue.shift();
      await worker(item);
      if (queue.length && !stopRequested) await sleep(WORKER_DELAY_MS);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("Usage: npm run enrich -- [--reset] [--limit N] [--workers 3] [--batch 50]");
    return;
  }

  if (args.reset && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
    console.log("[enrich] Checkpoint reset. Starting from catalog ID 0.");
  }

  const checkpoint = readCheckpoint();
  const started = Date.now();
  const supabase = getSupabaseClient();

  initTorrentProviders();

  const totalContent = await countContent(supabase);
  const totalBatches = Math.max(1, Math.ceil(totalContent / args.batch));
  let totalDdlReady = await countReadyDdlSources(supabase);

  console.log("===============================================================================");
  console.log(" High-Throughput Batch Catalog Enrichment & Torrent-to-DDL Pre-Conversion Engine");
  console.log("===============================================================================");
  console.log(`[enrich] Total Catalog Items : ${totalContent}`);
  console.log(`[enrich] Batch Size          : ${args.batch} items / batch (~${totalBatches} batches total)`);
  console.log(`[enrich] Concurrency Limiter : ${args.workers} concurrent workers`);
  console.log(`[enrich] Query Timeout       : ${args.timeout}ms`);
  console.log(`[enrich] Resuming From ID    : ${checkpoint.last_processed_id} (Batch ${checkpoint.batch_index})`);
  console.log(`[enrich] Current Ready DDL   : ${totalDdlReady} sources`);
  console.log("===============================================================================\n");

  let sessionCount = 0;

  while (!stopRequested) {
    if (args.limit && sessionCount >= args.limit) {
      console.log(`[enrich] Reached requested session limit of ${args.limit} items.`);
      break;
    }

    const batch = await fetchNextBatch(supabase, checkpoint.last_processed_id, args.batch);
    if (!batch.length) {
      console.log("[enrich] All catalog items have been evaluated!");
      break;
    }

    checkpoint.batch_index += 1;
    const batchNum = `${checkpoint.batch_index}/${totalBatches}`;

    // 2. Deduplication & Idempotency: Skip titles that already have a ready DDL source
    const readyIds = await getReadyDdlIds(supabase, batch);
    const toProcess = [];

    for (const item of batch) {
      if (args.limit && sessionCount >= args.limit) break;
      const mediaId = mediaIdOf(item);
      const title = String(item.title || "Untitled").trim();

      if (readyIds.has(mediaId) && !args.force) {
        checkpoint.total_processed += 1;
        sessionCount += 1;
        console.log(`[Batch ${batchNum}] Processed: "${title}" | Converted to DDL: Skipped (Already Ready) | Seeders: - | Total DDL Ready in DB: ${totalDdlReady}`);
      } else if (isUnreleased(item)) {
        checkpoint.total_processed += 1;
        sessionCount += 1;
        console.log(`[Batch ${batchNum}] Processed: "${title}" | Converted to DDL: Skipped (Unreleased) | Seeders: - | Total DDL Ready in DB: ${totalDdlReady}`);
      } else {
        toProcess.push(item);
      }
    }

    // 3. Concurrency Limiter: Process unresolved items in parallel pool (3-5 workers)
    if (toProcess.length) {
      await eachLimit(toProcess, args.workers, async (row) => {
        if (stopRequested) return;
        if (args.limit && sessionCount >= args.limit) return;
        sessionCount += 1;
        checkpoint.total_processed += 1;

        const title = String(row.title || "").trim();
        const year = yearOf(row);

        try {
          const mediaId = mediaIdOf(row);
          const sources = await discoverSources(title, year, args.timeout, row.media_type || "movie", row.details || {}, mediaId);
          if (sources.length) {
            const wrote = await saveSources(supabase, row, sources);
            if (wrote) {
              totalDdlReady += 1;
              checkpoint.total_ddl_converted += 1;
            }
            const seeders = sources[0].seeders || 0;
            console.log(`[Batch ${batchNum}] Processed: "${title}" | Converted to DDL: Yes | Seeders: ${seeders} | Total DDL Ready in DB: ${totalDdlReady}`);
          } else {
            console.log(`[Batch ${batchNum}] Processed: "${title}" | Converted to DDL: No | Seeders: 0 | Total DDL Ready in DB: ${totalDdlReady}`);
          }
        } catch (err) {
          console.log(`[Batch ${batchNum}] Processed: "${title}" | Converted to DDL: Error (${err.message}) | Seeders: 0 | Total DDL Ready in DB: ${totalDdlReady}`);
        }
      });
    }

    checkpoint.last_processed_id = batch[batch.length - 1].id;
    writeCheckpoint(checkpoint);
    await sleep(200);
  }

  writeCheckpoint(checkpoint);
  console.log("\n===============================================================================");
  console.log(`[enrich] ${stopRequested ? "Paused" : "Completed"} in ${formatDuration(Date.now() - started)}.`);
  console.log(`[enrich] Total Items Processed   : ${checkpoint.total_processed}`);
  console.log(`[enrich] Total DDL Converted     : ${checkpoint.total_ddl_converted}`);
  console.log(`[enrich] Total DDL Ready in DB   : ${totalDdlReady}`);
  console.log(`[enrich] Checkpoint Saved At     : ${CHECKPOINT_PATH}`);
  console.log("===============================================================================\n");
}

process.on("SIGINT", () => {
  if (stopRequested) {
    process.exit(1);
    return;
  }
  stopRequested = true;
  console.log("\n[enrich] Ctrl+C detected — finishing active batch then saving checkpoint...");
});

if (require.main === module) {
  main().catch((err) => {
    console.error("[enrich] Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  buildEnrichQueries,
  readCheckpoint,
  writeCheckpoint,
};
