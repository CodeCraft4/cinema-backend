-- Drop embed fallbacks and any source that is not a magnet download.
-- Titles left without a magnet torrent are picked up by the catalog enricher.

DELETE FROM public.media_sources
WHERE source_type = 'embed_stream'
   OR download_url IS NULL
   OR download_url NOT LIKE 'magnet:%';
