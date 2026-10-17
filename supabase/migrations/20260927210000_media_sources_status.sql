-- Cache-first reads filter on status = 'ready'. Existing rows become ready.

ALTER TABLE public.media_sources
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready';

CREATE INDEX IF NOT EXISTS media_sources_ready_lookup_idx
  ON public.media_sources (media_id, language, quality)
  WHERE status = 'ready';
