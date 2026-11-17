/**
 * Raw Poncle row -> DueItem builder, shared by the due scan (scan.ts) and the
 * 미방문 scan (unvisited.ts). Kept in its own module so neither imports the other.
 * Mirrors backend/scan.py._entry_from_row. `id` / `already_sent` are filled by
 * the caller.
 */
import { CATCH_UP_MAX_DAYS, parseOpendate } from "./expiry";
import { htmlUnescape } from "./html-entities";
import { PlainDate, daysUntil, parseIso, sameDate, toIso } from "./plaindate";
import type { DueItem, PoncleRow } from "./types";

/** Read a Poncle field as a trimmed, HTML-entity-decoded string ("" when absent).
 *  Poncle sends text HTML-escaped ("PS&amp;M"); this is THE data boundary where it
 *  is decoded — exactly once (raw rows are never re-read through here after
 *  decoding), so the UI (which esc()s at render) and SMS {agency}/{plan} get clean
 *  text (audit 1-34). */
export function field(row: PoncleRow, name: string): string {
  const v = row[name];
  return v == null ? "" : htmlUnescape(String(v)).trim();
}

/** Build a DueItem from an open-list row, its milestone offset, and its expiry. */
export function entryFromRow(row: PoncleRow, offset: number, expiry: PlainDate): DueItem {
  return {
    id: "",
    phone: field(row, "openphone"),
    customer: field(row, "customer"),
    opendate: field(row, "opendate"),
    expiry_date: toIso(expiry),
    milestone_offset: offset,
    telecom: field(row, "telecomx") || field(row, "telecom"),
    agency: field(row, "agencytitle"),
    openhow: field(row, "openhowx"),
    plan: field(row, "plan"),
    model: field(row, "model"),
    staff: field(row, "membername") || field(row, "username"),
    already_sent: false,
  };
}

/** Text fields of a DueItem that come from Poncle (HTML-escaped at the source). */
const DECODED_FIELDS = ["customer", "agency", "plan", "model", "staff", "telecom", "openhow"] as const;

/**
 * Decode HTML entities in a DueItem's Poncle text fields — for rows cached by an
 * older version (before field() decoded at the boundary) and restored from storage.
 * Clean text has no "&…;" sequence, so re-applying to an already-decoded row is a
 * no-op; an unchanged row is returned as the SAME object (pure otherwise).
 */
export function decodeDueItemText<T extends DueItem>(item: T): T {
  let out: T | null = null;
  for (const k of DECODED_FIELDS) {
    const v = item[k];
    if (typeof v !== "string" || v.indexOf("&") === -1) continue;
    const d = htmlUnescape(v);
    if (d === v) continue;
    out = out ?? { ...item };
    out[k] = d;
  }
  return out ?? item;
}

/** opendate as ISO for ordering ("yy-mm-dd"/"yyyy-mm-dd" both), else the raw text. */
function opendateKey(s: string): string {
  const d = parseOpendate(String(s ?? ""));
  return d ? toIso(d) : String(s ?? "");
}

/**
 * Home list order: unsent first; within each group the most urgent first — expiry
 * ascending, so overdue rows (negative D-day, past expiry) lead the unsent group.
 * Rows without a valid expiry go last in their group; ties break by 개통일 then phone
 * so the order is deterministic. Pure: returns a new array. Reuse after any
 * re-flagging (reconcile) so a just-sent row drops below the unsent ones.
 */
export function sortDueItems<T extends DueItem>(items: readonly T[]): T[] {
  const exp = (it: DueItem): string => (parseIso(it.expiry_date) ? it.expiry_date.trim() : "￿");
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return items.slice().sort((a, b) => {
    if (!!a.already_sent !== !!b.already_sent) return a.already_sent ? 1 : -1;
    return (
      cmp(exp(a), exp(b)) ||
      cmp(opendateKey(a.opendate), opendateKey(b.opendate)) ||
      cmp(String(a.phone ?? ""), String(b.phone ?? ""))
    );
  });
}

/**
 * Re-derive each cached due row's D-day (milestone_offset) from its expiry vs
 * `todayD`. A row whose milestone passed stays as overdue D+N while within
 * CATCH_UP_MAX_DAYS — when it is still unsent, or when the scan itself surfaced it
 * as overdue — exactly what a rescan's catch-up would show, so an unsent 'D-0' from
 * a closed day isn't silently lost until the user taps 스캔 (audit 1-4). Past the cap
 * (or already handled) it is dropped (those belong to 미방문). A row whose expiry
 * can't be parsed is kept untouched. Pure: returns new objects, so a list cached
 * days ago never shows the scan day's D-day (or 'D-3' for an already-passed one).
 */
export function refreshDueOffsets(items: readonly DueItem[], todayD: PlainDate): DueItem[] {
  const out: DueItem[] = [];
  for (const it of items) {
    const days = daysUntil(it.expiry_date, todayD);
    if (days === null) { out.push(it); continue; }
    const keepOverdue = days >= -CATCH_UP_MAX_DAYS && (Number(it.milestone_offset) < 0 || !it.already_sent);
    if (days < 0 && !keepOverdue) continue;
    out.push(days === it.milestone_offset ? it : { ...it, milestone_offset: days });
  }
  return out;
}

/**
 * Home notice for a due list that did NOT come from a scan today, or null when it
 * is fresh. `scanDateIso` is the cached list's scan date ("" for a cache saved
 * before the date was recorded); `count` is how many rows are shown. Never-scanned
 * (no date, nothing cached) -> null.
 */
export function staleScanNotice(scanDateIso: string, todayD: PlainDate, count: number): string | null {
  const scanned = parseIso(scanDateIso);
  if (scanned) {
    if (sameDate(scanned, todayD)) return null;
    return `${scanned.getMonth() + 1}월 ${scanned.getDate()}일 스캔 결과입니다 — 지금 다시 스캔하세요`;
  }
  return count > 0 ? "이전에 저장된 스캔 결과입니다 — 지금 다시 스캔하세요" : null;
}

/**
 * Confirm prompt before sending from a due list that did NOT come from a scan
 * today (a customer may have re-contracted or left since), or null when the list
 * is today's. The banner alone is advisory; this makes the send an explicit choice.
 */
export function staleSendWarning(scanDateIso: string, todayD: PlainDate): string | null {
  const scanned = parseIso(scanDateIso);
  if (scanned && sameDate(scanned, todayD)) return null;
  const when = scanned ? `${scanned.getMonth() + 1}월 ${scanned.getDate()}일 스캔 결과입니다` : "이전에 저장된 스캔 결과입니다";
  return `${when}.\n그 사이 재약정·해지된 고객일 수 있습니다. 지금 다시 스캔하는 것을 권장합니다.\n\n그래도 보낼까요?`;
}
