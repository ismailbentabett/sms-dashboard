import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const SECRET = "s".repeat(40);

describe("token encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("token-123", SECRET);
    const b = encryptSecret("token-123", SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, SECRET)).toBe("token-123");
  });

  it("rejects a wrong key or tampered ciphertext", () => {
    const enc = encryptSecret("token-123", SECRET);
    expect(() => decryptSecret(enc, "x".repeat(40))).toThrow();
    const buf = Buffer.from(enc, "base64url");
    buf[buf.length - 1] ^= 1;
    expect(() => decryptSecret(buf.toString("base64url"), SECRET)).toThrow();
  });
});
