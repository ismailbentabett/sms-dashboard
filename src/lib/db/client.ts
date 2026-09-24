import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireEnv } from "@/lib/env";
import * as schema from "./schema";
import type { DB } from "./types";

const globalForDb = globalThis as unknown as { __smsPool?: Pool; __smsDb?: DB };

/** Shared node-postgres pool. Use Neon's pooled (-pooler) connection string. */
export function getDb(): DB {
  if (globalForDb.__smsDb) return globalForDb.__smsDb;
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL"), max: 5, idleTimeoutMillis: 10_000 });
  attachDatabasePool(pool);
  globalForDb.__smsPool = pool;
  globalForDb.__smsDb = drizzle(pool, { schema });
  return globalForDb.__smsDb;
}
