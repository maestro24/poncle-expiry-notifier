/**
 * 이력 screen search/paging types and the pure record filter behind
 * History.search/searchPage. Split out of history.ts; re-exported from there.
 */
import { normalizePhone } from "./keepdate";
import type { SentRecord } from "./sent-record";

/** Rows per 이력 page (searchPage default). */
export const HISTORY_PAGE_SIZE = 200;

export interface HistoryPageQuery {
  query?: string;
  /** Inclusive ISO date bounds on sent_at. */
  start?: string;
  end?: string;
  offset?: number;
  limit?: number;
}

export interface HistoryPage {
  rows: SentRecord[];
  /** Number of records matching the filter (all pages). */
  total: number;
  offset: number;
  hasMore: boolean;
}

/** True for a phone-number-like search (>= 3 digits, no Hangul/Latin letters), which
 *  is then compared by digits; anything else is a name search (audit L2 — "홍1" must
 *  not match every phone containing a 1). */
export function isPhoneQuery(query: string): boolean {
  const q = String(query ?? "");
  return normalizePhone(q).length >= 3 && !/[A-Za-zㄱ-ㆎ가-힣]/.test(q);
}

export function filterHistory(all: readonly SentRecord[], query: string, start: string, end: string): SentRecord[] {
  const q = String(query ?? "").trim().toLowerCase();
  const qDigits = isPhoneQuery(q) ? normalizePhone(q) : "";
  let rows = all.slice();
  if (q) {
    rows = rows.filter(
      (r) =>
        String(r.customer ?? "").toLowerCase().includes(q) ||
        String(r.phone ?? "").toLowerCase().includes(q) ||
        (qDigits !== "" && normalizePhone(r.phone).includes(qDigits)),
    );
  }
  const day = (r: SentRecord) => String(r.sent_at ?? "").slice(0, 10);
  if (start) rows = rows.filter((r) => day(r) >= start);
  if (end) rows = rows.filter((r) => day(r) <= end);
  const at = (r: SentRecord) => String(r.sent_at ?? "");
  return rows.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
}
