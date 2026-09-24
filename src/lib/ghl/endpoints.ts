import { GHL_VERSION, type GhlClient } from "./client";
import {
  contactByIdResponseSchema,
  contactSearchResponseSchema,
  conversationMessagesResponseSchema,
  exportMessagesResponseSchema,
  opportunitySearchResponseSchema,
  pipelinesResponseSchema,
} from "./schemas";

/**
 * Typed wrappers for the read-only GHL endpoints this app uses.
 * Paths, params and versions were checked against the GHL OpenAPI specs
 * and live responses (see DECISIONS.md, "GHL API findings").
 */

/** GET /opportunities/pipelines — Version 2021-07-28 */
export function getPipelines(client: GhlClient) {
  return client.get(
    "/opportunities/pipelines",
    { locationId: client.locationId },
    GHL_VERSION.default,
    pipelinesResponseSchema,
  );
}

/**
 * GET /conversations/messages/export — Version 2021-04-15.
 * Location-wide message list. `limit` must be ≥ 10. The `cursor` is only
 * valid for 2 minutes, so it can't be carried between cron runs.
 */
export function exportMessages(
  client: GhlClient,
  params: { startDate?: string; endDate?: string; cursor?: string | null; limit?: number; contactId?: string },
) {
  return client.get(
    "/conversations/messages/export",
    {
      locationId: client.locationId,
      channel: "SMS",
      sortBy: "updatedAt",
      sortOrder: "asc",
      limit: params.limit ?? 100,
      startDate: params.startDate,
      endDate: params.endDate,
      cursor: params.cursor ?? undefined,
      contactId: params.contactId,
    },
    GHL_VERSION.conversations,
    exportMessagesResponseSchema,
  );
}

/** GET /conversations/{conversationId}/messages — Version 2021-04-15 (targeted re-sync). */
export function getConversationMessages(
  client: GhlClient,
  conversationId: string,
  params: { lastMessageId?: string | null; limit?: number } = {},
) {
  return client.get(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    { limit: params.limit ?? 100, lastMessageId: params.lastMessageId ?? undefined, type: "TYPE_SMS" },
    GHL_VERSION.conversations,
    conversationMessagesResponseSchema,
  );
}

/**
 * POST /contacts/search — Version 2021-07-28 (POST-for-read).
 * Sorted by dateUpdated ascending, optionally filtered to dateUpdated ≥ since.
 * Paginate by echoing the last contact's `searchAfter`.
 */
export function searchContacts(
  client: GhlClient,
  params: { updatedSince?: string | null; searchAfter?: unknown[] | null; pageLimit?: number },
) {
  return client.postSearch(
    "/contacts/search",
    {
      locationId: client.locationId,
      pageLimit: params.pageLimit ?? 100,
      sort: [{ field: "dateUpdated", direction: "asc" }],
      ...(params.updatedSince
        ? { filters: [{ field: "dateUpdated", operator: "range", value: { gte: params.updatedSince } }] }
        : {}),
      ...(params.searchAfter ? { searchAfter: params.searchAfter } : {}),
    },
    GHL_VERSION.default,
    contactSearchResponseSchema,
  );
}

/** GET /contacts/{contactId} — Version 2021-07-28 */
export function getContact(client: GhlClient, contactId: string) {
  return client.get(
    `/contacts/${encodeURIComponent(contactId)}`,
    {},
    GHL_VERSION.default,
    contactByIdResponseSchema,
  );
}

/**
 * GET /opportunities/search — Version 2021-07-28.
 * The live API wants camelCase `locationId` / `pipelineId` (the OpenAPI spec
 * says `location_id`, which the API rejects with 422). Paginate with
 * `startAfter` + `startAfterId` from `meta`.
 */
export function searchOpportunities(
  client: GhlClient,
  params: { pipelineId: string; startAfter?: string | number | null; startAfterId?: string | null; limit?: number; contactId?: string },
) {
  return client.get(
    "/opportunities/search",
    {
      locationId: client.locationId,
      pipelineId: params.pipelineId,
      status: "all",
      limit: params.limit ?? 100,
      startAfter: params.startAfter ?? undefined,
      startAfterId: params.startAfterId ?? undefined,
      contactId: params.contactId,
    },
    GHL_VERSION.default,
    opportunitySearchResponseSchema,
  );
}
