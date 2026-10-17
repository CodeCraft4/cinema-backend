const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, net } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "../.env"),
  override: true,
});
const WebTorrent = require("webtorrent");
const TorrentSearchApi = require("torrent-search-api");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { QueryClient } = require("@tanstack/query-core");

const SEARCH_CACHE_TTL = 60 * 60 * 1000; // 1 hour
// TanStack Query staleTime: serve from memory for 1 hour, refetch after that.
// Freshly fetched pages are still persisted to Supabase + disk (see callers).
const REACT_QUERY_STALE_TIME = 60 * 60 * 1000;
// Torrent search core (title aliases, provider set incl. B7 extended list,
// scoring, fetchTorrentSearch) lives in src/torrentSearch.js so the terminal
// test scripts (npm run test:torrent-search) exercise the exact same code.
const { initTorrentProviders, fetchTorrentSearch, buildBackfillQueries, mergeBackfillResults } = require("./torrentSearch");
const POSTER_CACHE_TTL = 60 * 60 * 1000;
const WATCHMODE_API_KEY = process.env.WATCHMODE_API_KEY?.trim() || null;
const TMDB_API_KEY = process.env.TMDB_API_KEY?.trim() || null;
const STREAMING_API_KEY = process.env.STREAMING_API_KEY?.trim() || null;
const OMDB_API_KEY = process.env.OMDB_API_KEY?.trim() || null;
const RAILWAY_API_URL = String(process.env.RAILWAY_API_URL || "https://cinebroadcast-production.up.railway.app").replace(/\/+$/, "");

async function fetchRailwayTvDiscover(params = {}) {
  const url = new URL(`${RAILWAY_API_URL}/api/tv-shows/discover`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error?.message || `Railway TV API failed: HTTP ${response.status}`);
  }
  return payload;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: SEARCH_CACHE_TTL,
      gcTime: SEARCH_CACHE_TTL,
      retry: 1,
    },
  },
});

const posterCache = new Map();
const posterInflight = new Map();
const { createPosterResolver } = require("./posters");
let resolvePoster = async () => null;

// --- CONFIGURATION ---
// B7 — enable the extended provider set (1337x, YTS, EZTV, LimeTorrents,
// TorrentProject, Torrentz2, ThePirateBay, KickassTorrents, RARBG…).
initTorrentProviders();

// Created only after we own the single-instance lock (avoids native crash on second launch).
let client = null;

function createTorrentClient() {
  if (client) return client;
  client = new WebTorrent({
    maxConns: 350,
    utp: true,
    tracker: true,
    dht: true,
    lsd: true,
    webSeeds: true,
  });
  return client;
}

const EXTRA_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.moeking.me:6969/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
];

const previewServers = new Map();

function withExtraTrackers(magnet) {
  if (!magnet || typeof magnet !== "string") return magnet;
  let next = magnet;
  for (const tracker of EXTRA_TRACKERS) {
    const token = `tr=${encodeURIComponent(tracker)}`;
    if (!next.includes(encodeURIComponent(tracker)) && !next.includes(tracker)) {
      next += (next.includes("?") ? "&" : "?") + token;
    }
  }
  return next;
}
let mainWindow;
let splash;
let tray;
let isQuitting = false;

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const DOWNLOADS_DB = path.join(
  app.getPath("userData"),
  "active_downloads.json"
);
const HIDDEN_DOWNLOADS_DB = path.join(
  app.getPath("userData"),
  "hidden_downloads.json"
);
const SEARCH_CACHE_DB = path.join(
  app.getPath("userData"),
  "search_query_cache.json"
);
const POSTER_CACHE_DB = path.join(
  app.getPath("userData"),
  "poster_query_cache.json"
);
const MOVIES_YEAR_DB = path.join(
  app.getPath("userData"),
  "movies_year_catalog.json"
);
const TMDB_SEARCH_DB = path.join(app.getPath("userData"), "tmdb_search_cache.json");
const TMDB_COUNTRIES_DB = path.join(app.getPath("userData"), "tmdb_countries_cache.json");
const TMDB_TV_DB = path.join(app.getPath("userData"), "tmdb_tv_cache.json");
const MOVIES_YEAR_TTL = 12 * 60 * 60 * 1000; // 12 hours
const TMDB_SEARCH_TTL = 7 * 24 * 60 * 60 * 1000;

// ── Supabase DB cache layer ──────────────────────────────────────────────
// Mirrors the existing disk cache, but also writes/reads from Supabase so
// the data survives a fresh install / multiple devices and can be shared.
// Falls back to disk-only (with a console warning below) when Supabase is unavailable.
const SUPABASE_CACHE_TTL = TMDB_SEARCH_TTL; // 7 days, same as TMDB_SEARCH_TTL
let supabaseClient = null;
let supabaseReady = false;
try {
  const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
  // Resolve credentials through the same central config the Express service
  // uses (server/config/env.js). This repo's .env does NOT define the plain
  // `SUPABASE_URL` name — the URL lives in `SUPABASE_URL_KEY` (or is derived
  // from the service-role JWT's "ref" claim). Reading only process.env.SUPABASE_URL
  // used to leave supabaseReady=false here, which silently skipped EVERY
  // media_content / media_page_cache write while the app kept working
  // disk-only. Fallback to the plain names below if server/ is unavailable.
  let resolvedUrl = "";
  let resolvedKey = "";
  let resolveSource = "";
  try {
    const centralEnv = require("../server/config/env");
    resolvedUrl = centralEnv.supabaseUrl || "";
    resolvedKey = centralEnv.supabaseKey || "";
    resolveSource = [centralEnv.supabaseUrlSource, centralEnv.supabaseKeySource]
      .filter(Boolean)
      .join(" + ");
  } catch {
    // Packaged layout without server/ → plain env names below.
  }
  const supabaseUrl = resolvedUrl || process.env.SUPABASE_URL?.trim() || "";
  const supabaseKey = resolvedKey
    || process.env.SUPABASE_SERVICE_ROLE_SECRET_KEY?.trim()
    || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
    || process.env.SUPABASE_SECRET_KEY?.trim()
    || "";
  if (supabaseUrl && supabaseKey && supabaseUrl.startsWith("http")) {
    supabaseClient = createSupabaseClient(supabaseUrl, supabaseKey);
    supabaseReady = true;
  }
  console.log(
    supabaseReady
      ? `✓ Supabase connected (${resolveSource || "env"}) — fetched items and page payloads will be stored in the DB.`
      : "! Supabase NOT configured — running disk-only; nothing will be written to the DB. Set SUPABASE_URL (or SUPABASE_URL_KEY) + the service-role key in .env."
  );
} catch {
  // @supabase/supabase-js not installed or misconfigured — continue disk-only.
  console.warn("! Supabase client unavailable — running disk-only; nothing will be written to the DB.");
}

/**
 * Read a JSON payload from the Supabase `media_page_cache` table.
 * Implementation lives in src/supabasePageCache.js (schema created by migration
 * 20260923120001): one row per `cache_key` (UNIQUE) → a page payload is never
 * stored twice and a cached page is served straight from the DB.
 */
const { createPageCache } = require("./supabasePageCache");

const pageCache = createPageCache({
  getClient: () => (supabaseReady && supabaseClient ? supabaseClient : null),
  ttlMs: SUPABASE_CACHE_TTL,
});

async function readSupabaseCache(cacheKey) {
  return pageCache.read(cacheKey);
}

/**
 * Write a JSON payload into the Supabase `media_page_cache` table (upsert).
 */
async function writeSupabaseCache(cacheKey, value) {
  return pageCache.write(cacheKey, value);
}
// ── Supabase ITEM store (media_content) ──────────────────────────────────
// Every fetched movie/series is saved as ONE row per
// (source, media_type, external_id). Existing rows are never re-written: the
// shared store reads which ids already exist and inserts only the strictly
// new ones, with `ignoreDuplicates` so even a race can never create a
// duplicate. Implementation lives in src/mediaItemStore.js so it can be
// exercised directly by scripts/test-item-store.js.
const { createMediaItemStore } = require("./mediaItemStore");

const mediaItemStore = createMediaItemStore({
  getClient: () => (supabaseReady && supabaseClient ? supabaseClient : null),
});

// ── torrent + episode library (LIST B: B1/B2/B4/B5/B6) ──────────────────────
// media_torrents: every searched release persisted (magnet/link/seeds/…);
// media_episodes: structured episode rows; details markers: language
// availability (B3) + parts (B5). All functions degrade gracefully when
// Supabase or the migration is missing (never throws).
const { createTorrentLibrary } = require("./torrentLibrary");

const torrentLibrary = createTorrentLibrary({
  getClient: () => (supabaseReady && supabaseClient ? supabaseClient : null),
});

/** Map search-movies meta {tmdbId|tvShowId, season, episode} → library scope. */
function scopeFromMeta(meta = {}) {
  const externalId = Number(meta.tmdbId || meta.tvShowId);
  const mediaType =
    meta.mediaType === "tv" || meta.tvShowId ? "tv" : meta.tmdbId ? "movie" : null;
  return {
    mediaType,
    externalId: Number.isInteger(externalId) && externalId > 0 ? externalId : null,
    season: meta.season != null && meta.season !== "" ? Number(meta.season) : null,
    episode: meta.episode != null && meta.episode !== "" ? Number(meta.episode) : null,
  };
}

