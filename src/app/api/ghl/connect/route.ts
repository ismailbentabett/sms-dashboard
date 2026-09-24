import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { authorizeUrl } from "@/lib/ghl/oauth";
import { oauthConfigFromEnv } from "@/lib/ghl/oauth-config";

const STATE_COOKIE = "ghl_oauth_state";

/** Start the agency install: redirect to GHL's "choose location" page. */
export async function GET(request: NextRequest) {
  const cfg = oauthConfigFromEnv();
  if (!cfg) {
    return NextResponse.redirect(new URL("/sync?ghl_error=Set+GHL_CLIENT_ID+and+GHL_CLIENT_SECRET+first", request.url));
  }
  const state = randomBytes(24).toString("base64url");
  const redirectUri = new URL("/api/ghl/callback", request.url).toString();
  const res = NextResponse.redirect(authorizeUrl(cfg, redirectUri, state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/ghl",
    maxAge: 15 * 60,
  });
  return res;
}
