#!/usr/bin/env node
"use strict";

/**
 * Download pipeline smoke test — proves WebTorrent actually MOVES BYTES.
 * Uses legal, freely distributable test torrents (Blender open movies, CC-BY):
 *   1. Sintel          (Blender Foundation)
 *   2. Big Buck Bunny  (fallback)
 *
 *   npm run test:download-smoke
 *
 * PASS: torrent metadata received AND downloaded > 0 (or fully available).
 * Downloads into a temp folder, reports files/peers/speed, cleans up, exits 0/1.
 */

const WebTorrent = require("webtorrent");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.webtorrent.io",
];
const tr = TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join("&");

const CANDIDATES = [
  {
    label: "Sintel (CC-BY Blender)",
    magnet: `magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&${tr}`,
  },
  {
    label: "Big Buck Bunny (CC-BY Blender)",
    magnet: `magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&${tr}`,
  },
];

const OVERALL_MS = 120000;
const PER_TORRENT_MS = 75000;

function runCandidate(candidate, downloadPath) {
  return new Promise((resolve) => {
    const client = new WebTorrent({ maxConns: 60 });
    let settled = false;
    let progressTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (progressTimer) clearInterval(progressTimer);
      clearTimeout(watchdog);
      try {
        client.destroy(() => resolve(result));
      } catch {
        resolve(result);
      }
    };

    const watchdog = setTimeout(() => finish({ ok: false, reason: "per-torrent timeout (no metadata/bytes)" }), PER_TORRENT_MS);

    console.log(`→ adding: ${candidate.label}`);
    client.add(candidate.magnet, { path: downloadPath }, (torrent) => {
      console.log(
        `  metadata OK — ${torrent.files.length} file(s), ${((torrent.length || 0) / 1048576).toFixed(1)} MiB`
      );
      torrent.files.forEach((f) => console.log(`    · ${f.path} (${(f.length / 1048576).toFixed(1)} MiB)`));

      progressTimer = setInterval(() => {
        const mb = (torrent.downloaded / 1048576).toFixed(2);
        console.log(
          `  progress ${(torrent.progress * 100).toFixed(2)}% · ${mb} MiB · ${torrent.numPeers} peers · ${(
            torrent.downloadSpeed / 1024
          ).toFixed(0)} KiB/s`
        );
        if (torrent.downloaded > 0) {
          finish({ ok: true, reason: `downloaded ${mb} MiB of real data` });
        }
      }, 3000);
    });

    client.on("error", (error) => finish({ ok: false, reason: `client error: ${error.message || error}` }));
  });
}

async function main() {
  console.log("Cinebroad — download pipeline smoke test (legal CC-BY torrents)");
  console.log("=".repeat(64));

  const downloadPath = path.join(os.tmpdir(), `cinebroad-dlsmoke-${Date.now()}`);
  fs.mkdirSync(downloadPath, { recursive: true });

  const started = Date.now();
  let result = { ok: false, reason: "no candidate executed" };
  for (const candidate of CANDIDATES) {
    if (Date.now() - started > OVERALL_MS - 5000) break;
    result = await runCandidate(candidate, downloadPath);
    console.log(`  ${candidate.label}: ${result.ok ? "PASS" : "FAIL"} (${result.reason})`);
    if (result.ok) break;
  }

  try {
    fs.rmSync(downloadPath, { recursive: true, force: true });
  } catch {
    // temp cleanup is best-effort
  }

  console.log("=".repeat(64));
  if (result.ok) {
    console.log(`✓ download pipeline works — ${result.reason}`);
    process.exit(0);
  }
  console.error(`✗ download pipeline did NOT move data — ${result.reason}`);
  process.exit(1);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