/** B1 — persist click-time search results (fire-and-forget, never blocks). */
function persistTorrentSearchLater(query, results, meta = {}) {
  if (!supabaseReady || !Array.isArray(results) || !results.length) return;
  const scope = scopeFromMeta(meta);
  if (!scope.externalId) return; // unattributed → the background job covers it
  Promise.resolve()
    .then(() => torrentLibrary.saveSearchResults(results, { ...scope, queryKey: String(query || "") }))
    .catch(() => {});
}

/** B1 — remember a resolved magnet so the next download starts instantly. */
function persistMagnetForTitle(torrentData, magnet) {
  if (!supabaseReady || !torrentData?.title || !magnet) return;
  const scope = scopeFromMeta(torrentData);
  if (!scope.externalId) return;
  Promise.resolve()
    .then(() =>
      torrentLibrary.saveMagnetFor({
        title: torrentData.title,
        magnet,
        link: torrentData.link,
        desc: torrentData.desc,
        provider: torrentData.provider,
        seeds: torrentData.seeds,
        size: torrentData.size,
        mediaType: scope.mediaType,
        externalId: scope.externalId,
        season: scope.season,
        episode: scope.episode,
      })
    )
    .catch(() => {});
}

/** B4 — persist season payloads (API fetch OR cache hit) as episode rows. */
function persistEpisodesFromPayload(showId, season, payload) {
  if (!supabaseReady || season == null || season === "" || !payload) return;
  const episodes = Array.isArray(payload.episodes) ? payload.episodes : [];
  if (!episodes.length) return;
  Promise.resolve()
    .then(() => torrentLibrary.saveEpisodes({ showId: Number(showId), season: Number(season), episodes }))
    .catch(() => {});
}

/** Best-effort magnet from a provider result (used by the backfill job). */
async function quickResolveMagnet(data, timeoutMs = 12000) {
  if (!data) return null;
  if (String(data.magnet || "").startsWith("magnet:")) return data.magnet;
  if (!data?.desc && !data?.link && !data?.provider) return null;
  try {
    const magnet = await Promise.race([
      TorrentSearchApi.getMagnet(data),
      new Promise((_, reject) => setTimeout(() => reject(new Error("magnet timeout")), timeoutMs)),
    ]);
    return magnet && String(magnet).startsWith("magnet:") ? magnet : null;
  } catch {
    return null;
  }
}

/** Store the items of a fetched page in Supabase — never creates duplicates. */
async function storeItemsToSupabase(items, options = {}) {
  return mediaItemStore.storeItems(items, options);
}

/** DB-first search: previously stored movies/series straight from Supabase. */
async function searchItemsFromSupabase(query, limit = 20, options = {}) {
  return mediaItemStore.searchItems(query, { limit, ...options });
}

/** DB fallback: stored items when a page payload is missing AND the APIs fail. */
async function listItemsFromSupabase(options = {}) {
  return mediaItemStore.listItems(options);
}

/**
 * Fire-and-forget store: every fetched item is still saved exactly once
 * (3-layer de-dupe), but the IPC response is never blocked by the write
 * round-trip — cache hits serve Supabase-fast (<2s). Safe because storeItems
 * never throws and any missed write is recovered on the next cache hit.
 * Newly stored rows are queued for the B2 background torrent finder.
 */
function ensureStoredLater(items, options = {}) {
  Promise.resolve()
    .then(async () => {
      const stored = await storeItemsToSupabase(items, options);
      for (const row of stored?.storedRows || []) {
        enqueueTorrentJob({
          externalId: row.externalId,
          mediaType: row.mediaType,
          title: row.title,
          year: row.year,
          originalLanguage: row.originalLanguage || row.original_language || "",
        });
      }
      return stored;
    })
    .catch(() => {});
}

// ── B2: background torrent finder (auto search + backfill + B6 refresh) ─────
const TORRENT_JOB_DELAY_MS = 3000; // gap between provider searches
const TORRENT_BACKFILL_BATCH = 25; // items queued per backfill cycle
const TORRENT_BACKFILL_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const TORRENT_CHECK_STALE_HOURS = 24; // re-check / seeds-refresh window (B6)
const torrentJobQueue = [];
const torrentJobKeys = new Set();
let torrentWorkerActive = false;

const torrentJobDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queue one title for background torrent search (deduped by scope key). */
function enqueueTorrentJob(job) {
  const externalId = Number(job?.externalId);
  if (!externalId || !job?.title) return;
  const mediaType = job.mediaType === "tv" ? "tv" : "movie";
  const key = `${mediaType}:${externalId}`;
  if (torrentJobKeys.has(key)) return;
  torrentJobKeys.add(key);
  torrentJobQueue.push({
    externalId,
    mediaType,
    title: String(job.title),
    year: String(job.year || ""),
    originalLanguage: String(job.originalLanguage || job.original_language || ""),
  });
  void runTorrentJobWorker();
}

/** Serial worker: one job at a time, polite delay, online-only. */
async function runTorrentJobWorker() {
  if (torrentWorkerActive) return;
  torrentWorkerActive = true;
  try {
    while (torrentJobQueue.length && isNetworkOnline()) {
      const job = torrentJobQueue.shift();
      torrentJobKeys.delete(`${job.mediaType}:${job.externalId}`);
      try {
        await runTorrentBackfillJob(job);
      } catch (error) {
        console.warn("[torrent backfill] job failed:", error?.message || error);
      }
      await torrentJobDelay(TORRENT_JOB_DELAY_MS);
    }
  } finally {
    torrentWorkerActive = false;
    if (!torrentJobQueue.length) torrentJobKeys.clear();
  }
}

/** One title → provider search → media_torrents rows + availability markers. */
async function runTorrentBackfillJob(job) {
  const { externalId, mediaType, title, year, originalLanguage } = job;
  const queries = buildBackfillQueries(title, year, originalLanguage);
  const rounds = [];
  for (const query of queries) {
    const found = await fetchTorrentSearch(query, { maxTitles: 4 }).catch(() => []);
    rounds.push(found);
  }
  const merged = mergeBackfillResults(rounds, { limitPerLanguage: 2, originalLanguage }).map((item) => ({
    ...item,
    // Keep the catalog's audio identity when a provider leaves the release untagged.
    originalLanguage: item.originalLanguage || item.original_language || originalLanguage || "",
  }));
  const results = merged;
  const query = queries[0] || String(title || "");
  const { rows = [] } = await torrentLibrary.saveSearchResults(results, {
    mediaType,
    externalId,
    queryKey: query,
  });

  const tags = new Set();
  let partsCount = 0;
  for (const row of rows) {
    for (const tag of row.language_tags || []) tags.add(String(tag));
    if (Number(row.part) > 0) partsCount = Math.max(partsCount, Number(row.part));
  }
  await torrentLibrary.markChecked({
    mediaType,
    externalId,
    found: rows.length,
    languageTags: [...tags],
    partsCount,
    complete: rows.length > 0,
  });

  // B1 — best-effort magnet for the best release (next download starts fast).
  if (results[0]) {
    const magnet = await quickResolveMagnet(results[0]);
    if (magnet) {
      await torrentLibrary.saveMagnetFor({
        title: results[0].title,
        magnet,
        link: results[0].link,
        desc: results[0].desc,
        provider: results[0].provider,
        mediaType,
        externalId,
        queryKey: query,
      });
    }
  }
  console.log(
    `[torrent backfill] ${mediaType}:${externalId} "${title}" → ${rows.length} torrent(s)` +
      (rows.length ? " saved" : " (none found; will retry)")
  );
}

/** Queue the next backfill batch (never-checked first, then stale re-checks). */
async function kickTorrentBackfill() {
  if (!supabaseReady || !isNetworkOnline()) return;
  const items = await torrentLibrary.listItemsMissingTorrents({
    limit: TORRENT_BACKFILL_BATCH,
    staleHours: TORRENT_CHECK_STALE_HOURS,
  });
  if (items.length) {
    console.log(`[torrent backfill] queueing ${items.length} item(s)`);
    items.forEach(enqueueTorrentJob);
  } else {
    void runTorrentJobWorker(); // resume any jobs left over while offline
  }
}

// Row mapping + duplicate-safe writes now live in src/mediaItemStore.js.



// storeItemsToSupabase() + searchItemsFromSupabase() are thin wrappers over
// src/mediaItemStore.js (defined above) — no duplicate logic lives here.

// ── TV category shelves ───────────────────────────────────────────────────
const TV_CATEGORIES = [
  { key: "trending", label: "Trending TV Shows", genreId: null },
  { key: "action-adventure", label: "Action & Adventure", genreId: 10759 },
  { key: "drama", label: "Drama", genreId: 18 },
  { key: "comedy", label: "Comedy", genreId: 35 },
  { key: "crime", label: "Crime", genreId: 80 },
  { key: "mystery", label: "Mystery", genreId: 9648 },
  { key: "sci-fi-fantasy", label: "Sci-Fi & Fantasy", genreId: 10765 },
  { key: "animation", label: "Animation", genreId: 16 },
  { key: "family", label: "Family", genreId: 10751 },
  { key: "reality", label: "Reality", genreId: 10764 },
  { key: "documentary", label: "Documentary", genreId: 99 },
  { key: "kids", label: "Kids", genreId: 10762 },
  { key: "war-politics", label: "War & Politics", genreId: 10768 },
  { key: "western", label: "Western", genreId: 37 },
  { key: "soap", label: "Soap", genreId: 10766 },
  { key: "talk", label: "Talk Show", genreId: 10767 },
  { key: "news", label: "News", genreId: 10763 },
];

