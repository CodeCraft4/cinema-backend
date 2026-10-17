"use strict";

const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require("../server/services/supabaseClient");

async function main() {
  console.log("===============================================================================");
  console.log(" 🔄 Migrating Single-Episode Torrents to Scoped Media IDs (-s01e01)");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  let offset = 0;
  const batchSize = 200;
  let totalChecked = 0;
  let totalMigrated = 0;

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select("id, media_id, media_title, payload")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error("❌ Supabase query error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const r of data) {
      totalChecked++;
      const pTitle = r.payload?.title || "";
      const mTitle = r.media_title || "";
      const fullText = `${pTitle} ${mTitle}`;

      // Check for SxxExx in title or payload filename
      const match = fullText.match(/s0*(\d+)[^a-z0-9]*e0*(\d+)/i) || fullText.match(/\b(\d+)x0*(\d+)\b/i);
      if (match && r.media_id && !/-s\d+e\d+/i.test(r.media_id)) {
        const sNum = Number(match[1]);
        const eNum = Number(match[2]);
        const sPad = String(sNum).padStart(2, "0");
        const ePad = String(eNum).padStart(2, "0");
        const newMediaId = `${r.media_id}-s${sPad}e${ePad}`;
        const newTitle = `${mTitle.replace(/\s*-\s*Season\s*\d+/i, "").replace(/\s*-\s*S\d+E\d+/i, "").trim()} - S${sPad}E${ePad}`;

        console.log(`📌 Migrating Row #${r.id}: "${r.media_id}" -> "${newMediaId}" (${pTitle.slice(0, 60)})`);

        const { error: updateError } = await supabase
          .from(MEDIA_SOURCES_TABLE)
          .update({
            media_id: newMediaId,
            media_title: newTitle,
            payload: {
              ...r.payload,
              season: sNum,
              episode: eNum,
            },
          })
          .eq("id", r.id);

        if (updateError) {
          console.warn(`⚠️ Update failed for #${r.id}:`, updateError.message);
        } else {
          totalMigrated++;
        }
      }
    }

    if (data.length < batchSize) break;
    offset += batchSize;
  }

  console.log("\n===============================================================================");
  console.log(`🎉 Migration Completed! Scanned: ${totalChecked} rows · Migrated: ${totalMigrated} rows`);
  console.log("===============================================================================");
}

main().catch(console.error);
