let activeDownloads = new Map();
let currentSearchTimestamp = 0;
let allSearchResults = [];
let filteredResults = [];
let currentPage = 0;
const RESULTS_PER_PAGE = 16;
const ROW_LIMIT = 8;
const YEARS_PER_BATCH = 2;
const HOME_BATCH = 8;
const TV_CATEGORIES_PER_BATCH = 2;
const TV_CATEGORY_CARD_WIDTH = 150;
const TV_CATEGORY_GAP = 14;
const HOME_MIX_MAX_PAGE = 500; // TMDb hard page cap for any feed
const HOME_YEAR_MAX_PAGES = 25; // top-rated pages allowed per year on Home
const HOME_YEAR_FLOOR = 1890;
const MOVIES_YEAR_FLOOR = 1920;
const MOVIES_MAX_ROUNDS = 50; // deeper "best rated" passes per year (Movies page)
const TV_YEAR_FLOOR = 1940;
let searchDebounceTimer = null;
let tvSearchDebounceTimer = null;
let tvCategoryResizeTimer = null;
let tvShowsRequestId = 0;
const searchTorrentCache = new Map();
const searchFilterCache = new Map();
const TV_SLIDER_VISIBLE = 3;
const TV_FEATURED_SLIDER_VISIBLE = 8;
const TV_SLIDER_STEP = 3;
let isOffline = !navigator.onLine;
const OFFLINE_MESSAGE = "You're offline. Only downloaded movies and previously cached content are available.";

let showingHomeShowcase = true;
let TMDB_API_KEY = null;
let currentPageName = "home";
let favorites = loadFavorites();
const browseCache = new Map();
const shownMovieKeys = {
  home: new Set(),
  movies: new Set(),
  tvShows: new Set(),
  search: new Set(),
};

function movieIdentityKey(item) {
  if (!item) return "";
  if (item.tmdbId) return `tmdb:${item.tmdbId}`;
  if (item.imdb) return `imdb:${String(item.imdb).toLowerCase()}`;

  const { core, year } = extractCoreTitle(item.title || item.name || "");
  if (!core) return "";
  // Same movie with/without year in the torrent name should collapse to one card.
  // Keep year only when the core title itself is very short/ambiguous.
  const coreWords = core.split(/\s+/).filter(Boolean);
  if (coreWords.length <= 1 && year) return `title:${core}|${year}`;
  return `title:${core}`;
}

function resetShownKeys(scope) {
  if (scope && shownMovieKeys[scope]) {
    shownMovieKeys[scope].clear();
    return;
  }
  Object.values(shownMovieKeys).forEach((set) => set.clear());
}

function dedupeItems(items, scope) {
  const bucket = shownMovieKeys[scope] || new Set();
  const unique = [];
  for (const item of items || []) {
    const key = movieIdentityKey(item);
    if (!key || bucket.has(key)) continue;
    bucket.add(key);
    unique.push(item);
  }
  return unique;
}

const infiniteState = {
  movies: {
    nextYear: null,
    endYear: null,
    round: 1,
    yearPages: {},
    loading: false,
    done: false,
  },
  home: {
    page: 1,
    totalPages: 1,
    source: "mix", // mix | years
    year: null,
    yearPage: 1,
    everSucceeded: false,
    loading: false,
    done: false,
  },
  tvShows: {
    page: 1,
    totalPages: null,
    loading: false,
    done: false,
    query: "",
    mode: "categories", // categories | search
    categories: [],
    categoryIndex: 0,
    columns: 0,
    shelfYear: null,
    yearCursor: {},
    yearPages: {},
  },
  search: {
    mode: "idle", // idle | trending | results
    page: 1,
    totalPages: 1,
    loading: false,
    renderedCount: 0,
    country: "all",
  },
};

let scrollObserver = null;

function setInlineLoader(statusId, loading, idleText = "") {
  const el = document.getElementById(statusId);
  if (!el) return;
  if (loading) {
    el.innerHTML = `<div class="inline-loader"><div class="dots-loader sm"><span></span><span></span><span></span></div></div>`;
    return;
  }
  el.textContent = idleText || "";
}

function setScrollStatus(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
}

// ── B3: language-availability badges (hydrated from media_content) ─────────
const languageInfoCache = new Map(); // key → { at, languages, partsCount }
const LANGUAGE_CACHE_TTL_MS = 5 * 60 * 1000; // re-check "unknown" every 5 min
const LANG_SHORT = { English: "EN", Hindi: "HI", Original: "ORIG" };
let languageHydrationTimer = null;

function scheduleLanguageBadgeHydration() {
  clearTimeout(languageHydrationTimer);
  languageHydrationTimer = setTimeout(() => {
    hydrateLanguageBadges().catch(() => {});
  }, 500);
}

async function hydrateLanguageBadges() {
  if (!window.api?.getMediaLanguages) return;
  const cards = [...document.querySelectorAll(".media-card[data-tmdb-id]")];
  if (!cards.length) return;

  const now = Date.now();
  const needed = [];
  for (const card of cards) {
    const key = `${card.dataset.mediaType || "movie"}:${card.dataset.tmdbId}`;
    const cached = languageInfoCache.get(key);
    const staleUnknown = cached && !cached.languages.length && now - cached.at > LANGUAGE_CACHE_TTL_MS;
    if (!cached || staleUnknown) {
      if (!needed.some((n) => n.key === key)) {
        needed.push({
          key,
          item: { tmdbId: Number(card.dataset.tmdbId), mediaType: card.dataset.mediaType || "movie" },
        });
      }
    }
  }
  if (!needed.length) return;

  const batch = needed.slice(0, 80);
  let map = {};
  try {
    map = (await window.api.getMediaLanguages(batch.map((n) => n.item))) || {};
  } catch {
    return;
  }
  for (const { key } of needed) {
    const info = map[key];
    languageInfoCache.set(key, {
      at: now,
      languages: info?.languages || [],
      partsCount: info?.partsCount || 0,
    });
  }
  for (const card of cards) {
    const key = `${card.dataset.mediaType || "movie"}:${card.dataset.tmdbId}`;
    const info = languageInfoCache.get(key);
    if (!info) continue;
    renderLanguageBadges(card, info);
  }
  if (needed.length > batch.length) scheduleLanguageBadgeHydration();
}

function renderLanguageBadges(card, info = {}) {
  const meta = card.querySelector(".card-meta");
  if (!meta) return;
  const SF = window.SearchFilters;
  const originalLanguage = card.dataset.originalLanguage || "";
  const torrentLangs = info.languages || [];
  const labels = SF
    ? SF.cardLanguageLabels({ originalLanguage }, torrentLangs)
    : torrentLangs.map((label) => LANG_SHORT[label] || String(label).slice(0, 5));
  let holder = meta.querySelector(".lang-badges");
  const chips = labels.map((label) => {
    const key = String(label || "").toUpperCase();
    const cls = key === "HI" ? " lang-chip is-hi" : key === "EN" ? " lang-chip is-en" : " lang-chip";
    return `<span class="${cls.trim()}">${escapeHtml(label)}</span>`;
  });
  if (Number(info.partsCount) > 1) {
    chips.push(`<span class="lang-chip is-parts">${Number(info.partsCount)} parts</span>`);
  }
  if (!chips.length) {
    holder?.remove();
    return;
  }
  if (!holder) {
    holder = document.createElement("span");
    holder.className = "lang-badges";
    meta.appendChild(holder);
  }
  holder.innerHTML = chips.join("");
}

// Auto-hydrate whenever cards land in the DOM (rows, grids, search results).
if (document.body && window.MutationObserver) {
  const domWatcher = new MutationObserver(() => scheduleLanguageBadgeHydration());
  domWatcher.observe(document.body, { childList: true, subtree: true });
}

const FALLBACK_POSTER = new URL("../icon.png", window.location.href).toString();
const posterCache = new Map();
const posterRequests = new Map();

