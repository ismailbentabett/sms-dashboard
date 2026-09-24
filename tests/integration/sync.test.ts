import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contacts,
  conversations,
  locations,
  messages,
  opportunities,
  stageHistory,
  stages,
  syncCursors,
  syncRuns,
} from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { GhlClient } from "@/lib/ghl/client";
import { RateLimiter } from "@/lib/ghl/rate-limiter";
import { acquireLock } from "@/lib/sync/lock";
import { runSync } from "@/lib/sync/run";
import { fakeClock } from "../helpers/fake-clock";
import { fakeGhl } from "../helpers/fake-ghl";
import { createTestDb } from "../helpers/test-db";

let db: DB;
let close: () => Promise<void>;
let ghl: ReturnType<typeof fakeGhl>;

const NOW = new Date("2026-09-22T12:00:00.000Z");

async function seedLocations() {
  await db
    .insert(locations)
    .values([
      { key: "A", name: "A: Website + Normal SMS", ghlLocationId: "LOC_A_000000000000001" },
      { key: "B", name: "B: Website + Loom SMS", ghlLocationId: "LOC_B_000000000000002" },
      { key: "Z", name: "Unrelated client", ghlLocationId: "LOC_Z", active: false },
    ])
    .onConflictDoNothing();
}

let scope: "full" | "opportunities" = "full";

async function sync(keys?: string[]) {
  await seedLocations();
  return runSync({
    db,
    locationKeys: keys ?? ["A"],
    scope,
    now: () => NOW,
    clientFor: (loc) => {
      if (loc.key !== "A") return null;
      const clock = fakeClock();
      return new GhlClient({
        token: "test",
        locationId: loc.ghlLocationId,
        fetchImpl: ghl.fetchImpl,
        clock,
        limiter: new RateLimiter({ clock }),
      });
    },
  });
}

/** Everything the sync owns, in a stable order, for before/after comparison. */
async function snapshot() {
  return {
    locations: await db.select().from(locations).orderBy(asc(locations.key)),
    stages: await db.select().from(stages).orderBy(asc(stages.ghlStageId)),
    contacts: await db.select().from(contacts).orderBy(asc(contacts.ghlContactId)),
    conversations: await db.select().from(conversations).orderBy(asc(conversations.ghlConversationId)),
    messages: await db.select().from(messages).orderBy(asc(messages.ghlMessageId)),
    opportunities: await db.select().from(opportunities).orderBy(asc(opportunities.ghlOpportunityId)),
    stageHistory: await db.select().from(stageHistory).orderBy(asc(stageHistory.id)),
  };
}

beforeEach(async () => {
  scope = "full";
  ({ db, close } = await createTestDb());
  ghl = fakeGhl();
});
afterEach(async () => {
  await close();
});

