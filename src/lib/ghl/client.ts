import type { z } from "zod";
import { backoffDelay, realClock, RateLimiter, type Clock } from "./rate-limiter";

export const GHL_BASE_URL = "https://services.leadconnectorhq.com";

/** API versions per endpoint family, from the GHL OpenAPI specs. */
export const GHL_VERSION = {
  conversations: "2021-04-15",
  default: "2021-07-28",
} as const;

/**
 * This app never writes to GHL. POST is only allowed for search endpoints
 * that GHL implements as POST-for-read.
 */
const POST_READ_ALLOWLIST = new Set(["/contacts/search"]);

/** Stop a run early when the daily budget gets this low, so the UI and webhooks keep working. */
const DAILY_FLOOR = 2_000;

export class GhlError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly path: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "GhlError";
  }
}

export class GhlDailyLimitError extends GhlError {
  constructor(path: string, remaining: number) {
    super(`GHL daily rate limit nearly exhausted (${remaining} left)`, 429, path);
    this.name = "GhlDailyLimitError";
  }
}

export interface GhlClientStats {
  requests: number;
  rateLimitHits: number;
  retries: number;
  dailyRemaining: number | null;
}

export interface GhlClientOptions {
  token: string;
  locationId: string;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  limiter?: RateLimiter;
  maxRetries?: number;
  timeoutMs?: number;
  random?: () => number;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export class GhlClient {
  readonly locationId: string;
  readonly stats: GhlClientStats = { requests: 0, rateLimitHits: 0, retries: 0, dailyRemaining: null };
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly random: () => number;

  constructor(opts: GhlClientOptions) {
    this.token = opts.token;
    this.locationId = opts.locationId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? realClock;
    this.limiter = opts.limiter ?? limiterFor(opts.locationId, this.clock);
    this.maxRetries = opts.maxRetries ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.random = opts.random ?? Math.random;
  }

  /** True once GHL reports the daily budget is nearly used up; callers should stop paging. */
  get dailyBudgetLow(): boolean {
    return this.stats.dailyRemaining !== null && this.stats.dailyRemaining < DAILY_FLOOR;
  }

  get<S extends z.ZodType>(path: string, query: Query, version: string, schema: S): Promise<z.infer<S>> {
    return this.request("GET", path, query, undefined, version, schema);
  }

  /** POST that only reads (search endpoints). Rejects anything not on the allowlist. */
  postSearch<S extends z.ZodType>(path: string, body: unknown, version: string, schema: S): Promise<z.infer<S>> {
    if (!POST_READ_ALLOWLIST.has(path)) {
      throw new GhlError(`Refusing POST to ${path}: this app is read-only`, null, path);
    }
    return this.request("POST", path, {}, body, version, schema);
  }

  private async request<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    query: Query,
    body: unknown,
    version: string,
    schema: S,
  ): Promise<z.infer<S>> {
    const url = new URL(GHL_BASE_URL + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      this.stats.requests++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Version: version,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
          cache: "no-store",
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          this.stats.retries++;
          await this.clock.sleep(backoffDelay(attempt, 1_000, 30_000, this.random));
          continue;
        }
        throw new GhlError(`Network error calling ${path}: ${String(err)}`, null, path);
      }

      const { dailyRemaining } = this.limiter.observeHeaders(res.headers);
      if (dailyRemaining !== null) this.stats.dailyRemaining = dailyRemaining;

      if (res.status === 429) {
        this.stats.rateLimitHits++;
        if (dailyRemaining !== null && dailyRemaining <= 0) throw new GhlDailyLimitError(path, dailyRemaining);
        if (attempt >= this.maxRetries) throw new GhlError(`Rate limited on ${path} after retries`, 429, path);
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000
          : backoffDelay(attempt, 2_000, 30_000, this.random);
        this.limiter.pause(wait);
        this.stats.retries++;
        continue;
      }

      if (res.status >= 500 && attempt < this.maxRetries) {
        this.stats.retries++;
        await this.clock.sleep(backoffDelay(attempt, 1_000, 30_000, this.random));
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new GhlError(`GHL ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status, path, text);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new GhlError(`GHL ${path} returned non-JSON`, res.status, path, text.slice(0, 300));
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new GhlError(
          `GHL ${path} response failed validation: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          res.status,
          path,
        );
      }
      return parsed.data;
    }
  }
}

/** One limiter per location per process, shared by every client for that location. */
const limiters = new Map<string, RateLimiter>();
function limiterFor(locationId: string, clock: Clock): RateLimiter {
  let l = limiters.get(locationId);
  if (!l) {
    l = new RateLimiter({ clock });
    limiters.set(locationId, l);
  }
  return l;
}
