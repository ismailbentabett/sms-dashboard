import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GhlClient, GhlError } from "@/lib/ghl/client";
import { RateLimiter } from "@/lib/ghl/rate-limiter";
import { fakeClock } from "../helpers/fake-clock";

const schema = z.object({ ok: z.boolean() });

function makeClient(responses: (() => Response)[]) {
  const clock = fakeClock();
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  });
  const client = new GhlClient({
    token: "tok",
    locationId: "loc1",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    clock,
    limiter: new RateLimiter({ clock }),
    random: () => 0.5,
  });
  return { client, fetchImpl, clock };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("GhlClient", () => {
  it("sends auth + Version headers and query params", async () => {
    const { client, fetchImpl } = makeClient([json({ ok: true })]);
    await client.get("/x", { locationId: "loc1", empty: "", skip: undefined, n: 5 }, "2021-07-28", schema);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://services.leadconnectorhq.com/x?locationId=loc1&n=5");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok", Version: "2021-07-28" });
  });

  it("retries 429 honoring Retry-After and counts the hit", async () => {
    const { client, clock } = makeClient([json({}, 429, { "retry-after": "3" }), json({ ok: true })]);
    await expect(client.get("/x", {}, "v", schema)).resolves.toEqual({ ok: true });
    expect(client.stats.rateLimitHits).toBe(1);
    expect(client.stats.requests).toBe(2);
    expect(clock.t()).toBeGreaterThanOrEqual(3000);
  });

  it("retries 5xx with backoff, then succeeds", async () => {
    const { client } = makeClient([json({}, 502), json({}, 503), json({ ok: true })]);
    await expect(client.get("/x", {}, "v", schema)).resolves.toEqual({ ok: true });
    expect(client.stats.retries).toBe(2);
  });

  it("throws on 4xx without retrying", async () => {
    const { client, fetchImpl } = makeClient([json({ message: "nope" }, 422)]);
    await expect(client.get("/x", {}, "v", schema)).rejects.toMatchObject({ status: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after max retries on repeated 429", async () => {
    const { client } = makeClient(Array.from({ length: 6 }, () => json({}, 429)));
    await expect(client.get("/x", {}, "v", schema)).rejects.toBeInstanceOf(GhlError);
    expect(client.stats.rateLimitHits).toBe(6);
  });

  it("reports validation failures with the field path", async () => {
    const { client } = makeClient([json({ ok: "yes" })]);
    await expect(client.get("/x", {}, "v", schema)).rejects.toThrow(/ok:/);
  });

  it("refuses POST to anything but allowlisted search endpoints", () => {
    const { client, fetchImpl } = makeClient([]);
    expect(() => client.postSearch("/contacts/", {}, "v", schema)).toThrow(/read-only/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("flags a low daily budget without failing the request", async () => {
    const { client } = makeClient([json({ ok: true }, 200, { "x-ratelimit-daily-remaining": "100" })]);
    await client.get("/x", {}, "v", schema);
    expect(client.dailyBudgetLow).toBe(true);
  });
});