function showToast(title, message = "", type = "info", icon = "fa-circle-info") {
  const stack = document.getElementById("toastStack");
  if (!stack) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon"><i class="fas ${icon}"></i></div>
    <div class="toast-body">
      <p class="toast-title">${escapeHtml(title)}</p>
      ${message ? `<p class="toast-msg">${escapeHtml(message)}</p>` : ""}
    </div>
  `;
  stack.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 250);
  }, 2600);
}

// --- INIT ---
window.onload = async () => {
  setupNavigation();
  document.addEventListener("keydown", handleActivePageRefresh);
  document.getElementById("tvDetailsClose")?.addEventListener("click", closeTvDetails);
  document.getElementById("tvDetailsModal")?.addEventListener("click", (event) => {
    if (event.target.id === "tvDetailsModal") closeTvDetails();
  });
  document.getElementById("tvLanguageSelect")?.addEventListener("change", () => {
    if (tvDetailsState.episodes.length) renderTvEpisodes();
    showToast("Language filter", getTvLanguageLabel(), "favorite", "fa-language");
  });
  window.addEventListener("online", () => setOfflineMode(false));
  window.addEventListener("offline", () => setOfflineMode(true));
  setupPlayerControls();
  loadPersistedDownloadsUi();
  updateBadge();
  try {
    // Ensure catalogs are fresh when renderer boots (main also clears on launch).
    if (window.api.clearCaches) await window.api.clearCaches();
  } catch (error) {
    console.warn("Cache clear skipped:", error.message);
  }
  try {
    const network = await window.api.getNetworkStatus();
    setOfflineMode(!network.online);
  } catch {
    setOfflineMode(!navigator.onLine);
  }

  try {
    const keys = await window.api.getApiKeys();
    TMDB_API_KEY = keys?.tmdbApiKey || null;
  } catch (error) {
    console.warn("API keys could not be loaded:", error);
  }

  try {
    const config = await window.api.getConfig();
    if (document.getElementById("pathDisplay")) {
      document.getElementById("pathDisplay").value = config.downloadPath;
    }
  } catch (error) {
    console.warn("Configuration could not be loaded:", error);
  }

  try {
    await syncDownloadsFromMain();
    renderDownloadsPage();
  } catch (error) {
    console.warn("Active downloads could not be loaded:", error);
  }

  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.value = "";
    searchInput.addEventListener("input", () => {
      const cancelBtn = document.getElementById("cancelSearchBtn");
      if (cancelBtn) cancelBtn.style.display = searchInput.value ? "inline-flex" : "none";
      window.clearTimeout(searchDebounceTimer);
      searchDebounceTimer = window.setTimeout(() => {
        if (searchInput.value.trim()) search();
        else loadSearchTrendingPage(true);
      }, 140);
    });
  }

  const tvSearchInput = document.getElementById("tvSearchInput");
  if (tvSearchInput) {
    tvSearchInput.value = "";
    updateTvSearchClearButton();
    tvSearchInput.addEventListener("input", () => {
      updateTvSearchClearButton();
      window.clearTimeout(tvSearchDebounceTimer);
      tvSearchDebounceTimer = window.setTimeout(() => {
        infiniteState.tvShows.query = tvSearchInput.value.trim();
        loadTvShowsPage(true);
      }, 300);
    });
  }

  // Keep each category shelf at exactly 2 rows when the window is resized.
  window.addEventListener("resize", () => {
    window.clearTimeout(tvCategoryResizeTimer);
    tvCategoryResizeTimer = window.setTimeout(() => {
      if (currentPageName !== "tv-shows") return;
      const state = infiniteState.tvShows;
      if (state.mode !== "categories" || !state.categories.length) return;
      if (getTvCategoryColumns() !== state.columns) loadTvCategories(true);
    }, 300);
  });

  // Default = show everything; users narrow with Language / Country / Quality.
  const languageFilter = document.getElementById("languageFilter");
  const qualityFilter = document.getElementById("qualityFilter");
  const countryFilter = document.getElementById("countryFilter");
  if (languageFilter) languageFilter.value = "all";
  if (qualityFilter) qualityFilter.value = "all";
  document.querySelectorAll("[data-home-row]").forEach((btn) => {
    btn.onclick = () => {
      const shell = btn.closest(".year-row");
      const dir = btn.getAttribute("data-row-action") === "next" ? 3 : -3;
      moveYearRow(shell, dir);
    };
  });
  const tvLang = document.getElementById("tvLanguageSelect");
  if (tvLang) tvLang.value = "hindi";
  if (countryFilter) {
    countryFilter.value = "all";
    loadTmdbCountries(countryFilter);
  }

  navigateTo("home");
  setupInfiniteScroll();
};

function setOfflineMode(offline) {
  isOffline = Boolean(offline);
  const status = document.getElementById("offlineStatus");
  if (status) status.hidden = !isOffline;
}

function showOfflineMessage() {
  showToast("Offline Mode", OFFLINE_MESSAGE, "info", "fa-cloud-slash");
}

async function handleActivePageRefresh(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "r") return;
  event.preventDefault();
  event.stopPropagation();

  const page = currentPageName;
  if (page === "search") {
    const query = document.getElementById("searchInput")?.value?.trim() || "";
    currentSearchTimestamp = 0;
    if (query) search();
    else loadSearchTrendingPage(true);
    return;
  }

  if (page === "home" || page === "movies") {
    await loadBrowsePage(page);
    return;
  }

  if (page === "tv-shows") {
    await loadBrowsePage(page);
    return;
  }

  if (page === "favorites") {
    favorites = loadFavorites();
    renderFavorites();
    return;
  }

  if (page === "downloads") {
    await syncDownloadsFromMain();
    renderDownloadsPage();
  }
}

function setupNavigation() {
  document.querySelectorAll(".nav-btn[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.page));
  });
}

function navigateTo(page, options = {}) {
  const { reload = true } = options;
  if (currentPageName === "tv-shows" && page !== "tv-shows") {
    // Abort the logical TV request when leaving the page. Network requests may
    // finish later, but their response must not mutate the next page visit.
    tvShowsRequestId += 1;
    infiniteState.tvShows.loading = false;
  }
  currentPageName = page;
  document.querySelectorAll(".page").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((el) => el.classList.remove("active"));

  const pageEl = document.getElementById(`page-${page}`);
  const navBtn = document.querySelector(`.nav-btn[data-page="${page}"]`);
  if (pageEl) pageEl.classList.add("active");
  if (navBtn) navBtn.classList.add("active");

  if (page === "favorites") renderFavorites();
  if (page === "downloads") {
    syncDownloadsFromMain();
    renderDownloadsPage();
  }
  if (reload && ["search", "home", "movies", "tv-shows"].includes(page)) loadBrowsePage(page);

  // Re-bind observers after page switch so infinite scroll stays reliable
  requestAnimationFrame(() => setupInfiniteScroll());
}

function handleEnter(e) {
  if (e.key === "Enter") {
    search();
  }
}

function toggleFiltersPanel() {
  const panel = document.getElementById("filtersPanel");
  if (!panel) return;
  panel.hidden = !panel.hidden;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec) {
  const bps = Math.max(0, Number(bytesPerSec) || 0);
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function loadFavorites() {
  try {
    return JSON.parse(localStorage.getItem("cinebroad-favorites") || localStorage.getItem("dolphin-favorites") || "[]");
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem("cinebroad-favorites", JSON.stringify(favorites));
}

function favoriteKey(item) {
  return String(item.id || item.tmdbId || item.title).toLowerCase();
}

function isFavorite(item) {
  const key = favoriteKey(item);
  return favorites.some((f) => favoriteKey(f) === key);
}

function toggleFavorite(item) {
  const key = favoriteKey(item);
  const idx = favorites.findIndex((f) => favoriteKey(f) === key);
  if (idx >= 0) {
    favorites.splice(idx, 1);
    saveFavorites();
    showToast("Removed from favorites", item.title, "favorite", "fa-bookmark");
  } else {
    favorites.unshift(item);
    saveFavorites();
    showToast("Added to favorites", item.title, "favorite", "fa-bookmark");
  }
  if (currentPageName === "favorites") renderFavorites();
}

function normalizeTorrentTitle(title) {
  return String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(s\d+e\d+|season\s*\d+|episode\s*\d+|1080p|720p|480p|2160p|4k|x264|x265|h264|h265|web|webrip|webdl|bluray|hdrip|dvdrip|hdtv|torrent|repack|proper|complete|multi|audio|dual|dubbed|subbed|yify|yt)\b/gi, " ")
    .replace(/[._\-\[\]()/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 2 && !/^\d{4}$/.test(word) && !["the", "and", "for", "with", "from", "part", "vol", "of"].includes(word.toLowerCase()))
    .join(" ");
}

const TORRENT_TAG_RE =
  /\b(1080p|720p|2160p|480p|4k|uhd|hdr10?|dv|x264|x265|h264|h265|h\.?264|h\.?265|hevc|avc|aac|ac3|eac3|ddp?5\.?1|ddp|dd|dts|truehd|atmos|opus|flac|bluray|blu-?ray|bdrip|brrip|webrip|web-?dl|webdl|hdrip|dvdrip|hdtv|pdtv|remux|imax|multi|dual[ ._-]?audio|dubbed|subbed|subs?|hindi|english|spanish|french|german|italian|vff|ita|castellano|hin|eng|proper|repack|extended|theatrical|unrated|directors?\s*cut|remastered|hybrid|limited|internal|hc|cam|ts|tc|hdts|hdcam|sample|trailer|complete|season\s*\d+|episode\s*\d+|s\d{1,2}e\d{1,3}|mkv|mp4|avi|mov|yify|yts|rarbg|eztv|ettv|galaxy|sparks|geckos|ntb|dimension|killers|evo|cmrg|psa|ion10|qxr|tigole|flux|casstudio|d3g|mtb|tof|joy|pug|teg|amzn|nf|dsnp|atvp|hulu|hbo|max|web|yt)\b/gi;

function extractCoreTitle(title) {
  const original = String(title || "");
  const year = original.match(/\b((?:19|20)\d{2})\b/)?.[1] || "";
  let cleaned = original
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(TORRENT_TAG_RE, " ")
    .replace(/\b(s\d{1,2}e\d{1,3}|season\s*\d+|episode\s*\d+)\b/gi, " ")
    .replace(/[._\-|/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Prefer everything before the year — release junk after the year is ignored.
  if (year) {
    const beforeYear = cleaned.split(new RegExp(`\\b${year}\\b`))[0].trim();
    if (beforeYear) cleaned = beforeYear;
  }

  const core = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 1)
    .slice(0, 6)
    .join(" ");

  return { core, year, display: cleaned };
}

function cleanDisplayTitle(title) {
  const { display, year } = extractCoreTitle(title);
  const label = display || String(title || "Movie").trim();
  return `${label}${year && !label.includes(year) ? ` ${year}` : ""}`.trim();
}

function getResultType(title) {
  const normalized = String(title || "").toLowerCase();
  // Word boundaries matter — "ATVP" / "hdtv" must not count as "tv" alone.
  if (/\b(s\d{1,2}e\d{1,3}|episodes?|series|seasons?|tv\s*show|tvrip)\b/i.test(normalized)) {
    return "series";
  }
  return "movie";
}

function ratingClass(score) {
  return score >= 70 ? "good" : "mid";
}

function createPosterArt(title) {
  const cleanedTitle = String(title || "Movie").replace(/\s+/g, " ").trim().slice(0, 20);
  const label = cleanedTitle || "Movie";
  const initials = label
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "MV";

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#e50914"/>
          <stop offset="100%" stop-color="#1a1a1a"/>
        </linearGradient>
      </defs>
      <rect width="400" height="600" fill="url(#g)"/>
      <text x="200" y="290" text-anchor="middle" fill="white" font-size="72" font-family="Arial" font-weight="700">${initials}</text>
      <text x="200" y="340" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="22" font-family="Arial">${escapeHtml(label).slice(0, 18)}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function getPosterFromTmdb(item) {
  // Kept for compatibility; prefer resolvePosterUrl which uses the full API chain.
  return resolvePosterUrl(item);
}

async function resolvePosterUrl(item) {
  if (item.poster && /^https?:\/\//i.test(item.poster)) return item.poster;

  const cacheKey = String(item.imdb || item.title || "").toLowerCase();
  if (posterCache.has(cacheKey)) {
    const cached = posterCache.get(cacheKey);
    // Never lock onto placeholder art
    if (cached && !String(cached).startsWith("data:image/svg")) return cached;
  }
  if (posterRequests.has(cacheKey)) return posterRequests.get(cacheKey);

  const searchHint =
    item.searchHint ||
    document.getElementById("searchInput")?.value?.trim() ||
    "";

  const request = (async () => {
    try {
      const posterUrl = await window.api.resolvePoster({
        title: item.title,
        imdb: item.imdb || null,
        searchHint,
      });
      if (posterUrl && /^https?:\/\//i.test(posterUrl)) {
        posterCache.set(cacheKey, posterUrl);
        return posterUrl;
      }
    } catch (error) {
      console.warn("Poster fallback failed:", error);
    }
    // Soft placeholder only — do not cache so we can retry later
    return createPosterArt(item.title);
  })();

  posterRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    posterRequests.delete(cacheKey);
  }
}

function buildMediaCard(item, options = {}) {
  const {
    title,
    year = "",
    typeLabel = "MOVIE",
    rating = null,
    poster = FALLBACK_POSTER,
    onDownload = null,
    showFavorite = true,
  } = { ...item, ...options };

  const card = document.createElement("article");
  card.className = "media-card";
  // B3 — badges need the identity to batch-load language availability.
  if (item.tmdbId) card.dataset.tmdbId = String(item.tmdbId);
  card.dataset.mediaType = item.mediaType || (typeLabel === "SERIES" ? "tv" : "movie");
  if (item.originalLanguage) card.dataset.originalLanguage = String(item.originalLanguage);

  const wrap = document.createElement("div");
  wrap.className = "poster-wrap";

  const img = document.createElement("img");
  img.className = "poster";
  img.alt = title;
  img.src = poster;
  img.loading = "lazy";
  img.onerror = () => {
    img.src = FALLBACK_POSTER;
  };

  const typeBadge = document.createElement("div");
  typeBadge.className = "badge-type";
  typeBadge.textContent = typeLabel;

  wrap.appendChild(img);
  wrap.appendChild(typeBadge);

  if (rating != null && !Number.isNaN(Number(rating))) {
    const score = Math.round(Number(rating));
    const ratingBadge = document.createElement("div");
    ratingBadge.className = `badge-rating ${ratingClass(score)}`;
    ratingBadge.innerHTML = `<span>★</span> ${score}%`;
    wrap.appendChild(ratingBadge);
  }

  const overlay = document.createElement("div");
  overlay.className = "card-actions-overlay";

  if (onDownload) {
    const dlBtn = document.createElement("button");
    dlBtn.className = "overlay-btn";
    dlBtn.type = "button";
    dlBtn.title = "Download";
    dlBtn.innerHTML = '<i class="fas fa-download"></i>';
    dlBtn.onclick = (e) => {
      e.stopPropagation();
      onDownload();
    };
    overlay.appendChild(dlBtn);
  }

  if (showFavorite) {
    const favBtn = document.createElement("button");
    favBtn.className = `overlay-btn fav${isFavorite(item) ? " active" : ""}`;
    favBtn.type = "button";
    favBtn.title = "Favorite";
    favBtn.innerHTML = '<i class="fas fa-bookmark"></i>';
    favBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite({
        id: item.id || item.tmdbId || title,
        title,
        poster,
        year,
        typeLabel,
        rating,
        mediaType: item.mediaType || (typeLabel === "SERIES" ? "tv" : "movie"),
      });
      favBtn.classList.toggle("active", isFavorite({ id: item.id || item.tmdbId || title, title }));
    };
    overlay.appendChild(favBtn);
  }

  wrap.appendChild(overlay);

  const titleEl = document.createElement("div");
  titleEl.className = "card-title";
  titleEl.title = title;
  titleEl.textContent = title;

  const metaEl = document.createElement("div");
  metaEl.className = "card-meta";
  const kind = typeLabel === "SERIES" ? "TV Show" : "Movie";
  metaEl.textContent = year ? `${year} • ${kind}` : kind;

  card.appendChild(wrap);
  card.appendChild(titleEl);
  card.appendChild(metaEl);
  renderLanguageBadges(card, { languages: [], partsCount: 0 });
  return { card, img };
}

async function fetchTmdbByYear(year, mediaType = "movie", limit = ROW_LIMIT, page = 1) {
  if (mediaType === "movie" && window.api.getMoviesByYear) {
    const payload = await window.api.getMoviesByYear({
      year,
      limit,
      page,
      sort: "popularity.desc",
    });
    return {
      items: payload?.items || [],
      page: payload?.page || page,
      totalPages: payload?.totalPages || 1,
      fromCache: Boolean(payload?.fromCache),
    };
  }

  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY is missing from .env");

  const url =
    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}` +
    `&language=en-US&sort_by=popularity.desc` +
    `&primary_release_date.gte=${year}-01-01&primary_release_date.lte=${year}-12-31` +
    `&vote_count.gte=1&page=${page}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDb ${year} failed: ${response.status}`);
  const data = await response.json();

  const items = (data.results || [])
    .filter((item) => item.poster_path)
    .slice(0, limit)
    .map((item) => ({
      id: `tmdb-movie-${item.id}-p${page}`,
      tmdbId: item.id,
      title: item.title || item.name,
      year: String(item.release_date || year).slice(0, 4) || String(year),
      typeLabel: "MOVIE",
      mediaType: "movie",
      rating: (item.vote_average || 0) * 10,
      poster: `https://image.tmdb.org/t/p/w500${item.poster_path}`,
    }));

  return { items, page: data.page || page, totalPages: data.total_pages || 1 };
}

async function fetchTmdbTrending(page = 1) {
  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY is missing from .env");

  const url = `https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_API_KEY}&page=${page}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDb trending failed: ${response.status}`);
  const data = await response.json();
  const items = (data.results || [])
    .filter((item) => item.poster_path)
    .slice(0, ROW_LIMIT)
    .map((item) => ({
      id: `tmdb-${item.id}-p${page}`,
      tmdbId: item.id,
      title: item.title || item.name,
      year: String(item.release_date || "").slice(0, 4),
      typeLabel: "MOVIE",
      mediaType: "movie",
      rating: (item.vote_average || 0) * 10,
      poster: `https://image.tmdb.org/t/p/w500${item.poster_path}`,
    }));

  return { items, page: data.page || page, totalPages: data.total_pages || 1 };
}

function appendItemsToGrid(grid, items, { clear = false, scope = "home" } = {}) {
  if (!grid) return;
  if (clear) {
    grid.innerHTML = "";
    resetShownKeys(scope);
  }

  const uniqueItems = dedupeItems(items, scope);
  if (!uniqueItems.length && clear) {
    grid.innerHTML = `<div class="empty-state"><i class="fas fa-film"></i><p>No titles found</p></div>`;
    return;
  }
  // Drop the stale "No titles found" placeholder once real items arrive.
  if (uniqueItems.length) grid.querySelector(".empty-state")?.remove();

  uniqueItems.forEach((item) => {
    const { card } = buildMediaCard(item, {
      onDownload: () =>
        downloadByTitle(item.title, item.year, {
          tmdbId: item.tmdbId,
          mediaType: item.mediaType || (item.typeLabel === "SERIES" ? "tv" : "movie"),
        }),
    });
    grid.appendChild(card);
  });
}

function renderItemsIntoGrid(grid, items, scope = "home") {
  appendItemsToGrid(grid, items, { clear: true, scope });
}

function renderItemsIntoRow(rowEl, items, scope = "movies") {
  if (!rowEl) return;
  rowEl.innerHTML = "";
  const uniqueItems = dedupeItems(items, scope).slice(0, ROW_LIMIT);
  if (!uniqueItems.length) {
    rowEl.innerHTML = `<div class="row-loading">No titles found for this row</div>`;
    return;
  }
  uniqueItems.forEach((item) => rowEl.appendChild(buildRowCard(rowEl, item)));
}

function buildRowCard(row, item) {
  if (row?._kind === "tv" || item.mediaType === "tv" || item.typeLabel === "SERIES") {
    return buildTvShowCard(item);
  }
  const { card } = buildMediaCard(item, {
    onDownload: () =>
      downloadByTitle(item.title, item.year, {
        tmdbId: item.tmdbId,
        mediaType: item.mediaType || (item.typeLabel === "SERIES" ? "tv" : "movie"),
      }),
  });
  return card;
}

function buildYearRowShell(year, page = 1) {
  const wrap = document.createElement("section");
  wrap.className = "year-row";
  wrap.dataset.year = String(year);
  wrap.dataset.page = String(page);
  wrap.innerHTML = `
    <div class="section-head year-row-head">
      <span class="section-accent"></span>
      <h2>${page > 1 ? `${year} · Best rated · p${page}` : `${year} · Best rated`}</h2>
      <div class="row-slider-controls">
        <button class="row-slider-btn" data-row-action="prev" type="button" title="Previous movies" disabled>
          <i class="fas fa-chevron-left"></i>
        </button>
        <button class="row-slider-btn" data-row-action="next" type="button" title="Next movies" disabled>
          <i class="fas fa-chevron-right"></i>
        </button>
      </div>
    </div>
    <div class="poster-row-viewport">
      <div class="poster-row" id="moviesRow${year}-p${page}">
        <div class="row-loading"><div class="dots-loader sm"><span></span><span></span><span></span></div></div>
      </div>
    </div>
  `;
  wrap.querySelector('[data-row-action="prev"]').onclick = () => moveYearRow(wrap, -(Number(wrap.dataset.step) || 3));
  wrap.querySelector('[data-row-action="next"]').onclick = () => moveYearRow(wrap, Number(wrap.dataset.step) || 3);
  wrap.dataset.step = "3";
  return wrap;
}

