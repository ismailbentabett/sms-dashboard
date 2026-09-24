import { describe, expect, it } from "vitest";
import { createSessionToken, secretsMatch, SESSION_TTL_MS, verifySessionToken } from "@/lib/auth/session";

const SECRET = "x".repeat(40);

describe("session tokens", () => {
  it("verifies a fresh token", async () => {
    const t = await createSessionToken(SECRET, 1_000);
    expect(await verifySessionToken(t, SECRET, 2_000)).toBe(true);
  });

  it("rejects expired, tampered, wrong-secret and malformed tokens", async () => {
    const t = await createSessionToken(SECRET, 1_000);
    expect(await verifySessionToken(t, SECRET, 1_000 + SESSION_TTL_MS + 1)).toBe(false);
    const [v, exp, sig] = t.split(".");
    expect(await verifySessionToken(`${v}.${Number(exp) + 1}.${sig}`, SECRET, 2_000)).toBe(false);
    expect(await verifySessionToken(t, "y".repeat(40), 2_000)).toBe(false);
    expect(await verifySessionToken("garbage", SECRET)).toBe(false);
    expect(await verifySessionToken(undefined, SECRET)).toBe(false);
    expect(await verifySessionToken(t, "short")).toBe(false);
  });

  it("compares secrets", async () => {
    expect(await secretsMatch("abc", "abc")).toBe(true);
    expect(await secretsMatch("abc", "abd")).toBe(false);
    expect(await secretsMatch(null, "abc")).toBe(false);
    expect(await secretsMatch("abc", undefined)).toBe(false);
  });
});
