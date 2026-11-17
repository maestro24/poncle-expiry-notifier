/**
 * Contract-expiry math over raw Poncle rows. Direct port of backend/expiry.py.
 *
 * A Poncle row (from /open/listOpen) carries, among others:
 *   opendate  : "26-07-02"  (yy-mm-dd, Korea local date the line was opened)
 *   openhowx  : "기변" | "번호이동" | "유심MNP" | ...
 *   telecomx  : "SK텔레콤" | ...
 *   agencytitle, customer, openphone, model, membername, ...
 *
 * 2단계 마일스톤 모델:
 *  - 요금제 유지 (1단계): 폰클 요금제유지 미결의 유지일, 없으면 개통 + keepdate_default_months(6).
 *    모든 개통 대상. -> 템플릿 1.
 *  - 약정 만료 (2단계): 약정 대상(신규/번호이동/기변)만, 개통 + default_term_months(24). -> 템플릿 2.
 * computeExpiry는 "그 고객의 대표 만료"(약정 대상=약정, 유심=요금제 유지)를 돌려줘 조회/미방문에 쓴다.
 */
import { htmlUnescape } from "./html-entities";
import {
  PlainDate,
  addDays,
  addMonths,
  daysBetween,
  makeDate,
  parseIso,
  toIso,
  today as todayLocal,
} from "./plaindate";
import { isContractType } from "./template-match";
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

/** 약정 개월 (2단계): 약정 대상의 약정 만료 = 개통 + 이 개월. */
export function contractTermMonths(config: AppConfig): number {
  return toInt(config.default_term_months, 24);
}

/** 요금제 유지 기본 개월 (1단계): 폰클 유지일이 없을 때 요금제 유지 시점 개월. */
export function keepdateDefaultMonths(config: AppConfig): number {
  return toInt(config.keepdate_default_months, 6);
}

/**
 * The customer's representative "만료" for 조회/미방문: 약정 대상은 약정 만료
 * (개통+약정 개월), 유심 등 그 외는 요금제 유지(개통+기본 개월). null when the
 * opendate is unparseable or the resolved term is non-positive.
 */