function buildTvSliderShell(category) {
  const wrap = document.createElement("section");
  const visible = category.featured ? TV_FEATURED_SLIDER_VISIBLE : TV_SLIDER_VISIBLE;
  wrap.className = `year-row tv-slider ${category.featured ? "tv-featured-slider" : "tv-year-slider"}`;
  wrap.dataset.category = category.key;
  wrap.dataset.visible = String(visible);
  wrap.dataset.step = String(TV_SLIDER_STEP);
  wrap.innerHTML = `
    <div class="section-head year-row-head">
      <span class="section-accent"></span>
      <h2>${escapeHtml(category.label)}</h2>
      <div class="row-slider-controls">
        <button class="row-slider-btn" data-row-action="prev" type="button" title="Previous shows" disabled>
          <i class="fas fa-chevron-left"></i>
        </button>
        <button class="row-slider-btn" data-row-action="next" type="button" title="Next shows" disabled>
          <i class="fas fa-chevron-right"></i>
        </button>
      </div>
    </div>
    <div class="poster-row-viewport">
      <div class="poster-row" id="tvSlider-${category.key}">
        <div class="row-loading"><div class="dots-loader sm"><span></span><span></span><span></span></div></div>
      </div>
    </div>
  `;
  wrap.querySelector('[data-row-action="prev"]').onclick = () => moveYearRow(wrap, -TV_SLIDER_STEP);
  wrap.querySelector('[data-row-action="next"]').onclick = () => moveYearRow(wrap, TV_SLIDER_STEP);
  return wrap;
}

async function loadYearRow(year, page = 1) {
  const payload = await window.api.getMoviesByYear({
    year,
    limit: ROW_LIMIT,
    page,
    sort: "vote_average.desc",
  });
  if (payload?.error) throw new Error(payload.error);
  const row = document.getElementById(`moviesRow${year}-p${page}`);
  if (!row) return;
  const state = infiniteState.movies;
  if (payload?.dbFallback && page > 1) {
    // Offline/cache-only: no trustworthy deeper page → stop deeper rounds here.
    state.yearPages[year] = 1;
    return;
  }
  state.yearPages[year] = Math.max(state.yearPages[year] || 0, Number(payload?.totalPages) || 1);
  row._year = year;
  row._page = payload?.page || page;
  row._totalPages = payload?.totalPages || 1;
  row._offset = 0;
  row._kind = "movies";
  row._sort = "vote_average.desc";
  renderItemsIntoRow(row, payload?.items || []);
  updateYearRowControls(row.closest(".year-row"));
}

function getYearRowVisibleCount(row) {
  const shell = row?.closest(".year-row");
  const forced = Number(shell?.dataset.visible) || 0;
  if (forced > 0) return forced;
  const card = row?.querySelector(".media-card");
  const viewport = row?.parentElement;
  if (!card || !viewport) return 1;
  return Math.max(1, Math.floor((viewport.clientWidth + 14) / (card.getBoundingClientRect().width + 14)));
}

function updateYearRowControls(rowShell) {
  if (!rowShell) return;
  const row = rowShell.querySelector(".poster-row");
  const cards = row?.querySelectorAll(".media-card").length || 0;
  const visible = getYearRowVisibleCount(row);
  const maxOffset = Math.max(0, cards - visible);
  const offset = Math.min(row?._offset || 0, maxOffset);
  if (row) row._offset = offset;
  const prev = rowShell.querySelector('[data-row-action="prev"]');
  const next = rowShell.querySelector('[data-row-action="next"]');
  if (prev) prev.disabled = offset <= 0;
  if (next) next.disabled = offset >= maxOffset && (row?._page || 1) >= (row?._totalPages || 1);
}

async function fetchSliderPage(row, page) {
  if (row._kind === "tv") {
    return window.api.getTvShowsByGenre({
      genreId: row._genreId == null ? null : row._genreId,
      year: row._year || null,
      sort: row._sort || null,
      page,
      limit: ROW_LIMIT,
    });
  }
  return window.api.getMoviesByYear({
    year: row._year,
    limit: ROW_LIMIT,
    page,
    sort: row._sort || "vote_average.desc",
  });
}

async function moveYearRow(rowShell, direction) {
  const row = rowShell?.querySelector(".poster-row");
  if (!row || row._loading) return;

  const step = Math.abs(Number(rowShell.dataset.step) || direction || 3) * Math.sign(direction || 1);
  const visible = getYearRowVisibleCount(row);
  const cards = row.querySelectorAll(".media-card").length;
  const maxOffset = Math.max(0, cards - visible);
  let nextOffset = Math.max(0, Math.min(maxOffset, (row._offset || 0) + step));

  if (step > 0 && nextOffset === (row._offset || 0) && (row._page || 1) < (row._totalPages || 1)) {
    row._loading = true;
    try {
      const payload = await fetchSliderPage(row, (row._page || 1) + 1);
      row._page = payload?.page || (row._page || 1) + 1;
      row._totalPages = payload?.totalPages || row._totalPages;
      const scope = row._kind === "tv" ? "tvShows" : "movies";
      const newItems = dedupeItems(payload?.items || [], scope);
      newItems.forEach((item) => row.appendChild(buildRowCard(row, item)));
    } finally {
      row._loading = false;
    }
    const updatedCards = row.querySelectorAll(".media-card").length;
    nextOffset = Math.min(Math.max(0, updatedCards - getYearRowVisibleCount(row)), (row._offset || 0) + step);
  }

  row._offset = Math.max(0, nextOffset);
  const card = row.querySelector(".media-card");
  const gap = 14;
  const stepPx = card ? card.getBoundingClientRect().width + gap : 0;
  row.style.transform = `translateX(-${row._offset * stepPx}px)`;
  row.style.transition = "transform 320ms ease";
  updateYearRowControls(rowShell);
}

async function loadMoviesYearCatalog() {
  const container = document.getElementById("moviesYearRows");
  if (!container) return;

  resetShownKeys("movies");
  const currentYear = new Date().getFullYear();
  infiniteState.movies.nextYear = currentYear;
  infiniteState.movies.endYear = MOVIES_YEAR_FLOOR;
  infiniteState.movies.round = 1;
  infiniteState.movies.yearPages = {};
  infiniteState.movies.loading = false;
  infiniteState.movies.done = false;
  container.innerHTML = "";
  setScrollStatus("moviesScrollStatus", "Scroll for older years");
  await loadMoreMovieYears();
}

async function loadMoreMovieYears() {
  const state = infiniteState.movies;
  if (state.loading || state.done || state.nextYear == null || state.endYear == null) return;
  state.loading = true;
  setInlineLoader("moviesScrollStatus", true);

  const container = document.getElementById("moviesYearRows");
  const currentYear = new Date().getFullYear();
  let loaded = 0;

  try {
    for (;;) {
      // Open rows for the current "best rated" pass over every year.
      while (loaded < YEARS_PER_BATCH && state.nextYear >= state.endYear) {
        const year = state.nextYear;
        const page = state.round;
        state.nextYear -= 1;
        if (page > 1 && (state.yearPages[year] ?? 0) < page) continue;
        if (document.getElementById(`moviesRow${year}-p${page}`)) continue;

        const shell = buildYearRowShell(year, page);
        container.appendChild(shell);
        try {
          await loadYearRow(year, page);
        } catch (error) {
          const row = document.getElementById(`moviesRow${year}-p${page}`);
          if (row) row.innerHTML = `<div class="row-loading">${escapeHtml(error.message)}</div>`;
        }
        const liveRow = document.getElementById(`moviesRow${year}-p${page}`);
        if (page > 1 && (!liveRow || !liveRow.querySelector(".media-card"))) shell.remove();
        loaded += 1;
      }

      if (state.nextYear >= state.endYear) break; // more years remain → next scroll

      // This pass finished → start a deeper pass over years that still have
      // pages left; only when no year has pages left is everything loaded.
      const nextRound = state.round + 1;
      const anyNext = Object.values(state.yearPages).some((pages) => pages >= nextRound);
      if (nextRound <= MOVIES_MAX_ROUNDS && anyNext) {
        state.round = nextRound;
        state.nextYear = currentYear;
        continue;
      }
      state.done = true;
      setScrollStatus("moviesScrollStatus", "All years loaded");
      break;
    }

    if (!state.done) {
      setScrollStatus("moviesScrollStatus", state.round > 1 ? "Scroll for more movies" : "Scroll for older years");
    }
  } finally {
    state.loading = false;
  }
}

async function loadMoreHomeMovies() {
  const state = infiniteState.home;
  if (state.loading || state.done) return;

  state.loading = true;
  setInlineLoader("homeScrollStatus", true);

  const grid = document.getElementById("homeGrid");
  let added = 0;
  let attempts = 0;

  try {
    while (added < HOME_BATCH && attempts < 60 && !state.done) {
      attempts += 1;

      if (state.source === "years") {
        // Phase 2: year-by-year top rated feed (runs until the year floor).
        if (state.year == null) {
          state.year = new Date().getFullYear();
          state.yearPage = 1;
        }
        if (state.year < HOME_YEAR_FLOOR) {
          state.done = true;
          break;
        }
        const payload = await window.api.getMoviesByYear({
          year: state.year,
          page: state.yearPage,
          limit: 32,
          sort: "vote_average.desc",
        });
        if (payload?.error) {
          // Transient failure: show it, keep state so the next scroll retries.
          setScrollStatus("homeScrollStatus", payload.error);
          return;
        }
        if (payload?.dbFallback) {
          // Cache-only fallback cannot paginate safely → stop cleanly.
          state.done = true;
          break;
        }
        const items = payload?.items || [];
        appendItemsToGrid(grid, items, { scope: "home" });
        added += items.length;
        const yearTotalPages = Math.min(Number(payload?.totalPages) || 1, HOME_YEAR_MAX_PAGES);
        if (state.yearPage >= yearTotalPages) {
          state.year -= 1;
          state.yearPage = 1;
        } else {
          state.yearPage += 1;
        }
        continue;
      }

      // Phase 1: popular/top-rated mix until its real last page.
      const mixCap = Math.min(Number(state.totalPages) || 1, HOME_MIX_MAX_PAGE);
      if (state.everSucceeded && state.page >= mixCap) {
        state.source = "years";
        continue;
      }
      const requestPage = state.everSucceeded ? state.page + 1 : state.page;
      const payload = await window.api.getPopularMovies({ page: requestPage, limit: 32 });
      if (payload?.error) {
        setScrollStatus("homeScrollStatus", payload.error);
        return;
      }
      if (payload?.dbFallback) {
        state.done = true;
        break;
      }
      state.page = Number(payload?.page) || requestPage;
      state.totalPages = Math.min(Number(payload?.totalPages) || state.totalPages, HOME_MIX_MAX_PAGE);
      state.everSucceeded = true;
      const items = payload?.items || [];
      appendItemsToGrid(grid, items, { scope: "home" });
      added += items.length;
    }

    if (state.done) setScrollStatus("homeScrollStatus", "You're all caught up");
    else setScrollStatus("homeScrollStatus", "Scroll for more movies");
  } catch (error) {
    setScrollStatus("homeScrollStatus", error.message || "Failed to load more");
  } finally {
    state.loading = false;
  }
}

function buildTvShowCard(show) {
  const { card } = buildMediaCard(show, { showFavorite: false });
  addTvViewAction(card, show);
  card.classList.add("tv-show-card");
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    openTvDetails(show);
  });
  return card;
}

function addTvViewAction(card, show) {
  const overlay = card.querySelector(".card-actions-overlay");
  if (!overlay) return;
  const viewButton = document.createElement("button");
  viewButton.className = "overlay-btn";
  viewButton.type = "button";
  viewButton.title = "View seasons and episodes";
  viewButton.innerHTML = '<i class="fas fa-eye"></i>';
  viewButton.onclick = (event) => {
    event.stopPropagation();
    openTvDetails(show);
  };
  overlay.appendChild(viewButton);
}

function appendTvShows(items, clear = false) {
  const grid = document.getElementById("tvShowsGrid");
  if (!grid) return;
  if (clear) {
    grid.innerHTML = "";
    resetShownKeys("tvShows");
  }
  dedupeItems(items, "tvShows").forEach((show) => grid.appendChild(buildTvShowCard(show)));
}

function updateTvSearchClearButton() {
  const input = document.getElementById("tvSearchInput");
  const clearBtn = document.getElementById("tvSearchClearBtn");
  if (clearBtn) clearBtn.style.display = input?.value ? "inline-flex" : "none";
}

function showTvShowsEmptyMessage(message, icon = "fa-tv") {
  const empty = document.getElementById("tvShowsEmpty");
  if (!empty) return;
  empty.innerHTML = `<i class="fas ${icon}"></i><p>${escapeHtml(message)}</p>`;
  empty.hidden = false;
}

function showTvShowsEmptyState(query = "") {
  const term = String(query || "").trim();
  showTvShowsEmptyMessage(term ? `No TV shows found for “${term}”` : "No TV shows found");
}

function hideTvShowsEmptyState() {
  const empty = document.getElementById("tvShowsEmpty");
  if (empty) empty.hidden = true;
}

function handleTvSearchEnter(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  window.clearTimeout(tvSearchDebounceTimer);
  const input = document.getElementById("tvSearchInput");
  infiniteState.tvShows.query = input ? input.value.trim() : "";
  updateTvSearchClearButton();
  loadTvShowsPage(true);
}

function clearTvSearch() {
  window.clearTimeout(tvSearchDebounceTimer);
  const input = document.getElementById("tvSearchInput");
  if (input) input.value = "";
  updateTvSearchClearButton();
  infiniteState.tvShows.query = "";
  if (input) input.focus();
  loadTvShowsPage(true);
}

// --- TV SHOWS: category shelves (exactly 2 rows per category) ---
function setTvShowsView(mode) {
  const categoriesEl = document.getElementById("tvShowCategories");
  const resultsEl = document.getElementById("tvShowsGrid");
  const searching = mode === "search";
  if (categoriesEl) categoriesEl.hidden = searching;
  if (resultsEl) resultsEl.hidden = !searching;
}

// Match the poster grid: ~150px columns with a 14px gutter so each shelf is exactly 2 rows.
function getTvCategoryColumns() {
  const container = document.getElementById("tvShowCategories");
  const width = container?.clientWidth || 0;
  if (!width) return 5;
  return Math.max(2, Math.floor((width + TV_CATEGORY_GAP) / (TV_CATEGORY_CARD_WIDTH + TV_CATEGORY_GAP)));
}

function buildTvCategoryShell(category, columns) {
  const section = document.createElement("section");
  section.className = "tv-category";
  section.dataset.category = category.key;
  section.innerHTML = `
    <div class="section-head tv-category-head">
      <span class="section-accent"></span>
      <h2>${escapeHtml(category.label)}</h2>
    </div>
    <div class="tv-category-grid" id="tvCatGrid-${category.key}">
      <div class="row-loading"><div class="dots-loader sm"><span></span><span></span><span></span></div></div>
    </div>
  `;
  const grid = section.querySelector(".tv-category-grid");
  if (grid) grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  return section;
}

