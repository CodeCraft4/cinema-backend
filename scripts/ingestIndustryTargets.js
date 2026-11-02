/**
 * scripts/ingestIndustryTargets.js
 *
 * Tops every industry up to a target of playable titles (default 100 movies, 50 series):
 *   movies  : TMDB discover (popular, by original language) -> Torrentio -> TorBox-cached
 *             releases -> up to three phone-friendly tiers (480p / 720p / 1080p), Hindi / Dual
 *             first, original audio next. Rows go to media_sources, titles to media_content.
 *   series  : candidate shows are chosen here; episodes are ingested by fillSeriesGaps.js
 *             (--new-shows), so a show always gets every aired episode.
 *
 *   node scripts/ingestIndustryTargets.js --dry-run
 *   node scripts/ingestIndustryTargets.js --industry ko --movies 100 --series 50
 *   node scripts/ingestIndustryTargets.js --industry all --skip-series
 *
 * Industries: hi (Bollywood) en (Hollywood) te ta ml kn ko zh ja tr es fr
 */

"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const { getSupabaseClient } = require("../server/services/supabaseClient");
const env = require("../server/config/env");
const { fetchTorrentio } = require("../server/services/torrentioClient");
const { hindiAudioKind, audioLabel, detectQuality, deviceCompatPenalty } = require("../server/services/releaseAudio");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DRY = flag("--dry-run");
const SKIP_SERIES = flag("--skip-series");
const SKIP_MOVIES = flag("--skip-movies");
const MOVIE_TARGET = Number(opt("--movies", 100));
const SERIES_TARGET = Number(opt("--series", 50));
const MAX_NEW_PER_RUN = Number(opt("--max-new", 60)); // per industry, keeps one run bounded
const ONLY = opt("--industry", "all");
const TMDB_KEY = process.env.TMDB_API_KEY || env.tmdbApiKey;
const STREAM_BASE = (process.env.SERVER_BASE_URL || process.env.PUBLIC_BACKEND_URL || "http://168.144.249.68:4555").replace(/\/$/, "");

const INDUSTRIES = ["hi", "en", "te", "ta", "ml", "kn", "ko", "zh", "ja", "tr", "es", "fr"];
// Tier caps keep every tier phone-friendly and quick to start.
const TIERS = [
  { quality: "480p", maxBytes: 0.9e9 },
  { quality: "720p", maxBytes: 1.8e9 },
  { quality: "1080p", maxBytes: 3.6e9 },
];
const CAM_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|predvd|dvdscr|screener|hqcam)\b/i;
const AAC_RE = /\baac\b|\bhe-aac\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

