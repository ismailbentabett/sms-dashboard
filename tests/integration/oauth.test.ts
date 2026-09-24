import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { decryptSecret } from "@/lib/crypto";
import { ghlConnection, ghlLocationTokens, locations } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { GhlClient } from "@/lib/ghl/client";
import {
  authorizeUrl,
  exchangeCode,
  getCompanyToken,
  GhlAuthError,
  listInstalledLocations,
  locationTokenProvider,
  type OAuthConfig,
} from "@/lib/ghl/oauth";
import { RateLimiter } from "@/lib/ghl/rate-limiter";
import { discoverLocations } from "@/lib/sync/discover";
import { fakeClock } from "../helpers/fake-clock";
import { createTestDb } from "../helpers/test-db";

const SECRET = "k".repeat(40);
let db: DB;
let close: () => Promise<void>;
let clock: Date;

/** Minimal fake of GHL's OAuth endpoints plus pipelines, recording every call. */
function fakeOAuthGhl() {
  const calls: { method: string; path: string; form: Record<string, string>; query: Record<string, string>; auth: string | null }[] = [];
  let refreshCount = 0;
  let mintCount = 0;
  const state = {
    installed: [
      { _id: "LOC_A", name: "A: Website + Normal SMS" },
      { _id: "LOC_B", name: "B: Website + Loom SMS" },
      { _id: "LOC_X", name: "Some other client" },
    ],
    validRefresh: "refresh-0",
    companyAccess: "company-access-0",
    rejectCompanyTokenOnce: false,
  };

  const fetchImpl = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const form = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ method: init?.method ?? "GET", path: url.pathname, form, query: Object.fromEntries(url.searchParams), auth: headers.Authorization ?? null });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

    if (url.pathname === "/oauth/token") {
      if (form.grant_type === "authorization_code") {
        if (form.code !== "good-code") return json({ error: "invalid_grant" }, 400);
        return json({
          access_token: state.companyAccess,
          refresh_token: state.validRefresh,
          expires_in: 86399,
          userType: "Company",
          companyId: "COMPANY_1",
          approvedLocations: ["LOC_A", "LOC_B", "LOC_X"],
          scope: "oauth.write oauth.readonly",
        });
      }
      if (form.grant_type === "refresh_token") {
        if (form.refresh_token !== state.validRefresh) return json({ error: "invalid_grant" }, 401);
        refreshCount++;
        state.validRefresh = `refresh-${refreshCount}`;
        state.companyAccess = `company-access-${refreshCount}`;
        return json({ access_token: state.companyAccess, refresh_token: state.validRefresh, expires_in: 86399, companyId: "COMPANY_1" });
      }
    }
    const bearer = headers.Authorization?.replace("Bearer ", "");
    if (url.pathname === "/oauth/locationToken") {
      if (state.rejectCompanyTokenOnce) {
        state.rejectCompanyTokenOnce = false;
        return json({ message: "expired" }, 401);
      }
      if (bearer !== state.companyAccess) return json({ message: "bad token" }, 401);
      mintCount++;
      return json({ access_token: `loc-${form.locationId}-${mintCount}`, expires_in: 86399, locationId: form.locationId });
    }
    if (url.pathname === "/oauth/installedLocations") {
      const skip = Number(url.searchParams.get("skip"));
      const limit = Number(url.searchParams.get("limit"));
      return json({ locations: state.installed.slice(skip, skip + limit), count: state.installed.length });
    }
    if (url.pathname === "/opportunities/pipelines") {
      const loc = url.searchParams.get("locationId");
      const name = loc === "LOC_X" ? "Some Other Pipeline" : "SMS Outreach - Remodelers - FB Ads";
      return json({ pipelines: [{ id: `p-${loc}`, name, stages: [] }] });
    }
    if (url.pathname === "/probe") {
      return bearer?.endsWith("-1") ? json({ ok: false }, 401) : json({ ok: true });
    }
    return json({ message: "unexpected " + url.pathname }, 404);
  };

  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    calls,
    state,
    counts: () => ({ refreshCount, mintCount }),
  };
}

let ghl: ReturnType<typeof fakeOAuthGhl>;
let cfg: OAuthConfig;