function mergeTvCategoryItems(groups) {
  const seen = new Set();
  const merged = [];
  groups.flat().forEach((item) => {
    const key = movieIdentityKey(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

async function fetchTvCategoryPayload(category, page, limit, requestId) {
  const payload = await window.api.getTvShowsByGenre({
    genreId: category.genreId == null ? null : category.genreId,
    year: category.year || null,
    sort: category.sort || null,
    page,
    limit,
  });
  if (requestId !== tvShowsRequestId) return null;
  if (payload?.error) {
    if (page === 1) throw new Error(payload.error);
    console.warn("TV category page failed:", payload.error);
    return { items: [], totalPages: null };
  }
  return { items: payload?.items || [], totalPages: Number(payload?.totalPages) || null };
}

async function renderTvSliderSection(category, requestId) {
  const container = document.getElementById("tvShowCategories");
  if (!container) return { cards: 0, totalPages: null, topupUsed: false };
  const rowId = `tvSlider-${category.key}`;
  if (document.getElementById(rowId)) return { cards: 0, totalPages: null, topupUsed: false };

  container.appendChild(buildTvSliderShell(category));
  const startPage = category.startPage || 1;
  try {
    const first = await fetchTvCategoryPayload(category, startPage, ROW_LIMIT, requestId);
    if (!first) return { cards: 0, totalPages: null, topupUsed: false };
    if (requestId !== tvShowsRequestId) return { cards: 0, totalPages: first.totalPages, topupUsed: false };
    const row = document.getElementById(rowId);
    if (!row) return { cards: 0, totalPages: first.totalPages, topupUsed: false };
    row._kind = "tv";
    row._year = category.year || null;
    row._genreId = category.genreId == null ? null : category.genreId;
    row._sort = category.sort || "vote_average.desc";
    row._page = startPage;
    row._totalPages = first.totalPages || 1;
    row._offset = 0;
    renderItemsIntoRow(row, first.items || [], "tvShows");
    updateYearRowControls(row.closest(".year-row"));
    return { cards: row.querySelectorAll(".media-card").length, totalPages: row._totalPages, topupUsed: false };
  } catch (error) {
    document.getElementById(rowId)?.closest(".year-row")?.remove();
    throw error;
  }
}

async function renderTvCategorySection(category, columns, requestId) {
  const container = document.getElementById("tvShowCategories");
  if (!container) return { cards: 0, totalPages: null, topupUsed: false };
  const gridId = `tvCatGrid-${category.key}`;
  if (document.getElementById(gridId)) return { cards: 0, totalPages: null, topupUsed: false };

  container.appendChild(buildTvCategoryShell(category, columns));
  const grid = document.getElementById(gridId);
  const needed = columns * 2; // exactly two rows
  const startPage = category.startPage || 1;

  try {
    const first = await fetchTvCategoryPayload(category, startPage, needed, requestId);
    if (!first) return { cards: 0, totalPages: null, topupUsed: false };
    let items = first.items;
    let totalPages = first.totalPages;
    let topupUsed = false;
    if (first.items.length < needed) {
      // Top up from the next page so both rows stay full.
      topupUsed = true;
      const second = await fetchTvCategoryPayload(category, startPage + 1, needed, requestId);
      if (second) {
        items = mergeTvCategoryItems([items, second.items]);
        if (second.totalPages != null) totalPages = Math.max(totalPages || 0, second.totalPages);
      }
    }
    if (requestId !== tvShowsRequestId) return { cards: 0, totalPages, topupUsed };
    const liveGrid = document.getElementById(gridId);
    if (!liveGrid) return { cards: 0, totalPages, topupUsed };

    liveGrid.innerHTML = "";
    const unique = items.slice(0, needed);
    unique.forEach((show) => liveGrid.appendChild(buildTvShowCard(show)));
    if (!unique.length) {
      liveGrid.innerHTML = '<div class="row-loading">No TV shows in this category right now</div>';
    }
    return { cards: unique.length, totalPages, topupUsed };
  } catch (error) {
    // Drop the empty shelf so the page keeps a clean look and surface the error below.
    document.getElementById(gridId)?.closest(".tv-category")?.remove();
    throw error;
  }
}

async function loadTvCategories(clear = true) {
  const state = infiniteState.tvShows;
  // Infinite scroll appends wait for the in-flight batch; a fresh load supersedes it.
  if (state.loading && !clear) return;

  const container = document.getElementById("tvShowCategories");
  if (!container) return;

  setTvShowsView("categories");
  const requestId = ++tvShowsRequestId;
  state.loading = true;

  if (clear) {
    container.innerHTML = "";
    state.categories = [];
    state.categoryIndex = 0;
    state.columns = 0;
    state.done = false;
    state.shelfYear = null;
    state.yearCursor = {};
    state.yearPages = {};
    hideTvShowsEmptyState();
  }

  setInlineLoader("tvShowsScrollStatus", true);
  const currentYear = new Date().getFullYear();
  let loaded = 0;
  let attempts = 0;
  let passes = 0;

  try {
    if (!state.categories.length) {
      const categories = await window.api.getTvCategories();
      if (requestId !== tvShowsRequestId) return;
      const baseCategories = Array.isArray(categories)
        ? categories
          .filter((category) => category?.key && category?.label)
          .map((category) => category.key === "trending" ? { ...category, slider: true, featured: true } : category)
        : [];
      if (!baseCategories.length) throw new Error("TV show categories are unavailable right now");
      // Pinned shelves first: latest + top rated of the current year.
      const tvYear = currentYear;
      state.categories = [
        {
          key: `tv-latest-${tvYear}`,
          label: `Latest TV Shows · ${tvYear}`,
          genreId: null,
          year: tvYear,
          sort: "first_air_date.desc",
          slider: true,
          featured: true,
        },
        {
          key: `tv-top-${tvYear}`,
          label: `Top Rated TV Shows · ${tvYear}`,
          genreId: null,
          year: tvYear,
          sort: "vote_average.desc",
          slider: true,
          featured: true,
        },
        ...baseCategories,
      ];
    }

    const columns = getTvCategoryColumns();
    state.columns = columns;

    while (loaded < TV_CATEGORIES_PER_BATCH && attempts < 30) {
      attempts += 1;

      // Phase 1: fixed genre / trending shelves.
      if (state.categoryIndex < state.categories.length) {
        const category = state.categories[state.categoryIndex];
        state.categoryIndex += 1;
        loaded += 1;
        if (category.slider) {
          await renderTvSliderSection(category, requestId);
        } else {
          await renderTvCategorySection(category, columns, requestId);
        }
        if (requestId !== tvShowsRequestId) return;
        continue;
      }

      // Phase 2: year-by-year "popular TV shows" shelves (keeps going deep).
      if (state.shelfYear == null) state.shelfYear = currentYear;

      let shelf = null;
      while (state.shelfYear >= TV_YEAR_FLOOR) {
        const year = state.shelfYear;
        const cursor = state.yearCursor[year] || 1;
        const pages = state.yearPages[year];
        state.shelfYear -= 1;
        if (pages !== undefined && cursor > pages) continue;
        shelf = {
          key: `tv-year-${year}-p${cursor}`,
          label: cursor > 1 ? `${year} · Top Rated TV Shows · p${cursor}` : `${year} · Top Rated TV Shows`,
          genreId: null,
          year,
          startPage: cursor,
          sort: "vote_average.desc",
          slider: true,
          featured: true,
        };
        break;
      }

      if (!shelf) {
        // This year pass finished → does any year still have pages left?
        const hasNext = (() => {
          for (let year = currentYear; year >= TV_YEAR_FLOOR; year -= 1) {
            const cursor = state.yearCursor[year] || 1;
            const pages = state.yearPages[year];
            if (pages === undefined || cursor <= pages) return true;
          }
          return false;
        })();
        if (hasNext && passes < 1) {
          passes += 1;
          state.shelfYear = currentYear;
          continue;
        }
        if (hasNext) break; // leave remaining pages for the next scroll
        state.done = true;
        break;
      }

      loaded += 1;
      try {
        const info = await renderTvSliderSection(shelf, requestId);
        if (requestId !== tvShowsRequestId) return;
        const year = shelf.year;
        state.yearPages[year] = Math.max(state.yearPages[year] || 0, Number(info?.totalPages) || 0);
        state.yearCursor[year] = shelf.startPage + 1;
        if (shelf.year != null && info && info.cards === 0) {
          document.getElementById(`tvSlider-${shelf.key}`)?.closest(".year-row")?.remove();
        }
      } catch (error) {
        if (requestId !== tvShowsRequestId) return;
        state.yearPages[shelf.year] = 0; // failed → skip this year for the session
        console.warn("TV year shelf failed:", error.message);
      }
    }

    if (!container.querySelector(".media-card")) showTvShowsEmptyState(state.query);
    setScrollStatus(
      "tvShowsScrollStatus",
      state.done ? "You've explored every TV show category" : "Scroll for more TV show categories"
    );
  } catch (error) {
    if (requestId !== tvShowsRequestId) return;
    setScrollStatus("tvShowsScrollStatus", error.message || "TV shows failed to load");
    if (!container.querySelector(".tv-category")) {
      showTvShowsEmptyMessage(error.message || "TV shows failed to load", "fa-triangle-exclamation");
    }
    state.done = true;
  } finally {
    if (requestId === tvShowsRequestId) state.loading = false;
  }
}

async function loadTvShowSearch(clear = true) {
  const state = infiniteState.tvShows;
  if (state.loading && !clear) return;

  const requestId = ++tvShowsRequestId;
  state.loading = true;
  if (clear) {
    state.page = 1;
    state.totalPages = null;
    state.done = false;
    appendTvShows([], true);
    hideTvShowsEmptyState();
  }
  setTvShowsView("search");
  setInlineLoader("tvShowsScrollStatus", true);
  try {
    const requestPage = clear ? 1 : state.page + 1;
    const payload = await window.api.getTvShows({
      page: requestPage,
      limit: 16,
      query: state.query || "",
    });
    if (requestId !== tvShowsRequestId) return;

    state.page = Number(payload?.page) || requestPage;
    if (Number(payload?.totalPages) > 0) state.totalPages = Number(payload.totalPages);
    appendTvShows(payload?.items || [], false);
    const totalPages = Number(state.totalPages) > 0 ? Number(state.totalPages) : null;
    state.done = totalPages != null && state.page >= totalPages;

    const grid = document.getElementById("tvShowsGrid");
    if (grid && !grid.querySelector(".media-card") && !payload?.error) {
      showTvShowsEmptyState(state.query);
    }
    setScrollStatus(
      "tvShowsScrollStatus",
      payload?.error || (state.done ? "End of TV shows" : "Scroll for more TV shows")
    );
  } catch (error) {
    if (requestId !== tvShowsRequestId) return;
    setScrollStatus("tvShowsScrollStatus", error.message || "TV shows failed to load");
  } finally {
    if (requestId === tvShowsRequestId) state.loading = false;
  }
}

async function loadTvShowsPage(clear = true) {
  const state = infiniteState.tvShows;
  const query = String(state.query || "").trim();
  if (query) {
    state.mode = "search";
    await loadTvShowSearch(clear);
    return;
  }
  state.mode = "categories";
  await loadTvCategories(clear);
}

async function loadMoreTvShows() {
  const state = infiniteState.tvShows;
  if (state.loading || state.done) return;
  if (state.mode === "search") {
    await loadTvShowSearch(false);
    return;
  }
  await loadTvCategories(false);
}

const tvDetailsState = { show: null, season: null, episodes: [] };

function getTvLanguageLabel() {
  const value = document.getElementById("tvLanguageSelect")?.value || "hindi";
  if (value === "hindi") return "Hindi Dubbed";
  if (value === "english") return "English";
  return "Original";
}

function getTvLanguageQuery() {
  const value = document.getElementById("tvLanguageSelect")?.value || "hindi";
  if (value === "hindi") return "hindi dubbed";
  if (value === "english") return "english";
  return "";
}

function padShowCode(prefix, number) {
  return `${prefix}${String(number).padStart(2, "0")}`;
}

function episodeReleaseYear(airDate, fallbackYear = "") {
  const year = String(airDate || "").slice(0, 4);
  if (/^\d{4}$/.test(year)) return year;
  return String(fallbackYear || "").slice(0, 4);
}

function closeTvDetails() {
  const modal = document.getElementById("tvDetailsModal");
  if (modal) modal.hidden = true;
  tvDetailsState.show = null;
  tvDetailsState.season = null;
  tvDetailsState.episodes = [];
}

async function openTvDetails(show) {
  const modal = document.getElementById("tvDetailsModal");
  if (!modal) return;
  tvDetailsState.show = show;
  tvDetailsState.season = null;
  modal.hidden = false;
  const langSelect = document.getElementById("tvLanguageSelect");
  if (langSelect && !langSelect.value) langSelect.value = "hindi";
  document.getElementById("tvDetailsPoster").src = show.poster || FALLBACK_POSTER;
  document.getElementById("tvDetailsTitle").textContent = show.title;
  document.getElementById("tvDetailsMeta").textContent = show.year || "";
  document.getElementById("tvSeasonTabs").innerHTML = "";
  document.getElementById("tvEpisodes").innerHTML = '<div class="row-loading">Loading seasons…</div>';
  try {
    const details = await window.api.getTvDetails({ id: show.tmdbId });
    if (details?.error) throw new Error(details.error);
    tvDetailsState.show = { ...show, ...details };
    if (details.poster) document.getElementById("tvDetailsPoster").src = details.poster;
    document.getElementById("tvDetailsTitle").textContent = details.title || show.title;
    document.getElementById("tvDetailsMeta").textContent = details.year || show.year || "";
    // B3 — language availability detected from saved torrents.
    if (window.api.getMediaLanguages) {
      try {
        const langMap = await window.api.getMediaLanguages([{ tmdbId: show.tmdbId, mediaType: "tv" }]);
        const info = langMap?.[`tv:${show.tmdbId}`];
        if (info?.languages?.length) {
          document.getElementById("tvDetailsMeta").textContent = [
            details.year || show.year || "",
            `${info.languages.join(" + ")} available`,
          ]
            .filter(Boolean)
            .join(" • ");
        }
      } catch {
        // badge is optional — modal works without it
      }
    }
    renderTvSeasonTabs(details.seasons || []);
    if (details.seasons?.length) selectTvSeason(details.seasons[0].number);
    else document.getElementById("tvEpisodes").innerHTML = '<div class="row-loading">No seasons available</div>';
  } catch (error) {
    document.getElementById("tvEpisodes").innerHTML = `<div class="row-loading">${escapeHtml(error.message)}</div>`;
  }
}

function renderTvSeasonTabs(seasons) {
  const tabs = document.getElementById("tvSeasonTabs");
  tabs.innerHTML = "";
  seasons.forEach((season) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tv-season-tab";
    button.textContent = padShowCode("S", season.number);
    button.title = season.title || `Season ${season.number}`;
    button.onclick = () => selectTvSeason(season.number);
    button.dataset.season = season.number;
    tabs.appendChild(button);
  });
}

async function selectTvSeason(season) {
  const show = tvDetailsState.show;
  if (!show) return;
  tvDetailsState.season = season;
  document.querySelectorAll(".tv-season-tab").forEach((tab) => tab.classList.toggle("active", Number(tab.dataset.season) === season));
  const list = document.getElementById("tvEpisodes");
  list.innerHTML = '<div class="row-loading">Loading episodes…</div>';
  const payload = await window.api.getTvDetails({ id: show.id || show.tmdbId, season });
  if (payload?.error) {
    list.innerHTML = `<div class="row-loading">${escapeHtml(payload.error)}</div>`;
    return;
  }
  tvDetailsState.episodes = payload.episodes || [];
  renderTvEpisodes();
}

function findTvEpisodeDownload(showId, season, episode, language) {
  const lang = language || document.getElementById("tvLanguageSelect")?.value || "hindi";
  return [...activeDownloads.values()].find(
    (item) =>
      item.tvShowId === showId &&
      item.season === season &&
      item.episode === episode &&
      (item.language || "hindi") === lang
  );
}

function renderTvEpisodes() {
  const list = document.getElementById("tvEpisodes");
  const show = tvDetailsState.show;
  if (!list || !show) return;
  list.innerHTML = "";
  const language = document.getElementById("tvLanguageSelect")?.value || "hindi";

  if (!tvDetailsState.episodes.length) {
    list.innerHTML = '<div class="row-loading">No episodes in this season</div>';
    return;
  }

  tvDetailsState.episodes.forEach((episode) => {
    const download = findTvEpisodeDownload(show.tmdbId, tvDetailsState.season, episode.number, language);
    const row = document.createElement("div");
    row.className = "tv-episode-row";
    const epCode = padShowCode("EP", episode.number);
    const year = episodeReleaseYear(episode.airDate, show.year);
    let status = "Download";
    if (download?.done) status = "Play";
    else if (download) status = `${Math.round(download.progress || 0)}%`;

    row.innerHTML = `
      <div>
        <strong>${epCode}</strong>
        <span>${escapeHtml(episode.title || "")}</span>
        <small>${escapeHtml(year || "")}</small>
      </div>
      <button type="button" class="tv-episode-action${download?.done ? " is-done" : ""}">${status}</button>
    `;
    const action = row.querySelector("button");
    action.disabled = Boolean(download && !download.done);
    action.onclick = () =>
      download?.done
        ? preview(download.id)
        : downloadTvEpisode(show, tvDetailsState.season, episode);
    list.appendChild(row);
  });
}

function downloadTvEpisode(show, season, episode) {
  if (isOffline) {
    showOfflineMessage();
    return;
  }
  const language = document.getElementById("tvLanguageSelect")?.value || "hindi";
  const languageQuery = getTvLanguageQuery();
  const code = `${padShowCode("S", season)}${padShowCode("E", episode.number)}`;
  const query = [show.title, code, languageQuery].filter(Boolean).join(" ");
  downloadByTitle(query, show.year, {
    tvShowId: show.tmdbId,
    tmdbId: show.tmdbId,
    mediaType: "tv",
    season,
    episode: episode.number,
    episodeTitle: episode.title,
    language,
    episodeKey: `${show.tmdbId}:${code}:${language}`,
    preferLanguage: language,
  });
  renderTvEpisodes();
}

function showSearchIdleState() {
  showingHomeShowcase = false;
  infiniteState.search.mode = "idle";
  infiniteState.search.page = 1;
  infiniteState.search.totalPages = 1;
  infiniteState.search.renderedCount = 0;
  resetShownKeys("search");

  const sectionHead = document.getElementById("searchSectionHead");
  const resultsContainer = document.getElementById("searchResultsContainer");
  const emptyState = document.getElementById("emptyState");
  const resultsGrid = document.getElementById("resultsGrid");
  const filtersPanel = document.getElementById("filtersPanel");

  if (sectionHead) sectionHead.style.display = "none";
  if (resultsContainer) resultsContainer.style.display = "none";
  if (resultsGrid) resultsGrid.innerHTML = "";
  if (filtersPanel) filtersPanel.hidden = false;
  document.getElementById("resultCount").innerText = "";
  setScrollStatus("searchScrollStatus", "");

  if (emptyState) {
    emptyState.style.display = "flex";
    emptyState.className = "empty-state search-idle";
    emptyState.innerHTML =
      '<i class="fas fa-magnifying-glass"></i><p>try to search</p>';
  }
}

async function loadMoreSearchContent() {
  const state = infiniteState.search;
  if (state.loading || !["trending", "results"].includes(state.mode)) return;

  if (state.country && state.country !== "all") {
    if (state.page >= state.totalPages) {
      setScrollStatus("searchScrollStatus", "End of country movies");
      return;
    }
    state.loading = true;
    setInlineLoader("searchScrollStatus", true);
    try {
      const payload = await window.api.discoverTmdb({ country: state.country, page: state.page + 1, limit: 16 });
      state.page = payload?.page || state.page + 1;
      state.totalPages = payload?.totalPages || state.totalPages;
      const query = String(state.query || "").toLowerCase();
      const items = (payload?.items || []).filter((item) => !query || String(item.title || "").toLowerCase().includes(query));
      allSearchResults.push(...items);
      await applyFilters();
      setScrollStatus("searchScrollStatus", state.page >= state.totalPages ? "End of country movies" : "Scroll for more movies");
    } finally {
      state.loading = false;
    }
    return;
  }

  if (state.mode === "trending") {
    if (state.page >= state.totalPages) {
      setScrollStatus("searchScrollStatus", "End of trending movies");
      return;
    }
    state.loading = true;
    setInlineLoader("searchScrollStatus", true);
    try {
      const payload = await window.api.getPopularMovies({ page: state.page + 1, limit: 32 });
      state.page = payload?.page || state.page + 1;
      state.totalPages = payload?.totalPages || state.totalPages;
      allSearchResults.push(...(payload?.items || []));
      const hasActiveFilter = ["languageFilter", "countryFilter", "qualityFilter"].some(
        (id) => (document.getElementById(id)?.value || "all") !== "all"
      );
      if (hasActiveFilter) await applyFilters();
      else appendTmdbSearchCards(payload?.items || []);
      setScrollStatus("searchScrollStatus", state.page >= state.totalPages ? "End of trending movies" : "Scroll for more movies");
    } finally {
      state.loading = false;
    }
    return;
  }

  if (state.page >= state.totalPages) {
    setScrollStatus("searchScrollStatus", "End of results");
    return;
  }
  state.loading = true;
  setInlineLoader("searchScrollStatus", true);
  try {
    const payload = await window.api.searchTmdb({ query: state.query, page: state.page + 1 });
    state.page = payload?.page || state.page + 1;
    state.totalPages = payload?.totalPages || state.totalPages;
    const items = payload?.items || [];
    allSearchResults.push(...items);
    const hasActiveFilter = ["languageFilter", "countryFilter", "qualityFilter"].some(
      (id) => (document.getElementById(id)?.value || "all") !== "all"
    );
    if (hasActiveFilter) await applyFilters();
    else appendTmdbSearchCards(items);
    setScrollStatus(
      "searchScrollStatus",
      state.page >= state.totalPages ? "End of results" : "Scroll for more results"
    );
  } finally {
    state.loading = false;
  }
}

function setupInfiniteScroll() {
  if (scrollObserver) scrollObserver.disconnect();

  const root = document.querySelector(".main-pane");
  if (!root) return;

  const maybeLoadMore = () => {
    const distance = root.scrollHeight - root.scrollTop - root.clientHeight;
    if (distance > 420) return;

    if (currentPageName === "movies") loadMoreMovieYears();
    else if (currentPageName === "home") loadMoreHomeMovies();
    else if (currentPageName === "search") loadMoreSearchContent();
    else if (currentPageName === "tv-shows") loadMoreTvShows();
  };

  scrollObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = entry.target.id;
        if (id === "moviesScrollSentinel" && currentPageName === "movies") loadMoreMovieYears();
        if (id === "homeScrollSentinel" && currentPageName === "home") loadMoreHomeMovies();
        if (id === "searchScrollSentinel" && currentPageName === "search") loadMoreSearchContent();
        if (id === "tvShowsScrollSentinel" && currentPageName === "tv-shows") loadMoreTvShows();
      });
    },
    { root, rootMargin: "420px 0px", threshold: 0 }
  );

  ["moviesScrollSentinel", "homeScrollSentinel", "searchScrollSentinel", "tvShowsScrollSentinel"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) scrollObserver.observe(el);
  });

  root.removeEventListener("scroll", root._infiniteScrollHandler || (() => {}));
  root._infiniteScrollHandler = () => {
    window.clearTimeout(root._infiniteScrollTimer);
    root._infiniteScrollTimer = window.setTimeout(maybeLoadMore, 80);
  };
  root.addEventListener("scroll", root._infiniteScrollHandler, { passive: true });
}

