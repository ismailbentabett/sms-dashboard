import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RelativeTime } from "@/components/layout/relative-time";
import { SyncButton } from "@/components/layout/sync-button";
import { getDb } from "@/lib/db/client";
import type { SyncStatus } from "@/lib/db/schema";
import { oauthConfigFromEnv } from "@/lib/ghl/oauth-config";
import { Button } from "@/components/ui/button";
import { setTracking } from "./actions";
import { getConnectionStatus, getLocationStatuses, getRecentRuns } from "@/lib/queries/sync-status";

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

export default async function SyncPage({ searchParams }: PageProps<"/sync">) {
  const db = getDb();
  const params = await searchParams;
  const [statuses, runs, connection] = await Promise.all([
    getLocationStatuses(db),
    getRecentRuns(db),
    getConnectionStatus(db),
  ]);
  const configured = oauthConfigFromEnv() !== null;
  const ghlError = typeof params.ghl_error === "string" ? params.ghl_error : null;
  const justConnected = typeof params.connected === "string" ? Number(params.connected) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Sync status</h1>
        <SyncButton label="Sync all now" variant="default" />
      </div>

      {ghlError && (
        <Card className="border-bad/50">
          <CardContent className="text-bad text-sm">{ghlError}</CardContent>
        </Card>
      )}
      {justConnected !== null && !ghlError && (
        <Card className="border-ok/50">
          <CardContent className="text-sm">
            GHL connected. {justConnected} new sub-account{justConnected === 1 ? "" : "s"} found.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>GHL agency connection</CardTitle>
          <CardDescription>
            One install of the private Marketplace app covers every sub-account. New sub-accounts appear here
            automatically and are tracked if they have the outreach pipeline.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          {!configured ? (
            <span className="text-bad">
              Set <code>GHL_CLIENT_ID</code> and <code>GHL_CLIENT_SECRET</code> (see README), then reload.
            </span>
          ) : connection ? (
            <>
              <Badge variant={connection.lastError ? "bad" : "ok"}>{connection.lastError ? "needs attention" : "connected"}</Badge>
              <span className="text-muted-foreground">
                Agency <code>{connection.companyId}</code> · connected <RelativeTime date={connection.connectedAt} /> ·
                sub-accounts checked <RelativeTime date={connection.locationsDiscoveredAt} />
              </span>
              {connection.lastError && <span className="text-bad w-full">{connection.lastError}</span>}
              <div className="flex gap-2">
                <SyncButton label="Re-check sub-accounts" forceDiscover />
                <Button asChild size="sm" variant="ghost">
                  <a href="/api/ghl/connect">Reconnect</a>
                </Button>
              </div>
            </>
          ) : (
            <Button asChild>
              <a href="/api/ghl/connect">Connect GHL agency</a>
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sub-accounts</CardTitle>
          <CardDescription>Every sub-account the app is installed on. Only tracked ones are synced and shown.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table className="tabular">
            <TableHeader>
              <TableRow>
                <TableHead>Sub-account</TableHead>
                <TableHead>Tracking</TableHead>
                <TableHead>Pipeline</TableHead>
                <TableHead className="text-right">Opportunities</TableHead>
                <TableHead>Last synced</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {statuses.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No sub-accounts yet. Connect GHL above.
                  </TableCell>
                </TableRow>
              )}
              {statuses.map((s) => {
                return (
                  <TableRow key={s.key} className={s.active && s.installed ? undefined : "opacity-60"}>
                    <TableCell className="font-medium">
                      <span className="text-muted-foreground mr-1.5">{s.key}</span>
                      {s.name}
                    </TableCell>
                    <TableCell>
                      {!s.installed ? (
                        <Badge variant="bad">app not installed</Badge>
                      ) : (
                        <form action={setTracking} className="flex items-center gap-2">
                          <input type="hidden" name="key" value={s.key} />
                          <input type="hidden" name="active" value={String(!s.active)} />
                          <Badge variant={s.active ? "ok" : "secondary"}>{s.active ? "tracked" : "ignored"}</Badge>
                          <Button type="submit" size="sm" variant="ghost" className="h-7 px-2 text-xs">
                            {s.active ? "Ignore" : "Track"}
                          </Button>
                        </form>
                      )}
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
                    <TableCell className="text-right">{n(s.counts.opportunities)}</TableCell>
                    <TableCell>
                      <RelativeTime date={s.lastSyncedAt} />
                    </TableCell>
                    <TableCell>
                      {s.active && s.installed && <SyncButton locationKeys={[s.key]} label={`Sync ${s.key}`} />}
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
