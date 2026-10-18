/**
 * fixTvPosterUrls.js
 * Restores true vertical theatrical series posters for all TV episodes in media_sources.
 * Moves any landscape episode stills to payload.still_url.
 */

const axios = require("axios");
const { getSupabaseClient, MEDIA_SOURCES_TABLE, MEDIA_CONTENT_TABLE } = require("../server/services/supabaseClient");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "40b06951f1c6497bbe2bc6d9e5ad6b47";

async function main() {
  console.log("===============================================================================");
  console.log(" 📺 Fast Fixing TV Series Poster URLs in Supabase media_sources");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();

  // 1. Fetch all TV episode sources
  console.log("🔍 Fetching TV sources from media_sources...");
  let allSources = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, payload")
      .ilike("media_id", "%-s%e%")
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error("❌ Error fetching media_sources:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allSources = allSources.concat(data);
    page++;
    if (data.length < pageSize) break;
  }

  console.log(`✅ Loaded ${allSources.length} TV episode sources from media_sources.`);

  // 2. Group by showId
  const showMap = new Map();
  for (const s of allSources) {
    const showId = s.media_id.split(/-s/i)[0];
    if (!showMap.has(showId)) {
      showMap.set(showId, []);
    }
    showMap.get(showId).push(s);
  }

  console.log(`📊 Found ${showMap.size} unique TV shows.\n`);

  // Preload all media_content rows in one query!
  const showIds = Array.from(showMap.keys());
  const { data: contentRows } = await supabase
    .from(MEDIA_CONTENT_TABLE)
    .select("external_id, title, details")
    .in("external_id", showIds);

  const contentMap = new Map();
  if (contentRows) {
    for (const c of contentRows) {
      contentMap.set(String(c.external_id), c);
    }
  }

  let fixedCount = 0;
  let showIdx = 0;

  for (const [showId, episodes] of showMap.entries()) {
    showIdx++;
    let showPoster = null;
    let showBackdrop = null;
    let showTitle = episodes[0]?.media_title?.split(/\s+S\d+/i)[0] || "TV Show";

    // A. Check preloaded media_content
    const c = contentMap.get(String(showId));
    if (c && c.details) {
      const d = c.details;
      showPoster = d.poster_url || d.poster || (d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null);
      showBackdrop = d.backdrop_url || d.backdrop || (d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : null);
      if (c.title) showTitle = c.title;
    }

    // B. Direct TMDB fallback if missing
    if (!showPoster && /^\d+$/.test(showId)) {
      try {
        const res = await axios.get(`https://api.themoviedb.org/3/tv/${showId}`, {
          params: { api_key: TMDB_API_KEY },
          timeout: 4000,
        });
        if (res.data?.poster_path) {
          showPoster = `https://image.tmdb.org/t/p/w500${res.data.poster_path}`;
        }
        if (res.data?.backdrop_path) {
          showBackdrop = `https://image.tmdb.org/t/p/w1280${res.data.backdrop_path}`;
        }
        if (res.data?.name) showTitle = res.data.name;
      } catch (_) {}
    }

    if (!showPoster) {
      console.warn(`  ⚠️ [${showIdx}/${showMap.size}] Could not find show poster for Show ID ${showId} ("${showTitle}")`);
      continue;
    }

    console.log(`  🎬 [${showIdx}/${showMap.size}] "${showTitle}" (ID: ${showId}) -> Show Poster: ${showPoster.substring(showPoster.lastIndexOf("/"))}`);

    // Update episode rows in parallel chunks of 15
    const CHUNK_SIZE = 15;
    for (let i = 0; i < episodes.length; i += CHUNK_SIZE) {
      const chunk = episodes.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (epRow) => {
          const payload = epRow.payload && typeof epRow.payload === "object" ? { ...epRow.payload } : {};
          const currentPoster = payload.series_poster_url || payload.poster_url || "";
          const currentStill = payload.still_url;

          let stillUrl = currentStill;
          if (!stillUrl && currentPoster && currentPoster !== showPoster) {
            stillUrl = currentPoster;
          }

          const needsUpdate =
            payload.series_poster_url !== showPoster ||
            payload.poster_url !== showPoster ||
            payload.still_url !== stillUrl ||
            (showBackdrop && !payload.backdrop_url);

          if (needsUpdate) {
            payload.series_poster_url = showPoster;
            payload.poster_url = showPoster;
            if (stillUrl) payload.still_url = stillUrl;
            if (showBackdrop && !payload.backdrop_url) payload.backdrop_url = showBackdrop;

            const { error: updErr } = await supabase
              .from(MEDIA_SOURCES_TABLE)
              .update({ payload })
              .eq("id", epRow.id);

            if (!updErr) fixedCount++;
          }
        })
      );
    }
  }

  console.log(`\n===============================================================================`);
  console.log(` 🎉 DONE! Fixed ${fixedCount} episodes across ${showMap.size} TV shows with official posters!`);
  console.log(`===============================================================================\n`);
}

main().catch(console.error);
