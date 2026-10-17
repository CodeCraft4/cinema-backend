-- Copy size_bytes / size_human from media_sources onto download_requests
-- that already have a magnet or download URL but no size.

UPDATE public.download_requests AS dr
SET
  size_bytes = src.size_bytes,
  size_human = COALESCE(NULLIF(src.size_human, ''), src.size_human),
  updated_at = NOW()
FROM public.media_sources AS src
WHERE (dr.size_bytes IS NULL OR dr.size_bytes <= 0)
  AND src.size_bytes IS NOT NULL
  AND src.size_bytes > 0
  AND (
    (dr.magnet_link IS NOT NULL AND dr.magnet_link <> '' AND (
      dr.magnet_link = src.magnet_link OR dr.magnet_link = src.download_url
    ))
    OR (dr.download_url IS NOT NULL AND dr.download_url <> '' AND (
      dr.download_url = src.magnet_link OR dr.download_url = src.download_url
    ))
  );

-- Fallback: same media_id when URL match did not fill the size.
UPDATE public.download_requests AS dr
SET
  size_bytes = src.size_bytes,
  size_human = COALESCE(NULLIF(src.size_human, ''), src.size_human),
  updated_at = NOW()
FROM (
  SELECT DISTINCT ON (media_id)
    media_id,
    size_bytes,
    size_human
  FROM public.media_sources
  WHERE size_bytes IS NOT NULL AND size_bytes > 0
  ORDER BY media_id, updated_at DESC NULLS LAST
) AS src
WHERE (dr.size_bytes IS NULL OR dr.size_bytes <= 0)
  AND dr.media_id IS NOT NULL
  AND dr.media_id = src.media_id;

-- Keep future inserts filled when the app stores a magnet without size.
CREATE OR REPLACE FUNCTION public.fill_download_request_size()
RETURNS TRIGGER AS $$
DECLARE
  found_bytes BIGINT;
  found_human TEXT;
BEGIN
  IF NEW.size_bytes IS NOT NULL AND NEW.size_bytes > 0 THEN
    IF NEW.size_human IS NULL OR NEW.size_human = '' THEN
      NEW.size_human := CASE
        WHEN NEW.size_bytes >= 1073741824 THEN ROUND(NEW.size_bytes / 1073741824.0, 1)::TEXT || ' GB'
        WHEN NEW.size_bytes >= 1048576 THEN ROUND(NEW.size_bytes / 1048576.0, 1)::TEXT || ' MB'
        ELSE NEW.size_bytes::TEXT || ' B'
      END;
    END IF;
    RETURN NEW;
  END IF;

  SELECT src.size_bytes, src.size_human
  INTO found_bytes, found_human
  FROM public.media_sources AS src
  WHERE src.size_bytes IS NOT NULL
    AND src.size_bytes > 0
    AND (
      (NEW.magnet_link IS NOT NULL AND NEW.magnet_link <> '' AND (
        src.magnet_link = NEW.magnet_link OR src.download_url = NEW.magnet_link
      ))
      OR (NEW.download_url IS NOT NULL AND NEW.download_url <> '' AND (
        src.magnet_link = NEW.download_url OR src.download_url = NEW.download_url
      ))
      OR (NEW.media_id IS NOT NULL AND src.media_id = NEW.media_id)
    )
  ORDER BY
    CASE
      WHEN NEW.magnet_link IS NOT NULL AND (src.magnet_link = NEW.magnet_link OR src.download_url = NEW.magnet_link) THEN 0
      WHEN NEW.download_url IS NOT NULL AND (src.magnet_link = NEW.download_url OR src.download_url = NEW.download_url) THEN 1
      ELSE 2
    END,
    src.updated_at DESC NULLS LAST
  LIMIT 1;

  IF found_bytes IS NOT NULL AND found_bytes > 0 THEN
    NEW.size_bytes := found_bytes;
    NEW.size_human := COALESCE(NULLIF(found_human, ''), NEW.size_human);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS download_requests_fill_size ON public.download_requests;
CREATE TRIGGER download_requests_fill_size
  BEFORE INSERT OR UPDATE OF download_url, magnet_link, media_id, size_bytes
  ON public.download_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.fill_download_request_size();
