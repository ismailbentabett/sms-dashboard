"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

/** Data older than this triggers a sync when the dashboard is opened or the tab comes back into view. */
const STALE_AFTER_MS = 60_000;

interface Props {
  /** Last successful sync per location that has a token (ISO strings; null = never). */
  lastSynced: { key: string; at: string | null }[];
}

type State =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "partial"; message: string }
  | { kind: "error"; message: string };

/**
 * Keeps what's on screen current without any background jobs: the page
 * renders from the database immediately, and if that data is stale this
 * runs a sync and refreshes the page when it finishes.
 */
export function AutoSync({ lastSynced }: Props) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const running = useRef(false);
  const latest = useRef(lastSynced);
  useEffect(() => {
    latest.current = lastSynced;
  }, [lastSynced]);

  const sync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setState({ kind: "syncing" });
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        results?: { locationKey: string; status: string; error: string | null }[];
      };
      const failed = body.results?.filter((r) => r.status === "error") ?? [];
      const partial = body.results?.filter((r) => r.status === "partial") ?? [];
      if (!res.ok) setState({ kind: "error", message: body.error ?? `Sync failed (${res.status})` });
      else if (failed.length)
        setState({
          kind: "error",
          message: `Sync failed for ${failed.map((f) => f.locationKey).join(", ")}: ${failed[0].error?.split("\n")[0] ?? ""}`,
        });
      else if (partial.length)
        setState({ kind: "partial", message: `Still catching up (${partial.map((p) => p.locationKey).join(", ")}); sync again to continue` });
      else setState({ kind: "idle" });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Sync failed" });
    } finally {
      running.current = false;
      startTransition(() => router.refresh());
    }
  }, [router]);

  const syncIfStale = useCallback(() => {
    const now = Date.now();
    const stale = latest.current.some((l) => !l.at || now - new Date(l.at).getTime() > STALE_AFTER_MS);
    if (stale) void sync();
  }, [sync]);

  useEffect(() => {
    syncIfStale();
    const onVisible = () => {
      if (document.visibilityState === "visible") syncIfStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [syncIfStale]);

  return (
    <span className="inline-flex items-center gap-2">
      {state.kind === "syncing" && <span className="text-muted-foreground text-xs">Updating from GHL…</span>}
      {(state.kind === "error" || state.kind === "partial") && (
        <span
          className={`max-w-72 truncate text-xs ${state.kind === "error" ? "text-bad" : "text-warn"}`}
          title={state.message}
        >
          {state.message}
        </span>
      )}
      <Button size="sm" variant="outline" onClick={() => void sync()} disabled={state.kind === "syncing"}>
        <RefreshCw className={state.kind === "syncing" ? "animate-spin" : undefined} />
        <span className="hidden sm:inline">{state.kind === "syncing" ? "Syncing…" : "Sync now"}</span>
      </Button>
    </span>
  );
}
