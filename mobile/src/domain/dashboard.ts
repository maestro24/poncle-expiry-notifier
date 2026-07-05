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

/** Daily send counts for the last `days` days (oldest → newest). Skips 'skipped'. */
export function sentTrend(
  records: ReadonlyArray<{ sent_at: string; channel: string }>,
  todayD: PlainDate,
  days = 7,
): TrendDay[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.channel === "skipped") continue;
    const d = (r.sent_at || "").slice(0, 10);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
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
