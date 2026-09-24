"use client";

import { useState } from "react";
import { SyncButton } from "@/components/layout/sync-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function BackfillForm({ locationKeys }: { locationKeys: string[] }) {
  const [from, setFrom] = useState("");
  const [loc, setLoc] = useState("ALL");
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backfill-from">Backfill messages from</Label>
        <Input id="backfill-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backfill-loc">Sub-account</Label>
        <select
          id="backfill-loc"
          value={loc}
          onChange={(e) => setLoc(e.target.value)}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="ALL">All</option>
          {locationKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      {from ? (
        <SyncButton
          label="Start backfill"
          size="default"
          variant="default"
          backfillFrom={from}
          locationKeys={loc === "ALL" ? undefined : [loc]}
        />
      ) : (
        <span className="text-muted-foreground pb-2 text-xs">Pick a date to enable.</span>
      )}
    </div>
  );
}
