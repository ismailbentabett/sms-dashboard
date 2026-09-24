import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "@/lib/config/settings";
import { settings } from "./schema";
import type { DB } from "./types";

/** Stored settings merged over defaults. Invalid stored values fall back to the default for that key. */
export async function getSettings(db: DB): Promise<Settings> {
  const rows = await db.select().from(settings);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const shape = settingsSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>;
    const field = shape[row.key];
    if (!field) continue;
    const parsed = field.safeParse(row.value);
    if (parsed.success) merged[row.key] = parsed.data;
  }
  return settingsSchema.parse(merged);
}
