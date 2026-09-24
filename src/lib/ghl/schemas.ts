import { z } from "zod";

/**
 * Loose zod schemas for the GHL responses we read. Unknown fields are
 * tolerated (zod objects strip them by default, and we keep the raw JSON
 * where it matters). Shapes were checked against live responses; see
 * DECISIONS.md for where they differ from the published OpenAPI spec.
 */

const nullishString = z.string().nullish().transform((v) => v ?? null);

export const ghlStageSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().optional(),
});

export const ghlPipelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  stages: z.array(ghlStageSchema).default([]),
});

export const pipelinesResponseSchema = z.object({
  pipelines: z.array(ghlPipelineSchema),
});

export const ghlMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  contactId: z.string(),
  locationId: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  messageType: z.string().optional(),
  type: z.number().optional(),
  body: nullishString,
  status: nullishString,
  /** Live responses carry e.g. "Error 30005 - The recipient's number is inactive…". Not in the OpenAPI spec. */
  error: z.unknown().optional(),
  dateAdded: z.string(),
  dateUpdated: z.string().optional(),
  source: nullishString,
  userId: nullishString,
});
export type GhlMessage = z.infer<typeof ghlMessageSchema>;

/** Messages are validated one by one so a single odd record doesn't sink the page. */
export const exportMessagesResponseSchema = z.object({
  messages: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
  total: z.number().optional(),
});

export const conversationMessagesResponseSchema = z.object({
  messages: z.object({
    lastMessageId: z.string().nullish(),
    nextPage: z.boolean().optional(),
    messages: z.array(z.unknown()),
  }),
});

export const ghlContactSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  firstName: nullishString,
  lastName: nullishString,
  companyName: nullishString,
  businessName: nullishString,
  city: nullishString,
  state: nullishString,
  timezone: nullishString,
  phone: nullishString,
  tags: z.array(z.string()).nullish().transform((v) => v ?? []),
  dnd: z.boolean().nullish(),
  dndSettings: z
    .record(z.string(), z.object({ status: z.string().nullish(), message: z.string().nullish() }).passthrough())
    .nullish(),
  customFields: z
    .array(z.object({ id: z.string(), value: z.unknown() }).passthrough())
    .nullish()
    .transform((v) => v ?? []),
  dateAdded: nullishString,
  dateUpdated: nullishString,
  /** Pagination token for POST /contacts/search. */
  searchAfter: z.array(z.unknown()).optional(),
});
export type GhlContact = z.infer<typeof ghlContactSchema>;

export const contactSearchResponseSchema = z.object({
  contacts: z.array(z.unknown()),
  total: z.number().optional(),
});

export const contactByIdResponseSchema = z.object({ contact: z.unknown() });

export const ghlOpportunitySchema = z.object({
  id: z.string(),
  name: nullishString,
  contactId: z.string(),
  locationId: z.string(),
  pipelineId: nullishString,
  pipelineStageId: nullishString,
  status: nullishString,
  monetaryValue: z.number().nullish(),
  createdAt: nullishString,
  updatedAt: nullishString,
  lastStageChangeAt: nullishString,
});
export type GhlOpportunity = z.infer<typeof ghlOpportunitySchema>;

export const opportunitySearchResponseSchema = z.object({
  opportunities: z.array(z.unknown()),
  meta: z
    .object({
      total: z.number().nullish(),
      startAfter: z.union([z.number(), z.string()]).nullish(),
      startAfterId: z.string().nullish(),
      nextPage: z.number().nullish(),
    })
    .passthrough()
    .nullish(),
});
