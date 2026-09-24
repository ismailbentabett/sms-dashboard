import "server-only";
import { isLocationKey } from "@/lib/config/locations";
import { ghlToken } from "@/lib/env";
import { GhlClient } from "@/lib/ghl/client";

/** Build a GHL client for a location from its GHL_TOKEN_<KEY> env var. */
export function clientFromEnv(loc: { key: string; ghlLocationId: string }): GhlClient | null {
  if (!isLocationKey(loc.key)) return null;
  const token = ghlToken(loc.key);
  return token ? new GhlClient({ token, locationId: loc.ghlLocationId }) : null;
}
