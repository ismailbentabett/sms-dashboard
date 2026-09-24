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
import { runDashboardSync } from "@/lib/sync/service";

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
  let backfillFrom: Date | undefined;
  if (values.backfill) {
    backfillFrom = new Date(`${values.backfill}T00:00:00Z`);
    if (Number.isNaN(backfillFrom.getTime())) throw new Error("--backfill must be YYYY-MM-DD");
  }
  const { results, problem } = await runDashboardSync(db, {
    locationKeys,
    backfillFrom,
    forceDiscover: true,
    budgetMs: values.budget ? Number(values.budget) * 1000 : undefined,
  });
  if (problem) console.warn(problem);
  console.table(results.map((r) => ({ location: r.locationKey, status: r.status, run: r.runId, error: r.error?.split("\n")[0] ?? "" })));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
