"use strict";

/**
 * 🖼️ Backfill TMDB Poster & Backdrop URLs into Supabase `media_sources` payload JSON
 * 
 * Purpose:
 * - Scans all rows in `media_sources` where `payload->poster_url` is null or missing.
 * - Resolves the authentic poster & backdrop from Supabase `media_content` table (or TMDB API fallback).
 * - Updates `payload` JSON with full `https://image.tmdb.org/t/p/w500/...` URLs.
 * - Fixes posters appearing blank or missing on frontend APK & desktop app.
 */

const axios = require("axios");
const env = require("../server/config/env");
const { getSupabaseClient, MEDIA_SOURCES_TABLE, MEDIA_CONTENT_TABLE } = require("../server/services/supabaseClient");

const TMDB_API_KEY = env.tmdbApiKey || process.env.TMDB_API_KEY;
const CONCURRENCY = 15;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeImageUrl(path, size = "w500") {
  if (!path || typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const cleanPath = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `https://image.tmdb.org/t/p/${size}${cleanPath}`;
}

async function buildMediaContentIndex(supabase) {
  console.log("🔍 Loading all media_content records into memory index for fast lookups...");
  const byExt = new Map();
  const byId = new Map();
  const byTitle = new Map();

  let offset = 0;
  const batchSize = 1000;
  let totalCount = 0;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, external_id, title, details")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error("❌ Error reading media_content:", error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const details = row.details || {};
      const posterPath = details.poster_url || details.poster || details.poster_path;
      const backdropPath = details.backdrop_url || details.backdrop || details.backdrop_path;
      const posterUrl = normalizeImageUrl(posterPath, "w500");
      const backdropUrl = normalizeImageUrl(backdropPath, "w1280");
      const overview = details.overview || details.description || null;
      const rating = details.rating_percent || (details.vote_average ? Math.round(Number(details.vote_average) * 10) : null);

      const meta = { posterUrl, backdropUrl, overview, rating };

      if (row.external_id != null) byExt.set(String(row.external_id), meta);
      if (row.id != null) byId.set(String(row.id), meta);
      if (row.title) byTitle.set(String(row.title).toLowerCase().trim(), meta);
      if (details.original_title) byTitle.set(String(details.original_title).toLowerCase().trim(), meta);
    }

    totalCount += data.length;
    if (data.length < batchSize) break;
    offset += batchSize;
  }

  console.log(`✅ Loaded ${totalCount} titles into memory index.\n`);
  return { byExt, byId, byTitle };
}

async function fetchTmdbMetaFallback(mediaId, title, year) {
  if (!TMDB_API_KEY) return null;
  const cleanId = String(mediaId || "").split(":")[0].trim();
  const isNumeric = /^\d+$/.test(cleanId) && Number(cleanId) > 0;

  try {
    // 1. Try numeric ID direct lookup
    if (isNumeric) {
      for (const type of ["tv", "movie"]) {
        try {
          const res = await axios.get(`https://api.themoviedb.org/3/${type}/${cleanId}`, {
            params: { api_key: TMDB_API_KEY },
            timeout: 3000,
          });
          if (res.data && res.data.poster_path) {
            return {
              posterUrl: normalizeImageUrl(res.data.poster_path, "w500"),
              backdropUrl: normalizeImageUrl(res.data.backdrop_path, "w1280"),
              overview: res.data.overview || null,
              rating: res.data.vote_average ? Math.round(Number(res.data.vote_average) * 10) : null,
            };
          }
        } catch (_) {}
      }
    }

    // 2. Try title search
    if (title && String(title).trim()) {
      const cleanTitle = String(title).split(/[\(\[\:]/)[0].trim();
      const res = await axios.get("https://api.themoviedb.org/3/search/multi", {
        params: {
          api_key: TMDB_API_KEY,
          query: cleanTitle,
          year: year || undefined,
        },
        timeout: 3000,
      });
      const hit = res.data?.results?.[0];
      if (hit && hit.poster_path) {
        return {
          posterUrl: normalizeImageUrl(hit.poster_path, "w500"),
          backdropUrl: normalizeImageUrl(hit.backdrop_path, "w1280"),
          overview: hit.overview || null,
          rating: hit.vote_average ? Math.round(Number(hit.vote_average) * 10) : null,
        };
      }
    }
  } catch (_) {}
  return null;
}

async function run() {
  console.log("===============================================================================");
  console.log(" 🖼️ TMDB Poster & Backdrop Backfill for media_sources");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  const index = await buildMediaContentIndex(supabase);

  console.log("🔍 Fetching rows from media_sources where payload->poster_url is missing or null...");
  let offset = 0;
  const batchSize = 1000;
  let missingRows = [];

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, year, payload")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error("❌ Failed to query media_sources:", error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const r of data) {
      const p = r.payload || {};
      if (!p.poster_url || String(p.poster_url).trim() === "" || p.poster_url === "null") {
        missingRows.push(r);
      }
    }

    if (data.length < batchSize) break;
    offset += batchSize;
  }

  console.log(`📋 Total rows in media_sources needing poster fix: ${missingRows.length}\n`);
  if (missingRows.length === 0) {
    console.log("🎉 All rows in media_sources already have valid poster_url!");
    return;
  }

  let updatedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < missingRows.length; i += CONCURRENCY) {
    const chunk = missingRows.slice(i, i + CONCURRENCY);
    const updates = await Promise.all(
      chunk.map(async (row) => {
        const baseId = String(row.media_id || "").split(":")[0].trim();
        const cleanTitle = String(row.media_title || "").toLowerCase().trim();

        let meta = index.byExt.get(baseId) || index.byId.get(baseId) || index.byTitle.get(cleanTitle);

        if (!meta || !meta.posterUrl) {
          meta = await fetchTmdbMetaFallback(baseId, row.media_title, row.year);
        }

        if (!meta || !meta.posterUrl) {
          return { id: row.id, ok: false, title: row.media_title };
        }

        const newPayload = {
          ...(row.payload || {}),
          poster_url: meta.posterUrl,
          backdrop_url: meta.backdropUrl || row.payload?.backdrop_url || null,
          overview: row.payload?.overview || meta.overview || null,
          rating: row.payload?.rating != null ? row.payload.rating : meta.rating,
        };

        const { error: updErr } = await supabase
          .from(MEDIA_SOURCES_TABLE)
          .update({ payload: newPayload, updated_at: new Date().toISOString() })
          .eq("id", row.id);

        if (updErr) {
          return { id: row.id, ok: false, error: updErr.message };
        }

        return { id: row.id, ok: true, title: row.media_title, posterUrl: meta.posterUrl };
      })
    );

    for (const res of updates) {
      if (res.ok) {
        updatedCount++;
      } else {
        failedCount++;
      }
    }

    const progress = Math.min(i + CONCURRENCY, missingRows.length);
    const pct = Math.round((progress / missingRows.length) * 100);
    process.stdout.write(`\r🔄 Progress: ${progress}/${missingRows.length} (${pct}%) | ✅ Fixed: ${updatedCount} | ⏳ Skipped: ${failedCount}`);

    await sleep(25);
  }

  console.log("\n\n===============================================================================");
  console.log(" 🎉 Poster Backfill Finished!");
  console.log(` ✅ Successfully Updated : ${updatedCount} rows with authentic TMDB Posters`);
  console.log(` ⚠️ Unmatched Titles     : ${failedCount}`);
  console.log("===============================================================================\n");
}

run().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
