/**
 * Scan: runs the Poncle scan, the scan buttons, settings-change rescans (#35) and
 * the home 로그인 button.
 */
import { catchUpAnchor } from "../domain/expiry";
import { today, toIso } from "../domain/plaindate";
import { SCAN_TRUNCATED_MESSAGE, runScan } from "../domain/scan";
import { scanSettingsAction, scanSignature } from "../domain/scan-settings";
import { nativePoncleGateway, poncleLogin } from "../native/adapters";
import { history, S } from "../app/state";
import { hooks } from "../app/hooks";
import { $, nowShort, toast } from "../app/dom";
import { renderState, showBanner, clockSkewedNow } from "../app/status";
import { withCohortGuard } from "../ui/clock-skew";
import { catchUpCapNotice } from "../ui/catchup-notice";
import { reconcileSentFlags } from "../app/sent-state";
import { renderDueList } from "./home";

/* ---------- scan ---------- */
/** Shown when a scan throws instead of answering (U5): the badge/buttons must not
 *  stay on '스캔중'. */
export const SCAN_CRASH_MESSAGE = "스캔 중 오류가 발생했습니다 — 다시 시도하세요";

export async function doScan(): Promise<void> {
  // Re-entry guard across ALL entry points (홈 #btn-scan, 대시보드 #dash-scan,
  // 배너 #btn-retry). Each button only disables itself, so without this a scan
  // started from one screen could run in parallel with another and let two scans
  // race their S.RESULTS/cache writes (last-writer-wins, unpredictable final state).
  if (S.SCANNING) return;
  S.SCANNING = true; // a scan owns the session/error banner until it finishes
  S.SESSION_EPOCH++; // any probe already in flight is now stale (L1)
  renderState("scanning");
  syncScanButtons();
  const scanSig = scanSignature(S.CFG); // the settings this scan is built with (#35)
  SCAN_INFLIGHT_SIG = scanSig;
  try {
    // sinceDate = the last successful NON-degraded scan's day: milestones that passed
    // since then (closed days, or days whose scan lacked the 미결 list) come back as
    // overdue D+N instead of being lost (audit 1-4). Pre-upgrade -> S.SCAN_DATE.
    // One 'today' for the whole scan (L3): a scan that runs past midnight is stored
    // under the day its D-days were computed for, not the next one.
    const todayD = today();
    const cleanDate = await history.getCleanScanDate().catch(() => "");
    // I1: after an upgrade from v1.2.16 neither ISO date exists yet — the stored
    // '마지막 스캔' label (S.LAST_SCAN, 'M/D HH:MM') anchors the first catch-up.
    const sinceDate = catchUpAnchor(cleanDate, S.SCAN_DATE, S.LAST_SCAN, todayD);
    // B10: with a wrong phone date every 'today'-based write is wrong for good — the
    // cohort (judged when runScan writes it, after the scan's own Poncle answers
    // carried the server date) and, below, the catch-up anchor and the caches.
    const store = withCohortGuard(history, clockSkewedNow);
    const res = await runScan(nativePoncleGateway(S.CFG), S.CFG, store, todayD, { sinceDate });
    const skewed = clockSkewedNow(); // the scan's responses carried Poncle's date (#58)
    // A failed scan leaves the old list in place — it must NOT look freshly
    // scanned, so '마지막 스캔' (and the cache's scan date) move only on success.
    if (res.status === "session_expired") {
      S.SESSION = "expired";
      showBanner("session");
      renderState("session_expired");
      return;
    }
    if (res.status === "error") {
      showBanner("error", res.error);
      renderState("error");
      toast(res.error || "스캔 실패", { err: true });
      return;
    }
    S.SESSION = "ok";
    S.SCAN_SIG = scanSig;
    showBanner("none");
    S.PENDING_DEGRADED = res.pendingDegraded;
    S.RESULTS = res.results;
    await reconcileSentFlags(); // 기록 상태 배지(기록만 됨/발송 실패) + 스캔 중 발송 반영
    if (skewed) {
      // 휴대폰 날짜가 틀린 스캔(B10): 목록은 보여 주되(발송은 막힘) 날짜 기준 상태 —
      // 스캔일·catch-up 기준일·대상/미방문 캐시·마지막 스캔 — 는 저장하지 않는다.
      // 날짜를 고친 뒤 스캔하면 그 사이 지나간 안내가 catch-up으로 다시 잡힌다.
      renderDueList();
      renderState("idle");
      toast("휴대폰 날짜가 실제와 달라 이번 스캔 결과는 저장하지 않았습니다 — 날짜를 맞춘 뒤 다시 스캔하세요", { err: true });
      return;
    }
    S.LAST_SCAN = nowShort();
    $("#last-scan").textContent = S.LAST_SCAN;
    void history.setLastScan(S.LAST_SCAN); // 대시보드가 재시작 후에도 표시하도록 영속화
    S.SCAN_DATE = toIso(todayD);
    await history.cacheDueList(S.RESULTS, S.SCAN_DATE); // 대시보드 3숫자/임박/통신사 캐시 + 스캔일
    // 미결 조회가 저하됐거나 페이지 상한에 걸려 잘린(L4) 스캔은 목록이 불완전하다 —
    // catch-up 기준일을 옮기지 않고(다음 스캔이 그 사이를 다시 본다) 미방문 캐시도
    // 덮어쓰지 않는다(이전 정상 스캔 결과 유지). 정상 스캔에서만 갱신.
    const complete = !res.pendingDegraded && !res.truncated;
    if (complete) await history.setCleanScanDate(S.SCAN_DATE);
    if (complete) await history.cacheUnvisited(res.unvisited);
    // I3: a gap longer than the catch-up window (or 미결 failing day after day, so
    // the anchor never moves) leaves older passed milestones out — say so on home.
    // The domain's res.catchUpCapped decides when present; the text names the gap.
    S.CATCHUP_NOTICE = res.catchUpCapped === false
      ? ""
      : catchUpCapNotice(sinceDate, todayD, { degraded: !!res.pendingDegraded }) ?? "";
    renderDueList();
    renderState("idle");
    // A paging safety cap stopped a fetch that still had full pages (audit 3-7).
    if (res.truncated) toast(SCAN_TRUNCATED_MESSAGE, { err: true });
  } catch {
    // U5: an unexpected throw (storage, bridge) — the old list stays; the scan state
    // must still end, visibly, with a way to retry.
    showBanner("error", SCAN_CRASH_MESSAGE);
    renderState("error");
    toast(SCAN_CRASH_MESSAGE, { err: true });
  } finally {
    S.SCANNING = false; // release the banner before re-enabling the buttons
    syncScanButtons();
    if (S.CURRENT === "dashboard") void hooks.renderDashboard(); // fresh numbers on whichever screen started it
  }
}

