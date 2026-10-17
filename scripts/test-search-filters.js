#!/usr/bin/env node
"use strict";

/**
 * Unit tests for the Search-page filter logic shared by UI and download path.
 *
 *   npm run test:search-filters
 *
 * src/searchFilters.js has zero DOM/Electron deps, so requiring it here runs
 * EXACTLY the code the renderer uses (window.SearchFilters).
 *
 * Covers:
 *   1. FAMOUS_COUNTRIES shape (curated, unique, right ISO codes)
 *   2. torrentMatchesLanguage (hindi / english / all, tags vs title)
 *   3. tmdbItemMatchesLanguage (original language + title markers)
 *   4. matchesQuality (parsed quality column wins over title text)
 *   5. combineChecks (empty = show all, All = every, Any = some)
 *   6. activeFilterCount
 *   7. strictFilterTorrents (download: language AND quality both required)
 *   8. languageLabel / qualityLabel / languageQueryFor
 */

const SF = require("../src/searchFilters");

const results = { passed: 0, failed: 0 };
function check(label, condition, detail = "") {
  if (condition) results.passed += 1;
  else results.failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. FAMOUS_COUNTRIES ─────────────────────────────────────────────────────
check("FAMOUS_COUNTRIES is a non-empty array", Array.isArray(SF.FAMOUS_COUNTRIES) && SF.FAMOUS_COUNTRIES.length > 0);
check(
  "FAMOUS_COUNTRIES entries have { iso, name }",
  SF.FAMOUS_COUNTRIES.every((c) => /^[A-Z]{2}$/.test(c.iso) && typeof c.name === "string" && c.name.length > 0)
);
check(
  "FAMOUS_COUNTRIES has no duplicate ISO codes",
  new Set(SF.FAMOUS_COUNTRIES.map((c) => c.iso)).size === SF.FAMOUS_COUNTRIES.length
);
const isoSet = new Set(SF.FAMOUS_COUNTRIES.map((c) => c.iso));
check("FAMOUS_COUNTRIES keeps US / IN / GB / KR / JP", ["US", "IN", "GB", "KR", "JP"].every((iso) => isoSet.has(iso)));
check("FAMOUS_COUNTRIES stays a SHORT curated list (≤ 40)", SF.FAMOUS_COUNTRIES.length <= 40, `n=${SF.FAMOUS_COUNTRIES.length}`);

// ── 2. torrentMatchesLanguage ───────────────────────────────────────────────
const hindiRow = { title: "Jawan 2023 Hindi Dubbed 1080p WEB-DL", language_tags: ["hindi"] };
const englishRow = { title: "Dune Part Two 2024 1080p WEB-DL", language_tags: ["english"] };
const dualRow = { title: "RRR 2022 Dual Audio Hindi Telugu 720p", language_tags: [] };
const bareEnglishRow = { title: "Oppenheimer 2023 4K WEB-DL", language: "English" };
const dbEnglishOnly = { title: "Some Show S01", language_tags: ["english"] };

check("hindi: title+tags → true", SF.torrentMatchesLanguage(hindiRow, "hindi") === true);
check("hindi: english-only row → false", SF.torrentMatchesLanguage(englishRow, "hindi") === false);
check("hindi: dual audio counts (contains Hindi)", SF.torrentMatchesLanguage(dualRow, "hindi") === true);
check("hindi: filter 'all' passes everything", SF.torrentMatchesLanguage(englishRow, "all") === true);
check("hindi: filter 'original' passes everything", SF.torrentMatchesLanguage(englishRow, "original") === true);
check("english: tags say english → true", SF.torrentMatchesLanguage(englishRow, "english") === true);
check("english: hindi row → false", SF.torrentMatchesLanguage(hindiRow, "english") === false);
check(
  "english: DB tags present but NOT english → false",
  SF.torrentMatchesLanguage({ title: "Korean Show", language_tags: ["korean"] }, "english") === false
);
check("english: live row with explicit language → true", SF.torrentMatchesLanguage(bareEnglishRow, "english") === true);
check("english: live row without tags/language is not assumed English", SF.torrentMatchesLanguage({ title: "Dune Part Two 2024 4K WEB-DL" }, "english") === false);
check("english: live row without tags, Hindi title → false", SF.torrentMatchesLanguage(dualRow, "english") === false);
check("english: DB enum tag 'en' → true", SF.torrentMatchesLanguage({ title: "Show", language_tags: ["en"] }, "english") === true);

// ── 3. tmdbItemMatchesLanguage ──────────────────────────────────────────────
const hiCard = { title: "12th Fail", originalLanguage: "hi" };
const enCard = { title: "The Batman", originalLanguage: "en" };
const frCard = { title: "Intouchables", originalLanguage: "fr" };
const hiTitleCard = { title: "Bollywood Movie (Hindi)", originalLanguage: "" };
const unknownCard = { title: "Some Indie Film", originalLanguage: "" };

check("tmdb hindi: original hi → true", SF.tmdbItemMatchesLanguage(hiCard, "hindi") === true);
check("tmdb hindi: original en → false", SF.tmdbItemMatchesLanguage(enCard, "hindi") === false);
check("tmdb hindi: Hindi markers in title → true", SF.tmdbItemMatchesLanguage(hiTitleCard, "hindi") === true);
check("tmdb english: original en → true", SF.tmdbItemMatchesLanguage(enCard, "english") === true);
check("tmdb english: original fr → false", SF.tmdbItemMatchesLanguage(frCard, "english") === false);
check("tmdb english: unknown lang, no Hindi markers → true", SF.tmdbItemMatchesLanguage(unknownCard, "english") === true);
check("tmdb: 'all' passes anything", SF.tmdbItemMatchesLanguage(frCard, "all") === true);

// ── 4. matchesQuality ───────────────────────────────────────────────────────
const parsed720 = { title: "Movie 2024 720p WEB-DL", quality: "720p" };
const parsed1080 = { title: "Movie 2024 1080p WEB-DL", quality: "1080p" };
const parsedUnknown = { title: "Movie 2024 HD", quality: "unknown" };
const titleOnly4k = { title: "Movie 2024 2160p UHD HDR", quality: "" };

check("quality: 'all' passes everything", SF.matchesQuality(parsed720, "all") === true);
check("quality: parsed 720p matches 720p filter", SF.matchesQuality(parsed720, "720p") === true);
check("quality: parsed 720p REJECTED by 1080p filter", SF.matchesQuality(parsed720, "1080p") === false);
check("quality: parsed 1080p REJECTED by 720p filter", SF.matchesQuality(parsed1080, "720p") === false);
check("quality: unknown parsed → title fallback (HD)", SF.matchesQuality({ title: "Movie 720p", quality: "unknown" }, "720p") === true);
check("quality: no parsed column → title 4K matches 2160p", SF.matchesQuality(titleOnly4k, "2160p") === true);
check("quality: 4k alias equals 2160p", SF.matchesQuality({ title: "X", quality: "4k" }, "2160p") === true);
check("quality: missing everything → true for 'all'", SF.matchesQuality({}, "all") === true);
check("qualityPattern: 1080p built", SF.qualityPattern("1080p").test("Film 1080p WEB-DL") === true);
check("qualityPattern: unknown → null", SF.qualityPattern("banana") === null);

// ── 5. combineChecks (All / Any match mode) ─────────────────────────────────
check("combine: empty checks → show all", SF.combineChecks([], "all") === true);
check("combine: empty checks + any → show all", SF.combineChecks([], "any") === true);
check("combine: ALL mode → [true,true] true", SF.combineChecks([true, true], "all") === true);
check("combine: ALL mode → [true,false] false", SF.combineChecks([true, false], "all") === false);
check("combine: ANY mode → [true,false] true", SF.combineChecks([true, false], "any") === true);
check("combine: ANY mode → [false,false] false", SF.combineChecks([false, false], "any") === false);
check("combine: non-boolean entries ignored", SF.combineChecks([undefined, true], "all") === true);

// ── 6. activeFilterCount ────────────────────────────────────────────────────
check("activeFilterCount: all/all → 0", SF.activeFilterCount({ language: "all", quality: "all" }) === 0);
check("activeFilterCount: hindi+1080p → 2", SF.activeFilterCount({ language: "hindi", quality: "1080p" }) === 2);
check("activeFilterCount: english only → 1", SF.activeFilterCount({ language: "english", quality: "all" }) === 1);
check("activeFilterCount: original counts as OFF", SF.activeFilterCount({ language: "original", quality: "all" }) === 0);

// ── 7. strictFilterTorrents (download path) ─────────────────────────────────
const pool = [
  { title: "A 2024 Hindi Dubbed 720p", quality: "720p", language_tags: ["hindi"], seeds: 10 },
  { title: "B 2024 720p", quality: "720p", language_tags: ["english"], seeds: 90 },
  { title: "C 2024 Hindi Dubbed 1080p", quality: "1080p", language_tags: ["hindi"], seeds: 50 },
  { title: "D 2024 Hindi Dubbed", quality: "unknown", seeds: 5 },
];
check("strict: hindi+720p keeps ONLY matching row", SF.strictFilterTorrents(pool, { language: "hindi", quality: "720p" }).length === 1);
check(
  "strict: hindi+720p picks the right row",
  (SF.strictFilterTorrents(pool, { language: "hindi", quality: "720p" })[0]?.title || "").startsWith("A ")
);
check("strict: language-only (hindi) → hindi rows incl. unknown quality", SF.strictFilterTorrents(pool, { language: "hindi", quality: "all" }).length === 3);
check("strict: quality-only (1080p) → 1080p rows", SF.strictFilterTorrents(pool, { language: "all", quality: "1080p" }).length === 1);
check("strict: all/all → full pool", SF.strictFilterTorrents(pool, { language: "all", quality: "all" }).length === pool.length);
check("strict: no silent fallback — english+4k → []", SF.strictFilterTorrents(pool, { language: "english", quality: "2160p" }).length === 0);
check("strict: non-array input → []", SF.strictFilterTorrents(null, { language: "all", quality: "all" }).length === 0);

// ── 8. Labels & query fragments ─────────────────────────────────────────────
check("languageLabel: hindi", SF.languageLabel("hindi") === "Hindi Dubbed");
check("languageLabel: english", SF.languageLabel("english") === "English");
check("languageLabel: all → Any", SF.languageLabel("all") === "Any");
check("qualityLabel: 2160p → 4K / 2160p", SF.qualityLabel("2160p") === "4K / 2160p");
check("qualityLabel: all → empty", SF.qualityLabel("all") === "");
check("languageQueryFor: hindi", SF.languageQueryFor("hindi") === "hindi dubbed");
check("languageQueryFor: english", SF.languageQueryFor("english") === "english");
check("languageQueryFor: all → empty", SF.languageQueryFor("all") === "");

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${results.passed} passed, ${results.failed} failed`);
if (results.failed > 0) process.exitCode = 1;