export function computeExpiry(row: PoncleRow, config: AppConfig): PlainDate | null {
  const openD = parseOpendate(field(row, "opendate"));
  if (openD === null) return null;
  const months = isContractType(field(row, "openhowx"))
    ? contractTermMonths(config)
    : keepdateDefaultMonths(config);
  if (months <= 0) return null;
  return addMonths(openD, months);
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

/** All positive milestone terms in play (약정 개월 + 요금제 유지 기본 개월), for fetch breadth. */
function positiveTerms(config: AppConfig): number[] {
  return [contractTermMonths(config), keepdateDefaultMonths(config)].filter((t) => t > 0);
}

/**
 * A single milestone `[daysUntil, date]` when `opendate + months` falls within the
 * look-ahead window [today, today+window]; else null. `daysUntil` is the ACTUAL
 * remaining days (used for the {when} phrase); it is NOT part of the dedup key, so
 * a customer shows every day until sent, once. Used by both scan milestones
 * (요금제 유지 기본 6개월, 약정 24개월).
 */
export function milestoneDue(
  openIso: string,
  months: number,
  config: AppConfig,
  todayD: PlainDate,
  catchUpDays = 0,
): [number, PlainDate] | null {
  const open = parseOpendate(openIso);
  if (open === null || months <= 0) return null;
  const date = addMonths(open, months);
  const days = daysBetween(date, todayD); // date - today (negative = passed, D+N)
  if (days < -clampCatchUp(catchUpDays) || days > lookAheadDays(config)) return null;
  return [days, date];
}

/** Longest catch-up (days) for milestones that passed while the app wasn't scanned. */
export const CATCH_UP_MAX_DAYS = 14;

function clampCatchUp(n: number): number {
  return Number.isFinite(n) ? Math.min(CATCH_UP_MAX_DAYS, Math.max(0, Math.floor(n))) : 0;
}

/**
 * Days of passed milestones to re-surface (audit 1-4): from the LAST SUCCESSFUL
 * scan date (inclusive — an unsent milestone shown that day is re-offered) up to
 * today, capped at CATCH_UP_MAX_DAYS. "" / invalid / a future date -> 0 (no
 * catch-up, the classic behavior).
 */
export function catchUpDaysSince(lastScanIso: string, todayD: PlainDate): number {
  const last = parseIso(lastScanIso);
  if (!last) return 0;
  return clampCatchUp(daysBetween(todayD, last));
}

/**
 * The catch-up anchor for the next scan's `sinceDate`: the last NON-degraded
 * successful scan. A degraded scan (미결 fetch failed) is missing Pass A and blocks
 * Pass B sends, so it must not move the anchor — otherwise milestones that passed
 * during consecutive degraded days are lost. Before the clean date was recorded
 * (pre-upgrade) fall back to the last scan's date.
 */
export function catchUpAnchor(
  lastCleanScanIso: string,
  lastScanIso: string,
  legacyLastScanLabel = "",
  todayD: PlainDate = todayLocal(),
): string {
  if (lastCleanScanIso || lastScanIso) return lastCleanScanIso || lastScanIso;
  // Upgrade from v1.2.16 (I1): neither ISO date was stored then, only the display
  // label last_scan_at ('M/D HH:MM'). Use its day; an unreadable label still proves
  // a scan happened, so take the full catch-up window. Never scanned -> no catch-up.
  const label = String(legacyLastScanLabel ?? "").trim();
  if (!label) return "";
  const legacy = parseLegacyScanLabel(label, todayD);
  return toIso(legacy ?? addDays(todayD, -CATCH_UP_MAX_DAYS));
}

/** The day of a v1.2.16 'M/D HH:MM' last-scan label: this year, or last year when
 *  that day is still ahead of `todayD` (a 12/30 label read on 1/5). null if invalid. */
function parseLegacyScanLabel(label: string, todayD: PlainDate): PlainDate | null {
  const m = /^(\d{1,2})\/(\d{1,2})(?:\s|$)/.exec(label);
  if (!m) return null;
  const [mo, d] = [Number(m[1]), Number(m[2])];
  const valid = (y: number): PlainDate | null => {
    const dt = makeDate(y, mo, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt : null;
  };
  const thisYear = valid(todayD.getFullYear());
  if (thisYear && daysBetween(thisYear, todayD) <= 0) return thisYear;
  // In the future this year (or 2/29 in a common year): it was last year's.
  return valid(todayD.getFullYear() - 1);
}

/**
 * True when the catch-up anchor is older than CATCH_UP_MAX_DAYS, so milestones that
 * passed before the cap were NOT re-surfaced (I3: the home tells the staff to check
 * the 미방문 list). Also true while 미결 조회 keeps degrading, since the clean anchor
 * does not move then. "" / invalid / future -> false.
 */
export function catchUpCapped(lastScanIso: string, todayD: PlainDate): boolean {
  const last = parseIso(lastScanIso);
  return !!last && daysBetween(todayD, last) > CATCH_UP_MAX_DAYS;
}

/**
 * True when open row `a` is a NEWER 개통 than `b` (U1): compares the PARSED opendate
 * (Poncle's 'yy-mm-dd', tolerating 'yyyy-mm-dd'), never the raw text, so mixed formats
 * order correctly. A parseable date beats an unparseable one; on the same day the
 * higher numeric Poncle idx (the later registration) wins; otherwise false, so the
 * first-seen row is kept. Order-independent whenever the rows differ in date or idx.
 */
export function isNewerOpenRow(a: PoncleRow, b: PoncleRow): boolean {
  const da = parseOpendate(String(a["opendate"] ?? ""));
  const db = parseOpendate(String(b["opendate"] ?? ""));
  if (!da || !db) return !!da && !db;
  const diff = daysBetween(da, db);
  if (diff !== 0) return diff > 0;
  const ia = rowIdx(a);
  const ib = rowIdx(b);
  return ia !== null && (ib === null || ia > ib);
}

function rowIdx(row: PoncleRow): number | null {
  const s = String(row["idx"] ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
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
  extendToToday: boolean,
  catchUpDays = 0,
): { sdate: string; edate: string } {
  const terms = positiveTerms(config);
  const maxTerm = terms.length ? Math.max(...terms) : 1;
  const minTerm = terms.length ? Math.min(...terms) : 1;
  const window = lookAheadDays(config);
  const buffer = Math.max(0, toInt(config.date_window_days, 3));
  const extra = Math.max(0, extraLookbackMonths);
  // expiry = today - extra - catchUp -> opendate = that - term (oldest we still fetch)
  const minOpen = addDays(addMonths(todayD, -maxTerm - extra), -buffer - clampCatchUp(catchUpDays));
  // Due upper: newest opendate whose expiry reaches the window edge (usually months
  // in the PAST). A scan must ALSO fetch re-activation rows — a returning customer's
  // new 개통 has opendate up to today — so latestOpenByPhone sees the newer contract
  // (auto-clears 미방문, and never surfaces the OLD contract's 만료 on home). Always
  // extend to today for a scan, regardless of the 미방문 look-back (audit 1-15).
  const dueUpper = addMonths(addDays(todayD, window), -minTerm);
  const upper = extendToToday && dueUpper.getTime() < todayD.getTime() ? todayD : dueUpper;
  const maxOpen = addDays(upper, buffer);
  return { sdate: toIso(minOpen), edate: toIso(maxOpen) };
}

/** Bounds for the classic due window only (expiry in [today, today+window]). */
export function candidateOpenDateBounds(
  config: AppConfig,
  todayD: PlainDate,
): { sdate: string; edate: string } {
  return openDateBounds(config, todayD, 0, false);
}

/**
 * Bounds for a full scan that also covers recently-expired customers, so the
 * same fetch feeds both the due list and the 미방문 list. Extends the lower
 * bound back by unvisited_lookback_months (+ `catchUpDays` of passed milestones),
 * and the upper bound always to today (re-contract rows).
 */
export function scanOpenDateBounds(
  config: AppConfig,
  todayD: PlainDate,
  catchUpDays = 0,
): { sdate: string; edate: string } {
  return openDateBounds(config, todayD, unvisitedLookbackMonths(config), true, catchUpDays);
}

/** Configured 미방문 tracking horizon in months (>= 0). */
export function unvisitedLookbackMonths(config: AppConfig): number {
  return Math.max(0, toInt(config.unvisited_lookback_months, 6));
}

/** Earliest expiry still counted as 미방문: today - unvisited_lookback_months. */
export function unvisitedFloor(config: AppConfig, todayD: PlainDate): PlainDate {
  return addMonths(todayD, -unvisitedLookbackMonths(config));
}

/** Human phrase for the alert text, from the signed days until expiry
 *  (expiry - today): '오늘 2026-06-15' / 'D-7 (2026-06-15)' / 'D+3 (2026-06-15)'
 *  once passed (never a misleading 'D-3' for an already-expired customer). */
export function formatWhen(offsetDays: number, expiry: PlainDate): string {
  const iso = toIso(expiry);
  if (offsetDays === 0) return `오늘 ${iso}`;
  if (offsetDays < 0) return `D+${-offsetDays} (${iso})`;
  return `D-${offsetDays} (${iso})`;
}
