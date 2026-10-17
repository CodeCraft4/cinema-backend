-- Rewrite LAN torrent-stream URLs to the public Railway host.
-- Keeps path/query intact; only swaps the origin.

UPDATE public.media_sources
SET
  download_url = REPLACE(
    download_url,
    'http://192.168.100.68:4555',
    'https://cinebroadcast-production.up.railway.app'
  ),
  stream_url = REPLACE(
    stream_url,
    'http://192.168.100.68:4555',
    'https://cinebroadcast-production.up.railway.app'
  ),
  updated_at = NOW()
WHERE download_url ILIKE '%192.168.100.68:4555%'
   OR stream_url ILIKE '%192.168.100.68:4555%';

-- Any leftover localhost stream URLs from local runs.
UPDATE public.media_sources
SET
  download_url = REPLACE(
    download_url,
    'http://127.0.0.1:4555',
    'https://cinebroadcast-production.up.railway.app'
  ),
  stream_url = REPLACE(
    stream_url,
    'http://127.0.0.1:4555',
    'https://cinebroadcast-production.up.railway.app'
  ),
  updated_at = NOW()
WHERE download_url ILIKE '%127.0.0.1:4555%'
   OR stream_url ILIKE '%127.0.0.1:4555%';

UPDATE public.media_sources
SET
  download_url = REPLACE(
    download_url,
    'http://localhost:4555',
    'https://cinebroadcast-production.up.railway.app'
  ),
  stream_url = REPLACE(
    stream_url,
    'http://localhost:4555',
    'https://cinebroadcast-production.up.railway.app'
  ),
  updated_at = NOW()
WHERE download_url ILIKE '%localhost:4555%'
   OR stream_url ILIKE '%localhost:4555%';
