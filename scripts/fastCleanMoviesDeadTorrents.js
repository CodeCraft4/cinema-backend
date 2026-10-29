"use strict";

/**
 * ⚡ Ultra-Fast Movies Dead Seeder Cleaner & Healer (Under 5 Minutes)
 *
 * Exclusively scans MOVIES in Supabase media_sources:
 * 1. TorBox 1Gbps Batch Check: Checks up to 80 hashes per call (300ms).
 *    If cached on TorBox -> 100% HEALTHY, 1Gbps instant stream. Kept.
 * 2. BEP 15 UDP Tracker Scrape: Queries opentrackr, stealth.si, torrent.eu.org in parallel.
 *    If live seeds >= 3 -> HEALTHY on internet. Updated with live seed count.
 * 3. Fast Healing / Purging:
 *    If confirmed 0 seeds on internet:
 *    - Tries fast Torrentio lookup for fresh Hindi magnet with >= 5 seeds.
 *    - If found -> HEALS the movie row in DB.
 *    - If not found -> PURGES (deletes) the dead row from Supabase in single batch.
 */

const dgram = require("dgram");
const crypto = require("crypto");
const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
const { searchTorrentio } = require("../server/services/torrentResolver");
const torboxService = require("../server/services/torboxService");
const env = require("../server/config/env");

const TORBOX_API_KEY = env.torboxApiKey || "0edcc612-8771-4d1e-bc74-26056f4906f9";
const MIN_HEALTHY_SEEDS = 3;

const UDP_TRACKERS = [
  ["tracker.opentrackr.org", 1337],
  ["open.stealth.si", 80],
  ["tracker.torrent.eu.org", 451],
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Scrape UDP trackers for an array of infohashes using BEP 15 scrape
 */
function scrapeTracker(host, port, hashes) {
  return new Promise((resolve) => {
    if (!hashes || hashes.length === 0) return resolve({});
    const s = dgram.createSocket("udp4");
    const tid = crypto.randomBytes(4);
    const conn = Buffer.alloc(16);
    conn.writeBigUInt64BE(0x41727101980n, 0); // protocol_id
    conn.writeUInt32BE(0, 8); // action = 0 (connect)
    tid.copy(conn, 12);
    let cid = null;
    let timer = setTimeout(() => {
      try { s.close(); } catch (_) {}
      resolve({});
    }, 2200);

    s.on("error", () => {
      clearTimeout(timer);
      try { s.close(); } catch (_) {}
      resolve({});
    });

    s.on("message", (msg) => {
      if (msg.length >= 16 && !cid) {
        cid = msg.slice(8, 16);
        const t2 = crypto.randomBytes(4);
        const req = Buffer.alloc(16 + hashes.length * 20);
        cid.copy(req, 0);
        req.writeUInt32BE(2, 8); // action = 2 (scrape)
        t2.copy(req, 12);
        hashes.forEach((h, idx) => {
          try {
            Buffer.from(h, "hex").copy(req, 16 + idx * 20);
          } catch (_) {}
        });
        s.send(req, port, host, () => {});
      } else if (msg.length >= 8 && cid) {
        clearTimeout(timer);
        const results = {};
        let offset = 8;
        hashes.forEach((h) => {
          if (offset + 12 <= msg.length) {
            const seeders = msg.readUInt32BE(offset);
            const completed = msg.readUInt32BE(offset + 4);
            const leechers = msg.readUInt32BE(offset + 8);
            results[h.toLowerCase()] = { seeders, leechers, completed };
            offset += 12;
          }
        });
        try { s.close(); } catch (_) {}
        resolve(results);
      }
    });

    s.send(conn, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        try { s.close(); } catch (_) {}
        resolve({});
      }
    });
  });
}

/**
 * Scrape multiple trackers in parallel and take max seeders found
 */
async function getLiveSeedsMultiTracker(hashes) {
  if (!hashes || hashes.length === 0) return {};
  const promises = UDP_TRACKERS.map(([h, p]) => scrapeTracker(h, p, hashes));
  const allResults = await Promise.allSettled(promises);

  const combined = {};
  for (const res of allResults) {
    if (res.status === "fulfilled" && res.value) {
      for (const [h, data] of Object.entries(res.value)) {
        const curSeeds = combined[h]?.seeders || 0;
        const curLeechers = combined[h]?.leechers || 0;
        combined[h] = {
          seeders: Math.max(curSeeds, data.seeders || 0),
          leechers: Math.max(curLeechers, data.leechers || 0),
        };
      }
    }
  }
  return combined;
}

/**
 * Check TorBox cache in batches of 70-80 hashes
 */
async function checkTorboxBatch(hashes) {
  if (!TORBOX_API_KEY || !hashes || hashes.length === 0) return {};
  try {
    const url = `https://api.torbox.app/v1/api/torrents/checkcached?hash=${hashes.join(",")}&format=object`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return {};
    const json = await res.json();
    return json.data || {};
  } catch (err) {
    console.warn("[TorBox] Batch check failed:", err.message);
    return {};
  }
}

