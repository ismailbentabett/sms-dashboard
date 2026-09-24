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
npm run db:migrate              # applies migrations
npm run dev                     # http://localhost:3000
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | Unit + integration tests (Vitest; integration tests use in-memory PGlite and fixture JSON, no GHL calls) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run db:generate` | Generate a new migration after editing `src/lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run sync` | Incremental sync of all locations from the CLI |
| `npm run sync -- --loc A` | Only sub-account A |
| `npm run sync -- --backfill 2026-09-01 --budget 900` | Backfill from a date with a 15-minute budget (no Vercel limit locally) |

## 2. Connect GHL (agency-level, one time)

One private Marketplace app, installed once at agency level, covers every sub-account. The dashboard lists the sub-accounts the app is installed on and gets each one's access token itself. **New sub-accounts show up by themselves** and are tracked if they have the `SMS Outreach - Remodelers - FB Ads` pipeline. You can turn tracking on or off per sub-account on `/sync`.

(Agency Private Integration Tokens can't be used: GHL only serves conversations, contacts and opportunities to sub-account tokens, and agency PITs can't create those.)

### 2a. Create the app (≈10 min)

1. Go to **https://marketplace.gohighlevel.com**, sign in with your agency login, and create a developer account if asked.
2. **My Apps → Create App**:
   - **App type: Private**. Only your agency can see or install it.
   - **Target user / distribution: Agency** (installable by the agency on its sub-accounts). If you see "Agency & Sub-account", pick that.
3. Open the app, then **Advanced Settings → Auth**:
   - **Scopes**, select exactly these four (the two `oauth.*` ones let the agency token list sub-accounts and get their tokens):
     `oauth.readonly`, `oauth.write`, `locations.readonly`, `opportunities.readonly`
     (Conversation analytics later will add `contacts.readonly`, `conversations.readonly` and `conversations/message.readonly`; you'd add them to the app and click Reconnect.)
   - **Redirect URL**: `https://<your-app>.vercel.app/api/ghl/callback`. Also add `http://localhost:3000/api/ghl/callback` for local dev.
   - **Client Keys → Add**: copy the **Client ID** and **Client Secret** (the secret is shown once).
4. Set the env vars `GHL_CLIENT_ID` and `GHL_CLIENT_SECRET` (§3) and redeploy.

GHL renames menus from time to time. If a label differs, look for the same setting nearby.

### 2b. Install it

1. Open the dashboard → **Sync status** → **Connect GHL agency**.
2. GHL asks where to install: choose **your agency** (not a single sub-account), select **all sub-accounts**, and if offered, tick **install on future sub-accounts**.
3. You land back on `/sync` with the sub-accounts listed. The first sync starts automatically.

If the refresh token ever stops working (e.g. the app was uninstalled), `/sync` shows "needs attention"; click **Reconnect**.

## 3. Environment variables

All are server-only; none are exposed to the browser.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string (host contains `-pooler`), `?sslmode=require` |
| `GHL_CLIENT_ID` | yes | Marketplace app Client ID (§2a) |
| `GHL_CLIENT_SECRET` | yes | Marketplace app Client Secret |
| `GHL_APP_ID` | no | Only if sub-account discovery fails with an appId error; defaults to the part of the Client ID before the first `-` |
| `DASHBOARD_PASSWORD` | yes | Login password, ≥ 8 chars |
| `SESSION_SECRET` | yes | ≥ 32 chars; signs the session cookie and encrypts the stored GHL tokens. `openssl rand -base64 48` |

Changing `SESSION_SECRET` logs you out and means clicking **Reconnect** for GHL (stored tokens can no longer be decrypted).

## 4. Neon (Postgres)

1. In Vercel: **Project → Storage → Create Database → Neon** (Marketplace integration), and connect it to the project. This sets `DATABASE_URL` (pooled) on the project.
2. For local dev, copy the pooled URL into `.env.local` (or create a Neon branch for dev).
3. Run migrations against it: `DATABASE_URL=... npm run db:migrate`. Re-run after pulling new migrations. It's safe to run repeatedly.

## 5. Deploy on Vercel

1. Import the GitHub repo in Vercel (framework: Next.js, defaults are fine).
2. Add the env vars from §3 (Production, and Preview if you use it).
3. Deploy, then run `npm run db:migrate` once against the production `DATABASE_URL`.
4. Open the site, log in, go to **Sync status**, click **Sync all now**.

The first sync of each location reads the last 60 days of SMS (`initial_sync_days` setting). For older history use **Backfill** on `/sync`. Big ranges continue on the following syncs.

## 6. How data stays current

There are no background jobs yet. When you open the dashboard (or come back to the tab), the page renders straight away from the database. If any location's data is more than a minute old, the header shows **Updating from GHL…**, a sync runs for all 4 locations in parallel, and the page refreshes when it finishes. A normal incremental sync takes a few seconds. **Sync now** in the header forces one at any time.

Only runs whose steps all succeeded move a location's "last synced" time, so the header never claims fresh data after a failed sync. If a sync fails, the header shows the reason and `/sync` lists the details.

The very first sync of a location reads 60 days of SMS and can take up to a minute. If it hits the 240 s budget, it stops cleanly and the next sync continues where it left off.

## 7. Later: background sync and webhooks

A scheduled sync (Vercel Hobby cron only runs daily, so it would need an external scheduler) and GHL workflow webhooks are deferred. The sync code is already idempotent and lock-protected, so adding a scheduler later is just a route that calls `runSync`.

## Project layout

```
src/
  proxy.ts                       auth gate (Next 16's renamed middleware)
  app/
    login/                       password login (server action)
    (dashboard)/                 authenticated pages (sidebar + header)
      sync/                      Sync status page
    api/sync/                    sync-on-open, manual sync, backfill (session)
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
