import "server-only";
import { requireEnv } from "@/lib/env";
import type { OAuthConfig } from "./oauth";

/** OAuth settings from env, or null if the Marketplace app isn't configured yet. */
export function oauthConfigFromEnv(): OAuthConfig | null {
  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const clientSecret = process.env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // GHL client ids look like "<appId>-<suffix>"; GHL_APP_ID overrides if that ever changes.
  const appId = process.env.GHL_APP_ID?.trim() || clientId.split("-")[0];
  return { clientId, clientSecret, appId, encryptionSecret: requireEnv("SESSION_SECRET") };
}
