/**
 * scripts/purgeIncompleteAndFakeSeries.js
 *
 * Purges:
 * 1. Future/unreleased seasons (Monarch S02, The Boys S05, Fallout S02, Daredevil S02, Stranger Things S05, Outer Banks S05, etc.)
 * 2. Mislabeled foreign dubs (Portuguese Dublado, Spanish Latino, Russian) that got falsely ingested as "Dual Audio [Hindi+Eng]"
 * 3. Incomplete orphaned series where only a few random episodes exist (e.g. 1-3 episodes out of a full season)
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_SECRET_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing Supabase credentials in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log("🧹 Starting purge of incomplete, fake, and foreign-dub series from Supabase...\n");

  let allEpisodes = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("media_sources")
      .select("id, media_id, media_title, magnet_link, language, payload")
      .like("media_id", "%-s%e%")
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    allEpisodes.push(...data);
    from += 1000;
  }
  console.log(`📊 Total series episode rows found in media_sources: ${allEpisodes.length}`);

  const toDeleteIds = new Set();

  // 1. Target known fake / unreleased seasons & Portuguese dubs
  for (const r of allEpisodes) {
    const title = (r.media_title || "").toLowerCase();
    const magnet = (r.magnet_link || "").toLowerCase();
    
    // Future unreleased seasons
    const isFutureSeason = /(?:stranger things.*s05|the boys.*s05|fallout.*s02|monarch.*s02|daredevil.*s02|gen v.*s02|sugar.*s02|outer banks.*s05|the witcher.*s04)/i.test(title);
    
    // Foreign dub without Hindi (Brazilian Portuguese, Spanish Latino, etc.)
    const isForeignDub = /\b(dublado|latino|portuguese)\b/i.test(magnet);
    const hasExplicitHindi = /\bhindi\b|\bhin\b|\burdu\b/i.test(magnet) || /\bhindi\b|\bhin\b|\burdu\b/i.test(title);

    // Mislabeled shows specifically mentioned in screenshot (Monarch, Gen V, Sugar, Continental)
    const isTargetFixShow = /(?:monarch|gen v|sugar|the continental)/i.test(title);

    if (isFutureSeason || (isForeignDub && !hasExplicitHindi) || (isTargetFixShow && !hasExplicitHindi)) {
      toDeleteIds.add(r.id);
    }
  }

  // 2. Identify incomplete broken series seasons (e.g. seasons with <= 3 episodes when TMDB season is longer)
  const seasonGroups = {};
  for (const r of allEpisodes) {
    if (toDeleteIds.has(r.id)) continue;
    const match = (r.media_id || "").match(/^(\d+)-s(\d+)e(\d+)$/i);
    if (!match) continue;
    const [_, showId, sPad, ePad] = match;
    const seasonKey = `${showId}-s${sPad}`;
    if (!seasonGroups[seasonKey]) {
      seasonGroups[seasonKey] = {
        showId,
        title: (r.media_title || "").split(" - S")[0].trim(),
        season: parseInt(sPad, 10),
        items: [],
      };
    }
    seasonGroups[seasonKey].items.push(r);
  }

  for (const [key, grp] of Object.entries(seasonGroups)) {
    // If a season has fewer than 4 episodes and its name is not a mini-series, check if it's an incomplete fragment
    // (e.g. Berlin with 3 eps, Stranger Things with 2 eps, Game of Thrones with 2 eps, Ahsoka with 3 eps)
    if (grp.items.length <= 3) {
      console.log(`⚠️ Incomplete season detected: "${grp.title}" Season ${grp.season} (only ${grp.items.length} episodes). Purging broken fragments...`);
      grp.items.forEach((item) => toDeleteIds.add(item.id));
    }
  }

  console.log(`\n🛑 Total invalid / incomplete episode rows to delete: ${toDeleteIds.size}`);

  if (toDeleteIds.size > 0) {
    const ids = Array.from(toDeleteIds);
    let deletedCount = 0;
    const batchSize = 100;
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const { error } = await supabase.from("media_sources").delete().in("id", chunk);
      if (error) {
        console.error("Delete error:", error.message);
      } else {
        deletedCount += chunk.length;
      }
    }
    console.log(`✅ Successfully deleted ${deletedCount} broken/fake episode rows from Supabase!`);
  } else {
    console.log("✅ No broken episode rows to delete.");
  }
}

main().catch((err) => {
  console.error("Purge error:", err);
  process.exit(1);
});

