"use strict";

/**
 * TVMaze API client (https://api.tvmaze.com).
 * Public endpoints need no key; TVMAZE_API_KEY is sent when configured.
 */

const axios = require("axios");
const env = require("../config/env");

const tvmaze = axios.create({
  baseURL: env.tvmazeBaseUrl,
  timeout: env.requestTimeoutMs,
  headers: env.tvmazeApiKey ? { "X-API-Key": env.tvmazeApiKey } : {},
});

/** TVMaze 404 → null (title/id simply not present) instead of an exception. */
function normalizeAxiosError(error, context) {
  if (error.response?.status === 404) return null;
  if (error.response) {
    return new Error(`TVMaze ${context} failed with HTTP ${error.response.status}`);
  }
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
    return new Error(`TVMaze ${context} timed out after ${env.requestTimeoutMs}ms`);
  }
  return new Error(`TVMaze ${context} failed: ${error.message}`);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Flattens a raw TVMaze show object into the JSONB payload we persist. */
function formatShowPayload(raw, episodes = null) {
  if (!raw || !raw.id) return null;
  const summary = stripHtml(raw.summary);
  return {
    provider: "tvmaze",
    externalId: raw.id,
    title: raw.name || "Untitled",
    mediaType: "tv",
    url: raw.url || `https://www.tvmaze.com/shows/${raw.id}`,
    language: raw.language || null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    status: raw.status || null,
    premiered: raw.premiered || null,
    ended: raw.ended || null,
    runtime: raw.averageRuntime ?? raw.runtime ?? null,
    officialSite: raw.officialSite || null,
    rating: raw.rating?.average ?? null,
    weight: raw.weight ?? null,
    network: raw.network
      ? { id: raw.network.id, name: raw.network.name, country: raw.network.country?.code || null }
      : raw.webChannel
        ? { id: raw.webChannel.id, name: raw.webChannel.name, country: raw.webChannel.country?.code || null }
        : null,
    image: { medium: raw.image?.medium || null, original: raw.image?.original || null },
    externals: { imdb: raw.externals?.imdb || null, thetvdb: raw.externals?.thetvdb ?? null },
    summary,
    summaryHtml: raw.summary || null,
    episodeCount: Array.isArray(episodes) ? episodes.length : null,
    fetchedAt: new Date().toISOString(),
  };
}

/** GET /search/shows?q=… → [{ score, show }] */
async function searchShows(query, limit = 10) {
  const term = String(query || "").trim();
  if (!term) return [];
  try {
    const { data } = await tvmaze.get("/search/shows", { params: { q: term } });
    return (Array.isArray(data) ? data : []).slice(0, limit);
  } catch (error) {
    const normalized = normalizeAxiosError(error, `search for "${term}"`);
    if (normalized === null) return []; // TVMaze 404 → no results
    throw normalized;
  }
}

/** GET /shows/:id — returns null when TVMaze does not know the id (404). */
async function getShowById(externalId) {
  try {
    const { data } = await tvmaze.get(`/shows/${Number(externalId)}`);
    return data || null;
  } catch (error) {
    const normalized = normalizeAxiosError(error, `lookup for show ${externalId}`);
    if (normalized === null) return null; // TVMaze 404 → show not present
    throw normalized;
  }
}

/** GET /shows/:id?embed=episodes — one call, episodes embedded; null on 404. */
async function getShowWithEpisodes(externalId) {
  try {
    const { data } = await tvmaze.get(`/shows/${Number(externalId)}`, {
      params: { embed: "episodes" },
    });
    if (!data) return null;
    const { _embedded, ...show } = data;
    return { show, episodes: _embedded?.episodes || [] };
  } catch (error) {
    const normalized = normalizeAxiosError(error, `lookup for show ${externalId}`);
    if (normalized === null) return null; // TVMaze 404 → show not present
    throw normalized;
  }
}

/**
 * Full provider payload for one show: normalized `details` for JSONB storage.
 * Returns null when TVMaze does not know the id.
 */
async function fetchShowPayload(externalId) {
  const result = await getShowWithEpisodes(externalId);
  if (!result) return null;
  return formatShowPayload(result.show, result.episodes);
}

/** Resolves a human title to the best matching TVMaze show payload. */
async function fetchShowPayloadByTitle(title) {
  const matches = await searchShows(title, 5);
  if (!matches.length) return null;
  const best = matches.find((entry) => entry?.show?.id) || null;
  if (!best) return null;
  const payload = await fetchShowPayload(best.show.id);
  if (payload) payload.searchScore = best.score ?? null;
  return payload;
}

module.exports = {
  searchShows,
  getShowById,
  getShowWithEpisodes,
  fetchShowPayload,
  fetchShowPayloadByTitle,
  formatShowPayload,
  stripHtml,
};