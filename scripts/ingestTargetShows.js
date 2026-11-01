"use strict";

const { getSupabaseClient } = require("../server/services/supabaseClient");
const { fetchTorrentio } = require("../server/services/torrentioClient");
const { saveTorrentRelease } = require("../server/services/mediaSourceService");

const supabase = getSupabaseClient();

async function ingestShow(name, tmdbId, imdbId, totalEpisodes, season = 1) {
  console.log(`\n======================================================`);
  console.log(`🎬 Ingesting: ${name} (TMDB: ${tmdbId}, IMDB: ${imdbId}) S0${season}`);
  console.log(`======================================================`);

  for (let ep = 1; ep <= totalEpisodes; ep++) {
    const mediaId = `${tmdbId}-s${String(season).padStart(2, "0")}e${String(ep).padStart(2, "0")}`;
    console.log(`\n[${name}] Checking S${season}E${ep} (media_id: ${mediaId})...`);

    // Check if already in Supabase
    const { data: existing } = await supabase
      .from("media_sources")
      .select("id")
      .eq("media_id", mediaId)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`⏩ ${mediaId} already exists in Supabase. Skipping.`);
      continue;
    }

    try {
      const res = await fetchTorrentio(`series/${imdbId}:${season}:${ep}`);
      const streams = res?.streams || [];
      const hindiStreams = streams.filter((s) => /\bhindi\b|\bhin\b|\bhindustani\b/i.test(s.title || s.name));

      if (hindiStreams.length === 0) {
        console.warn(`⚠️ No verified Hindi stream found for ${name} S${season}E${ep}`);
        continue;
      }

      // Pick top seeder / quality stream
      const topStream = hindiStreams[0];
      const infoHash = topStream.infoHash;
      const fileIdx = topStream.fileIdx;
      const fileName = topStream.behaviorHints?.filename || null;
      const releaseTitle = topStream.title.split("\n")[0].trim();

      const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(releaseTitle)}`;
      const qualityMatch = (topStream.name + " " + topStream.title).match(/(2160p|1080p|720p|480p)/i);
      const quality = qualityMatch ? qualityMatch[1].toLowerCase() : "1080p";

      console.log(`💾 Saving S${season}E${ep} -> ${infoHash} (fileIdx: ${fileIdx}, quality: ${quality})`);

      const saved = await saveTorrentRelease(
        {
          mediaId: tmdbId,
          title: `${name} - S0${season}E${String(ep).padStart(2, "0")}`,
          season,
          episode: ep,
          mediaType: "tv",
          language: "Hindi",
          quality,
          origin: "US",
        },
        {
          magnet_link: magnet,
          title: releaseTitle,
          quality,
          language: "Hindi",
          seeders: 25,
          file_name: fileName,
          file_idx: fileIdx,
        }
      );

      if (saved) {
        console.log(`✅ Successfully saved ${mediaId}!`);
      } else {
        console.warn(`❌ Failed to save ${mediaId}`);
      }
    } catch (err) {
      console.error(`Error fetching ${name} S${season}E${ep}:`, err.message);
    }
  }
}

async function run() {
  // 1. Game of Thrones S01 (TMDB: 1399, IMDB: tt0944947) - 10 episodes
  await ingestShow("Game of Thrones", 1399, "tt0944947", 10, 1);

  // 2. Lupin S01 (TMDB: 96677, IMDB: tt2531336) - 5 episodes
  await ingestShow("Lupin", 96677, "tt2531336", 5, 1);

  console.log("\n🎉 Ingestion complete!");
  process.exit(0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

