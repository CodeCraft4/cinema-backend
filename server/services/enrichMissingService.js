"use strict";

/**
 * Enrich titles that already exist in media_content but still have no ready
 * DDL/torrent row in media_sources. Designed to run on Railway via HTTP so the
 * remaining catalog (~4k+) can be filled without a local CLI.
 */

const axios = require("axios");
const env = require("../config/env");
const { HttpError } = require("../utils/http");
const {
  getSupabaseClient,
  MEDIA_CONTENT_TABLE,
  MEDIA_SOURCES_TABLE,
} = require("./supabaseClient");
const { saveTorrentRelease } = require("./mediaSourceService");
const { discoverCascadingTorrents, normalizeSourceLinks, publicSize } = require("./torrentResolver");
const { getServerBaseUrl } = require("./torrentStreamEngine");

async function ensureTmdbMetadata(content) {
  const mediaId = content?.external_id;
  const mediaType = content?.media_type === "tv" ? "tv" : "movie";
  let details = { ...(content?.details || {}) };
  let overview = details.overview || details.description || "";
  let poster = details.poster || details.poster_url || null;
  let backdrop = details.backdrop || details.backdrop_url || null;
  let rating = details.rating != null ? Number(details.rating) : null;

  // If overview or poster is missing and TMDB key is configured, fetch live from TMDB
  if ((!overview || !poster) && env.tmdbApiKey && mediaId) {
    try {
      const endpoint = `https://api.themoviedb.org/3/${mediaType}/${mediaId}`;
      const res = await axios.get(endpoint, {
        params: { api_key: env.tmdbApiKey },
        timeout: 5000,
      });
      const data = res.data;
      if (data) {
        overview = data.overview || data.description || overview || "";
        if (data.poster_path) {
          poster = `https://image.tmdb.org/t/p/w500${data.poster_path}`;
        }
        if (data.backdrop_path) {
          backdrop = `https://image.tmdb.org/t/p/w1280${data.backdrop_path}`;
        }
        if (data.vote_average != null) {
          rating = Math.round(Number(data.vote_average) * 100) / 10;
        }

        details = {
          ...details,
          overview,
          poster,
          backdrop,
          rating,
        };

        const supabase = getSupabaseClient();
        await supabase
          .from(MEDIA_CONTENT_TABLE)
          .update({ details, updated_at: new Date().toISOString() })
          .eq("id", content.id);

        try {
          await supabase
            .from("catalog_titles")
            .update({
              overview: overview || null,
              poster_url: poster || null,
              backdrop_url: backdrop || null,
              rating_percent: rating,
            })
            .eq("external_id", mediaId);
        } catch (_) {}
      }
    } catch (e) {
      // Graceful fallback if TMDB request fails
    }
  }

  return {
    overview: overview || "",
    posterUrl: poster || null,
    backdropUrl: backdrop || null,
    rating,
    details,
  };
}

const DEFAULT_BATCH = 25;
const MAX_BATCH = 100;
const DEFAULT_WORKERS = 3;
const ENRICH_TIMEOUT_MS = 6000;

let job = {
  running: false,
  started_at: null,
  finished_at: null,
  requested: 0,
  processed: 0,
  enriched: 0,
  skipped: 0,
  no_torrent: 0,
  failed: 0,
  remaining_estimate: null,
  last_error: null,
  items: [],
};

