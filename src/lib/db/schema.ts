import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type Direction = "inbound" | "outbound";
export type MatchMethod = "exact" | "fuzzy" | "none" | "manual";
export type Classification = "positive" | "negative" | "opt_out" | "question" | "auto_reply" | "other";
export type ClassificationSource = "rule" | "manual";
export type TemplateCategory = "first_text" | "fu1" | "fu2" | "post_loom" | "loom_delivery";
export type SyncKind = "incremental" | "backfill" | "targeted";
export type SyncStatus = "running" | "success" | "partial" | "error" | "skipped";

export const locations = pgTable("locations", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  ghlLocationId: text("ghl_location_id").notNull().unique(),
  pipelineId: text("pipeline_id"),
  timezoneDefault: text("timezone_default"),
  active: boolean("active").notNull().default(true),
});

export const stages = pgTable(
  "stages",
  {
    ghlStageId: text("ghl_stage_id").primaryKey(),
    locationKey: text("location_key").notNull().references(() => locations.key),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    position: integer("position").notNull(),
    canonicalName: text("canonical_name"),
  },
  (t) => [index("stages_location_idx").on(t.locationKey), index("stages_canonical_idx").on(t.canonicalName)],
);

/** Manual stage mapping: a normalized GHL stage name (per location, or '*' for all) → canonical name. */
export const stageOverrides = pgTable(
  "stage_overrides",
  {
    id: serial("id").primaryKey(),
    locationKey: text("location_key").notNull().default("*"),
    normalizedName: text("normalized_name").notNull(),
    canonicalName: text("canonical_name").notNull(),
  },
  (t) => [uniqueIndex("stage_overrides_uq").on(t.locationKey, t.normalizedName)],
);

