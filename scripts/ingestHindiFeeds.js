#!/usr/bin/env node
"use strict";

/**
 * Pull Hindi Dubbed and Dual Audio listings from indexer category searches
 * and upsert magnets into media_sources.
 *
 *   npm run ingest:hindi
 *   npm run ingest:hindi -- --pages 12 --dry-run
 *   npm run ingest:hindi -- --self-test
 *
 * There is no catalog_titles table. Title rows are matched or created in media_content.
 * TorrentGalaxy is requested and skipped when this indexer package does not ship it.
 */

const crypto = require("crypto");
const TorrentSearchApi = require("torrent-search-api");

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { formatSize, parseByteSize, magnetWrite } = require("../server/services/torrentResolver");

const MIN_BYTES = 600 * 1024 * 1024;
const MIN_SEEDERS = 2;
const DEFAULT_PAGES = 12;
const PAGE_SIZE = 20;
const MAGNET_TIMEOUT_MS = 4000;
const FEED_TIMEOUT_MS = 45000;

const PROVIDERS = ["1337x", "TorrentGalaxy", "Limetorrents"];
const FEEDS = [
  { label: "Bollywood / Indian Cinema", query: "bollywood hindi", category: "Movies" },
  { label: "Hollywood Dubbed in Hindi", query: "hindi dubbed", category: "Movies" },
  { label: "Dual / Multi Audio", query: "dual audio", category: "Movies" },
  { label: "Pakistani / Urdu Cinema", query: "urdu", category: "Movies" },
  { label: "Bollywood / Indian Cinema", query: "bollywood hindi", category: "TV" },
  { label: "Hollywood Dubbed in Hindi", query: "hindi dubbed", category: "TV" },
  { label: "Dual / Multi Audio", query: "dual audio hindi", category: "TV" },
  { label: "Pakistani / Urdu Series", query: "urdu", category: "TV" },
];

const JUNK_RE = /\b(sample|trailer|teaser|clip|camrip|telesync|screener)\b/i;
const DUAL_RE = /\bdual\b|\bmulti\b/i;
const HINDI_RE = /\bhindi\b|\bhin\b|\bdubbed\b|\borg\s*dd\b|\bdha\b/i;
const QUALITY_RE = /\b(2160p|1080p|720p|480p|4k|uhd)\b/i;
const YEAR_RE = /\b(19[9]\d|20[0-2]\d)\b/;
const TAG_RE =
  /\b(2160p|1080p|720p|480p|4k|uhd|web[\s-]*dl|bluray|blu[\s-]*ray|hdrip|webrip|hdtv|x264|x265|hevc|h264|aac|ac3|dts|dd|5\.1|hindi|hin|dual|multi|dubbed|audio|org|proper|repack|extended|unrated|remastered)\b/gi;

