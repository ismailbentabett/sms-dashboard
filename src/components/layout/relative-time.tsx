import { formatDistanceToNowStrict } from "date-fns";

/** "3 min ago", with the exact time on hover. Server-rendered; refreshes with the page. */
export function RelativeTime({ date, empty = "never" }: { date: Date | null | undefined; empty?: string }) {
  if (!date) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString("en-US", { timeZone: "America/New_York" })}>
      {formatDistanceToNowStrict(date, { addSuffix: true })}
    </time>
  );
}

/** Minutes since `date`, for staleness coloring. */
export function minutesSince(date: Date | null | undefined): number | null {
  return date ? (Date.now() - date.getTime()) / 60_000 : null;
}
