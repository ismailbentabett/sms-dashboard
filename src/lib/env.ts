import "server-only";
import { z } from "zod";

/**
 * Server-only environment access. Values are read lazily so `next build`
 * works without secrets; each accessor validates what it needs.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DASHBOARD_PASSWORD: z.string().min(8, "DASHBOARD_PASSWORD must be at least 8 characters"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
});
type EnvKey = keyof z.infer<typeof envSchema>;

export function requireEnv(key: EnvKey): string {
  const result = envSchema.shape[key].safeParse(process.env[key]);
  if (!result.success) {
    throw new Error(`Missing or invalid env var ${key}: ${result.error.issues[0]?.message ?? "invalid"}`);
  }
  return result.data;
}