let hiddenDownloadIds = new Set();

function isNetworkOnline() {
  return net.isOnline();
}

function loadHiddenDownloads() {
  try {
    if (fs.existsSync(HIDDEN_DOWNLOADS_DB)) {
      hiddenDownloadIds = new Set(JSON.parse(fs.readFileSync(HIDDEN_DOWNLOADS_DB)));
    }
  } catch (error) {
    console.warn("Hidden download state could not be loaded:", error.message);
  }
}

function saveHiddenDownloads() {
  try {
    fs.writeFileSync(HIDDEN_DOWNLOADS_DB, JSON.stringify([...hiddenDownloadIds]));
  } catch (error) {
    console.error("Hidden download state could not be saved:", error.message);
  }
}

function loadJsonCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveJsonCache(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch (error) {
    console.warn("Cache save failed:", error.message);
  }
}

function readDiskCacheEntry(filePath, key, ttl) {
  const db = loadJsonCache(filePath);
  const entry = db[key];
  if (!entry || !entry.timestamp) return null;
  if (Date.now() - entry.timestamp > ttl) return null;
  return entry.value;
}

function readAnyDiskCacheEntry(filePath, key) {
  const db = loadJsonCache(filePath);
  return db[key]?.value ?? null;
}

function writeDiskCacheEntry(filePath, key, value, ttl) {
  const db = loadJsonCache(filePath);
  const now = Date.now();
  for (const [cacheKey, entry] of Object.entries(db)) {
    if (!entry?.timestamp || now - entry.timestamp > ttl) delete db[cacheKey];
  }
  db[key] = { timestamp: now, value };
  saveJsonCache(filePath, db);
}

function initPosterResolver() {
  const created = createPosterResolver({
    TMDB_API_KEY,
    WATCHMODE_API_KEY,
    STREAMING_API_KEY,
    OMDB_API_KEY,
    posterCache,
    posterInflight,
    readDiskCacheEntry,
    readAnyDiskCacheEntry,
    isOnline: isNetworkOnline,
    writeDiskCacheEntry,
    POSTER_CACHE_DB,
    POSTER_CACHE_TTL,
  });
  resolvePoster = created.resolvePoster;
}

// Torrent-search helpers (editDistance / TITLE_ALIASES / aliasCorrectedTitle /
// resolveSearchTitles) moved to src/torrentSearch.js — shared with the
// terminal test scripts (npm run test:torrent-search).

// scoreTorrentMatch / isVideoTorrent / searchProviderWithTimeout /
// fetchTorrentSearch moved to src/torrentSearch.js (B7 provider set lives
// there too) — the terminal test scripts import the exact same functions.

async function getCachedSearchResults(query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return { results: [], fromCache: false };

  if (!isNetworkOnline()) {
    const cached = readAnyDiskCacheEntry(SEARCH_CACHE_DB, normalizedQuery);
    return { results: Array.isArray(cached) ? cached : [], fromCache: Boolean(cached), offline: true };
  }

  const diskHit = readDiskCacheEntry(SEARCH_CACHE_DB, normalizedQuery, SEARCH_CACHE_TTL);
  // Never trust empty cache entries — previous timeouts used to poison search for 1 hour.
  if (Array.isArray(diskHit) && diskHit.length > 0) {
    queryClient.setQueryData(["search", normalizedQuery], diskHit);
    return { results: diskHit, fromCache: true };
  }

  const memoryHit = queryClient.getQueryData(["search", normalizedQuery]);
  if (Array.isArray(memoryHit) && memoryHit.length > 0) {
    return { results: memoryHit, fromCache: true };
  }

  const results = await queryClient.fetchQuery({
    queryKey: ["search", normalizedQuery],
    staleTime: SEARCH_CACHE_TTL,
    gcTime: SEARCH_CACHE_TTL,
    queryFn: () => fetchTorrentSearch(query),
  });

  if (Array.isArray(results) && results.length > 0) {
    writeDiskCacheEntry(SEARCH_CACHE_DB, normalizedQuery, results, SEARCH_CACHE_TTL);
  }
  return { results: results || [], fromCache: false };
}

function mapTmdbMovie(item, year, page = 1) {
  return {
    id: `tmdb-movie-${item.id}-p${page}`,
    tmdbId: item.id,
    title: item.title || item.name,
    year: String(item.release_date || year).slice(0, 4) || String(year),
    typeLabel: "MOVIE",
    mediaType: "movie",
    originalLanguage: item.original_language || "",
    originCountry: Array.isArray(item.origin_country) ? item.origin_country : [],
    rating: (item.vote_average || 0) * 10,
    poster: item.poster_path
      ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
      : null,
    backdrop: item.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}`
      : null,
    overview: item.overview || item.description || "",
  };
}

async function fetchTmdbMoviesForYear(year, { limit = 8, sort = "vote_average.desc", page = 1 } = {}) {
  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY is missing from .env");

  const cacheKey = `movie-year-${year}-${sort}-${limit}-p${page}`;
  // Check Supabase first
  const supaHit = await readSupabaseCache(cacheKey);
  if (supaHit) {
    return { ...supaHit, fromCache: true, source: 'supabase' };
  }

  const voteFloor = sort.includes("vote_average") ? 40 : 1;
  const url =
    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}` +
    `&language=en-US&sort_by=${encodeURIComponent(sort)}` +
    `&primary_release_date.gte=${year}-01-01&primary_release_date.lte=${year}-12-31` +
    `&vote_count.gte=${voteFloor}&include_adult=false&page=${page}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDb year ${year} failed: ${response.status}`);
  const data = await response.json();
  const items = (data.results || [])
    .filter((item) => item.poster_path)
    .slice(0, limit)
    .map((item) => mapTmdbMovie(item, year, page));

  const payload = {
    items,
    page: data.page || page,
    totalPages: data.total_pages || 1,
  };
  // Write to both Supabase and disk
  await writeSupabaseCache(cacheKey, payload);
  writeDiskCacheEntry(MOVIES_YEAR_DB, cacheKey, payload, MOVIES_YEAR_TTL);
  return payload;
}

async function getMoviesByYearCached(year, options = {}) {
  const limit = options.limit || 8;
  const sort = options.sort || "vote_average.desc";
  const page = options.page || 1;
  const cacheKey = `movie-${year}-${sort}-${limit}-p${page}`;

  // Check Supabase first
  const supaHit = await readSupabaseCache(cacheKey);
  if (supaHit) {
    queryClient.setQueryData(["movies-year", cacheKey], supaHit);
    ensureStoredLater(supaHit.items, { mediaType: "movie" });
    return { year, ...supaHit, fromCache: true, source: 'supabase' };
  }

  const diskHit = readDiskCacheEntry(MOVIES_YEAR_DB, cacheKey, MOVIES_YEAR_TTL);
  if (diskHit) {
    queryClient.setQueryData(["movies-year", cacheKey], diskHit);
    ensureStoredLater(diskHit.items, { mediaType: "movie" });
    return { year, ...diskHit, fromCache: true };
  }

  // DB fallback (offline / API failure): this year's already-stored movies,
  // so the Movies page never renders empty while the DB has data.
  const dbYearFallback = async () => {
    const stored = await listItemsFromSupabase({ mediaType: "movie", limit: 200 });
    const items = stored.items.filter((item) => String(item.year || "") === String(year)).slice(0, limit);
    if (!items.length) return null;
    return { items, page, totalPages: 1, fromCache: true, source: "supabase", dbFallback: true };
  };

  if (!isNetworkOnline()) {
    const offlineHit = readAnyDiskCacheEntry(MOVIES_YEAR_DB, cacheKey);
    if (offlineHit) {
      ensureStoredLater(offlineHit.items, { mediaType: "movie" });
      return { year, ...offlineHit, fromCache: true, offline: true };
    }
    const offlineDb = await dbYearFallback();
    if (offlineDb) return { year, ...offlineDb, offline: true };
    throw new Error("You're offline. Only downloaded movies and previously cached content are available.");
  }

  let payload;
  try {
    payload = await queryClient.fetchQuery({
      queryKey: ["movies-year", cacheKey],
      staleTime: REACT_QUERY_STALE_TIME, // 1 hour
      gcTime: MOVIES_YEAR_TTL,
      queryFn: () => fetchTmdbMoviesForYear(year, { limit, sort, page }),
    });
  } catch (fetchError) {
    // TMDb unreachable / key missing → serve what is already stored in Supabase.
    const fallback = await dbYearFallback();
    if (!fallback) throw fetchError;
    console.warn(`movies-year ${year}: API failed, serving Supabase items —`, fetchError.message);
    ensureStoredLater(fallback.items, { mediaType: "movie" });
    return { year, ...fallback };
  }

  await writeSupabaseCache(cacheKey, payload);
  writeDiskCacheEntry(MOVIES_YEAR_DB, cacheKey, payload, MOVIES_YEAR_TTL);
  // New items → auto-store in Supabase (existing ids are skipped, never duplicated)
  ensureStoredLater(payload.items, { mediaType: "movie" });
  return { year, ...payload, fromCache: false };
}

