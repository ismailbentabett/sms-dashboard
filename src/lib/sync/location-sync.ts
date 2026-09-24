import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Settings } from "@/lib/config/settings";
import { PIPELINE_NAME } from "@/lib/config/locations";
import {
  contacts,
  conversations,
  locations,
  messages,
  opportunities,
  stageHistory,
  stageOverrides,
  stages,
  syncCursors,
  type SyncCounts,
} from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { GhlError, type GhlClient } from "@/lib/ghl/client";
import { exportMessages, getContact, getPipelines, searchContacts, searchOpportunities } from "@/lib/ghl/endpoints";
import { ghlContactSchema, ghlMessageSchema, ghlOpportunitySchema } from "@/lib/ghl/schemas";
import { canonicalStage, mapContact, mapMessage, mapOpportunity, normalizeStageName } from "./mappers";

/** Re-read this much before each cursor so nothing is missed at page boundaries. */
export const OVERLAP_MS = 10 * 60 * 1000;
/** How far back the periodic deep pass reaches, to catch late delivery-status changes. */
const DEEP_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEEP_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_MESSAGE_PAGES = 60;
const MAX_CONTACT_PAGES = 40;
const MAX_OPPORTUNITY_PAGES = 50;
const MAX_CONTACTS_BY_ID = 50;

export interface LocationRef {
  key: string;
  ghlLocationId: string;
}

export interface LocationSyncResult {
  counts: SyncCounts;
  /** Human-readable problems: step failures, parse errors, early stops. */
  notes: string[];
  failedSteps: number;
  totalSteps: number;
  stoppedEarly: boolean;
}

interface Ctx {
  db: DB;
  client: GhlClient;
  loc: LocationRef;
  settings: Settings;
  deadline: number;
  now: () => Date;
  counts: Required<SyncCounts>;
  notes: string[];
  stoppedEarly: boolean;
}

function outOfTime(ctx: Ctx): boolean {
  if (Date.now() >= ctx.deadline) {
    if (!ctx.stoppedEarly) ctx.notes.push("Stopped early: time budget reached; will resume next run.");
    ctx.stoppedEarly = true;
    return true;
  }
  if (ctx.client.dailyBudgetLow) {
    if (!ctx.stoppedEarly) ctx.notes.push("Stopped early: GHL daily rate limit nearly used up.");
    ctx.stoppedEarly = true;
    return true;
  }
  return false;
}

function noteParseError(ctx: Ctx, what: string, issue: string) {
  ctx.counts.parseErrors++;
  // Keep the log readable: first few in full, then just the count.
  if (ctx.counts.parseErrors <= 5) ctx.notes.push(`Skipped invalid ${what}: ${issue}`);
}

const maxDate = (a: Date | null | undefined, b: Date | null | undefined): Date | null =>
  !a ? (b ?? null) : !b ? a : a > b ? a : b;

export async function syncLocation(
  db: DB,
  client: GhlClient,
  loc: LocationRef,
  settings: Settings,
  opts: { deadline: number; now?: () => Date },
): Promise<LocationSyncResult> {
  const ctx: Ctx = {
    db,
    client,
    loc,
    settings,
    deadline: opts.deadline,
    now: opts.now ?? (() => new Date()),
    counts: {
      messages: 0,
      contacts: 0,
      opportunities: 0,
      opportunitiesRemoved: 0,
      stages: 0,
      stageChanges: 0,
      contactsFetchedById: 0,
      parseErrors: 0,
      pages: 0,
    },
    notes: [],
    stoppedEarly: false,
  };

  await db.insert(syncCursors).values({ locationKey: loc.key }).onConflictDoNothing();

  const steps: [string, () => Promise<void>][] = [
    ["pipeline", () => syncPipeline(ctx)],
    ["messages", () => syncMessages(ctx)],
    ["contacts", () => syncContacts(ctx)],
    ["missing contacts", () => fetchMissingContacts(ctx)],
    ["opportunities", () => syncOpportunities(ctx)],
  ];
  let failedSteps = 0;
  for (const [name, run] of steps) {
    if (outOfTime(ctx)) break;
    try {
      await run();
    } catch (err) {
      failedSteps++;
      const msg = err instanceof GhlError || err instanceof Error ? err.message : String(err);
      ctx.notes.push(`${name} failed: ${msg}`);
    }
  }

  return {
    counts: ctx.counts,
    notes: ctx.notes,
    failedSteps,
    totalSteps: steps.length,
    stoppedEarly: ctx.stoppedEarly,
  };
}

