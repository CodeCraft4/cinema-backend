require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_SECRET_KEY);
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';

async function searchTmdb(title, mediaType) {
  try {
    const type = mediaType === 'movie' ? 'movie' : 'tv';
    let cleanTitle = title;
    
    // Attempt to remove common things like season/episode indicators if they leaked into title
    cleanTitle = cleanTitle.replace(/S\d+E\d+/i, '');
    cleanTitle = cleanTitle.replace(/Season \d+/i, '');
    cleanTitle = cleanTitle.replace(/\(\d{4}\)/, ''); // year
    cleanTitle = cleanTitle.trim();
    
    const url = `${TMDB_BASE_URL}/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}&page=1`;
    const response = await axios.get(url);
    if (response.data.results && response.data.results.length > 0) {
      // Prefer exact match with poster
      const exactMatch = response.data.results.find(
        (r) => (r.title || r.name).toLowerCase() === cleanTitle.toLowerCase() && r.poster_path
      );
      if (exactMatch) return exactMatch;
      
      const anyWithPoster = response.data.results.find((r) => r.poster_path);
      return anyWithPoster || response.data.results[0];
    }
  } catch (err) {
    console.error(`TMDB search error for ${title}:`, err.message);
  }
  return null;
}

async function run() {
  console.log('Fetching media content to check for missing posters...');
  const { data, error } = await supabase
    .from('media_content')
    .select('id, title, media_type, external_id, details');
  
  if (error) {
    console.error('Error fetching from DB:', error);
    return;
  }
  
  const missing = data.filter(item => {
    return !item.details || !item.details.poster || item.details.poster.trim() === '';
  });
  
  if (missing.length === 0) {
    console.log('All media content have posters! Nothing to fix.');
    return;
  }
  
  console.log(`Found ${missing.length} titles missing posters. Fixing them...`);
  
  for (const item of missing) {
    console.log(`\nProcessing: ${item.title}`);
    let tmdbData = null;
    
    // First try search
    console.log(`  - Searching TMDB by title: ${item.title}`);
    tmdbData = await searchTmdb(item.title, item.media_type || 'movie');
    
    // Fallback to series if movie search fails (just in case media_type is wrong)
    if (!tmdbData && item.media_type !== 'tv') {
       console.log(`  - Fallback searching as tv series...`);
       tmdbData = await searchTmdb(item.title, 'tv');
    }
    
    if (tmdbData && tmdbData.poster_path) {
      const fullPosterPath = IMAGE_BASE_URL + tmdbData.poster_path;
      console.log(`  - Found poster: ${fullPosterPath}`);
      
      const updatedDetails = {
        ...item.details,
        poster: fullPosterPath,
        overview: item.details?.overview || tmdbData.overview,
        externalId: item.details?.externalId || tmdbData.id,
      };
      
      const updateData = {
        details: updatedDetails,
        updated_at: new Date().toISOString()
      };
      
      if (!item.external_id && tmdbData.id) {
        updateData.external_id = tmdbData.id;
      }
      
      const { error: updateError } = await supabase
        .from('media_content')
        .update(updateData)
        .eq('id', item.id);
        
      if (updateError) {
        console.error(`  - Failed to update DB for ${item.title}:`, updateError.message);
      } else {
        console.log(`  - Successfully updated ${item.title} in database!`);
      }
    } else {
      console.log(`  - Could not find a poster on TMDB for ${item.title}.`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  console.log('\nFinished fixing missing posters.');
}

run();
