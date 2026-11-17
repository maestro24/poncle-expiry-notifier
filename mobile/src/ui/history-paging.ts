/**
 * 이력 화면 paging (#59): the whole matching history is counted and shown a page at
 * a time ('더 보기'), instead of being silently cut at 1000 records. Storage is the
 * same single JSON log; only the rendering is paged.
 */

/** Records rendered per '더 보기' step. */
export const HISTORY_PAGE = 200;

export interface HistoryPage<T> {
  visible: T[];
  total: number;
  remaining: number;
}

/** The first `shown` rows (newest first, as given) plus the real total. Pure. */
export function historyPage<T>(rows: readonly T[], shown: number): HistoryPage<T> {
  const n = Math.max(0, Math.min(rows.length, Math.trunc(shown) || 0));
  return { visible: rows.slice(0, n), total: rows.length, remaining: rows.length - n };
}

/** Count line above the list: the REAL total, and how many are on screen. */
export function historyCountLabel(total: number, visible: number): string {
  if (total <= 0) return "";
  const fmt = (n: number) => n.toLocaleString("ko-KR");
  return visible < total ? `총 ${fmt(total)}건 중 ${fmt(visible)}건 표시` : `${fmt(total)}건`;
}

/** The 재발송 bookkeeping a history record may carry (#57; absent on old records). */
export interface FirstSendFields {
  sent_at?: string;
  first_sent_at?: unknown;
  send_count?: unknown;
}

/** '최초 발송 YYYY-MM-DD · N회' for a customer messaged more than once; "" otherwise. */
export function firstSendNote(r: FirstSendFields): string {
  const count = typeof r.send_count === "number" && Number.isInteger(r.send_count) ? r.send_count : 0;
  if (count < 2) return "";
  const first = typeof r.first_sent_at === "string" ? r.first_sent_at.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(first) ? `최초 발송 ${first} · ${count}회` : `${count}회 발송`;
}
