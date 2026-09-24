"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  locationKeys?: string[];
  backfillFrom?: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline";
}

/** Calls POST /api/sync and refreshes server data when it finishes. */
export function SyncButton({ locationKeys, backfillFrom, label = "Sync now", size = "sm", variant = "outline" }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationKeys, backfillFrom }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Sync failed (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
      startTransition(() => router.refresh());
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button size={size} variant={variant} onClick={run} disabled={busy}>
        <RefreshCw className={busy ? "animate-spin" : undefined} />
        {busy ? "Syncing…" : label}
      </Button>
      {error && <span className="text-bad text-xs">{error}</span>}
    </span>
  );
}
