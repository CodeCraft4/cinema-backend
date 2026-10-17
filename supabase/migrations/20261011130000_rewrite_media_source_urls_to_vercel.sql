-- Rewrite Railway torrent-stream URLs to the public Vercel host.
-- Keeps path/query intact; only swaps the origin.

UPDATE public.media_sources
SET
  download_url = REPLACE(
    download_url,
    'https://cinebroadcast-production.up.railway.app',
    'https://cinemaapi.vercel.app'
  ),
  stream_url = REPLACE(
    stream_url,
    'https://cinebroadcast-production.up.railway.app',
    'https://cinemaapi.vercel.app'
  ),
  updated_at = NOW()
WHERE download_url ILIKE '%cinebroadcast-production.up.railway.app%'
   OR stream_url ILIKE '%cinebroadcast-production.up.railway.app%';
