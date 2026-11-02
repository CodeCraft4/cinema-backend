/**
 * scripts/addLowerQualityMovies.js
 *
 * Movies that only have a 1080p+ row stream slowly on a phone. This adds the missing 480p /
 * 720p tiers (TorBox-cached, Hindi / Dual audio only, phone-friendly, small) as extra rows.
 *
 *   node scripts/addLowerQualityMovies.js --dry-run --limit 20
 *   node scripts/addLowerQualityMovies.js --limit 300
 */

"use strict";

const { getSupabaseClient } = require("../server/services/supabaseClient");
const { fetchTorrentio } = require("../server/services/torrentioClient");
const { tmdb, checkCached, parseMovieStream, bestForTier, movieRow, TIERS } = require("./ingestIndustryTargets");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const LIMIT = Number(args[args.indexOf("--limit") + 1]) || 200;
const LOWER = TIERS.filter((t) => t.quality === "480p" || t.quality === "720p");

async function main() {
  const sb = getSupabaseClient();
  const tiersByMovie = new Map();
  const meta = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("media_sources").select("media_id,media_title,quality,year,payload").eq("status", "ready").not("media_id", "like", "%-s%e%").range(from, from + 999).order("id");
    if (error) throw error;
    for (const r of data) {
      if (!tiersByMovie.has(r.media_id)) tiersByMovie.set(r.media_id, new Set());
      tiersByMovie.get(r.media_id).add(r.quality);
      meta.set(r.media_id, r);
    }
    if (data.length < 1000) break;
  }
  const todo = [...tiersByMovie].filter(([, q]) => !q.has("480p") && !q.has("720p")).map(([id]) => id).slice(0, LIMIT);
  console.log(`movies with only high quality: ${[...tiersByMovie].filter(([, q]) => !q.has("480p") && !q.has("720p")).length}; processing ${todo.length}${DRY ? " [dry run]" : ""}`);

  let added = 0;
  let rowsAdded = 0;
  for (const id of todo) {
    try {
      const m = meta.get(id);
      const ext = await tmdb(`/movie/${id}/external_ids`);
      if (!ext?.imdb_id) continue;
      const info = await tmdb(`/movie/${id}`);
      const hindiOriginal = info?.original_language === "hi" || info?.original_language === "ur";
      const streams = (await fetchTorrentio(`movie/${ext.imdb_id}`)).streams || [];
      const cands = streams.map(parseMovieStream).filter(Boolean).map((c) => (hindiOriginal && !c.kind ? { ...c, kind: "hindi" } : c));
      const cachedSet = cands.length ? await checkCached([...new Set(cands.map((c) => c.hash))]) : new Set();
      const rows = [];
      const poster = m.payload?.poster_url || (info?.poster_path ? `https://image.tmdb.org/t/p/w500${info.poster_path}` : null);
      const backdrop = m.payload?.backdrop_url || (info?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${info.backdrop_path}` : null);
      for (const tier of LOWER) {
        const pick = bestForTier(cands, cachedSet, tier, !hindiOriginal);
        if (pick) rows.push(movieRow({ id, title: m.media_title, vote_average: info?.vote_average, original_language: info?.original_language }, m.year || String(info?.release_date || "").slice(0, 4), pick, tier, poster, backdrop));
      }
      if (!rows.length) continue;
      if (!DRY) {
        const { error } = await sb.from("media_sources").upsert(rows, { onConflict: "media_id,quality,language" });
        if (error) throw error;
      }
      added++;
      rowsAdded += rows.length;
      console.log(`  + ${m.media_title}: ${rows.map((r) => `${r.quality}/${r.language}`).join(", ")}`);
    } catch (err) {
      console.warn(`  ! ${id}: ${err.message}`);
    }
  }
  console.log(`\nDone. movies upgraded ${added}/${todo.length}, rows ${rowsAdded}${DRY ? " [dry run]" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
