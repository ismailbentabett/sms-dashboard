import { eq } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ghlConnection, ghlLocationTokens } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { GHL_BASE_URL, GhlError, type TokenProvider } from "./client";

/**
 * Agency-level access through a private GHL Marketplace app.
 *
 * 1. The agency admin installs the app once (all sub-accounts, optionally
 *    future ones too). We exchange the code for a Company token.
 * 2. For each sub-account we mint a short-lived Location token with
 *    POST /oauth/locationToken (needs `oauth.write`). Data endpoints only
 *    accept Location tokens.
 * 3. GET /oauth/installedLocations (needs `oauth.readonly`) lists every
 *    sub-account the app is installed on, so new ones show up by themselves.
 *
 * POST /oauth/token and POST /oauth/locationToken only issue tokens; they
 * don't change anything in GHL, so the app stays read-only.
 */

export const OAUTH_SCOPES = [
  "oauth.readonly",
  "oauth.write",
  "locations.readonly",
  "locations/customFields.readonly",
  "contacts.readonly",
  "conversations.readonly",
  "conversations/message.readonly",
  "opportunities.readonly",
] as const;

const AUTHORIZE_URL = "https://marketplace.gohighlevel.com/v2/oauth/chooselocation";
const CONNECTION_ID = "agency";
/** Refresh tokens this long before they expire. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Marketplace app id (the part of the client id before the first "-", unless set explicitly). */
  appId: string;
  /** Secret used to encrypt tokens at rest (SESSION_SECRET). */
  encryptionSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class GhlAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhlAuthError";
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.string().optional(),
  userType: z.string().optional(),
  companyId: z.string().optional(),
  locationId: z.string().optional(),
  userId: z.string().optional(),
  approvedLocations: z.array(z.string()).optional(),
});

const installedLocationsSchema = z.object({
  locations: z.array(z.object({ _id: z.string(), name: z.string().nullish(), isInstalled: z.boolean().optional() })),
  count: z.number().optional(),
});

