/**
 * Home notice when a scan's catch-up hit its cap (audit I3). Milestones that
 * passed since the last clean scan are re-surfaced as D+N, but only for the last
 * CATCH_UP_MAX_DAYS days — after a longer gap (app unused, or the 요금제유지 미결
 * fetch failing day after day so the anchor never moves) older ones are silently
 * out of reach. The notice names the gap and where to look instead.
 */
import { CATCH_UP_MAX_DAYS } from "../domain/expiry";
import { daysBetween, parseIso, type PlainDate } from "../domain/plaindate";

export interface CatchUpCapOptions {
  /** This scan's 미결 fetch failed too (the anchor stays put while it does). */
  degraded: boolean;
}

/** Notice text, or null when the gap since `sinceIso` fits the catch-up window. */
export function catchUpCapNotice(sinceIso: string, todayD: PlainDate, opts: CatchUpCapOptions): string | null {
  const since = parseIso(String(sinceIso ?? "").trim());
  if (!since) return null;
  const days = daysBetween(todayD, since);
  if (!(days > CATCH_UP_MAX_DAYS)) return null;
  const day = `${since.getMonth() + 1}월 ${since.getDate()}일`;
  const lead = opts.degraded
    ? `요금제유지 미결 조회 실패가 이어져 마지막 정상 스캔(${day})부터 ${days}일이 지났습니다.`
    : `마지막 정상 스캔(${day})부터 ${days}일이 지났습니다.`;
  return `${lead} 그 사이 지난 안내는 최근 ${CATCH_UP_MAX_DAYS}일 것만 다시 표시했습니다 — 더 전에 만료된 고객은 이력 > 미방문 고객이나 조회에서 확인하세요`;
}
