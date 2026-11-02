/**
 * scripts/fillSeriesGaps.js
 *
 * Finds series episodes that are aired on TMDB but have no playable row in media_sources,
 * looks for a release on Torrentio, prefers releases that are already cached on TorBox
 * (instant native streaming + one-click download) and inserts them as status=ready.
 *
 * Usage:
 *   node scripts/fillSeriesGaps.js --dry-run              # report only
 *   node scripts/fillSeriesGaps.js                        # fill every show that has rows
 *   node scripts/fillSeriesGaps.js --show 100088          # one TMDB show id
 *   node scripts/fillSeriesGaps.js --hide-bad bad.json    # hide rows listed as unplayable first
 *   node scripts/fillSeriesGaps.js --min-uncached-seeders 20
 *
 * A release is only inserted when its episode file can be named (Torrentio filename) or the
 * torrent is a single-episode release, so the stream resolver never serves another episode.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getSupabaseClient } = require("../server/services/supabaseClient");
const env = require("../server/config/env");
const torbox = require("../server/services/torboxService");
const { fetchTorrentio } = require("../server/services/torrentioClient");
const { hindiAudioKind, audioLabel, detectQuality, episodeScope } = require("../server/services/releaseAudio");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY = flag("--dry-run");
const ONLY_SHOW = opt("--show");
const HIDE_BAD = opt("--hide-bad");
const MIN_UNCACHED_SEEDERS = Number(opt("--min-uncached-seeders", 20));
const STREAM_BASE = (process.env.SERVER_BASE_URL || process.env.PUBLIC_BACKEND_URL || "http://168.144.249.68:4555").replace(/\/$/, "");
const TMDB_KEY = process.env.TMDB_API_KEY || env.tmdbApiKey;
const REPORT = path.join(__dirname, "..", ".fill-series-report.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAM_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|predvd|dvdscr|screener|hqcam)\b/i;
const pad = (n) => String(n).padStart(2, "0");

async function tmdb(pathname) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.themoviedb.org/3${pathname}${pathname.includes("?") ? "&" : "?"}api_key=${TMDB_KEY}`);
      if (res.ok) return res.json();
      if (res.status === 404) return null;
    } catch {
      // retry
    }
    await sleep(500);
  }
  return null;
}

async function checkCachedBatch(hashes) {
  const cached = new Set();
  const key = env.torboxApiKey;
  for (let i = 0; i < hashes.length; i += 50) {
    const part = hashes.slice(i, i + 50);
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch("https://api.torbox.app/v1/api/torrents/checkcached?format=object", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: part }),
      });
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        for (const h of part) if (json.data && json.data[h]) cached.add(h);
        break;
      } catch {
        await sleep(2500 * (attempt + 1)); // "rate limit exceeded"
      }
    }
  }
  return cached;
}

function parseStream(stream, season, episode) {
  const lines = String(stream.title || "").split("\n");
  const releaseName = (lines[0] || "").trim();
  const filename = stream.behaviorHints?.filename || null;
  const text = `${releaseName} ${filename || ""}`;
  const seeders = Number((text + " " + (stream.title || "")).match(/👤\s*(\d+)/)?.[1] || 0);
  const sizeBytes = Number(stream.behaviorHints?.videoSize) || 0;
  const hash = String(stream.infoHash || "").toLowerCase();
  if (!hash || hash.length < 32) return null;
  if (CAM_RE.test(text)) return null;
  // A file / release tagged for another episode is never usable here.
  if (episodeScope(filename || releaseName, season, episode) === "other") return null;
  if (filename && episodeScope(releaseName, season, episode) === "other") return null;
  const kind = hindiAudioKind(text, null);
  return {
    hash,
    releaseName,
    filename,
    fileIdx: stream.fileIdx ?? null,
    seeders,
    sizeBytes,
    quality: detectQuality(text, "") || "720p",
    kind,
  };
}

function pickBest(cands, cachedSet) {
  const qRank = (q) => ({ "1080p": 0, "720p": 1, "480p": 2, "2160p": 3, "360p": 4 }[q] ?? 5);
  const score = (c) => [
    cachedSet.has(c.hash) ? 0 : 1, // cached first: starts in seconds
    c.kind === "dual" ? 0 : c.kind === "hindi" ? 1 : 2, // Hindi audio first
    c.sizeBytes > 6e9 ? 1 : 0, // avoid huge files for fast start
    qRank(c.quality),
    -c.seeders,
  ];
  return [...cands].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  })[0];
}

function buildRow({ showId, showName, year, season, episode, cand, cached, template, episodeInfo }) {
  const mediaId = `${showId}-s${pad(season)}e${pad(episode)}`;
  const title = `${showName} - S${pad(season)}E${pad(episode)}`;
  const label = audioLabel(cand.kind);
  const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dn = encodeURIComponent(cand.releaseName || title);
  const magnet = `magnet:?xt=urn:btih:${cand.hash}&dn=${dn}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce`;
  const bridge = `${STREAM_BASE}/api/media/stream/torrent/${cand.hash}/video.mp4?ep=${episode}&s=${season}`;
  const sizeHuman = cand.sizeBytes ? `${(cand.sizeBytes / 1e9).toFixed(2)} GB` : null;
  return {
    cache_key: `${mediaId}::${slug(title)}::${year || ""}::${slug(label)}::${cand.quality}`,
    media_id: mediaId,
    media_title: title,
    year: year || null,
    language: label,
    quality: cand.quality,
    source_type: "ddl",
    download_url: `${bridge}&download=1`,
    stream_url: bridge,
    magnet_link: magnet,
    seeders: cand.seeders,
    is_fallback: false,
    status: "ready",
    size_human: sizeHuman,
    size_bytes: cand.sizeBytes || null,
    payload: {
      ...(template || {}),
      title,
      season,
      episode,
      tmdb_id: String(showId),
      provider: "Torrentio",
      language_label: label,
      size_human: sizeHuman,
      episode_title: episodeInfo?.name || null,
      overview: episodeInfo?.overview || template?.overview || null,
      still_url: episodeInfo?.still_path ? `https://image.tmdb.org/t/p/w500${episodeInfo.still_path}` : template?.still_url || null,
      file_name: cand.filename || null,
      torbox_cached: cached,
      filled_by: "fillSeriesGaps",
    },
  };
}

async function main() {
  const sb = getSupabaseClient();

  if (HIDE_BAD) {
    const ids = JSON.parse(fs.readFileSync(HIDE_BAD, "utf8"));
    console.log(`Hiding ${ids.length} unplayable rows${DRY ? " (dry run)" : ""}`);
    if (!DRY) {
      for (let i = 0; i < ids.length; i += 100) {
        await sb.from("media_sources").update({ status: "hidden" }).in("id", ids.slice(i, i + 100));
      }
    }
  }

  // All ready TV rows → shows and the episodes they already have.
  let rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("media_sources")
      .select("media_id,payload")
      .like("media_id", "%-s%e%")
      .eq("status", "ready")
      .range(from, from + 999)
      .order("id");
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
  }
  const have = new Map(); // showId -> Set("s:e")
  const templates = new Map();
  for (const r of rows) {
    const m = /^(\d+)-s(\d+)e(\d+)$/i.exec(r.media_id);
    if (!m) continue;
    if (!have.has(m[1])) have.set(m[1], new Set());
    have.get(m[1]).add(`${+m[2]}:${+m[3]}`);
    if (!templates.has(m[1]) && r.payload) {
      const { poster_url, backdrop_url, series_poster_url, rating } = r.payload;
      templates.set(m[1], { poster_url, backdrop_url, series_poster_url, rating });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const shows = [...have.keys()].filter((id) => !ONLY_SHOW || id === String(ONLY_SHOW));
  const report = { shows: [], inserted: 0, uncachedInserted: 0, notFound: [] };

  for (const showId of shows) {
    const info = await tmdb(`/tv/${showId}`);
    if (!info) continue;
    const ext = await tmdb(`/tv/${showId}/external_ids`);
    const imdb = ext?.imdb_id;
    const year = String(info.first_air_date || "").slice(0, 4);
    const missing = [];
    for (const s of info.seasons || []) {
      if (s.season_number === 0) continue;
      const sd = await tmdb(`/tv/${showId}/season/${s.season_number}`);
      for (const e of sd?.episodes || []) {
        if (e.air_date && e.air_date <= today && !have.get(showId).has(`${s.season_number}:${e.episode_number}`)) {
          missing.push({ season: s.season_number, episode: e.episode_number, info: e });
        }
      }
    }
    if (!missing.length) continue;
    console.log(`\n${info.name} (${showId}) missing ${missing.length}`);
    if (!imdb) {
      report.notFound.push({ showId, name: info.name, reason: "no imdb id", count: missing.length });
      continue;
    }

    // 1. Torrentio candidates per missing episode
    const perEp = [];
    for (const m of missing) {
      let streams = [];
      try {
        streams = (await fetchTorrentio(`series/${imdb}:${m.season}:${m.episode}`)).streams || [];
      } catch (err) {
        console.warn(`  S${m.season}E${m.episode} torrentio: ${err.message}`);
      }
      const cands = streams.map((s) => parseStream(s, m.season, m.episode)).filter(Boolean);
      perEp.push({ ...m, cands });
    }

    // 2. One TorBox cache lookup for every hash of this show
    const hashes = [...new Set(perEp.flatMap((p) => p.cands.map((c) => c.hash)))];
    const cachedSet = hashes.length ? await checkCachedBatch(hashes) : new Set();

    // 3. Choose + insert
    const toInsert = [];
    for (const p of perEp) {
      const best = pickBest(p.cands, cachedSet);
      const isCached = best ? cachedSet.has(best.hash) : false;
      if (!best || (!isCached && best.seeders < MIN_UNCACHED_SEEDERS)) {
        report.notFound.push({ showId, name: info.name, season: p.season, episode: p.episode, reason: best ? `uncached, ${best.seeders} seeders` : "no release" });
        continue;
      }
      toInsert.push(
        buildRow({ showId, showName: info.name, year, season: p.season, episode: p.episode, cand: best, cached: isCached, template: templates.get(showId), episodeInfo: p.info })
      );
    }
    const cachedN = toInsert.filter((r) => r.payload.torbox_cached).length;
    console.log(`  found ${toInsert.length}/${missing.length} (TorBox cached: ${cachedN})`);
    report.shows.push({ showId, name: info.name, missing: missing.length, found: toInsert.length, cached: cachedN });
    if (!DRY && toInsert.length) {
      for (let i = 0; i < toInsert.length; i += 100) {
        const { error } = await sb.from("media_sources").upsert(toInsert.slice(i, i + 100), { onConflict: "media_id,quality,language" });
        if (error) console.error("  upsert failed:", error.message);
      }
    }
    report.inserted += toInsert.length;
    report.uncachedInserted += toInsert.length - cachedN;
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  }

  console.log(`\nDone. inserted=${report.inserted} (uncached ${report.uncachedInserted}), not found=${report.notFound.length}${DRY ? " [dry run]" : ""}`);
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
