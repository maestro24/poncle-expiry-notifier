/**
 * Contract-expiry math over raw Poncle rows. Direct port of backend/expiry.py.
 *
 * A Poncle row (from /open/listOpen) carries, among others:
 *   opendate  : "26-07-02"  (yy-mm-dd, Korea local date the line was opened)
 *   openhowx  : "기변" | "번호이동" | "유심MNP" | ...
 *   telecomx  : "SK텔레콤" | ...
 *   agencytitle, customer, openphone, model, membername, ...
 *
 * Expiry = opendate + term_months. term_months comes from 개통유형: 기변/신규 use
 * default_term_months (24); every other type uses the row's 거래처 term from
 * agency_term_months, or nonstandard_term_months (6) if that 거래처 has no override.
 */
import { htmlUnescape } from "./html-entities";
import {
  PlainDate,
  addDays,
  addMonths,
  daysBetween,
  makeDate,
  toIso,
} from "./plaindate";
import type { AppConfig, PoncleRow } from "./types";

// 개통유형(openhowx)이 정확히 이 값이면 표준 약정(기변/신규). "유심신규"는 "신규"를
// 포함하지만 정확 매칭이라 여기 안 걸리고 비표준(거래처 기준)으로 처리된다.
export const STANDARD_OPEN_TYPES: ReadonlySet<string> = new Set(["기변", "신규"]);

/** Parse Poncle's 'yy-mm-dd' (also tolerates 'yyyy-mm-dd'). null if invalid. */
export function parseOpendate(value: string): PlainDate | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const parts = v.split("-");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  let [y] = nums;
  const [, m, d] = nums;
  if (y < 100) y += 2000; // two-digit year -> 2000+yy
  const dt = makeDate(y, m, d);
  // Reject rolled-over invalid dates (JS Date silently normalises 24-13-40).
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt;
}

/**
 * Completed whole months from an opendate ("yy-mm-dd") to `today`, for the
 * {months} / {years} message placeholders (e.g. "{months}개월 전 개통").
 * The day-of-month is honoured so a not-yet-elapsed month doesn't count. Returns
 * 0 when the opendate is unparseable or in the future.
 */
export function monthsSinceOpen(openIso: string, today: PlainDate): number {
  const open = parseOpendate(openIso);
  if (!open) return 0;
  let m = (today.getFullYear() - open.getFullYear()) * 12 + (today.getMonth() - open.getMonth());
  // Clamp the open day to today's month length, so a month-end opendate (29/30/31)
  // whose day doesn't exist in a shorter month still counts once its clamped
  // monthiversary passes — matching computeExpiry's month-end clamp (addMonths),
  // e.g. 24-08-31 -> 2026-06-30 is a completed 22 months, not 21.
  const daysInTodayMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const effectiveOpenDay = Math.min(open.getDate(), daysInTodayMonth);
  if (today.getDate() < effectiveOpenDay) m -= 1; // this month not completed yet
  return Math.max(0, m);
}

function field(row: PoncleRow, name: string): string {
  const v = row[name];
  return v == null ? "" : String(v);
}

/**
 * Normalize a 거래처 name for matching: unescape HTML entities (PS&amp;M -> PS&M),
 * collapse whitespace, casefold. Applied to both the config key and the scanned
 * row so minor spacing/case/encoding differences still match.
 */
export function normalizeAgency(name: string): string {
  let s = htmlUnescape(String(name ?? ""));
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

/** True for 기변/신규 (표준 약정 + 표준 문자). 정확 매칭이라 유심신규는 False. */
export function isStandardOpenType(openhow: string): boolean {
  return STANDARD_OPEN_TYPES.has(String(openhow ?? "").trim());
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 개통유형 기변/신규 -> 표준 약정. 그 외 -> 거래처별 값(없으면 비표준 기본). */
export function resolveTermMonths(row: PoncleRow, config: AppConfig): number {
  if (isStandardOpenType(field(row, "openhowx"))) {
    return toInt(config.default_term_months, 24);
  }
  const agency = normalizeAgency(field(row, "agencytitle"));
  const overrides = config.agency_term_months ?? {};
  for (const [name, months] of Object.entries(overrides)) {
    if (normalizeAgency(name) === agency) {
      const n = typeof months === "number" ? months : parseInt(String(months), 10);
      if (Number.isFinite(n)) return n;
      break;
    }
  }
  return toInt(config.nonstandard_term_months, 6);
}

/** Return the expiry date, or null if the row has no computable/relevant term. */
export function computeExpiry(row: PoncleRow, config: AppConfig): PlainDate | null {
  const openD = parseOpendate(field(row, "opendate"));
  if (openD === null) return null;
  const term = resolveTermMonths(row, config);
  if (term <= 0) return null;
  return addMonths(openD, term);
}

/** Sorted, de-duplicated, non-negative notify offsets (days before expiry). */
export function normalizedOffsets(config: AppConfig): number[] {
  const seen = new Set<number>();
  const raw = config.notify_offsets_days ?? [0];
  for (const v of raw) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n >= 0) seen.add(n);
  }
  const out = Array.from(seen).sort((a, b) => a - b);
  return out.length ? out : [0];
}