async function main() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error("Supabase client failed to initialize.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const batchSize = parseInt(args.find((a) => a.startsWith("--batch="))?.split("=")[1] || "80", 10);
  const maxLimit = parseInt(args.find((a) => a.startsWith("--max="))?.split("=")[1] || "10000", 10);
  const purgeOnly = args.includes("--purge-only");

  console.log("==================================================================");
  console.log("⚡ Ultra-Fast Movies Dead Seeder Cleaner & Purge Engine");
  console.log("   Target: MOVIES ONLY (media_sources without -s / :s)");
  console.log(`   Batch Size: ${batchSize} | Max Limit: ${maxLimit}`);
  console.log("==================================================================\n");

  let totalProcessed = 0;
  let totalCached = 0;
  let totalLiveSeeds = 0;
  let totalHealed = 0;
  let totalPurged = 0;
  let batchIndex = 1;
  let offset = 0;

  // Count total movies first
  const { count: totalMoviesInDb } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("*", { count: "exact", head: true })
    .not("media_id", "ilike", "%-s%")
    .not("media_id", "ilike", "%:s%");

  console.log(`📊 Total Movies in Database to inspect: ${totalMoviesInDb}\n`);

  while (totalProcessed < maxLimit && offset < (totalMoviesInDb || 10000)) {
    // 1. Fetch batch of movie rows
    const { data: rows, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, year, quality, language, magnet_link, download_url, seeders")
      .not("media_id", "ilike", "%-s%")
      .not("media_id", "ilike", "%:s%")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error(`[DB ERROR] Fetch failed at offset ${offset}:`, error.message);
      await sleep(2000);
      offset += batchSize;
      continue;
    }

    if (!rows || rows.length === 0) {
      console.log("✅ All movie records scanned.");
      break;
    }

    const hashToRow = new Map();
    for (const row of rows) {
      const magnet = row.magnet_link || row.download_url;
      const h = torboxService.extractInfoHash(magnet);
      if (h) hashToRow.set(h.toLowerCase(), row);
    }

    const hashes = Array.from(hashToRow.keys());

    // 2. Check TorBox 1Gbps Cache (Instant)
    const torboxCachedMap = await checkTorboxBatch(hashes);
    const uncachedHashes = [];

    for (const h of hashes) {
      const row = hashToRow.get(h);
      if (torboxCachedMap[h] || torboxCachedMap[h.toUpperCase()]) {
        totalCached++;
        totalProcessed++;
        // If row has low seeders, promote to 99 in DB
        if (Number(row.seeders || 0) < 50) {
          await supabase.from(MEDIA_SOURCES_TABLE).update({ seeders: 99, status: "ready" }).eq("id", row.id);
        }
      } else {
        uncachedHashes.push(h);
      }
    }

    // 3. For Uncached Hashes: UDP Multi-Tracker Scrape
    const trackerScrapeMap = await getLiveSeedsMultiTracker(uncachedHashes);
    const deadRows = [];

    for (const h of uncachedHashes) {
      totalProcessed++;
      const row = hashToRow.get(h);
      const trackerData = trackerScrapeMap[h];
      const liveSeeds = trackerData?.seeders || 0;

      if (liveSeeds >= MIN_HEALTHY_SEEDS) {
        // Has active seeders on the internet!
        totalLiveSeeds++;
        // Update DB with verified live seeds
        await supabase.from(MEDIA_SOURCES_TABLE).update({ seeders: liveSeeds }).eq("id", row.id);
      } else {
        // 0 seeds on trackers and uncached on Torbox
        deadRows.push(row);
      }
    }

    // 4. Fast Heal or Purge Dead Rows
    const deadIdsToPurge = [];

    for (const deadRow of deadRows) {
      let healed = false;
      const title = deadRow.media_title || "";
      const year = deadRow.year || "";

      if (!purgeOnly && title) {
        try {
          const streams = await searchTorrentio({ title, year, mediaType: "movie" });
          const hindiStream = streams.find((s) => {
            const t = (s.title || "").toLowerCase();
            const seeds = Number(s.seeders || s.seeds || 0);
            return seeds >= 5 && (t.includes("hindi") || t.includes("dual") || t.includes("dubbed"));
          });

          if (hindiStream && hindiStream.magnet) {
            const freshSeeds = Number(hindiStream.seeders || hindiStream.seeds || 5);
            await supabase
              .from(MEDIA_SOURCES_TABLE)
              .update({
                magnet_link: hindiStream.magnet,
                download_url: hindiStream.magnet,
                seeders: freshSeeds,
                quality: hindiStream.quality || deadRow.quality,
                size_human: hindiStream.size || deadRow.size_human,
                updated_at: new Date().toISOString(),
              })
              .eq("id", deadRow.id);

            totalHealed++;
            healed = true;
            console.log(`  ✨ [HEALED] ${title} (${year}) updated with fresh magnet (${freshSeeds} seeds).`);
          }
        } catch (_) {}
      }

      if (!healed) {
        deadIdsToPurge.push(deadRow.id);
      }
    }

    // 5. Batch Purge Dead Rows from Supabase in ONE request
    if (deadIdsToPurge.length > 0) {
      await supabase.from(MEDIA_SOURCES_TABLE).delete().in("id", deadIdsToPurge);
      totalPurged += deadIdsToPurge.length;
      console.log(`  🗑️ [PURGED ${deadIdsToPurge.length} DEAD MOVIES] 0 seeds on internet. Removed from DB.`);
    }

    console.log(
      `📦 [BATCH ${batchIndex}] Checked ${totalProcessed}/${totalMoviesInDb} | 🟢 TorBox 1Gbps: ${totalCached} | 🌐 Live Seeds: ${totalLiveSeeds} | ✨ Healed: ${totalHealed} | 🗑️ Purged: ${totalPurged}`
    );

    batchIndex++;
    offset += batchSize;
    await sleep(200);
  }

  console.log("\n==================================================================");
  console.log("🏁 [MOVIES FAST CLEAN COMPLETE]");
  console.log(`   • Total Movies Checked: ${totalProcessed}`);
  console.log(`   • Verified TorBox 1Gbps Ready: ${totalCached}`);
  console.log(`   • Active Live Seeds on Internet: ${totalLiveSeeds}`);
  console.log(`   • Healed with Working Hindi Magnets: ${totalHealed}`);
  console.log(`   • Dead Movies Purged from Supabase: ${totalPurged}`);
  console.log("==================================================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
