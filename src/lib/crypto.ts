import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets stored in the database (GHL OAuth tokens). The key
 * is derived from SESSION_SECRET, so changing SESSION_SECRET means
 * reconnecting GHL (the stored tokens can no longer be decrypted).
 */
function key(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "sms-dashboard", "ghl-token-encryption", 32));
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

export function decryptSecret(enc: string, secret: string): string {
  const buf = Buffer.from(enc, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(secret), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
