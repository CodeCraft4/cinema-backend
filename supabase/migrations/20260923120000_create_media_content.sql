-- ============================================================================
-- media_content — shared metadata cache for externally sourced media
-- ============================================================================
-- Purpose
--   Stores normalized TV Show (and later Movie) metadata fetched from external
--   providers (TVMaze today, TMDb later) so the same title is never fetched
--   twice and never stored twice.
--
-- Duplicate protection
--   `external_id` is UNIQUE, so the upsert with `{ onConflict: 'external_id' }`
--   used by server/services/mediaContentService.js can only ever keep ONE row
--   per external id.
--
-- NOTE: external_id is globally unique (as specified). Because the ids of
--   different providers can theoretically collide, `source` is always written
--   alongside the id so rows stay traceable/auditable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.media_content (
  id BIGSERIAL PRIMARY KEY,
  external_id INT UNIQUE NOT NULL,                 -- TVMaze / TMDb id
  source VARCHAR(50) NOT NULL DEFAULT 'tvmaze',    -- tvmaze | tmdb
  title VARCHAR(255) NOT NULL,
  media_type VARCHAR(20) NOT NULL DEFAULT 'tv',    -- tv | movie
  details JSONB NOT NULL,                          -- normalized provider payload
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fast lookups for the lazy-cache read path and for browsing cached rows.
CREATE INDEX IF NOT EXISTS media_content_source_type_idx
  ON public.media_content (source, media_type);

CREATE INDEX IF NOT EXISTS media_content_title_idx
  ON public.media_content (LOWER(title));

-- Keep updated_at accurate without relying on the application layer.
CREATE OR REPLACE FUNCTION public.set_media_content_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_content_set_updated_at ON public.media_content;
CREATE TRIGGER media_content_set_updated_at
  BEFORE UPDATE ON public.media_content
  FOR EACH ROW
  EXECUTE FUNCTION public.set_media_content_updated_at();

-- Lock the table down by default. The Express service connects with the
-- service-role key, which bypasses RLS, so no policy is required for it.
-- (Add read policies later if you ever expose this table to the browser/anon key.)
ALTER TABLE public.media_content ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.media_content IS
  'Cache of external media metadata (TVMaze/TMDb). One row per external_id (upsert target).';
COMMENT ON COLUMN public.media_content.external_id IS
  'Provider id (TVMaze/TMDb). UNIQUE — used as the upsert onConflict target.';
COMMENT ON COLUMN public.media_content.details IS
  'Normalized provider payload (JSONB) as returned by the service formatter.';