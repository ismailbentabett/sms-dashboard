import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { locations, syncCursors, syncRuns, type SyncKind, type SyncStatus } from "@/lib/db/schema";
import { seedLocations } from "@/lib/db/seed";
import { getSettings } from "@/lib/db/settings";
import type { DB } from "@/lib/db/types";
import type { GhlClient } from "@/lib/ghl/client";
import { acquireLock, releaseLock } from "./lock";
import { syncLocation, type LocationRef } from "./location-sync";

export interface RunSyncOptions {
  db: DB;
  /** Returns a client for the location, or null when its token isn't configured. */
  clientFor: (loc: LocationRef & { key: string }) => GhlClient | null;
  kind?: SyncKind;
  locationKeys?: string[];
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
 * Run a sync for each active location, one after another. Each location
 * gets an equal share of the remaining budget so one big backfill can't
 * starve the others.
 */
export async function runSync(opts: RunSyncOptions): Promise<LocationRunSummary[]> {
  const { db } = opts;
  const kind = opts.kind ?? "incremental";
  const started = Date.now();
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  await seedLocations(db);
  const settings = await getSettings(db);

  const locs = await db
    .select()
    .from(locations)
    .where(opts.locationKeys?.length ? inArray(locations.key, opts.locationKeys) : eq(locations.active, true))
    .orderBy(asc(locations.key));

  const results: LocationRunSummary[] = [];
  for (let i = 0; i < locs.length; i++) {
    const loc = locs[i];
    const remaining = budget - (Date.now() - started);
    const share = remaining / (locs.length - i);
    const deadline = Date.now() + Math.max(share, 5_000);
    results.push(await runOne(db, opts, loc, kind, deadline, settings));
  }
  return results;
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
        error: `GHL_TOKEN_${loc.key} is not set`,
      })
      .returning({ id: syncRuns.id });
    return { locationKey: loc.key, status: "skipped", runId: run.id, error: `GHL_TOKEN_${loc.key} is not set` };
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
    const result = await syncLocation(db, client, loc, settings, { deadline, now: opts.now });
    status =
      result.failedSteps === result.totalSteps
        ? "error"
        : result.failedSteps > 0 || result.stoppedEarly || result.counts.parseErrors
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
