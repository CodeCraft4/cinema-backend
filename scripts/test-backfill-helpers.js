#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  buildBackfillQueries,
  mergeBackfillResults,
  isBackfillResultFresh,
} = require("../src/torrentSearch");

const queries = buildBackfillQueries("Spider-Man", 2024, "en");
assert.ok(queries[0].includes("hindi dubbed"));
assert.ok(queries.some((q) => q.includes("dual audio hindi")));
assert.ok(queries.some((q) => q.includes("english")));

const merged = mergeBackfillResults([
  [{ title: "Spider-Man 2024 Hindi Dubbed 1080p", seeds: 5, link: "h" }],
  [
    { title: "Spider-Man 2024 English 1080p", seeds: 8, link: "e" },
    { title: "Spider-Man 2024 Hindi Dubbed 720p", seeds: 9, link: "h2" },
  ],
], { limitPerLanguage: 2, originalLanguage: "en" });
assert.ok(merged.some((item) => item.title.includes("Hindi")));
assert.ok(merged.some((item) => item.title.includes("English")));
assert.ok(merged.filter((item) => /Hindi/i.test(item.title)).length <= 2);
assert.ok(merged.filter((item) => /English/i.test(item.title)).length <= 2);

const now = Date.now();
assert.strictEqual(isBackfillResultFresh({ torrentsFound: 0, torrentsCheckedAt: new Date().toISOString() }, 86400000, now), false);
assert.strictEqual(isBackfillResultFresh({ torrentsFound: 1, torrentsCheckedAt: new Date().toISOString() }, 86400000, now), true);
assert.strictEqual(isBackfillResultFresh({ torrentsFound: 1, torrentsCheckedAt: new Date(now - 90000).toISOString() }, 60000, now), false);

console.log("Backfill helper tests passed");