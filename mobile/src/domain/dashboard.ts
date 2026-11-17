/**
 * Pure aggregations for the 대시보드. No I/O — the app layer feeds cached rows
 * (send history, last scan's due list) and renders the returned view data.
 */
import { PlainDate, addDays, toIso } from "./plaindate";

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

export interface TrendDay {
  dateIso: string;
  dayLabel: string; // 요일 (월/화/…)
  count: number;
}

/** An earlier counted send kept behind a 재발송 (history.ts PrevSend). */
interface TrendPrev {
  sent_at: string;
  prev_sent?: TrendPrev;
}

/** The send-log fields the trend reads (a SentRecord satisfies it). */
export interface TrendRecord {
  sent_at: string;
  channel: string;
  delivery?: string;
  prev_sent?: TrendPrev;
  first_sent_at?: string;
  send_count?: number;
}

/**
 * The sent_at of every real send behind one record (audit L25): the record itself
 * when it is a counted SMS, each earlier send kept in its 재발송 prev_sent chain, and —
 * once a confirmed resend dropped the chain — the first send (first_sent_at) while
 * send_count says it is not already among them. Sends between the first and the
 * latest whose time was not kept can't be placed and are left out.
 */
function sendTimes(r: TrendRecord): string[] {
  const out: string[] = [];
  if (r.channel === "sms" && r.delivery !== "failed" && r.sent_at) out.push(r.sent_at);
  for (let p = r.prev_sent; p; p = p.prev_sent) if (p.sent_at && !out.includes(p.sent_at)) out.push(p.sent_at);
  const count = typeof r.send_count === "number" && Number.isInteger(r.send_count) ? r.send_count : out.length;
  const first = r.first_sent_at;
  if (first && out.length < count && !out.includes(first)) out.push(first);
  return out;
}

/** Daily REAL send counts for the last `days` days (oldest → newest). Only a real
 *  SMS that wasn't reported failed counts — skips, practice (record-only) records
 *  and failed sends are excluded. A 재발송 does not move the earlier send to the
 *  resend day: each send counts on the day it was sent (L25). */
export function sentTrend(
  records: ReadonlyArray<TrendRecord>,
  todayD: PlainDate,
  days = 7,
): TrendDay[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const at of sendTimes(r)) {
      const d = at.slice(0, 10);
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  const out: TrendDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(todayD, -i);
    const iso = toIso(date);
    out.push({ dateIso: iso, dayLabel: WEEKDAY[date.getDay()], count: counts.get(iso) ?? 0 });
  }
  return out;
}

export interface CarrierCount {
  name: string;
  count: number;
}

/** Count due customers by telecom, largest first (top `limit`). */
export function carrierBreakdown(
  items: ReadonlyArray<{ telecom: string }>,
  limit = 6,
): CarrierCount[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const name = (it.telecom || "").trim() || "미상";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit));
}
