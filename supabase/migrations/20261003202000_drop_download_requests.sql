-- Drop download_requests table and its triggers/functions since the app now streams
-- and downloads directly from media_sources without intermediate database queue overhead.

DROP TABLE IF EXISTS public.download_requests CASCADE;
DROP FUNCTION IF EXISTS public.set_download_requests_updated_at() CASCADE;
