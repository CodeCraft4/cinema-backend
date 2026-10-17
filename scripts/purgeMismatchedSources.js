"use strict";

const { getSupabaseClient } = require("../server/services/supabaseClient");

function matchesTargetTitle(candidateTitle, targetTitle) {
  if (!targetTitle) return true;
  const normT = String(targetTitle || "").toLowerCase().replace(/\./g, "");
  const normC = String(candidateTitle || "").toLowerCase().replace(/\./g, "");
  const c = normC.replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const t = normT.replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  if (!c || !t) return true;

  const STOP_WORDS = new Set([
    "season", "complete", "series", "hindi", "dual", "audio", "dubbed",
    "the", "and", "a", "an", "of", "in", "to", "for", "with", "all",
    "episodes", "episode", "part"
  ]);
  const tWords = t.split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  if (!tWords.length) return c.includes(t);

  const cWords = new Set(c.split(/\s+/));
  if (tWords.length === 1) {
    const singleWord = tWords[0];
    return cWords.has(singleWord) || c.includes(singleWord);
  }

  let matchCount = 0;
  for (const w of tWords) {
    if (cWords.has(w) || c.includes(w)) matchCount++;
  }
  return matchCount >= Math.ceil(tWords.length * 0.5);
}

// Known legitimate alternative title pairs
function isKnownLegitAlt(targetTitle, torrentTitle) {
  const t = targetTitle.toLowerCase();
  const c = torrentTitle.toLowerCase();
  if (t.includes("like stars on earth") && c.includes("taare zameen par")) return true;
  if (t.includes("erkenci") && c.includes("day dreamer")) return true;
  if (t.includes("fake profile") && c.includes("perfil falso")) return true;
  if (t.includes("you+me") && c.includes("toi+moi")) return true;
  if (t.includes("desperate housewives") && c.includes("gotow")) return true;
  if (t.includes("green street hooligans") && c.includes("hooligans")) return true;
  return false;
}

async function purgeMismatchedSources() {
  console.log("=================================================================");
  console.log(" 🧹 Purging Bogus & Mismatched Torrents from media_sources");
  console.log("=================================================================\n");

  const supabase = getSupabaseClient();
  let totalScanned = 0;
  let totalPurged = 0;
  let offset = 0;
  const batchSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("media_sources")
      .select("id, media_id, media_title, payload")
      .range(offset, offset + batchSize - 1);

    if (error || !data || data.length === 0) break;
    totalScanned += data.length;

    const bogusIds = [];
    for (const row of data) {
      const torrentTitle = row.payload?.title || "";
      const mediaTitle = row.media_title || "";
      if (!torrentTitle) continue;

      // 1. Check Ranma spam on non-Ranma shows
      if (/Ranma/i.test(torrentTitle) && !/Ranma/i.test(mediaTitle)) {
        bogusIds.push({ id: row.id, mediaTitle, torrentTitle, reason: "Ranma spam on non-Ranma title" });
        continue;
      }

      // 2. Check S.W.A.T. bogus rows (3 Idiots, Supergirl)
      if (/s\.?w\.?a\.?t\.?/i.test(mediaTitle) && (/3 Idiots/i.test(torrentTitle) || /Supergirl/i.test(torrentTitle))) {
        bogusIds.push({ id: row.id, mediaTitle, torrentTitle, reason: "S.W.A.T. mismatched title" });
        continue;
      }

      // 3. Known legit pairs
      if (isKnownLegitAlt(mediaTitle, torrentTitle)) {
        continue;
      }

      // 4. General title match check
      if (!matchesTargetTitle(torrentTitle, mediaTitle)) {
        bogusIds.push({ id: row.id, mediaTitle, torrentTitle, reason: "Title does not match media" });
      }
    }

    if (bogusIds.length > 0) {
      console.log(`Found ${bogusIds.length} bogus rows in batch ${offset}-${offset + data.length}:`);
      bogusIds.slice(0, 5).forEach((b) => {
        console.log(`  ❌ [${b.id}] "${b.mediaTitle}" -> "${b.torrentTitle}" (${b.reason})`);
      });

      const idsToDelete = bogusIds.map((b) => b.id);
      const { error: delError } = await supabase.from("media_sources").delete().in("id", idsToDelete);
      if (delError) {
        console.error("Delete error:", delError.message);
      } else {
        totalPurged += bogusIds.length;
        console.log(`  🗑️ Successfully deleted ${bogusIds.length} bogus rows.`);
      }
    }

    if (data.length < batchSize) break;
    offset += batchSize;
  }

  console.log(`\n✅ Finished scan. Total scanned: ${totalScanned}, Total purged: ${totalPurged}\n`);
}

purgeMismatchedSources().catch((err) => {
  console.error("Error during purge:", err);
  process.exit(1);
});
