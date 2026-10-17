#!/usr/bin/env node
"use strict";

/**
 * 🎬 Multi-Quality (1080p, 720p, 480p) Hindi & Dual Audio Enrichment Engine
 * 
 * Rules:
 * 1. 4K / 2160p is FULLY IGNORED (skipped).
 * 2. Strict Hindi & Dual Audio only (no English-only).
 * 3. Enriches 3 streamable tiers for each movie:
 *    - 1080p (FHD, max 2.8 GB)
 *    - 720p (HD, max 1.5 GB)
 *    - 480p (SD/Mobile, max 800 MB)
 * 4. Safe & fast: 4 parallel workers with checkpoint auto-resume.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");
const { discoverCascadingTorrents, cleanSearchTitle } = require("../server/services/torrentResolver");

const CONCURRENCY = 4;
const VPS_BASE_URL = process.env.BASE_URL || "http://168.144.249.68:4555";
const CHECKPOINT_FILE = path.join(__dirname, ".multi-quality-checkpoint.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSizeToBytes(str) {
  if (!str) return 0;
  const match = String(str).match(/([\d.]+)\s*(gb|mb|kb|g|m)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("g")) return val * 1024 * 1024 * 1024;
  if (unit.startsWith("m")) return val * 1024 * 1024;
  if (unit.startsWith("k")) return val * 1024;
  return 0;
}

function readCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    }
  } catch (_) {}
  return { lastId: 0, processedCount: 0, addedCount: 0 };
}

function writeCheckpoint(data) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

async function getExistingQualityMap(supabase) {
  const map = new Map(); // mediaId -> Set of existing qualities ('1080p', '720p', '480p')
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("media_id, quality, language")
      .range(offset, offset + 999);

    if (error || !data?.length) break;

    for (const r of data) {
      if (!r.media_id) continue;
      const id = String(r.media_id).trim();
      const q = String(r.quality || "").toLowerCase();
      const l = String(r.language || "").toLowerCase();
      const isHindi = l.includes("hindi") || l.includes("dual") || l.includes("urdu");
      if (!isHindi) continue;

      if (!map.has(id)) map.set(id, new Set());
      if (q.includes("1080")) map.get(id).add("1080p");
      else if (q.includes("720")) map.get(id).add("720p");
      else if (q.includes("480")) map.get(id).add("480p");
    }

    if (data.length < 1000) break;
    offset += 1000;
  }
  return map;
}

async function fetchTorrentioTiers(imdbId, title) {
  if (!imdbId && !title) return {};
  const tiers = { "1080p": null, "720p": null, "480p": null };

  if (imdbId) {
    try {
      const cleanImdb = imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;
      const res = await axios.get(`https://torrentio.strem.fun/stream/movie/${cleanImdb}.json`, { timeout: 4500 });
      const streams = res.data?.streams || [];

      for (const s of streams) {
        const raw = `${s.name || ""} ${s.title || ""}`.toLowerCase();
        const isHindi = raw.includes("hindi") || raw.includes("dual") || raw.includes("multi");
        if (!isHindi) continue;

        const seedMatch = raw.match(/👤\s*(\d+)/);
        const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 5;
        if (seeds < 3) continue;

        const sizeMatch = raw.match(/💾\s*([\d.]+\s*[gm]b)/);
        const sizeBytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : 0;
        const sizeHuman = sizeMatch ? sizeMatch[1].toUpperCase() : "";

        // STRICT SIZE CAPS: Skip oversized files
        if (sizeBytes > 3.5 * 1024 * 1024 * 1024) continue; // Skip > 3.5GB

        const magnet = s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(title || "Movie")}` : null;
        if (!magnet) continue;

        const candidate = {
          title: s.title ? s.title.split("\n")[0] : `${title} Hindi`,
          magnet_link: magnet,
          download_url: magnet,
          seeders: seeds,
          size_bytes: sizeBytes,
          size_human: sizeHuman,
        };

        if ((raw.includes("1080p") || raw.includes("fhd")) && !tiers["1080p"] && sizeBytes <= 2.8 * 1024 * 1024 * 1024) {
          tiers["1080p"] = candidate;
        } else if ((raw.includes("720p") || raw.includes("hd")) && !tiers["720p"] && sizeBytes <= 1.6 * 1024 * 1024 * 1024) {
          tiers["720p"] = candidate;
        } else if ((raw.includes("480p") || raw.includes("dvdrip") || raw.includes("sd")) && !tiers["480p"] && sizeBytes <= 800 * 1024 * 1024) {
          tiers["480p"] = candidate;
        }
      }
    } catch (_) {}
  }

  return tiers;
}

async function processMovie(movie, existingQualities = new Set()) {
  const mediaId = String(movie.external_id || movie.id);
  const details = movie.details || {};
  const title = cleanSearchTitle(movie.title || details.title);
  const year = details.year || String(details.release_date || "").slice(0, 4) || "";
  const imdbId = details.imdb_id;
  const overview = details.overview || "";
  const posterUrl = details.poster_url || (details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : "");
  const backdropUrl = details.backdrop_url || (details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : "");
  const rating = details.rating_percent || (details.vote_average ? Math.round(Number(details.vote_average) * 10) : null);

  if (!title) return { status: "skipped" };

  const neededTiers = ["1080p", "720p", "480p"].filter((q) => !existingQualities.has(q));
  if (neededTiers.length === 0) {
    return { status: "already_complete", title };
  }

  const addedTiers = [];

  // 1. First probe Torrentio for high-speed multi-quality index
  const torrentioTiers = await fetchTorrentioTiers(imdbId, title);

  for (const tier of neededTiers) {
    let chosenRelease = torrentioTiers[tier];

    // 2. If not found in Torrentio, probe 1337x / Limetorrents / YTS with strict tier query
    if (!chosenRelease) {
      try {
        const query = `${title} ${tier} Hindi`;
        const found = await discoverCascadingTorrents({
          title,
          year,
          mediaType: "movie",
          tmdbId: mediaId,
          imdbId,
          requireDubMarker: true,
          queryTimeoutMs: 3500,
          allowEmbed: false,
          queries: [query, `${title} ${tier} Dual Audio`],
        });

        if (found && found.magnet_link) {
          const bytes = Number(found.size_bytes || found.sizeBytes) || 0;
          // Apply max size caps per tier
          const maxAllowed = tier === "1080p" ? 2.8 * 1024 * 1024 * 1024 : tier === "720p" ? 1.6 * 1024 * 1024 * 1024 : 800 * 1024 * 1024;
          if (bytes <= maxAllowed || bytes === 0) {
            chosenRelease = {
              title: found.title || `${title} [${tier} Hindi]`,
              magnet_link: found.magnet_link,
              download_url: found.magnet_link,
              seeders: found.seeders || 10,
              size_bytes: bytes || null,
              size_human: found.size_human || "",
            };
          }
        }
      } catch (_) {}
    }

    // 3. Save release if found
    if (chosenRelease && chosenRelease.magnet_link) {
      try {
        await saveTorrentRelease(
          {
            mediaId,
            imdbId,
            title: movie.title,
            year,
            mediaType: "movie",
            language: "Hindi",
            quality: tier,
            overview,
            posterUrl,
            backdropUrl,
            rating,
            baseUrl: VPS_BASE_URL,
          },
          chosenRelease
        );
        addedTiers.push(tier);
      } catch (_) {}
    }
  }

  if (addedTiers.length > 0) {
    return { status: "saved", title, addedTiers };
  }
  return { status: "not_found", title };
}

async function main() {
  console.log("===============================================================================");
  console.log(" 🎬 Multi-Quality (1080p, 720p, 480p) Hindi & Dual Audio Enrichment Engine");
  console.log(" 🚫 4K IGNORED · 🎯 Tiers: 1080p, 720p, 480p · ⚡ Direct VPS Stream URLs");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  console.log("🔍 Scanning existing quality coverage in Supabase media_sources...");
  const qualityMap = await getExistingQualityMap(supabase);
  console.log(`✅ Loaded quality map for ${qualityMap.size} existing titles.\n`);

  console.log("📥 Loading movies (2000 - 2026) from media_content...");
  let movies = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, external_id, title, media_type, details")
      .eq("media_type", "movie")
      .order("id", { ascending: false })
      .range(offset, offset + 999);

    if (error || !data?.length) break;

    for (const row of data) {
      const yr = Number(row.details?.year || (row.details?.release_date || "").slice(0, 4));
      if (yr >= 2000 && yr <= 2026) {
        movies.push(row);
      }
    }

    if (data.length < 1000) break;
    offset += 1000;
  }

  console.log(`🎯 Found ${movies.length} movies (released 2000 - 2026) in catalog.`);

  const cp = readCheckpoint();
  if (cp.lastId > 0) {
    const idx = movies.findIndex((m) => m.id === cp.lastId);
    if (idx !== -1) {
      movies = movies.slice(idx + 1);
      console.log(`⏩ Auto-resuming from previous checkpoint (Remaining: ${movies.length} movies)...`);
    }
  }

  let processed = cp.processedCount || 0;
  let totalAdded = cp.addedCount || 0;

  for (let i = 0; i < movies.length; i += CONCURRENCY) {
    const chunk = movies.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((m) => processMovie(m, qualityMap.get(String(m.external_id || m.id)) || new Set()))
    );

    for (let j = 0; j < results.length; j++) {
      processed++;
      const res = results[j];
      const m = chunk[j];

      if (res.status === "saved") {
        totalAdded += res.addedTiers.length;
        console.log(`✅ [${processed}] "${res.title}" -> Added Qualities: [${res.addedTiers.join(", ")}] (Hindi)`);
      } else if (res.status === "already_complete") {
        console.log(`⚡ [${processed}] "${res.title}" -> Already has 1080p, 720p, 480p`);
      } else {
        console.log(`⏩ [${processed}] "${res.title}" -> No additional Hindi tiers found`);
      }

      writeCheckpoint({
        lastId: m.id,
        processedCount: processed,
        addedCount: totalAdded,
        updatedAt: new Date().toISOString(),
      });
    }

    await sleep(150);
  }

  console.log("\n===============================================================================");
  console.log(`🎉 Multi-Quality Hindi Enrichment Complete!`);
  console.log(`💾 Successfully Added: ${totalAdded} new quality tiers (1080p, 720p, 480p)`);
  console.log("===============================================================================\n");
}

main().catch((err) => {
  console.error("Fatal Error in enrichMultiQualityHindi:", err);
  process.exit(1);
});
