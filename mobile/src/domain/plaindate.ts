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

/** Parse a strict "yyyy-mm-dd" into a local-midnight date; null if invalid. */
export function parseIso(iso: string): PlainDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = makeDate(y, mo, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** Shown (home banner) while the device clock is off by a day or more; sending is
 *  blocked meanwhile, since every D-day and {when} is computed from the device date. */
export const CLOCK_SKEW_MESSAGE = "휴대폰 날짜가 실제와 다릅니다 — 날짜/시간 자동 설정을 켜 주세요";

const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
/** Wall-clock drift this small never counts as a wrong date (a midnight edge). */
const CLOCK_SKEW_TOLERANCE_MS = 10 * 60_000;

/**
 * Calendar days the device's LOCAL date (what today() and every D-day/{when} use) is
 * ahead (+) / behind (-) of Korea's date (KST, UTC+9) at the server's instant — the
 * server's HTTP Date header as ISO (or an RFC 1123 date), e.g. from the native
 * check/getJson `serverDate`. Dates, not elapsed time, are compared: a phone 23h
 * ahead across midnight, or one set to UTC between 00:00 and 09:00 KST, shows the
 * wrong date and is ±1. A date difference whose wall clocks are under 10 minutes
 * apart is a midnight edge of normal drift -> 0. Unparseable/empty -> 0 (can't tell:
 * never block). The caller warns and blocks sending when Math.abs(result) >= 1.
 */
export function clockSkewDays(serverIso: string, deviceNow: Date): number {
  const serverMs = Date.parse(String(serverIso ?? "").trim());
  if (!Number.isFinite(serverMs) || !(deviceNow instanceof Date) || Number.isNaN(deviceNow.getTime())) return 0;
  // The device's wall clock as if it were UTC, vs the KST wall clock at the server instant.
  const deviceWall = Date.UTC(
    deviceNow.getFullYear(), deviceNow.getMonth(), deviceNow.getDate(),
    deviceNow.getHours(), deviceNow.getMinutes(), deviceNow.getSeconds(), deviceNow.getMilliseconds(),
  );
  const kstWall = serverMs + KST_OFFSET_MS;
  const days = Math.floor(deviceWall / DAY_MS) - Math.floor(kstWall / DAY_MS); // calendar-day diff
  if (days === 0 || Math.abs(deviceWall - kstWall) < CLOCK_SKEW_TOLERANCE_MS) return 0; // never -0
  return days;
}

/** Days from `todayD` until the "yyyy-mm-dd" expiry (negative once past); null if invalid.
 *  The single source of a due row's D-day, so a cached list never shows a stale one. */
export function daysUntil(expiryIso: string, todayD: PlainDate): number | null {
  const exp = parseIso(expiryIso);
  return exp ? daysBetween(exp, todayD) : null;
}
