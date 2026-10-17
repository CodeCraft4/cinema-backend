/** Home-page emptiness diagnostic: where does the data stop? */
require("dotenv").config({ path: ".env" });

const fs = require("fs");
const os = require("os");
const path = require("path");
const env = require("../server/config/env");
const { createClient } = require("@supabase/supabase-js");
const { createPageCache } = require("../src/supabasePageCache");

const silent = { log() {}, warn() {} };

async function main() {
  const supabase = createClient(env.supabaseUrl, env.supabaseKey);
  const pageCache = createPageCache({ getClient: () => supabase, logger: silent });

  // 1) page-cache: does the home payload exist in Supabase?
  const keys = [
    "popular-mix-v2-p1-l32-e",
    "popular-catalog-p1-l40",
    "movie-2026-vote_average.desc-8-p1",
    "movie-2025-vote_average.desc-8-p1",
  ];
  for (const key of keys) {
    const t0 = Date.now();
    const hit = await pageCache.read(key);
    console.log(
      "[page-cache] " + key + " -> " +
        (hit ? "HIT items=" + ((hit.items || []).length) : "MISS") +
        " (" + (Date.now() - t0) + "ms)"
    );
  }

  // 2) every cache_key that mentions popular
  const { data: popKeys } = await supabase
    .from("media_page_cache")
    .select("cache_key")
    .ilike("cache_key", "%popular%");
  console.log("[db] popular* cache keys:", (popKeys || []).map((r) => r.cache_key));

  // 3) media_content breakdown
  const { data: rows } = await supabase
    .from("media_content")
    .select("source, media_type, details");
  const breakdown = {};
  for (const r of rows || []) {
    const k = r.source + "/" + r.media_type;
    breakdown[k] = (breakdown[k] || 0) + 1;
  }
  console.log("[db] media_content breakdown:", breakdown, "total:", (rows || []).length);

  // 4) disk caches in Electron userData
  const roamed = path.join(os.homedir(), "AppData", "Roaming");
  const candidates = fs
    .readdirSync(roamed)
    .filter((d) => /cine|broad/i.test(d));
  console.log("[disk] userData candidates:", candidates);
  for (const dir of candidates) {
    const full = path.join(roamed, dir);
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".json")) continue;
      const stat = fs.statSync(path.join(full, f));
      let info = "";
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(full, f), "utf8"));
        info = "keys=" + (Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length);
      } catch {}
      console.log("[disk] " + dir + "/" + f + " (" + stat.size + "b) " + info);
    }
  }

  // 5) live TMDb — the home fetch path (key must be uncommented in .env)
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    console.log("[tmdb] TMDB_API_KEY missing!");
  } else {
    const t0 = Date.now();
    try {
      const res = await fetch(
        "https://api.themoviedb.org/3/trending/movie/week?api_key=" + key + "&page=1",
        { signal: AbortSignal.timeout(10000) }
      );
      const data = await res.json().catch(() => ({}));
      console.log(
        "[tmdb] trending/movie/week -> HTTP " + res.status +
          " results=" + ((data.results || []).length) +
          " (" + (Date.now() - t0) + "ms)" +
          (data.status_message ? " msg=" + data.status_message : "")
      );
    } catch (error) {
      console.log("[tmdb] FAILED after " + (Date.now() - t0) + "ms: " + error.message);
    }
  }

  // 6) DB-items fallback API (used when page payload missing AND APIs fail)
  const { createMediaItemStore } = require("../src/mediaItemStore");
  const store = createMediaItemStore({ getClient: () => supabase, logger: silent });
  const listed = await store.listItems({ mediaType: "movie", limit: 6 });
  console.log(
    "[listItems] movie fallback -> " + listed.items.length + " item(s): " +
      listed.items.slice(0, 4).map((i) => i.title + " (" + i.year + ")").join(" | ")
  );
  const yearRows = listed.items.filter((i) => String(i.year) === "2026");
  console.log("[listItems] year=2026 filter -> " + yearRows.length + " item(s)");
}

main().catch((e) => console.log("FAIL:", e.message));
