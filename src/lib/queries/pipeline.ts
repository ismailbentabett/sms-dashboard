import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { CANONICAL_STAGES } from "@/lib/config/stages";
import { locations, opportunities, stageHistory, stages } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";

export const UNMAPPED = "(unmapped stage)";

/** Tracked sub-accounts, in key order. */
export function getTrackedLocations(db: DB) {
  return db
    .select({ key: locations.key, name: locations.name, ghlLocationId: locations.ghlLocationId })
    .from(locations)
    .where(and(eq(locations.active, true), eq(locations.installed, true)))
    .orderBy(locations.key);
}

/**
 * Opportunity counts per canonical stage per sub-account. Stages that don't
 * map to a canonical name are grouped under UNMAPPED so nothing is hidden.
 */
export async function getStageCounts(db: DB) {
  const rows = await db
    .select({
      locationKey: opportunities.locationKey,
      stage: sql<string>`coalesce(${stages.canonicalName}, ${UNMAPPED})`,
      n: sql<number>`count(*)::int`,
    })
    .from(opportunities)
    .innerJoin(locations, eq(locations.key, opportunities.locationKey))
    .leftJoin(stages, eq(stages.ghlStageId, opportunities.stageId))
    .where(and(eq(locations.active, true), eq(locations.installed, true)))
    .groupBy(opportunities.locationKey, sql`2`);

  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const byLoc = counts.get(r.stage) ?? new Map<string, number>();
    byLoc.set(r.locationKey, Number(r.n));
    counts.set(r.stage, byLoc);
  }
  const order: string[] = [...CANONICAL_STAGES];
  if (counts.has(UNMAPPED)) order.push(UNMAPPED);
  return { order, counts };
}

/** Latest stage moves across tracked sub-accounts. */
export async function getRecentStageChanges(db: DB, limit = 40) {
  const fromStage = alias(stages, "from_stage");
  const toStage = alias(stages, "to_stage");
  return db
    .select({
      id: stageHistory.id,
      changedAt: stageHistory.changedAt,
      locationKey: stageHistory.locationKey,
      opportunityName: opportunities.name,
      from: sql<string | null>`coalesce(${fromStage.canonicalName}, ${fromStage.name})`,
      to: sql<string | null>`coalesce(${toStage.canonicalName}, ${toStage.name})`,
    })
    .from(stageHistory)
    .innerJoin(opportunities, eq(opportunities.ghlOpportunityId, stageHistory.opportunityId))
    .innerJoin(locations, eq(locations.key, stageHistory.locationKey))
    .leftJoin(fromStage, eq(fromStage.ghlStageId, stageHistory.fromStage))
    .leftJoin(toStage, eq(toStage.ghlStageId, stageHistory.toStage))
    .where(and(eq(locations.active, true), eq(locations.installed, true)))
    .orderBy(desc(stageHistory.changedAt), desc(stageHistory.id))
    .limit(limit);
}

/** Opportunities, newest stage change first, optionally filtered. */
export async function getOpportunities(db: DB, filter: { locationKey?: string; stage?: string }, limit = 300) {
  const stageExpr = sql<string>`coalesce(${stages.canonicalName}, ${UNMAPPED})`;
  return db
    .select({
      id: opportunities.ghlOpportunityId,
      name: opportunities.name,
      locationKey: opportunities.locationKey,
      ghlLocationId: locations.ghlLocationId,
      stage: stageExpr,
      rawStage: stages.name,
      status: opportunities.status,
      stageChangedAt: opportunities.stageChangedAt,
      createdAt: opportunities.createdAt,
    })
    .from(opportunities)
    .innerJoin(locations, eq(locations.key, opportunities.locationKey))
    .leftJoin(stages, eq(stages.ghlStageId, opportunities.stageId))
    .where(
      and(
        eq(locations.active, true),
        eq(locations.installed, true),
        filter.locationKey ? eq(opportunities.locationKey, filter.locationKey) : undefined,
        filter.stage ? sql`${stageExpr} = ${filter.stage}` : undefined,
      ),
    )
    .orderBy(sql`${opportunities.stageChangedAt} desc nulls last`)
    .limit(limit);
}
