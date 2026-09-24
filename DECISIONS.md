# Decisions

Choices made where the spec was ambiguous or where the docs or live API differed from it. Newest phase at the bottom.

## GHL API findings (checked against the OpenAPI specs in `GoHighLevel/highlevel-api-docs` and live read-only calls, 2026-09-24)

| Topic | Spec said | Reality | What the app does |
|---|---|---|---|
| Opportunity search params | — | OpenAPI documents `location_id` / `pipeline_id`; the live API rejects them with 422 (`property location_id should not exist`). Its own `meta.nextPageUrl` uses `locationId` / `pipelineId`. | Sends camelCase. |
| Message error codes | store error code + message | Not in the OpenAPI message schema, but live messages have `error: "Error 30005 - The recipient's number is inactive or does not exist."` | Parse the 5-digit code into `messages.error_code`; keep the full string in `error_message`; keep the raw payload in `messages.raw`. |
| Message export | "prefer a location-wide export if one exists" | `GET /conversations/messages/export` exists. `limit` must be ≥ 10. **The pagination cursor expires 2 minutes after the last request.** `startDate` accepts ISO timestamps. Messages include `dateUpdated`. | Primary incremental source. Sorted by `updatedAt` asc; the persisted cursor is the newest `dateUpdated` seen, not GHL's cursor, so a run cut short resumes next run. |
| Message statuses | delivered / failed / undelivered / sent | Also `pending`, `queued`, `scheduled`, `read`, `opened`, `clicked`, `connected`, `opt_out`. | Stored as-is. |
| Message `source` | workflow / app / api | Also `bulk_actions`, `campaign`. Inbound messages have no source. | Stored as-is. |
| Outbound first texts | template text | Every workflow first text has an appended footer: `\njust say "byebye" if you want me to stop\nthanks`. | **Phase 2:** template matching strips/tolerates this footer; `byebye` is added to opt-out keywords. |
| Contacts | `GET /contacts/{id}` per contact | `POST /contacts/search` (POST-for-read) returns 100 full contacts per call, sorts and filters by `dateUpdated` (`range` / `gte`), pages with `searchAfter`. | Contacts sync incrementally via search; `GET /contacts/{id}` only for contacts referenced by messages but not yet seen. |
| Company name | `contact.companyName` | Empty for imported leads; the business name is in `firstName` + `lastName` (and the opportunity name). | `company_name = companyName ‖ businessName ‖ firstName + lastName`. |
| DND | `contact.dnd` | `dnd` is often false while `dndSettings.SMS.status = "active"` (message like `TWILIO_ERROR_CODE: 30005` or `Updated from workflow_…`). | `dnd = dnd ‖ dndSettings.SMS.status == "active"`; the message is kept in `dnd_message`. |
| Opportunities | incremental by updated date | No "updated since" filter on `GET /opportunities/search` (only created-date). About 90 opportunities per location, since they're created on reply. | Walk the whole pipeline each run (1–2 requests) and diff stages to build `stage_history`. `lastStageChangeAt` gives the change timestamp. |
| Conversations | conversation search | Every message carries `conversationId`, and the export covers all SMS. | `conversations` rows come from messages (0 extra requests). Conversation search is kept for targeted re-sync (Phase 4). |
| Rate-limit headers | read them | `X-RateLimit-Remaining`, `X-RateLimit-Max`, `X-RateLimit-Interval-Milliseconds`, `X-RateLimit-Daily-Remaining`, `X-RateLimit-Limit-Daily` (read case-insensitively; `-Interval-Millis` also accepted). | Pause when burst remaining ≤ 3; stop paging when daily remaining < 2,000. |
| Stage spelling | "Loom sent" | Location A has "Loom Sent". | Normalized-name mapping plus the `stage_overrides` table. |

## Phase 1

- **Next.js 16: `proxy.ts`, not `middleware.ts`.** Middleware was renamed to Proxy in Next 16 and always runs on Node.js.
- **DB driver: `pg` (node-postgres) with Neon's pooled URL, not the Neon serverless driver.** It works the same locally and on Vercel Fluid compute (pool registered with `attachDatabasePool`). Tests run on PGlite (in-process Postgres) with the same migrations.
- **Sync lock: a lease row in `sync_locks`, not `pg_advisory_lock`.** Neon's pooler runs PgBouncer in transaction mode, where session advisory locks aren't reliable. The lease expires on its own if a function dies.
- **Rate limiter: sliding-window log instead of a classic token bucket.** A bucket that holds 90 tokens and refills 90 per 10 s can release ~180 requests in one 10 s window. The sliding window guarantees ≤ 90 per any 10 s window (limit is 100). It is per process; cross-instance safety comes from the lock and GHL's headers.
- **Late status changes.** The export may filter `startDate` on creation date rather than update date (not documented). So every 6 hours the incremental walk reaches back 48 h to pick up delivery statuses that settled late. The normal overlap is 10 minutes, per the spec.
- **First sync reaches back `initial_sync_days` (default 60).** Change it in `settings`, or use Backfill.
- **Backfill** sets `sync_cursors.backfill_from`. Each run walks forward from it until it reaches the present, then clears it, so large backfills continue across scheduled runs. There's a CLI: `npm run sync -- --backfill 2026-09-01 --budget 900`.
- **Time budget.** Each sync budgets 240 s (Vercel Hobby max is 300 s). Page caps per step are a second guard.
- **Sync runs through `POST /api/sync`** (session cookie + same-origin check) rather than a server action, so the header works on every page with one `maxDuration`.

