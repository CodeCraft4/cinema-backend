"use strict";

/**
 * Cleanup script to remove podcasts, interviews, press conferences, talk shows,
 * behind-the-scenes, making-of videos from Supabase media_content & media_sources.
 */

const { getSupabaseClient, MEDIA_CONTENT_TABLE, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");

const NOISE_KEYWORDS = [
  "podcast",
  "interview",
  "talk show",
  "press conference",
  "making of",
  "behind the scenes",
  "red carpet",
  "q&a",
  "unfiltered",
  "bloopers",
  "featurette",
  "cast reacts",
  "trailer collection",
];

async function removePodcastsAndInterviews() {
  const supabase = getSupabaseClient();
  console.log("🔍 Scanning DB for podcast, interview, and talk show entries...");

  // 1. Scan media_content table
  let allContent = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_CONTENT_TABLE)
      .select("id, title, details")
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error("❌ Error reading media_content:", error);
      break;
    }
    allContent.push(...data);
    if (data.length < pageSize) break;
    page++;
  }

  console.log(`📊 Total media_content rows scanned: ${allContent.length}`);

  const contentToDeleteIds = [];
  const matchedTitles = [];

  allContent.forEach((item) => {
    const title = (item.title || "").toLowerCase();
    const overview = (item.details?.overview || item.details?.description || "").toLowerCase();
    const combined = `${title} ${overview}`;

    const isNoise = NOISE_KEYWORDS.some((kw) => combined.includes(kw));

    if (isNoise) {
      contentToDeleteIds.push(item.id);
      matchedTitles.push(item.title);
    }
  });

  console.log(`🎯 Found ${contentToDeleteIds.length} podcast/interview/talk show entries in media_content.`);

  if (matchedTitles.length > 0) {
    console.log("Sample matched items to delete (first 10):", matchedTitles.slice(0, 10));
  }

  if (contentToDeleteIds.length > 0) {
    // Delete from media_content
    const batchSize = 100;
    let deletedContentCount = 0;
    for (let i = 0; i < contentToDeleteIds.length; i += batchSize) {
      const chunk = contentToDeleteIds.slice(i, i + batchSize);
      const { error: delErr } = await supabase
        .from(MEDIA_CONTENT_TABLE)
        .delete()
        .in("id", chunk);

      if (delErr) {
        console.error("❌ Error deleting media_content chunk:", delErr);
      } else {
        deletedContentCount += chunk.length;
      }
    }
    console.log(`✅ Removed ${deletedContentCount} podcast/interview items from media_content.`);
  }

  // 2. Scan media_sources table for podcast/interview torrent sources
  console.log("\n🔍 Scanning media_sources table for podcast/interview torrent sources...");
  let allSources = [];
  page = 0;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_title, cache_key, payload")
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error("❌ Error reading media_sources:", error);
      break;
    }
    allSources.push(...data);
    if (data.length < pageSize) break;
    page++;
  }

  console.log(`📊 Total media_sources rows scanned: ${allSources.length}`);

  const sourcesToDeleteIds = [];

  allSources.forEach((source) => {
    const title = (source.media_title || "").toLowerCase();
    const cacheKey = (source.cache_key || "").toLowerCase();
    const payloadTitle = (source.payload?.title || "").toLowerCase();
    const combined = `${title} ${cacheKey} ${payloadTitle}`;

    const isNoise = NOISE_KEYWORDS.some((kw) => combined.includes(kw));

    if (isNoise) {
      sourcesToDeleteIds.push(source.id);
    }
  });

  console.log(`🎯 Found ${sourcesToDeleteIds.length} podcast/interview sources in media_sources.`);

  if (sourcesToDeleteIds.length > 0) {
    const batchSize = 100;
    let deletedSourceCount = 0;
    for (let i = 0; i < sourcesToDeleteIds.length; i += batchSize) {
      const chunk = sourcesToDeleteIds.slice(i, i + batchSize);
      const { error: delErr } = await supabase
        .from(MEDIA_SOURCES_TABLE)
        .delete()
        .in("id", chunk);

      if (delErr) {
        console.error("❌ Error deleting media_sources chunk:", delErr);
      } else {
        deletedSourceCount += chunk.length;
      }
    }
    console.log(`✅ Removed ${deletedSourceCount} podcast/interview torrent sources from media_sources.`);
  }

  console.log("\n🎉 Podcasts and Interviews cleanup complete!");
}

removePodcastsAndInterviews().catch(console.error);
