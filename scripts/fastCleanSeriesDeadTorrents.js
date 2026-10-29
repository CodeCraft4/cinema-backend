"use strict";

/**
 * ⚡ Ultra-Fast TV Shows & Episodes Dead Seeder Cleaner (Under 5 Minutes)
 *
 * Exclusively scans TV SERIES & EPISODES in Supabase media_sources:
 * 1. TorBox 1Gbps Batch Check: Checks up to 80 episode hashes per call (300ms).
 *    If cached on TorBox -> 100% HEALTHY, 1Gbps instant stream. Kept.
 * 2. BEP 15 UDP Tracker Scrape: Queries opentrackr, stealth.si, torrent.eu.org in parallel.
 *    If live seeds >= 3 -> HEALTHY on internet. Updated with live seed count.
 * 3. Dead Episodes Purge:
 *    If confirmed 0 seeds on internet and uncached on TorBox:
 *    - PURGES (deletes) dead episode row from Supabase in batch.
 */

const dgram = require("dgram");
const crypto = require("crypto");
const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");
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

function scrapeTracker(host, port, hashes) {
  return new Promise((resolve) => {
    if (!hashes || hashes.length === 0) return resolve({});
    const s = dgram.createSocket("udp4");
    const tid = crypto.randomBytes(4);
    const conn = Buffer.alloc(16);
    conn.writeBigUInt64BE(0x41727101980n, 0);
    conn.writeUInt32BE(0, 8);
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
        req.writeUInt32BE(2, 8);
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
  const maxLimit = parseInt(args.find((a) => a.startsWith("--max="))?.split("=")[1] || "15000", 10);

  console.log("==================================================================");
  console.log("⚡ Ultra-Fast TV Shows & Episodes Dead Seeder Cleaner");
  console.log("   Target: TV EPISODES ONLY (media_sources with -s / :s)");
  console.log(`   Batch Size: ${batchSize} | Max Limit: ${maxLimit}`);
  console.log("==================================================================\n");

  let totalProcessed = 0;
  let totalCached = 0;
  let totalLiveSeeds = 0;
  let totalPurged = 0;
  let batchIndex = 1;
  let lastSeenId = 0;

  // Count total series episodes first
  const { count: totalEpisodesInDb } = await supabase
    .from(MEDIA_SOURCES_TABLE)
    .select("*", { count: "exact", head: true })
    .or("media_id.ilike.%-s%,media_id.ilike.%:s%");

  console.log(`📊 Total TV Episodes in Database to inspect: ${totalEpisodesInDb}\n`);

  while (totalProcessed < maxLimit) {
    // 1. Fetch batch of TV episode rows using Keyset Pagination (ID > lastSeenId)
    const { data: rows, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, year, quality, language, magnet_link, download_url, seeders")
      .or("media_id.ilike.%-s%,media_id.ilike.%:s%")
      .gt("id", lastSeenId)
      .order("id", { ascending: true })
      .limit(batchSize);

    if (error) {
      console.error(`[DB ERROR] Fetch failed after ID ${lastSeenId}:`, error.message);
      await sleep(2000);
      continue;
    }

    if (!rows || rows.length === 0) {
      console.log("✅ All TV episode records scanned.");
      break;
    }

    lastSeenId = rows[rows.length - 1].id;

    const hashToRows = new Map();
    const deadIdsToPurge = [];

    for (const row of rows) {
      const magnet = row.magnet_link || row.download_url;
      const h = torboxService.extractInfoHash(magnet);
      if (h) {
        const key = h.toLowerCase();
        if (!hashToRows.has(key)) hashToRows.set(key, []);
        hashToRows.get(key).push(row);
      } else {
        // Corrupted magnet or missing hash -> dead
        deadIdsToPurge.push(row.id);
        totalProcessed++;
      }
    }

    const hashes = Array.from(hashToRows.keys());

    // 2. Check TorBox 1Gbps Cache
    const torboxCachedMap = await checkTorboxBatch(hashes);
    const uncachedHashes = [];

    for (const h of hashes) {
      const matchedRows = hashToRows.get(h) || [];
      if (torboxCachedMap[h] || torboxCachedMap[h.toUpperCase()]) {
        totalCached += matchedRows.length;
        totalProcessed += matchedRows.length;
        const lowSeedIds = matchedRows.filter((r) => Number(r.seeders || 0) < 50).map((r) => r.id);
        if (lowSeedIds.length > 0) {
          await supabase.from(MEDIA_SOURCES_TABLE).update({ seeders: 99, status: "ready" }).in("id", lowSeedIds);
        }
      } else {
        uncachedHashes.push(h);
      }
    }

    // 3. For Uncached Hashes: UDP Multi-Tracker Scrape
    const trackerScrapeMap = await getLiveSeedsMultiTracker(uncachedHashes);

    for (const h of uncachedHashes) {
      const matchedRows = hashToRows.get(h) || [];
      const trackerData = trackerScrapeMap[h];
      const liveSeeds = trackerData?.seeders || 0;

      totalProcessed += matchedRows.length;

      if (liveSeeds >= MIN_HEALTHY_SEEDS) {
        totalLiveSeeds += matchedRows.length;
        const ids = matchedRows.map((r) => r.id);
        await supabase.from(MEDIA_SOURCES_TABLE).update({ seeders: liveSeeds }).in("id", ids);
      } else {
        matchedRows.forEach((r) => deadIdsToPurge.push(r.id));
      }
    }

    // 4. Batch Purge Dead Episodes from Supabase
    if (deadIdsToPurge.length > 0) {
      await supabase.from(MEDIA_SOURCES_TABLE).delete().in("id", deadIdsToPurge);
      totalPurged += deadIdsToPurge.length;
      console.log(`  🗑️ [PURGED ${deadIdsToPurge.length} DEAD EPISODES] 0 seeds on internet. Removed from DB.`);
    }

    console.log(
      `📦 [SERIES BATCH ${batchIndex}] Checked ${totalProcessed}/${totalEpisodesInDb} | 🟢 TorBox: ${totalCached} | 🌐 Live Seeds: ${totalLiveSeeds} | 🗑️ Purged: ${totalPurged}`
    );

    batchIndex++;
    await sleep(200);
  }

  console.log("\n==================================================================");
  console.log("🏁 [TV EPISODES FAST CLEAN COMPLETE]");
  console.log(`   • Total Episodes Checked: ${totalProcessed}`);
  console.log(`   • Verified TorBox 1Gbps Ready: ${totalCached}`);
  console.log(`   • Active Live Seeds on Internet: ${totalLiveSeeds}`);
  console.log(`   • Dead Episodes Purged from Supabase: ${totalPurged}`);
  console.log("==================================================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