async function fetchTmdbPopularCatalog(page = 1, limit = 40) {
  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY is missing from .env");

  const cacheKey = `popular-catalog-p${page}-l${limit}`;
  // Check Supabase first
  const supaHit = await readSupabaseCache(cacheKey);
  if (supaHit) {
    return { ...supaHit, fromCache: true, source: 'supabase' };
  }

  // Mix trending + popular + top_rated for a fuller Home / Trending feed.
  const [trendingRes, popularRes, topRes] = await Promise.all([
    fetch(
      `https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_API_KEY}&page=${page}`
    ),
    fetch(
      `https://api.themoviedb.org/3/movie/popular?api_key=${TMDB_API_KEY}&language=en-US&page=${page}`
    ),
    fetch(
      `https://api.themoviedb.org/3/movie/top_rated?api_key=${TMDB_API_KEY}&language=en-US&page=${page}`
    ),
  ]);

  if (!trendingRes.ok) throw new Error(`TMDb trending failed: ${trendingRes.status}`);
  if (!popularRes.ok) throw new Error(`TMDb popular failed: ${popularRes.status}`);
  if (!topRes.ok) throw new Error(`TMDb top_rated failed: ${topRes.status}`);

  const trendingData = await trendingRes.json();
  const popularData = await popularRes.json();
  const topData = await topRes.json();

  const seen = new Set();
  const merged = [];
  const trending = trendingData.results || [];
  const popular = popularData.results || [];
  const topRated = topData.results || [];
  const maxLen = Math.max(trending.length, popular.length, topRated.length);

  for (let i = 0; i < maxLen; i += 1) {
    for (const item of [trending[i], popular[i], topRated[i]]) {
      if (!item?.poster_path || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(mapTmdbMovie(item, String(item.release_date || "").slice(0, 4), page));
    }
  }

  const payload = {
    items: merged.slice(0, limit),
    page,
    totalPages: Math.min(
      Math.max(
        trendingData.total_pages || 1,
        popularData.total_pages || 1,
        topData.total_pages || 1,
        50
      ),
      500 // TMDb hard page cap
    ),
  };
  // Write to both Supabase and disk
  await writeSupabaseCache(cacheKey, payload);
  writeDiskCacheEntry(MOVIES_YEAR_DB, cacheKey, payload, MOVIES_YEAR_TTL);
  return payload;
}

async function searchTmdb(query, page = 1) {
  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY is missing from .env");
  const cacheKey = `search-multi-${String(query || "").trim().toLowerCase()}-p${page}`;
  // 1) Supabase page cache → serve directly from the DB, nothing new to store
  const supaHit = await readSupabaseCache(cacheKey);
  if (supaHit) {
    ensureStoredLater(supaHit.items);
    return { ...supaHit, fromCache: true, source: 'supabase' };
  }

  const cached = readDiskCacheEntry(TMDB_SEARCH_DB, cacheKey, TMDB_SEARCH_TTL);
  if (cached) {
    ensureStoredLater(cached.items);
    return { ...cached, fromCache: true };
  }
  if (!isNetworkOnline()) {
    const offlineCached = readAnyDiskCacheEntry(TMDB_SEARCH_DB, cacheKey);
    if (offlineCached) {
      ensureStoredLater(offlineCached.items);
      return { ...offlineCached, fromCache: true, offline: true };
    }
    // 2) No page cache & offline → serve matching items already stored in the DB
    const dbHit = await searchItemsFromSupabase(query, 20);
    if (dbHit.items.length) return { ...dbHit, offline: true };
    throw new Error("You're offline. Only downloaded movies and previously cached content are available.");
  }
  // Fast path: matching items are already in Supabase → serve directly
  // (no upstream call). Page 1 only — deeper pages still go to TMDb so
  // "load more" pagination keeps working.
  if ((Number(page) || 1) === 1) {
    const dbHit = await searchItemsFromSupabase(query, 24);
    if (dbHit.items.length) {
      return { items: dbHit.items, page: 1, totalPages: 1, fromCache: true, source: "supabase" };
    }
  }

  const url =
    `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}` +
    `&language=en-US&include_adult=false&page=${page}&query=${encodeURIComponent(query)}`;
  let data;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`TMDb search failed: ${response.status}`);
    data = await response.json();
  } catch (error) {
    // 3) Upstream search failed → fall back to items already in Supabase
    const dbHit = await searchItemsFromSupabase(query, 20);
    if (dbHit.items.length) return { ...dbHit, upstreamError: error.message };
    throw error;
  }
  const items = (data.results || [])
    .filter((item) => (item.media_type === "movie" || item.media_type === "tv") && item.poster_path)
    .map((item) => ({
      id: `tmdb-${item.media_type}-${item.id}`,
      tmdbId: item.id,
      title: item.title || item.name,
      year: String(item.release_date || item.first_air_date || "").slice(0, 4),
      typeLabel: item.media_type === "tv" ? "SERIES" : "MOVIE",
      mediaType: item.media_type,
      originalLanguage: item.original_language || "",
      originCountry: Array.isArray(item.origin_country) ? item.origin_country : [],
      rating: (item.vote_average || 0) * 10,
      poster: `https://image.tmdb.org/t/p/w500${item.poster_path}`,
      backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null,
      overview: item.overview || item.description || "",
    }));
  const payload = { items, page: data.page || page, totalPages: Math.min(data.total_pages || 1, 20) };
  // Write to both Supabase and disk
  await writeSupabaseCache(cacheKey, payload);
  writeDiskCacheEntry(TMDB_SEARCH_DB, cacheKey, payload, TMDB_SEARCH_TTL);
  // Newly fetched movies/series → auto-store in Supabase (no duplicates)
  ensureStoredLater(items);
  const top = items[0];
  if (top?.tmdbId && top?.title) {
    void require("../server/services/catalogSearchService")
      .ensureStoredTitle(top)
      .catch((error) => console.warn("[catalog search] source store skipped:", error?.message || error));
  }
  return payload;
}

async function getTmdbCountries() {
  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY is missing from .env");
  const cached = readAnyDiskCacheEntry(TMDB_COUNTRIES_DB, "countries");
  if (cached) return cached;
  if (!isNetworkOnline()) return [];
  const response = await fetch(
    `https://api.themoviedb.org/3/configuration/countries?api_key=${TMDB_API_KEY}&language=en-US`
  );
  if (!response.ok) throw new Error(`TMDb countries failed: ${response.status}`);
  const countries = await response.json();
  writeDiskCacheEntry(TMDB_COUNTRIES_DB, "countries", countries, TMDB_SEARCH_TTL);
  return countries;
}