function yearFrom(value) {
  return String(value || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
}

function isFutureRelease(details) {
  const raw = details?.release_date || "";
  if (!raw) {
    const year = Number(details?.year);
    return Number.isFinite(year) && year > new Date().getFullYear();
  }
  const date = new Date(raw);
  return !Number.isNaN(date.getTime()) && date.getTime() > Date.now();
}

function presentStoredSource(source) {
  if (!source) return null;
  const links = normalizeSourceLinks(source);
  const size = publicSize(source);
  return {
    language: source.language_label || source.language || "",
    quality: source.quality || "",
    source_type: links.source_type,
    download_url: links.download_url,
    stream_url: links.stream_url,
    magnet_link: links.magnet_link,
    size_bytes: size.size_bytes,
    size_human: size.size_human,
    seeders: source.seeders == null ? 0 : Number(source.seeders),
    status: "ready",
  };
}

async function eachLimit(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function coveredMediaIds() {
  const supabase = getSupabaseClient();
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("media_id, stream_url")
      .eq("status", "ready")
      .in("source_type", ["ddl", "torrent"])
      .not("stream_url", "is", null)
      .range(from, from + 999);
    if (error) throw new Error(error.message || "media_sources coverage read failed");
    if (!data?.length) break;
    for (const row of data) {
      if (row.media_id && row.stream_url) ids.add(String(row.media_id));
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return ids;
}

async function loadMissingBatch({ afterId = 0, limit = DEFAULT_BATCH } = {}) {
  const supabase = getSupabaseClient();
  const covered = await coveredMediaIds();
  const batch = [];
  let cursor = Number(afterId) || 0;

  while (batch.length < limit) {
    let query = supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, external_id, source, title, media_type, details")
      .order("id", { ascending: true })
      .limit(200);
    if (cursor > 0) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message || "media_content read failed");
    if (!data?.length) break;
    for (const row of data) {
      cursor = Number(row.id) || cursor;
      const mediaId = row.external_id == null ? "" : String(row.external_id).trim();
      if (!mediaId || covered.has(mediaId)) continue;
      batch.push(row);
      if (batch.length >= limit) break;
    }
    if (data.length < 200) break;
  }

  return { rows: batch, nextAfterId: cursor, coveredCount: covered.size };
}

async function enrichOne(content, { baseUrl } = {}) {
  const title = String(content.title || "").trim();
  const year = content.details?.year || yearFrom(content.details?.release_date);
  const mediaId = String(content.external_id);
  const imdbId = content.details?.imdb_id || "";
  if (!title) return { status: "skipped", reason: "missing_title" };
  if (isFutureRelease(content.details || {})) {
    return { status: "skipped", reason: "unreleased", title, media_id: mediaId };
  }

  const found = await discoverCascadingTorrents({
    title,
    year,
    mediaType: content.media_type || "movie",
    imdbId,
    tmdbId: mediaId,
    originalLanguage: content.details?.originalLanguage || "",
    country: Array.isArray(content.details?.originCountry) ? content.details.originCountry.join(",") : "",
    timeoutMs: ENRICH_TIMEOUT_MS,
    allowEmbed: false,
    requireDubMarker: true,
  });

  if (!found || found.source_type === "embed_stream" || !found.magnet_link) {
    return { status: "no_torrent", title, media_id: mediaId, year };
  }

  const meta = await ensureTmdbMetadata(content);

  const stored = await saveTorrentRelease(
    {
      mediaId,
      imdbId,
      title,
      year,
      language: found.language_label || found.language,
      quality: found.quality,
      mediaType: content.media_type || "movie",
      baseUrl,
      overview: meta.overview,
      posterUrl: meta.posterUrl,
      backdropUrl: meta.backdropUrl,
      rating: meta.rating,
    },
    found
  );
  if (!stored) return { status: "no_torrent", title, media_id: mediaId, year, reason: "save_rejected" };

  const links = normalizeSourceLinks(stored, baseUrl);
  return {
    status: "enriched",
    title,
    media_id: mediaId,
    year,
    source: presentStoredSource({ ...stored, ...links }),
  };
}

function getEnrichMissingStatus() {
  return { ...job, items: (job.items || []).slice(-30) };
}

let shouldStop = false;

function stopEnrichMissing() {
  shouldStop = true;
  job.running = false;
  job.finished_at = new Date().toISOString();
}

/**
 * Start a background enrich pass for titles missing ready DDL/torrent sources.
 * Returns immediately so Railway HTTP timeouts do not kill the job.
 */
async function startEnrichMissing({
  limit = DEFAULT_BATCH,
  afterId = 0,
  workers = DEFAULT_WORKERS,
  baseUrl = null,
  continuous = true,
} = {}) {
  if (job.running) {
    throw new HttpError(409, "An enrich-missing job is already running", "JOB_IN_PROGRESS");
  }

  const safeLimit = Math.max(1, Math.min(MAX_BATCH, Number(limit) || DEFAULT_BATCH));
  const safeWorkers = Math.max(1, Math.min(6, Number(workers) || DEFAULT_WORKERS));
  const resolvedBase = getServerBaseUrl(baseUrl);

  const preview = await loadMissingBatch({ afterId, limit: safeLimit });
  const contentCount = await getSupabaseClient()
    .from(MEDIA_CONTENT_TABLE)
    .select("id", { count: "exact", head: true });

  job = {
    running: true,
    continuous: Boolean(continuous),
    started_at: new Date().toISOString(),
    finished_at: null,
    requested: safeLimit,
    processed: 0,
    enriched: 0,
    skipped: 0,
    no_torrent: 0,
    failed: 0,
    after_id: Number(afterId) || 0,
    next_after_id: preview.nextAfterId,
    covered_count: preview.coveredCount,
    media_content_total: contentCount.count || null,
    remaining_estimate: Math.max(0, (contentCount.count || 0) - preview.coveredCount),
    base_url: resolvedBase,
    last_error: null,
    items: [],
  };

  setImmediate(() => {
    void runEnrichJob({
      rows: preview.rows,
      workers: safeWorkers,
      baseUrl: resolvedBase,
      nextAfterId: preview.nextAfterId,
      continuous: Boolean(continuous),
      safeLimit,
    });
  });

  return getEnrichMissingStatus();
}

async function runEnrichJob({ rows: initialRows, workers, baseUrl, nextAfterId: initialAfterId, continuous = false, safeLimit = 50 }) {
  shouldStop = false;
  let currentRows = initialRows;
  let currentAfterId = initialAfterId;

  try {
    while (currentRows.length && !shouldStop) {
      console.log(
        `[enrich-missing] processing batch ${currentRows.length} · workers ${workers} · afterId ${currentAfterId}`
      );
      await eachLimit(currentRows, workers, async (content) => {
        if (shouldStop) return;
        try {
          const result = await enrichOne(content, { baseUrl });
          job.processed += 1;
          job.items.push({
            media_id: result.media_id || String(content.external_id),
            title: result.title || content.title,
            status: result.status,
            reason: result.reason || null,
            source: result.source || null,
          });
          if (result.status === "enriched") job.enriched += 1;
          else if (result.status === "skipped") job.skipped += 1;
          else if (result.status === "no_torrent") job.no_torrent += 1;
          else job.failed += 1;
        } catch (error) {
          job.processed += 1;
          job.failed += 1;
          job.last_error = error.message;
          job.items.push({
            media_id: String(content.external_id),
            title: content.title,
            status: "failed",
            error: error.message,
          });
          console.warn(`[enrich-missing] failed for "${content.title}":`, error.message);
        }
      });

      job.next_after_id = currentAfterId;

      if (!continuous || shouldStop) break;

      // Small breather between batches so Railway and Supabase aren't overwhelmed
      await new Promise((r) => setTimeout(r, 400));

      const nextBatch = await loadMissingBatch({ afterId: currentAfterId, limit: safeLimit });
      if (!nextBatch.rows.length) {
        console.log("[enrich-missing] All missing catalog items have been evaluated!");
        break;
      }
      currentRows = nextBatch.rows;
      currentAfterId = nextBatch.nextAfterId;
      job.remaining_estimate = Math.max(0, (job.media_content_total || 0) - nextBatch.coveredCount);
    }
  } catch (error) {
    job.last_error = error.message;
    console.warn("[enrich-missing] job crashed:", error.message);
  } finally {
    job.running = false;
    job.finished_at = new Date().toISOString();
    console.log(
      `[enrich-missing] completed pass · processed ${job.processed} · enriched ${job.enriched} · no_torrent ${job.no_torrent} · ` +
        `skipped ${job.skipped} · failed ${job.failed}`
    );
  }
}

module.exports = {
  startEnrichMissing,
  stopEnrichMissing,
  getEnrichMissingStatus,
  loadMissingBatch,
  DEFAULT_BATCH,
  MAX_BATCH,
};
