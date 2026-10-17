#!/usr/bin/env node
"use strict";

/**
 * Live Hindi / Dual Audio torrent probe.
 * Movies: full-title search.
 * Series: season pack + two sample episodes (S01E01, S01E02), which is how
 * episode/part packs usually show up. Not every episode of a long show.
 */

const { initTorrentProviders, fetchTorrentSearch, parseTorrentReleaseMeta } = require("../src/torrentSearch");
const { buildTorrentQueries, pickHealthyTorrent, MIN_SEEDERS } = require("../server/services/streamResolver");

initTorrentProviders();

const CASES = [
  { kind: "movie", label: "Interstellar", title: "Interstellar", year: "2014" },
  { kind: "movie", label: "Spider-Man: Brand New Day", title: "Spider-Man Brand New Day", year: "2026" },
  { kind: "movie", label: "The Martian", title: "The Martian", year: "2015" },
  { kind: "series-pack", label: "Game of Thrones S01 pack", title: "Game of Thrones", extra: "S01" },
  { kind: "episode", label: "Game of Thrones S01E01", title: "Game of Thrones", extra: "S01E01" },
  { kind: "episode", label: "Game of Thrones S01E02", title: "Game of Thrones", extra: "S01E02" },
  { kind: "series-pack", label: "The Punisher S01 pack", title: "The Punisher", extra: "S01" },
  { kind: "episode", label: "The Punisher S01E01", title: "The Punisher", extra: "S01E01" },
  { kind: "episode", label: "The Punisher S01E02", title: "The Punisher", extra: "S01E02" },
  { kind: "series-pack", label: "The Witcher S01 pack", title: "The Witcher", extra: "S01" },
  { kind: "episode", label: "The Witcher S01E01", title: "The Witcher", extra: "S01E01" },
  { kind: "episode", label: "The Witcher S01E02", title: "The Witcher", extra: "S01E02" },
  { kind: "series-pack", label: "Vikings S01 pack", title: "Vikings", extra: "S01" },
  { kind: "episode", label: "Vikings S01E01", title: "Vikings", extra: "S01E01" },
  { kind: "episode", label: "Vikings S01E02", title: "Vikings", extra: "S01E02" },
];

function queriesFor(entry) {
  if (!entry.extra) return buildTorrentQueries(entry.title, entry.year || "", "hindi", "all");
  return [
    `${entry.title} ${entry.extra} Dual Audio Hindi`,
    `${entry.title} ${entry.extra} Multi Audio`,
    `${entry.title} ${entry.extra} Hindi Dubbed`,
  ];
}

function hindiRows(rows) {
  return (rows || []).filter((row) => parseTorrentReleaseMeta(row.title).languageTags.includes("hindi"));
}

async function runCase(entry) {
  const queries = queriesFor(entry);
  const started = Date.now();
  const batches = await Promise.all(
    queries.map((query) =>
      fetchTorrentSearch(query, { maxTitles: 1, timeoutMs: 12000 }).catch(() => [])
    )
  );
  const rows = batches.flat();
  const hindi = hindiRows(rows).sort((a, b) => Number(b.seeds || 0) - Number(a.seeds || 0));
  const healthy = pickHealthyTorrent(rows, "hindi", "all");
  const ms = Date.now() - started;
  const best = healthy || hindi[0] || null;
  let status = "MISS";
  if (healthy && Number(healthy.seeds) >= MIN_SEEDERS) status = "OK";
  else if (hindi.length) status = "LOW";
  return {
    status,
    kind: entry.kind,
    label: entry.label,
    ms,
    rows: rows.length,
    hindi: hindi.length,
    seeds: best ? Number(best.seeds || 0) : 0,
    quality: best ? parseTorrentReleaseMeta(best.title).quality : "",
    sample: best ? String(best.title).slice(0, 90) : "",
  };
}

(async () => {
  const started = Date.now();
  console.log(`Hindi/Dual live probe — min seeders ${MIN_SEEDERS}\n`);
  const results = [];
  for (const entry of CASES) {
    process.stdout.write(`… ${entry.label}\n`);
    const result = await runCase(entry);
    results.push(result);
    console.log(
      `${result.status.padEnd(4)} | ${(result.ms / 1000).toFixed(1)}s | hindi ${result.hindi}/${result.rows} | seeds ${result.seeds} | ${result.label}` +
        (result.sample ? `\n       ${result.sample}` : "")
    );
  }
  const ok = results.filter((r) => r.status === "OK").length;
  const low = results.filter((r) => r.status === "LOW").length;
  const miss = results.filter((r) => r.status === "MISS").length;
  console.log(
    `\n${ok} OK, ${low} low-seeders, ${miss} miss — total ${(Date.now() - started) / 1000}s`
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