## Phase 1b: sync on open instead of background jobs (your call)

- **No cron, scheduler or webhooks for now.** Removed `vercel.json`, the GitHub Actions scheduler, `/api/cron/sync`, `CRON_SECRET` and `INGEST_SECRET`.
- **Sync on open.** The dashboard renders from the database immediately. If any location with a token was last synced more than 60 s ago, the header component (`AutoSync`) calls `POST /api/sync` and refreshes the page when it finishes. It checks again when the tab becomes visible. There is no polling while the tab is open.
- **Locations sync in parallel.** GHL rate-limits per location, and each location has its own limiter and lock, so this is safe and cuts the wait about 4x.
- **"Last synced" is honest.** Any failed step marks the run `error`, and only `success`/`partial` runs move `last_synced_at`. (Before this change, a run where every GHL call failed was marked `partial` and looked fresh.) `partial` now only means every step worked but the run stopped at its time budget or skipped unparseable records.
- **Deleted opportunities are removed.** After a complete pipeline walk, opportunities GHL no longer returns (deleted or moved out of the pipeline) are deleted locally, so stage counts don't drift. If the walk returns nothing at all, nothing is deleted, since that's more likely an API hiccup.
- **shadcn/ui components were written by hand** (`src/components/ui/*`, same code the CLI generates) because the shadcn registry is unreachable from the build container. `components.json` is present so `npx shadcn add …` works on your machine.
- **No Google Fonts**: system font stack, so builds don't depend on fonts.googleapis.com.
- **Dark mode** follows the OS by default; the header toggle overrides it (stored in localStorage).
- **Ids as primary keys.** GHL ids are the PKs for contacts, conversations, messages, opportunities and stages, so upserts are naturally idempotent. Rows have no "synced at" column, so re-running a sync leaves them byte-identical (tested).
- **Enums as `text`** with TypeScript unions instead of Postgres enums: easier migrations when GHL adds statuses.

## Phase 1c: agency-level GHL access (your call: "find an agency-level solution")

- **Why not an agency Private Integration Token:** the data endpoints (`/conversations/*`, `/contacts/*`, `/opportunities/*`) only accept sub-account tokens (OpenAPI `security: bearer` = "Sub-Account token"). Agency PITs don't offer those scopes or `oauth.write`, so they can't read or create sub-account tokens.
- **What we do instead: a private Marketplace app with OAuth.** The agency admin installs it once. We exchange the code with `user_type=Company` (`POST /oauth/token`), mint a sub-account token per location with `POST /oauth/locationToken` (scope `oauth.write`, Version 2021-07-28, ~24 h lifetime), and list installs with `GET /oauth/installedLocations` (scope `oauth.readonly`, needs `companyId` + `appId`).
- **Still read-only.** The two POSTs only issue tokens; nothing in GHL changes. The data client's POST allowlist is unchanged (`/contacts/search` only).
- **Token storage:** Company access and refresh tokens and cached location tokens live in Postgres, AES-256-GCM encrypted with a key derived (HKDF) from `SESSION_SECRET`. No new secret to manage; rotating `SESSION_SECRET` requires a Reconnect.
- **Refresh safety:** GHL rotates the refresh token on every use, so the refresh runs under `SELECT … FOR UPDATE` on the connection row. A second concurrent refresher waits, then reuses the new token. A failed refresh is recorded in `ghl_connection.last_error` and shown on `/sync` with a Reconnect button.
- **401 handling:** the data client drops its cached location token on a 401 and retries once. Minting a location token that gets a 401 forces a Company refresh and retries once.
- **appId** is derived from the Client ID (the part before the first `-`, GHL's format); `GHL_APP_ID` overrides it. If `installedLocations` fails, discovery falls back to the `approvedLocations` GHL returned at install time.
- **Sub-accounts are discovered, not hard-coded.** The seed of the 4 sub-accounts is gone. Discovery runs on connect, then at most every 10 minutes on sync (or on "Re-check sub-accounts").
  - A new sub-account gets its key from a `"A: …"` name prefix (else the next free letter).
  - It's tracked only if it has the outreach pipeline, so other agency clients are listed but ignored.
  - One the app was removed from is marked `installed = false` and skipped.
  - An empty install list is ignored rather than treated as "uninstalled everywhere".
  - A manual Track/Ignore choice is never overridden.
- **Callback CSRF:** the Connect button sets a 15-minute httpOnly state cookie; the callback requires it (and a matching `state` if GHL echoes it). Installs must therefore start from the dashboard's Connect button.

## Phase 1d: opportunities first (your call: "track the opportunities, keep convos for later")

- The sync scope defaults to **`opportunities`**: pipeline stages + opportunities (full walk, stage history, deleted-opportunity cleanup). Message and contact sync is still in the code (`scope: "full"`) and tested, but not run.
- The OAuth app needs only `oauth.readonly`, `oauth.write`, `locations.readonly` and `opportunities.readonly`. `opportunities.readonly` is a Sub-Account scope in GHL's scope table, so the agency Private Integration Token still can't read opportunities; the Marketplace app remains the agency-level route.
- **Home page = Pipeline:**
  - opportunity counts per canonical stage × sub-account (unmapped stages grouped, not hidden)
  - Needs Reply / Won / MRR (Won stage count × price setting)
  - a filterable opportunity list (click any count)
  - recent stage changes from `stage_history`
- The Sync page drops the message, contact and conversation columns and the (messages-only) Backfill box.
