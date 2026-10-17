-- Migration: Scope Single Episode Sources to -s01e01 format
-- Prevents series episodes from displaying identical duplicate sizes and playing Episode 1 for all episodes.

-- Description:
-- 1. Scoped media_id convention: {tmdbId}-s{season}e{episode} (e.g. 246473-s02e01)
-- 2. Media titles format: {Series Title} - S{season}E{episode}
-- 3. Realistic per-episode file size rather than copying multi-episode pack sizes.
