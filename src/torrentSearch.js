"use strict";

/**
 * Torrent search core — providers (B7), title aliases, scoring, magnet search.
 * ---------------------------------------------------------------------------
 * Extracted from src/main.js so terminal test scripts (npm run
 * test:torrent-search) exercise the EXACT same code the Electron app uses —
 * no Electron required. src/main.js requires this module.
 *
 * B7 (LIST B): the provider set goes far beyond the original 3 fast indexers:
 * 1337x, YTS, EZTV, LimeTorrents, TorrentProject, Torrentz2, ThePirateBay,
 * KickassTorrents and RARBG are all enabled. Every provider call is raced
 * with a hard timeout, so a dead mirror can never hang the search — it just
 * contributes zero results.
 */

const TorrentSearchApi = require("torrent-search-api");

const SEARCH_RESULT_LIMIT = 40;
const SEARCH_TIMEOUT = 15 * 1000;
const PROVIDER_TIMEOUT = 10000;

function safeDelay(ms, fallback = 100) {
  const value = Number(ms);
  const fallbackValue = Number(fallback);
  const base = Number.isFinite(value) && value > 0 ? value : Number.isFinite(fallbackValue) ? fallbackValue : 100;
  return Math.max(100, Math.floor(base));
}

// Indian / Bollywood indexers first. TorrentGalaxy is enabled when this build
// of torrent-search-api ships it; unknown names are skipped.
const PRIMARY_PROVIDERS = ["1337x", "TorrentGalaxy", "ThePirateBay", "Limetorrents", "TorrentProject"];
const SECONDARY_PROVIDERS = ["Yts", "Eztv", "KickassTorrents", "Torrentz2"];
const REGIONAL_PROVIDERS = PRIMARY_PROVIDERS;
const DEFAULT_PROVIDERS = [...PRIMARY_PROVIDERS, ...SECONDARY_PROVIDERS];

const TITLE_ALIASES = {
  interstaller: "Interstellar",
  intersteller: "Interstellar",
  interstelar: "Interstellar",
  interstellr: "Interstellar",
  viking: "Vikings",
  vikings: "Vikings",
  avenger: "Avengers",
  "spider man": "Spider-Man",
  spiderman: "Spider-Man",
  "harry poter": "Harry Potter",
  inceptionn: "Inception",
};

/** enableProvider name variants (package casing differs across builds). */
function providerNameVariants(name) {
  const clean = String(name || "").trim();
  if (!clean) return [];
  const lower = clean.toLowerCase();
  const capitalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  return [...new Set([clean, lower, capitalized])];
}

