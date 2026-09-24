import { sql } from "drizzle-orm";
import { LOCATION_SEEDS } from "@/lib/config/locations";
import { locations } from "./schema";
import type { DB } from "./types";

/** Insert or refresh the 4 locations. Safe to run repeatedly. */
export async function seedLocations(db: DB) {
  await db
    .insert(locations)
    .values(LOCATION_SEEDS.map((l) => ({ key: l.key, name: l.name, ghlLocationId: l.ghlLocationId })))
    .onConflictDoUpdate({
      target: locations.key,
      set: { name: sql`excluded.name`, ghlLocationId: sql`excluded.ghl_location_id` },
    });
}
