import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { exchangeCode } from "@/lib/ghl/oauth";
import { oauthConfigFromEnv } from "@/lib/ghl/oauth-config";
import { oauthClientFactory } from "@/lib/sync/clients";
import { discoverLocations } from "@/lib/sync/discover";

export const maxDuration = 60;

const STATE_COOKIE = "ghl_oauth_state";

function back(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/sync", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.delete({ name: STATE_COOKIE, path: "/api/ghl" });
  return res;
}

/** GHL redirects here after the agency admin installs the app. */
export async function GET(request: NextRequest) {
  const cfg = oauthConfigFromEnv();
  if (!cfg) return back(request, { ghl_error: "GHL app not configured" });

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expected = request.cookies.get(STATE_COOKIE)?.value;
  // The install must start from our Connect button (which sets the cookie). If GHL echoes `state`, it must match.
  if (!expected || (state && state !== expected)) {
    return back(request, { ghl_error: "Start the connection from the Connect button on this page, then try again" });
  }
  if (!code) return back(request, { ghl_error: request.nextUrl.searchParams.get("error") ?? "No code from GHL" });

  const db = getDb();
  try {
    await exchangeCode(db, cfg, code, new URL("/api/ghl/callback", request.url).toString());
  } catch (err) {
    return back(request, { ghl_error: err instanceof Error ? err.message : "Connecting GHL failed" });
  }
  try {
    const found = await discoverLocations(db, cfg, oauthClientFactory(db, cfg), { force: true });
    return back(request, { connected: String(found.added.length) });
  } catch (err) {
    return back(request, { connected: "0", ghl_error: `Connected, but listing sub-accounts failed: ${err instanceof Error ? err.message : err}` });
  }
}