function appendSearchResultCards(items) {
  const resultsGrid = document.getElementById("resultsGrid");
  if (!resultsGrid || !items?.length) return;
  const searchHint = document.getElementById("searchInput")?.value?.trim() || "";
  const uniqueItems = dedupeItems(items, "search");
  if (!uniqueItems.length) return;

  uniqueItems.forEach((t) => {
    if (!t.id) t.id = `search-${Math.random().toString(36).slice(2, 9)}`;
    const typeLabel = getResultType(t.title) === "series" ? "SERIES" : "MOVIE";
    const year = String(t.title).match(/\b(19|20)\d{2}\b/)?.[0] || "";
    const seedsScore = Math.min(99, Math.round(((t.seeds || 0) / 50) * 100));

    const { card, img } = buildMediaCard(
      {
        id: t.id,
        title: cleanDisplayTitle(t.title),
        year,
        typeLabel,
        rating: seedsScore || 50,
        poster: createPosterArt(t.title),
        mediaType: typeLabel === "SERIES" ? "tv" : "movie",
        searchHint,
      },
      {
        onDownload: typeLabel === "SERIES" ? null : () => startDownload(t),
      }
    );

    const loading = document.createElement("div");
    loading.className = "poster-loading";
    loading.innerHTML = '<div class="dots-loader sm"><span></span><span></span><span></span></div>';
    card.querySelector(".poster-wrap").appendChild(loading);
    resultsGrid.appendChild(card);
    if (t.tmdbId && typeLabel === "SERIES") {
      addTvViewAction(card, { ...t, title: cleanDisplayTitle(t.title), typeLabel, mediaType: "tv" });
      card.classList.add("tv-show-card");
      card.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        openTvDetails({ ...t, title: cleanDisplayTitle(t.title), typeLabel, mediaType: "tv" });
      });
    }

    resolvePosterUrl({ ...t, searchHint }).then((posterUrl) => {
      if (posterUrl && /^https?:\/\//i.test(posterUrl)) {
        img.src = posterUrl;
        img.style.filter = "none";
      }
      loading.remove();
    }).catch(() => {
      loading.remove();
    });
  });
}

function appendTmdbSearchCards(items) {
  const resultsGrid = document.getElementById("resultsGrid");
  if (!resultsGrid || !items?.length) return;
  const uniqueItems = dedupeItems(items, "search");
  uniqueItems.forEach((item) => {
    const { card } = buildMediaCard(item, {
      onDownload: item.mediaType === "tv" || item.typeLabel === "SERIES"
        ? null
        : () => downloadByTitle(item.title, item.year, { tmdbId: item.tmdbId, mediaType: "movie" }),
    });
    if (item.mediaType === "tv" || item.typeLabel === "SERIES") {
      addTvViewAction(card, item);
      card.classList.add("tv-show-card");
      card.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        openTvDetails(item);
      });
    }
    resultsGrid.appendChild(card);
  });
}

async function loadSearchTrendingPage(clear = false) {
  if (currentPageName !== "search" || infiniteState.search.loading) return;
  const state = infiniteState.search;
  state.loading = true;
  state.mode = "trending";
  state.country = "all";
  state.page = clear ? 1 : state.page;
  state.totalPages = clear ? 1 : state.totalPages;
  state.renderedCount = 0;
  if (clear) resetShownKeys("search");

  const emptyState = document.getElementById("emptyState");
  const resultsContainer = document.getElementById("searchResultsContainer");
  const resultsGrid = document.getElementById("resultsGrid");
  const sectionHead = document.getElementById("searchSectionHead");
  const filtersPanel = document.getElementById("filtersPanel");
  if (clear) resultsGrid.innerHTML = "";
  emptyState.style.display = "none";
  resultsContainer.style.display = "block";
  sectionHead.style.display = "flex";
  document.getElementById("searchSectionTitle").textContent = "Trending Movies";
  filtersPanel.hidden = false;
  setInlineLoader("searchScrollStatus", true);

  try {
    const payload = await window.api.getPopularMovies({ page: state.page, limit: 32 });
    state.page = payload?.page || state.page;
    state.totalPages = payload?.totalPages || state.totalPages;
    allSearchResults = payload?.items || [];
    filteredResults = allSearchResults;
    appendTmdbSearchCards(payload?.items || []);
    setScrollStatus("searchScrollStatus", payload?.error || (state.page >= state.totalPages ? "End of trending movies" : "Scroll for more movies"));
  } catch (error) {
    setScrollStatus("searchScrollStatus", error.message || "Failed to load trending movies");
  } finally {
    state.loading = false;
  }
}

async function loadTmdbCountries(select) {
  try {
    // Famous production countries only (searchFilters.js) — a short, curated
    // list instead of 240+ TMDb entries. "All countries" stays the default.
    const famous = (window.SearchFilters && window.SearchFilters.FAMOUS_COUNTRIES) || [];
    while (select.options.length > 1) select.remove(1);
    famous.forEach((country) => {
      const option = document.createElement("option");
      option.value = country.iso;
      option.textContent = country.name;
      select.appendChild(option);
    });
  } catch (error) {
    console.warn("Country filters could not be loaded:", error.message);
  }
}

async function loadCountryMovies(country) {
  const state = infiniteState.search;
  const query = String(document.getElementById("searchInput")?.value || "").trim().toLowerCase();
  state.loading = true;
  state.mode = "results";
  state.country = country;
  state.query = query;
  state.page = 1;
  state.totalPages = 1;
  allSearchResults = [];
  filteredResults = [];
  resetShownKeys("search");

  const grid = document.getElementById("resultsGrid");
  const emptyState = document.getElementById("emptyState");
  const resultsContainer = document.getElementById("searchResultsContainer");
  const sectionHead = document.getElementById("searchSectionHead");
  const selectedCountry = document.querySelector(`#countryFilter option[value="${country}"]`)?.textContent || country;
  grid.innerHTML = "";
  emptyState.style.display = "none";
  resultsContainer.style.display = "block";
  sectionHead.style.display = "flex";
  document.getElementById("searchSectionTitle").textContent = query ? `${selectedCountry} results for “${query}”` : `${selectedCountry} Movies`;
  setInlineLoader("searchScrollStatus", true);

  try {
    const payload = await window.api.discoverTmdb({ country, page: 1, limit: 16 });
    state.page = payload?.page || 1;
    state.totalPages = payload?.totalPages || 1;
    allSearchResults = (payload?.items || []).filter((item) => !query || String(item.title || "").toLowerCase().includes(query));
    filteredResults = allSearchResults;
    appendTmdbSearchCards(allSearchResults);
    document.getElementById("resultCount").innerText = `${allSearchResults.length} results`;
    setScrollStatus("searchScrollStatus", state.page >= state.totalPages ? "End of country movies" : "Scroll for more movies");
  } catch (error) {
    setScrollStatus("searchScrollStatus", error.message || "Country movies failed to load");
  } finally {
    state.loading = false;
  }
}

