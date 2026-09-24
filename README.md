# SMS Campaign Dashboard

Private, single-user analytics for the cold-SMS outreach running in 4 GoHighLevel sub-accounts. Next.js 16 on Vercel, Postgres on Neon, read-only GHL API v2.

**Status: Phase 1 (foundation).** Login, database schema, GHL client with rate limiting, incremental sync, backfill, and the Sync status page. See `DECISIONS.md` for design choices and where the GHL API differs from its docs.

---

## 1. Local setup

Requirements: Node 22+, a Postgres database (local, or a Neon branch).

```bash
npm install
cp .env.example .env.local      # fill in the values (see §3)
cp .env.local .env              # CLI scripts (migrate, sync) read .env
npm run db:migrate              # applies migrations and seeds the 4 locations
npm run dev                     # http://localhost:3000
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | Unit + integration tests (Vitest; integration tests use in-memory PGlite and fixture JSON, no GHL calls) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run db:generate` | Generate a new migration after editing `src/lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations + seed locations |
| `npm run sync` | Incremental sync of all locations from the CLI |
| `npm run sync -- --loc A` | Only sub-account A |
| `npm run sync -- --backfill 2026-09-01 --budget 900` | Backfill from a date with a 15-minute budget (no Vercel limit locally) |

## 2. GHL Private Integration Tokens (one per sub-account)

This app only reads from GHL. For **each** of the 4 sub-accounts:

1. Switch into the sub-account → **Settings → Private Integrations**.
2. **Create new Integration**. Name it e.g. `SMS Dashboard (read-only)`.
3. Select exactly these scopes:

   | Scope | Used for |
   |---|---|
   | `conversations.readonly` | Conversation lookup for targeted re-sync |
   | `conversations/message.readonly` | Message export and conversation messages |
   | `contacts.readonly` | Contact search and contact by id |
   | `opportunities.readonly` | Pipelines, stages, opportunity search |
   | `locations.readonly` | Location details (timezone) |
   | `locations/customFields.readonly` | Only needed if niche comes from a custom field |

4. Copy the token into `GHL_TOKEN_A` (sub-account A), `GHL_TOKEN_B`, `GHL_TOKEN_C`, `GHL_TOKEN_D`.

A missing token doesn't break anything: that location's runs show as **skipped** on `/sync`.

| Key | Sub-account | Location ID |
|---|---|---|
| A | A: Website + Normal SMS | `U8cEIiAwrnS7QEzMyRNj` |
| B | B: Website + Loom SMS | `uciXzsgWKcwnEOhYxVe3` |
| C | C: Lead + Normal SMS | `adOazVo5iRrj2qDc2z1N` |
| D | D: Lead + Loom SMS | `cR5FxMwT2HvGbqylJBfs` |

(Seeded from `src/lib/config/locations.ts` into the `locations` table.)

## 3. Environment variables

All are server-only; none are exposed to the browser.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string (host contains `-pooler`), `?sslmode=require` |
| `GHL_TOKEN_A` … `GHL_TOKEN_D` | per location | Private Integration Tokens (§2) |
| `DASHBOARD_PASSWORD` | yes | Login password, ≥ 8 chars |
| `SESSION_SECRET` | yes | ≥ 32 chars; signs the session cookie. `openssl rand -base64 48` |
| `CRON_SECRET` | yes | ≥ 16 chars; the scheduler sends `Authorization: Bearer <CRON_SECRET>` |
| `INGEST_SECRET` | Phase 4 | ≥ 16 chars; protects the GHL webhook endpoint |

Changing `SESSION_SECRET` logs you out everywhere.

## 4. Neon (Postgres)

1. In Vercel: **Project → Storage → Create Database → Neon** (Marketplace integration), and connect it to the project. This sets `DATABASE_URL` (pooled) on the project.
2. For local dev, copy the pooled URL into `.env.local` (or create a Neon branch for dev).
3. Run migrations against it: `DATABASE_URL=... npm run db:migrate`. Re-run after pulling new migrations. It's safe to run repeatedly.

## 5. Deploy on Vercel

1. Import the GitHub repo in Vercel (framework: Next.js, defaults are fine).
2. Add the env vars from §3 (Production, and Preview if you use it).
3. Deploy, then run `npm run db:migrate` once against the production `DATABASE_URL`.
4. Open the site, log in, go to **Sync status**, click **Sync all now**.

The first sync of each location reads the last 60 days of SMS (`initial_sync_days` setting). For older history use **Backfill** on `/sync`. Big ranges continue automatically on the following scheduled runs.

## 6. Scheduling the sync every 5 minutes

The Hobby plan only allows Vercel Cron jobs to run **once per day** (a job may fire any time within its scheduled hour), and functions time out at **300 s**. So:

- `vercel.json` runs `/api/cron/sync` once a day as a fallback. Vercel sends the `CRON_SECRET` header automatically.
- **The real 5-minute schedule is `.github/workflows/sync-cron.yml`.** In the GitHub repo go to **Settings → Secrets and variables → Actions** and add:
  - `SYNC_URL` = `https://<your-app>.vercel.app` (no trailing slash)
  - `CRON_SECRET` = same value as in Vercel

  Check **Actions → sync-cron** for runs; you can also trigger it by hand ("Run workflow").

GitHub can delay scheduled workflows by several minutes at busy times. If that matters, use **cron-job.org** instead (free):

- URL: `https://<your-app>.vercel.app/api/cron/sync`, method GET, every 5 minutes
- Header: `Authorization: Bearer <CRON_SECRET>`
- Request timeout: 300 s

Each run processes the locations one after another within a 240 s budget. Only one sync per location can run at a time (a lease lock), so overlapping triggers are harmless. They show as *skipped*.

With a Pro plan you can change `vercel.json` to `*/5 * * * *` and drop the GitHub workflow.

## 7. GHL webhooks (Phase 4)

Real-time updates via GHL workflow webhooks arrive in Phase 4, with step-by-step setup in `docs/ghl-webhook-setup.md`. Polling stays the source of truth; the dashboard is correct without webhooks.

## Project layout

```
src/
  proxy.ts                       auth gate (Next 16's renamed middleware)
  app/
    login/                       password login (server action)
    (dashboard)/                 authenticated pages (sidebar + header)
      sync/                      Sync status page
    api/cron/sync/               scheduled sync (CRON_SECRET)
    api/sync/                    manual sync / backfill (session)
  components/ui/                 shadcn/ui components
  components/layout/             nav, header widgets
  lib/
    env.ts                       server-only env access
    auth/session.ts              signed httpOnly session cookie
    config/                      locations, canonical stages, settings defaults
    db/                          Drizzle schema, client, seed, settings
    ghl/                         GHL client, rate limiter, zod schemas, endpoints
    sync/                        per-location sync, lock, orchestrator
    queries/                     read models for pages
drizzle/                         SQL migrations
scripts/                         migrate + sync CLIs
tests/                           unit + integration (fixtures in tests/fixtures/ghl)
```