function getActiveProviderNames() {
  try {
    return (TorrentSearchApi.getActiveProviders?.() || [])
      .map((p) => (typeof p === "string" ? p : p?.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Disable everything, then enable the extended B7 provider set.
 * A provider only counts as enabled when it appears in getActiveProviders()
 * (unknown names must not throw the whole init away).
 * @returns {string[]} the provider names that are actually active
 */
function initTorrentProviders(names = DEFAULT_PROVIDERS) {
  try {
    TorrentSearchApi.disableAllProviders();
  } catch {
    // Some builds have no disableAll — fall through and enable what we can.
  }

  const enabled = [];
  for (const name of names) {
    let activated = false;
    for (const variant of providerNameVariants(name)) {
      try {
        TorrentSearchApi.enableProvider(variant);
      } catch {
        continue; // provider not present in this torrent-search-api build
      }
      const active = getActiveProviderNames();
      const match = active.find((n) => String(n).toLowerCase() === variant.toLowerCase());
      if (match && !enabled.some((n) => n.toLowerCase() === match.toLowerCase())) {
        enabled.push(match);
        activated = true;
        break;
      }
    }
    if (!activated) {
      // Not available under any casing — skip silently (timeout-raced anyway).
    }
  }

  if (!enabled.length) {
    try {
      TorrentSearchApi.enablePublicProviders();
    } catch {
      // Leave whatever is active — fetchTorrentSearch handles empty provider lists.
    }
  }

  const finalNames = getActiveProviderNames();
  console.log(
    `[torrent-search] providers enabled: ${finalNames.length ? finalNames.join(", ") : "(none — public fallback)"}`
  );
  return finalNames.length ? finalNames : enabled;
}

function editDistance(a, b) {
  const s = String(a || "").toLowerCase();
  const t = String(b || "").toLowerCase();
  if (s === t) return 0;
  const rows = s.length + 1;
  const cols = t.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

function aliasCorrectedTitle(query) {
  const normalized = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!normalized) return null;
  if (TITLE_ALIASES[normalized]) return TITLE_ALIASES[normalized];

  let best = null;
  let bestDist = Infinity;
  for (const [typo, title] of Object.entries(TITLE_ALIASES)) {
    const dist = editDistance(normalized, typo);
    const maxAllowed = Math.max(1, Math.floor(typo.length / 5));
    if (dist <= maxAllowed && dist < bestDist) {
      best = title;
      bestDist = dist;
    }
  }
  for (const title of new Set(Object.values(TITLE_ALIASES))) {
    const dist = editDistance(normalized, title.toLowerCase());
    const maxAllowed = Math.max(2, Math.floor(title.length / 6));
    if (dist > 0 && dist <= maxAllowed && dist < bestDist) {
      best = title;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Expand one user query into several provider-friendly title variants:
 * alias-corrected title first, then TMDb / OMDb official titles + years.
 */
async function resolveSearchTitles(query) {
  const raw = String(query || "").trim();
  const titles = [];
  const push = (value) => {
    const cleaned = String(value || "").trim();
    if (!cleaned) return;
    if (!titles.some((t) => t.toLowerCase() === cleaned.toLowerCase())) {
      titles.push(cleaned);
    }
  };

  const alias = aliasCorrectedTitle(raw);
  // Prefer corrected/official titles first so providers hit the right movie.
  if (alias) push(alias);
  push(raw);
  if (alias) {
    push(alias.toLowerCase());
    push(`${alias} 1080p`);
  } else {
    push(raw.toLowerCase());
  }

  const tmdbKey = process.env.TMDB_API_KEY?.trim() || null;
  if (tmdbKey) {
    try {
      const url =
        `https://api.themoviedb.org/3/search/multi?api_key=${tmdbKey}` +
        `&query=${encodeURIComponent(alias || raw)}&include_adult=false&page=1`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        for (const hit of (data.results || []).slice(0, 4)) {
          if (hit.media_type !== "movie" && hit.media_type !== "tv") continue;
          const name = hit.title || hit.name;
          const year = String(hit.release_date || hit.first_air_date || "").slice(0, 4);
          if (name) {
            push(name);
            if (year) {
              push(`${name} ${year}`);
              push(`${name} (${year})`);
            }
          }
        }
      }
    } catch (error) {
      console.warn("TMDB title resolve failed:", error.message);
    }
  }

  const omdbKey = process.env.OMDB_API_KEY?.trim() || null;
  if (titles.length <= 2 && omdbKey) {
    try {
      const url = `https://www.omdbapi.com/?apikey=${omdbKey}&s=${encodeURIComponent(alias || raw)}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        for (const hit of data.Search || []) {
          if (hit.Title) {
            push(hit.Title);
            if (hit.Year) push(`${hit.Title} ${String(hit.Year).slice(0, 4)}`);
          }
        }
      }
    } catch (error) {
      console.warn("OMDb title resolve failed:", error.message);
    }
  }

  return titles.slice(0, 6);
}

/** Score one provider result against the title/year hints. Higher = better. */
function scoreTorrentMatch(torrent, queryHints) {
  const title = String(torrent?.title || "").toLowerCase();
  if (!title) return -100;
  if (/\b(18\+|xxx|porn|lolita)\b/i.test(title)) return -100;
  if (
    /\b(pc game|fitgirl|codex|repack)\b/i.test(title) &&
    !/\b(1080p|720p|webrip|bluray)\b/i.test(title)
  ) {
    return -50;
  }

  const primary = String(queryHints?.[0] || "")
    .toLowerCase()
    .replace(/\b(1080p|720p|2160p|4k)\b/g, " ")
    .replace(/[()]/g, " ")
    .trim();
  const primaryWords = primary.split(/\s+/).filter((w) => w.length > 2 && !/^\d{4}$/.test(w));
  if (primaryWords.length && !primaryWords.some((w) => title.includes(w))) {
    return -100;
  }

  let score = Number(torrent.seeds) || 0;
  for (const hint of queryHints) {
    const h = String(hint || "")
      .toLowerCase()
      .replace(/\b(1080p|720p|2160p|4k)\b/g, " ")
      .replace(/[()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!h || h.length < 3) continue;
    if (title.includes(h)) score += 200;
    const words = h.split(/\s+/).filter((w) => w.length > 2);
    const matched = words.filter((w) => title.includes(w)).length;
    score += matched * 25;
  }
  if (/\b(1080p|2160p|4k|bluray|webrip|web-dl|x264|x265|hevc|yify|rarbg)\b/i.test(title)) {
    score += 40;
  }
  if (
    /hindi|dual[ ._-]?audio|multi[ ._-]?audio|\bdesi\b|\burdu\b|hq-hindi|org\s*2ch|true\s*web-dl|hindi\s*5\.1|hindi\s*\+\s*tamil\s*\+\s*telugu|\bdubbed\b|dual\s*\[\s*hindi/i.test(
      title
    )
  ) {
    score += 250;
  }
  return score;
}

function isVideoTorrent(torrent) {
  const title = String(torrent?.title || "");
  if (!title) return false;
  if (/\b(18\+|xxx|porn)\b/i.test(title)) return false;
  if (
    /\b(pc|game|games|software|ebook|pdf|epub|iso|apk|mobile)\b/i.test(title) &&
    !/\b(1080p|720p|480p|2160p|4k|webrip|web-dl|bluray|hdtv|x264|x265|hevc|mkv|mp4)\b/i.test(title)
  ) {
    return false;
  }
  const seeds = Number(torrent.seeds);
  return !Number.isFinite(seeds) || seeds >= 0;
}

function searchProviderWithTimeout(providerName, query, limit, timeoutMs = PROVIDER_TIMEOUT) {
  const searchCall = providerName
    ? TorrentSearchApi.search([providerName], query, "All", limit)
    : TorrentSearchApi.search(query, "All", limit);
  return Promise.race([
    searchCall.catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), safeDelay(timeoutMs, PROVIDER_TIMEOUT))),
  ]);
}

/**
 * Fan out over all active providers × expanded titles, race every call with
 * a hard timeout, score & de-duplicate, return the best SEARCH_RESULT_LIMIT.
 * Options: { maxTitles = 5, resultLimit = SEARCH_RESULT_LIMIT,
 *            timeoutMs = SEARCH_TIMEOUT, onBatch }
 * `onBatch` fires as soon as any provider returns, so callers can stop
 * without waiting for the rest of the pool.
 */
async function fetchTorrentSearch(query, options = {}) {
  const maxTitles = Math.max(1, Number(options.maxTitles) || 5);
  const resultLimit = Math.max(1, Number(options.resultLimit) || SEARCH_RESULT_LIMIT);
  const timeoutMs = safeDelay(options.timeoutMs, SEARCH_TIMEOUT);
  const skipTitleResolve = Boolean(options.skipTitleResolve);
  const onBatch = typeof options.onBatch === "function" ? options.onBatch : null;
  const providers = TorrentSearchApi.getActiveProviders?.() || [];
  const providerNames = providers.map((p) => p.name || p).filter(Boolean);
  const requested = Array.isArray(options.providers)
    ? options.providers.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean)
    : null;
  const scoped = requested
    ? providerNames.filter((name) => requested.includes(String(name).toLowerCase()))
    : providerNames;
  const names = scoped.length ? scoped : requested ? [] : [null];
  const searchTitles = skipTitleResolve ? [String(query || "").trim()] : await resolveSearchTitles(query);
  const queries = (searchTitles.length ? searchTitles : [query]).slice(0, Math.max(1, maxTitles));
  const merged = [];
  const seen = new Set();

  const pushResults = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const key = `${item.title || ""}|${item.size || ""}|${item.magnet || item.desc || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  };

  const finalize = () =>
    merged
      .filter(isVideoTorrent)
      .map((item) => ({ item, score: scoreTorrentMatch(item, queries) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.item.seeds || 0) - Number(a.item.seeds || 0))
      .map((row) => row.item)
      .slice(0, resultLimit);

  return new Promise((resolve) => {
    let settled = false;
    let pending = 0;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(finalize());
    }, timeoutMs);

    const finishIfReady = () => {
      if (settled) return;
      const ready = finalize();
      if (ready.length >= 8 || pending <= 0) {
        settled = true;
        clearTimeout(timer);
        resolve(ready);
      }
    };

    for (const title of queries) {
      for (const name of names) {
        pending += 1;
        searchProviderWithTimeout(name, title, resultLimit, timeoutMs)
          .then((items) => {
            pushResults(items);
            if (!settled && typeof onBatch === "function" && Array.isArray(items) && items.length) {
              try {
                onBatch(finalize());
              } catch {
                // A caller that already moved on must not break the pool.
              }
            }
            pending -= 1;
            finishIfReady();
          })
          .catch(() => {
            pending -= 1;
            finishIfReady();
          });
      }
    }

    if (pending === 0) {
      settled = true;
      clearTimeout(timer);
      resolve([]);
    }
  });
}

/**
 * Parse a release title for quality, language tags (B3) and multi-part
 * number (B5). Pure function — shared by main.js, tests and the backfill.
 * @returns {{ quality: string, languageTags: string[], part: number }}
 */
function parseTorrentReleaseMeta(title) {
  const text = String(title || "");
  const lower = text.toLowerCase();

  let quality = null;
  for (const candidate of ["2160p", "1080p", "720p", "480p", "360p"]) {
    if (lower.includes(candidate)) {
      quality = candidate;
      break;
    }
  }
  if (!quality && /\b4k\b/.test(lower)) quality = "2160p";
  if (!quality && /\b(?:hd|hq)\b/.test(lower)) quality = "720p";
  if (!quality) quality = "unknown";

  const languageTags = [];
  const urduOnly = /\burdu\b|urdu[ ._-]?(?:dub|audio)/i.test(text) && !/\bhindi\b/i.test(text);
  const hindi =
    /\bhindi\b|\bhin\b|bollywood|lollywood|dual[ ._-]?audio|multi[ ._-]?audio|\bdesi\b|hq-hindi|org\s*2ch|hindi\s*5\.1|hindi\s*\+\s*tamil\s*\+\s*telugu|hindi[ ._-]?(?:dub|flac)|pakistani|indian[ ._-]?(?:dub|audio)|\bdubbed\b/i.test(
      text
    );
  const english = /\benglish\b|\beng\b|\bengsub\b|english[ ._-]?(?:dub|sub)/i.test(text);
  if (hindi) languageTags.push("hindi");
  if (urduOnly) languageTags.push("urdu");
  if (english) languageTags.push("english");

  let part = -1;
  const scoped = /\b(?:cd|pt|part|vol)[ ._-]?(\d{1,2})\b/i.exec(text);
  const ofForm = /(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})/.exec(text);
  const match = scoped || ofForm;
  if (match) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 20) part = n;
  }

  return { quality, languageTags, part };
}

/** Deterministic Hindi-first provider query order for catalog backfill. */
function buildBackfillQueries(title, year = "", originalLanguage = "") {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return [];
  const cleanYear = String(year || "").match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
  const withYear = (text) => [text, cleanYear].filter(Boolean).join(" ").trim();
  const original = String(originalLanguage || "").toLowerCase();
  const originalLabel = original === "en" ? "english" : original ? `${original} audio` : "";

  return [...new Set([
    withYear(`${cleanTitle} hindi dubbed`),
    withYear(`${cleanTitle} dual audio hindi`),
    withYear(`${cleanTitle} urdu dubbed`),
    withYear(`${cleanTitle} pakistani dubbed`),
    withYear(`${cleanTitle} indian dubbed`),
    withYear(originalLabel ? `${cleanTitle} ${originalLabel}` : cleanTitle),
  ].filter(Boolean))];
}

/**
 * Merge rounds and keep a small, language-balanced set. Untagged releases are
 * original/original-language; explicit Hindi/Urdu markers classify as Hindi.
 */
function mergeBackfillResults(rounds, { limitPerLanguage = 2, originalLanguage = "" } = {}) {
  const byKey = new Map();
  const originalCode = String(originalLanguage || "").toLowerCase();
  for (const list of Array.isArray(rounds) ? rounds : []) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item?.title || !isVideoTorrent(item)) continue;
      const key = String(item.magnet || item.infoHash || item.desc || item.link || item.title).toLowerCase();
      const previous = byKey.get(key);
      if (!previous || Number(item.seeds || 0) > Number(previous.seeds || 0)) byKey.set(key, item);
    }
  }
  const hindi = [];
  const original = [];
  for (const item of byKey.values()) {
    const tags = parseTorrentReleaseMeta(item.title).languageTags;
    const itemOriginal = String(item.originalLanguage || item.original_language || originalCode).toLowerCase();
    const bucket = tags.includes("hindi") ? hindi : original;
    bucket.push({ ...item, originalLanguage: itemOriginal || undefined });
  }
  const bySeeds = (a, b) => Number(b.seeds || 0) - Number(a.seeds || 0);
  hindi.sort(bySeeds);
  original.sort(bySeeds);
  return [...hindi.slice(0, limitPerLanguage), ...original.slice(0, limitPerLanguage)];
}

function isBackfillResultFresh(details, staleMs, now = Date.now()) {
  const found = Number(details?.torrentsFound) || 0;
  if (found <= 0) return false;
  const checkedAt = Date.parse(details?.torrentsCheckedAt || "");
  return Number.isFinite(checkedAt) && now - checkedAt < Math.max(1, Number(staleMs) || 1);
}

module.exports = {
  initTorrentProviders,
  getActiveProviderNames,
  fetchTorrentSearch,
  resolveSearchTitles,
  aliasCorrectedTitle,
  scoreTorrentMatch,
  isVideoTorrent,
  parseTorrentReleaseMeta,
  buildBackfillQueries,
  mergeBackfillResults,
  isBackfillResultFresh,
  TITLE_ALIASES,
  DEFAULT_PROVIDERS,
  PRIMARY_PROVIDERS,
  SECONDARY_PROVIDERS,
  SEARCH_RESULT_LIMIT,
  SEARCH_TIMEOUT,
  PROVIDER_TIMEOUT,
};
