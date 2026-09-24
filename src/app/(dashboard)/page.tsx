import Link from "next/link";
import { RelativeTime } from "@/components/layout/relative-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db/client";
import { getSettings } from "@/lib/db/settings";
import { fmtDateTime, fmtInt, fmtMoney } from "@/lib/format";
import {
  getOpportunities,
  getRecentStageChanges,
  getStageCounts,
  getTrackedLocations,
} from "@/lib/queries/pipeline";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

function filterHref(loc?: string, stage?: string) {
  const p = new URLSearchParams();
  if (loc) p.set("loc", loc);
  if (stage) p.set("stage", stage);
  const q = p.toString();
  return q ? `/?${q}#opportunities` : "/#opportunities";
}

export default async function PipelinePage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const loc = typeof params.loc === "string" ? params.loc : undefined;
  const stage = typeof params.stage === "string" ? params.stage : undefined;

  const db = getDb();
  const [locs, { order, counts }, changes, opps, settings] = await Promise.all([
    getTrackedLocations(db),
    getStageCounts(db),
    getRecentStageChanges(db),
    getOpportunities(db, { locationKey: loc, stage }),
    getSettings(db),
  ]);
  const tz = settings.display_timezone;

  const total = (s: string) => [...(counts.get(s)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const locTotal = (k: string) => order.reduce((a, s) => a + (counts.get(s)?.get(k) ?? 0), 0);
  const won = (k?: string) => (k ? (counts.get("Won")?.get(k) ?? 0) : total("Won"));
  const grand = locs.reduce((a, l) => a + locTotal(l.key), 0);

  if (locs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No sub-accounts tracked yet</CardTitle>
          <CardDescription>
            Connect GHL on the <Link href="/sync" className="underline">Sync status</Link> page. Sub-accounts with the
            outreach pipeline are tracked automatically.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Pipeline</h1>

      <div className="tabular grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Opportunities" value={fmtInt(grand)} />
        <Kpi label="Needs Reply" value={fmtInt(total("Needs Reply"))} href={filterHref(undefined, "Needs Reply")} />
        <Kpi label="Won" value={fmtInt(won())} href={filterHref(undefined, "Won")} />
        <Kpi
          label="MRR"
          value={fmtMoney(won() * settings.price_per_client)}
          hint={`${fmtInt(won())} × ${fmtMoney(settings.price_per_client)}`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By stage</CardTitle>
          <CardDescription>Current stage of every opportunity. Click a number to list them.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table className="tabular">
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                {locs.map((l) => (
                  <TableHead key={l.key} className="text-right" title={l.name}>
                    {l.key}
                  </TableHead>
                ))}
                <TableHead className="text-right">All</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.map((s) => (
                <TableRow key={s} className={total(s) === 0 ? "text-muted-foreground" : undefined}>
                  <TableCell className={cn(stage === s && "font-semibold")}>{s}</TableCell>
                  {locs.map((l) => {
                    const n = counts.get(s)?.get(l.key) ?? 0;
                    return (
                      <TableCell key={l.key} className="text-right">
                        {n ? (
                          <Link href={filterHref(l.key, s)} className="hover:underline">
                            {fmtInt(n)}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground/50">0</span>
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right font-medium">
                    {total(s) ? (
                      <Link href={filterHref(undefined, s)} className="hover:underline">
                        {fmtInt(total(s))}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground/50">0</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-medium">
                <TableCell>Total</TableCell>
                {locs.map((l) => (
                  <TableCell key={l.key} className="text-right">
                    <Link href={filterHref(l.key)} className="hover:underline">
                      {fmtInt(locTotal(l.key))}
                    </Link>
                  </TableCell>
                ))}
                <TableCell className="text-right">{fmtInt(grand)}</TableCell>
              </TableRow>
              <TableRow className="text-muted-foreground">
                <TableCell>MRR</TableCell>
                {locs.map((l) => (
                  <TableCell key={l.key} className="text-right">
                    {fmtMoney(won(l.key) * settings.price_per_client)}
                  </TableCell>
                ))}
                <TableCell className="text-right">{fmtMoney(won() * settings.price_per_client)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card id="opportunities">
          <CardHeader>
            <CardTitle>
              Opportunities
              {(loc || stage) && (
                <span className="text-muted-foreground ml-2 text-sm font-normal">
                  {[loc && `sub-account ${loc}`, stage].filter(Boolean).join(" · ")} ·{" "}
                  <Link href="/#opportunities" className="underline">
                    clear
                  </Link>
                </span>
              )}
            </CardTitle>
            <CardDescription>Most recent stage change first{opps.length === 300 ? " (first 300)" : ""}.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table className="tabular">
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Sub</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>In stage since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opps.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      None.
                    </TableCell>
                  </TableRow>
                )}
                {opps.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="max-w-56 truncate" title={o.name ?? ""}>
                      {o.name ?? "—"}
                    </TableCell>
                    <TableCell>{o.locationKey}</TableCell>
                    <TableCell title={o.rawStage ?? ""}>{o.stage}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <RelativeTime date={o.stageChangedAt} empty="—" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent stage changes</CardTitle>
            <CardDescription>Seen by the sync (times from GHL).</CardDescription>
          </CardHeader>
          <CardContent>
            <Table className="tabular">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Sub</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Move</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {changes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      No changes yet.
                    </TableCell>
                  </TableRow>
                )}
                {changes.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-muted-foreground">{fmtDateTime(c.changedAt, tz)}</TableCell>
                    <TableCell>{c.locationKey}</TableCell>
                    <TableCell className="max-w-44 truncate" title={c.opportunityName ?? ""}>
                      {c.opportunityName ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {c.from ? (
                        <>
                          <span className="text-muted-foreground">{c.from}</span> → {c.to}
                        </>
                      ) : (
                        <>
                          <span className="text-muted-foreground">new in</span> {c.to}
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value, hint, href }: { label: string; value: string; hint?: string; href?: string }) {
  const body = (
    <Card className="gap-1 py-3">
      <CardContent className="flex flex-col gap-0.5">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className="text-2xl font-semibold" title={hint}>
          {value}
        </span>
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="hover:[&>*]:border-ring">
      {body}
    </Link>
  ) : (
    body
  );
}
