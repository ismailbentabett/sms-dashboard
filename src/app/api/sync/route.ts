import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { LOCATION_KEYS } from "@/lib/config/locations";
import { getDb } from "@/lib/db/client";
import { clientFromEnv } from "@/lib/sync/clients";
import { requestBackfill, runSync } from "@/lib/sync/run";

export const maxDuration = 300;

const bodySchema = z.object({
  locationKeys: z.array(z.enum(LOCATION_KEYS)).optional(),
  backfillFrom: z.iso.date().optional(),
});

/**
 * Manual "Sync now" / "Backfill from date". Session-protected by the proxy;
 * the same-origin check stops cross-site form posts riding the cookie.
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
  const db = getDb();
  const { locationKeys, backfillFrom } = parsed.data;
  if (backfillFrom) await requestBackfill(db, new Date(`${backfillFrom}T00:00:00Z`), locationKeys);
  const results = await runSync({
    db,
    clientFor: clientFromEnv,
    kind: backfillFrom ? "backfill" : "incremental",
    locationKeys,
  });
  return NextResponse.json({ results });
}
