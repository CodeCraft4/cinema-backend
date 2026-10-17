#!/usr/bin/env node
// Cinebroad Cache Refresh - Clear + Re-fetch TV show cache into Supabase
const path = require('path');
const envPath = path.resolve(__dirname, '..', '.env');
if (require('fs').existsSync(envPath)) require('dotenv').config({ path: envPath });
const env = require('../server/config/env');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(env.supabaseUrl, env.supabaseKey);
const TV = env.tvmazeBaseUrl;

async function fetchShows(page) {
  const r = await fetch(TV + '/shows?page=' + page + '&limit=100');
  if (!r.ok) throw new Error('TVMaze ' + r.status);
  const j = await r.json();
  return Object.values(j).filter(v => v && v.id);
}

async function upsert(s) {
  if (!s.id) return;
  const { error } = await supabase.from('media_content').upsert({
    external_id: s.id, source: 'tvmaze', title: s.name || '?', media_type: 'tv',
    details: JSON.stringify({
      provider: 'tvmaze', tmdb_id: null, premiered: s.premiered,
      status: s.status, rating: s.rating?.average, runtime: s.runtime,
      network: s.network?.name, genres: s.genres || [], summary: s.summary,
      image: s.image?.medium, url: s.url
    })
  }, { onConflict: 'external_id' });
  if (error) throw error;
}

(async () => {
  console.log('=== Cache Refresh ===');
  console.log('Supabase:', env.supabaseUrl);
  console.log('TVMaze:', TV);
  const { count: before } = await supabase.from('media_content').select('external_id', { count: 'exact', head: true });
  console.log('Before:', before ?? 0);
  await supabase.from('media_content').delete().neq('external_id', -1);
  console.log('Cleared');
  let store = [], total = 0, page = 1;
  while (page <= 5 && total < 500) {
    let b;
    try { b = await fetchShows(page); } catch (e) { console.log('Page ' + page + ' fail'); break; }
    if (!b.length) break;
    console.log('Page ' + page + ': ' + b.length);
    b.forEach(s => { total++; if (s.id && s.name && s.image?.medium) store.push(s); });
    page++;
  }
  console.log('Eligible:', store.length);
  let st = 0, er = 0;
  for (let i = 0; i < store.length; i++) {
    try { await upsert(store[i]); st++; }
    catch (e) { er++; if (er <= 5) console.log('Fail ' + store[i].id); }
    if (i % 15 === 14) await new Promise(r => setTimeout(r, 300));
  }
  console.log('Stored:', st, 'Errors:', er);
  const { count: after } = await supabase.from('media_content').select('external_id', { count: 'exact', head: true });
  console.log('After:', after ?? 0);
  if (after > 0) {
    const { data: d } = await supabase.from('media_content').select('title, external_id').order('updated_at', { ascending: false }).limit(3);
    if (d) d.forEach(r => console.log(' - ' + r.title + ' (id=' + r.external_id + ')'));
  }
  console.log('Done');
})().catch(e => { console.error(e); process.exit(1); });
