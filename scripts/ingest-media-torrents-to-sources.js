#!/usr/bin/env node
"use strict";

/**
 * Ingests existing torrent magnets from `media_torrents` table directly
 * into `media_sources` as pre-converted DDL HTTP endpoints.
 */

const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { magnetWrite } = require("../server/services/torrentResolver");

async function main() {
  const supabase = getSupabaseClient();
  console.log("[ingest] Fetching media_torrents with magnets...");

  const { data: torrents, error } = await supabase
    .from("media_torrents")
    .select("id, external_id, title, magnet, quality, media_type, seeds, language_tags")
    .not("magnet", "is", null)
    .limit(3000);

  if (error) {
    console.error("[ingest] Error fetching media_torrents:", error.message);
    return;
  }

  console.log(`[ingest] Found ${torrents.length} torrent records in media_torrents.`);
  let inserted = 0;
  let skipped = 0;

  for (const t of torrents) {
    const magnet = String(t.magnet || "").trim();
    if (!/^magnet:/i.test(magnet)) {
      skipped++;
      continue;
    }

    const written = magnetWrite(magnet);
    if (!written) {
      skipped++;
      continue;
    }

    const mediaId = String(t.external_id || t.id);
    const lang = Array.isArray(t.language_tags) && t.language_tags.length ? t.language_tags.join(" / ") : "Original / Dual Audio";
    const quality = t.quality && t.quality !== "unknown" ? t.quality : "1080p";

    const row = {
      cache_key: `${mediaId}::${(t.title || "").slice(0, 50).toLowerCase()}::${lang.toLowerCase()}::${quality.toLowerCase()}`,
      media_id: mediaId,
      media_title: String(t.title || "Untitled").slice(0, 255),
      year: null,
      language: lang,
      quality: quality,
      source_type: written.source_type, // "ddl"
      download_url: written.download_url,
      stream_url: written.stream_url,
      magnet_link: written.magnet_link,
      seeders: Number(t.seeds) || 0,
      is_fallback: false,
      status: "ready",
      updated_at: new Date().toISOString(),
      payload: {
        title: t.title,
        media_type: t.media_type,
        source: "media_torrents_ingest",
        resolvedAt: new Date().toISOString(),
      },
    };

    const { error: upsertErr } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .upsert(row, { onConflict: "media_id,quality,language" });

    if (!upsertErr) {
      inserted++;
    } else {
      skipped++;
    }
  }

  console.log(`[ingest] Finished! Successfully converted & upserted ${inserted} DDL sources to media_sources (Skipped: ${skipped}).`);
}

main().catch(console.error);
