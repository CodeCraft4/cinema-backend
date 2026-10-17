const { getSupabaseClient, MEDIA_SOURCES_TABLE } = require('../server/services/supabaseClient');

async function purgeJunkSources() {
  console.log("===============================================================================");
  console.log(" 🧹 Purging 4K, Oversized (>4.5GB), Dead (<3 seeds), and English-only Sources");
  console.log("===============================================================================\n");

  const supabase = getSupabaseClient();
  let offset = 0;
  const toDelete = [];

  while (true) {
    const { data, error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .select('id, media_title, quality, language, size_bytes, seeders')
      .range(offset, offset + 999);

    if (error || !data || data.length === 0) break;

    for (const r of data) {
      const q = String(r.quality || '').toLowerCase();
      const l = String(r.language || '').toLowerCase();
      const bytes = Number(r.size_bytes) || 0;
      const seeders = Number(r.seeders) || 0;

      const is4K = q.includes('2160') || q.includes('4k');
      const isOversized = bytes > 4.5 * 1024 * 1024 * 1024;
      const isDead = seeders < 3;
      const isPureEnglish = (l === 'english' || l === 'en' || l === 'original') && !l.includes('hindi') && !l.includes('dual') && !l.includes('urdu');

      if (is4K || isOversized || isDead || isPureEnglish) {
        toDelete.push(r.id);
      }
    }

    if (data.length < 1000) break;
    offset += 1000;
  }

  console.log(`Found ${toDelete.length} junk/dead sources to delete.`);
  if (toDelete.length === 0) {
    console.log("Database is already clean!");
    return;
  }

  // Delete in batches of 100 for maximum speed
  let deleted = 0;
  const BATCH = 100;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const chunk = toDelete.slice(i, i + BATCH);
    const { error } = await supabase
      .from(MEDIA_SOURCES_TABLE)
      .delete()
      .in('id', chunk);

    if (error) {
      console.error(`Failed to delete batch ${i}-${i + BATCH}:`, error.message);
    } else {
      deleted += chunk.length;
      process.stdout.write(`\rProgress: ${deleted} / ${toDelete.length} sources deleted...`);
    }
  }

  console.log(`\n\n✅ Successfully deleted ${deleted} bad sources! Only healthy Hindi & Dual Audio remain.`);
}

purgeJunkSources().catch((err) => {
  console.error("Error purging sources:", err);
  process.exit(1);
});
