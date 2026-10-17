-- File size captured from the indexer at resolve time.
-- Payload still stores size_human when these columns are missing.

ALTER TABLE public.media_sources
  ADD COLUMN IF NOT EXISTS size_human TEXT;

ALTER TABLE public.media_sources
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