async function discoverTmdbByCountry(country, page = 1, limit = 16) {
  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY is missing from .env");
  const cacheKey = `country-${country}-p${page}-l${limit}`;
  // Check Supabase first
  const supaHit = await readSupabaseCache(cacheKey);
  if (supaHit) {
    ensureStoredLater(supaHit.items, { mediaType: "movie" });
    return { ...supaHit, fromCache: true, source: 'supabase' };
  }

  const cached = readDiskCacheEntry(TMDB_SEARCH_DB, cacheKey, TMDB_SEARCH_TTL);
  if (cached) {
    ensureStoredLater(cached.items, { mediaType: "movie" });
    return { ...cached, fromCache: true };
  }
  if (!isNetworkOnline()) {
    const offlineCached = readAnyDiskCacheEntry(TMDB_SEARCH_DB, cacheKey);
    if (offlineCached) {
      ensureStoredLater(offlineCached.items, { mediaType: "movie" });
      return { ...offlineCached, fromCache: true, offline: true };
    }
    throw new Error("You're offline. Only downloaded movies and previously cached content are available.");
  }
  const url =
    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}` +
    `&language=en-US&sort_by=popularity.desc&include_adult=false` +
    `&with_origin_country=${encodeURIComponent(country)}&page=${page}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDb country search failed: ${response.status}`);
  const data = await response.json();
  const payload = {
    items: (data.results || [])
      .filter((item) => item.poster_path)
      .slice(0, limit)
      .map((item) => mapTmdbMovie(item, String(item.release_date || "").slice(0, 4), page)),
    page: data.page || page,
    totalPages: Math.min(data.total_pages || 1, 20),
  };
  // Write to both Supabase and disk
  await writeSupabaseCache(cacheKey, payload);
  writeDiskCacheEntry(TMDB_SEARCH_DB, cacheKey, payload, TMDB_SEARCH_TTL);
  // New items → auto-store (duplicates are skipped)
  ensureStoredLater(payload.items, { mediaType: "movie" });
  return payload;
}

function mapTmdbTv(item, page = 1) {
  return {
    id: `tmdb-tv-${item.id}`,
    tmdbId: item.id,
    title: item.name || item.title,
    year: String(item.first_air_date || "").slice(0, 4),
    typeLabel: "SERIES",
    mediaType: "tv",
    originalLanguage: item.original_language || "",
    originCountry: Array.isArray(item.origin_country) ? item.origin_country : [],
    rating: (item.vote_average || 0) * 10,
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null,
    overview: item.overview || "",
    page,
  };
}

async function getTvShowsCached(page = 1, limit = 16, query = "") {
  const term = String(query || "").trim();
  const isSearch = Boolean(term);
  const cacheKey = isSearch
    ? `search-${term.toLowerCase().replace(/\s+/g, " ")}-p${page}`
    : `discover-p${page}-l${limit}`;
  // Check Supabase first (DB-first: survives restarts / other devices)
  const supaHit = await readSupabaseCache(cacheKey);
  if (supaHit) {
    ensureStoredLater(supaHit.items, { mediaType: "tv" });
    return { ...supaHit, fromCache: true, source: 'supabase' };
  }

  const cached = readDiskCacheEntry(TMDB_TV_DB, cacheKey, TMDB_SEARCH_TTL);
  if (cached) {
    ensureStoredLater(cached.items, { mediaType: "tv" });
    return { ...cached, fromCache: true };
  }
  if (!isNetworkOnline()) {
    const offlineCached = readAnyDiskCacheEntry(TMDB_TV_DB, cacheKey);
    if (offlineCached) {
      ensureStoredLater(offlineCached.items, { mediaType: "tv" });
      return { ...offlineCached, fromCache: true, offline: true };
    }
    throw new Error("You're offline. Only downloaded and previously cached TV content is available.");
  }
  // Fast path: matching series already stored in Supabase → direct serve.
  if (isSearch && page === 1) {
    const dbHit = await searchItemsFromSupabase(term, 24, { mediaType: "tv" });
    if (dbHit.items.length) {
      // No totalPages here: it stays unknown until the first upstream fetch,
      // so the renderer keeps paginating instead of ending at page 1.
      return { items: dbHit.items, page: 1, query: term, fromCache: true, source: "supabase" };
    }
  }

  const url = isSearch
    ? `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}` +
      `&language=en-US&include_adult=false&page=${page}&query=${encodeURIComponent(term)}`
    : `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&language=en-US&sort_by=popularity.desc&include_adult=false&page=${page}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      isSearch ? `TMDb TV search failed: ${response.status}` : `TMDb TV discovery failed: ${response.status}`
    );
  }
  const data = await response.json();
  const payload = {
    items: (data.results || []).filter((item) => item.poster_path).slice(0, limit).map((item) => mapTmdbTv(item, page)),
    page: data.page || page,
    totalPages: Math.min(data.total_pages || 1, 500), // TMDb hard page cap
    query: term,
  };
  await writeSupabaseCache(cacheKey, payload);
  writeDiskCacheEntry(TMDB_TV_DB, cacheKey, payload, TMDB_SEARCH_TTL);
  // New series → auto-store (existing ids skipped, never duplicated)
  ensureStoredLater(payload.items, { mediaType: "tv" });
  return payload;
}

// 2-row shelf data for the TV Shows page: trending (popular) or one TMDb genre.
async function getTvShowsByGenreCached(genreId = null, page = 1, limit = 14, year = null, sort = null) {
  const slug = year
    ? `year-${year}`
    : genreId == null || genreId === ""
      ? "trending"
      : `genre-${genreId}`;
  const sortBy = String(sort || "").trim() || "popularity.desc";
  const sortSlug = sortBy !== "popularity.desc" ? `s-${sortBy.replace(/[^\w.]/g, "")}` : "";
  const cacheKey = `tv-category-${slug}-p${page}-l${limit}${sortSlug ? `-${sortSlug}` : ""}`;
  // Check Supabase first
  const supaHit = await readSupabaseCache(cacheKey);
  if (supaHit) {
    ensureStoredLater(supaHit.items, { mediaType: "tv" });
    return { ...supaHit, fromCache: true, source: 'supabase' };
  }

  const cached = readDiskCacheEntry(TMDB_TV_DB, cacheKey, TMDB_SEARCH_TTL);
  if (cached) {
    ensureStoredLater(cached.items, { mediaType: "tv" });
    return { ...cached, fromCache: true };
  }
  if (!isNetworkOnline()) {
    const offlineCached = readAnyDiskCacheEntry(TMDB_TV_DB, cacheKey);
    if (offlineCached) {
      ensureStoredLater(offlineCached.items, { mediaType: "tv" });
      return { ...offlineCached, fromCache: true, offline: true };
    }
    throw new Error("You're offline. Only downloaded and previously cached TV content is available.");
  }
  const genreQuery = year
    ? `&first_air_date_year=${encodeURIComponent(String(year))}`
    : slug === "trending"
      ? ""
      : `&with_genres=${encodeURIComponent(String(genreId))}`;
  // Top-rated shelves need a vote floor or they surface one-vote miniseries.
  const voteQuery = sortBy.includes("vote_average") ? "&vote_count.gte=20" : "";
  const response = await fetch(
    `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&language=en-US&sort_by=${encodeURIComponent(sortBy)}&include_adult=false&page=${page}${genreQuery}${voteQuery}`
  );
  if (!response.ok) throw new Error(`TMDb TV category failed: ${response.status}`);
  const data = await response.json();
  const payload = {
    items: (data.results || []).filter((item) => item.poster_path).slice(0, limit).map((item) => mapTmdbTv(item, page)),
    page: data.page || page,
    totalPages: Math.min(data.total_pages || 1, 500), // TMDb hard page cap
  };
  // Write to both Supabase and disk
  await writeSupabaseCache(cacheKey, payload);
  writeDiskCacheEntry(TMDB_TV_DB, cacheKey, payload, TMDB_SEARCH_TTL);
  // New series → auto-store (duplicates skipped)
  ensureStoredLater(payload.items, { mediaType: "tv" });
  return payload;
}

async function getTvDetailsCached(id, season = null) {
  const cacheKey = season == null ? `tv-details-${id}` : `tv-season-${id}-${season}`;
  // Check Supabase first
  const supaHit = await readSupabaseCache(cacheKey);
  if (supaHit) {
    persistEpisodesFromPayload(id, season, supaHit); // B4 — keep episode rows fresh
    return { ...supaHit, fromCache: true, source: 'supabase' };
  }

  const cached = readDiskCacheEntry(TMDB_TV_DB, cacheKey, TMDB_SEARCH_TTL);
  if (cached) {
    persistEpisodesFromPayload(id, season, cached); // B4
    return { ...cached, fromCache: true };
  }
  if (!isNetworkOnline()) {
    const offlineCached = readAnyDiskCacheEntry(TMDB_TV_DB, cacheKey);
    if (offlineCached) return { ...offlineCached, fromCache: true, offline: true };
    throw new Error("You're offline. This TV show has not been cached yet.");
  }
  const endpoint = season == null ? `tv/${id}` : `tv/${id}/season/${season}`;
  const response = await fetch(`https://api.themoviedb.org/3/${endpoint}?api_key=${TMDB_API_KEY}&language=en-US`);
  if (!response.ok) throw new Error(`TMDb TV details failed: ${response.status}`);
  const data = await response.json();
  const payload = season == null
    ? {
        id: data.id,
        title: data.name,
        year: String(data.first_air_date || "").slice(0, 4),
        overview: data.overview || "",
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
        backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
        language: data.original_language || "",
        seasons: (data.seasons || []).filter((item) => item.season_number > 0).map((item) => ({
          number: item.season_number,
          title: item.name,
          episodeCount: item.episode_count,
        })),
      }
    : {
        season: data.season_number,
        episodes: (data.episodes || []).map((episode) => ({
          number: episode.episode_number,
          title: episode.name,
          airDate: episode.air_date || "",
          overview: episode.overview || "",
        })),
      };
  // Write to both Supabase and disk
  await writeSupabaseCache(cacheKey, payload);
  writeDiskCacheEntry(TMDB_TV_DB, cacheKey, payload, TMDB_SEARCH_TTL);
  persistEpisodesFromPayload(id, season, payload); // B4 — structured episode rows
  return payload;
}

