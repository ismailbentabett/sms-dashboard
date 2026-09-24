"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import { locations } from "@/lib/db/schema";

/** Turn tracking of a sub-account on or off. Discovery won't override a manual choice. */
export async function setTracking(formData: FormData) {
  const key = formData.get("key");
  const active = formData.get("active") === "true";
  if (typeof key !== "string" || !key) return;
  await getDb().update(locations).set({ active, activeSetManually: true }).where(eq(locations.key, key));
  revalidatePath("/", "layout");
}
