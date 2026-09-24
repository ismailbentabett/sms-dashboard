"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionToken, secretsMatch, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth/session";
import { requireEnv } from "@/lib/env";

export interface LoginState {
  error: string | null;
}

function safeNext(next: FormDataEntryValue | null): string {
  const v = typeof next === "string" ? next : "";
  // Only allow same-site relative paths.
  return v.startsWith("/") && !v.startsWith("//") ? v : "/";
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = formData.get("password");
  const ok = await secretsMatch(typeof password === "string" ? password : "", requireEnv("DASHBOARD_PASSWORD"));
  if (!ok) {
    // Slow down guessing.
    await new Promise((r) => setTimeout(r, 600));
    return { error: "Wrong password" };
  }
  const token = await createSessionToken(requireEnv("SESSION_SECRET"));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  redirect(safeNext(formData.get("next")));
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
