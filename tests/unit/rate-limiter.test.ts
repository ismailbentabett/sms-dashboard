import { describe, expect, it } from "vitest";
import { backoffDelay, RateLimiter } from "@/lib/ghl/rate-limiter";
import { fakeClock } from "../helpers/fake-clock";

describe("RateLimiter", () => {
  it("allows a full burst, then waits for the window to slide", async () => {
    const clock = fakeClock();
    const bucket = new RateLimiter({ capacity: 10, intervalMs: 10_000, clock });
    for (let i = 0; i < 10; i++) await bucket.acquire();
    expect(clock.sleeps).toEqual([]);
    await bucket.acquire();
    expect(clock.t()).toBe(10_000);
  });

  it("never exceeds capacity within any interval", async () => {
    const clock = fakeClock();
    const bucket = new RateLimiter({ capacity: 90, intervalMs: 10_000, clock });
    const stamps: number[] = [];
    for (let i = 0; i < 300; i++) {
      await bucket.acquire();
      stamps.push(clock.t());
    }
    for (let i = 0; i < stamps.length; i++) {
      const inWindow = stamps.filter((s) => s >= stamps[i] && s < stamps[i] + 10_000).length;
      expect(inWindow).toBeLessThanOrEqual(90);
    }
  });

  it("pauses when headers say the burst window is nearly used", async () => {
    const clock = fakeClock();
    const bucket = new RateLimiter({ capacity: 90, clock });
    const h = new Headers({
      "x-ratelimit-remaining": "2",
      "x-ratelimit-interval-milliseconds": "10000",
      "x-ratelimit-daily-remaining": "150000",
    });
    expect(bucket.observeHeaders(h)).toEqual({ dailyRemaining: 150000 });
    await bucket.acquire();
    expect(clock.t()).toBeGreaterThanOrEqual(10_000);
  });

  it("ignores missing headers", () => {
    const bucket = new RateLimiter({ clock: fakeClock() });
    expect(bucket.observeHeaders(new Headers())).toEqual({ dailyRemaining: null });
  });
});

describe("backoffDelay", () => {
  it("grows exponentially with jitter and caps", () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 1)).toBe(8000);
    expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
  });
});