describe("sync (fixtures)", () => {
  it("imports messages, contacts, conversations, opportunities and stages", async () => {
    const [result] = await sync();
    expect(result.status).toBe("partial"); // one invalid message in the fixture
    const snap = await snapshot();

    // SMS only, invalid record skipped, TYPE_CALL skipped.
    expect(snap.messages.map((m) => m.ghlMessageId)).toEqual(["m1", "m2", "m3", "m4", "m6"]);
    const failed = snap.messages.find((m) => m.ghlMessageId === "m3");
    expect(failed).toMatchObject({ status: "undelivered", errorCode: "30007", direction: "outbound", source: "workflow" });
    expect(snap.messages.find((m) => m.ghlMessageId === "m2")?.direction).toBe("inbound");

    expect(snap.conversations).toHaveLength(4);
    expect(snap.conversations.find((c) => c.ghlConversationId === "conv1")?.lastMessageAt?.toISOString()).toBe(
      "2026-09-20T14:05:00.000Z",
    );

    // 3 from search + ct3 fetched by id because a message referenced it.
    expect(snap.contacts.map((c) => c.ghlContactId)).toEqual(["ct1", "ct2", "ct3", "ct4"]);
    expect(snap.contacts.find((c) => c.ghlContactId === "ct2")).toMatchObject({ dnd: true, phoneLast4: "2345" });
    expect(snap.contacts.find((c) => c.ghlContactId === "ct1")?.companyName).toBe("Acme Remodeling LLC");

    // Only the target pipeline's stages, with spelling variants mapped.
    expect(snap.stages).toHaveLength(15);
    expect(snap.stages.find((s) => s.name === "Loom Sent")?.canonicalName).toBe("Loom sent");
    expect(snap.stages.find((s) => s.name === "Needs  Reply")?.canonicalName).toBe("Needs Reply");
    expect(snap.locations.find((l) => l.key === "A")?.pipelineId).toBe("pipe1");

    expect(snap.opportunities).toHaveLength(2);
    expect(snap.stageHistory).toHaveLength(2);

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.locationKey, "A"));
    expect(run.counts.parseErrors).toBe(1);
    expect(run.error).toMatch(/Skipped invalid message/);
    expect(run.requests).toBeGreaterThan(0);

    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.locationKey, "A"));
    expect(cursor.messagesUpdatedAt?.toISOString()).toBe("2026-09-21T16:00:00.000Z");
    expect(cursor.lastSyncedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("is idempotent: a second run changes nothing", async () => {
    await sync();
    const first = await snapshot();
    await sync();
    expect(await snapshot()).toEqual(first);
  });

  it("uses the cursor minus a 10 minute overlap on the next run", async () => {
    await sync();
    ghl.requests.length = 0;
    await sync();
    const exportReq = ghl.requests.find((r) => r.path === "/conversations/messages/export");
    // Deep pass already ran on the first sync, so the start is cursor − 10 min.
    expect(exportReq?.query.startDate).toBe("2026-09-21T15:50:00.000Z");
    expect(exportReq?.query).toMatchObject({ channel: "SMS", sortBy: "updatedAt", sortOrder: "asc" });
  });

  it("records a stage change once", async () => {
    await sync();
    const opp = ghl.data.opportunities.opportunities[0];
    opp.pipelineStageId = "st2";
    opp.lastStageChangeAt = "2026-09-21T09:00:00.000Z";
    await sync();
    await sync();
    const history = await db.select().from(stageHistory).where(eq(stageHistory.opportunityId, "op1")).orderBy(asc(stageHistory.changedAt));
    expect(history.map((h) => [h.fromStage, h.toStage])).toEqual([
      [null, "st0"],
      ["st0", "st2"],
    ]);
    expect(history[1].changedAt.toISOString()).toBe("2026-09-21T09:00:00.000Z");
  });

  it("drops opportunities that GHL no longer returns", async () => {
    await sync();
    ghl.data.opportunities.opportunities = ghl.data.opportunities.opportunities.filter((o) => o.id !== "op2");
    const [result] = await sync();
    expect((await db.select().from(opportunities)).map((o) => o.ghlOpportunityId)).toEqual(["op1"]);
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, result.runId!));
    expect(run.counts.opportunitiesRemoved).toBe(1);
  });

  it("keeps opportunities when GHL returns an empty pipeline (likely an API hiccup)", async () => {
    await sync();
    ghl.data.opportunities.opportunities = [];
    await sync();
    expect(await db.select().from(opportunities)).toHaveLength(2);
  });

  it("opportunities-only scope touches just pipelines and opportunities", async () => {
    scope = "opportunities";
    const [result] = await sync();
    expect(result.status).toBe("success");
    expect(new Set(ghl.requests.map((r) => r.path))).toEqual(new Set(["/opportunities/pipelines", "/opportunities/search"]));
    expect(await db.select().from(opportunities)).toHaveLength(2);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("never sends a write to GHL", async () => {
    await sync();
    const writes = ghl.requests.filter((r) => r.method !== "GET" && r.path !== "/contacts/search");
    expect(writes).toEqual([]);
  });

  it("uses camelCase params for opportunity search", async () => {
    await sync();
    const req = ghl.requests.find((r) => r.path === "/opportunities/search");
    expect(req?.query).toMatchObject({ pipelineId: "pipe1", status: "all" });
    expect(req?.query).not.toHaveProperty("location_id");
  });

  it("syncs only tracked, installed locations by default", async () => {
    await seedLocations();
    await db.update(locations).set({ installed: false }).where(eq(locations.key, "B"));
    const results = await runSync({ db, clientFor: () => null, now: () => NOW });
    expect(results.map((r) => r.locationKey)).toEqual(["A"]);
  });

  it("skips locations without a client and locations that are already syncing", async () => {
    const results = await sync(["A", "B"]);
    expect(results.find((r) => r.locationKey === "B")).toMatchObject({ status: "skipped", error: "GHL is not connected" });

    await acquireLock(db, "A", "someone-else", 60_000);
    const [again] = await sync(["A"]);
    expect(again).toMatchObject({ status: "skipped", error: "Another sync is running" });
  });

  it("records a failing step without crashing the run or marking data fresh", async () => {
    ghl.data.pipelines = { pipelines: [] };
    const [result] = await sync();
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Pipeline .* not found/);
    // A failed step must not make the data look fresh.
    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.locationKey, "A"));
    expect(cursor.lastSyncedAt).toBeNull();
    // Messages still synced even though the pipeline step failed.
    expect(await db.select().from(messages)).toHaveLength(5);
  });
});
