# Supabase setup — push the migration & connect the DB

Project: `fhbeomadvgmsleemmpww` → `https://fhbeomadvgmsleemmpww.supabase.co`

Migrations to apply (all four, in file-name order — `npm run db:migrate` does this):

| File | Creates |
| ---- | ------- |
| `20260923120000_create_media_content.sql` | `media_content` — one row per cached movie / series |
| `20260923120001_create_media_page_cache.sql` | `media_page_cache` — one row per cached page payload (Home, Movies, TV Shows, Search) |
| `20260923120002_media_content_scope_unique.sql` | `UNIQUE (source, media_type, external_id)` — the upsert target that makes duplicate rows impossible, while still letting a movie and a series share the same numeric provider id |
| `20260923160000_create_media_torrents_episodes.sql` | `media_torrents` (persisted magnet/link/quality/seeds per title or episode — torrent-library fallback, health refresh, multi-part) + `media_episodes` (first-class TV episode rows) |

Together they make the whole app cache DB-first: identical pages are served from
`media_page_cache`, and every single fetched movie/series is stored once in
`media_content`.

> Choose **one** of the three options below. They all produce the same result.
> Afterwards run the verification in the last section.

---

## Option A — Dashboard SQL Editor (fastest, nothing to install)

1. Open <https://supabase.com/dashboard/project/fhbeomadvgmsleemmpww/sql/new>
2. Open the migration files in `supabase/migrations/` (or print them with
   `npm run db:migrate -- --dry-run`).
3. Copy each file → paste into the editor → **Run** (`Ctrl+Enter`), oldest first.
4. Expected result: `Success. No rows returned`.

The SQL is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`DROP TRIGGER IF EXISTS`, `CREATE OR REPLACE FUNCTION`), so running it twice is safe.

---

## Option B — Automated via a Personal Access Token (recommended)

This project can apply migrations for you over the Management API — no CLI and no
database password needed.

1. Create a token: <https://supabase.com/dashboard/account/tokens>
   (looks like `sbp_xxxxxxxxxxxxxxxxxxxxxxxx`).
2. Add it to the **bottom of `.env`**:

   ```ini
   SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxxxxxxxxxxxxxxxxxx
   ```

3. Diff-check what will be sent, then apply:

   ```powershell
   npm run db:migrate -- --dry-run     # prints the file it would apply
   npm run db:migrate                  # applies + verifies the schema
   ```

4. Expected output:

   ```
   ✓ media_content is ready (media_content_scope_external_key)
     visible via PostgREST, 1 row(s) so far.
   ```

The script (`scripts/apply-migration.js`) uses
`POST https://api.supabase.com/v1/projects/{ref}/database/query` with
`Authorization: Bearer <token>` and `{ "query": "<sql>" }`, then verifies the table
and the `(source, media_type, external_id)` UNIQUE constraint before reporting success.

`.env` is gitignored, so the token never gets committed.

---

## Option C — Supabase CLI

```powershell
npx supabase init                                  # generates supabase/config.toml
npx supabase login                                 # paste a PAT when prompted
npx supabase link --project-ref fhbeomadvgmsleemmpww   # asks for your DB password
npx supabase db push                               # applies supabase/migrations/*.sql
```