function renderPage() {
  const resultsGrid = document.getElementById("resultsGrid");
  const paginationContainer = document.getElementById("paginationContainer");
  const emptyState = document.getElementById("emptyState");
  const resultsContainer = document.getElementById("searchResultsContainer");
  const sectionHead = document.getElementById("searchSectionHead");

  if (paginationContainer) paginationContainer.style.display = "none";

  if (!filteredResults.length) {
    resultsContainer.style.display = "none";
    if (sectionHead) sectionHead.style.display = "none";
    emptyState.style.display = "flex";
    emptyState.className = "empty-state";
    emptyState.innerHTML = '<i class="fas fa-search-minus"></i><p>No results found</p>';
    setScrollStatus("searchScrollStatus", "");
    return;
  }

  emptyState.style.display = "none";
  resultsContainer.style.display = "block";
  if (sectionHead) sectionHead.style.display = "flex";
  resultsGrid.innerHTML = "";
  resetShownKeys("search");

  infiniteState.search.mode = "results";
  infiniteState.search.renderedCount = 0;
  infiniteState.search.loading = false;

  const firstBatch = filteredResults.slice(0, RESULTS_PER_PAGE);
  appendSearchResultCards(firstBatch);
  infiniteState.search.renderedCount = firstBatch.length;

  setScrollStatus(
    "searchScrollStatus",
    infiniteState.search.renderedCount >= filteredResults.length
      ? "End of results"
      : "Scroll for more results"
  );
}

/** Current-year Home shelves: New & Latest, then Most Trending. */
async function loadHomePinnedRows() {
  const year = new Date().getFullYear();
  const rows = [
    { id: "homeLatestRow", section: "homeLatestSection", title: "homeLatestTitle", sort: "primary_release_date.desc", label: "New & Latest Movies" },
    { id: "homeTrendingRow", section: "homeTrendingSection", title: "homeTrendingTitle", sort: "popularity.desc", label: "Most Trending Movies" },
  ];

  await Promise.all(rows.map(async ({ id, section, title, sort, label }) => {
    const row = document.getElementById(id);
    const sectionEl = document.getElementById(section);
    if (!row || !sectionEl) return;
    try {
      const payload = await window.api.getMoviesByYear({ year, limit: 32, page: 1, sort });
      const items = (payload?.items || []).filter((item) => item?.tmdbId || item?.title);
      row.innerHTML = "";
      if (!items.length) {
        sectionEl.hidden = true;
        return;
      }
      row._kind = "movies";
      row._year = year;
      row._sort = sort;
      row._page = Number(payload?.page) || 1;
      row._totalPages = Number(payload?.totalPages) || 1;
      row._offset = 0;
      items.forEach((item) => row.appendChild(buildRowCard(row, item)));
      const titleEl = document.getElementById(title);
      if (titleEl) titleEl.textContent = `${label} · ${year}`;
      sectionEl.hidden = false;
      updateYearRowControls(sectionEl);
    } catch (error) {
      sectionEl.hidden = true;
      console.warn(`Home current-year row failed: ${label}`, error.message);
    }
  }));
}

async function loadBrowsePage(page) {
  if (page === "search" && infiniteState.search.mode === "results" && filteredResults.length > 0) {
    return;
  }

  if (page === "search") {
    loadSearchTrendingPage(true);
    return;
  }

  try {
    if (page === "home") {
      infiniteState.home.page = 1;
      infiniteState.home.totalPages = 1;
      infiniteState.home.done = false;
      infiniteState.home.loading = false;
      infiniteState.home.source = "mix";
      infiniteState.home.year = null;
      infiniteState.home.yearPage = 1;
      infiniteState.home.everSucceeded = false;

      const [payload] = await Promise.all([
        window.api.getPopularMovies({ page: 1, limit: 32 }),
        loadHomePinnedRows(),
      ]);
      if (payload?.error) throw new Error(payload.error);
      infiniteState.home.totalPages = Math.min(Number(payload?.totalPages) || 50, HOME_MIX_MAX_PAGE);
      infiniteState.home.everSucceeded = true;
      renderItemsIntoGrid(document.getElementById("homeGrid"), payload.items || [], "home");
      if (payload?.dbFallback || payload?.offline) {
        // Offline/cache-only mode cannot paginate → stop here.
        infiniteState.home.done = true;
        setScrollStatus("homeScrollStatus", "You're all caught up");
      } else {
        setScrollStatus("homeScrollStatus", "Scroll for more movies");
      }
      return;
    }

    if (page === "movies") {
      await loadMoviesYearCatalog();
      return;
    }

    if (page === "tv-shows") {
      // Re-entry must rebuild the category DOM/state even when the previous
      // visit was interrupted by navigation.
      await loadTvShowsPage(true);
    }
  } catch (error) {
    console.warn("Browse load failed:", error);
    showToast("Failed to load movies", error.message, "info", "fa-triangle-exclamation");
  }
}


