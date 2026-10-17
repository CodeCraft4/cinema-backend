-- ============================================================================
-- media_page_cache — Supabase-backed cache for paginated page data
-- ============================================================================
-- Purpose
--   Stores the full JSON response payloads for paginated TMDb/TVMaze queries
--   (home popular, movies by year, discover by country, TV categories, search
--   results) so the Electron app can serve them from Supabase even on a fresh
--   install or when the local disk cache is cleared.
--
-- Duplicate protection
--   `cache_key` is UNIQUE, so upsert with `{ onConflict: 'cache_key' }` keeps
--   exactly one row per cache key.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.media_page_cache (
  id BIGSERIAL PRIMARY KEY,
  cache_key TEXT UNIQUE NOT NULL,     -- e.g. "popular-p1-l32", "search-matrix-p1-l16"
  provider VARCHAR(30) NOT NULL DEFAULT 'tmdb',  -- tmdb | tvmaze
  page_data JSONB NOT NULL,           -- full API response payload (items + pagination)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS media_page_cache_provider_key_idx
  ON public.media_page_cache (provider, cache_key);

CREATE OR REPLACE FUNCTION public.set_media_page_cache_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_page_cache_set_updated_at ON public.media_page_cache;
CREATE TRIGGER media_page_cache_set_updated_at
  BEFORE UPDATE ON public.media_page_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.set_media_page_cache_updated_at();

ALTER TABLE public.media_page_cache ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.media_page_cache IS
  'Paginated page data cache (TMDb/TVMaze). One row per cache_key (upsert target).';
COMMENT ON COLUMN public.media_page_cache.cache_key IS
  'Unique cache identifier, e.g. popular-p1-l32. UNIQUE — upsert onConflict target.';
COMMENT ON COLUMN public.media_page_cache.page_data IS
  'Full API response payload as JSONB (items + pagination metadata).';
