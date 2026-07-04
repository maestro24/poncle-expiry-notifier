/**
 * 요금제 유지일(keepdate) scan pass. The 유지일 lives only in Poncle's 미결관리
 * (/pending/listPending, gubunx="요금제유지") as `pendingdate`; the open list has
 * the 개통 type/telecom but no 유지일. This module parses the pending rows, decides
 * which are due within the look-ahead window, exposes the phone blacklist that the
 * term pass must skip, and (given the joined open row) builds a DueItem. All pure;
 * fetching + joining is orchestrated in scan.ts.
 */
import { lookAheadDays } from "./expiry";
import { PlainDate, daysBetween, makeDate, toIso } from "./plaindate";
import type { AppConfig, DueItem, PoncleRow } from "./types";

/** Poncle 미결 gubunx value that carries the 요금제 유지일. */
export const KEEP_GUBUNX = "요금제유지";

function field(row: PoncleRow, name: string): string {
  const v = row[name];
  return v == null ? "" : String(v).trim();
}

/** Digits-only phone, for join + blacklist + dedup (format-insensitive). */
export function normalizePhone(s: unknown): string {
  return String(s ?? "").replace(/[^0-9]/g, "");
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

/**
 * Digits-phones of EVERY 요금제유지 pending (regardless of date or 접수/해결) — the
 * term pass blacklist. A customer with a 유지일 is judged only by that 유지일, so
 * the term calc must never surface them, even on an unrelated date.
 */
export function keepPhoneSet(rows: PoncleRow[]): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (!isKeepPending(r)) continue;
    const p = normalizePhone(field(r, "openphone") || field(r, "phone"));
    if (p) set.add(p);
  }
  return set;
}

/** A due 유지일 pending, before joining the open row. */
export interface KeepDueRow {
  phone: string; // display phone (as Poncle returns it)
  phoneDigits: string; // normalized, for join + dedup
  keepdateIso: string; // yyyy-mm-dd
  offset: number; // days until 유지일 (0..window)
  name: string; // customer-name fallback when the open join misses
}

/**
 * 요금제유지 pendings whose 유지일 is within [today, today+window] and not resolved
 * (condx !== "해결"). Past 유지일 and resolved rows are dropped.
 */
export function keepDueRows(rows: PoncleRow[], config: AppConfig, todayD: PlainDate): KeepDueRow[] {
  const window = lookAheadDays(config);
  const out: KeepDueRow[] = [];
  for (const r of rows) {
    if (!isKeepPending(r)) continue;
    if (field(r, "condx") === "해결") continue;
    const kd = parseKeepdate(field(r, "pendingdate"));
    if (kd === null) continue;
    const offset = daysBetween(kd, todayD); // 유지일 - today
    if (offset < 0 || offset > window) continue;
    const display = field(r, "openphone") || field(r, "phone");
    out.push({
      phone: display,
      phoneDigits: normalizePhone(display),
      keepdateIso: toIso(kd),
      offset,
      name: field(r, "name") || field(r, "customer"),
    });
  }
  return out;
}

/** Build the DueItem for a 유지일 row, joined to its open row (null when unmatched). */
export function keepDueItem(k: KeepDueRow, openRow: PoncleRow | null): DueItem {
  const o = openRow ?? {};
  return {
    id: `${k.phone}|${k.keepdateIso}`,
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
