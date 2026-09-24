import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { locations, syncCursors, syncRuns, type SyncKind, type SyncStatus } from "@/lib/db/schema";
import { getSettings } from "@/lib/db/settings";
import type { DB } from "@/lib/db/types";
import type { GhlClient } from "@/lib/ghl/client";
import { acquireLock, releaseLock } from "./lock";
import { syncLocation, type LocationRef, type SyncScope } from "./location-sync";

export interface RunSyncOptions {
  db: DB;
  /** Returns a client for the location, or null when GHL isn't connected. */
  clientFor: (loc: LocationRef & { key: string }) => GhlClient | null;
  /** Why clientFor returned null, shown on skipped runs. */
  noClientReason?: string;
  kind?: SyncKind;
  locationKeys?: string[];
  /** What to sync; defaults to opportunities only. */
  scope?: SyncScope;
  /** Total wall-clock budget for all locations. */
  budgetMs?: number;
  now?: () => Date;
}

export interface LocationRunSummary {
  locationKey: string;
  status: SyncStatus;
  runId: number | null;
  error: string | null;
}

/** Leave headroom under Vercel Hobby's 300 s function limit. */
export const DEFAULT_BUDGET_MS = 240_000;

/**
 * Sync each active location. Locations run in parallel: GHL rate-limits per
 * location, and each has its own limiter and lock, so this is safe and keeps
 * the sync-on-open wait short.
 */
export async function runSync(opts: RunSyncOptions): Promise<LocationRunSummary[]> {
  const { db } = opts;
  const kind = opts.kind ?? "incremental";
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const settings = await getSettings(db);

  const locs = await db
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.installed, true),
        opts.locationKeys?.length ? inArray(locations.key, opts.locationKeys) : eq(locations.active, true),
      ),
    )
    .orderBy(asc(locations.key));

  return Promise.all(locs.map((loc) => runOne(db, opts, loc, kind, deadline, settings)));
}

async function runOne(
  db: DB,
  opts: RunSyncOptions,
  loc: typeof locations.$inferSelect,
  kind: SyncKind,
  deadline: number,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<LocationRunSummary> {
  const client = opts.clientFor(loc);
  if (!client) {
    const [run] = await db
      .insert(syncRuns)
      .values({
        locationKey: loc.key,
        kind,
        status: "skipped",
        startedAt: new Date(),
        finishedAt: new Date(),
        error: opts.noClientReason ?? "GHL is not connected",
      })
      .returning({ id: syncRuns.id });
    return { locationKey: loc.key, status: "skipped", runId: run.id, error: opts.noClientReason ?? "GHL is not connected" };
  }

  const holder = randomUUID();
  const leaseMs = Math.max(deadline - Date.now(), 0) + 60_000;
  if (!(await acquireLock(db, loc.key, holder, leaseMs))) {
    const [run] = await db
      .insert(syncRuns)
      .values({
        locationKey: loc.key,
        kind,
        status: "skipped",
        startedAt: new Date(),
        finishedAt: new Date(),
        error: "Another sync is running",
      })
      .returning({ id: syncRuns.id });
    return { locationKey: loc.key, status: "skipped", runId: run.id, error: "Another sync is running" };
  }

  const [run] = await db
    .insert(syncRuns)
    .values({ locationKey: loc.key, kind, status: "running", startedAt: new Date() })
    .returning({ id: syncRuns.id });

  let status: SyncStatus = "error";
  let error: string | null = null;
  try {
    const result = await syncLocation(db, client, loc, settings, { deadline, now: opts.now, scope: opts.scope });
    // Any failed step is an error: "last synced" must only move when the data really is current.
    // "partial" means every step worked but the run stopped early or skipped unparseable records.
    status =
      result.failedSteps > 0
        ? "error"
        : result.stoppedEarly || result.counts.parseErrors
          ? "partial"
          : "success";
    error = result.notes.length ? result.notes.join("\n") : null;
    await db
      .update(syncRuns)
      .set({
        status,
        finishedAt: new Date(),
        counts: result.counts,
        requests: client.stats.requests,
        rateLimitHits: client.stats.rateLimitHits,
        error,
      })
      .where(eq(syncRuns.id, run.id));
    if (status !== "error") {
      await db
        .update(syncCursors)
        .set({ lastSyncedAt: (opts.now ?? (() => new Date()))() })
        .where(eq(syncCursors.locationKey, loc.key));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({
        status: "error",
        finishedAt: new Date(),
        requests: client.stats.requests,
        rateLimitHits: client.stats.rateLimitHits,
        error,
      })
      .where(eq(syncRuns.id, run.id));
  } finally {
    await releaseLock(db, loc.key, holder);
  }
  return { locationKey: loc.key, status, runId: run.id, error };
}

/** Queue a backfill: the next runs walk messages forward from `from` until they reach the present. */
export async function requestBackfill(db: DB, from: Date, locationKeys?: string[]) {
  const locs = await db
    .select({ key: locations.key })
    .from(locations)
    .where(locationKeys?.length ? inArray(locations.key, locationKeys) : eq(locations.active, true));
  for (const { key } of locs) {
    await db
      .insert(syncCursors)
      .values({ locationKey: key, backfillFrom: from })
      .onConflictDoUpdate({ target: syncCursors.locationKey, set: { backfillFrom: from } });
  }
}
