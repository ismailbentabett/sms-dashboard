import { CANONICAL_STAGES } from "@/lib/config/stages";
import type { NicheSource } from "@/lib/config/settings";
import type { GhlContact, GhlMessage, GhlOpportunity } from "@/lib/ghl/schemas";
import type { contacts, messages, opportunities } from "@/lib/db/schema";

/** Lowercase, trim, collapse internal whitespace. */
export function normalizeStageName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

const CANONICAL_BY_NORMALIZED = new Map(CANONICAL_STAGES.map((s) => [normalizeStageName(s), s]));

/**
 * Map a GHL stage name to its canonical name. Manual overrides win
 * (location-specific first, then '*'), then an exact normalized match.
 */
export function canonicalStage(
  name: string,
  locationKey: string,
  overrides: readonly { locationKey: string; normalizedName: string; canonicalName: string }[] = [],
): string | null {
  const n = normalizeStageName(name);
  const specific = overrides.find((o) => o.locationKey === locationKey && o.normalizedName === n);
  if (specific) return specific.canonicalName;
  const global = overrides.find((o) => o.locationKey === "*" && o.normalizedName === n);
  if (global) return global.canonicalName;
  return CANONICAL_BY_NORMALIZED.get(n) ?? null;
}

export function phoneLast4(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** "Error 30005 - The recipient's number is inactive…" → { code: "30005", message: … } */
export function parseMessageError(error: unknown): { code: string | null; message: string | null } {
  if (error === undefined || error === null || error === "") return { code: null, message: null };
  const message = typeof error === "string" ? error : JSON.stringify(error);
  const code = /\b(\d{5})\b/.exec(message)?.[1] ?? null;
  return { code, message };
}

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function deriveNiche(contact: Pick<GhlContact, "tags" | "customFields">, source: NicheSource): string | null {
  if (source.type === "tag_prefix") {
    const prefix = source.prefix.toLowerCase();
    const tag = contact.tags.find((t) => t.toLowerCase().startsWith(prefix));
    const v = tag?.slice(prefix.length).trim();
    return v ? v.toLowerCase() : null;
  }
  if (source.type === "custom_field") {
    const field = contact.customFields.find((f) => f.id === source.fieldId);
    const v = field?.value;
    return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
  }
  return null;
}

type MessageRow = typeof messages.$inferInsert;
type ContactRow = typeof contacts.$inferInsert;
type OpportunityRow = typeof opportunities.$inferInsert;

export function mapMessage(m: GhlMessage, locationKey: string): MessageRow {
  const err = parseMessageError(m.error);
  return {
    ghlMessageId: m.id,
    conversationId: m.conversationId,
    contactId: m.contactId,
    locationKey,
    direction: m.direction,
    messageType: m.messageType ?? "TYPE_SMS",
    body: m.body ?? "",
    status: m.status,
    errorCode: err.code,
    errorMessage: err.message,
    sentAt: toDate(m.dateAdded) ?? new Date(0),
    ghlUpdatedAt: toDate(m.dateUpdated),
    source: m.source,
    userId: m.userId,
  };
}

/** DND is on if the global flag is set or the SMS channel's DND is active. */
function smsDnd(c: GhlContact): { dnd: boolean; message: string | null } {
  const sms = c.dndSettings?.SMS;
  const active = sms?.status === "active";
  return { dnd: Boolean(c.dnd) || active, message: active ? (sms?.message ?? null) : null };
}

export function mapContact(
  c: GhlContact,
  locationKey: string,
  nicheSource: NicheSource,
  companyFallback?: string | null,
): ContactRow {
  const dnd = smsDnd(c);
  const fullName = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return {
    ghlContactId: c.id,
    locationKey,
    // Leads are imported with the business name in first/last name; companyName is usually empty.
    companyName: c.companyName || c.businessName || companyFallback || fullName || null,
    firstName: c.firstName,
    lastName: c.lastName,
    city: c.city,
    state: c.state,
    timezone: c.timezone,
    phoneLast4: phoneLast4(c.phone),
    tags: c.tags,
    dnd: dnd.dnd,
    dndMessage: dnd.message,
    niche: deriveNiche(c, nicheSource),
    customFields: c.customFields.map((f) => ({ id: f.id, value: f.value })),
    createdAt: toDate(c.dateAdded),
    updatedAt: toDate(c.dateUpdated),
  };
}

export function mapOpportunity(o: GhlOpportunity, locationKey: string): OpportunityRow {
  return {
    ghlOpportunityId: o.id,
    contactId: o.contactId,
    locationKey,
    pipelineId: o.pipelineId,
    stageId: o.pipelineStageId,
    name: o.name,
    status: o.status,
    monetaryValue: o.monetaryValue ?? null,
    createdAt: toDate(o.createdAt),
    updatedAt: toDate(o.updatedAt),
    stageChangedAt: toDate(o.lastStageChangeAt),
  };
}
