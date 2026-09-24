import { z } from "zod";

export const nicheSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("tag_prefix"), prefix: z.string().min(1) }),
  z.object({ type: z.literal("custom_field"), fieldId: z.string().min(1) }),
]);
export type NicheSource = z.infer<typeof nicheSourceSchema>;

export const settingsSchema = z.object({
  price_per_client: z.number().nonnegative(),
  display_timezone: z.string().min(1),
  sample_target: z.number().int().positive(),
  min_sample: z.number().int().positive(),
  health_delivery_healthy: z.number(),
  health_delivery_warning: z.number(),
  health_optout_healthy: z.number(),
  health_optout_warning: z.number(),
  niche_source: nicheSourceSchema,
  /** How far back the first sync of a location reaches, in days. */
  initial_sync_days: z.number().int().positive(),
  /** Base URL of the GHL web app, for conversation links (white-label domains differ). */
  ghl_app_base_url: z.string().url(),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  price_per_client: 97,
  display_timezone: "America/New_York",
  sample_target: 250,
  min_sample: 100,
  health_delivery_healthy: 0.9,
  health_delivery_warning: 0.85,
  health_optout_healthy: 0.02,
  health_optout_warning: 0.03,
  niche_source: { type: "none" },
  initial_sync_days: 60,
  ghl_app_base_url: "https://app.gohighlevel.com",
};
