/**
 * scripts/hideIncompleteSeries.js
 *
 * Users must never open a series and find mostly "Not available". A show stays visible only
 * when at least one season is (almost) fully playable. Otherwise all of its rows are set to
 * status=hidden (nothing is deleted; set them back to "ready" to restore).
 *
 *   node scripts/hideIncompleteSeries.js              # report only
 *   node scripts/hideIncompleteSeries.js --apply      # hide the incomplete shows
 *   node scripts/hideIncompleteSeries.js --min 0.8    # coverage of the best season (default 0.8)
 *
 * Rows of single seasons that are below the threshold are left alone when the show has another
 * complete season: the app lists seasons from TMDB and marks missing episodes.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getSupabaseClient } = require("../server/services/supabaseClient");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const MIN = Number(args[args.indexOf("--min") + 1]) || 0.8;
const TMDB_KEY = process.env.TMDB_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdb(p) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.themoviedb.org/3${p}${p.includes("?") ? "&" : "?"}api_key=${TMDB_KEY}`);
      if (res.ok) return res.json();
      if (res.status === 404) return null;
    } catch {
      // retry
    }
    await sleep(500);
  }
  return null;
}

async function main() {
  require("../server/config/env");
  const sb = getSupabaseClient();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("media_sources").select("id,media_id").eq("status", "ready").like("media_id", "%-s%e%").range(from, from + 999).order("id");
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const shows = new Map(); // id -> { eps: Map(season -> Set(ep)), ids: [] }
  for (const r of rows) {
    const m = /^(\d+)-s(\d+)e(\d+)$/i.exec(r.media_id);
    if (!m) continue;
    if (!shows.has(m[1])) shows.set(m[1], { eps: new Map(), ids: [] });
    const s = shows.get(m[1]);
    s.ids.push(r.id);
    if (!s.eps.has(+m[2])) s.eps.set(+m[2], new Set());
    s.eps.get(+m[2]).add(+m[3]);
  }

  const today = new Date().toISOString().slice(0, 10);
  const keep = [];
  const hide = [];
  for (const [id, show] of shows) {
    const info = await tmdb(`/tv/${id}`);
    if (!info) {
      keep.push({ id, name: id, best: "?" });
      continue;
    }
    let best = 0;
    let maxPlayable = 0;
    for (const [season, set] of show.eps) {
      maxPlayable = Math.max(maxPlayable, set.size);
      const sd = await tmdb(`/tv/${id}/season/${season}`);
      const aired = (sd?.episodes || []).filter((e) => e.air_date && e.air_date <= today).length || 0;
      if (aired > 0) best = Math.max(best, Math.min(1, set.size / aired));
    }
    const entry = { id, name: info.name, best: Math.round(best * 100) + "%", rows: show.ids.length, ids: show.ids };
    // Very long running shows (daily soaps) can never reach 80%: keep them when a season has 30+ playable episodes.
    (best >= MIN || maxPlayable >= 30 ? keep : hide).push(entry);
  }

  console.log(`series with playable rows: ${shows.size} | visible (best season >= ${MIN * 100}%): ${keep.length} | to hide: ${hide.length}`);
  for (const h of hide) console.log(`  hide  ${h.name} (${h.id}) best season ${h.best}, ${h.rows} rows`);
  fs.writeFileSync(path.join(__dirname, "..", ".hide-incomplete-series.json"), JSON.stringify(hide.map((h) => ({ id: h.id, name: h.name, ids: h.ids }))));

  if (APPLY) {
    let n = 0;
    for (const h of hide) {
      for (let i = 0; i < h.ids.length; i += 100) {
        const { error } = await sb.from("media_sources").update({ status: "hidden" }).in("id", h.ids.slice(i, i + 100)).eq("status", "ready");
        if (!error) n += Math.min(100, h.ids.length - i);
      }
    }
    console.log(`hidden rows: ${n}`);
  } else {
    console.log("\nDry run. Add --apply to hide them.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
