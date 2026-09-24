/** Short date-time in the display timezone, e.g. "Sep 24, 4:05 PM". */
export function fmtDateTime(d: Date | null | undefined, timeZone: string): string {
  return d
    ? d.toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";
}

export const fmtInt = (n: number) => n.toLocaleString("en-US");

export const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
