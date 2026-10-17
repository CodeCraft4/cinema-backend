-- Allow embed fallbacks and upsert one row per media + quality + language.

ALTER TABLE public.media_sources
  ADD COLUMN IF NOT EXISTS stream_url TEXT;

ALTER TABLE public.media_sources
  DROP CONSTRAINT IF EXISTS media_sources_source_type_check;

ALTER TABLE public.media_sources
  ADD CONSTRAINT media_sources_source_type_check
  CHECK (source_type IN ('torrent', 'ddl', 'embed_stream'));

CREATE UNIQUE INDEX IF NOT EXISTS media_sources_media_quality_language_uidx
  ON public.media_sources (media_id, quality, language);