// ---------------------------------------------------------------- pipeline

async function syncPipeline(ctx: Ctx) {
  const { pipelines } = await getPipelines(ctx.client);
  const wanted = normalizeStageName(PIPELINE_NAME);
  const pipeline = pipelines.find((p) => normalizeStageName(p.name) === wanted);
  if (!pipeline) {
    throw new Error(`Pipeline "${PIPELINE_NAME}" not found (have: ${pipelines.map((p) => p.name).join(", ")})`);
  }
  await ctx.db.update(locations).set({ pipelineId: pipeline.id }).where(eq(locations.key, ctx.loc.key));

  const overrides = await ctx.db.select().from(stageOverrides);
  const rows = pipeline.stages.map((s, i) => ({
    ghlStageId: s.id,
    locationKey: ctx.loc.key,
    name: s.name,
    normalizedName: normalizeStageName(s.name),
    position: s.position ?? i,
    canonicalName: canonicalStage(s.name, ctx.loc.key, overrides),
  }));
  if (rows.length) {
    await ctx.db
      .insert(stages)
      .values(rows)
      .onConflictDoUpdate({
        target: stages.ghlStageId,
        set: {
          name: sql`excluded.name`,
          normalizedName: sql`excluded.normalized_name`,
          position: sql`excluded.position`,
          canonicalName: sql`excluded.canonical_name`,
        },
      });
  }
  ctx.counts.stages = rows.length;
  const unmapped = rows.filter((r) => !r.canonicalName).map((r) => r.name);
  if (unmapped.length) ctx.notes.push(`Unmapped stages (add an override): ${unmapped.join(", ")}`);
}

// ---------------------------------------------------------------- messages

async function syncMessages(ctx: Ctx) {
  const [cursor] = await ctx.db.select().from(syncCursors).where(eq(syncCursors.locationKey, ctx.loc.key));
  const now = ctx.now();

  // 1) Pending backfill walk, if one was requested.
  if (cursor?.backfillFrom) {
    const res = await walkMessages(ctx, cursor.backfillFrom, async (maxSeen) => {
      await ctx.db.update(syncCursors).set({ backfillFrom: maxSeen }).where(eq(syncCursors.locationKey, ctx.loc.key));
    });
    if (!res.completed) return;
    await ctx.db.update(syncCursors).set({ backfillFrom: null }).where(eq(syncCursors.locationKey, ctx.loc.key));
    await advanceMessageCursor(ctx, res.maxSeen);
  }
  if (outOfTime(ctx)) return;

  // 2) Incremental walk from the cursor (minus overlap). Every 6h reach back 48h
  //    to pick up delivery statuses that changed after we first saw the message.
  const initial = new Date(now.getTime() - ctx.settings.initial_sync_days * 86_400_000);
  const base = cursor?.messagesUpdatedAt ?? initial;
  let start = new Date(base.getTime() - OVERLAP_MS);
  const deep = !cursor?.lastDeepSyncAt || now.getTime() - cursor.lastDeepSyncAt.getTime() > DEEP_EVERY_MS;
  if (deep && cursor?.messagesUpdatedAt) {
    const deepStart = new Date(now.getTime() - DEEP_WINDOW_MS);
    if (deepStart < start) start = deepStart;
  }

  const res = await walkMessages(ctx, start, (maxSeen) => advanceMessageCursor(ctx, maxSeen));
  if (res.completed) {
    const set: Partial<typeof syncCursors.$inferInsert> = { lastDeepSyncAt: deep ? now : undefined };
    // A completed walk with nothing new still means we're current up to `now - overlap`.
    if (!cursor?.messagesUpdatedAt && !res.maxSeen) set.messagesUpdatedAt = now;
    if (set.lastDeepSyncAt || set.messagesUpdatedAt) {
      await ctx.db.update(syncCursors).set(set).where(eq(syncCursors.locationKey, ctx.loc.key));
    }
  }
}