async function getPopularMoviesCached(page = 1, limit = 32, excludeIds = []) {
  const excludeKey = Array.isArray(excludeIds) ? excludeIds.slice().sort().join(",") : "";
  const cacheKey = `popular-mix-v2-p${page}-l${limit}-e${excludeKey}`;
  // Check Supabase first
  const supaHit = await readSupabaseCache(cacheKey);
  let payload = supaHit;
  if (supaHit) {
    queryClient.setQueryData(["popular-movies", cacheKey], supaHit);
    payload = { ...supaHit, fromCache: true, source: 'supabase' };
  } else {
    const diskHit = readDiskCacheEntry(MOVIES_YEAR_DB, cacheKey, MOVIES_YEAR_TTL);
    if (diskHit) {
      queryClient.setQueryData(["popular-movies", cacheKey], diskHit);
      payload = { ...diskHit, fromCache: true };
    } else if (!isNetworkOnline()) {
      const offlineHit = readAnyDiskCacheEntry(MOVIES_YEAR_DB, cacheKey);
      if (offlineHit) {
        payload = { ...offlineHit, fromCache: true, offline: true };
      } else {
        const offlineDb = await listItemsFromSupabase({ mediaType: "movie", limit: 100 });
        if (!offlineDb.items.length) throw new Error("You're offline. Only downloaded movies and previously cached content are available.");
        payload = { items: offlineDb.items, page: 1, totalPages: 1, fromCache: true, source: "supabase", offline: true };
      }
    } else {
      let fetched;
      try {
        fetched = await queryClient.fetchQuery({
          queryKey: ["popular-movies", cacheKey],
          staleTime: REACT_QUERY_STALE_TIME, // 1 hour
          gcTime: MOVIES_YEAR_TTL,
          queryFn: () => fetchTmdbPopularCatalog(page, Math.max(limit * 2, 40)),
        });
      } catch (fetchError) {
        // APIs down / key missing → serve stored DB items so Home is never empty.
        const dbFallback = await listItemsFromSupabase({ mediaType: "movie", limit: 100 });
        if (!dbFallback.items.length) throw fetchError;
        console.warn("popular catalog: API failed, serving Supabase items —", fetchError.message);
        payload = { items: dbFallback.items, page: 1, totalPages: 1, fromCache: true, source: "supabase", dbFallback: true };
      }
      if (fetched) {
        payload = fetched;
        // Write to Supabase as well
        await writeSupabaseCache(cacheKey, payload);
        writeDiskCacheEntry(MOVIES_YEAR_DB, cacheKey, payload, MOVIES_YEAR_TTL);
        payload = { ...payload, fromCache: false };
      }
    }
  }

  const excluded = new Set((excludeIds || []).map(String));
  const items = (payload.items || []).filter((item) => !excluded.has(String(item.tmdbId)));
  // Everything fetched for Home (infinite scroll included) → auto-store in
  // Supabase. Already-stored ids are skipped, so no duplicates are ever created.
  ensureStoredLater(payload.items);
  return {
    ...payload,
    items: items.slice(0, limit),
  };
}

function clearAppCaches({ disk = true } = {}) {
  try {
    queryClient.clear();
  } catch {}
  posterCache.clear();
  posterInflight.clear();

  if (!disk) return { ok: true, disk: false };

  const files = [
    SEARCH_CACHE_DB,
    POSTER_CACHE_DB,
    MOVIES_YEAR_DB,
    TMDB_SEARCH_DB,
    TMDB_COUNTRIES_DB,
    TMDB_TV_DB,
  ];
  let removed = 0;
  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch (error) {
      console.warn("Cache clear failed:", file, error.message);
    }
  }
  return { ok: true, disk: true, removed };
}

loadHiddenDownloads();
initPosterResolver();

if (!TMDB_API_KEY) {
  console.warn("TMDB_API_KEY is missing from .env — home/trending movies will not load.");
}
if (!WATCHMODE_API_KEY) {
  console.warn("WATCHMODE_API_KEY is missing from .env — poster fallback #2 disabled.");
}
if (!STREAMING_API_KEY) {
  console.warn("STREAMING_API_KEY is missing from .env — poster fallback #3 disabled.");
}

// ---------------------------------------------------------
// SINGLE INSTANCE LOCK
// ---------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Do not construct WebTorrent in a losing instance — that caused ACCESS_VIOLATION crashes.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createTorrentClient();
    // Bust stale TanStack + disk catalogs so trending refreshes with the new mix.
    clearAppCaches({ disk: true });
    createWindow();
    if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify();
    // B2 — background torrent finder: first batch after startup, then every
    // 30 minutes (never-checked items first; >24h-old rows re-checked → B6).
    setTimeout(kickTorrentBackfill, 20 * 1000);
    setInterval(kickTorrentBackfill, TORRENT_BACKFILL_INTERVAL_MS);
  });
}

// ---------------------------------------------------------
// SAVE & RESTORE LOGIC (AUTO-RESUME)
// ---------------------------------------------------------

// 1. SAVE: Runs before the app quits
function saveState() {
  // Persist incomplete downloads so they resume after restart.
  if (!client) return;
  const active = client.torrents
    .filter((t) => t.progress < 1 && t.uiId && !hiddenDownloadIds.has(String(t.uiId)))
    .map((t) => ({
      id: t.uiId,
      title: t.uiTitle,
      magnet: t.magnetURI,
      path: t.path,
      paused: false,
    }));

  try {
    fs.writeFileSync(DOWNLOADS_DB, JSON.stringify(active));
  } catch (e) {
    console.error("Save failed:", e);
  }
}

function findTorrentByUiId(id) {
  if (!client) return null;
  return client.torrents.find((t) => String(t.uiId) === String(id)) || null;
}

function pickVideoFile(torrent) {
  if (!torrent?.files?.length) return null;
  const ranked = [...torrent.files].sort((a, b) => b.length - a.length);
  return (
    ranked.find((f) => /\.(mp4|m4v|webm)$/i.test(f.name)) ||
    ranked.find((f) => /\.(mkv|avi|mov)$/i.test(f.name)) ||
    null
  );
}

async function ensurePreviewServer(torrent) {
  const key = String(torrent.uiId || torrent.infoHash);
  const existing = previewServers.get(key);
  if (existing?.server) return existing;

  const server = torrent.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const entry = { server, port: server.address().port };
  previewServers.set(key, entry);
  return entry;
}

function stopPreviewServer(id) {
  const key = String(id);
  const entry = previewServers.get(key);
  if (!entry) return;
  try {
    entry.server.close();
  } catch {}
  previewServers.delete(key);
}
// 2. RESTORE: Runs when app starts
function restoreDownloads() {
  if (!fs.existsSync(DOWNLOADS_DB)) return;

  try {
    const saved = JSON.parse(fs.readFileSync(DOWNLOADS_DB));
    console.log("🔄 Restoring", saved.length, "downloads...");

    saved.forEach((item) => {
      // Restart the torrent engine for each item
      // We pass 'true' to indicate this is a RESTORE (not a new user click)
      startTorrent(null, item, true);
    });

    // Send the list to the UI so the Sidebar pops up
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          "restore-downloads",
          saved.filter((item) => !hiddenDownloadIds.has(String(item.id)))
        );
      }
    }, 2000); // Wait 2s for window to fully load
  } catch (e) {
    console.error("Restore failed:", e);
  }
}

// Save when quitting
app.on("before-quit", () => {
  isQuitting = true;
  saveState();
});

// --- HELPER: CONFIG ---
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH))
      return JSON.parse(fs.readFileSync(CONFIG_PATH));
  } catch (e) {}
  return { downloadPath: app.getPath("downloads") };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