export const contacts = pgTable(
  "contacts",
  {
    ghlContactId: text("ghl_contact_id").primaryKey(),
    locationKey: text("location_key").notNull().references(() => locations.key),
    companyName: text("company_name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    city: text("city"),
    state: text("state"),
    timezone: text("timezone"),
    phoneLast4: text("phone_last4"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    dnd: boolean("dnd").notNull().default(false),
    dndMessage: text("dnd_message"),
    niche: text("niche"),
    customFields: jsonb("custom_fields").$type<{ id: string; value: unknown }[]>(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    loomSentAt: ts("loom_sent_at"),
  },
  (t) => [
    index("contacts_location_idx").on(t.locationKey),
    index("contacts_niche_idx").on(t.niche),
    index("contacts_updated_idx").on(t.updatedAt),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    ghlConversationId: text("ghl_conversation_id").primaryKey(),
    contactId: text("contact_id").notNull(),
    locationKey: text("location_key").notNull().references(() => locations.key),
    lastMessageAt: ts("last_message_at"),
  },
  (t) => [
    index("conversations_contact_idx").on(t.contactId),
    index("conversations_location_last_idx").on(t.locationKey, t.lastMessageAt),
  ],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: serial("id").primaryKey(),
    /** A/B/C/D or ALL */
    locationKey: text("location_key").notNull(),
    category: text("category").$type<TemplateCategory>().notNull(),
    /** Split-test path A/B/C, null for post-Loom and Loom delivery. */
    path: text("path"),
    /** Post-Loom: workflow name, e.g. "LOOM 1 Loom sent". */
    sequence: text("sequence"),
    /** Post-Loom: step number within the sequence (1 = FU1). */
    step: integer("step"),
    label: text("label").notNull(),
    templateText: text("template_text").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("templates_location_category_idx").on(t.locationKey, t.category)],
);

export const messages = pgTable(
  "messages",
  {
    ghlMessageId: text("ghl_message_id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    contactId: text("contact_id").notNull(),
    locationKey: text("location_key").notNull().references(() => locations.key),
    direction: text("direction").$type<Direction>().notNull(),
    messageType: text("message_type").notNull(),
    body: text("body").notNull().default(""),
    status: text("status"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    sentAt: ts("sent_at").notNull(),
    ghlUpdatedAt: ts("ghl_updated_at"),
    source: text("source"),
    userId: text("user_id"),
    // Outbound attribution (Phase 2)
    templateId: integer("template_id").references(() => messageTemplates.id, { onDelete: "set null" }),
    matchMethod: text("match_method").$type<MatchMethod>(),
    matchScore: real("match_score"),
    // Inbound attribution + classification (Phase 2)
    attributedTemplateId: integer("attributed_template_id").references(() => messageTemplates.id, {
      onDelete: "set null",
    }),
    attributedMessageId: text("attributed_message_id"),
    classification: text("classification").$type<Classification>(),
    classificationSource: text("classification_source").$type<ClassificationSource>(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("messages_location_sent_idx").on(t.locationKey, t.sentAt),
    index("messages_conversation_sent_idx").on(t.conversationId, t.sentAt),
    index("messages_contact_idx").on(t.contactId),
    index("messages_template_idx").on(t.templateId),
    index("messages_attributed_template_idx").on(t.attributedTemplateId),
    index("messages_classification_idx").on(t.classification),
    index("messages_direction_idx").on(t.direction),
  ],
);

export const opportunities = pgTable(
  "opportunities",
  {
    ghlOpportunityId: text("ghl_opportunity_id").primaryKey(),
    contactId: text("contact_id").notNull(),
    locationKey: text("location_key").notNull().references(() => locations.key),
    pipelineId: text("pipeline_id"),
    stageId: text("stage_id"),
    name: text("name"),
    status: text("status"),
    monetaryValue: numeric("monetary_value", { mode: "number" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    stageChangedAt: ts("stage_changed_at"),
  },
  (t) => [
    index("opportunities_location_idx").on(t.locationKey),
    index("opportunities_stage_idx").on(t.stageId),
    index("opportunities_contact_idx").on(t.contactId),
  ],
);

export const stageHistory = pgTable(
  "stage_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    opportunityId: text("opportunity_id").notNull(),
    locationKey: text("location_key").notNull(),
    fromStage: text("from_stage"),
    toStage: text("to_stage").notNull(),
    changedAt: ts("changed_at").notNull(),
    source: text("source").$type<"sync" | "webhook">().notNull(),
  },
  (t) => [
    uniqueIndex("stage_history_uq").on(t.opportunityId, t.toStage, t.changedAt),
    index("stage_history_opp_idx").on(t.opportunityId, t.changedAt),
    index("stage_history_to_stage_idx").on(t.toStage),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    locationId: text("location_id"),
    eventType: text("event_type"),
    payload: jsonb("payload").notNull(),
    processed: boolean("processed").notNull().default(false),
    error: text("error"),
  },
  (t) => [index("webhook_events_received_idx").on(t.receivedAt)],
);

export interface SyncCounts {
  messages?: number;
  contacts?: number;
  opportunities?: number;
  opportunitiesRemoved?: number;
  stages?: number;
  stageChanges?: number;
  contactsFetchedById?: number;
  parseErrors?: number;
  pages?: number;
}

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    locationKey: text("location_key").notNull(),
    kind: text("kind").$type<SyncKind>().notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    status: text("status").$type<SyncStatus>().notNull(),
    counts: jsonb("counts").$type<SyncCounts>().notNull().default({}),
    requests: integer("requests").notNull().default(0),
    rateLimitHits: integer("rate_limit_hits").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("sync_runs_location_started_idx").on(t.locationKey, t.startedAt)],
);

export const syncCursors = pgTable("sync_cursors", {
  locationKey: text("location_key").primaryKey(),
  /** Newest message dateUpdated seen by the message export walk. */
  messagesUpdatedAt: ts("messages_updated_at"),
  /** Newest contact dateUpdated seen by the contact search walk. */
  contactsUpdatedAt: ts("contacts_updated_at"),
  /** Last run that finished without error (success or partial). */
  lastSyncedAt: ts("last_synced_at"),
  /** Last time the incremental walk re-read the trailing 48h to pick up late status changes. */
  lastDeepSyncAt: ts("last_deep_sync_at"),
  /** Pending backfill: the message walk resumes from here until it reaches the present, then clears it. */
  backfillFrom: ts("backfill_from"),
});

export const syncLocks = pgTable("sync_locks", {
  locationKey: text("location_key").primaryKey(),
  holder: text("holder").notNull(),
  lockedUntil: ts("locked_until").notNull(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});