function clientFor(loc: { ghlLocationId: string }) {
  const c = fakeClock();
  return new GhlClient({
    token: locationTokenProvider(db, cfg, loc.ghlLocationId),
    locationId: loc.ghlLocationId,
    fetchImpl: ghl.fetchImpl,
    clock: c,
    limiter: new RateLimiter({ clock: c }),
  });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ghl = fakeOAuthGhl();
  clock = new Date("2026-09-24T12:00:00.000Z");
  cfg = {
    clientId: "APPID123-abc",
    clientSecret: "shh",
    appId: "APPID123",
    encryptionSecret: SECRET,
    fetchImpl: ghl.fetchImpl,
    now: () => clock,
  };
});
afterEach(async () => {
  await close();
});

describe("agency OAuth", () => {
  it("builds the chooselocation URL with all read scopes and state", () => {
    const url = new URL(authorizeUrl(cfg, "https://app.example.com/api/ghl/callback", "st4te"));
    expect(url.origin + url.pathname).toBe("https://marketplace.gohighlevel.com/v2/oauth/chooselocation");
    expect(url.searchParams.get("client_id")).toBe("APPID123-abc");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["oauth.write", "oauth.readonly", "opportunities.readonly"]),
    );
  });

  it("exchanges the code as a Company token and stores it encrypted", async () => {
    await exchangeCode(db, cfg, "good-code", "https://app.example.com/api/ghl/callback");
    const tokenCall = ghl.calls.find((c) => c.path === "/oauth/token");
    expect(tokenCall?.form).toMatchObject({ grant_type: "authorization_code", user_type: "Company", client_id: "APPID123-abc" });

    const [row] = await db.select().from(ghlConnection);
    expect(row.companyId).toBe("COMPANY_1");
    expect(row.accessTokenEnc).not.toContain("company-access");
    expect(decryptSecret(row.refreshTokenEnc, SECRET)).toBe("refresh-0");
    expect(row.approvedLocations).toEqual(["LOC_A", "LOC_B", "LOC_X"]);
  });

  it("rejects a bad code", async () => {
    await expect(exchangeCode(db, cfg, "bad", "https://x/cb")).rejects.toBeInstanceOf(GhlAuthError);
  });

  it("refreshes the Company token near expiry and stores the rotated refresh token", async () => {
    await exchangeCode(db, cfg, "good-code", "https://x/cb");
    expect((await getCompanyToken(db, cfg)).token).toBe("company-access-0");
    expect(ghl.counts().refreshCount).toBe(0);

    clock = new Date(clock.getTime() + 24 * 3600 * 1000);
    expect((await getCompanyToken(db, cfg)).token).toBe("company-access-1");
    clock = new Date(clock.getTime() + 24 * 3600 * 1000);
    expect((await getCompanyToken(db, cfg)).token).toBe("company-access-2");
    const [row] = await db.select().from(ghlConnection);
    expect(decryptSecret(row.refreshTokenEnc, SECRET)).toBe("refresh-2");
  });

  it("records a failed refresh so the UI can ask for a reconnect", async () => {
    await exchangeCode(db, cfg, "good-code", "https://x/cb");
    ghl.state.validRefresh = "something-else";
    clock = new Date(clock.getTime() + 24 * 3600 * 1000);
    await expect(getCompanyToken(db, cfg)).rejects.toThrow(/Reconnect/);
    const [row] = await db.select().from(ghlConnection);
    expect(row.lastError).toMatch(/refresh failed/);
  });

  it("mints, caches and re-mints Location tokens", async () => {
    await exchangeCode(db, cfg, "good-code", "https://x/cb");
    const provider = locationTokenProvider(db, cfg, "LOC_A");
    expect(await provider.get()).toBe("loc-LOC_A-1");
    expect(await provider.get()).toBe("loc-LOC_A-1");
    // A second provider (e.g. another request) reuses the DB cache.
    expect(await locationTokenProvider(db, cfg, "LOC_A").get()).toBe("loc-LOC_A-1");
    expect(ghl.counts().mintCount).toBe(1);

    const mint = ghl.calls.find((c) => c.path === "/oauth/locationToken");
    expect(mint?.form).toEqual({ companyId: "COMPANY_1", locationId: "LOC_A" });

    await provider.invalidate();
    expect(await provider.get()).toBe("loc-LOC_A-2");
    expect(await db.select().from(ghlLocationTokens)).toHaveLength(1);
  });

  it("refreshes the Company token when minting gets a 401", async () => {
    await exchangeCode(db, cfg, "good-code", "https://x/cb");
    ghl.state.rejectCompanyTokenOnce = true;
    expect(await locationTokenProvider(db, cfg, "LOC_B").get()).toBe("loc-LOC_B-1");
    expect(ghl.counts().refreshCount).toBe(1);
  });

  it("GhlClient swaps in a fresh Location token after a 401", async () => {
    await exchangeCode(db, cfg, "good-code", "https://x/cb");
    const client = clientFor({ ghlLocationId: "LOC_A" });
    // The fake rejects tokens ending in "-1" (the first minted one).
    await expect(client.get("/probe", {}, "v", z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
    expect(ghl.counts().mintCount).toBe(2);
  });

  it("lists installed sub-accounts with companyId + appId, across pages", async () => {
    await exchangeCode(db, cfg, "good-code", "https://x/cb");
    ghl.state.installed = Array.from({ length: 150 }, (_, i) => ({ _id: `L${i}`, name: `Loc ${i}` }));
    const locs = await listInstalledLocations(db, cfg);
    expect(locs).toHaveLength(150);
    const call = ghl.calls.find((c) => c.path === "/oauth/installedLocations");
    expect(call?.query).toMatchObject({ companyId: "COMPANY_1", appId: "APPID123", isInstalled: "true" });
  });

  it("throws a clear error when not connected", async () => {
    await expect(getCompanyToken(db, cfg)).rejects.toThrow(/not connected/);
  });
});