/** Every scan button (홈 + 대시보드) reflects S.SCANNING: disabled with '스캔 중…'. */
function syncScanButtons(): void {
  const home = $<HTMLButtonElement>("#btn-scan");
  home.dataset.label ??= home.textContent ?? "";
  home.disabled = S.SCANNING;
  home.textContent = S.SCANNING ? "스캔 중…" : home.dataset.label;
  const dash = document.querySelector<HTMLButtonElement>("#dash-scan");
  if (dash) {
    dash.disabled = S.SCANNING;
    dash.textContent = S.SCANNING ? "스캔 중…" : "지금 스캔";
  }
}


/** scanSignature the user was last told "다음 스캔부터 반영" about (no repeat toasts). */
let SCAN_SIG_NOTIFIED = "";
/** scanSignature the in-flight scan was started with (valid while S.SCANNING). */
let SCAN_INFLIGHT_SIG = "";
/** scanSignature of the last rescan a settings change started (D5). */
let SETTINGS_RESCAN_SIG = "";
const RESCAN_MESSAGE = "저장했습니다 — 바뀐 기준으로 다시 스캔합니다";

/** After 안내 시점/개월 수 were saved (#35) — by 설정 저장 OR by the auto-save on
 *  leaving 설정/약정 기간: rescan right away with a live session, else say plainly
 *  when it takes effect. `explicit` = the 저장 button (always acknowledges). */
export async function applyScanSettings(explicit: boolean): Promise<void> {
  renderDueList();
  const sig = scanSignature(S.CFG);
  // A scan already running with these very settings will show them.
  const shownSig = S.SCANNING && SCAN_INFLIGHT_SIG === sig ? sig : S.SCAN_SIG;
  const action = scanSettingsAction(sig, shownSig, explicit ? "" : SCAN_SIG_NOTIFIED, {
    scanning: S.SCANNING,
    sessionOk: S.SESSION === "ok",
  });
  if (action === "none") {
    // D5: 화면을 나갈 때의 자동 저장이 먼저 다시 스캔을 시작했으면, 저장 버튼에도
    // '다시 스캔'이라고 답한다 (그 스캔이 바로 이 설정으로 돌고 있다).
    if (explicit) toast(S.SCANNING && SCAN_INFLIGHT_SIG === sig && SETTINGS_RESCAN_SIG === sig ? RESCAN_MESSAGE : "저장되었습니다");
    return;
  }
  if (action === "rescan") {
    toast(RESCAN_MESSAGE);
    SETTINGS_RESCAN_SIG = sig;
    await doScan();
    return;
  }
  SCAN_SIG_NOTIFIED = sig;
  toast(action === "after-running-scan"
    ? "저장했습니다 — 지금 진행 중인 스캔에는 반영되지 않아 다음 스캔부터 반영됩니다"
    : "저장했습니다 — 다음 스캔부터 반영됩니다");
}

/* ---------- login ---------- */
export async function doLogin(): Promise<void> {
  const ok = await poncleLogin(S.CFG);
  if (ok) {
    showBanner("none");
    await doScan();
  }
}