// --- WINDOW CREATION ---
function createWindow() {
  // 1. Create SPLASH Window
  splash = new BrowserWindow({
    width: 500,
    height: 350,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, "../icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  splash.loadFile("src/splash.html");

  // 2. Create MAIN Window (Hidden initially)
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    title: "Cinebroad",
    icon: path.join(__dirname, "../icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      // Allow in-app preview streaming from the local WebTorrent HTTP server.
      webSecurity: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile("src/index.html");

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (tray) {
      tray.displayBalloon?.({
        title: "Cinebroad",
        content: "Still downloading in the background. Open from the tray icon.",
      });
    }
  });

  createTray();

  // --- UPDATE / LAUNCH LOGIC ---

  const sendStatus = (text) => {
    if (splash && !splash.isDestroyed()) {
      try {
        splash.webContents.send("update-status", text);
      } catch (e) {}
    }
  };

  const launchMainApp = () => {
    if (splash && !splash.isDestroyed()) {
      splash.destroy();
      mainWindow.show();
      restoreDownloads(); // <--- RESTORE STARTS HERE
    }
  };

  splash.webContents.once("did-finish-load", () => {
    splash.webContents.send("app-version", app.getVersion());

    // FIX: Skip updates if in Dev Mode (npm start)
    if (!app.isPackaged) {
      sendStatus("Dev Mode: Launching...");
      setTimeout(launchMainApp, 1500);
      return;
    }

    sendStatus("Checking for updates...");

    // Safety Timeout
    setTimeout(() => {
      console.log("Updater timed out. Forcing launch.");
      launchMainApp();
    }, 10000);

    autoUpdater.checkForUpdatesAndNotify().catch((err) => console.log(err));
  });

  // Events to switch to Main Window
  autoUpdater.on("update-not-available", () => {
    sendStatus("Up to date! Launching...");
    setTimeout(launchMainApp, 1500);
  });

  autoUpdater.on("error", (err) => {
    sendStatus("Update check failed. Launching...");
    setTimeout(launchMainApp, 1500);
  });

  // Standard Update Events
  autoUpdater.on("update-available", () =>
    sendStatus("New version found. Downloading...")
  );
  autoUpdater.on("download-progress", (p) =>
    sendStatus(`Downloading: ${p.percent.toFixed(0)}%`)
  );
  autoUpdater.on("update-downloaded", () => {
    sendStatus("Update Ready. Restarting...");
    setTimeout(() => autoUpdater.quitAndInstall(), 2000);
  });
}

function createTray() {
  if (tray) return;

  tray = new Tray(path.join(__dirname, "../icon.png"));
  tray.setToolTip("Cinebroad — downloads keep running in tray");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Open Cinebroad",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: "Downloads keep running in background",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Quit (stops downloads)",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on("click", () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// --- HANDLERS ---
ipcMain.handle("search-movies", async (event, query, meta = {}) => {
  try {
    const { results, fromCache } = await getCachedSearchResults(query);
    if (Array.isArray(results) && results.length) {
      // B1 — persist click-time results so the DB always holds fresh torrents.
      persistTorrentSearchLater(query, results.slice(0, 5), meta);
      return { results, fromCache };
    }
    // B1 — live search empty (providers down / offline): serve saved torrents
    // so "No torrent found" never fires while the DB holds a release.
    const scope = scopeFromMeta(meta);
    const saved = await torrentLibrary.getTorrents({ query, ...scope });
    if (saved.length) {
      console.log(`[torrent fallback] "${query}" → ${saved.length} saved torrent(s) from Supabase`);
      return { results: saved, fromCache: true, fromDb: true };
    }
    return { results: [], fromCache };
  } catch (err) {
    console.error("Search failed:", err.message);
    try {
      const saved = await torrentLibrary.getTorrents({ query, ...scopeFromMeta(meta) });
      if (saved.length) return { results: saved, fromCache: true, fromDb: true };
    } catch {
      // library unavailable — fall through to the error payload
    }
    return { results: [], fromCache: false, error: err.message };
  }
});

// B3 — one batched lookup for language-availability / parts badges in the UI.
ipcMain.handle("get-media-languages", async (event, payload) => {
  const items = Array.isArray(payload) ? payload : payload?.items || [];
  return await torrentLibrary.getLanguageMap(items);
});

ipcMain.handle("search-tmdb", async (event, payload) => {
  try {
    return await searchTmdb(String(payload?.query || "").trim(), Number(payload?.page) || 1);
  } catch (error) {
    console.warn("TMDb search failed:", error.message);
    return { items: [], page: 1, totalPages: 1, error: error.message };
  }
});

ipcMain.handle("get-tmdb-countries", async () => {
  try {
    return await getTmdbCountries();
  } catch (error) {
    console.warn("TMDb country list failed:", error.message);
    return [];
  }
});

ipcMain.handle("discover-tmdb", async (event, payload) => {
  try {
    return await discoverTmdbByCountry(
      String(payload?.country || "").trim(),
      Number(payload?.page) || 1,
      Number(payload?.limit) || 16
    );

  } catch (error) {
    console.warn("TMDb country discovery failed:", error.message);
    return { items: [], page: 1, totalPages: 1, error: error.message };
  }
});

ipcMain.handle("get-tv-shows", async (event, payload) => {
  try {
    return await fetchRailwayTvDiscover({
      page: Number(payload?.page) || 1,
      limit: Number(payload?.limit) || 16,
      query: String(payload?.query || "").trim(),
      sort: "popularity.desc",
    });
  } catch (error) {
    return { items: [], page: 1, totalPages: 1, error: error.message };
  }
});

ipcMain.handle("get-tv-categories", () =>
  TV_CATEGORIES.map(({ key, label, genreId }) => ({ key, label, genreId }))
);

ipcMain.handle("get-tv-shows-by-genre", async (event, payload) => {
  try {
    return await fetchRailwayTvDiscover({
      genreId: payload?.genreId == null || payload.genreId === "" ? null : Number(payload.genreId),
      year: payload?.year || null,
      sort: String(payload?.sort || "popularity.desc").trim(),
      page: Number(payload?.page) || 1,
      limit: Math.min(Math.max(Number(payload?.limit) || 14, 2), 50),
    });
  } catch (error) {
    return { items: [], page: 1, totalPages: 1, error: error.message };
  }
});

ipcMain.handle("get-tv-details", async (event, payload) => {
  try {
    return await getTvDetailsCached(Number(payload?.id), payload?.season == null ? null : Number(payload.season));
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (result.canceled) return null;
  saveConfig({ downloadPath: result.filePaths[0] });
  return result.filePaths[0];
});

ipcMain.handle("get-config", () => loadConfig());

ipcMain.handle("get-api-keys", () => ({
  tmdbApiKey: TMDB_API_KEY,
}));

ipcMain.handle("get-network-status", () => ({ online: isNetworkOnline() }));

ipcMain.handle("get-movies-by-year", async (event, payload) => {
  const year = Number(payload?.year);
  if (!year) return { year: null, items: [], fromCache: false };
  try {
    return await getMoviesByYearCached(year, {
      limit: payload?.limit || 8,
      sort: payload?.sort || "vote_average.desc",
      page: payload?.page || 1,
    });
  } catch (error) {
    console.warn("get-movies-by-year failed:", error.message);
    return { year, items: [], fromCache: false, error: error.message };
  }
});

ipcMain.handle("get-popular-movies", async (event, payload) => {
  try {
    return await getPopularMoviesCached(payload?.page || 1, payload?.limit || 32);
  } catch (error) {
    console.warn("get-popular-movies failed:", error.message);
    return { items: [], page: 1, totalPages: 1, fromCache: false, error: error.message };
  }
});

ipcMain.handle("clear-caches", async () => clearAppCaches({ disk: true }));

ipcMain.handle("get-active-downloads", () => {
  if (!client) return [];
  return client.torrents
    .filter((torrent) => torrent.uiId && !hiddenDownloadIds.has(String(torrent.uiId)))
    .map((torrent) => ({
      id: torrent.uiId,
      title: torrent.uiTitle,
      magnet: torrent.magnetURI,
      path: torrent.path,
      progress: Number((torrent.progress * 100).toFixed(1)),
      downloaded: torrent.downloaded,
      total: torrent.length,
      speed: Number((torrent.downloadSpeed / 1024 / 1024).toFixed(2)),
      speedBps: torrent.downloadSpeed || 0,
      peers: torrent.numPeers,
      done: torrent.progress >= 1,
    }));
});

ipcMain.on("hide-download", (event, id) => {
  if (!id) return;
  hiddenDownloadIds.add(String(id));
  saveHiddenDownloads();
});

ipcMain.handle("resolve-poster", async (event, payload) => {
  try {
    return await resolvePoster({
      title: payload?.title || "",
      imdb: payload?.imdb || null,
      searchHint: payload?.searchHint || null,
      offline: !isNetworkOnline(),
    });
  } catch (error) {
    console.warn("resolve-poster failed:", error.message);
    return null;
  }
});

// Backwards-compatible alias
ipcMain.handle("get-watchmode-poster", async (event, title) =>
  resolvePoster({ title, imdb: null, searchHint: null })
);

ipcMain.on("start-download", (event, torrentData) => {
  if (!isNetworkOnline()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("download-error", {
        id: torrentData?.id,
        message: "You're offline. New downloads require an internet connection.",
      });
    }
    return;
  }
  hiddenDownloadIds.delete(String(torrentData.id));
  saveHiddenDownloads();
  startTorrent(event, torrentData);
  saveState();
});
ipcMain.on("resume-download", (event, torrentData) => {
  hiddenDownloadIds.delete(String(torrentData.id));
  saveHiddenDownloads();
  startTorrent(event, torrentData);
  saveState();
});

ipcMain.on("pause-download", (event, magnet) => {
  if (!magnet) return;
  const torrent = client.get(magnet);
  if (torrent) {
    stopPreviewServer(torrent.uiId);
    torrent.destroy();
    saveState();
  }
});

ipcMain.on("cancel-download", (event, magnet) => {
  if (!magnet) return;
  const torrent = client.get(magnet);
  if (torrent) {
    const uiId = torrent.uiId;
    stopPreviewServer(uiId);
    client.remove(magnet, { destroyStore: false }, () => {
      if (uiId) {
        hiddenDownloadIds.add(String(uiId));
        saveHiddenDownloads();
      }
      saveState();
    });
  }
});

ipcMain.on("show-in-folder", (event, filePath) => {
  shell.showItemInFolder(filePath);
});

async function resolveMagnetLink(torrentData, onStatus) {
  const status = (message) => {
    try { onStatus?.(message); } catch {}
  };

  // 1. If already have a magnet, return it immediately
  if (torrentData?.magnet && String(torrentData.magnet).startsWith("magnet:")) {
    return torrentData.magnet;
  }

  // Helper: Try to get magnet from torrent-search-api (handles detail page scraping)
  const tryGetMagnet = async (data, timeoutMs = 15000) => {
    if (!data?.desc && !data?.link && !data?.provider) return null;
    try {
      const magnet = await Promise.race([
        TorrentSearchApi.getMagnet(data),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Magnet fetch timed out")), timeoutMs)
        ),
      ]);
      if (magnet && String(magnet).startsWith("magnet:")) return magnet;
    } catch (error) {
      console.warn("getMagnet failed:", error.message);
    }
    return null;
  };

  // Helper: Download .torrent file, parse it with WebTorrent to get magnet
  const tryTorrentFile = async (url, label = "Torrent file") => {
    try {
      status(`${label} download…`);
      const cleanUrl = String(url).split("#")[0];
      const response = await fetch(cleanUrl, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 100) throw new Error("File too small");
      const tmpPath = path.join(os.tmpdir(), `cinebroad-${Date.now()}.torrent`);
      await fs.promises.writeFile(tmpPath, buffer);
      const result = await new Promise((resolve) => {
        const client = new WebTorrent();
        client.add(tmpPath, (torrent) => {
          client.destroy();
          resolve(torrent.magnetURI || null);
        });
        setTimeout(() => { try { client.destroy(); } catch {} resolve(null); }, 10000);
      });
      await fs.promises.unlink(tmpPath).catch(() => {});
      if (result && String(result).startsWith("magnet:")) return result;
    } catch (error) {
      console.warn(`${label} failed:`, error.message);
    }
    return null;
  };

  // 2. Try getMagnet from the original torrentData (detail page URL or torrent link)
  let magnet = await tryGetMagnet(torrentData, 15000);
  if (magnet) return magnet;

  // 3. If link is a .torrent file URL, download and parse it
  if (torrentData?.link && String(torrentData.link).includes(".torrent")) {
    magnet = await tryTorrentFile(torrentData.link, "Downloading .torrent file");
    if (magnet) return magnet;
  }

  // 4. If desc (detail page) exists, try getMagnet on it specifically
  if (torrentData?.desc) {
    magnet = await tryGetMagnet({ link: torrentData.desc, provider: torrentData.provider }, 12000);
    if (magnet) return magnet;
  }

  // 5. Re-search and try first 8 results
  const query = String(torrentData?.title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (query) {
    status("Searching torrent sources…");
    const results = await fetchTorrentSearch(query).catch(() => []);
    for (let i = 0; i < Math.min(8, results.length); i++) {
      const item = results[i];
      status(`Resolving magnet (${i + 1}/${Math.min(8, results.length)})…`);
      magnet = await tryGetMagnet(item, 10000);
      if (magnet) return magnet;
      // Also try .torrent file for each result
      if (item?.link && String(item.link).includes(".torrent")) {
        magnet = await tryTorrentFile(item.link, `Torrent file ${i + 1}`);
        if (magnet) return magnet;
      }
    }
  }

  // 6. Final attempt: retry original link as .torrent one more time
  if (torrentData?.link && String(torrentData.link).includes(".torrent")) {
    magnet = await tryTorrentFile(torrentData.link, "Final .torrent attempt");
    if (magnet) return magnet;
  }

  return null;
}

// ---------------------------------------------------------
// CORE DOWNLOAD FUNCTION (UPDATED FOR RESTORE)
// ---------------------------------------------------------
async function startTorrent(event, torrentData, isRestore = false) {
  const config = loadConfig();

  // If restoring, use the path saved in the file. Otherwise use default config.
  const downloadLocation =
    isRestore && torrentData.path ? torrentData.path : config.downloadPath;

  const sendStatus = (message) => {
    if (!mainWindow || mainWindow.isDestroyed() || !torrentData?.id) return;
    mainWindow.webContents.send("download-progress", {
      id: torrentData.id,
      title: torrentData.title,
      progress: 0,
      speed: 0,
      peers: 0,
      downloaded: 0,
      total: 0,
      status: message,
      magnet: torrentData.magnet || null,
    });
  };

  let magnet = null;
  try {
    magnet = await resolveMagnetLink(torrentData, sendStatus);
    if (!magnet) throw new Error("No magnet link found for this release.");
    // B1 — remember the resolved magnet so the next download starts instantly.
    persistMagnetForTitle(torrentData, magnet);
  } catch (e) {
    console.error(e);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("download-error", {
        id: torrentData.id,
        message: e.message || "No Magnet",
      });
    }
    return;
  }

  const originalMagnet = magnet;
  magnet = withExtraTrackers(magnet);

  // Prevent duplicates (match original or tracker-enriched magnet)
  const existing = client.get(originalMagnet) || client.get(magnet);
  if (existing) {
    existing.uiId = torrentData.id;
    existing.uiTitle = torrentData.title;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("download-started", {
        id: torrentData.id,
        magnet,
      });
    }
    return;
  }

  sendStatus("Connecting to peers…");

  // START DOWNLOAD
  client.add(
    magnet,
    {
      path: downloadLocation,
      maxWebConns: 55,
      strategy: "rarest",
      announce: EXTRA_TRACKERS,
    },
    (torrent) => {
    // Save metadata needed for restoring later
    torrent.uiId = torrentData.id;
    torrent.uiTitle = torrentData.title;

    try {
      torrent.maxWebConns = 55;
      // Prefer the largest video file so bandwidth focuses on the main content.
      const videos = torrent.files
        .filter((f) => /\.(mp4|mkv|avi|mov|m4v)$/i.test(f.name))
        .sort((a, b) => b.length - a.length);
      if (videos.length) {
        torrent.files.forEach((file) => file.deselect());
        videos[0].select();
      }
    } catch (err) {
      console.warn("Could not prioritize video file:", err.message);
    }

    // IMPORTANT: Only tell UI "Started" if it's NEW (not restoring)
    // If we are restoring, the UI gets the list separately via 'restore-downloads'
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("download-started", {
        id: torrentData.id,
        magnet: magnet,
      });
    }

    saveState();

    // Progress Loop
    let progressTicks = 0;
    const interval = setInterval(() => {
      if (!mainWindow || torrent.destroyed) return clearInterval(interval);

      mainWindow.webContents.send("download-progress", {
        id: torrent.uiId,
        title: torrent.uiTitle,
        progress: (torrent.progress * 100).toFixed(1),
        speed: (torrent.downloadSpeed / 1024 / 1024).toFixed(2),
        speedBps: torrent.downloadSpeed || 0,
        downloaded: torrent.downloaded,
        total: torrent.length,
        peers: torrent.numPeers,
        magnet: magnet,
        done: torrent.progress >= 1,
        status:
          torrent.numPeers === 0
            ? "Looking for peers…"
            : torrent.downloadSpeed > 0
              ? null
              : "Connected — waiting for data…",
      });

      progressTicks += 1;
      if (progressTicks % 5 === 0) saveState();

      if (torrent.progress === 1) clearInterval(interval);
    }, 1000);

    torrent.on("done", () => {
      // 1. Mark as completed in the internal list?
      // (Optional, but good for logic. For now, we just notify UI)

      const file = torrent.files.find(
        (f) =>
          f.name.endsWith(".mp4") ||
          f.name.endsWith(".mkv") ||
          f.name.endsWith(".avi")
      );

      let fullPath = "";
      if (file) {
        fullPath = path.join(downloadLocation, file.path);
      }

      // ONLY Send the message. DO NOT call client.remove() here!
      mainWindow.webContents.send("download-complete", {
        id: torrent.uiId,
        title: torrent.uiTitle,
        path: fullPath,
      });
    });

    torrent.on("error", (err) => {
      mainWindow.webContents.send("download-error", {
        id: torrent.uiId,
        message: err.message,
      });
    });
  });
}

