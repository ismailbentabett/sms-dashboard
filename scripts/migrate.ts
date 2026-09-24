/** Apply migrations and seed the 4 locations. Usage: npm run db:migrate */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "@/lib/db/schema";
import { seedLocations } from "@/lib/db/seed";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedLocations(db);
  await pool.end();
  console.log("Migrations applied and locations seeded.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
