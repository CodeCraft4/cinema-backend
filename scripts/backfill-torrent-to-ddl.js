#!/usr/bin/env node
"use strict";

/**
 * Robust backfill script:
 * Converts raw magnet: download_url / source_type="torrent" rows into DDL HTTP endpoints.
 * Includes retries and rate limiting to avoid Supabase fetch failure.
 *
 * Usage:
 *   node scripts/backfill-torrent-to-ddl.js
 */

const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { magnetWrite } = require("../server/services/torrentResolver");

const BATCH_SIZE = 50;
const DELAY_BETWEEN_BATCHES_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, retries = 5, delay = 1000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= retries) throw err;
      console.warn(`[backfill] Request failed: ${err.message}. Retrying in ${delay * attempt}ms...`);
      await sleep(delay * attempt);
    }
  }
}

async function fetchBatch(supabase) {
  return retry(async () => {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, quality, language, source_type, download_url, stream_url, magnet_link, status, payload")
      .or("download_url.ilike.magnet:%,source_type.eq.torrent")
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);

    if (error) throw new Error(error.message);
    return data || [];
  });
}

async function updateRow(supabase, id, patch) {
  return retry(async () => {
    const { error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .update(patch)
      .eq("id", id);

    if (error) throw new Error(error.message);
  });
}

async function main() {
  const supabase = getSupabaseClient();
  let totalUpdated = 0;
  let skipped = 0;

  console.log("[backfill] Starting robust magnet -> DDL conversion...");

  while (true) {
    const rows = await fetchBatch(supabase);
    if (!rows.length) {
      console.log("[backfill] No more magnet or source_type='torrent' rows found!");
      break;
    }

    for (const row of rows) {
      const magnet = String(row.magnet_link || row.download_url || "").trim();
      if (!/^magnet:/i.test(magnet)) {
        // If it's not a magnet, mark source_type as ddl if it already has an http stream
        if (/^https?:\/\//i.test(String(row.download_url || ""))) {
          await updateRow(supabase, row.id, { source_type: "ddl", status: "ready" });
          totalUpdated++;
        } else {
          skipped++;
        }
        continue;
      }

      const written = magnetWrite(magnet);
      if (!written) {
        skipped++;
        continue;
      }

      const patch = {
        source_type: written.source_type, // "ddl"
        download_url: written.download_url,
        stream_url: written.stream_url,
        magnet_link: written.magnet_link,
        status: "ready",
        updated_at: new Date().toISOString(),
      };

      try {
        await updateRow(supabase, row.id, patch);
        totalUpdated++;
        if (totalUpdated % 25 === 0) {
          console.log(`[backfill] Progress: ${totalUpdated} rows converted (e.g. "${row.media_title}" [${row.quality}])`);
        }
      } catch (err) {
        console.error(`[backfill] Failed row ${row.id}: ${err.message}`);
      }
    }

    await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  console.log(`[backfill] Successfully finished! Total rows converted to DDL: ${totalUpdated}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
