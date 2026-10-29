"use strict";

const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");

function extractCandidateCoreTitle(candidate) {
  let s = String(candidate || "").replace(/[._]/g, " ").trim();
  const metaRegex = /\b(?:s\d{1,2}|season\s*\d+|\d{1,2}x\d{1,2}|e\d{1,2}|ep\s*\d+|episode\s*\d+|19\d{2}|20\d{2}|480p|720p|1080p|2160p|4k|uhd|bluray|web-?dl|webrip|brrip|hdtv|nf|amzn|dsnp|hbo|complete|repack|dual|hindi|dubbed)\b/i;
  const match = s.match(metaRegex);
  if (match && match.index > 0) {
    s = s.slice(0, match.index);
  }
  return s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "the", "and", "a", "an", "of", "in", "to", "for", "with", "all",
  "season", "complete", "series", "hindi", "dual", "audio", "dubbed", "part"
]);

function isMismatch(mediaTitle, magnetDn) {
  if (!mediaTitle || !magnetDn) return false;
  // Clean mediaTitle: remove ' - S01E01' etc.
  const cleanTarget = mediaTitle.replace(/[\s_-]+s\d{1,2}(?:e\d{1,2})?.*$/i, "").trim();
  const normT = cleanTarget.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const tWords = normT.split(/\s+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  if (tWords.length === 0) return false;

  const cCore = extractCandidateCoreTitle(magnetDn);
  const cWords = cCore.split(/\s+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  // 1. All target words must be present in candidate
  for (const tw of tWords) {
    if (!cWords.includes(tw)) return true; // Missing a target word = mismatch!
  }

  // 2. Candidate must NOT have extra major content words
  const extraWords = cWords.filter((cw) => !tWords.includes(cw));
  return extraWords.length > 0;
}

async function main() {
  const sb = getSupabaseClient();
  let lastSeenId = 0;
  const batchSize = 1000;
  let totalChecked = 0;
  let mismatched = [];

  console.log("🔍 Scanning media_sources for mismatched torrents...");

  while (true) {
    const { data: rows, error } = await sb
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, magnet_link")
      .gt("id", lastSeenId)
      .order("id", { ascending: true })
      .limit(batchSize);

    if (error) {
      console.error("DB error:", error.message);
      break;
    }
    if (!rows || rows.length === 0) break;

    lastSeenId = rows[rows.length - 1].id;
    totalChecked += rows.length;

    for (const r of rows) {
      const match = (r.magnet_link || "").match(/dn=([^&]+)/i);
      const dn = match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : "";
      if (dn && isMismatch(r.media_title, dn)) {
        mismatched.push({ id: r.id, media_id: r.media_id, title: r.media_title, dn });
      }
    }
  }

  console.log(`\n📊 Total Rows Scanned: ${totalChecked}`);
  console.log(`❌ Total Mismatched Torrents Found: ${mismatched.length}`);

  if (mismatched.length > 0) {
    console.log("\nSample Mismatches (First 20):");
    mismatched.slice(0, 20).forEach((m) => {
      console.log(`  [ID ${m.id}] "${m.title}" -> "${m.dn}"`);
    });

    const idsToDelete = mismatched.map((m) => m.id);
    console.log(`\n🗑️ Purging ${idsToDelete.length} mismatched rows from media_sources...`);

    // Delete in chunks of 200
    for (let i = 0; i < idsToDelete.length; i += 200) {
      const chunk = idsToDelete.slice(i, i + 200);
      const { error: delErr } = await sb.from(MEDIA_SOURCES_TABLE).delete().in("id", chunk);
      if (delErr) {
        console.error("Delete chunk error:", delErr.message);
      }
    }
    console.log(`✅ Successfully purged ${idsToDelete.length} mismatched rows!`);
  } else {
    console.log("✨ No mismatched torrents found.");
  }
}

main().catch(console.error);

