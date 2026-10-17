-- ============================================================================
-- Purge English-only and non-Hindi/Dual/Urdu torrent records from media_sources
-- ============================================================================

DELETE FROM public.media_sources 
WHERE (LOWER(language) = 'english' OR LOWER(language) = 'en' OR LOWER(language) = 'original')
  AND LOWER(language) NOT LIKE '%hindi%'
  AND LOWER(language) NOT LIKE '%urdu%'
  AND LOWER(language) NOT LIKE '%dual%'
  AND LOWER(language) NOT LIKE '%turkish%';