ipcMain.handle("open-preview", async (event, id) => {
  try {
    const torrent = findTorrentByUiId(id);
    if (!torrent) return { error: "Download not found. It may still be connecting." };

    if (!torrent.ready) {
      await Promise.race([
        new Promise((resolve) => torrent.once("ready", resolve)),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Torrent metadata is still loading")), 20000)
        ),
      ]);
    }

    const file = pickVideoFile(torrent);
    if (!file) return { error: "No playable video file found in this torrent yet." };

    try {
      torrent.files.forEach((f) => f.deselect());
      file.select();

      torrent.strategy = "sequential";
      const firstPiece = Math.floor(file.offset / torrent.pieceLength);
      const previewPieces = Math.min(torrent.pieces.length - 1, firstPiece + 2);
      torrent.select(firstPiece, previewPieces, true);
      torrent.critical(firstPiece, previewPieces);
    } catch {}

    const { port } = await ensurePreviewServer(torrent);
    const index = torrent.files.indexOf(file);
    const streamUrl = `http://127.0.0.1:${port}/${index}`;
    const diskPath = path.join(torrent.path, file.path);

    return {
      id: String(id),
      title: torrent.uiTitle || file.name,
      fileName: file.name,
      streamUrl,
      diskPath,
      progress: torrent.progress,
      done: torrent.progress >= 1,
      streaming: torrent.progress < 1,
    };
  } catch (error) {
    return { error: error.message || "Preview failed" };
  }
});

ipcMain.handle("open-local-preview", async (event, payload) => {
  const filePath = String(payload?.filePath || "");
  if (!filePath || !fs.existsSync(filePath)) return { error: "Downloaded video file was not found." };
  return {
    id: "local",
    title: payload?.title || path.basename(filePath),
    fileName: path.basename(filePath),
    streamUrl: pathToFileURL(filePath).href,
    diskPath: filePath,
    progress: 1,
    done: true,
    streaming: false,
  };
});

ipcMain.handle("open-external-video", async (event, filePath) => {
  if (!filePath) return { ok: false };
  const result = await shell.openPath(filePath);
  return { ok: !result, error: result || null };
});

ipcMain.on("close-preview", (event, id) => {
  if (id) stopPreviewServer(id);
});

ipcMain.on("preview-file", async (event, id) => {
  // Back-compat: ask renderer to open the in-app player via progress channel pattern
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("preview-request", { id });
  }
});
