import { asc, desc, sql } from "drizzle-orm";
import { ghlConnection, locations, syncCursors, syncRuns } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { rowsOf } from "@/lib/sync/lock";

export interface LocationStatus {
  key: string;
  name: string;
  ghlLocationId: string;
  pipelineId: string | null;
  active: boolean;
  installed: boolean;
  lastSyncedAt: Date | null;
  messagesUpdatedAt: Date | null;
  contactsUpdatedAt: Date | null;
  backfillFrom: Date | null;
  counts: {
    contacts: number;
    conversations: number;
    messages: number;
    inbound: number;
    outbound: number;
    opportunities: number;
    stages: number;
    unmappedStages: number;
  };
}

/** Header strip: last sync time per location. */
export async function getLastSynced(db: DB) {
  return db
    .select({
      key: locations.key,
      lastSyncedAt: syncCursors.lastSyncedAt,
      active: locations.active,
      installed: locations.installed,
    })
    .from(locations)
    .leftJoin(syncCursors, sql`${syncCursors.locationKey} = ${locations.key}`)
    .orderBy(asc(locations.key));
}

export async function getLocationStatuses(db: DB): Promise<LocationStatus[]> {
  const locs = await db
    .select({
      key: locations.key,
      name: locations.name,
      ghlLocationId: locations.ghlLocationId,
      pipelineId: locations.pipelineId,
      active: locations.active,
      installed: locations.installed,
      lastSyncedAt: syncCursors.lastSyncedAt,
      messagesUpdatedAt: syncCursors.messagesUpdatedAt,
      contactsUpdatedAt: syncCursors.contactsUpdatedAt,
      backfillFrom: syncCursors.backfillFrom,
    })
    .from(locations)
    .leftJoin(syncCursors, sql`${syncCursors.locationKey} = ${locations.key}`)
    .orderBy(asc(locations.key));

  // One grouped count per table, keyed by location.
  const res = await db.execute<{ location_key: string; metric: string; n: string | number }>(sql`
    select location_key, 'contacts' as metric, count(*) as n from contacts group by location_key
    union all select location_key, 'conversations', count(*) from conversations group by location_key
    union all select location_key, 'messages', count(*) from messages group by location_key
    union all select location_key, 'inbound', count(*) from messages where direction = 'inbound' group by location_key
    union all select location_key, 'outbound', count(*) from messages where direction = 'outbound' group by location_key
    union all select location_key, 'opportunities', count(*) from opportunities group by location_key
    union all select location_key, 'stages', count(*) from stages group by location_key
    union all select location_key, 'unmappedStages', count(*) from stages where canonical_name is null group by location_key
  `);
  const counts = new Map<string, Record<string, number>>();
  for (const r of rowsOf<{ location_key: string; metric: string; n: string | number }>(res)) {
    const m = counts.get(r.location_key) ?? {};
    m[r.metric] = Number(r.n);
    counts.set(r.location_key, m);
  }

  return locs.map((l) => {
    const c = counts.get(l.key) ?? {};
    return {
      ...l,
      counts: {
        contacts: c.contacts ?? 0,
        conversations: c.conversations ?? 0,
        messages: c.messages ?? 0,
        inbound: c.inbound ?? 0,
        outbound: c.outbound ?? 0,
        opportunities: c.opportunities ?? 0,
        stages: c.stages ?? 0,
        unmappedStages: c.unmappedStages ?? 0,
      },
    };
  });
}

export async function getRecentRuns(db: DB, limit = 40) {
  return db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt), desc(syncRuns.id)).limit(limit);
}

/** Agency connection summary for the UI (no secrets). */
export async function getConnectionStatus(db: DB) {
  const [row] = await db
    .select({
      companyId: ghlConnection.companyId,
      connectedAt: ghlConnection.connectedAt,
      expiresAt: ghlConnection.expiresAt,
      scope: ghlConnection.scope,
      locationsDiscoveredAt: ghlConnection.locationsDiscoveredAt,
      lastError: ghlConnection.lastError,
    })
    .from(ghlConnection);
  return row ?? null;
}
