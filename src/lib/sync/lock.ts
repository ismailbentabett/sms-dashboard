import { sql } from "drizzle-orm";
import type { DB } from "@/lib/db/types";

/**
 * Per-location sync lock stored as a lease row in `sync_locks`.
 *
 * A row lease is used instead of pg_advisory_lock because Neon's pooled
 * connection string runs PgBouncer in transaction mode, where session-level
 * advisory locks aren't reliable. The lease expires on its own if a function
 * dies mid-run.
 */
export async function acquireLock(db: DB, locationKey: string, holder: string, leaseMs: number): Promise<boolean> {
  const until = new Date(Date.now() + leaseMs);
  const rows = await db.execute<{ location_key: string }>(sql`
    insert into sync_locks (location_key, holder, locked_until)
    values (${locationKey}, ${holder}, ${until})
    on conflict (location_key) do update
      set holder = excluded.holder, locked_until = excluded.locked_until
      where sync_locks.locked_until < now() or sync_locks.holder = excluded.holder
    returning location_key
  `);
  return rowsOf(rows).length > 0;
}

export async function releaseLock(db: DB, locationKey: string, holder: string): Promise<void> {
  await db.execute(sql`delete from sync_locks where location_key = ${locationKey} and holder = ${holder}`);
}

/** node-postgres returns { rows }, PGlite returns { rows } too; guard in case a driver returns an array. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}
