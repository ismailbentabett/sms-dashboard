import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { runDashboardSync } from "@/lib/sync/service";

export const maxDuration = 300;

const bodySchema = z.object({
  locationKeys: z.array(z.string().min(1).max(8)).optional(),
  backfillFrom: z.iso.date().optional(),
  forceDiscover: z.boolean().optional(),
});

/**
 * Sync-on-open, "Sync now" and "Backfill from date". Session-protected by
 * the proxy; the same-origin check stops cross-site posts riding the cookie.
 */
export async function POST(request: NextRequest) {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if ((site && site !== "same-origin") || (origin && new URL(origin).host !== request.nextUrl.host)) {
    return NextResponse.json({ error: "cross-site request refused" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }
  const { locationKeys, backfillFrom, forceDiscover } = parsed.data;
  const result = await runDashboardSync(getDb(), {
    locationKeys,
    forceDiscover,
    backfillFrom: backfillFrom ? new Date(`${backfillFrom}T00:00:00Z`) : undefined,
  });
  return NextResponse.json(result);
}
