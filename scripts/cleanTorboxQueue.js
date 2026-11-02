/**
 * scripts/cleanTorboxQueue.js
 *
 * Removes torrents from the TorBox account that can never be streamed: the ones stuck in
 * "queued" / "stalled" / inactive state (added earlier for magnets TorBox had not cached).
 * Cached / completed torrents ("cached", "completed", "uploading") are NEVER touched.
 *
 *   node scripts/cleanTorboxQueue.js            # list only
 *   node scripts/cleanTorboxQueue.js --delete   # delete the queued / stalled ones
 */

"use strict";

const env = require("../server/config/env");

const BASE = "https://api.torbox.app/v1/api";
const KEY = env.torboxApiKey;
const DELETE = process.argv.includes("--delete");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// States that mean "not playable and not progressing".
const REMOVABLE = /^(queued|stalled|stalled \(no seeds\)|checking|metadl|inactive|failed|error)/i;

async function api(path, options = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${KEY}`, ...(options.headers || {}) } });
    const text = await res.text();
    if (res.status === 429 || /rate limit/i.test(text)) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

(async () => {
  const list = await api("/torrents/mylist?bypass_cache=true");
  const items = Array.isArray(list?.data) ? list.data : [];
  const states = {};
  for (const t of items) states[t.download_state] = (states[t.download_state] || 0) + 1;
  console.log(`TorBox torrents: ${items.length}`, states);

  const removable = items.filter((t) => !t.download_present && !t.cached && t.progress < 1 && REMOVABLE.test(String(t.download_state || "")));
  console.log(`Queued / stuck (safe to remove): ${removable.length}`);
  for (const t of removable.slice(0, 80)) console.log(`  ${t.id}  ${t.download_state}  ${String(t.name).slice(0, 70)}`);

  if (!DELETE) return console.log("\nDry run. Re-run with --delete to remove them.");
  let done = 0;
  for (const t of removable) {
    const res = await api("/torrents/controltorrent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ torrent_id: t.id, operation: "delete" }),
    });
    if (res?.success) done++;
    await sleep(400);
  }
  console.log(`Deleted ${done}/${removable.length}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
