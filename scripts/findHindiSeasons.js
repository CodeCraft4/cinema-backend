/**
 * scripts/findHindiSeasons.js
 *
 * Finds Hindi / Dual audio releases for series seasons that have missing episodes, using
 * apibay (The Pirate Bay API) searches that Torrentio does not cover ("<show> S01 hindi").
 * Only releases already cached on TorBox are used; the pack's file list is read from TorBox,
 * every missing episode is matched to its own file, and one row per episode is stored.
 *
 *   node scripts/findHindiSeasons.js --show 71912 --dry-run     # one TMDB show id
 *   node scripts/findHindiSeasons.js --show 71912,76331
 *   node scripts/findHindiSeasons.js --all                      # every show with rows (ready or hidden)
 *   node scripts/findHindiSeasons.js --all --include-uncached --min-seeders 10
 *       # releases TorBox has not cached yet are stored too (healthy swarms only); the first
 *       # user who opens one makes TorBox cache it ("Preparing…" in the player)
 *
 * Rows that are hidden because their show was incomplete come back automatically when the show
 * gets a complete season (run hideIncompleteSeries.js afterwards to re-evaluate).
 */

"use strict";

const { getSupabaseClient } = require("../server/services/supabaseClient");
const env = require("../server/config/env");
const torbox = require("../server/services/torboxService");
const { hindiAudioKind, detectQuality, deviceCompatPenalty, packCoversSeason } = require("../server/services/releaseAudio");
const { buildRow, tmdb, checkCachedBatch } = require("./fillSeriesGaps");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ALL = args.includes("--all");
const INCLUDE_UNCACHED = args.includes("--include-uncached");
const MIN_SEEDERS = Number(args[args.indexOf("--min-seeders") + 1]) || 10;
const SHOWS = (args[args.indexOf("--show") + 1] || "").split(",").map((v) => v.trim()).filter((v) => /^\d+$/.test(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const CAM_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|predvd|dvdscr|screener|hqcam)\b/i;

async function tpb(query) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=200`, { signal: AbortSignal.timeout(15000) });
      const list = await res.json();
      return Array.isArray(list) ? list.filter((x) => x.info_hash && !/^0+$/.test(x.info_hash)) : [];
    } catch {
      await sleep(800);
    }
  }
  return [];
}

async function main() {
  const sb = getSupabaseClient();
  const report = { shows: 0, episodesAdded: 0, seasonsFilled: 0 };

  // Shows to work on: given ids, or every show that has rows (any status).
  let showIds = SHOWS;
  if (ALL) {
    const set = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("media_sources").select("media_id").like("media_id", "%-s%e%").range(from, from + 999).order("id");
      if (error) throw error;
      data.forEach((r) => set.add(r.media_id.split("-")[0]));
      if (data.length < 1000) break;
    }
    showIds = [...set];
  }

  for (const showId of showIds) {
    const info = await tmdb(`/tv/${showId}`);
    if (!info) continue;
    const today = new Date().toISOString().slice(0, 10);

    // Episodes that already have a ready Hindi / Dual row.
    const { data: haveRows } = await sb.from("media_sources").select("media_id").like("media_id", `${showId}-s%`).eq("status", "ready");
    const have = new Set((haveRows || []).map((r) => r.media_id.toLowerCase()));
    const poster = info.poster_path ? `https://image.tmdb.org/t/p/w500${info.poster_path}` : null;
    const backdrop = info.backdrop_path ? `https://image.tmdb.org/t/p/w1280${info.backdrop_path}` : null;
    const template = { poster_url: poster, backdrop_url: backdrop, series_poster_url: poster, rating: Math.round((info.vote_average || 0) * 10), original_language: info.original_language };
    const year = String(info.first_air_date || "").slice(0, 4);

    for (const s of info.seasons || []) {
      if (s.season_number === 0) continue;
      const sd = await tmdb(`/tv/${showId}/season/${s.season_number}`);
      const missing = (sd?.episodes || []).filter((e) => e.air_date && e.air_date <= today && !have.has(`${showId}-s${pad(s.season_number)}e${pad(e.episode_number)}`));
      if (!missing.length) continue;
      const sn = s.season_number;
      console.log(`\n${info.name} S${pad(sn)}: ${missing.length} episodes missing`);

      // 1. Search
      const queries = [`${info.name} S${pad(sn)} hindi`, `${info.name} season ${sn} hindi`, `${info.name} S${pad(sn)} dual audio`, `${info.name} complete hindi`];
      const found = new Map();
      for (const q of queries) {
        for (const r of await tpb(q)) {
          const name = r.name;
          if (CAM_RE.test(name) || !hindiAudioKind(name, null) || !packCoversSeason(name, sn)) continue;
          // A release for another season only ("S02" when we need S01) is not a match.
          const tags = [...name.matchAll(/\bs(\d{1,2})(?![\d])/gi)].map((m) => Number(m[1]));
          if (tags.length && !tags.includes(sn) && !/complete|s\d{1,2}\s*-\s*s?\d{1,2}/i.test(name)) continue;
          found.set(r.info_hash.toLowerCase(), { hash: r.info_hash.toLowerCase(), name, seeders: Number(r.seeders) || 0, size: Number(r.size) || 0 });
        }
        await sleep(350);
      }
      if (!found.size) {
        console.log("  no Hindi / Dual release found");
        continue;
      }

      // 2. Cached on TorBox only, phone-friendly first
      const cached = await checkCachedBatch([...found.keys()]);
      const cands = [...found.values()].filter((c) => cached.has(c.hash)).sort((a, b) => deviceCompatPenalty(a.name) - deviceCompatPenalty(b.name) || b.seeders - a.seeders);
      if (!cands.length) {
        const healthy = INCLUDE_UNCACHED
          ? [...found.values()].filter((c) => c.seeders >= MIN_SEEDERS).sort((a, b) => deviceCompatPenalty(a.name) - deviceCompatPenalty(b.name) || b.seeders - a.seeders)[0]
          : null;
        if (!healthy) {
          console.log(`  ${found.size} release(s) found but none cached on TorBox${INCLUDE_UNCACHED ? ` with ${MIN_SEEDERS}+ seeders` : ""} (${[...found.values()].map((c) => `${c.name.slice(0, 45)} [${c.seeders} seeds]`).slice(0, 2).join(" | ")})`);
          continue;
        }
        // Not cached yet: store one row per missing episode; the resolver finds each file when TorBox has cached it.
        const rows = missing.map((e) =>
          buildRow({
            showId,
            showName: info.name,
            year,
            season: sn,
            episode: e.episode_number,
            cand: { hash: healthy.hash, releaseName: healthy.name, filename: null, seeders: healthy.seeders, sizeBytes: 0, quality: detectQuality(healthy.name, "") || "720p", kind: hindiAudioKind(healthy.name, null) },
            cached: false,
            template,
            episodeInfo: e,
          })
        );
        console.log(`  not cached, ${healthy.seeders} seeders: storing ${rows.length} episodes (${healthy.name.slice(0, 60)})${DRY ? " [dry run]" : ""}`);
        if (!DRY) {
          for (let i = 0; i < rows.length; i += 100) {
            const { error } = await sb.from("media_sources").upsert(rows.slice(i, i + 100), { onConflict: "media_id,quality,language" });
            if (error) console.warn("  upsert failed:", error.message);
          }
        }
        report.episodesAdded += rows.length;
        report.seasonsFilled++;
        continue;
      }

      // 3. Map every missing episode to its own file inside the pack
      const stillMissing = new Map(missing.map((e) => [e.episode_number, e]));
      const toInsert = [];
      for (const cand of cands) {
        if (!stillMissing.size) break;
        const magnet = `magnet:?xt=urn:btih:${cand.hash}&dn=${encodeURIComponent(cand.name)}`;
        const pack = await torbox.getPackFiles(magnet);
        if (!pack) continue;
        for (const [epNum, epInfo] of [...stillMissing]) {
          const file = torbox.pickPrimaryVideoFile(pack.files, sn, epNum, { singleEpisode: false });
          if (!file) continue;
          const kind = hindiAudioKind(`${cand.name} ${file.name}`, null);
          const row = buildRow({
            showId,
            showName: info.name,
            year,
            season: sn,
            episode: epNum,
            cand: {
              hash: cand.hash,
              releaseName: cand.name,
              filename: file.name.split("/").pop(),
              seeders: cand.seeders,
              sizeBytes: Number(file.size) || 0,
              quality: detectQuality(`${cand.name} ${file.name}`, "") || "720p",
              kind,
            },
            cached: true,
            template,
            episodeInfo: epInfo,
          });
          toInsert.push(row);
          stillMissing.delete(epNum);
        }
        await sleep(300);
      }
      console.log(`  mapped ${toInsert.length}/${missing.length} episodes from cached pack(s)${DRY ? " [dry run]" : ""}`);
      if (toInsert.length && !DRY) {
        for (let i = 0; i < toInsert.length; i += 100) {
          const { error } = await sb.from("media_sources").upsert(toInsert.slice(i, i + 100), { onConflict: "media_id,quality,language" });
          if (error) console.warn("  upsert failed:", error.message);
        }
      }
      report.episodesAdded += toInsert.length;
      if (toInsert.length) report.seasonsFilled++;
    }
    report.shows++;
  }
  console.log(`\nDone. shows ${report.shows}, seasons with new episodes ${report.seasonsFilled}, episodes ${DRY ? "found" : "added"} ${report.episodesAdded}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