async function tmdb(p) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.themoviedb.org/3${p}${p.includes("?") ? "&" : "?"}api_key=${TMDB_KEY}`);
      if (res.ok) return res.json();
      if (res.status === 404) return null;
    } catch {
      // retry
    }
    await sleep(600);
  }
  return null;
}

async function checkCached(hashes) {
  const cached = new Set();
  for (let i = 0; i < hashes.length; i += 50) {
    const part = hashes.slice(i, i + 50);
    for (let a = 0; a < 4; a++) {
      try {
        const res = await fetch("https://api.torbox.app/v1/api/torrents/checkcached?format=object", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.torboxApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ hashes: part }),
        });
        const json = JSON.parse(await res.text());
        for (const h of part) if (json.data && json.data[h]) cached.add(h);
        break;
      } catch {
        await sleep(2500 * (a + 1));
      }
    }
  }
  return cached;
}

function parseMovieStream(stream) {
  const lines = String(stream.title || "").split("\n");
  const releaseName = (lines[0] || "").trim();
  const text = `${releaseName} ${stream.behaviorHints?.filename || ""}`;
  const hash = String(stream.infoHash || "").toLowerCase();
  if (!hash || hash.length < 32 || CAM_RE.test(text)) return null;
  return {
    hash,
    releaseName,
    filename: stream.behaviorHints?.filename || null,
    seeders: Number((stream.title || "").match(/👤\s*(\d+)/)?.[1] || 0),
    sizeBytes: Number(stream.behaviorHints?.videoSize) || 0,
    quality: detectQuality(text, ""),
    kind: hindiAudioKind(text, null),
    text,
  };
}

/** Best cached release for one quality tier: Hindi/Dual, then phone-friendly, AAC, smaller. */
function bestForTier(cands, cachedSet, tier, requireHindi) {
  const pool = cands.filter(
    (c) => c.quality === tier.quality && cachedSet.has(c.hash) && (!c.sizeBytes || c.sizeBytes <= tier.maxBytes) && (!requireHindi || c.kind)
  );
  const kindRank = (c) => (c.kind === "dual" ? 0 : c.kind === "hindi" ? 1 : 2);
  return pool.sort(
    (a, b) =>
      kindRank(a) - kindRank(b) ||
      deviceCompatPenalty(a.text) - deviceCompatPenalty(b.text) ||
      (AAC_RE.test(a.text) ? 0 : 1) - (AAC_RE.test(b.text) ? 0 : 1) ||
      (a.sizeBytes || 9e9) - (b.sizeBytes || 9e9)
  )[0];
}

function movieRow(movie, year, cand, tier, posterUrl, backdropUrl) {
  const label = audioLabel(cand.kind);
  const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const sizeHuman = cand.sizeBytes ? `${(cand.sizeBytes / 1e9).toFixed(2)} GB` : null;
  const bridge = `${STREAM_BASE}/api/media/stream/torrent/${cand.hash}/video.mp4`;
  return {
    cache_key: `${movie.id}::${slug(movie.title)}::${year}::${slug(label)}::${tier.quality}`,
    media_id: String(movie.id),
    media_title: movie.title,
    year: String(year),
    language: label,
    quality: tier.quality,
    source_type: "ddl",
    download_url: `${bridge}?download=1`,
    stream_url: bridge,
    magnet_link: `magnet:?xt=urn:btih:${cand.hash}&dn=${encodeURIComponent(cand.releaseName || movie.title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce`,
    seeders: cand.seeders,
    is_fallback: false,
    status: "ready",
    size_human: sizeHuman,
    size_bytes: cand.sizeBytes || null,
    payload: {
      title: movie.title,
      rating: Math.round((movie.vote_average || 0) * 10),
      tmdb_id: String(movie.id),
      provider: "Torrentio",
      poster_url: posterUrl,
      backdrop_url: backdropUrl,
      series_poster_url: posterUrl,
      language_label: label,
      original_language: movie.original_language,
      size_human: sizeHuman,
      file_name: cand.filename || null,
      torbox_cached: true,
      filled_by: "ingestIndustryTargets",
    },
  };
}

async function playableIds(sb) {
  const movieIds = new Set();
  const showIds = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("media_sources").select("media_id").eq("status", "ready").range(from, from + 999).order("id");
    if (error) throw error;
    for (const r of data) {
      const m = /^(\d+)-s\d+e\d+$/i.exec(r.media_id);
      if (m) showIds.add(m[1]);
      else movieIds.add(String(r.media_id));
    }
    if (data.length < 1000) break;
  }
  return { movieIds, showIds };
}

async function currentCountFor(sb, lang, type, ids) {
  // How many playable titles already belong to this original_language.
  let n = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("media_content").select("external_id,details").eq("media_type", type).range(from, from + 999).order("id");
    if (error) throw error;
    for (const r of data) if (r.details?.original_language === lang && ids.has(String(r.external_id))) n++;
    if (data.length < 1000) break;
  }
  return n;
}

// Big industries have plenty of well-voted titles; smaller ones need a lower vote floor on TMDB.
const BIG = new Set(["hi", "en"]);
const MID = new Set(["ko", "ja", "zh", "tr", "te", "ta", "es", "fr"]);
const minVotes = (lang, type) => (BIG.has(lang) ? (type === "movie" ? 200 : 150) : MID.has(lang) ? (type === "movie" ? 40 : 30) : 8);

async function discover(type, lang, page) {
  const votes = minVotes(lang, type);
  const base = type === "movie"
    ? `/discover/movie?with_original_language=${lang}&without_genres=16&sort_by=popularity.desc&vote_count.gte=${votes}&primary_release_date.lte=${today()}&include_adult=false&page=${page}`
    : `/discover/tv?with_original_language=${lang}&without_genres=16&sort_by=popularity.desc&vote_count.gte=${votes}&first_air_date.lte=${today()}&page=${page}`;
  return (await tmdb(base))?.results || [];
}

async function ingestMovies(sb, lang, need, known) {
  const hindiOriginal = lang === "hi" || lang === "ur"; // a Hindi film's own audio is Hindi
  let added = 0;
  const report = { checked: 0, added: 0, rows: 0, skipped: 0 };
  for (let page = 1; page <= 25 && added < Math.min(need, MAX_NEW_PER_RUN); page++) {
    const results = await discover("movie", lang, page);
    if (!results.length) break;
    for (const m of results) {
      if (added >= Math.min(need, MAX_NEW_PER_RUN)) break;
      if (known.has(String(m.id))) continue;
      report.checked++;
      try {
        const ext = await tmdb(`/movie/${m.id}/external_ids`);
        if (!ext?.imdb_id) {
          report.skipped++;
          continue;
        }
        const streams = (await fetchTorrentio(`movie/${ext.imdb_id}`)).streams || [];
        const cands = streams.map(parseMovieStream).filter(Boolean).map((c) => (hindiOriginal && !c.kind ? { ...c, kind: "hindi" } : c));
        const cachedSet = cands.length ? await checkCached([...new Set(cands.map((c) => c.hash))]) : new Set();
        // Hindi / Dual only.
        const rows = [];
        const year = String(m.release_date || "").slice(0, 4);
        const poster = m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null;
        const backdrop = m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null;
        const usedHashes = new Set();
        for (const tier of TIERS) {
          // Only Hindi / Dual (Hindi + English or Original + Hindi) releases are stored.
          const pick = bestForTier(cands.filter((c) => !usedHashes.has(`${c.hash}`)), cachedSet, tier, !hindiOriginal);
          if (pick) {
            usedHashes.add(pick.hash);
            rows.push(movieRow({ id: m.id, title: m.title, vote_average: m.vote_average, original_language: m.original_language }, year, pick, tier, poster, backdrop));
          }
        }
        if (!rows.length) {
          report.skipped++;
          continue;
        }
        if (!DRY) {
          await sb.from("media_content").upsert(
            [{
              external_id: m.id, source: "tmdb", media_type: "movie", title: m.title,
              details: {
                id: m.id, title: m.title, year, overview: m.overview || "", genre_ids: m.genre_ids || [],
                poster_url: poster, poster_path: m.poster_path, backdrop_url: backdrop, backdrop_path: m.backdrop_path,
                release_date: m.release_date, vote_average: m.vote_average, original_language: m.original_language, imdb_id: ext.imdb_id,
              },
            }],
            { onConflict: "source,media_type,external_id" }
          );
          const { error } = await sb.from("media_sources").upsert(rows, { onConflict: "media_id,quality,language" });
          if (error) throw error;
        }
        added++;
        report.added++;
        report.rows += rows.length;
        known.add(String(m.id));
        console.log(`  + ${m.title} (${year}) tiers: ${rows.map((r) => `${r.quality}/${r.language}`).join(", ")}`);
      } catch (err) {
        console.warn(`  ! ${m.title}: ${err.message}`);
      }
    }
  }
  return report;
}

async function pickSeries(lang, need, known) {
  const ids = [];
  for (let page = 1; page <= 12 && ids.length < Math.min(need, MAX_NEW_PER_RUN); page++) {
    const results = await discover("tv", lang, page);
    if (!results.length) break;
    for (const s of results) {
      if (ids.length >= Math.min(need, MAX_NEW_PER_RUN)) break;
      if (!known.has(String(s.id))) ids.push(String(s.id));
    }
  }
  return ids;
}

async function main() {
  const sb = getSupabaseClient();
  const industries = ONLY === "all" ? INDUSTRIES : ONLY.split(",");
  const { movieIds, showIds } = await playableIds(sb);
  console.log(`Playable now: ${movieIds.size} movies, ${showIds.size} series. Targets: ${MOVIE_TARGET} movies / ${SERIES_TARGET} series per industry${DRY ? " [dry run]" : ""}`);

  for (const lang of industries) {
    console.log(`\n=== ${lang} ===`);
    if (!SKIP_MOVIES) {
      const have = await currentCountFor(sb, lang, "movie", movieIds);
      const need = Math.max(0, MOVIE_TARGET - have);
      console.log(`movies: have ${have}, need ${need}`);
      if (need > 0) console.log("  result:", await ingestMovies(sb, lang, need, movieIds));
    }
    if (!SKIP_SERIES) {
      const have = await currentCountFor(sb, lang, "tv", showIds);
      const need = Math.max(0, SERIES_TARGET - have);
      console.log(`series: have ${have}, need ${need}`);
      if (need > 0) {
        const ids = await pickSeries(lang, need, showIds);
        console.log(`  candidate shows: ${ids.length}`);
        if (ids.length) {
          const r = spawnSync("node", [path.join(__dirname, "fillSeriesGaps.js"), "--new-shows", ids.join(","), ...(DRY ? ["--dry-run"] : [])], { stdio: "inherit" });
          if (r.status === 0) ids.forEach((id) => showIds.add(id));
        }
      }
    }
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
