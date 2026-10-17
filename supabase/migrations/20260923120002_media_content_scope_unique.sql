-- ============================================================================
-- media_content — scope the UNIQUE key to (source, media_type, external_id)
-- ============================================================================
-- Why
--   TMDb uses ONE numeric id space for movies and TV shows (movie 550 and tv 550
--   both exist), and TVMaze ids are a third space. With a *global* UNIQUE on
--   external_id alone, caching a movie could silently overwrite a TV show that
--   happens to share the same number.
--
-- What this keeps
--   Strict "no duplicates" is still guaranteed — but per scope:
--       ONE row per (source, media_type, external_id)
--   which is now the `onConflict` target used by every upsert:
--       { onConflict: "source,media_type,external_id" }
--
-- Idempotent: safe to run repeatedly.
-- ============================================================================

-- 1. Drop the old single-column UNIQUE constraint/index on external_id.
ALTER TABLE public.media_content
  DROP CONSTRAINT IF EXISTS media_content_external_id_key;

-- Some setups created the inline UNIQUE with a different auto-generated name —
-- drop any remaining single-column unique index on external_id.
DO $$
DECLARE
  idx_name text;
BEGIN
  FOR idx_name IN
    SELECT i.relname
    FROM pg_class i
    JOIN pg_index ix ON ix.indexrelid = i.oid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'media_content'
      AND n.nspname = 'public'
      AND ix.indisunique
      AND ix.indnatts = 1
      AND (
        SELECT a.attname
        FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum = ix.indkey[0]
      ) = 'external_id'
  LOOP
    EXECUTE format('ALTER TABLE public.media_content DROP CONSTRAINT IF EXISTS %I', idx_name);
    EXECUTE format('DROP INDEX IF EXISTS public.%I', idx_name);
  END LOOP;
END $$;

-- 2. Add the scoped UNIQUE constraint (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'media_content_scope_external_key'
      AND conrelid = 'public.media_content'::regclass
  ) THEN
    ALTER TABLE public.media_content
      ADD CONSTRAINT media_content_scope_external_key
      UNIQUE (source, media_type, external_id);
  END IF;
END $$;

-- 3. Indexes that make the DB-first lookups (existence checks / title search) fast.
CREATE INDEX IF NOT EXISTS media_content_type_title_idx
  ON public.media_content (media_type, LOWER(title));

CREATE INDEX IF NOT EXISTS media_content_scope_idx
  ON public.media_content (source, media_type, external_id);

COMMENT ON CONSTRAINT media_content_scope_external_key ON public.media_content IS
  'One row per (source, media_type, external_id) — the upsert onConflict target (no duplicates).';
