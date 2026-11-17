/**
 * 요금제 유지일(keepdate) scan pass. The 유지일 lives only in Poncle's 미결관리
 * (/pending/listPending, gubunx="요금제유지") as `pendingdate`; the open list has
 * the 개통 type/telecom but no 유지일. This module parses the pending rows, decides
 * which are due within the look-ahead window, exposes the phone blacklist that the
 * term pass must skip, and (given the joined open row) builds a DueItem. All pure;
 * fetching + joining is orchestrated in scan.ts.
 */
import { lookAheadDays } from "./expiry";
import { htmlUnescape } from "./html-entities";
import { PlainDate, daysBetween, makeDate, toIso } from "./plaindate";
import type { AppConfig, DueItem, PoncleRow } from "./types";

/** Poncle 미결 gubunx value that carries the 요금제 유지일. */
export const KEEP_GUBUNX = "요금제유지";

/** Raw Poncle field -> trimmed, entity-decoded text (same boundary rule as
 *  due-item.field; kept local to avoid an import cycle). */
function field(row: PoncleRow, name: string): string {
  const v = row[name];
  return v == null ? "" : htmlUnescape(String(v)).trim();
}

/** Digits-only phone, for join + blacklist + dedup (format-insensitive). */
export function normalizePhone(s: unknown): string {
  return String(s ?? "").replace(/[^0-9]/g, "");
}

/**
 * Canonical customer/contract key: normalized(phone)|expiry. The SINGLE source of
 * truth for every "phone|expiry" identity — DueItem.id, the sent-log dedup key, the
 * manual-제외 key, and the cohort key. Normalizing the phone here means a customer
 * whose number arrives hyphenated from one Poncle endpoint (미결) and bare from
 * another (개통) still resolves to ONE key, so already_sent / 재발송 / 제외 never
 * split across formats (double-send or silent miss). Display uses the raw phone;
 * only keys go through here.
 */
export function dueKey(phone: unknown, expiry: unknown): string {
  return `${normalizePhone(phone)}|${String(expiry ?? "").trim()}`;
}

/** Parse "yyyy-mm-dd" (tolerates "yy-mm-dd") to a local PlainDate; null if invalid. */
export function parseKeepdate(value: string): PlainDate | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const parts = v.split("-");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  let [y] = nums;
  const [, m, d] = nums;
  if (y < 100) y += 2000;
  const dt = makeDate(y, m, d);
  // Reject rolled-over invalid dates (JS Date silently normalises 2026-13-40).
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** True for a 요금제유지 pending row (guard against other 미결 categories). */
export function isKeepPending(row: PoncleRow): boolean {
  return field(row, "gubunx") === KEEP_GUBUNX;
}

/** The pending row's display phone (openphone, else phone). */
function pendingPhone(r: PoncleRow): string {
  return field(r, "openphone") || field(r, "phone");
}

/** yy-mm-dd / yyyy-mm-dd opendate -> local date (null when unknown). */
function parseOpen(row: PoncleRow | undefined): PlainDate | null {
  return row ? parseKeepdate(field(row, "opendate")) : null;
}

/**
 * True when a 유지일 belongs to a PREVIOUS contract: the phone's current (latest)
 * 개통 is newer than the 유지일. Such a pending must neither blacklist the current
 * contract's 1단계 nor surface as a 1단계 itself (audit 1-16).
 */
export function isStaleKeepdate(keepdate: PlainDate, latestOpenRow: PoncleRow | null | undefined): boolean {
  const od = parseOpen(latestOpenRow ?? undefined);
  return od !== null && od.getTime() > keepdate.getTime();
}

/**
 * Digits-phones whose 1단계 is judged by a 폰클 유지일 — the Pass B (개통+기본 개월)
 * blacklist. With `latestOpen` (phone digits -> current 개통 row), only a 유지일 on/after
 * the current contract's opendate counts: a 유지일 from an older contract no longer
 * hides the current one forever (audit 1-16). Resolution (접수/해결) is NOT a filter:
 * a 해결 유지일 of the current contract means 폰클 already handled that 1단계, so the
 * default-months fallback must not message the customer again. Without `latestOpen`
 * every 요금제유지 phone counts (legacy behavior).
 */
export function keepPhoneSet(rows: PoncleRow[], latestOpen?: ReadonlyMap<string, PoncleRow>): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (!isKeepPending(r)) continue;
    const p = normalizePhone(pendingPhone(r));
    if (!p) continue;
    if (latestOpen) {
      const kd = parseKeepdate(field(r, "pendingdate"));
      if (kd === null || isStaleKeepdate(kd, latestOpen.get(p))) continue;
    }
    set.add(p);
  }
  return set;
}

