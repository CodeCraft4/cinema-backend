-- ============================================================================
-- media_sources — verified torrent / DDL links for a title + language + quality
-- download_requests — manual queue when no healthy source can be resolved
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.media_sources (
  id BIGSERIAL PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  media_id TEXT,
  media_title TEXT NOT NULL,
  year TEXT,
  language TEXT NOT NULL DEFAULT 'all',
  quality TEXT NOT NULL DEFAULT 'all',
  source_type TEXT NOT NULL CHECK (source_type IN ('torrent', 'ddl')),
  download_url TEXT NOT NULL,
  magnet_link TEXT,
  seeders INT,
  is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS media_sources_media_id_idx
  ON public.media_sources (media_id);

CREATE INDEX IF NOT EXISTS media_sources_title_idx
  ON public.media_sources (LOWER(media_title), language, quality);

CREATE TABLE IF NOT EXISTS public.download_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  media_id TEXT,
  media_title TEXT NOT NULL,
  year TEXT,
  language TEXT,
  quality TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS download_requests_status_idx
  ON public.download_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS download_requests_user_idx
  ON public.download_requests (user_id);

CREATE OR REPLACE FUNCTION public.set_media_sources_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_sources_set_updated_at ON public.media_sources;
CREATE TRIGGER media_sources_set_updated_at
  BEFORE UPDATE ON public.media_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.set_media_sources_updated_at();

CREATE OR REPLACE FUNCTION public.set_download_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS download_requests_set_updated_at ON public.download_requests;
CREATE TRIGGER download_requests_set_updated_at
  BEFORE UPDATE ON public.download_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_download_requests_updated_at();

ALTER TABLE public.media_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.download_requests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.media_sources IS
  'Cached, verified torrent magnets or DDL URLs keyed by title/language/quality.';
COMMENT ON TABLE public.download_requests IS
  'Queued download requests when torrent and DDL resolution both fail.';
