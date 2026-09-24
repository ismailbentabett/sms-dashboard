/**
 * Run a sync from the command line.
 *   npm run sync                         incremental, all locations
 *   npm run sync -- --loc A --loc B      only some locations
 *   npm run sync -- --backfill 2026-09-01 [--loc A]
 *   npm run sync -- --budget 900         seconds (default 240; no Vercel limit locally)
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/lib/db/schema";
import { clientFromEnv } from "@/lib/sync/clients";
import { requestBackfill, runSync } from "@/lib/sync/run";

async function main() {
  const { values } = parseArgs({
    options: {
      loc: { type: "string", multiple: true },
      backfill: { type: "string" },
      budget: { type: "string" },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema });
  const locationKeys = values.loc?.map((l) => l.toUpperCase());
  if (values.backfill) {
    const from = new Date(`${values.backfill}T00:00:00Z`);
    if (Number.isNaN(from.getTime())) throw new Error("--backfill must be YYYY-MM-DD");
    await requestBackfill(db, from, locationKeys);
  }
  const results = await runSync({
    db,
    clientFor: clientFromEnv,
    kind: values.backfill ? "backfill" : "incremental",
    locationKeys,
    budgetMs: values.budget ? Number(values.budget) * 1000 : undefined,
  });
  console.table(results.map((r) => ({ location: r.locationKey, status: r.status, run: r.runId, error: r.error?.split("\n")[0] ?? "" })));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
