import { LogOut } from "lucide-react";
import { logout } from "@/app/login/actions";
import { Nav, type NavItem } from "@/components/layout/nav";
import { minutesSince, RelativeTime } from "@/components/layout/relative-time";
import { SyncButton } from "@/components/layout/sync-button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db/client";
import { getLastSynced } from "@/lib/queries/sync-status";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Pages are added to this list as each phase ships.
const NAV: NavItem[] = [{ href: "/sync", label: "Sync status" }];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const lastSynced = await getLastSynced(getDb()).catch(() => []);
  return (
    <div className="flex min-h-dvh">
      <aside className="bg-card hidden w-52 shrink-0 flex-col gap-4 border-r p-3 md:flex">
        <div className="px-3 pt-1 text-sm font-semibold">SMS Dashboard</div>
        <Nav items={NAV} orientation="vertical" />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/95 sticky top-0 z-10 flex flex-col gap-2 border-b px-4 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="md:hidden">
              <Nav items={NAV} orientation="horizontal" />
            </div>
            <div className="tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {lastSynced.map((l) => {
                const mins = minutesSince(l.lastSyncedAt);
                return (
                  <span key={l.key} className="inline-flex items-center gap-1">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        mins === null ? "bg-muted-foreground" : mins <= 15 ? "bg-ok" : mins <= 60 ? "bg-warn" : "bg-bad",
                      )}
                    />
                    <span className="font-medium">{l.key}</span>
                    <RelativeTime date={l.lastSyncedAt} />
                  </span>
                );
              })}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <SyncButton />
              <ThemeToggle />
              <form action={logout}>
                <Button variant="ghost" size="icon" type="submit" aria-label="Sign out">
                  <LogOut />
                </Button>
              </form>
            </div>
          </div>
        </header>
        <main className="flex-1 p-4">{children}</main>
      </div>
    </div>
  );
}
