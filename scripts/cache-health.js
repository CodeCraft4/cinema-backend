const { createClient } = require('@supabase/supabase-js');
const env = require('../server/config/env');

const supabase = createClient(env.supabaseUrl, env.supabaseKey);

supabase
  .from('media_content')
  .select('count', { count: 'exact', head: true })
  .then((r) => console.log('Cached TV shows:', r.count ?? 0))
  .catch((e) => console.error('Error:', e.message));
