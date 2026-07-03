/**
 * Date-only arithmetic that mirrors Python's `datetime.date` (no time, no
 * timezone). We represent a plain date as a JS Date pinned to LOCAL midnight and
 * only ever read/write it through local components (getFullYear/getMonth/
 * getDate). We never use toISOString()/Date.parse on these, because those go
 * through UTC and would shift the calendar day for anyone east/west of UTC. The
 * app runs in Korea (KST, no DST), so local-midnight math is exact.
 */
export type PlainDate = Date;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Construct a local-midnight date from a 1-based month. */
export function makeDate(year: number, month1: number, day: number): PlainDate {
  return new Date(year, month1 - 1, day);
}

/** Today at local midnight. */
export function today(): PlainDate {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** "yyyy-mm-dd" from LOCAL components (never toISOString). */
export function toIso(d: PlainDate): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Add (or subtract) whole days, staying at local midnight. */
export function addDays(d: PlainDate, n: number): PlainDate {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * Add `months` calendar months, clamping the day to the target month end.
 * e.g. makeDate(2024,1,31) + 1 month -> 2024-02-29. Mirrors expiry.add_months.
 */
export function addMonths(d: PlainDate, months: number): PlainDate {
  const total = d.getFullYear() * 12 + d.getMonth() + months; // getMonth is 0-based
  const year = Math.floor(total / 12);
  const month0 = total - year * 12; // 0..11
  const lastDay = new Date(year, month0 + 1, 0).getDate(); // day 0 of next month
  const day = Math.min(d.getDate(), lastDay);
  return new Date(year, month0, day);
}

/** True if two plain dates fall on the same calendar day (component compare). */
export function sameDate(a: PlainDate, b: PlainDate): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole-day difference a - b (a and b are local-midnight dates). */
export function daysBetween(a: PlainDate, b: PlainDate): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}