async function advanceMessageCursor(ctx: Ctx, maxSeen: Date | null) {
  if (!maxSeen) return;
  await ctx.db
    .update(syncCursors)
    .set({ messagesUpdatedAt: sql`greatest(coalesce(${syncCursors.messagesUpdatedAt}, ${maxSeen}), ${maxSeen})` })
    .where(eq(syncCursors.locationKey, ctx.loc.key));
}

/**
 * Walk the location's SMS export from `start`, sorted by updatedAt ascending,
 * upserting each page. `onPage` is called with the newest dateUpdated so far,
 * so an interrupted walk resumes where it stopped.
 */
async function walkMessages(
  ctx: Ctx,
  start: Date,
  onPage: (maxSeen: Date | null) => Promise<void>,
): Promise<{ completed: boolean; maxSeen: Date | null }> {
  let exportCursor: string | null = null;
  let maxSeen: Date | null = null;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    if (outOfTime(ctx)) return { completed: false, maxSeen };
    const res = await exportMessages(ctx.client, { startDate: start.toISOString(), cursor: exportCursor, limit: 100 });
    ctx.counts.pages++;

    const rows: (typeof messages.$inferInsert)[] = [];
    for (const raw of res.messages) {
      const parsed = ghlMessageSchema.safeParse(raw);
      if (!parsed.success) {
        noteParseError(ctx, "message", parsed.error.issues[0]?.message ?? "unknown");
        continue;
      }
      const m = parsed.data;
      if (m.messageType && m.messageType !== "TYPE_SMS") continue;
      rows.push({ ...mapMessage(m, ctx.loc.key), raw: raw as Record<string, unknown> });
    }
    await upsertMessages(ctx.db, rows);
    ctx.counts.messages += rows.length;
    for (const r of rows) maxSeen = maxDate(maxSeen, r.ghlUpdatedAt ?? r.sentAt);
    await onPage(maxSeen);

    exportCursor = res.nextCursor ?? null;
    if (!exportCursor || res.messages.length === 0) return { completed: true, maxSeen };
  }
  ctx.notes.push(`Message page cap (${MAX_MESSAGE_PAGES}) reached; will resume next run.`);
  ctx.stoppedEarly = true;
  return { completed: false, maxSeen };
}

