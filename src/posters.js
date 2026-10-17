/**
 * Poster resolution chain:
 * TMDB → Watchmode → Streaming API → OMDb → TVMaze → iTunes → Wikipedia
 * Never permanently cache misses so retries can succeed.
 */

function createPosterResolver({
  TMDB_API_KEY,
  WATCHMODE_API_KEY,
  STREAMING_API_KEY,
  OMDB_API_KEY,
  posterCache,
  posterInflight,
  readDiskCacheEntry,
  readAnyDiskCacheEntry,
  isOnline,
  writeDiskCacheEntry,
  POSTER_CACHE_DB,
  POSTER_CACHE_TTL,
}) {
  let watchmodeUnavailable = false;
  let watchmodeQueue = Promise.resolve();
  let watchmodeLastCallAt = 0;

  function normalizePosterQuery(title) {
    return String(title || "")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(
        /\b(s\d{1,2}e\d{1,3}|season\s*\d+|episode\s*\d+|1080p|720p|480p|2160p|4k|x264|x265|h264|h265|hevc|avc|aac|web|webrip|webdl|bluray|hdrip|brrip|dvdrip|hdtv|torrent|repack|proper|complete|multi|audio|dual|dubbed|subbed|yify|yt|amz|nf|dsnp|hulu|mkv|mp4|avi|xvid)\b/gi,
        " "
      )
      .replace(/[._\-\[\]()/|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function buildPosterQueryVariants(title, searchHint) {
    const raw = String(title || "").trim();
    const hint = String(searchHint || "").trim();
    const variants = [];

    const push = (value) => {
      const cleaned = normalizePosterQuery(value);
      if (!cleaned) return;
      const short = cleaned.split(" ").slice(0, 6).join(" ");
      if (short && !variants.includes(short)) variants.push(short);
      const shorter = cleaned.split(" ").slice(0, 3).join(" ");
      if (shorter && !variants.includes(shorter)) variants.push(shorter);
      const first = cleaned.split(" ")[0];
      if (first && first.length > 2 && !variants.includes(first)) variants.push(first);
    };

    if (hint) push(hint);
    const beforeEpisode = raw.split(/\bS\d{1,2}E\d{1,3}\b/i)[0];
    push(beforeEpisode || raw);
    push(raw);
    return variants;
  }

  async function fetchPosterFromTmdb(title, imdbId) {
    if (!TMDB_API_KEY) return null;

    if (imdbId) {
      const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
      const findRes = await fetch(findUrl);
      if (findRes.ok) {
        const findData = await findRes.json();
        const media = findData.movie_results?.[0] || findData.tv_results?.[0];
        if (media?.poster_path) return `https://image.tmdb.org/t/p/w500${media.poster_path}`;
      }
    }

    if (!title) return null;
    const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&include_adult=false&page=1`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const hit = (searchData.results || []).find(
      (result) => result.poster_path && (result.media_type === "movie" || result.media_type === "tv")
    );
    return hit?.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null;
  }

  async function fetchPosterFromWatchmode(title) {
    if (!WATCHMODE_API_KEY || watchmodeUnavailable || !title) return null;

    const run = watchmodeQueue.then(async () => {
      const waitMs = Math.max(0, 400 - (Date.now() - watchmodeLastCallAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      watchmodeLastCallAt = Date.now();

      const url = new URL("https://api.watchmode.com/v1/autocomplete-search/");
      url.searchParams.set("search_value", title);
      url.searchParams.set("search_type", "2");

      const response = await fetch(url, {
        headers: { "X-API-Key": WATCHMODE_API_KEY },
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) watchmodeUnavailable = true;
        if (response.status === 429) await new Promise((resolve) => setTimeout(resolve, 1500));
        throw new Error(`Watchmode failed (${response.status})`);
      }

      const data = await response.json();
      return (
        data.results?.find((result) => result.result_type === "title" && result.image_url)
          ?.image_url || null
      );
    });

    watchmodeQueue = run.catch(() => null);
    return run;
  }

  async function fetchPosterFromStreamingApi(title) {
    if (!STREAMING_API_KEY || !title) return null;

    const url = new URL("https://streaming-availability.p.rapidapi.com/shows/search/title");
    url.searchParams.set("country", "us");
    url.searchParams.set("title", title);
    url.searchParams.set("series_granularity", "show");
    url.searchParams.set("show_type", "all");
    url.searchParams.set("output_language", "en");

    const response = await fetch(url, {
      headers: {
        "x-rapidapi-key": STREAMING_API_KEY,
        "x-rapidapi-host": "streaming-availability.p.rapidapi.com",
      },
    });
    if (!response.ok) return null;

    const data = await response.json();
    const show = Array.isArray(data) ? data[0] : null;
    return (
      show?.imageSet?.verticalPoster?.w720 ||
      show?.imageSet?.verticalPoster?.w480 ||
      show?.imageSet?.verticalPoster?.w360 ||
      show?.poster ||
      show?.image ||
      null
    );
  }

  async function fetchPosterFromOmdb(title, imdbId) {
    if (!OMDB_API_KEY) return null;
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("apikey", OMDB_API_KEY);
    if (imdbId) url.searchParams.set("i", imdbId);
    else url.searchParams.set("t", title);

    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.Response === "False") return null;
    if (data?.Poster && data.Poster !== "N/A") return data.Poster;
    return null;
  }

  async function fetchPosterFromTvMaze(title) {
    if (!title) return null;
    const url = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data?.image?.original || data?.image?.medium || null;
  }

  async function fetchPosterFromItunes(title) {
    if (!title) return null;
    for (const media of ["tvShow", "movie"]) {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=${media}&limit=5`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      const art = (data.results || []).find((item) => item.artworkUrl100)?.artworkUrl100;
      if (art) return art.replace(/100x100bb/i, "600x600bb").replace(/60x60bb/i, "600x600bb");
    }
    return null;
  }

  async function fetchPosterFromWikipedia(title) {
    if (!title) return null;
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.originalimage?.source || data?.thumbnail?.source || null;
  }

  function withTimeout(promise, ms = 2500) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  }

  async function firstValidPoster(jobs) {
    return new Promise((resolve) => {
      if (!jobs.length) {
        resolve(null);
        return;
      }
      let pending = jobs.length;
      let settled = false;
      for (const job of jobs) {
        Promise.resolve()
          .then(job)
          .then((url) => {
            if (settled) return;
            if (url && /^https?:\/\//i.test(url)) {
              settled = true;
              resolve(url);
              return;
            }
            pending -= 1;
            if (pending <= 0) resolve(null);
          })
          .catch(() => {
            if (settled) return;
            pending -= 1;
            if (pending <= 0) resolve(null);
          });
      }
    });
  }

  async function resolvePoster({ title, imdb, searchHint, offline = false }) {
    const variants = buildPosterQueryVariants(title, searchHint);
    const cacheKey = `${imdb || ""}|${variants[0] || normalizePosterQuery(title)}`;
    if (!variants.length && !imdb) return null;

    const memoryHit = posterCache.get(cacheKey);
    if (memoryHit?.url && Date.now() - memoryHit.timestamp < POSTER_CACHE_TTL) {
      return memoryHit.url;
    }

    const diskHit = readDiskCacheEntry(POSTER_CACHE_DB, cacheKey, POSTER_CACHE_TTL);
    if (diskHit) {
      posterCache.set(cacheKey, { timestamp: Date.now(), url: diskHit });
      return diskHit;
    }

    if (offline || !isOnline()) {
      const offlineHit = readAnyDiskCacheEntry(POSTER_CACHE_DB, cacheKey);
      if (offlineHit) return offlineHit;
      return null;
    }

    if (posterInflight.has(cacheKey)) return posterInflight.get(cacheKey);

    const task = (async () => {
      // Race fast providers first so posters don't wait on slow/rate-limited APIs.
      for (const query of variants.slice(0, 2)) {
        const fastUrl = await firstValidPoster([
          () => withTimeout(fetchPosterFromTmdb(query, imdb), 3000),
          () => withTimeout(fetchPosterFromOmdb(query, imdb), 2500),
          () => withTimeout(fetchPosterFromTvMaze(query), 2500),
          () => withTimeout(fetchPosterFromItunes(query), 2500),
        ]);
        if (fastUrl) {
          posterCache.set(cacheKey, { timestamp: Date.now(), url: fastUrl });
          writeDiskCacheEntry(POSTER_CACHE_DB, cacheKey, fastUrl, POSTER_CACHE_TTL);
          return fastUrl;
        }
      }

      for (const query of variants.slice(0, 2)) {
        const slowUrl = await firstValidPoster([
          () => withTimeout(fetchPosterFromWatchmode(query), 3000),
          () => withTimeout(fetchPosterFromStreamingApi(query), 3000),
          () => withTimeout(fetchPosterFromWikipedia(query), 2500),
        ]);
        if (slowUrl) {
          posterCache.set(cacheKey, { timestamp: Date.now(), url: slowUrl });
          writeDiskCacheEntry(POSTER_CACHE_DB, cacheKey, slowUrl, POSTER_CACHE_TTL);
          return slowUrl;
        }
      }

      // Do not persist null — allow future retries
      posterCache.set(cacheKey, { timestamp: Date.now(), url: null });
      return null;
    })();

    posterInflight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      posterInflight.delete(cacheKey);
    }
  }

  return { resolvePoster, normalizePosterQuery };
}

module.exports = { createPosterResolver };