export function authorizeUrl(cfg: Pick<OAuthConfig, "clientId">, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function call(
  cfg: OAuthConfig,
  method: "GET" | "POST",
  path: string,
  opts: { form?: Record<string, string>; query?: Record<string, string>; bearer?: string; version?: string },
): Promise<{ status: number; json: unknown; text: string }> {
  const url = new URL(GHL_BASE_URL + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await (cfg.fetchImpl ?? fetch)(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(opts.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.version ? { Version: opts.version } : {}),
    },
    body: opts.form ? new URLSearchParams(opts.form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON error bodies are reported via `text`.
  }
  return { status: res.status, json, text };
}

const now = (cfg: OAuthConfig) => (cfg.now ? cfg.now() : new Date());
const expiry = (cfg: OAuthConfig, expiresIn: number) => new Date(now(cfg).getTime() + expiresIn * 1000);

/** Exchange the install code for a Company token and store the connection. */
export async function exchangeCode(db: DB, cfg: OAuthConfig, code: string, redirectUri: string) {
  const res = await call(cfg, "POST", "/oauth/token", {
    form: {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      user_type: "Company",
      redirect_uri: redirectUri,
    },
  });
  if (res.status !== 200) throw new GhlAuthError(`GHL rejected the install code (${res.status}): ${res.text.slice(0, 300)}`);
  const tok = tokenResponseSchema.parse(res.json);
  if (!tok.refresh_token || !tok.companyId) {
    throw new GhlAuthError(
      tok.locationId
        ? "GHL issued a sub-account token. Install the app at agency level (choose the agency, not a single sub-account)."
        : "GHL token response is missing companyId or refresh_token.",
    );
  }
  const row = {
    id: CONNECTION_ID,
    companyId: tok.companyId,
    accessTokenEnc: encryptSecret(tok.access_token, cfg.encryptionSecret),
    refreshTokenEnc: encryptSecret(tok.refresh_token, cfg.encryptionSecret),
    expiresAt: expiry(cfg, tok.expires_in),
    scope: tok.scope ?? null,
    userId: tok.userId ?? null,
    approvedLocations: tok.approvedLocations ?? null,
    connectedAt: now(cfg),
    locationsDiscoveredAt: null,
    lastError: null,
  };
  await db.insert(ghlConnection).values(row).onConflictDoUpdate({ target: ghlConnection.id, set: row });
  // Location tokens minted from an older connection are no longer trustworthy.
  await db.delete(ghlLocationTokens);
  return row;
}

export async function getConnection(db: DB) {
  const [row] = await db.select().from(ghlConnection).where(eq(ghlConnection.id, CONNECTION_ID));
  return row ?? null;
}

/**
 * A valid Company token, refreshing it if needed. The refresh runs under a
 * row lock because GHL rotates the refresh token on every use: two
 * concurrent refreshes would leave one of them holding a dead token.
 */
export async function getCompanyToken(db: DB, cfg: OAuthConfig, opts: { forceRefresh?: boolean } = {}) {
  const current = await getConnection(db);
  if (!current) throw new GhlAuthError("GHL is not connected. Connect the agency app on the Sync page.");
  if (!opts.forceRefresh && current.expiresAt.getTime() - EXPIRY_MARGIN_MS > now(cfg).getTime()) {
    return { token: decryptSecret(current.accessTokenEnc, cfg.encryptionSecret), companyId: current.companyId };
  }

  type RefreshOutcome = { token: string; companyId: string; failed?: undefined } | { failed: string };
  const result = await db.transaction(async (tx): Promise<RefreshOutcome> => {
    const [row] = await tx.select().from(ghlConnection).where(eq(ghlConnection.id, CONNECTION_ID)).for("update");
    if (!row) throw new GhlAuthError("GHL is not connected.");
    // Someone else refreshed while we waited for the lock.
    if (row.accessTokenEnc !== current.accessTokenEnc && row.expiresAt.getTime() - EXPIRY_MARGIN_MS > now(cfg).getTime()) {
      return { token: decryptSecret(row.accessTokenEnc, cfg.encryptionSecret), companyId: row.companyId };
    }
    const res = await call(cfg, "POST", "/oauth/token", {
      form: {
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "refresh_token",
        refresh_token: decryptSecret(row.refreshTokenEnc, cfg.encryptionSecret),
        user_type: "Company",
      },
    });
    // Returned rather than thrown so the error can be recorded outside the (rolled-back) transaction.
    if (res.status !== 200) return { failed: `GHL token refresh failed (${res.status}). Reconnect the agency app on the Sync page.` };
    const tok = tokenResponseSchema.parse(res.json);
    await tx
      .update(ghlConnection)
      .set({
        accessTokenEnc: encryptSecret(tok.access_token, cfg.encryptionSecret),
        refreshTokenEnc: tok.refresh_token ? encryptSecret(tok.refresh_token, cfg.encryptionSecret) : row.refreshTokenEnc,
        expiresAt: expiry(cfg, tok.expires_in),
        scope: tok.scope ?? row.scope,
        lastError: null,
      })
      .where(eq(ghlConnection.id, CONNECTION_ID));
    return { token: tok.access_token, companyId: row.companyId };
  });

  if (result.failed !== undefined) {
    await db.update(ghlConnection).set({ lastError: result.failed }).where(eq(ghlConnection.id, CONNECTION_ID));
    throw new GhlAuthError(result.failed);
  }
  return result;
}

/** Mint a Location token from the Company token. */
async function mintLocationToken(db: DB, cfg: OAuthConfig, ghlLocationId: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const company = await getCompanyToken(db, cfg, { forceRefresh: attempt > 0 });
    const res = await call(cfg, "POST", "/oauth/locationToken", {
      form: { companyId: company.companyId, locationId: ghlLocationId },
      bearer: company.token,
      version: "2021-07-28",
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status !== 200 && res.status !== 201) {
      throw new GhlError(
        `Could not get a token for sub-account ${ghlLocationId} (${res.status}): ${res.text.slice(0, 200)}. ` +
          "Is the app installed on this sub-account?",
        res.status,
        "/oauth/locationToken",
      );
    }
    const tok = tokenResponseSchema.parse(res.json);
    const row = {
      ghlLocationId,
      accessTokenEnc: encryptSecret(tok.access_token, cfg.encryptionSecret),
      expiresAt: expiry(cfg, tok.expires_in),
    };
    await db.insert(ghlLocationTokens).values(row).onConflictDoUpdate({ target: ghlLocationTokens.ghlLocationId, set: row });
    return tok.access_token;
  }
  throw new GhlAuthError("Unreachable");
}

/** Token provider for one sub-account: cached in the DB, re-minted when close to expiry or rejected. */
export function locationTokenProvider(db: DB, cfg: OAuthConfig, ghlLocationId: string): TokenProvider {
  let memo: { token: string; expiresAt: number } | null = null;
  return {
    async get() {
      const t = now(cfg).getTime();
      if (memo && memo.expiresAt - EXPIRY_MARGIN_MS > t) return memo.token;
      const [row] = await db.select().from(ghlLocationTokens).where(eq(ghlLocationTokens.ghlLocationId, ghlLocationId));
      if (row && row.expiresAt.getTime() - EXPIRY_MARGIN_MS > t) {
        memo = { token: decryptSecret(row.accessTokenEnc, cfg.encryptionSecret), expiresAt: row.expiresAt.getTime() };
        return memo.token;
      }
      const token = await mintLocationToken(db, cfg, ghlLocationId);
      const [fresh] = await db.select().from(ghlLocationTokens).where(eq(ghlLocationTokens.ghlLocationId, ghlLocationId));
      memo = { token, expiresAt: fresh?.expiresAt.getTime() ?? t + 60_000 };
      return token;
    },
    async invalidate() {
      memo = null;
      await db.delete(ghlLocationTokens).where(eq(ghlLocationTokens.ghlLocationId, ghlLocationId));
    },
  };
}

/** Every sub-account the app is installed on. */
export async function listInstalledLocations(db: DB, cfg: OAuthConfig): Promise<{ id: string; name: string | null }[]> {
  const out: { id: string; name: string | null }[] = [];
  const pageSize = 100;
  for (let skip = 0; skip < 10_000; skip += pageSize) {
    const company = await getCompanyToken(db, cfg);
    const res = await call(cfg, "GET", "/oauth/installedLocations", {
      query: {
        companyId: company.companyId,
        appId: cfg.appId,
        isInstalled: "true",
        limit: String(pageSize),
        skip: String(skip),
      },
      bearer: company.token,
      version: "2021-07-28",
    });
    if (res.status !== 200) {
      throw new GhlError(
        `Listing installed sub-accounts failed (${res.status}): ${res.text.slice(0, 200)}`,
        res.status,
        "/oauth/installedLocations",
      );
    }
    const page = installedLocationsSchema.parse(res.json);
    for (const l of page.locations) {
      if (l.isInstalled !== false) out.push({ id: l._id, name: l.name ?? null });
    }
    if (page.locations.length < pageSize) break;
  }
  return out;
}
