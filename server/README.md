# Cinebroad media service (Supabase + TVMaze)

Standalone Express service that caches TV Show metadata in Supabase so the same
title is **never fetched twice and never stored twice**.

```
server/
├── index.js                          # bootstrap (npm run server)
├── app.js                            # express app + middleware wiring
├── config/env.js                     # .env resolution (names + JWT-derived URL)
├── controllers/tvShowsController.js  # HTTP layer
├── routes/tvShowsRoutes.js           # /api/tv-shows/*
├── services/supabaseClient.js        # client singleton + health probe + error mapping
├── services/tvmazeService.js         # axios client + payload normalizer
├── services/mediaContentService.js   # lazy caching + upsert (onConflict: source, media_type, external_id)
├── middleware/                       # request logger, 404 + error handler
└── utils/                            # HttpError, asyncHandler, response envelope
```

## Run

```bash
npm run server          # http://localhost:4555
npm run server:dev      # same, with --watch
```

## Endpoints

| Method | Path | Behaviour |
| ------ | ---- | --------- |
| `GET` | `/health` | Liveness of the service itself (no DB access) |
| `GET` | `/api/tv-shows/health` | Config snapshot + Supabase reachability + `media_content` readiness |
| `GET` | `/api/tv-shows/:id` | **Lazy cache**: Supabase → (miss/stale) TVMaze → upsert |
| `GET` | `/api/tv-shows?title=Breaking Bad` | Cache lookup by title, TVMaze search on miss |
| `GET` | `/api/tv-shows/search?q=breaking` | TVMaze search proxy (not persisted) |
| `GET` | `/api/tv-shows/cache?page=1&limit=20` | Everything already stored — 0 upstream calls |
| `POST` | `/api/tv-shows/prefetch` | `{ "id": 169 }` — warm the cache ahead of time |

Add `?refresh=true` to force an upstream re-fetch (it still updates in place).

## Railway healthcheck and URL

Use `GET /health` as the Railway healthcheck path. It is a lightweight liveness
route and should return HTTP 200 when the service is running.

`BACKEND_INTERNAL_URL` is only for service-to-service communication inside
Railway:

```text
https://cinebroadcast-backend.railway.internal
```

Do not open that URL in a browser or configure a desktop client with it. Railway
also provides a public domain for browser/client use; configure that separately
in the client when needed.

Response envelope:

```json
{
  "ok": true,
  "cached": true,          // served from Supabase
  "source": "supabase",    // "tvmaze" when freshly fetched
  "upstreamCalled": false, // false ⇒ TVMaze was not contacted
  "stale": false,
  "stored": false,
  "data": { "id": 1, "external_id": 1, "title": "Under the Dome", "details": { … } }
}
```

## Database

Apply the migrations in `supabase/migrations/` (all three, oldest first) —
see **[docs/SUPABASE_SETUP.md](../docs/SUPABASE_SETUP.md)** for three ways to do it
(Dashboard paste, automated via token, or the Supabase CLI).

```bash
npm run db:migrate -- --dry-run   # show the migrations that would be applied
npm run db:migrate                # apply via Management API (needs SUPABASE_ACCESS_TOKEN)
```

`media_content` holds one row per cached title, keyed by
`UNIQUE (source, media_type, external_id)` — the `onConflict` target that makes the
upsert idempotent. The composite key (not `external_id` alone) matters because TMDb
reuses one numeric id space for movies and series, so `movie:550` and `tv:550` are
different rows. `details JSONB`, an `updated_at` trigger and RLS are included (the
service-role key bypasses RLS).

The Electron app writes into the same table through `src/mediaItemStore.js`
(scopes `tmdb`/`movie` and `tmdb`/`tv`) and caches whole page payloads in
`media_page_cache` (migration `20260923120001`), so the app and this service share
one deduplicated store.

## Environment

`server/config/env.js` resolves values from the project `.env` and falls back
through the names that actually exist there:

| Purpose | Lookup order |
| ------- | ------------ |
| Project URL | `SUPABASE_URL` → `NEXT_PUBLIC_SUPABASE_URL` → `VITE_SUPABASE_URL` → `SUPABASE_URL_KEY` *(only when it is a real URL)* → derived as `https://<ref>.supabase.co` from a Supabase JWT's `ref` claim |
| Server key | `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_ROLE_SECRET_KEY` → `SUPABASE_SECRET_KEY` |
| TVMaze | `TV_MAZ_API_URL` (default `https://api.tvmaze.com`), optional `TVMAZE_API_KEY` |
| Tuning | `SERVER_PORT`, `MEDIA_CACHE_TTL_MS` (default 7 days), `TVMAZE_TIMEOUT_MS` |

No secret is ever hardcoded, and only masked values are logged.

## Verification

```bash
npm run test:media-cache    # logic checks — TVMaze live, Supabase faked (no credentials needed)
npm run test:item-store     # live DB — items stored once, repeats skipped, no duplicates
npm run verify:supabase     # .env + migrations + live Supabase round trip + real HTTP requests
```

`verify:supabase` performs a real round trip (MISS → upsert, HIT → Supabase only)
and asserts that repeated upserts leave exactly **one** row per
`(source, media_type, external_id)`.
It exits non-zero while the migration is still pending and prints the exact file
to apply.

`test:item-store` runs the same duplicate-safety checks the app uses, in its own
scope (`source = "tmdb-test"`), and cleans up after itself.

## Notes

- A missing/unmigrated table degrades gracefully: `503 CACHE_NOT_READY` with the
  migration path in `error.details` — never a 500 stack trace.
- `HEAD`-style probes are intentionally avoided: PostgREST answers `204` for a
  missing table, which would report a false healthy state.
- Stale-but-unreachable upstream serves the previous cached copy rather than failing.
- Errors are mapped to meaningful codes: `CACHE_NOT_READY`, `CACHE_SCHEMA_INVALID`,
  `DUPLICATE_ROW` (409), `SUPABASE_UNREACHABLE` (502), `NOT_FOUND` (404), `INVALID_ID` (400).