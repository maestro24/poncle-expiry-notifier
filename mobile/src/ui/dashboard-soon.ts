/**
 * 대시보드 '임박 고객' (L24): the customers still waiting for their 안내 — unsent,
 * expiring within D-3 or already past it within the catch-up window (D+N rows the
 * home list keeps as sendable). The 미방문 count leaves out customers that are on
 * the due list, so one customer is never counted in both.
 */
import { CATCH_UP_MAX_DAYS } from "../domain/expiry";
import { daysUntil, type PlainDate } from "../domain/plaindate";
import type { DueItem } from "../domain/types";

export interface SoonRow {
  r: DueItem;
  /** Days until expiry (negative once past: D+N). */
  dd: number;
}

export interface SoonOptions {
  aheadDays?: number;
  catchUpDays?: number;
  limit?: number;
}

export function dashboardSoon(due: readonly DueItem[], todayD: PlainDate, opts: SoonOptions = {}): SoonRow[] {
  const ahead = opts.aheadDays ?? 3;
  const back = opts.catchUpDays ?? CATCH_UP_MAX_DAYS;
  const out: SoonRow[] = [];
  for (const r of due) {
    if (r.test || r.already_sent) continue;
    const dd = daysUntil(r.expiry_date, todayD);
    if (dd === null || dd > ahead || dd < -back) continue;
    out.push({ r, dd });
  }
  return out.sort((a, b) => a.dd - b.dd).slice(0, opts.limit ?? 6);
}

/** 미방문 rows that are not also on the due list (by customer key). */
export function unvisitedNotDue(unvisited: readonly DueItem[], due: readonly DueItem[]): DueItem[] {
  const dueIds = new Set(due.filter((r) => !r.test).map((r) => r.id));
  return unvisited.filter((r) => !dueIds.has(r.id));
}
