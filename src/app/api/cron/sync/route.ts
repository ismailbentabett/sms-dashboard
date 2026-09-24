import { NextResponse, type NextRequest } from "next/server";
import { secretsMatch } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { requireEnv } from "@/lib/env";
import { clientFromEnv } from "@/lib/sync/clients";
import { runSync } from "@/lib/sync/run";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Incremental sync of all locations. Called by Vercel Cron (daily on Hobby)
 * and by the GitHub Actions schedule every 5 minutes, both sending
 * `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!(await secretsMatch(token, requireEnv("CRON_SECRET")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const results = await runSync({ db: getDb(), clientFor: clientFromEnv, kind: "incremental" });
  const failed = results.filter((r) => r.status === "error");
  return NextResponse.json({ ok: failed.length === 0, results }, { status: failed.length ? 500 : 200 });
}
