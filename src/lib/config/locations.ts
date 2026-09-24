/**
 * The 4 GHL sub-accounts. This is the seed for the `locations` table;
 * components read locations from the database, not from here.
 */
export const LOCATION_KEYS = ["A", "B", "C", "D"] as const;
export type LocationKey = (typeof LOCATION_KEYS)[number];

export interface LocationSeed {
  key: LocationKey;
  name: string;
  ghlLocationId: string;
  tokenEnv: `GHL_TOKEN_${LocationKey}`;
}

export const LOCATION_SEEDS: readonly LocationSeed[] = [
  { key: "A", name: "A: Website + Normal SMS", ghlLocationId: "U8cEIiAwrnS7QEzMyRNj", tokenEnv: "GHL_TOKEN_A" },
  { key: "B", name: "B: Website + Loom SMS", ghlLocationId: "uciXzsgWKcwnEOhYxVe3", tokenEnv: "GHL_TOKEN_B" },
  { key: "C", name: "C: Lead + Normal SMS", ghlLocationId: "adOazVo5iRrj2qDc2z1N", tokenEnv: "GHL_TOKEN_C" },
  { key: "D", name: "D: Lead + Loom SMS", ghlLocationId: "cR5FxMwT2HvGbqylJBfs", tokenEnv: "GHL_TOKEN_D" },
];

export const PIPELINE_NAME = "SMS Outreach - Remodelers - FB Ads";

export function isLocationKey(v: unknown): v is LocationKey {
  return typeof v === "string" && (LOCATION_KEYS as readonly string[]).includes(v);
}
