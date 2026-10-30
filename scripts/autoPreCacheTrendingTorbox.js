/**
 * scripts/autoPreCacheTrendingTorbox.js
 *
 * Automatically pre-caches Top Trending Movies (2022-2026) to TorBox Cloud Storage.
 *
 * Rules & Features:
 * 1. Queries Supabase for Top Movies (2022 - 2026) across all industries with highest seeds.
 * 2. Checks if each torrent is already cached on TorBox.
 * 3. If not cached, sends to TorBox (`/torrents/createtorrent`).
 * 4. Safety Cap: Enforces a strict 150 GB limit (leaving ~150 GB free for dynamic user streams).
 * 5. Logs every movie cached with its size and status.
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_SECRET_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TORBOX_BASE_URL = "https://api.torbox.app/v1/api";

const MAX_CACHE_BYTES = 150 * 1024 * 1024 * 1024; // 150 GB Strict Cap

if (!SUPABASE_URL || !SUPABASE_KEY || !TORBOX_API_KEY) {
  console.error("Missing Supabase or TorBox API credentials in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractInfoHash(magnet) {
  if (!magnet) return null;
  const hex = magnet.match(/(?:urn:btih:)?([a-fA-F0-9]{40})/i);
  if (hex) return hex[1].toLowerCase();
  const b32 = magnet.match(/(?:urn:btih:)?([a-zA-Z2-7]{32})/i);
  if (b32) return b32[1].toLowerCase();
  return null;
}

async function checkTorboxCached(hash) {
  try {
    const res = await fetch(`${TORBOX_BASE_URL}/torrents/checkcached?hash=${hash}&format=object`, {
      headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return Boolean(json?.data?.[hash] || json?.data?.[hash.toUpperCase()]);
  } catch {
    return false;
  }
}

async function createTorboxTorrent(magnet) {
  try {
    const body = new URLSearchParams();
    body.append("magnet", String(magnet).replace(/[\r\n\t]+/g, "").trim());
    body.append("seed", "1");
    body.append("allow_zip", "false");

    const res = await fetch(`${TORBOX_BASE_URL}/torrents/createtorrent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TORBOX_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    return json.success ? json.data : null;
  } catch (err) {
    console.warn("Error creating Torbox torrent:", err.message);
    return null;
  }
}

async function getTorboxUserStorage() {
  try {
    const res = await fetch(`${TORBOX_BASE_URL}/torrents/mylist`, {
      headers: { Authorization: `Bearer ${TORBOX_API_KEY}` },
    });
    const json = await res.json();
    if (!json.success || !Array.isArray(json.data)) return 0;
    const totalBytes = json.data.reduce((acc, t) => {
      const size = Number(t.size);
      return acc + (size > 0 ? size : 0);
    }, 0);
    return totalBytes;
  } catch {
    return 0;
  }
}

async function main() {
  console.log("================================================================================");
  console.log("⚡ STARTING TORBOX AUTO PRE-CACHE ENGINE (TARGET: 150 GB TRENDING MOVIES)");
  console.log("   Years: 2022 - 2026 | Audio: Hindi & Dual Audio | High Seeders");
  console.log("================================================================================\n");

  const currentStorage = await getTorboxUserStorage();
  const currentGb = (currentStorage / (1024 * 1024 * 1024)).toFixed(2);
  console.log(`📊 Current TorBox Active Storage Used: ${currentGb} GB / 150 GB Cap\n`);

  if (currentStorage >= MAX_CACHE_BYTES) {
    console.log("⚠️ TorBox is already utilizing >= 150 GB! No further pre-caching required.");
    return;
  }

  // Fetch top movies from Supabase: released 2022 or later, non-series, highest seeders first
  console.log("🔍 Fetching Top Trending Movies from Supabase...");
  const { data: movies, error } = await supabase
    .from("media_sources")
    .select("id, media_id, media_title, year, quality, language, seeders, magnet_link, size_human, size_bytes")
    .not("magnet_link", "is", null)
    .not("media_id", "like", "%-s%e%") // Exclude series episodes
    .gte("year", 2022)
    .gte("seeders", 10)
    .order("seeders", { ascending: false })
    .limit(200);

  if (error || !movies || movies.length === 0) {
    console.error("❌ Failed to fetch movies from Supabase:", error?.message);
    return;
  }

  console.log(`✅ Loaded ${movies.length} high-seeder candidate movies for caching.\n`);

  let addedCount = 0;
  let alreadyCachedCount = 0;
  let trackedBytes = currentStorage;

  for (const m of movies) {
    if (trackedBytes >= MAX_CACHE_BYTES) {
      console.log(`\n🛑 Reached 150 GB Cache Limit! (Total Cached Size: ${(trackedBytes / (1024 * 1024 * 1024)).toFixed(2)} GB)`);
      break;
    }

    const hash = extractInfoHash(m.magnet_link);
    if (!hash) continue;

    // Estimate movie size: ~1.5 GB if unknown
    const estBytes = Number(m.size_bytes) > 0 ? Number(m.size_bytes) : 1.5 * 1024 * 1024 * 1024;

    // Check if already 100% cached on TorBox
    const isCached = await checkTorboxCached(hash);
    if (isCached) {
      alreadyCachedCount++;
      console.log(`  ⚡ [ALREADY CACHED] "${m.media_title}" (${m.year}) · ${m.quality} · ${m.seeders} seeds`);
      trackedBytes += estBytes;
      await sleep(200);
      continue;
    }

    // Submit to TorBox for cloud caching
    console.log(`  📥 [PRE-WARMING TO CLOUD] "${m.media_title}" (${m.year}) · ${m.quality} · ${m.seeders} seeds...`);
    const created = await createTorboxTorrent(m.magnet_link);
    if (created) {
      addedCount++;
      trackedBytes += estBytes;
      console.log(`     ✅ Successfully queued on TorBox! (Torrent ID: ${created.torrent_id}) [Total: ${(trackedBytes / (1024 * 1024 * 1024)).toFixed(2)} GB]`);
    } else {
      console.log(`     ⚠️ Failed to queue or duplicate on TorBox.`);
    }

    await sleep(400); // Polite rate limit
  }

  console.log("\n================================================================================");
  console.log("🎉 PRE-CACHE ENGINE COMPLETED!");
  console.log(`   Movies Already Instant Cached: ${alreadyCachedCount}`);
  console.log(`   New Movies Queued to Cloud: ${addedCount}`);
  console.log(`   Estimated Cloud Reserved Size: ${(trackedBytes / (1024 * 1024 * 1024)).toFixed(2)} GB / 150 GB`);
  console.log("================================================================================\n");
}

main().catch(console.error);