function parseArgs(argv) {
  const args = { pages: DEFAULT_PAGES, dryRun: false, selfTest: false, providers: PROVIDERS };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--self-test") args.selfTest = true;
    else if (token === "--pages") args.pages = Math.max(10, Math.min(20, Number(argv[++i]) || DEFAULT_PAGES));
    else if (token === "--providers") {
      args.providers = String(argv[++i] || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    } else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function detectQuality(text) {
  const match = QUALITY_RE.exec(String(text || ""));
  if (!match) return "";
  const token = match[1].toLowerCase();
  if (token === "4k" || token === "uhd" || token === "2160p") return "2160p";
  return token;
}

function detectLanguage(text) {
  const value = String(text || "");
  if (!HINDI_RE.test(value) && !DUAL_RE.test(value)) return "";
  if (DUAL_RE.test(value)) return "Dual Audio";
  return "Hindi";
}

function releaseYear(text) {
  const match = YEAR_RE.exec(String(text || ""));
  if (!match) return "";
  const year = Number(match[1]);
  if (year < 1990 || year > 2026) return "";
  return match[1];
}

function cleanTitleFrom(raw, year) {
  let text = String(raw || "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  if (year) {
    const at = text.search(new RegExp(`\\b${year}\\b`));
    if (at > 0) text = text.slice(0, at);
  }
  return text.replace(TAG_RE, " ").replace(/\s+/g, " ").trim();
}

function mediaKind(title) {
  const text = String(title || "");
  if (/\bS\d{1,2}\s*E\d{1,2}\b/i.test(text)) return "tv";
  if (/\b(season\s*\d+|complete(?:\s+(?:series|season))?)\b/i.test(text)) return "tv";
  return "movie";
}

/** Parse one indexer title. Returns null when it is junk, too small, or not a Hindi/Dual release. */
function parseRelease(item) {
  const raw = String(item?.title || "").trim();
  if (!raw || JUNK_RE.test(raw)) return null;
  const seeders = Number(item.seeds ?? item.seeders ?? item.seed);
  if (!Number.isFinite(seeders) || seeders < MIN_SEEDERS) return null;
  const sizeBytes = parseByteSize(item.size_bytes, item.size, raw);
  if (!sizeBytes || sizeBytes < MIN_BYTES) return null;
  const language = detectLanguage(raw);
  const quality = detectQuality(raw);
  if (!language || !quality) return null;
  const year = releaseYear(raw);
  const cleanTitle = cleanTitleFrom(raw, year);
  if (cleanTitle.length < 2) return null;
  return {
    cleanTitle,
    year,
    quality,
    language,
    sizeBytes,
    sizeHuman: formatSize(sizeBytes),
    seeders,
    mediaType: mediaKind(raw),
    raw,
  };
}

function infoHash(magnet) {
  const match = /btih:([a-z0-9]{32,40})/i.exec(String(magnet || ""));
  return match ? match[1].toLowerCase() : "";
}

function feedExternalId(title, year, mediaType) {
  const digest = crypto.createHash("sha1").update(`${mediaType}|${year}|${title.toLowerCase()}`).digest();
  const value = digest.readUInt32BE(0) % 2000000000;
  return value || 1;
}

function yearOfRow(row) {
  const details = row?.details || {};
  const raw = details.year || details.release_date || details.first_air_date || details.premiered || "";
  return String(raw).match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
}

function enableProviders(names) {
  const active = [];
  for (const name of names) {
    try {
      TorrentSearchApi.enableProvider(name);
      active.push(name);
    } catch {
      console.log(`[ingest] provider unavailable, skipped: ${name}`);
    }
  }
  return active;
}

async function searchFeed(provider, feed, pages) {
  const limit = Math.max(1, pages) * PAGE_SIZE;
  const rows = await withTimeout(
    TorrentSearchApi.search([provider], feed.query, feed.category, limit),
    FEED_TIMEOUT_MS,
    []
  );
  return Array.isArray(rows) ? rows : [];
}

async function readMagnet(item) {
  const direct = String(item?.magnet || item?.link || "").trim();
  if (/^magnet:/i.test(direct)) return direct;
  const magnet = await withTimeout(TorrentSearchApi.getMagnet(item), MAGNET_TIMEOUT_MS, "");
  return /^magnet:/i.test(String(magnet || "")) ? String(magnet) : "";
}

async function findContent(supabase, title, year) {
  const { data, error } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select("external_id, title, source, media_type, details")
    .ilike("title", title)
    .limit(8);
  if (error) throw new Error(error.message);
  const exact = (data || []).filter((row) => String(row.title || "").trim().toLowerCase() === title.toLowerCase());
  if (year) {
    const dated = exact.find((row) => yearOfRow(row) === year);
    if (dated) return dated;
  }
  return exact[0] || null;
}

async function ensureContent(supabase, parsed) {
  const existing = await findContent(supabase, parsed.cleanTitle, parsed.year);
  if (existing?.external_id != null) return String(existing.external_id);
  const externalId = feedExternalId(parsed.cleanTitle, parsed.year, parsed.mediaType);
  const row = {
    source: "feed",
    media_type: parsed.mediaType,
    external_id: externalId,
    title: parsed.cleanTitle.slice(0, 255),
    details: {
      title: parsed.cleanTitle,
      year: parsed.year || null,
      provider: "hindi-feed",
      mediaType: parsed.mediaType,
    },
  };
  const { error } = await supabase.from(MEDIA_CONTENT_TABLE).upsert(row, { onConflict: "source,media_type,external_id" });
  if (error) throw new Error(error.message);
  return String(externalId);
}

async function magnetExists(supabase, magnet) {
  const byMagnet = await supabase.from(MEDIA_SOURCES_TABLE).select("id").eq("magnet_link", magnet).limit(1);
  if (byMagnet.error) throw new Error(byMagnet.error.message);
  if (byMagnet.data?.length) return true;
  const byDownload = await supabase.from(MEDIA_SOURCES_TABLE).select("id").eq("download_url", magnet).limit(1);
  if (byDownload.error) throw new Error(byDownload.error.message);
  return Boolean(byDownload.data?.length);
}

async function saveSource(supabase, mediaId, parsed, magnet) {
  const written = magnetWrite(magnet);
  if (!written) return false;
  const row = {
    cache_key: [mediaId, parsed.cleanTitle.toLowerCase(), parsed.year || "-", parsed.language.toLowerCase(), parsed.quality.toLowerCase()].join("::"),
    media_id: mediaId,
    media_title: parsed.cleanTitle.slice(0, 255),
    year: parsed.year || null,
    language: parsed.language,
    quality: parsed.quality,
    source_type: written.source_type,
    download_url: written.download_url,
    stream_url: written.stream_url,
    magnet_link: written.magnet_link,
    seeders: parsed.seeders,
    size_human: parsed.sizeHuman,
    size_bytes: parsed.sizeBytes,
    is_fallback: false,
    status: "ready",
    updated_at: new Date().toISOString(),
    payload: {
      title: parsed.raw,
      language_label: parsed.language,
      size_human: parsed.sizeHuman,
      size_bytes: parsed.sizeBytes,
      provider: "hindi-feed",
      resolvedAt: new Date().toISOString(),
    },
  };
  let { error } = await supabase.from(MEDIA_SOURCES_TABLE).upsert(row, { onConflict: "media_id,quality,language" });
  if (error && /size_human|size_bytes/i.test(error.message || "")) {
    const withoutSize = { ...row };
    delete withoutSize.size_human;
    delete withoutSize.size_bytes;
    ({ error } = await supabase.from(MEDIA_SOURCES_TABLE).upsert(withoutSize, { onConflict: "media_id,quality,language" }));
  }
  if (error) throw new Error(error.message);
  return true;
}

function runSelfTest() {
  const dubbed = parseRelease({
    title: "Inception.2010.1080p.BluRay.Hindi.Dubbed.x264-YIFY",
    seeds: 40,
    size: "1.4 GB",
  });
  const dual = parseRelease({
    title: "Parasite 2019 720p Dual Audio WEB-DL",
    seeds: 8,
    size: "900 MB",
  });
  const checks = [
    ["dubbed title is Inception", dubbed?.cleanTitle === "Inception" && dubbed?.year === "2010"],
    ["dubbed quality and language", dubbed?.quality === "1080p" && dubbed?.language === "Hindi"],
    ["dual audio stays Dual Audio", dual?.language === "Dual Audio" && dual?.quality === "720p" && dual?.cleanTitle === "Parasite"],
    ["4K maps to 2160p", detectQuality("Film 2024 4K Hindi Dubbed") === "2160p"],
    ["trailer is discarded", parseRelease({ title: "Inception 2010 1080p Hindi trailer", seeds: 20, size: "1 GB" }) == null],
    ["file under 600 MB is discarded", parseRelease({ title: "Film 2020 720p Hindi Dubbed", seeds: 9, size: "80 MB" }) == null],
    ["one seeder is discarded", parseRelease({ title: "Film 2020 1080p Hindi Dubbed", seeds: 1, size: "1.2 GB" }) == null],
    ["english-only release is discarded", parseRelease({ title: "Film 2020 1080p BluRay x264", seeds: 20, size: "1.6 GB" }) == null],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} | ${label}`);
  }
  if (failed) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("Usage: npm run ingest:hindi -- [--pages 12] [--dry-run] [--providers 1337x,Limetorrents]");
    return;
  }
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const providers = enableProviders(args.providers);
  if (!providers.length) {
    console.error("[ingest] no indexer providers are available");
    process.exitCode = 1;
    return;
  }

  const supabase = args.dryRun ? null : getSupabaseClient();
  const seen = new Set();
  const totals = { scanned: 0, kept: 0, saved: 0, duplicates: 0, skipped: 0 };
  console.log(`[ingest] providers ${providers.join(", ")} · ${args.pages} pages per feed${args.dryRun ? " · dry-run" : ""}`);

  for (const provider of providers) {
    for (const feed of FEEDS) {
      console.log(`[ingest] ${provider} · ${feed.label} · ${feed.category} · "${feed.query}"`);
      let rows = [];
      try {
        rows = await searchFeed(provider, feed, args.pages);
      } catch (error) {
        console.warn(`[ingest] ${provider} ${feed.label} failed: ${error.message}`);
        continue;
      }
      totals.scanned += rows.length;
      console.log(`[ingest] ${provider} returned ${rows.length} listings`);
      for (const item of rows) {
        const parsed = parseRelease(item);
        if (!parsed) {
          totals.skipped += 1;
          continue;
        }
        const magnet = await readMagnet(item);
        const hash = infoHash(magnet);
        if (!hash) {
          totals.skipped += 1;
          continue;
        }
        if (seen.has(hash)) {
          totals.duplicates += 1;
          continue;
        }
        seen.add(hash);
        totals.kept += 1;
        if (args.dryRun) {
          console.log(`[ingest] dry-run ${parsed.cleanTitle} ${parsed.year || "?"} ${parsed.quality} ${parsed.language} · ${parsed.seeders} seeders · ${parsed.sizeHuman}`);
          continue;
        }
        try {
          if (await magnetExists(supabase, magnet)) {
            totals.duplicates += 1;
            continue;
          }
          const mediaId = await ensureContent(supabase, parsed);
          const wrote = await saveSource(supabase, mediaId, parsed, magnet);
          if (wrote) {
            totals.saved += 1;
            console.log(`[ingest] saved ${parsed.cleanTitle} ${parsed.year || "?"} ${parsed.quality} ${parsed.language} · ${parsed.seeders} seeders · ${parsed.sizeHuman}`);
          }
        } catch (error) {
          totals.skipped += 1;
          console.warn(`[ingest] save skipped for ${parsed.cleanTitle}: ${error.message}`);
        }
      }
    }
  }

  console.log(
    `[ingest] done · scanned ${totals.scanned} · kept ${totals.kept} · saved ${totals.saved} · duplicates ${totals.duplicates} · skipped ${totals.skipped}`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ingest] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseRelease, detectQuality, detectLanguage, cleanTitleFrom };
