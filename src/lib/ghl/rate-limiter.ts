/**
 * Rate limiter for one GHL location. GHL allows 100 requests per 10 s per
 * location; we default to 90 to leave headroom for webhook-triggered
 * re-syncs running in another function instance.
 *
 * This is a sliding-window log rather than a classic token bucket: a bucket
 * that holds 90 tokens and refills 90 per 10 s can release ~180 requests in
 * one 10 s window, which GHL would reject. The log guarantees at most
 * `capacity` requests in any `intervalMs` window.
 *
 * State is in-memory, so it only coordinates requests inside one process.
 * Cross-instance safety comes from the per-location sync lock plus reading
 * GHL's own rate-limit headers (see `observeHeaders`).
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RateLimiterOptions {
  capacity?: number;
  intervalMs?: number;
  clock?: Clock;
}

export class RateLimiter {
  readonly capacity: number;
  readonly intervalMs: number;
  /** Send times of recent requests, oldest first. */
  private sent: number[] = [];
  /** Earliest time the next request may go out (set from headers / 429s). */
  private blockedUntil = 0;
  private readonly clock: Clock;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    this.capacity = opts.capacity ?? 90;
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.clock = opts.clock ?? realClock;
  }

  /** Waits until a request slot is free, then takes it. Calls are served in order. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.take());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async take(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      if (now < this.blockedUntil) {
        await this.clock.sleep(this.blockedUntil - now);
        continue;
      }
      while (this.sent.length && this.sent[0] <= now - this.intervalMs) this.sent.shift();
      if (this.sent.length < this.capacity) {
        this.sent.push(now);
        return;
      }
      await this.clock.sleep(Math.max(this.sent[0] + this.intervalMs - now, 1));
    }
  }

  /** Pause all requests for `ms` (used after a 429 or when headers say we're nearly out). */
  pause(ms: number) {
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + ms);
  }

  /**
   * Adjust to GHL's headers. If the burst window is nearly used up, pause
   * until it resets. Returns the daily remaining count when present.
   */
  observeHeaders(headers: Headers): { dailyRemaining: number | null } {
    const num = (name: string) => {
      const v = headers.get(name);
      if (v === null || v.trim() === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const remaining = num("x-ratelimit-remaining");
    const intervalMs = num("x-ratelimit-interval-milliseconds") ?? num("x-ratelimit-interval-millis");
    if (remaining !== null && remaining <= 3) {
      this.pause(intervalMs ?? this.intervalMs);
    }
    return { dailyRemaining: num("x-ratelimit-daily-remaining") };
  }
}

/** Exponential backoff with full jitter: random in [base*2^attempt/2, base*2^attempt], capped. */
export function backoffDelay(attempt: number, baseMs = 1_000, capMs = 30_000, random = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}
