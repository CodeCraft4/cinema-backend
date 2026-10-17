-- ============================================================================
-- media_torrents + media_episodes — persistent torrent & episode library
-- ============================================================================
-- LIST B purpose:
--   B1  media_torrents — har movie/series/episode ka torrent (magnet/link/
--       provider/quality/seeds) DB me store, taake live search fail hone par
--       "torrent not found" kabhi na aaye (renderer DB fallback).
--   B4  media_episodes  — har TV episode apni structured, queryable DB row.
--   B5  part            — multi-part releases (CD1/Part 2/1of2) ka part number.
--   B6  seeds/peers/last_refreshed_at — torrent health refreshable hota hai.
--
-- Duplicate protection
--   `dedupe_key` UNIQUE (source|media_type|external_id|season|episode|title)
--   → upsert { onConflict: 'dedupe_key' } keeps exactly ONE row per release
--     and refreshes seeds instead of inserting duplicates.
-- Idempotent: safe to run repeatedly (IF NOT EXISTS / DROP TRIGGER IF EXISTS).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.media_torrents (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(50) NOT NULL DEFAULT 'tmdb',   -- tmdb | tmdb-test (tests)
  media_type VARCHAR(20) NOT NULL,              -- movie | tv
  external_id INT NOT NULL,                     -- TMDb id of the movie / show
  season INT NOT NULL DEFAULT -1,               -- -1 = movie / whole show
  episode INT NOT NULL DEFAULT -1,              -- -1 = movie / whole season
  part INT NOT NULL DEFAULT -1,                 -- multi-part number (1..n), -1 = single
  title TEXT NOT NULL,                          -- torrent release title
  query_key TEXT NOT NULL DEFAULT '',           -- search query that found it
  magnet TEXT,                                  -- resolved magnet URI (lazy / best-effort)
  link TEXT,                                    -- provider .torrent / detail URL
  desc_url TEXT,                                -- provider detail page URL
  provider VARCHAR(50),
  quality VARCHAR(20),                          -- 2160p | 1080p | 720p | 480p | unknown
  size TEXT,
  seeds INT NOT NULL DEFAULT 0,
  peers INT NOT NULL DEFAULT 0,
  language_tags JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["hindi","english",…]
  match_score NUMERIC NOT NULL DEFAULT 0,
  dedupe_key TEXT UNIQUE NOT NULL,
  last_refreshed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Title lookup for the download DB-fallback (search-movies → media_torrents).
CREATE INDEX IF NOT EXISTS media_torrents_title_idx
  ON public.media_torrents (LOWER(title));
CREATE INDEX IF NOT EXISTS media_torrents_scope_idx
  ON public.media_torrents (source, media_type, external_id, season, episode);
CREATE INDEX IF NOT EXISTS media_torrents_refresh_idx
  ON public.media_torrents (last_refreshed_at);

CREATE OR REPLACE FUNCTION public.set_media_torrents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.last_refreshed_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_torrents_set_updated_at ON public.media_torrents;
CREATE TRIGGER media_torrents_set_updated_at
  BEFORE UPDATE ON public.media_torrents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_media_torrents_updated_at();

ALTER TABLE public.media_torrents ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.media_torrents IS
  'Persisted torrent search results per title/episode (B1). One row per dedupe_key — upsert refreshes seeds (B6).';
COMMENT ON COLUMN public.media_torrents.dedupe_key IS
  'source|media_type|external_id|season|episode|normalized_title — UNIQUE upsert target (no duplicates).';
COMMENT ON COLUMN public.media_torrents.part IS
  'Multi-part release part number parsed from the title (B5), -1 when single.';

-- ============================================================================
-- media_episodes (B4) — first-class rows for every TV episode
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.media_episodes (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(50) NOT NULL DEFAULT 'tmdb',
  show_id INT NOT NULL,                          -- TMDb tv id
  season INT NOT NULL,
  episode INT NOT NULL,
  title VARCHAR(500),
  overview TEXT,
  air_date VARCHAR(30),
  details JSONB,                                 -- spare payload
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT media_episodes_scope_key UNIQUE (source, show_id, season, episode)
);

CREATE INDEX IF NOT EXISTS media_episodes_show_season_idx
  ON public.media_episodes (show_id, season);

CREATE OR REPLACE FUNCTION public.set_media_episodes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_episodes_set_updated_at ON public.media_episodes;
CREATE TRIGGER media_episodes_set_updated_at
  BEFORE UPDATE ON public.media_episodes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_media_episodes_updated_at();

ALTER TABLE public.media_episodes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.media_episodes IS
  'Structured TV episode rows (B4) — one row per (source, show_id, season, episode), queryable alongside their torrents.';
