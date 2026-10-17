"use strict";

/**
 * Persistent torrent + episode library (LIST B: B1, B4, B5, B6).
 * ---------------------------------------------------------------------------
 * Tables (migration 20260923160000_create_media_torrents_episodes.sql):
 *   media_torrents — magnet/link/provider/quality/seeds per title or episode.
 *   media_episodes — structured TV episode rows (season/episode scoped).
 *
 * Contract (same as mediaItemStore):
 *   1. NEVER throws — every function degrades to null / [] when Supabase is
 *      unconfigured, unreachable or the migration has not been applied yet.
 *   2. No duplicates — upserts are keyed on UNIQUE columns
 *      (media_torrents.dedupe_key, media_episodes scope constraint), so a
 *      re-search REFRESHES seeds (B6) instead of inserting a second row.
 *   3. media_content.details is only ever merged (never replaced) by
 *      markChecked() — torrent markers (B3 language availability, B5 parts,
 *      torrentsCheckedAt) are added alongside the existing metadata.
 *
 * Usage (src/main.js + scripts/test-torrent-db.js):
 *   const lib = createTorrentLibrary({ getClient: () => supabaseClient });
 *   await lib.saveTorrents(rows);            // upsert (refresh seeds)
 *   await lib.getTorrents({ query, ... });   // DB fallback for downloads
 */

const { parseTorrentReleaseMeta } = require("./torrentSearch");

