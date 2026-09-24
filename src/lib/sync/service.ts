import "server-only";
import type { DB } from "@/lib/db/types";
import { getConnection } from "@/lib/ghl/oauth";
import { oauthConfigFromEnv } from "@/lib/ghl/oauth-config";
import { oauthClientFactory } from "./clients";
import { discoverLocations, type DiscoveryResult } from "./discover";
import { requestBackfill, runSync, type LocationRunSummary } from "./run";

export interface DashboardSyncResult {
  results: LocationRunSummary[];
  discovery: DiscoveryResult | null;
  /** Set when GHL isn't configured/connected or discovery failed. */
  problem: string | null;
}

/** Discover sub-accounts from the agency connection, then sync the tracked ones. */
export async function runDashboardSync(
  db: DB,
  opts: { locationKeys?: string[]; backfillFrom?: Date; forceDiscover?: boolean; budgetMs?: number } = {},
): Promise<DashboardSyncResult> {
  const cfg = oauthConfigFromEnv();
  if (!cfg) {
    return { results: [], discovery: null, problem: "GHL app not configured: set GHL_CLIENT_ID and GHL_CLIENT_SECRET." };
  }
  if (!(await getConnection(db))) {
    return { results: [], discovery: null, problem: "GHL is not connected. Click “Connect GHL agency” on the Sync page." };
  }

  const clientFor = oauthClientFactory(db, cfg);
  let discovery: DiscoveryResult | null = null;
  let problem: string | null = null;
  try {
    discovery = await discoverLocations(db, cfg, clientFor, { force: opts.forceDiscover });
  } catch (err) {
    problem = `Couldn't refresh the sub-account list: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (opts.backfillFrom) await requestBackfill(db, opts.backfillFrom, opts.locationKeys);
  const results = await runSync({
    db,
    clientFor,
    kind: opts.backfillFrom ? "backfill" : "incremental",
    locationKeys: opts.locationKeys,
    budgetMs: opts.budgetMs,
  });
  return { results, discovery, problem };
}
