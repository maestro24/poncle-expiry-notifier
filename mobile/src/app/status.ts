/**
 * Home status chrome: the scan-state badge, the session/error banners, the phone
 * clock-skew banner (#58) and the degraded-scan row check.
 */
import { clockSkewDays } from "../domain/plaindate";
import type { ScanState } from "../domain/scan";
import type { DueItem } from "../domain/types";
import { lastClockSkewMs } from "../native/adapters";
import { CLOCK_SKEW_TITLE, clockSkewDetail, evaluateClockSkew, serverNowIso, type ClockCheck } from "../ui/clock-skew";
import { $, toast } from "./dom";

/* ---------- state ---------- */
let SHOWN: ScanState = "idle";
/** The scan state the status badge shows now. */
export function shownState(): ScanState {
  return SHOWN;
}
export function renderState(state: ScanState): void {
  SHOWN = state;
  const map: Record<ScanState, { cls: string; text: string; busy: boolean }> = {
    idle: { cls: "", text: "대기중", busy: false },
    scanning: { cls: "is-busy", text: "스캔중", busy: true },
    session_expired: { cls: "is-expired", text: "세션만료", busy: false },
    error: { cls: "is-error", text: "오류", busy: false },
  };
  const m = map[state] ?? map.idle;
  $("#status-badge").className = "badge " + m.cls;
  $("#status-label").textContent = m.text;
  $("#status-spinner").classList.toggle("hidden", !m.busy);
}
export function showBanner(which: "session" | "error" | "none", errMsg?: string): void {
  $("#session-banner").classList.toggle("hidden", which !== "session");
  $("#error-banner").classList.toggle("hidden", which !== "error");
  if (which === "error" && errMsg) $("#error-sub").textContent = errMsg;
}

/** Scan-built rows whose 요금제 유지 시점 is unreliable (the 미결 fetch failed). The
 *  domain marks them `degraded: true`; sending them is blocked until a clean scan. */
export function isDegraded(item: DueItem): boolean {
  return !item.test && (item as DueItem & { degraded?: boolean }).degraded === true;
}
/** Phone date vs Poncle's server date (#58), re-judged right after every Poncle
 *  call (scan, session probe, 조회). Null = not known yet (never blocks). */
let CLOCK: ClockCheck | null = null;
export function refreshClockSkew(): void {
  // Judge from the skew measured when Poncle answered (does not age), so an offline
  // foreground probe a day later never flags a correct phone.
  const now = new Date();
  const next = evaluateClockSkew(serverNowIso(lastClockSkewMs(), now), now, clockSkewDays);
  if (next) CLOCK = next; // no fresh reading keeps the last verdict
  const on = !!CLOCK?.blocked;
  $("#clock-banner").classList.toggle("hidden", !on);
  if (on && CLOCK) $("#clock-sub").textContent = clockSkewDetail(CLOCK);
}
/** Re-judge the phone date from the latest Poncle answer; true while it is off (B10). */
export function clockSkewedNow(): boolean {
  refreshClockSkew();
  return !!CLOCK?.blocked;
}
/** True (and says why) when sending to a customer must wait for a correct date. */
export function clockBlocksSend(item: DueItem): boolean {
  if (item.test || !CLOCK?.blocked) return false;
  toast(`${CLOCK_SKEW_TITLE} (날짜가 맞을 때까지 발송할 수 없습니다)`, { err: true });
  return true;
}
