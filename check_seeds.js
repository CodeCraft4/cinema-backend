const Module = require("module");
const realLoad = Module._load;
Module._load = (r, p, im) => {
  if (/electron-updater|src\/main\.js/i.test(String(r))) return {};
  return realLoad(r, p, im);
};
const resolver = require("./server/services/torrentResolver");

function row(title, seeders = 5) {
  return {
    title,
    size_bytes: 1450000000,
    size: "1.37 GB",
    size_human: "1.37 GB",
    quality: "720p",
    seeds: seeders,
    seeders,
  };
}

let failures = 0;
function assert(cond, msg) {
  console.log((cond ? "PASS" : "FAIL") + ": " + msg);
  if (!cond) failures++;
}

// The reported 0-seed magnet should now be rejected at resolution (never reach engine -> 503).
{
  const r1 = resolver.acceptTorrentRelease({
    title: "Anpadh 1962 DvDrip 1.37GB AVI ~ Musical  Drama  Family ~ [RdY].avi",
    sizeBytes: 1450000000,
    size: "1.37 GB",
    quality: "720p",
    mediaType: "movie",
    metadata: "",
    seeders: 0,
  });
  assert(r1.ok === false, "0 seeders rejected");

  // Indexer reports no seed count -> cannot prove live swarm; reject too.
  const r2 = resolver.acceptTorrentRelease({
    title: "Anpadh 1962",
    sizeBytes: 1450000000,
    size: "1.37 GB",
    quality: "720p",
    mediaType: "movie",
    metadata: "",
    seeders: null,
  });
  assert(r2.ok === false, "missing seeder count rejected");

  // Healthy seeders pass through.
  const r3 = resolver.acceptTorrentRelease({
    title: "Anpadh 1962",
    sizeBytes: 1450000000,
    size: "1.37 GB",
    quality: "720p",
    mediaType: "movie",
    metadata: "",
    seeders: 5,
  });
  assert(r3.ok === true, ">= 2 seeders accepted");
}

// Episode-strict logic still intact (with valid seed counts).
const tvEpisodes = [row("Intelligence.S01E05.1080p.BluRay.x264-DEViATe"), row("Intelligence.S01.Complete.720p.Dubbed.x264"), row("Intelligence.720p.Dubbed.x264")];
const ranked = resolver.rankValidReleases(tvEpisodes, "series", "", 1, 5);
const allowed = ranked.filter((x) => x.item.title.includes("E05"));
const blocked = ranked.filter((x) => !x.item.title.includes("E05"));
assert(allowed.length === 1, "exact S1E5 kept for episode request");
assert(blocked.length === 0, "no bare-season/no-marker torrent leaked into S1E5 resolution");

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
