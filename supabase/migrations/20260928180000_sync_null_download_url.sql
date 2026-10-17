-- Copy a stored magnet into download_url when that column was left null.
-- download_requests may not have magnet_link yet; add it before the sync.

ALTER TABLE public.download_requests
  ADD COLUMN IF NOT EXISTS magnet_link TEXT;

UPDATE public.media_sources
SET download_url = magnet_link
WHERE download_url IS NULL AND magnet_link IS NOT NULL;

UPDATE public.download_requests
SET download_url = magnet_link
WHERE download_url IS NULL AND magnet_link IS NOT NULL;