/**
 * Latest 유지일 per phone that belongs to the CURRENT contract (on/after the latest
 * 개통's opendate), any 접수/해결 — the customer's representative 요금제 유지 date for
 * 조회/미방문, so their keys match the home Pass A item (audit 1-9/1-10).
 */
export function currentKeepdates(rows: PoncleRow[], latestOpen: ReadonlyMap<string, PoncleRow>): Map<string, PlainDate> {
  const out = new Map<string, PlainDate>();
  for (const r of rows) {
    if (!isKeepPending(r)) continue;
    const p = normalizePhone(pendingPhone(r));
    const kd = parseKeepdate(field(r, "pendingdate"));
    if (!p || kd === null || isStaleKeepdate(kd, latestOpen.get(p))) continue;
    const prev = out.get(p);
    if (!prev || kd.getTime() > prev.getTime()) out.set(p, kd);
  }
  return out;
}

/** A due 유지일 pending, before joining the open row. */
export interface KeepDueRow {
  phone: string; // display phone (as Poncle returns it)
  phoneDigits: string; // normalized, for join + dedup
  keepdateIso: string; // yyyy-mm-dd
  offset: number; // days until 유지일 (-catchUp..window; negative = passed, D+N)
  name: string; // customer-name fallback when the open join misses
}

/**
 * 요금제유지 pendings whose 유지일 is within [today - catchUpDays, today+window] and
 * not resolved (condx !== "해결"). Resolved rows, rows without a phone (they would
 * all collapse onto one '|date' key) and older 유지일 are dropped. One row per phone:
 * the window is applied FIRST, then when a phone still has several unresolved 유지일
 * the LATEST one wins (audit 1-36 — a date correction leaving the old one 접수), so
 * the same 1단계 is never offered twice; a later 유지일 OUTSIDE the window never hides
 * a due one inside it (audit B2). `catchUpDays` (default 0 = classic) re-surfaces
 * 유지일 that passed since the last successful scan (audit 1-4).
 *
 * Policy (deliberate, pinned by tests/domain-r1 B2): when the same phone also has a
 * LATER unresolved 유지일 outside the window — possibly a 'date correction' whose old
 * 접수 row was left behind — the in-window 유지일 is STILL offered. 폰클 data can't
 * tell a correction from two real 유지일, and a possibly-stale alert the staff sees
 * (the confirm sheet shows the 유지일; 해결 the old 미결 in 폰클 to drop it) is safer
 * than the pre-B2 silent miss. Once the later 유지일 enters the window it wins.
 */
export function keepDueRows(rows: PoncleRow[], config: AppConfig, todayD: PlainDate, catchUpDays = 0): KeepDueRow[] {
  const window = lookAheadDays(config);
  const back = Math.max(0, Math.floor(Number(catchUpDays) || 0));
  const latestByPhone = new Map<string, { row: PoncleRow; kd: PlainDate }>();
  for (const r of rows) {
    if (!isKeepPending(r)) continue;
    if (field(r, "condx") === "해결") continue;
    const kd = parseKeepdate(field(r, "pendingdate"));
    const digits = normalizePhone(pendingPhone(r));
    if (kd === null || !digits) continue;
    const offset = daysBetween(kd, todayD); // 유지일 - today
    if (offset < -back || offset > window) continue; // window first (B2)
    const prev = latestByPhone.get(digits);
    if (!prev || kd.getTime() > prev.kd.getTime()) latestByPhone.set(digits, { row: r, kd });
  }
  const out: KeepDueRow[] = [];
  for (const [digits, { row, kd }] of latestByPhone) {
    const offset = daysBetween(kd, todayD);
    out.push({
      phone: pendingPhone(row),
      phoneDigits: digits,
      keepdateIso: toIso(kd),
      offset,
      name: field(row, "name") || field(row, "customer"),
    });
  }
  return out;
}

/** Build the DueItem for a 유지일 row, joined to its open row (null when unmatched). */
export function keepDueItem(k: KeepDueRow, openRow: PoncleRow | null): DueItem {
  const o = openRow ?? {};
  return {
    id: dueKey(k.phone, k.keepdateIso),
    phone: k.phone,
    customer: field(o, "customer") || k.name,
    opendate: field(o, "opendate"),
    expiry_date: k.keepdateIso,
    milestone_offset: k.offset,
    telecom: field(o, "telecomx") || field(o, "telecom"),
    agency: field(o, "agencytitle"),
    openhow: field(o, "openhowx"),
    plan: field(o, "plan"),
    model: field(o, "model"),
    staff: field(o, "membername") || field(o, "username"),
    already_sent: false,
    source: "keepdate",
  };
}
