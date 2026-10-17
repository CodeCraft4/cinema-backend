-- Store the resolved link on the request row so pending is not the only state.

ALTER TABLE public.download_requests
  ADD COLUMN IF NOT EXISTS download_url TEXT;
