#!/usr/bin/env node
"use strict";

/**
 * Fill missing torrent/DDL sizes from payload, magnet xl, the release title,
 * or the .torrent metadata. Never writes 0. Embed rows are skipped.
 *
 *   node scripts/backfillSourceSizes.js
 */

const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { publicSize, lookupReleaseBytes } = require("../server/services/torrentResolver");

const PAGE = 200;

async function loadMissing(supabase, afterId) {
  const { data, error } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("id, media_title, source_type, download_url, magnet_link, payload, size_bytes, size_human")
    .in("source_type", ["torrent", "ddl"])
    .or("size_bytes.is.null,size_bytes.lte.0")
    .gt("id", afterId)
    .order("id", { ascending: true })
    .limit(PAGE);
  if (error) throw new Error(error.message);
  return data || [];
}

async function main() {
  const supabase = getSupabaseClient();
  let afterId = 0;
  let updated = 0;
  let stillUnknown = 0;
  let scanned = 0;

  for (;;) {
    const rows = await loadMissing(supabase, afterId);
    if (!rows.length) break;
    afterId = rows[rows.length - 1].id;
    for (const row of rows) {
      scanned += 1;
      let size = publicSize(row);
      if (!size.size_bytes && row.source_type === "torrent") {
        size = await lookupReleaseBytes(row);
      }
      if (!size.size_bytes) {
        stillUnknown += 1;
        continue;
      }
      const payload = { ...(row.payload || {}), size_bytes: size.size_bytes, size_human: size.size_human };
      const { error } = await supabase
        .from(MEDIA_SOURCES_TABLE)
        .update({ size_bytes: size.size_bytes, size_human: size.size_human, payload })
        .eq("id", row.id)
        .or("size_bytes.is.null,size_bytes.lte.0");
      if (error) {
        console.warn(`[size-backfill] ${row.media_title}: ${error.message}`);
        stillUnknown += 1;
        continue;
      }
      updated += 1;
      console.log(`[size-backfill] ${row.media_title} · ${size.size_human}`);
    }
  }

  console.log(`[size-backfill] scanned ${scanned} · updated ${updated} · still unknown ${stillUnknown}`);
}

main().catch((error) => {
  console.error(`[size-backfill] ${error.message}`);
  process.exitCode = 1;
});
