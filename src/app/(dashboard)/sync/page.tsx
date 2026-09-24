import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RelativeTime } from "@/components/layout/relative-time";
import { SyncButton } from "@/components/layout/sync-button";
import { isLocationKey } from "@/lib/config/locations";
import { getDb } from "@/lib/db/client";
import type { SyncStatus } from "@/lib/db/schema";
import { ghlToken } from "@/lib/env";
import { getLocationStatuses, getRecentRuns } from "@/lib/queries/sync-status";
import { BackfillForm } from "./backfill-form";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<SyncStatus, "ok" | "warn" | "bad" | "secondary"> = {
  success: "ok",
  partial: "warn",
  error: "bad",
  skipped: "secondary",
  running: "secondary",
};

const n = (v: number) => v.toLocaleString("en-US");

function fmtTime(d: Date | null) {
  return d
    ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";
}

export default async function SyncPage() {
  const db = getDb();
  const [statuses, runs] = await Promise.all([getLocationStatuses(db), getRecentRuns(db)]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Sync status</h1>
        <SyncButton label="Sync all now" variant="default" />
      </div>

      {statuses.length === 0 && (
        <Card>
          <CardContent className="text-muted-foreground text-sm">
            No locations yet. Run <code>npm run db:migrate</code> (it seeds the 4 sub-accounts), or click Sync now.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Sub-accounts</CardTitle>
          <CardDescription>Raw row counts in the database and each location&apos;s sync cursors.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table className="tabular">
            <TableHeader>
              <TableRow>
                <TableHead>Sub-account</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Pipeline</TableHead>
                <TableHead className="text-right">Contacts</TableHead>
                <TableHead className="text-right">Conversations</TableHead>
                <TableHead className="text-right">Messages (in / out)</TableHead>
                <TableHead className="text-right">Opportunities</TableHead>
                <TableHead>Last synced</TableHead>
                <TableHead>Message cursor</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {statuses.map((s) => {
                const hasToken = isLocationKey(s.key) && ghlToken(s.key) !== null;
                return (
                  <TableRow key={s.key}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>
                      {hasToken ? <Badge variant="ok">set</Badge> : <Badge variant="bad">GHL_TOKEN_{s.key} missing</Badge>}
                    </TableCell>
                    <TableCell>
                      {s.pipelineId ? (
                        <span>
                          {s.counts.stages} stages
                          {s.counts.unmappedStages > 0 && (
                            <Badge variant="warn" className="ml-1">
                              {s.counts.unmappedStages} unmapped
                            </Badge>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">not found yet</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{n(s.counts.contacts)}</TableCell>
                    <TableCell className="text-right">{n(s.counts.conversations)}</TableCell>
                    <TableCell className="text-right">
                      {n(s.counts.messages)}{" "}
                      <span className="text-muted-foreground">
                        ({n(s.counts.inbound)} / {n(s.counts.outbound)})
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{n(s.counts.opportunities)}</TableCell>
                    <TableCell>
                      <RelativeTime date={s.lastSyncedAt} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {fmtTime(s.messagesUpdatedAt)}
                      {s.backfillFrom && <div className="text-warn">backfill at {fmtTime(s.backfillFrom)}</div>}
                    </TableCell>
                    <TableCell>
                      <SyncButton locationKeys={[s.key]} label={`Sync ${s.key}`} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backfill</CardTitle>
          <CardDescription>
            Re-walks all SMS from a date forward (idempotent). Large ranges continue automatically on the next scheduled
            runs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BackfillForm locationKeys={statuses.map((s) => s.key)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent sync runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No runs yet.</p>
          ) : (
            <Table className="tabular">
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Loc</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">429s</TableHead>
                  <TableHead>Fetched · notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id} className="align-top">
                    <TableCell>{fmtTime(r.startedAt)}</TableCell>
                    <TableCell>{r.locationKey}</TableCell>
                    <TableCell>{r.kind}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.finishedAt
                        ? `${Math.max(0, (r.finishedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(1)}s`
                        : "…"}
                    </TableCell>
                    <TableCell className="text-right">{r.requests}</TableCell>
                    <TableCell className={r.rateLimitHits ? "text-warn text-right" : "text-right"}>
                      {r.rateLimitHits}
                    </TableCell>
                    <TableCell className="min-w-72 text-xs whitespace-normal">
                      <div className="text-muted-foreground">
                        {Object.entries(r.counts)
                          .filter(([, v]) => v)
                          .map(([k, v]) => `${k} ${v}`)
                          .join(" · ") || "—"}
                      </div>
                      {r.error && <div className="mt-1 whitespace-pre-wrap">{r.error}</div>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