const MEDIA_TORRENTS_TABLE = "media_torrents";
const MEDIA_EPISODES_TABLE = "media_episodes";
const MEDIA_CONTENT_TABLE = "media_content";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalised UNIQUE key — one row per release per scope. */
function buildDedupeKey({ source = "tmdb", mediaType, externalId, season = -1, episode = -1, title }) {
  const normTitle = String(title || "")
    .toLowerCase()
    .replace(/[.\-_[\]()+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    source,
    mediaType,
    Number(externalId),
    Number.isFinite(Number(season)) ? Number(season) : -1,
    Number.isFinite(Number(episode)) ? Number(episode) : -1,
    normTitle,
  ].join("|");
}

function toScopeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Map a torrent-search-api result to a media_torrents row.
 * Parses quality / language tags / multi-part number out of the release
 * title (B3 + B5) and stamps last_refreshed_at (B6).
 */
function searchResultToRow(item, scope = {}) {
  const title = String(item?.title || "").trim().slice(0, 500);
  if (!title) return null;
  const externalId = Number(scope.externalId ?? scope.external_id);
  if (!Number.isInteger(externalId) || externalId <= 0) return null;
  const mediaType = scope.mediaType === "tv" ? "tv" : "movie";
  const season = mediaType === "tv" ? toScopeNumber(scope.season) : -1;
  const episode = mediaType === "tv" ? toScopeNumber(scope.episode) : -1;
  const source = scope.source || "tmdb";
  const meta = parseTorrentReleaseMeta(title);

  return {
    source,
    media_type: mediaType,
    external_id: externalId,
    season,
    episode,
    part: Number.isFinite(Number(scope.part)) && Number(scope.part) > 0 ? Number(scope.part) : meta.part,
    title,
    query_key: String(scope.queryKey || "").slice(0, 300),
    magnet: String(item?.magnet || "").startsWith("magnet:") ? item.magnet : null,
    link: item?.link || null,
    desc_url: item?.desc || null,
    provider: item?.provider ? String(item.provider).slice(0, 50) : null,
    quality: meta.quality,
    size: item?.size ? String(item.size).slice(0, 50) : null,
    seeds: Math.max(0, Number(item?.seeds) || 0),
    peers: Math.max(0, Number(item?.peers) || 0),
    language_tags: Array.isArray(meta.languageTags) ? meta.languageTags : [],
    match_score: Number(item?.matchScore) || 0,
    dedupe_key: buildDedupeKey({
      source,
      mediaType,
      externalId,
      season,
      episode,
      title,
    }),
    last_refreshed_at: new Date().toISOString(),
  };
}

/** B3 — human labels for the language-availability badge. */
function availabilityLabels(languageTags = [], originalLanguage = "") {
  const labels = new Set();
  const tags = (Array.isArray(languageTags) ? languageTags : []).map((t) =>
    String(t || "").toLowerCase()
  );
  if (tags.includes("hindi") || tags.includes("urdu")) labels.add("Hindi");
  if (tags.includes("english")) labels.add("English");
  const orig = String(originalLanguage || "").toLowerCase();
  if (orig === "en") labels.add("English");
  if (orig === "hi" || orig === "ur") labels.add("Hindi");
  labels.add("Original"); // the title's own language is always available
  return [...labels];
}

function createTorrentLibrary({ getClient, logger = console, source = "tmdb" } = {}) {
  const log = logger || console;
  const client = () => (typeof getClient === "function" ? getClient() : null) || null;

  /**
   * Upsert torrent rows (B1). Existing dedupe_key rows are REFRESHED (seeds,
   * magnet, last_refreshed_at — B6), never duplicated. Never throws.
   * @returns {Promise<{saved:number, error:string|null}>}
   */
  async function saveTorrents(rows) {
    const supabase = client();
    const rowsIn = (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.dedupe_key && row.title)
      // NOT NULL column — never forward undefined/null (property-name mismatches).
      .map((row) => ({ ...row, language_tags: Array.isArray(row.language_tags) ? row.language_tags : [] }));
    // Postgres rejects a batch where the same dedupe_key appears twice
    // ("ON CONFLICT DO UPDATE cannot affect row a second time") — keep the
    // row with the most seeds per key so one search can refresh health (B6).
    const byKey = new Map();
    for (const row of rowsIn) {
      const prev = byKey.get(row.dedupe_key);
      if (!prev || (Number(row.seeds) || 0) > (Number(prev.seeds) || 0)) byKey.set(row.dedupe_key, row);
    }
    const clean = [...byKey.values()];
    if (!supabase || !clean.length) return { saved: 0, error: supabase ? null : "no-client" };

    try {
      const chunkSize = 50;
      let saved = 0;
      for (let i = 0; i < clean.length; i += chunkSize) {
        const chunk = clean.slice(i, i + chunkSize);
        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const { error } = await supabase
            .from(MEDIA_TORRENTS_TABLE)
            .upsert(chunk, { onConflict: "dedupe_key", ignoreDuplicates: false });
          if (!error) {
            lastError = null;
            saved += chunk.length;
            break;
          }
          lastError = error;
          if (attempt < 2) await sleep(250);
        }
        if (lastError) {
          log.warn?.("[torrent library] save failed:", lastError.message);
          return { saved, error: lastError.message };
        }
      }
      return { saved, error: null };
    } catch (error) {
      log.warn?.("[torrent library] save skipped:", error?.message || error);
      return { saved: 0, error: error?.message || "save-failed" };
    }
  }

  /** Convenience: map search results → rows → upsert. Returns rows saved. */
  async function saveSearchResults(items, scope) {
    const rows = (Array.isArray(items) ? items : [])
      .map((item) => searchResultToRow(item, scope))
      .filter(Boolean);
    const result = await saveTorrents(rows);
    return { ...result, rows };
  }

  /** Row → UI shape (same fields the live torrent search returns). */
  function rowToUi(row) {
    if (!row) return null;
    return {
      title: row.title,
      magnet: row.magnet || null,
      desc: row.desc_url || null,
      link: row.link || null,
      provider: row.provider || null,
      size: row.size || null,
      seeds: Number(row.seeds) || 0,
      peers: Number(row.peers) || 0,
      quality: row.quality || null,
      part: Number(row.part) > 0 ? Number(row.part) : null,
      language_tags: Array.isArray(row.language_tags) ? row.language_tags : [],
      mediaType: row.media_type,
      tmdbId: Number(row.external_id),
      season: Number(row.season),
      episode: Number(row.episode),
      fromDb: true, // renderer shows "Queued from library" for these
    };
  }

  /** Drop noise words so "%…%" matches release titles stored in the DB. */
  function buildTitlePattern(query) {
    let q = String(query || "");
    q = q.replace(/\bS\d{1,2}\s?E\d{1,2}\b/gi, " ");
    q = q.replace(/\b(19|20)\d{2}\b/g, " ");
    q = q.replace(
      /\b(hindi|dubbed|dual|audio|english|1080p|720p|2160p|480p|4k|bluray|webrip|web-dl|x265|x264|hevc|hdts|cam|aac|atmos)\b/gi,
      " "
    );
    q = q.replace(/[()[\]]/g, " ");
    q = q.replace(/\s+/g, " ").trim();
    if (!q) return null;
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    return `%${escaped.split(" ").join("%")}%`;
  }

  /**
   * DB fallback (B1) — saved torrents for a download query.
   * Order of attempts:
   *   1. exact scope (tmdbId + season/episode) when the caller knows it
   *   2. title pattern INCLUDING episode code (e.g. "%bad%s01e01%")
   *   3. cleaned title pattern (noise words stripped)
   * Always returns [] on any failure — never throws.
   */
  async function getTorrents(options = {}) {
    const supabase = client();
    if (!supabase) return [];
    const {
      query = "",
      mediaType = null,
      externalId = null,
      season = null,
      episode = null,
      limit = 10,
      src = source,
    } = options;

    try {
      // 1) exact scope
      if (Number.isInteger(Number(externalId)) && Number(externalId) > 0) {
        let builder = supabase
          .from(MEDIA_TORRENTS_TABLE)
          .select("*")
          .eq("source", src)
          .eq("media_type", mediaType === "tv" ? "tv" : "movie")
          .eq("external_id", Number(externalId));
        if (mediaType === "tv" && Number.isInteger(Number(season)) && Number(season) >= 0) {
          builder = builder.eq("season", Number(season));
          if (Number.isInteger(Number(episode)) && Number(episode) >= 0) {
            builder = builder.eq("episode", Number(episode));
          }
        } else if (mediaType === "movie") {
          builder = builder.eq("season", -1);
        }
        const { data, error } = await builder
          .order("seeds", { ascending: false })
          .limit(Math.min(Math.max(Number(limit) || 10, 1), 50));
        if (!error && Array.isArray(data) && data.length) {
          return data.map(rowToUi).filter(Boolean);
        }
      }

      // 2) raw query with episode code, then 3) cleaned title
      const raw = String(query || "").trim();
      const rawPattern = raw ? `%${raw.replace(/[\\%_]/g, "\\$&").replace(/\s+/g, "%")}%` : null;
      const cleanPattern = buildTitlePattern(raw);
      for (const pattern of [rawPattern, cleanPattern]) {
        if (!pattern) continue;
        const { data, error } = await supabase
          .from(MEDIA_TORRENTS_TABLE)
          .select("*")
          .eq("source", src)
          .ilike("title", pattern)
          .order("seeds", { ascending: false })
          .limit(Math.min(Math.max(Number(limit) || 10, 1), 50));
        if (!error && Array.isArray(data) && data.length) {
          let rows = data;
          if (mediaType) rows = rows.filter((r) => r.media_type === (mediaType === "tv" ? "tv" : "movie"));
          if (rows.length) return rows.map(rowToUi).filter(Boolean);
        }
      }
      return [];
    } catch (error) {
      log.warn?.("[torrent library] read skipped:", error?.message || error);
      return [];
    }
  }

  /**
   * B1 — store the resolved magnet for a release.
   * Updates the existing row when the dedupe_key matches; otherwise inserts a
   * minimal new row (a click-time download whose search was never persisted).
   * Never throws.
   */
  async function saveMagnetFor(details = {}) {
    const supabase = client();
    if (!supabase) return false;
    try {
      const row = searchResultToRow(
        {
          title: details.title,
          magnet: details.magnet,
          link: details.link,
          desc: details.desc,
          provider: details.provider,
          seeds: details.seeds,
          size: details.size,
        },
        {
          mediaType: details.mediaType,
          externalId: details.externalId,
          season: details.season,
          episode: details.episode,
          source: details.source || source,
          queryKey: details.queryKey || "",
        }
      );
      if (!row?.magnet || !row.dedupe_key) return false;

      const { data, error } = await supabase
        .from(MEDIA_TORRENTS_TABLE)
        .update({
          magnet: row.magnet,
          link: row.link,
          desc_url: row.desc_url,
          provider: row.provider,
          last_refreshed_at: new Date().toISOString(),
        })
        .eq("dedupe_key", row.dedupe_key)
        .select("id");
      if (!error && Array.isArray(data) && data.length) return true;

      const { error: insertError } = await supabase
        .from(MEDIA_TORRENTS_TABLE)
        .upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: false });
      if (insertError) {
        log.warn?.("[torrent library] magnet save failed:", insertError.message);
        return false;
      }
      return true;
    } catch (error) {
      log.warn?.("[torrent library] magnet save skipped:", error?.message || error);
      return false;
    }
  }

  // ── B4: episode rows ───────────────────────────────────────────────────

  /** Upsert a season's episodes (one row per source|show|season|episode). */
  async function saveEpisodes({ showId, season, episodes = [], src = source }) {
    const supabase = client();
    const show = Number(showId);
    const seasonNo = Number(season);
    if (!supabase || !Number.isInteger(show) || show <= 0 || !Number.isFinite(seasonNo)) {
      return { saved: 0, error: "no-client" };
    }
    const rows = (Array.isArray(episodes) ? episodes : [])
      .filter((episode) => Number.isInteger(Number(episode?.number)) && Number(episode.number) > 0)
      .map((episode) => ({
        source: src,
        show_id: show,
        season: seasonNo,
        episode: Number(episode.number),
        title: String(episode.title || "").slice(0, 500),
        overview: episode.overview || null,
        air_date: episode.airDate || null,
        details: null,
      }));
    if (!rows.length) return { saved: 0, error: null };
    try {
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const { error } = await supabase
          .from(MEDIA_EPISODES_TABLE)
          .upsert(rows, { onConflict: "source,show_id,season,episode", ignoreDuplicates: true });
        if (!error) return { saved: rows.length, error: null };
        lastError = error;
        if (attempt < 2) await sleep(250);
      }
      log.warn?.("[torrent library] episode save failed:", lastError?.message);
      return { saved: 0, error: lastError?.message || "save-failed" };
    } catch (error) {
      log.warn?.("[torrent library] episode save skipped:", error?.message || error);
      return { saved: 0, error: error?.message || "save-failed" };
    }
  }

  /** Read a season's stored episode rows (newest structure for the UI). */
  async function getEpisodes({ showId, season, src = source } = {}) {
    const supabase = client();
    const show = Number(showId);
    if (!supabase || !Number.isInteger(show) || show <= 0) return [];
    try {
      let builder = supabase
        .from(MEDIA_EPISODES_TABLE)
        .select("*")
        .eq("source", src)
        .eq("show_id", show);
      if (Number.isFinite(Number(season))) builder = builder.eq("season", Number(season));
      const { data, error } = await builder.order("episode", { ascending: true }).limit(500);
      if (error || !Array.isArray(data)) return [];
      return data.map((row) => ({
        number: row.episode,
        title: row.title || "",
        airDate: row.air_date || "",
        overview: row.overview || "",
        season: row.season,
        fromDb: true,
      }));
    } catch (error) {
      log.warn?.("[torrent library] episode read skipped:", error?.message || error);
      return [];
    }
  }

  /**
   * B3/B5/B6 — stamp the torrent-check markers onto media_content.details.
   * MERGES only: existing keys are preserved; languageAvailability is a
   * union (never loses previously detected languages) and partsCount only
   * grows. Never throws.
   */
  async function markChecked({ mediaType, externalId, found = 0, languageTags = [], partsCount = 0, complete = true } = {}) {
    const supabase = client();
    const id = Number(externalId);
    const type = mediaType === "tv" ? "tv" : "movie";
    if (!supabase || !Number.isInteger(id) || id <= 0) return false;
    try {
      const { data, error } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .select("details")
        .eq("source", source)
        .eq("media_type", type)
        .eq("external_id", id)
        .maybeSingle();
      if (error || !data) return false;

      const details = { ...(data.details || {}) };
      const existingTags = new Set(
        (Array.isArray(details.torrentLanguageTags) ? details.torrentLanguageTags : []).map((t) =>
          String(t).toLowerCase()
        )
      );
      for (const tag of Array.isArray(languageTags) ? languageTags : []) {
        existingTags.add(String(tag).toLowerCase());
      }
      const tags = [...existingTags];
      if (complete !== false) details.torrentsCheckedAt = new Date().toISOString();
      details.torrentsFound = Math.max(0, Number(found) || 0);
      details.torrentLanguageTags = tags;
      details.languageAvailability = availabilityLabels(tags, details.originalLanguage || "");
      details.partsCount = Math.max(Number(details.partsCount) || 0, Number(partsCount) || 0);

      const { error: updateError } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .update({ details })
        .eq("source", source)
        .eq("media_type", type)
        .eq("external_id", id);
      if (updateError) {
        log.warn?.("[torrent library] markChecked failed:", updateError.message);
        return false;
      }
      return true;
    } catch (error) {
      log.warn?.("[torrent library] markChecked skipped:", error?.message || error);
      return false;
    }
  }

  /**
   * B3 — one lookup for the UI badges: [{tmdbId, mediaType}] →
   * { "movie:603": { languages, partsCount, torrentsFound }, … }.
   */
  async function getLanguageMap(items = []) {
    const supabase = client();
    const wanted = (Array.isArray(items) ? items : [])
      .map((item) => ({
        tmdbId: Number(item?.tmdbId),
        mediaType: item?.mediaType === "tv" ? "tv" : "movie",
      }))
      .filter((item) => Number.isInteger(item.tmdbId) && item.tmdbId > 0);
    if (!supabase || !wanted.length) return {};
    try {
      const ids = [...new Set(wanted.map((item) => item.tmdbId))];
      const { data, error } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .select("external_id, media_type, details")
        .eq("source", source)
        .in("external_id", ids)
        .limit(500);
      if (error || !Array.isArray(data)) return {};

      const byKey = new Map(data.map((row) => [`${row.media_type}:${row.external_id}`, row.details || {}]));
      const map = {};
      for (const item of wanted) {
        const details = byKey.get(`${item.mediaType}:${item.tmdbId}`);
        if (!details) continue;
        map[`${item.mediaType}:${item.tmdbId}`] = {
          languages: Array.isArray(details.languageAvailability) ? details.languageAvailability : [],
          partsCount: Number(details.partsCount) || 0,
          torrentsFound: Number(details.torrentsFound) || 0,
          checkedAt: details.torrentsCheckedAt || null,
        };
      }
      return map;
    } catch (error) {
      log.warn?.("[torrent library] language map skipped:", error?.message || error);
      return {};
    }
  }

  /**
   * B2 — items whose torrent check is missing or older than `staleHours`.
   * Scans media_content newest-first (bounded by maxScan) and filters the
   * torrentsCheckedAt marker client-side (no fragile JSONB filters).
   */
  async function listItemsMissingTorrents({ limit = 25, staleHours = 24, maxScan = 500 } = {}) {
    const supabase = client();
    if (!supabase) return [];
    try {
      const pageSize = 200;
      const maxPages = Math.max(1, Math.ceil(Math.min(maxScan, 2000) / pageSize));
      const staleMs = Math.max(1, Number(staleHours) || 24) * 60 * 60 * 1000;
      const now = Date.now();
      const neverChecked = [];
      const retryable = [];
      const staleSuccessful = [];

      for (let page = 0; page < maxPages; page += 1) {
        const from = page * pageSize;
        const { data, error } = await supabase
          .from(MEDIA_CONTENT_TABLE)
          .select("external_id, media_type, title, details")
          .eq("source", source)
          .order("updated_at", { ascending: false })
          .range(from, from + pageSize - 1);
        if (error || !Array.isArray(data) || !data.length) break;

        for (const row of data) {
          const details = row.details || {};
          const checkedAt = details.torrentsCheckedAt ? Date.parse(details.torrentsCheckedAt) : NaN;
          const externalId = Number(row.external_id);
          if (!Number.isInteger(externalId) || externalId <= 0) continue;
          const candidate = {
            externalId,
            mediaType: row.media_type === "tv" ? "tv" : "movie",
            title: row.title || details.title || "",
            year: details.year || "",
            originalLanguage: details.originalLanguage || details.original_language || "",
          };
          if (!Number.isFinite(checkedAt)) {
            neverChecked.push(candidate);
          } else if (Number(details.torrentsFound) > 0) {
            if (now - checkedAt >= staleMs) staleSuccessful.push(candidate);
          } else {
            // A zero-result scan is not a success. This also makes old rows
            // written by the previous worker eligible immediately.
            retryable.push(candidate);
          }
        }
        if (data.length < pageSize) break;
      }

      // Never starve new catalog rows behind the same permanent zero-result set.
      return [...neverChecked, ...retryable, ...staleSuccessful].slice(0, limit);
    } catch (error) {
      log.warn?.("[torrent library] backfill scan skipped:", error?.message || error);
      return [];
    }
  }

  /** Counts for tests / diagnostics. Never throws. */
  async function stats() {
    const supabase = client();
    if (!supabase) return { torrents: 0, episodes: 0, error: "no-client" };
    try {
      const torrents = await supabase.from(MEDIA_TORRENTS_TABLE).select("id", { count: "exact", head: true });
      const episodes = await supabase.from(MEDIA_EPISODES_TABLE).select("id", { count: "exact", head: true });
      return {
        torrents: torrents.count ?? 0,
        episodes: episodes.count ?? 0,
        error: torrents.error?.message || episodes.error?.message || null,
      };
    } catch (error) {
      return { torrents: 0, episodes: 0, error: error?.message || "stats-failed" };
    }
  }

  return {
    saveTorrents,
    saveSearchResults,
    getTorrents,
    saveMagnetFor,
    saveEpisodes,
    getEpisodes,
    markChecked,
    getLanguageMap,
    listItemsMissingTorrents,
    stats,
  };
}

module.exports = {
  createTorrentLibrary,
  searchResultToRow,
  buildDedupeKey,
  availabilityLabels,
  MEDIA_TORRENTS_TABLE,
  MEDIA_EPISODES_TABLE,
};
