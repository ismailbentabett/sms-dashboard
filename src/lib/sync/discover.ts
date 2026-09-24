import { and, eq, notInArray } from "drizzle-orm";
import { PIPELINE_NAME } from "@/lib/config/locations";
import { ghlConnection, locations } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import type { GhlClient } from "@/lib/ghl/client";
import { getPipelines } from "@/lib/ghl/endpoints";
import { getConnection, listInstalledLocations, type OAuthConfig } from "@/lib/ghl/oauth";
import { normalizeStageName } from "./mappers";

/** Re-list installed sub-accounts at most this often (unless forced). */
const DISCOVERY_EVERY_MS = 10 * 60 * 1000;

/**
 * Short UI label for a sub-account: the letter from a "A: …" style name if
 * it's free, otherwise the next unused letter (A–Z, then L27, L28, …).
 */
export function assignKey(name: string, taken: Set<string>): string {
  const m = /^\s*([A-Za-z])\s*[:\-.)]/.exec(name);
  if (m && !taken.has(m[1].toUpperCase())) return m[1].toUpperCase();
  for (let c = 65; c <= 90; c++) {
    const k = String.fromCharCode(c);
    if (!taken.has(k)) return k;
  }
  for (let n = 27; ; n++) if (!taken.has(`L${n}`)) return `L${n}`;
}

export interface DiscoveryResult {
  added: string[];
  removed: string[];
  skipped: boolean;
}

/**
 * Sync the `locations` table with the sub-accounts the app is installed on.
 * New sub-accounts are tracked if they have the outreach pipeline; ones the
 * app was removed from are marked not installed. Manual on/off choices win.
 */
export async function discoverLocations(
  db: DB,
  cfg: OAuthConfig,
  clientFor: (loc: { key: string; ghlLocationId: string }) => GhlClient,
  opts: { force?: boolean; now?: () => Date } = {},
): Promise<DiscoveryResult> {
  const now = opts.now?.() ?? new Date();
  const conn = await getConnection(db);
  if (!conn) return { added: [], removed: [], skipped: true };
  if (
    !opts.force &&
    conn.locationsDiscoveredAt &&
    now.getTime() - conn.locationsDiscoveredAt.getTime() < DISCOVERY_EVERY_MS
  ) {
    return { added: [], removed: [], skipped: true };
  }

  let installed: { id: string; name: string | null }[];
  try {
    installed = await listInstalledLocations(db, cfg);
  } catch (err) {
    // Fall back to the sub-accounts approved at install time.
    if (!conn.approvedLocations?.length) throw err;
    installed = conn.approvedLocations.map((id) => ({ id, name: null }));
  }

  const existing = await db.select().from(locations);
  const byGhlId = new Map(existing.map((l) => [l.ghlLocationId, l]));
  const taken = new Set(existing.map((l) => l.key));
  const wantedPipeline = normalizeStageName(PIPELINE_NAME);
  const added: string[] = [];

  for (const inst of installed) {
    const prev = byGhlId.get(inst.id);
    if (prev) {
      await db
        .update(locations)
        .set({ name: inst.name ?? prev.name, installed: true })
        .where(eq(locations.ghlLocationId, inst.id));
      continue;
    }
    const name = inst.name ?? inst.id;
    const key = assignKey(name, taken);
    taken.add(key);
    // Track it only if it runs the outreach pipeline; other agency sub-accounts are listed but ignored.
    let hasPipeline = false;
    try {
      const { pipelines } = await getPipelines(clientFor({ key, ghlLocationId: inst.id }));
      hasPipeline = pipelines.some((p) => normalizeStageName(p.name) === wantedPipeline);
    } catch {
      hasPipeline = false;
    }
    await db.insert(locations).values({ key, name, ghlLocationId: inst.id, active: hasPipeline, installed: true });
    added.push(key);
  }

  // An empty list is more likely a GHL hiccup than an uninstall everywhere; don't act on it.
  const installedIds = installed.map((i) => i.id);
  const removedRows = installedIds.length
    ? await db
        .update(locations)
        .set({ installed: false })
        .where(and(eq(locations.installed, true), notInArray(locations.ghlLocationId, installedIds)))
        .returning({ key: locations.key })
    : [];

  await db.update(ghlConnection).set({ locationsDiscoveredAt: now }).where(eq(ghlConnection.id, conn.id));
  return { added, removed: removedRows.map((r) => r.key), skipped: false };
}