function renderFavorites() {
  const grid = document.getElementById("favoritesGrid");
  const empty = document.getElementById("favoritesEmpty");
  grid.innerHTML = "";

  if (!favorites.length) {
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  favorites.forEach((item) => {
    const { card } = buildMediaCard(item, {
      onDownload: () =>
        downloadByTitle(item.title, item.year, {
          tmdbId: item.tmdbId,
          mediaType: item.mediaType || (item.typeLabel === "SERIES" ? "tv" : "movie"),
        }),
    });
    grid.appendChild(card);
  });
}

function normalizeSearchResponse(payload) {
  if (Array.isArray(payload)) {
    return { results: payload, fromCache: false, fromDb: false };
  }
  return {
    results: payload?.results || [],
    fromCache: Boolean(payload?.fromCache),
    fromDb: Boolean(payload?.fromDb),
    error: payload?.error || null,
  };
}

async function downloadByTitle(title, year = "", metadata = {}) {
  if (isOffline) {
    showOfflineMessage();
    return;
  }
  const SF = window.SearchFilters;
  const rawLang =
    metadata.preferLanguage ||
    metadata.language ||
    document.getElementById("languageFilter")?.value ||
    "all";
  // "all" / "original" / empty → any language acceptable (no forced fallback).
  const preferLanguage = !rawLang || rawLang === "original" ? "all" : rawLang;
  const quality = document.getElementById("qualityFilter")?.value || "all";
  const languageFragments = SF ? SF.languageQueriesFor(preferLanguage) : [];
  const qualityFragment = SF ? SF.qualityQueryFor(quality) : "";
  const baseQuery = [title, year].filter(Boolean).join(" ").trim();
  // Probe Hindi/Urdu/Pakistani variants and the selected quality first.
  // Every result is strictly filtered after each round, so escalation cannot
  // silently download a different language or resolution.
  const queryList = [
    ...languageFragments.map((languageFragment) =>
      [title, year, languageFragment, qualityFragment].filter(Boolean).join(" ").trim()
    ),
    [title, year, qualityFragment].filter(Boolean).join(" ").trim(),
    baseQuery,
    String(title || "").trim(),
  ].filter(Boolean);

  const langLabel = SF ? SF.languageLabel(preferLanguage) : "";
  const qualLabel = SF ? SF.qualityLabel(quality) : "";
  const filterLabel =
    [langLabel !== "Any" ? langLabel : "", qualLabel].filter(Boolean).join(" ") || "matching";

  showToast("Finding torrent", title, "info", "fa-magnifying-glass");
  const placeholderId = `quick-${Date.now()}`;
  activeDownloads.set(placeholderId, {
    id: placeholderId,
    title: `Finding: ${title}`,
    magnet: null,
    progress: 0,
    speed: 0,
    status:
      preferLanguage === "all" && quality === "all"
        ? "Searching torrents…"
        : `Searching ${filterLabel} torrents…`,
    language: preferLanguage,
    ...metadata,
  });
  persistDownloadsUi();
  updateBadge();
  if (currentPageName === "downloads") renderDownloadsPage();

  const isHindiTorrent = (t) =>
    (SF && SF.HINDI_RE.test(`${t.title || ""} ${t.language || ""}`)) ||
    /\bhindi\b|\bhin\b|bollywood|lollywood|dual[ ._-]?audio|\bdesi\b|urdu|pakistani|indian[ ._-]?(?:dub|audio)/i.test(
      `${t.title || ""} ${t.language || ""}`
    );

  try {
    // meta lets main persist results + query the DB fallback (LIST B1).
    const searchMeta = {
      tmdbId: metadata.tmdbId || metadata.tvShowId || null,
      mediaType: metadata.mediaType || (metadata.tvShowId ? "tv" : null),
      season: metadata.season ?? null,
      episode: metadata.episode ?? null,
    };

    // STRICT: language AND quality must both match — never something else.
    const strictMatch = (list) =>
      SF
        ? SF.strictFilterTorrents(list, { language: preferLanguage, quality })
        : list;

    const pool = [];
    const seen = new Set();
    let savedFromDb = false;
    let matched = [];

    for (const query of queryList) {
      const response = normalizeSearchResponse(await window.api.searchMovies(query, searchMeta));
      savedFromDb = savedFromDb || Boolean(response.fromDb);
      for (const t of response.results || []) {
        const key = t.magnet || t.infoHash || `${t.title}::${t.seeds}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(t);
      }
      matched = strictMatch(pool);
      if (matched.some((t) => Number(t.seeds) > 0)) break; // usable match → stop escalating
    }

    // Rank: seeds first; Hindi preference only reorders within matching rows.
    const rankHindi = preferLanguage === "hindi";
    let candidates = matched
      .filter((t) => Number(t.seeds) > 0)
      .sort((a, b) => {
        if (rankHindi) {
          const ah = isHindiTorrent(a) ? 1 : 0;
          const bh = isHindiTorrent(b) ? 1 : 0;
          if (bh !== ah) return bh - ah;
        }
        return (b.seeds || 0) - (a.seeds || 0);
      });

    removeDownloadCard(placeholderId);

    const best = candidates[0];
    if (!best) {
      const hadResults = pool.length > 0;
      showToast(
        "No matching torrent",
        hadResults
          ? `No ${filterLabel} torrent for "${title}" right now — change Language/Quality and retry.`
          : `"${title}" is listed, but no downloadable torrent is online right now.`,
        "info",
        "fa-circle-xmark"
      );
      return;
    }

    best.id = metadata.episodeKey ? placeholderId : (best.id || `search-${Math.random().toString(36).slice(2, 9)}`);
    Object.assign(best, metadata, { language: preferLanguage });
    startDownload(best, { skipToast: true });
    if (savedFromDb) {
      showToast(
        "Queued from library",
        `${cleanDisplayTitle(best.title)} · saved torrent (Supabase)`,
        "success",
        "fa-database"
      );
    } else {
      showToast("Queued for download", cleanDisplayTitle(best.title), "success", "fa-cloud-arrow-down");
    }
  } catch (error) {
    removeDownloadCard(placeholderId);
    showToast("Download failed", error.message || "Search failed", "info", "fa-triangle-exclamation");
  }
}

async function search() {
  const query = document.getElementById("searchInput").value.trim();
  if (!query) return;

  navigateTo("search", { reload: false });
  showingHomeShowcase = false;

  const mySearchId = Date.now();
  currentSearchTimestamp = mySearchId;

  const emptyState = document.getElementById("emptyState");
  const resultsContainer = document.getElementById("searchResultsContainer");
  const resultsGrid = document.getElementById("resultsGrid");
  const cancelBtn = document.getElementById("cancelSearchBtn");

  cancelBtn.style.display = "inline-flex";
  emptyState.style.display = "none";
  resultsContainer.style.display = "block";
  const sectionHead = document.getElementById("searchSectionHead");
  if (sectionHead) sectionHead.style.display = "flex";
  resultsGrid.innerHTML = "";
  document.getElementById("searchSectionTitle").textContent = `Results for “${query}”`;
  document.getElementById("resultCount").innerText = "Searching...";
  document.getElementById("filtersPanel").hidden = false;
  document.getElementById("paginationContainer").style.display = "none";
  setInlineLoader("searchScrollStatus", true);

  currentPage = 0;
  allSearchResults = [];
  filteredResults = [];

  try {
    const payload = await window.api.searchTmdb({ query, page: 1 });
    if (currentSearchTimestamp !== mySearchId) return;

    allSearchResults = payload?.items || [];
    filteredResults = allSearchResults;
    infiniteState.search.mode = "results";
    infiniteState.search.query = query;
    infiniteState.search.page = payload?.page || 1;
    infiniteState.search.totalPages = payload?.totalPages || 1;
    infiniteState.search.renderedCount = allSearchResults.length;
    if (allSearchResults.length === 0) {
      document.getElementById("resultCount").innerText = payload?.error || (isOffline ? OFFLINE_MESSAGE : "0 results found.");
      emptyState.style.display = "flex";
      emptyState.className = "empty-state";
      emptyState.innerHTML = '<i class="fas fa-search-minus"></i><p>No results found</p>';
      resultsContainer.style.display = "none";
      const sectionHead = document.getElementById("searchSectionHead");
      if (sectionHead) sectionHead.style.display = "none";
      setScrollStatus("searchScrollStatus", "");
    } else {
      resetShownKeys("search");
      appendTmdbSearchCards(allSearchResults);
      document.getElementById("resultCount").innerText = `${allSearchResults.length} results`;
      setScrollStatus("searchScrollStatus", infiniteState.search.page >= infiniteState.search.totalPages ? "End of results" : "Scroll for more results");
    }
  } catch (err) {
    if (currentSearchTimestamp === mySearchId) {
      console.error("Search failed:", err);
      document.getElementById("resultCount").innerText = isOffline ? OFFLINE_MESSAGE : (err?.message || "Error occurred.");
      emptyState.style.display = "flex";
      emptyState.className = "empty-state";
      emptyState.innerHTML = `<i class="fas fa-triangle-exclamation"></i><p>${escapeHtml(err?.message || "Error occurred.")}</p>`;
      setScrollStatus("searchScrollStatus", "");
    }
  }
}

function cancelSearch() {
  currentSearchTimestamp = 0;
  document.getElementById("searchInput").value = "";
  document.getElementById("cancelSearchBtn").style.display = "none";
  allSearchResults = [];
  filteredResults = [];
  loadSearchTrendingPage(true);
}

async function findFilteredTmdbTorrents(item, language, quality) {
  const SF = window.SearchFilters;
  const title = String(item?.title || "").trim();
  const year = String(item?.year || "").trim();
  if (!title || !SF) return [];

  const baseQuery = [title, year].filter(Boolean).join(" ");
  const languageParts = SF.languageQueriesFor(language);
  const qualityPart = SF.qualityQueryFor(quality);
  const queries = [
    ...languageParts.map((languagePart) => [title, year, languagePart, qualityPart].filter(Boolean).join(" ")),
    [title, year, qualityPart].filter(Boolean).join(" "),
    baseQuery,
  ];

  const pool = [];
  const seen = new Set();
  for (const query of new Set(queries.filter(Boolean))) {
    const cacheKey = `${item.mediaType || "movie"}:${item.tmdbId || title}:${language}:${quality}:${query}`;
    let torrents = searchTorrentCache.get(cacheKey);
    if (!torrents) {
      try {
        const response = normalizeSearchResponse(
          await window.api.searchMovies(query, {
            tmdbId: item.tmdbId || null,
            mediaType: item.mediaType || "movie",
          })
        );
        torrents = response.results || [];
        searchTorrentCache.set(cacheKey, torrents);
      } catch {
        torrents = [];
        searchTorrentCache.set(cacheKey, torrents);
      }
    }
    for (const torrent of torrents) {
      const key = torrent.magnet || torrent.infoHash || `${torrent.title}::${torrent.seeds}`;
      if (!seen.has(key)) {
        seen.add(key);
        pool.push(torrent);
      }
    }
  }
  return SF.strictFilterTorrents(
    pool.map((torrent) => ({
      ...torrent,
      // Preserve the catalog's original audio when a provider does not include
      // an explicit English tag on an otherwise untagged release.
      originalLanguage: torrent.originalLanguage || torrent.original_language || item.originalLanguage || "",
    })),
    { language, quality }
  );
}

async function applyFilters() {
  if (showingHomeShowcase) return;

  const SF = window.SearchFilters;
  const language = document.getElementById("languageFilter")?.value || "all";
  const quality = document.getElementById("qualityFilter")?.value || "all";
  const country = document.getElementById("countryFilter")?.value || "all";
  const currentCountry = infiniteState.search.country || "all";

  // Country drives TMDb discovery. After discovery, continue into the same
  // language + quality filtering path below; selecting a country must never
  // discard the other active filters.
  if (country !== "all" && country !== currentCountry) {
    await loadCountryMovies(country);
  }
  if (country === "all" && currentCountry !== "all") {
    const query = String(document.getElementById("searchInput")?.value || "").trim();
    if (query) await search();
    else await loadSearchTrendingPage(true);
    return;
  }

  const renderFiltered = (items, status) => {
    filteredResults = items;
    const grid = document.getElementById("resultsGrid");
    grid.innerHTML = "";
    resetShownKeys("search");
    appendTmdbSearchCards(filteredResults);
    document.getElementById("resultCount").innerText = `${filteredResults.length} results`;
    setScrollStatus("searchScrollStatus", status);
  };

  if (allSearchResults.some((item) => item.tmdbId)) {
    const query = String(document.getElementById("searchInput")?.value || "").trim().toLowerCase();
    const queryMatches = (item) => {
      const title = String(item.title || "").toLowerCase();
      return !query || title.includes(query) || title.split(/\s+/).some((word) => word.startsWith(query));
    };

    const langActive = language !== "all";
    const qualActive = quality !== "all";
    const countryActive = country !== "all";
    const base = allSearchResults.filter(
      (item) =>
        queryMatches(item) &&
        (!countryActive || !SF || SF.tmdbItemMatchesCountry(item, country))
    );

    if (!langActive && !qualActive && !countryActive) {
      renderFiltered(base, base.length ? "Showing all results" : "No matches for these filters");
      return;
    }

    if ((langActive || qualActive) && isOffline) {
      showOfflineMessage();
      return;
    }
    setInlineLoader("searchScrollStatus", true);
    const passes = new Map();
    await Promise.all(
      base.map(async (item) => {
        const key = `${item.tmdbId || item.id}:${language}:${quality}`;
        if (searchFilterCache.has(key)) {
          passes.set(item, searchFilterCache.get(key));
          return;
        }
        const torrents = langActive || qualActive
          ? await findFilteredTmdbTorrents(item, language, quality)
          : [];
        const pass = (langActive || qualActive)
          ? torrents.length > 0
          : Boolean(SF?.tmdbItemMatchesCountry(item, country));
        searchFilterCache.set(key, pass);
        passes.set(item, pass);
      })
    );

    const filtered = base.filter((item) => passes.get(item) !== false);
    const activeCount = SF ? SF.activeFilterCount({ language, quality }) + (countryActive ? 1 : 0) : 0;
    renderFiltered(
      filtered,
      filtered.length
        ? `${activeCount} filter${activeCount === 1 ? "" : "s"} · exact match`
        : "No exact match for the selected filters"
    );
    return;
  }

  const sort = document.getElementById("sortFilter")?.value || "seeds";
  const queryCore =
    extractCoreTitle(document.getElementById("searchInput")?.value || "").core || "";
  const langActive = language !== "all";
  const qualActive = quality !== "all";

  let temp = allSearchResults.filter((t) => {
    const title = String(t.title || "");
    const filterMatches = SF
      ? SF.strictFilterTorrents([t], { language, quality }).length > 0
      : true;

    // Keep only titles that actually start with the search query (drops "Doctor Who The Interstellar...").
    const itemCore = extractCoreTitle(title).core;
    const queryWords = queryCore.split(/\s+/).filter(Boolean);
    const queryMatches =
      !queryCore ||
      itemCore === queryCore ||
      itemCore.startsWith(`${queryCore} `) ||
      itemCore.split(/\s+/).slice(0, queryWords.length).join(" ") === queryCore;

    return filterMatches && queryMatches;
  });

  const parseSize = (str) => {
    const text = String(str || "");
    const num = parseFloat(text);
    if (Number.isNaN(num)) return 0;
    if (/gb/i.test(text)) return num * 1024;
    if (/mb/i.test(text)) return num;
    if (num > 1024 * 1024) return num / (1024 * 1024);
    return num;
  };

  temp.sort((a, b) => {
    if (sort === "seeds_desc") return (b.seeds || 0) - (a.seeds || 0);
    if (sort === "seeds_asc") return (a.seeds || 0) - (b.seeds || 0);
    if (sort === "size_desc") return parseSize(b.size) - parseSize(a.size);
    if (sort === "size_asc") return parseSize(a.size) - parseSize(b.size);
    return 0;
  });

  filteredResults = (() => {
    const bestByKey = new Map();
    for (const item of temp) {
      const key = movieIdentityKey(item);
      if (!key) continue;
      const prev = bestByKey.get(key);
      if (!prev || Number(item.seeds || 0) > Number(prev.seeds || 0)) {
        bestByKey.set(key, item);
      }
    }
    return [...bestByKey.values()].sort((a, b) => {
      if (sort === "seeds_desc") return (b.seeds || 0) - (a.seeds || 0);
      if (sort === "seeds_asc") return (a.seeds || 0) - (b.seeds || 0);
      if (sort === "size_desc") return parseSize(b.size) - parseSize(a.size);
      if (sort === "size_asc") return parseSize(a.size) - parseSize(b.size);
      return 0;
    });
  })();
  currentPage = 0;
  document.getElementById("resultCount").innerText = `${filteredResults.length} results`;
  renderPage();
}

function changePage() {
  // Pagination replaced by infinite scroll
}

// --- DOWNLOADS ---
const DOWNLOADS_UI_KEY = "cinebroad-active-downloads-ui";
const DOWNLOADS_UI_KEY_LEGACY = "dolphin-active-downloads-ui";

function persistDownloadsUi() {
  try {
    const payload = [...activeDownloads.values()].map((item) => ({
      id: item.id,
      title: item.title,
      magnet: item.magnet || null,
      path: item.path || null,
      filePath: item.filePath || null,
      progress: item.progress || 0,
      downloaded: item.downloaded || 0,
      total: item.total || 0,
      speed: item.speed || 0,
      peers: item.peers || 0,
      done: Boolean(item.done),
      paused: Boolean(item.paused),
      tvShowId: item.tvShowId || null,
      season: item.season || null,
      episode: item.episode || null,
      episodeTitle: item.episodeTitle || null,
      language: item.language || null,
      episodeKey: item.episodeKey || null,
    }));
    localStorage.setItem(DOWNLOADS_UI_KEY, JSON.stringify(payload));
  } catch {}
}

function loadPersistedDownloadsUi() {
  try {
    const raw = JSON.parse(
      localStorage.getItem(DOWNLOADS_UI_KEY) ||
        localStorage.getItem(DOWNLOADS_UI_KEY_LEGACY) ||
        "[]"
    );
    if (!Array.isArray(raw)) return;
    raw.forEach((item) => {
      if (!item?.id || activeDownloads.has(item.id)) return;
      activeDownloads.set(item.id, item);
    });
  } catch {}
}

async function syncDownloadsFromMain() {
  try {
    const list = await window.api.getActiveDownloads();
    (list || []).forEach((item) => {
      const prev = activeDownloads.get(item.id) || {};
      activeDownloads.set(item.id, {
        ...prev,
        ...item,
        done: Boolean(item.done),
        paused: false,
      });
    });
    persistDownloadsUi();
    updateBadge();
  } catch (error) {
    console.warn("Could not sync downloads:", error.message);
  }
}

function startDownload(torrent, options = {}) {
  if (!torrent?.id) return;
  const existing = activeDownloads.get(torrent.id) || {};
  activeDownloads.set(torrent.id, {
    ...existing,
    ...torrent,
    progress: existing.progress || 0,
    done: false,
    paused: false,
    status: torrent.magnet ? "Connecting to peers…" : "Fetching magnet link…",
  });
  persistDownloadsUi();
  renderDownloadsPage();
  updateBadge();
  if (!options.skipToast) {
    showToast("Download started", cleanDisplayTitle(torrent.title), "success", "fa-download");
  }
  // Keep provider fields so main process can resolve the magnet from the detail page.
  window.api.startDownload({
    id: torrent.id,
    title: torrent.title,
    magnet: torrent.magnet || null,
    desc: torrent.desc || null,
    link: torrent.link || null,
    provider: torrent.provider || null,
    size: torrent.size || null,
    seeds: torrent.seeds || 0,
    path: torrent.path || null,
    tmdbId: torrent.tmdbId || null,
    tvShowId: torrent.tvShowId || null,
    mediaType: torrent.mediaType || null,
    season: torrent.season ?? null,
    episode: torrent.episode ?? null,
  });
}

function renderDownloadsPage() {
  const list = document.getElementById("downloadList");
  const empty = document.getElementById("downloadsEmpty");
  if (!list) return;

  const items = [...activeDownloads.values()];
  list.innerHTML = "";

  if (!items.length) {
    if (empty) empty.hidden = false;
    updateBadge();
    return;
  }
  if (empty) empty.hidden = true;

  items
    .sort((a, b) => Number(b.progress || 0) - Number(a.progress || 0))
    .forEach((torrent) => list.appendChild(buildDownloadCard(torrent)));

  updateBadge();
}

function buildDownloadCard(torrent) {
  const card = document.createElement("div");
  card.id = `card-${torrent.id}`;
  card.className = `download-card${torrent.done ? " is-complete" : ""}`;
  const progress = Number(torrent.progress || 0).toFixed(1);
  const speedLabel = torrent.done
    ? "Completed"
    : torrent.paused
      ? "Paused"
      : torrent.status
        ? torrent.status
        : Number(torrent.speedBps || torrent.speed) > 0
          ? `${formatSpeed(
              torrent.speedBps != null
                ? torrent.speedBps
                : Number(torrent.speed || 0) * 1024 * 1024
            )} · ${torrent.peers || 0} peers`
          : "Starting…";
  const sizeLabel =
    torrent.total > 0
      ? `${formatBytes(torrent.downloaded || 0)} / ${formatBytes(torrent.total)}`
      : torrent.status || "Waiting…";

  card.innerHTML = `
    <div class="dl-title" title="${escapeHtml(torrent.title)}"><span class="dl-title-text">${escapeHtml(
      cleanDisplayTitle(torrent.title)
    )}</span>${torrent.link ? `<a class="dl-torrent-url" href="${escapeHtml(torrent.link)}" target="_blank" rel="noopener" title="Open torrent source in browser"><i class="fas fa-link"></i></a>` : ""}</div>
    <div class="dl-progress-row">
      <span id="speed-${torrent.id}">${speedLabel}</span>
      <span id="size-${torrent.id}">${sizeLabel}</span>
      <span id="percent-${torrent.id}">${torrent.done ? "100" : progress}%</span>
    </div>
    <div class="progress-bar-bg"><div id="bar-${torrent.id}" class="progress-bar-fill" style="width:${
      torrent.done ? 100 : progress
    }%;${torrent.done ? "background:#22c55e" : ""}"></div></div>
    <div class="dl-actions">
      <button type="button" onclick="preview('${torrent.id}')" title="Preview in player"><i class="fas fa-play"></i></button>
      ${
        torrent.done
          ? `<button type="button" onclick="locateFile('${torrent.id}')" title="Open folder"><i class="fas fa-folder-open"></i></button>`
          : `<button type="button" id="btn-pause-${torrent.id}" onclick="${
              torrent.paused ? `resume('${torrent.id}')` : `pause('${torrent.id}')`
            }" title="${torrent.paused ? "Resume" : "Pause"}"><i class="fas fa-${
              torrent.paused ? "play" : "pause"
            }"></i></button>`
      }
      <button type="button" class="danger" onclick="stopAndRemove('${torrent.id}')" title="Stop & remove"><i class="fas fa-xmark"></i></button>
    </div>
  `;
  return card;
}

function removeDownloadCard(id) {
  activeDownloads.delete(id);
  persistDownloadsUi();
  const card = document.getElementById(`card-${id}`);
  if (card) card.remove();
  if (currentPageName === "downloads") renderDownloadsPage();
  if (!document.getElementById("tvDetailsModal")?.hidden && tvDetailsState.show) renderTvEpisodes();
  updateBadge();
  syncDownloadsEmpty();
}

function syncDownloadsEmpty() {
  const empty = document.getElementById("downloadsEmpty");
  const list = document.getElementById("downloadList");
  if (!empty || !list) return;
  empty.hidden = list.children.length > 0;
}

function pause(id) {
  const torrent = activeDownloads.get(id);
  if (!torrent?.magnet) {
    showToast("Still connecting", "Please wait a moment", "info", "fa-spinner");
    return;
  }
  window.api.pauseDownload(torrent.magnet);
  torrent.paused = true;
  torrent.speed = 0;
  persistDownloadsUi();
  renderDownloadsPage();
}

function resume(id) {
  const torrent = activeDownloads.get(id);
  if (!torrent?.magnet) return;
  torrent.paused = false;
  persistDownloadsUi();
  window.api.resumeDownload(torrent);
  renderDownloadsPage();
}

function stopAndRemove(id) {
  const torrent = activeDownloads.get(id);
  if (torrent?.magnet) window.api.cancelDownload(torrent.magnet);
  window.api.hideDownload(id);
  if (playerState.currentId === String(id)) closePlayer();
  removeDownloadCard(id);
  showToast("Removed from downloads", cleanDisplayTitle(torrent?.title || "Item"), "info", "fa-xmark");
}

async function preview(id) {
  const item = activeDownloads.get(id);
  if (item?.filePath) {
    const result = await window.api.openLocalPreview(item.filePath, item.title);
    if (result?.error) showToast("Preview unavailable", result.error, "info", "fa-triangle-exclamation");
    else openInAppPlayerResult(result);
    return;
  }
  openInAppPlayer(id);
}

function locateFile(id) {
  const torrent = activeDownloads.get(id);
  const target = torrent?.filePath || torrent?.path;
  if (target) window.api.showItemInFolder(target);
  else showToast("Folder not ready", "File path not available yet", "info", "fa-folder-open");
}

async function changeFolder() {
  const selected = await window.api.selectFolder();
  if (selected) document.getElementById("pathDisplay").value = selected;
}

function updateBadge() {
  const badge = document.getElementById("activeCount");
  if (!badge) return;
  const activeCount = [...activeDownloads.values()].filter((item) => !item.done).length;
  badge.innerText = String(activeCount);
  badge.style.display = activeCount > 0 ? "flex" : "none";
  updateNetworkSpeedDisplay();
}

function updateNetworkSpeedDisplay() {
  const valueEl = document.getElementById("networkSpeedValue");
  const wrapEl = document.getElementById("networkSpeed");
  if (!valueEl || !wrapEl) return;

  const totalBps = [...activeDownloads.values()]
    .filter((item) => !item.done && !item.paused)
    .reduce((sum, item) => {
      if (item.speedBps != null) return sum + (Number(item.speedBps) || 0);
      // Legacy: speed was stored as MB/s
      return sum + (Number(item.speed) || 0) * 1024 * 1024;
    }, 0);

  valueEl.textContent = formatSpeed(totalBps);
  wrapEl.classList.toggle("is-idle", totalBps <= 0);
}

// --- IN-APP PLAYER ---
const playerState = {
  currentId: null,
  diskPath: null,
  hideControlsTimer: null,
  lastTap: { side: null, at: 0 },
};

function formatPlayerTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getPlayerEls() {
  return {
    modal: document.getElementById("playerModal"),
    shell: document.getElementById("playerShell"),
    video: document.getElementById("playerVideo"),
    title: document.getElementById("playerTitle"),
    seek: document.getElementById("playerSeek"),
    volume: document.getElementById("playerVolume"),
    time: document.getElementById("playerTime"),
    playBtn: document.getElementById("playerPlayBtn"),
    muteBtn: document.getElementById("playerMuteBtn"),
    fsBtn: document.getElementById("playerFsBtn"),
    buffering: document.getElementById("playerBuffering"),
    errorBox: document.getElementById("playerError"),
    errorText: document.getElementById("playerErrorText"),
    seekFlash: document.getElementById("playerSeekFlash"),
  };
}

function setPlayerBuffering(on) {
  const { buffering } = getPlayerEls();
  if (buffering) buffering.hidden = !on;
}

function setPlayerError(message) {
  const { errorBox, errorText } = getPlayerEls();
  if (!errorBox) return;
  errorBox.hidden = !message;
  if (errorText && message) errorText.textContent = message;
}

function flashSeek(delta) {
  const { seekFlash } = getPlayerEls();
  if (!seekFlash) return;
  seekFlash.hidden = false;
  seekFlash.textContent = delta > 0 ? `+${delta}s` : `${delta}s`;
  clearTimeout(flashSeek._timer);
  flashSeek._timer = setTimeout(() => {
    seekFlash.hidden = true;
  }, 700);
}

function seekPlayerBy(seconds) {
  const { video } = getPlayerEls();
  if (!video || !Number.isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  flashSeek(seconds);
  updatePlayerTimeUi();
}

function updatePlayerTimeUi() {
  const { video, seek, time } = getPlayerEls();
  if (!video || !seek || !time) return;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  if (!seek.dataset.dragging) {
    seek.value = duration ? Math.round((current / duration) * 1000) : 0;
  }
  time.textContent = `${formatPlayerTime(current)} / ${formatPlayerTime(duration)}`;
}

function syncPlayButton() {
  const { video, playBtn } = getPlayerEls();
  if (!video || !playBtn) return;
  playBtn.innerHTML = video.paused
    ? '<i class="fas fa-play"></i>'
    : '<i class="fas fa-pause"></i>';
}

function syncMuteButton() {
  const { video, muteBtn, volume } = getPlayerEls();
  if (!video || !muteBtn) return;
  const muted = video.muted || video.volume === 0;
  muteBtn.innerHTML = muted
    ? '<i class="fas fa-volume-xmark"></i>'
    : video.volume < 0.4
      ? '<i class="fas fa-volume-low"></i>'
      : '<i class="fas fa-volume-high"></i>';
  if (volume && !volume.dataset.dragging) volume.value = String(video.muted ? 0 : video.volume);
}

function togglePlayerFullscreen() {
  const { shell, fsBtn } = getPlayerEls();
  if (!shell) return;
  const next = !shell.classList.contains("is-fullscreen");
  shell.classList.toggle("is-fullscreen", next);
  if (fsBtn) {
    fsBtn.innerHTML = next
      ? '<i class="fas fa-compress"></i>'
      : '<i class="fas fa-expand"></i>';
  }
}

async function openInAppPlayerResult(result) {
  const { modal, video, title } = getPlayerEls();
  if (!modal || !video || result?.error) return;
  setPlayerError("");
  setPlayerBuffering(false);
  modal.hidden = false;
  playerState.currentId = null;
  playerState.diskPath = result.diskPath || null;
  title.textContent = cleanDisplayTitle(result.title || result.fileName || "Preview");
  video.src = result.streamUrl;
  video.volume = Number(document.getElementById("playerVolume")?.value || 0.9);
  await video.play().catch(() => {});
  syncPlayButton();
  syncMuteButton();
}

async function openInAppPlayer(id) {
  const { modal, video, title } = getPlayerEls();
  if (!modal || !video) return;

  setPlayerError("");
  setPlayerBuffering(true);
  modal.hidden = false;
  title.textContent = cleanDisplayTitle(activeDownloads.get(id)?.title || "Loading preview…");
  video.removeAttribute("src");
  video.load();

  try {
    const result = await window.api.openPreview(id);
    if (result?.error) {
      setPlayerBuffering(false);
      setPlayerError(result.error);
      return;
    }

    playerState.currentId = String(id);
    playerState.diskPath = result.diskPath || null;
    title.textContent = cleanDisplayTitle(result.title || result.fileName || "Preview");
    video.src = result.streamUrl;
    video.volume = Number(document.getElementById("playerVolume")?.value || 0.9);
    if (result.streaming) {
      showToast("Preview started", "Playing available pieces while downloading continues", "info", "fa-play");
    }
    await video.play().catch(() => {});
    setPlayerBuffering(false);
    syncPlayButton();
    syncMuteButton();
  } catch (error) {
    setPlayerBuffering(false);
    setPlayerError(error.message || "Could not open preview");
  }
}

function closePlayer() {
  const { modal, video, shell } = getPlayerEls();
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  if (playerState.currentId) window.api.closePreview(playerState.currentId);
  playerState.currentId = null;
  playerState.diskPath = null;
  if (shell) shell.classList.remove("is-fullscreen");
  if (modal) modal.hidden = true;
  setPlayerError("");
  setPlayerBuffering(false);
}

function setupPlayerControls() {
  const els = getPlayerEls();
  if (!els.modal || els.modal.dataset.ready) return;
  els.modal.dataset.ready = "1";

  els.playBtn?.addEventListener("click", () => {
    if (!els.video) return;
    if (els.video.paused) els.video.play().catch(() => {});
    else els.video.pause();
  });
  document.getElementById("playerRewindBtn")?.addEventListener("click", () => seekPlayerBy(-10));
  document.getElementById("playerForwardBtn")?.addEventListener("click", () => seekPlayerBy(10));
  document.getElementById("playerCloseBtn")?.addEventListener("click", closePlayer);
  document.getElementById("playerFsBtn")?.addEventListener("click", togglePlayerFullscreen);
  document.getElementById("playerMuteBtn")?.addEventListener("click", () => {
    if (!els.video) return;
    els.video.muted = !els.video.muted;
    syncMuteButton();
  });
  document.getElementById("playerOpenFolderBtn")?.addEventListener("click", () => {
    if (playerState.diskPath) window.api.showItemInFolder(playerState.diskPath);
  });
  document.getElementById("playerExternalBtn")?.addEventListener("click", async () => {
    if (!playerState.diskPath) return;
    await window.api.openExternalVideo(playerState.diskPath);
  });
  document.getElementById("playerErrorExternalBtn")?.addEventListener("click", async () => {
    if (!playerState.diskPath) return;
    await window.api.openExternalVideo(playerState.diskPath);
  });

  els.volume?.addEventListener("input", () => {
    if (!els.video) return;
    els.volume.dataset.dragging = "1";
    els.video.volume = Number(els.volume.value);
    els.video.muted = els.video.volume === 0;
    syncMuteButton();
  });
  els.volume?.addEventListener("change", () => {
    delete els.volume.dataset.dragging;
  });

  els.seek?.addEventListener("input", () => {
    if (!els.video || !Number.isFinite(els.video.duration)) return;
    els.seek.dataset.dragging = "1";
    els.video.currentTime = (Number(els.seek.value) / 1000) * els.video.duration;
    updatePlayerTimeUi();
  });
  els.seek?.addEventListener("change", () => {
    delete els.seek.dataset.dragging;
  });

  els.video?.addEventListener("timeupdate", updatePlayerTimeUi);
  els.video?.addEventListener("play", syncPlayButton);
  els.video?.addEventListener("pause", syncPlayButton);
  els.video?.addEventListener("waiting", () => setPlayerBuffering(true));
  els.video?.addEventListener("playing", () => setPlayerBuffering(false));
  els.video?.addEventListener("error", () => {
    setPlayerBuffering(false);
    setPlayerError("This codec may not play in-app. Use the system player or open the folder.");
  });

  // Double-tap left/right zones for ±10s
  document.querySelectorAll("#playerTapZones .tap-zone").forEach((zone) => {
    zone.addEventListener("click", () => {
      const side = zone.classList.contains("left") ? "left" : "right";
      const now = Date.now();
      if (playerState.lastTap.side === side && now - playerState.lastTap.at < 320) {
        seekPlayerBy(side === "left" ? -10 : 10);
        playerState.lastTap = { side: null, at: 0 };
      } else {
        playerState.lastTap = { side, at: now };
        // Single tap toggles play/pause with a short delay so double-tap can win
        clearTimeout(zone._singleTimer);
        zone._singleTimer = setTimeout(() => {
          if (playerState.lastTap.side !== side) return;
          if (!els.video) return;
          if (els.video.paused) els.video.play().catch(() => {});
          else els.video.pause();
          playerState.lastTap = { side: null, at: 0 };
        }, 280);
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (els.modal.hidden) return;
    if (event.key === "Escape") closePlayer();
    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      if (!els.video) return;
      if (els.video.paused) els.video.play().catch(() => {});
      else els.video.pause();
    }
    if (event.key === "ArrowRight") seekPlayerBy(10);
    if (event.key === "ArrowLeft") seekPlayerBy(-10);
    if (event.key.toLowerCase() === "f") togglePlayerFullscreen();
    if (event.key.toLowerCase() === "m") {
      if (!els.video) return;
      els.video.muted = !els.video.muted;
      syncMuteButton();
    }
  });
}

window.api.onProgress((data) => {
  if (!data?.id) return;
  const prev = activeDownloads.get(data.id) || { id: data.id, title: data.title || "Download" };
  activeDownloads.set(data.id, {
    ...prev,
    title: data.title || prev.title,
    magnet: data.magnet || prev.magnet,
    progress: Number(data.progress || 0),
    speed: Number(data.speed || 0),
    speedBps: data.speedBps != null ? Number(data.speedBps) : Number(data.speed || 0) * 1024 * 1024,
    downloaded: data.downloaded || 0,
    total: data.total || 0,
    peers: data.peers || 0,
    done: Boolean(data.done) || Number(data.progress) >= 100,
    paused: false,
    status: data.status || null,
  });
  persistDownloadsUi();
  updateBadge();
  updateNetworkSpeedDisplay();
  if (!document.getElementById("tvDetailsModal")?.hidden && tvDetailsState.show) renderTvEpisodes();

  if (currentPageName === "downloads") {
    const bar = document.getElementById(`bar-${data.id}`);
    if (!bar) {
      renderDownloadsPage();
      return;
    }
    const percentText = document.getElementById(`percent-${data.id}`);
    const speedText = document.getElementById(`speed-${data.id}`);
    const sizeText = document.getElementById(`size-${data.id}`);
    if (bar) bar.style.width = `${data.progress}%`;
    if (percentText) percentText.innerText = `${data.progress}%`;
    if (speedText) {
      speedText.innerText = data.status
        ? data.status
        : `${formatSpeed(
            data.speedBps != null ? data.speedBps : Number(data.speed || 0) * 1024 * 1024
          )} · ${data.peers || 0} peers`;
    }
    if (sizeText && data.total) {
      sizeText.innerText = `${formatBytes(data.downloaded)} / ${formatBytes(data.total)}`;
    } else if (sizeText && data.status) {
      sizeText.innerText = data.status;
    }
  }
  if (!document.getElementById("tvDetailsModal")?.hidden && tvDetailsState.show) renderTvEpisodes();
});

window.api.onComplete((data) => {
  const prev = activeDownloads.get(data.id) || { id: data.id, title: data.title };
  activeDownloads.set(data.id, {
    ...prev,
    title: data.title || prev.title,
    filePath: data.path,
    progress: 100,
    done: true,
    speed: 0,
  });
  persistDownloadsUi();
  updateBadge();
  if (currentPageName === "downloads") renderDownloadsPage();
  if (!document.getElementById("tvDetailsModal")?.hidden && tvDetailsState.show) renderTvEpisodes();

  try {
    new Notification("Download Finished", { body: data.title });
  } catch {}
});

window.api.onStarted((data) => {
  const torrent = activeDownloads.get(data.id) || { id: data.id };
  torrent.magnet = data.magnet;
  activeDownloads.set(data.id, torrent);
  persistDownloadsUi();
  if (currentPageName === "downloads") renderDownloadsPage();
});

window.api.onError((data) => {
  const torrent = activeDownloads.get(data.id);
  showToast(
    "Download failed",
    data.message || "Could not start this torrent",
    "info",
    "fa-triangle-exclamation"
  );
  if (torrent) {
    // Drop dead entries so Downloads doesn't stay stuck at Starting forever.
    removeDownloadCard(data.id);
  }
});

if (window.api.onRestore) {
  window.api.onRestore((savedList) => {
    restoreDownloadCards(savedList);
  });
}

if (window.api.onPreviewRequest) {
  window.api.onPreviewRequest((data) => {
    if (data?.id) openInAppPlayer(data.id);
  });
}

function restoreDownloadCards(savedList) {
  (savedList || []).forEach((item) => {
    const prev = activeDownloads.get(item.id) || {};
    activeDownloads.set(item.id, { ...prev, ...item, done: false, paused: false });
  });
  persistDownloadsUi();
  updateBadge();
  if (currentPageName === "downloads") renderDownloadsPage();
}
