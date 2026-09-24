import "server-only";
import type { DB } from "@/lib/db/types";
import { GhlClient } from "@/lib/ghl/client";
import { locationTokenProvider, type OAuthConfig } from "@/lib/ghl/oauth";

/** GHL client for a sub-account, authenticated with a Location token minted from the agency connection. */
export function oauthClientFactory(db: DB, cfg: OAuthConfig) {
  return (loc: { ghlLocationId: string }) =>
    new GhlClient({ token: locationTokenProvider(db, cfg, loc.ghlLocationId), locationId: loc.ghlLocationId });
}