export async function upsertMessages(db: DB, rows: (typeof messages.$inferInsert)[]) {
  if (!rows.length) return;
  // Only GHL-owned columns are updated; attribution and manual classification are left alone.
  await db
    .insert(messages)
    .values(rows)
    .onConflictDoUpdate({
      target: messages.ghlMessageId,
      set: {
        conversationId: sql`excluded.conversation_id`,
        contactId: sql`excluded.contact_id`,
        direction: sql`excluded.direction`,
        messageType: sql`excluded.message_type`,
        body: sql`excluded.body`,
        status: sql`excluded.status`,
        errorCode: sql`excluded.error_code`,
        errorMessage: sql`excluded.error_message`,
        sentAt: sql`excluded.sent_at`,
        ghlUpdatedAt: sql`excluded.ghl_updated_at`,
        source: sql`excluded.source`,
        userId: sql`excluded.user_id`,
        raw: sql`excluded.raw`,
      },
    });

  // Conversations are derived from messages (no extra API calls).
  const byConv = new Map<string, typeof conversations.$inferInsert>();
  for (const r of rows) {
    const prev = byConv.get(r.conversationId);
    if (!prev || (prev.lastMessageAt && r.sentAt > prev.lastMessageAt)) {
      byConv.set(r.conversationId, {
        ghlConversationId: r.conversationId,
        contactId: r.contactId,
        locationKey: r.locationKey,
        lastMessageAt: r.sentAt,
      });
    }
  }
  await db
    .insert(conversations)
    .values([...byConv.values()])
    .onConflictDoUpdate({
      target: conversations.ghlConversationId,
      set: {
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, excluded.last_message_at)`,
      },
    });
}

// ---------------------------------------------------------------- contacts

async function syncContacts(ctx: Ctx) {
  const [cursor] = await ctx.db.select().from(syncCursors).where(eq(syncCursors.locationKey, ctx.loc.key));
  const since = cursor?.contactsUpdatedAt ? new Date(cursor.contactsUpdatedAt.getTime() - OVERLAP_MS) : null;
  let searchAfter: unknown[] | null = null;
  let maxSeen: Date | null = null;

  for (let page = 0; page < MAX_CONTACT_PAGES; page++) {
    if (outOfTime(ctx)) return;
    const res = await searchContacts(ctx.client, { updatedSince: since?.toISOString() ?? null, searchAfter, pageLimit: 100 });
    ctx.counts.pages++;
    const rows: (typeof contacts.$inferInsert)[] = [];
    let lastAfter: unknown[] | null = null;
    for (const raw of res.contacts) {
      const parsed = ghlContactSchema.safeParse(raw);
      if (!parsed.success) {
        noteParseError(ctx, "contact", parsed.error.issues[0]?.message ?? "unknown");
        continue;
      }
      rows.push(mapContact(parsed.data, ctx.loc.key, ctx.settings.niche_source));
      if (parsed.data.searchAfter) lastAfter = parsed.data.searchAfter;
    }
    await upsertContacts(ctx.db, rows);
    ctx.counts.contacts += rows.length;
    for (const r of rows) maxSeen = maxDate(maxSeen, r.updatedAt);
    if (maxSeen) {
      await ctx.db
        .update(syncCursors)
        .set({ contactsUpdatedAt: sql`greatest(coalesce(${syncCursors.contactsUpdatedAt}, ${maxSeen}), ${maxSeen})` })
        .where(eq(syncCursors.locationKey, ctx.loc.key));
    }
    if (res.contacts.length < 100 || !lastAfter) return;
    searchAfter = lastAfter;
  }
  ctx.notes.push(`Contact page cap (${MAX_CONTACT_PAGES}) reached; will resume next run.`);
  ctx.stoppedEarly = true;
}

export async function upsertContacts(db: DB, rows: (typeof contacts.$inferInsert)[]) {
  if (!rows.length) return;
  await db
    .insert(contacts)
    .values(rows)
    .onConflictDoUpdate({
      target: contacts.ghlContactId,
      set: {
        locationKey: sql`excluded.location_key`,
        companyName: sql`excluded.company_name`,
        firstName: sql`excluded.first_name`,
        lastName: sql`excluded.last_name`,
        city: sql`excluded.city`,
        state: sql`excluded.state`,
        timezone: sql`excluded.timezone`,
        phoneLast4: sql`excluded.phone_last4`,
        tags: sql`excluded.tags`,
        dnd: sql`excluded.dnd`,
        dndMessage: sql`excluded.dnd_message`,
        niche: sql`excluded.niche`,
        customFields: sql`excluded.custom_fields`,
        createdAt: sql`excluded.created_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Contacts referenced by messages but not returned by the search walk (e.g. first run cut short). */
async function fetchMissingContacts(ctx: Ctx) {
  const missing = await ctx.db
    .selectDistinct({ id: messages.contactId })
    .from(messages)
    .where(
      and(
        eq(messages.locationKey, ctx.loc.key),
        notExists(ctx.db.select({ one: sql`1` }).from(contacts).where(eq(contacts.ghlContactId, messages.contactId))),
      ),
    )
    .limit(MAX_CONTACTS_BY_ID);

  for (const { id } of missing) {
    if (outOfTime(ctx)) return;
    try {
      const res = await getContact(ctx.client, id);
      const parsed = ghlContactSchema.safeParse(res.contact);
      if (!parsed.success) {
        noteParseError(ctx, "contact", parsed.error.issues[0]?.message ?? "unknown");
        continue;
      }
      await upsertContacts(ctx.db, [mapContact(parsed.data, ctx.loc.key, ctx.settings.niche_source)]);
      ctx.counts.contactsFetchedById++;
    } catch (err) {
      // A deleted contact returns 4xx; note it and move on.
      if (err instanceof GhlError && err.status !== null && err.status >= 400 && err.status < 500 && err.status !== 429) {
        ctx.notes.push(`Contact ${id} not fetchable (${err.status})`);
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------- opportunities

async function syncOpportunities(ctx: Ctx) {
  const [loc] = await ctx.db.select().from(locations).where(eq(locations.key, ctx.loc.key));
  if (!loc?.pipelineId) throw new Error("No pipeline id; pipeline step must succeed first");

  // Opportunities have no "updated since" filter, so walk the whole pipeline
  // (cheap: a few pages) and diff stages against what we have.
  let startAfter: string | number | null = null;
  let startAfterId: string | null = null;
  const seenIds = new Set<string>();
  for (let page = 0; page < MAX_OPPORTUNITY_PAGES; page++) {
    if (outOfTime(ctx)) return;
    const res = await searchOpportunities(ctx.client, { pipelineId: loc.pipelineId, startAfter, startAfterId, limit: 100 });
    ctx.counts.pages++;
    const rows: (typeof opportunities.$inferInsert)[] = [];
    for (const raw of res.opportunities) {
      const parsed = ghlOpportunitySchema.safeParse(raw);
      if (!parsed.success) {
        noteParseError(ctx, "opportunity", parsed.error.issues[0]?.message ?? "unknown");
        continue;
      }
      if (seenIds.has(parsed.data.id)) continue;
      seenIds.add(parsed.data.id);
      rows.push(mapOpportunity(parsed.data, ctx.loc.key));
    }
    ctx.counts.stageChanges += await upsertOpportunities(ctx.db, rows, "sync", ctx.now());
    ctx.counts.opportunities += rows.length;

    const meta = res.meta;
    if (!meta?.startAfterId || res.opportunities.length < 100 || meta.startAfterId === startAfterId) {
      await removeVanishedOpportunities(ctx, seenIds);
      return;
    }
    startAfter = meta.startAfter ?? null;
    startAfterId = meta.startAfterId;
  }
  ctx.notes.push(`Opportunity page cap (${MAX_OPPORTUNITY_PAGES}) reached.`);
}

/**
 * After a complete walk, anything we still hold for this location that GHL
 * didn't return was deleted or moved out of the pipeline. Drop it so stage
 * counts stay accurate. Skipped if the walk returned nothing at all, which
 * is more likely an API hiccup than an empty pipeline.
 */
async function removeVanishedOpportunities(ctx: Ctx, seenIds: Set<string>) {
  if (seenIds.size === 0) return;
  const held = await ctx.db
    .select({ id: opportunities.ghlOpportunityId })
    .from(opportunities)
    .where(eq(opportunities.locationKey, ctx.loc.key));
  const gone = held.map((h) => h.id).filter((id) => !seenIds.has(id));
  if (!gone.length) return;
  await ctx.db.delete(opportunities).where(inArray(opportunities.ghlOpportunityId, gone));
  ctx.counts.opportunitiesRemoved += gone.length;
}

/** Upsert opportunities and record stage changes. Returns the number of stage_history rows written. */
export async function upsertOpportunities(
  db: DB,
  rows: (typeof opportunities.$inferInsert)[],
  source: "sync" | "webhook",
  now: Date,
): Promise<number> {
  if (!rows.length) return 0;
  const existing = await db
    .select({ id: opportunities.ghlOpportunityId, stageId: opportunities.stageId })
    .from(opportunities)
    .where(
      inArray(
        opportunities.ghlOpportunityId,
        rows.map((r) => r.ghlOpportunityId),
      ),
    );
  const prevStage = new Map(existing.map((e) => [e.id, e.stageId]));

  const history: (typeof stageHistory.$inferInsert)[] = [];
  for (const r of rows) {
    if (!r.stageId) continue;
    const known = prevStage.has(r.ghlOpportunityId);
    const prev = prevStage.get(r.ghlOpportunityId) ?? null;
    if (known && prev === r.stageId) continue;
    history.push({
      opportunityId: r.ghlOpportunityId,
      locationKey: r.locationKey,
      fromStage: prev,
      toStage: r.stageId,
      // GHL gives lastStageChangeAt; fall back to creation (new) or now (changed).
      changedAt: r.stageChangedAt ?? (known ? now : (r.createdAt ?? now)),
      source,
    });
  }

  await db
    .insert(opportunities)
    .values(rows)
    .onConflictDoUpdate({
      target: opportunities.ghlOpportunityId,
      set: {
        contactId: sql`excluded.contact_id`,
        pipelineId: sql`excluded.pipeline_id`,
        stageId: sql`excluded.stage_id`,
        name: sql`excluded.name`,
        status: sql`excluded.status`,
        monetaryValue: sql`excluded.monetary_value`,
        createdAt: sql`excluded.created_at`,
        updatedAt: sql`excluded.updated_at`,
        stageChangedAt: sql`excluded.stage_changed_at`,
      },
    });

  if (!history.length) return 0;
  const inserted = await db.insert(stageHistory).values(history).onConflictDoNothing().returning({ id: stageHistory.id });
  return inserted.length;
}
