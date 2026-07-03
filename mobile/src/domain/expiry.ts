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
  makeDate,
  sameDate,
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
 * Milestones for this row that land exactly on `today`. Returns [offsetDays,
 * expiryDate] pairs. A milestone fires when today == expiry - offsetDays.
 */
export function dueMilestones(
  row: PoncleRow,
  config: AppConfig,
  todayD: PlainDate,
): Array<[number, PlainDate]> {
  const expiry = computeExpiry(row, config);
  if (expiry === null) return [];
  const out: Array<[number, PlainDate]> = [];
  for (const offset of normalizedOffsets(config)) {
    if (sameDate(todayD, addDays(expiry, -offset))) {
      out.push([offset, expiry]);
    }
  }
  return out;
}

/**
 * Open dates that could produce a milestone today, used to narrow the
 * server-side date filter. For every (offset, term) pair,
 *   expiry = today + offset  and  opendate = expiry - term.
 * Includes the default term and every override term.
 */
export function candidateOpenDates(config: AppConfig, todayD: PlainDate): PlainDate[] {
  const terms = new Set<number>([
    toInt(config.default_term_months, 24),
    toInt(config.nonstandard_term_months, 6),
  ]);
  for (const months of Object.values(config.agency_term_months ?? {})) {
    const n = typeof months === "number" ? months : parseInt(String(months), 10);
    if (Number.isFinite(n)) terms.add(n);
  }
  const seen = new Map<number, PlainDate>();
  for (const offset of normalizedOffsets(config)) {
    const expiry = addDays(todayD, offset);
    for (const term of terms) {
      if (term <= 0) continue;
      const d = addMonths(expiry, -term);
      seen.set(d.getTime(), d);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.getTime() - b.getTime());
}

/** Human phrase for the alert text, e.g. '오늘 2026-06-15' / 'D-7 (2026-06-15)'. */
export function formatWhen(offsetDays: number, expiry: PlainDate): string {
  const iso = toIso(expiry);
  if (offsetDays === 0) return `오늘 ${iso}`;
  return `D-${offsetDays} (${iso})`;
}
