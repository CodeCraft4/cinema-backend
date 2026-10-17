/**
 * Shared search-filter logic for the Search page.
 *
 * Loaded two ways:
 *   • Renderer:  <script src="searchFilters.js"> → window.SearchFilters
 *   • Terminal:  require("../src/searchFilters")  → module.exports
 *
 * Pure functions only (no DOM / Electron) so scripts/test-search-filters.js
 * can verify the exact same code the UI runs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SearchFilters = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /**
   * Famous production countries only (major movie / series industries).
   * Keeps the country dropdown short and useful instead of 240 TMDb rows.
   * Order = typical relevance for movies & series.
   */
  const FAMOUS_COUNTRIES = [
    { iso: "US", name: "United States" },
    { iso: "IN", name: "India" },
    { iso: "GB", name: "United Kingdom" },
    { iso: "KR", name: "South Korea" },
    { iso: "JP", name: "Japan" },
    { iso: "FR", name: "France" },
    { iso: "DE", name: "Germany" },
    { iso: "ES", name: "Spain" },
    { iso: "IT", name: "Italy" },
    { iso: "CN", name: "China" },
    { iso: "HK", name: "Hong Kong" },
    { iso: "TW", name: "Taiwan" },
    { iso: "CA", name: "Canada" },
    { iso: "AU", name: "Australia" },
    { iso: "MX", name: "Mexico" },
    { iso: "BR", name: "Brazil" },
    { iso: "TR", name: "Turkey" },
    { iso: "TH", name: "Thailand" },
    { iso: "NG", name: "Nigeria" },
    { iso: "AR", name: "Argentina" },
    { iso: "RU", name: "Russia" },
    { iso: "SE", name: "Sweden" },
    { iso: "DK", name: "Denmark" },
    { iso: "NO", name: "Norway" },
    { iso: "PL", name: "Poland" },
    { iso: "NL", name: "Netherlands" },
    { iso: "IE", name: "Ireland" },
    { iso: "NZ", name: "New Zealand" },
    { iso: "PH", name: "Philippines" },
    { iso: "ID", name: "Indonesia" },
    { iso: "PK", name: "Pakistan" },
    { iso: "BD", name: "Bangladesh" },
    { iso: "EG", name: "Egypt" },
    { iso: "ZA", name: "South Africa" },
    { iso: "PT", name: "Portugal" },
    { iso: "GR", name: "Greece" },
  ];

  // Same rules as parseTorrentReleaseMeta() in src/torrentSearch.js — keep in sync.
  // Hindi / Urdu / Pakistani / Indian dubbed audio (not the word "Indiana").
  const HINDI_RE =
    /\bhindi\b|\bhin\b|\burdu\b|\burd\b|bollywood|lollywood|dual[ ._-]?audio|\bdesi\b|hindi[ ._-]?(?:dub|flac)|urdu[ ._-]?(?:dub|audio)|pakistani|indian[ ._-]?(?:dub|audio)/i;

  const ORIG_LANG_SHORT = {
    en: "EN",
    hi: "HI",
    ur: "UR",
    pa: "PA",
    ta: "TA",
    te: "TE",
    ml: "ML",
    kn: "KN",
    bn: "BN",
    ko: "KO",
    ja: "JA",
    zh: "ZH",
    fr: "FR",
    es: "ES",
    de: "DE",
    it: "IT",
    pt: "PT",
    ru: "RU",
    tr: "TR",
    ar: "AR",
    th: "TH",
  };

  function qualityPattern(quality) {
    const q = String(quality || "").toLowerCase();
    if (q === "2160p" || q === "4k") return /\b(2160p|4k|uhd)\b/i;
    if (q === "1080p") return /\b(1080p|1080|fhd)\b/i;
    if (q === "720p") return /\b(720p|720|hdrip)\b/i;
    return null;
  }

  function textOf(item) {
    return `${item?.title || ""} ${item?.language || ""}`.trim();
  }

  function languageTagsOf(item) {
    const tags = item?.language_tags || item?.languageTags || [];
    return Array.isArray(tags) ? tags.map((t) => String(t || "").toLowerCase()) : [];
  }

  function originCountriesOf(item) {
    const raw = item?.originCountry || item?.origin_country || item?.productionCountries || [];
    if (Array.isArray(raw)) {
      return raw.map((code) => String(code || "").toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
    }
    const one = String(raw || "").toUpperCase();
    return /^[A-Z]{2}$/.test(one) ? [one] : [];
  }

  function tmdbItemMatchesCountry(item, country) {
    const iso = String(country || "all").toUpperCase();
    if (!iso || iso === "ALL") return true;
    const codes = originCountriesOf(item);
    if (codes.includes(iso)) return true;
    // Cached rows sometimes omit origin_country — use language as a weak IN/PK signal only.
    const original = String(item?.originalLanguage || "").toLowerCase();
    if (iso === "IN" && ["hi", "ta", "te", "ml", "kn", "bn", "pa"].includes(original)) return true;
    if (iso === "PK" && ["ur", "pa"].includes(original)) return true;
    return false;
  }

  /**
   * Strict language match for a torrent row.
   *  - "hindi"   → title/tags must look Hindi (dual audio counts — it contains Hindi).
   *  - "english" → explicit English tag/markers; when the row carries DB tags and
   *                none say English it is rejected; live provider rows without tags
   *                fall back to "anything that is not Hindi".
   *  - "all"     → always true.
   */
  function torrentMatchesLanguage(item, language) {
    const lang = String(language || "all").toLowerCase();
    if (!lang || lang === "all" || lang === "original") return true;

    const tags = languageTagsOf(item);
    const text = textOf(item);
    const isHindi = tags.includes("hindi") || HINDI_RE.test(text);

    if (lang === "hindi") return isHindi;
    if (lang === "english") {
      if (tags.includes("english") || tags.includes("en")) return true;
      if (String(item?.originalLanguage || item?.original_language || "").toLowerCase() === "en") return true;
      if (tags.length > 0) return false; // DB tags present but no English → not English
      return /\beng(?:lish)?\b/i.test(text); // do not guess English from "not Hindi"
    }
    return true;
  }

  /**
   * Language match for a TMDb catalog card (movies / series).
   *  - "hindi"   → original language Hindi/Urdu OR Hindi markers in the title.
   *  - "english" → original language English, or unknown language without Hindi markers.
   */
  function tmdbItemMatchesLanguage(item, language) {
    const lang = String(language || "all").toLowerCase();
    if (!lang || lang === "all" || lang === "original") return true;

    const title = String(item?.title || "");
    const original = String(item?.originalLanguage || "").toLowerCase();
    const isHindiTitle = HINDI_RE.test(title);
    const countries = originCountriesOf(item);

    if (lang === "hindi") {
      if (["hi", "ur", "pa"].includes(original) || isHindiTitle) return true;
      if (countries.some((code) => code === "IN" || code === "PK")) return true;
      return false;
    }
    if (lang === "english") {
      if (original === "en") return true;
      if (!original) return !isHindiTitle;
      return false;
    }
    return true;
  }

  /** Original-language chip from TMDb (always real). */
  function originalLanguageChip(originalLanguage) {
    const orig = String(originalLanguage || "").toLowerCase();
    if (!orig) return "ORIG";
    return ORIG_LANG_SHORT[orig] || orig.slice(0, 3).toUpperCase();
  }

  /**
   * Card badges: original language always, plus Hindi/English only when those
   * audio tracks are known (torrent tags or the original language itself).
   */
  function cardLanguageLabels(item, torrentLanguages = []) {
    const labels = [];
    const seen = new Set();
    const push = (label) => {
      const key = String(label || "").toUpperCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      labels.push(label);
    };
    const orig = String(item?.originalLanguage || "").toLowerCase();
    const origChip = originalLanguageChip(orig);
    const extras = (Array.isArray(torrentLanguages) ? torrentLanguages : []).map((t) =>
      String(t || "").toLowerCase()
    );
    const hasHindi =
      extras.includes("hindi") || ["hi", "ur"].includes(orig) || extras.includes("hi");
    const hasEnglish = extras.includes("english") || orig === "en" || extras.includes("en");

    if (hasEnglish) push("EN");
    if (hasHindi) push("HI");
    if (origChip && origChip !== "EN" && origChip !== "HI") push(origChip);
    else if (!hasEnglish && !hasHindi) push(origChip);
    else if ((hasEnglish || hasHindi) && orig && orig !== "en" && orig !== "hi" && orig !== "ur") {
      push("ORIG");
    }
    return labels;
  }

  /** Strict quality match — honours the parsed `quality` column, then the title. */
  function matchesQuality(item, quality) {
    const q = String(quality || "all").toLowerCase();
    if (!q || q === "all") return true;

    const parsed = String(item?.quality || "").toLowerCase();
    if (parsed && parsed !== "unknown") {
      if (parsed === q) return true;
      if ((q === "2160p" || q === "4k") && (parsed === "4k" || parsed === "2160p")) return true;
      // Parsed quality known but different → trust the parser over the title.
      if (parsed === "2160p" || parsed === "1080p" || parsed === "720p") return false;
    }

    const pattern = qualityPattern(q);
    if (!pattern) return true;
    const text = `${item?.title || ""} ${item?.language || ""}`;
    return pattern.test(text);
  }

  /**
   * Combine per-filter boolean results with the Match mode.
   * checks = [] → true (no active filter → show everything).
   * mode "all"  → every active filter must match.
   * mode "any"  → at least one active filter must match.
   */
  function combineChecks(checks, mode) {
    const values = (Array.isArray(checks) ? checks : []).filter((c) => typeof c === "boolean");
    if (!values.length) return true;
    return String(mode || "all").toLowerCase() === "any" ? values.some(Boolean) : values.every(Boolean);
  }

  /** How many filters are actually active (drives UI hints). */
  function activeFilterCount({ language = "all", quality = "all" } = {}) {
    let n = 0;
    if (language && language !== "all" && language !== "original") n += 1;
    if (quality && quality !== "all") n += 1;
    return n;
  }

  /**
   * Download-time strict filter — language AND quality must both match
   * (never silently falls back to another language or quality).
   */
  function strictFilterTorrents(items, { language = "all", quality = "all" } = {}) {
    return (Array.isArray(items) ? items : []).filter(
      (t) => torrentMatchesLanguage(t, language) && matchesQuality(t, quality)
    );
  }

  function languageLabel(language) {
    const lang = String(language || "all").toLowerCase();
    if (lang === "hindi") return "Hindi Dubbed";
    if (lang === "english") return "English";
    return "Any";
  }

  function qualityLabel(quality) {
    const q = String(quality || "all").toLowerCase();
    if (!q || q === "all") return "";
    if (q === "2160p") return "4K / 2160p";
    return q;
  }

  /** Search-query fragment for a preferred download language. */
  function languageQueryFor(language) {
    const lang = String(language || "all").toLowerCase();
    if (lang === "hindi") return "hindi dubbed";
    if (lang === "english") return "english";
    return "";
  }

  /** Extra Hindi/Urdu query rounds so dubbed Indian/Pakistani audio is found. */
  function languageQueriesFor(language) {
    const lang = String(language || "all").toLowerCase();
    if (lang === "hindi") return ["hindi dubbed", "dual audio hindi", "urdu"];
    const one = languageQueryFor(lang);
    return one ? [one] : [];
  }

  function qualityQueryFor(quality) {
    const q = String(quality || "all").toLowerCase();
    if (q === "2160p" || q === "4k") return "2160p";
    if (q === "1080p" || q === "720p") return q;
    return "";
  }

  return {
    FAMOUS_COUNTRIES,
    HINDI_RE,
    qualityPattern,
    torrentMatchesLanguage,
    tmdbItemMatchesLanguage,
    tmdbItemMatchesCountry,
    originCountriesOf,
    originalLanguageChip,
    cardLanguageLabels,
    matchesQuality,
    combineChecks,
    activeFilterCount,
    strictFilterTorrents,
    languageLabel,
    qualityLabel,
    languageQueryFor,
    languageQueriesFor,
    qualityQueryFor,
  };
});


