-- First-class file size. Zero is not a size; unknown stays NULL.
-- Copy a real payload size onto the columns without replacing an existing byte count.

ALTER TABLE public.media_sources
  ADD COLUMN IF NOT EXISTS size_human TEXT;

ALTER TABLE public.media_sources
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

ALTER TABLE public.download_requests
  ADD COLUMN IF NOT EXISTS size_human TEXT;

ALTER TABLE public.download_requests
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

UPDATE public.media_sources
SET size_bytes = NULL
WHERE size_bytes IS NOT NULL AND size_bytes <= 0;

UPDATE public.media_sources
SET size_human = NULL
WHERE size_human IS NOT NULL
  AND size_human ~ '^[[:space:]]*0+(\.0+)?[[:space:]]*(B|KB|MB|GB|TB)?[[:space:]]*$';

UPDATE public.media_sources
SET
  size_bytes = (payload->>'size_bytes')::bigint,
  size_human = COALESCE(NULLIF(payload->>'size_human', ''), NULLIF(payload->>'size', ''))
WHERE source_type IN ('torrent', 'ddl')
  AND (size_bytes IS NULL OR size_bytes <= 0)
  AND COALESCE(payload->>'size_bytes', '') ~ '^[0-9]+$'
  AND (payload->>'size_bytes')::bigint > 0;