/**
 * Look-ahead window in days: the furthest 안내 시점. Because the app is run
 * manually (no daily scheduler), the meaning is a RANGE, not an exact-day
 * milestone: "show everyone expiring within N days", where N is the largest
 * selected offset. So D-30 shows every customer expiring in the next 30 days.
 */
export function lookAheadDays(config: AppConfig): number {
  const offs = normalizedOffsets(config); // always >= 1 element, non-negative
  return Math.max(...offs);
}

/** All positive contract terms in play (default + nonstandard + agency overrides). */
function positiveTerms(config: AppConfig): number[] {
  const set = new Set<number>([
    toInt(config.default_term_months, 24),
    toInt(config.nonstandard_term_months, 6),
  ]);
  for (const months of Object.values(config.agency_term_months ?? {})) {
    const n = typeof months === "number" ? months : parseInt(String(months), 10);
    if (Number.isFinite(n)) set.add(n);
  }
  return Array.from(set).filter((t) => t > 0);
}

/**
 * Whether this row is due within the look-ahead window. Returns a single
 * [daysUntilExpiry, expiry] pair when 0 <= (expiry - today) <= window, else [].
 * daysUntilExpiry is the ACTUAL remaining days (used for the {when} phrase); it
 * is NOT part of the dedup key, so a customer shows every day until sent, once.
 */
export function dueWithin(
  row: PoncleRow,
  config: AppConfig,
  todayD: PlainDate,
): Array<[number, PlainDate]> {
  const expiry = computeExpiry(row, config);
  if (expiry === null) return [];
  const days = daysBetween(expiry, todayD); // expiry - today
  if (days < 0 || days > lookAheadDays(config)) return [];
  return [[days, expiry]];
}

/**
 * Open-date bounds (inclusive ISO) whose expiries could fall in [today - extra
 * months, today + window], used to narrow the server date filter. A buffer
 * absorbs the month-clamp inverse error; the client re-checks each row exactly
 * (dueWithin / unvisited), so this only affects fetch breadth, never correctness.
 *
 * `extraLookbackMonths` widens the lower bound so already-expired customers
 * (the 미방문 list) are also fetched; 0 keeps the classic due-only breadth.
 */
function openDateBounds(
  config: AppConfig,
  todayD: PlainDate,
  extraLookbackMonths: number,
): { sdate: string; edate: string } {
  const terms = positiveTerms(config);
  const maxTerm = terms.length ? Math.max(...terms) : 1;
  const minTerm = terms.length ? Math.min(...terms) : 1;
  const window = lookAheadDays(config);
  const buffer = Math.max(0, toInt(config.date_window_days, 3));
  const extra = Math.max(0, extraLookbackMonths);
  // expiry = today - extra -> opendate = today - term - extra (oldest we still fetch)
  const minOpen = addDays(addMonths(todayD, -maxTerm - extra), -buffer);
  // Due upper: newest opendate whose expiry reaches the window edge (usually months
  // in the PAST). But when 미방문 tracking is on (extra > 0) we must ALSO fetch
  // re-activation rows — a returning customer's new 개통 has opendate up to today —
  // so latestOpenByPhone sees the return and auto-clears them. Extend to today.
  const dueUpper = addMonths(addDays(todayD, window), -minTerm);
  const upper = extra > 0 && dueUpper.getTime() < todayD.getTime() ? todayD : dueUpper;
  const maxOpen = addDays(upper, buffer);
  return { sdate: toIso(minOpen), edate: toIso(maxOpen) };
}

/** Bounds for the classic due window only (expiry in [today, today+window]). */
export function candidateOpenDateBounds(
  config: AppConfig,
  todayD: PlainDate,
): { sdate: string; edate: string } {
  return openDateBounds(config, todayD, 0);
}

/**
 * Bounds for a full scan that also covers recently-expired customers, so the
 * same fetch feeds both the due list and the 미방문 list. Extends the lower
 * bound back by unvisited_lookback_months.
 */
export function scanOpenDateBounds(
  config: AppConfig,
  todayD: PlainDate,
): { sdate: string; edate: string } {
  return openDateBounds(config, todayD, unvisitedLookbackMonths(config));
}

/** Configured 미방문 tracking horizon in months (>= 0). */
export function unvisitedLookbackMonths(config: AppConfig): number {
  return Math.max(0, toInt(config.unvisited_lookback_months, 6));
}

/** Earliest expiry still counted as 미방문: today - unvisited_lookback_months. */
export function unvisitedFloor(config: AppConfig, todayD: PlainDate): PlainDate {
  return addMonths(todayD, -unvisitedLookbackMonths(config));
}

/** Human phrase for the alert text, e.g. '오늘 2026-06-15' / 'D-7 (2026-06-15)'. */
export function formatWhen(offsetDays: number, expiry: PlainDate): string {
  const iso = toIso(expiry);
  if (offsetDays === 0) return `오늘 ${iso}`;
  return `D-${offsetDays} (${iso})`;
}
