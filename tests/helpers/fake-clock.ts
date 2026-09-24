import type { Clock } from "@/lib/ghl/rate-limiter";

/** A clock whose sleep() advances time instantly and records each wait. */
export function fakeClock(start = 0): Clock & { sleeps: number[]; t: () => number } {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    t: () => t,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}