`supabase link` needs your **database password** (Dashboard → Project Settings →
Database → *Reset database password* if you don't have it), which is why Option B
exists as a password-free alternative.

---

## Connect & verify

### 1. Confirm credentials resolve

```powershell
npm run verify:supabase
```

This reports which `.env` names were used, whether the table is ready, and runs a
live round trip (cache MISS → TVMaze + upsert, then cache HIT with no API call).
Expected ending after the migration is applied: **19/19 checks passed**.

### 2. Start the API

```powershell
npm run server        # http://localhost:4555
```

Then exercise it:

```powershell
curl http://localhost:4555/api/tv-shows/health     # health + database readiness
curl http://localhost:4555/api/tv-shows/169        # 1st call: TVMaze -> Supabase upsert
curl http://localhost:4555/api/tv-shows/169        # 2nd call: Supabase only, upstreamCalled=false
curl "http://localhost:4555/api/tv-shows/cache?limit=10"   # 0 upstream calls
```

### 3. Prove duplicate protection holds

```powershell
npm run test:media-cache    # TVMaze live + in-memory Supabase — upsert logic checks
npm run test:item-store     # live DB — new items stored once, repeats skipped
```

`test:item-store` writes into its own scope (`source = "tmdb-test"`), so your real
cache is untouched, and asserts that:

- a first fetch stores every unique item,
- the same fetch repeated stores **0** new rows (already in DB → skipped),
- an existing row is never overwritten,
- one batch cannot insert the same id twice,
- a movie and a series may share the same numeric id,
- the whole table contains **no** duplicate `(source, media_type, external_id)` group.

All test rows are deleted again at the end.

### 4. See the rows landed

Dashboard → Table Editor → `media_content`, or:

```sql
select id, external_id, source, title, media_type, created_at, updated_at
from public.media_content
order by updated_at desc;
```

---

## How the app keeps the DB deduplicated

Every fetch the user triggers (Home, Movies by year, TV Show shelves, Search,
including every infinite-scroll page) goes through one shared write path,
`src/mediaItemStore.js`:

1. **Page payload cache** — the finished page object is written to
   `media_page_cache` (`cache_key` UNIQUE, upsert). The next identical request is
   answered straight from the DB with **zero** API calls.
2. **Item store** — every item of that page is normalised to one row per
   `(source, media_type, external_id)` and written to `media_content`. Before
   writing, the store selects the ids that already exist and sends **only the
   missing ones** with `ignoreDuplicates: true` (`ON CONFLICT DO NOTHING`), so:

   - new data is always stored,
   - an id that is already in the DB is never written (and never overwritten),
   - a duplicate cannot appear even if two app instances fetch the same page.

3. **DB-first reads** — a request whose page is already cached is served from
   `media_page_cache`; a search that cannot reach TMDb falls back to movie/series
   rows already stored in `media_content` (`title ILIKE`), so the user still gets
   results from the DB.

Row scopes in use: `tmdb`/`movie`, `tmdb`/`tv` (app) and `tvmaze`/`tv`
(Express media service) — the composite UNIQUE keeps them apart instead of
letting a numeric id collision overwrite a row.

---

## How the connection is configured (no hardcoding)

`server/config/env.js` resolves everything at runtime and only ever logs masked values:

| Purpose | Lookup order in `.env` |
| ------- | ---------------------- |
| Project URL | `SUPABASE_URL` → `NEXT_PUBLIC_SUPABASE_URL` → `VITE_SUPABASE_URL` → `SUPABASE_URL_KEY` *(only if it is a real URL)* → **derived** as `https://<ref>.supabase.co` from the `ref` claim of your service-role JWT |
| Server key | `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_ROLE_SECRET_KEY` → `SUPABASE_SECRET_KEY` |
| Project ref | `SUPABASE_PROJECT_REF` → parsed from the project URL host |
| Migration token | `SUPABASE_ACCESS_TOKEN` (only needed for Option B) |
| TVMaze | `TV_MAZ_API_URL` (default `https://api.tvmaze.com`), optional `TVMAZE_API_KEY` |

Your current `.env` only has `SUPABASE_URL_KEY` (a *key*, not a URL),
`SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_SECRET_KEY` and
`SUPABASE_SERVICE_ROLE_ANON_KEY` — all handled automatically, which is why no `.env`
edit was needed to connect. Adding `SUPABASE_ACCESS_TOKEN` is optional and only
unlocks Option B.

**Do not** expect `SUPABASE_URL_KEY` to work as a URL: the code detects that it is not
an `http(s)` URL, ignores it on purpose, and derives the correct URL from the JWT instead.

---

## Direct Postgres access (optional)

Dashboard → Project Settings → Database → *Connection string* gives you
`postgresql://postgres:<password>@db.fhbeomadvgmsleemmpww.supabase.co:5432/postgres`.
Not required for Option A or B.

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `503 CACHE_NOT_READY` / `PGRST205` | Migration not applied yet — do Option A, B or C. |
| `401 Unauthorized` from `db:migrate` | Token wrong/expired; create a new one at <https://supabase.com/dashboard/account/tokens>. |
| `404 Not Found` from `db:migrate` | Wrong project ref; set `SUPABASE_PROJECT_REF` in `.env`. |
| Table created but still `PGRST205` | PostgREST schema-cache lag — wait ~10s and re-run, or Settings → API → *Reload schema*. |
| `Upsert … needs the UNIQUE constraint` | Migration `20260923120002_media_content_scope_unique.sql` not applied yet; run `npm run db:migrate`. |
| `password authentication failed` (CLI) | Reset the DB password, or use Option B. |