describe("location discovery", () => {
  beforeEach(async () => {
    await exchangeCode(db, cfg, "good-code", "https://x/cb");
  });

  it("adds new sub-accounts, keys them from their names and tracks only those with the pipeline", async () => {
    const res = await discoverLocations(db, cfg, clientFor, { force: true, now: () => clock });
    expect(res.added.sort()).toEqual(["A", "B", "C"]);
    const rows = await db.select().from(locations).orderBy(locations.key);
    expect(rows.map((r) => [r.key, r.ghlLocationId, r.active])).toEqual([
      ["A", "LOC_A", true],
      ["B", "LOC_B", true],
      ["C", "LOC_X", false],
    ]);
  });

  it("is throttled unless forced", async () => {
    await discoverLocations(db, cfg, clientFor, { force: true, now: () => clock });
    const again = await discoverLocations(db, cfg, clientFor, { now: () => clock });
    expect(again.skipped).toBe(true);
  });

  it("marks uninstalled sub-accounts and picks up newly installed ones", async () => {
    await discoverLocations(db, cfg, clientFor, { force: true, now: () => clock });
    ghl.state.installed = [
      { _id: "LOC_A", name: "A: Website + Normal SMS" },
      { _id: "LOC_E", name: "E: New split test" },
    ];
    const res = await discoverLocations(db, cfg, clientFor, { force: true, now: () => clock });
    expect(res.added).toEqual(["E"]);
    expect(res.removed.sort()).toEqual(["B", "C"]);
    const [b] = await db.select().from(locations).where(eq(locations.key, "B"));
    expect(b.installed).toBe(false);
  });

  it("ignores an empty install list instead of uninstalling everything", async () => {
    await discoverLocations(db, cfg, clientFor, { force: true, now: () => clock });
    ghl.state.installed = [];
    const res = await discoverLocations(db, cfg, clientFor, { force: true, now: () => clock });
    expect(res.removed).toEqual([]);
    expect((await db.select().from(locations)).every((l) => l.installed)).toBe(true);
  });

  it("keeps a manual tracking choice", async () => {
    await discoverLocations(db, cfg, clientFor, { force: true, now: () => clock });
    await db.update(locations).set({ active: false, activeSetManually: true }).where(eq(locations.key, "A"));
    await discoverLocations(db, cfg, clientFor, { force: true, now: () => clock });
    const [a] = await db.select().from(locations).where(eq(locations.key, "A"));
    expect(a.active).toBe(false);
  });
});
