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
- **Time budget.** Each cron run budgets 240 s (Vercel Hobby max is 300 s), split evenly across the locations still to run. Page caps per step are a second guard.
- **Scheduling on Hobby.** `vercel.json` has a once-daily cron (the Hobby maximum) as a fallback; `.github/workflows/sync-cron.yml` calls the endpoint every 5 minutes.
- **Manual sync** goes through `POST /api/sync` (session cookie + same-origin check) rather than a server action, so the header button works on every page with one `maxDuration`.
- **shadcn/ui components were written by hand** (`src/components/ui/*`, same code the CLI generates) because the shadcn registry is unreachable from the build container. `components.json` is present so `npx shadcn add …` works on your machine.
- **No Google Fonts**: system font stack, so builds don't depend on fonts.googleapis.com.
- **Dark mode** follows the OS by default; the header toggle overrides it (stored in localStorage).
- **Ids as primary keys.** GHL ids are the PKs for contacts, conversations, messages, opportunities and stages, so upserts are naturally idempotent. Rows have no "synced at" column, so re-running a sync leaves them byte-identical (tested).
- **Enums as `text`** with TypeScript unions instead of Postgres enums: easier migrations when GHL adds statuses.
