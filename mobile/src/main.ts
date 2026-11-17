/**
 * App entry for 약정만료 알리미 (Android): wires the DOM to the screen modules
 * (src/app, src/screens) and boots the app on import. Framework-free vanilla TS.
 */
import { loadConfig, seedDefaultTemplates } from "./domain/config";
import { refreshDueOffsets } from "./domain/due-item";
import { today } from "./domain/plaindate";
import { scanSignature } from "./domain/scan-settings";
import { capacitorCacheFs, purgeExportFiles } from "./ui/export-files";
import { installViewportVars } from "./ui/viewport";
import { type Screen, history, S } from "./app/state";
import { installHooks } from "./app/hooks";
import { $, $$ } from "./app/dom";
import { renderState } from "./app/status";
import { reconcileSentFlags } from "./app/sent-state";
import { UPDATE_POLL_MS, checkUpdate } from "./screens/update";
import { refreshHome, probeSession } from "./app/session";
import { reconcileSendResults } from "./screens/send-results";
import { bindConfirmSheet } from "./screens/send";
import { renderDueList, refreshHomeSendState, addTestTarget, bindHomeFilters } from "./screens/home";
import { doScan, doLogin } from "./screens/scan";
import { renderDashboard } from "./screens/dashboard";
import { bindHistory } from "./screens/history";
import { loadRecent, bindLookup } from "./screens/lookup";
import { onSettingsSave, bindTerms, bindSettings } from "./screens/settings";
import { bindBackup } from "./screens/backup";
import { bindTemplates } from "./screens/templates";
import { maybeOnboard, bindOnboarding } from "./screens/onboarding";
import { showScreen, navigate, handleHardwareBack, rerenderCurrent } from "./app/nav";

/* ---------- wire up ---------- */
function bind(): void {
  $$("[data-nav]").forEach((b) => (b.onclick = () => void navigate(b.dataset.nav as Screen)));
  $("#btn-scan").onclick = () => void doScan();
  $("#btn-login").onclick = () => void doLogin();
  $("#btn-retry").onclick = () => void doScan();
  $("#btn-stale-scan").onclick = () => void doScan();
  $("#btn-degraded-scan").onclick = () => void doScan();
  $("#btn-test-target").onclick = () => void addTestTarget();

  // Returning to the foreground: re-check the session so a stale "세션 만료" banner
  // clears once the native layer has restored the persisted cookie, and re-check for
  // a new app release so the 업데이트 prompt appears during use (both are debounced).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void onForeground();
      void checkUpdate();
    }
  });

  bindHomeFilters();
  bindConfirmSheet();

  // Android hardware back (MainActivity asks this first): dialogs/sheets close like
  // 취소, sub-screens go to their parent; false only on home with nothing open.
  (window as unknown as { __poncleHandleBack?: () => boolean }).__poncleHandleBack = handleHardwareBack;

  bindTemplates();
  bindTerms();
  bindHistory();
  bindLookup();
  bindSettings();
  bindBackup();

  $("#btn-save").onclick = () => void onSettingsSave();

  bindOnboarding();
}

/**
 * Returning to the foreground: re-derive the cached list's D-days (the day may
 * have changed while backgrounded), drain native send results, and re-probe the
 * session once. We never force a scan; the user taps 스캔 when ready.
 */
async function onForeground(): Promise<void> {
  if (!S.SCANNING) {
    S.RESULTS = refreshDueOffsets(S.RESULTS, today());
    if (S.CURRENT === "home") renderDueList();
  }
  // Send state may have changed while away (another tab's send, a restore): re-derive.
  void refreshHomeSendState();
  void reconcileSendResults();
  if (S.SCANNING) return; // a scan owns the session/banner; don't race it
  await probeSession();
}

/* ---------- boot ---------- */
/** Boot steps that failed (U6): each step is isolated, so a storage read failure
 *  never stops the update check, the timers or the first render. */
const BOOT_FAILED: string[] = [];

/** Run one boot step; a throw is recorded (banner) instead of aborting boot. */
async function bootStep(name: string, fn: () => Promise<void> | void): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    BOOT_FAILED.push(name);
    return false;
  }
}

/** The saved settings, retried once (a transient bridge hiccup at cold start). */
async function loadConfigWithRetry(): Promise<void> {
  try {
    S.CFG = await loadConfig();
  } catch {
    S.CFG = await loadConfig();
  }
}

/** Home banner naming what could not be loaded at start (U6). */
function showBootErrors(): void {
  const box = document.querySelector<HTMLElement>("#boot-error-banner");
  if (!box || !BOOT_FAILED.length) return;
  const sub = document.querySelector<HTMLElement>("#boot-error-sub");
  if (sub) {
    sub.textContent = S.CONFIG_READ_FAILED
      ? "설정을 읽지 못해 기본값으로 표시하고, 설정 변경은 저장하지 않습니다. 앱을 완전히 닫았다가 다시 여세요."
      : `불러오지 못한 항목: ${BOOT_FAILED.join(", ")} — 앱을 완전히 닫았다가 다시 여세요.`;
  }
  box.classList.remove("hidden");
}

async function boot(): Promise<void> {
  installViewportVars(window); // modals stay above the soft keyboard (#47)
  // Exported CSV/backup files left in the cache by an earlier share hold customer
  // data: remove them now that any receiving app has had its chance (L6).
  void purgeExportFiles(capacitorCacheFs()).catch(() => undefined);
  // 기본 템플릿 2종 최초 1회 주입 (이후 수정/삭제 자유). 손대지 않은 옛 기본 문구는
  // loadConfig(withDefaults)가 새 문구로 바꾼다 — 사용자가 고친 문구는 그대로 (#60/#61).
  await bootStep("기본 템플릿", () => seedDefaultTemplates());
  // Unreadable settings (U6): keep DEFAULTS on screen but never write them back over
  // the user's real settings (S.CONFIG_READ_FAILED blocks every settings save).
  if (!(await bootStep("설정", loadConfigWithRetry))) S.CONFIG_READ_FAILED = true;
  S.SCAN_SIG = scanSignature(S.CFG); // the cached list is taken as built with the saved settings
  // Wire the UI only now (L1): before S.CFG is loaded, 설정 would show DEFAULTS and
  // its leave-auto-save would write them over the user's settings (실제 발송 off).
  bind();
  await bootStep("제외 이력 정리", async () => {
    await history.migrateRecontacted(); // v1.1.x 연락완료 -> 제외(handled), one-time
    await history.migrateLegacyExclusions(); // v1.2.16 제외 -> + 계약 키(B8), one-time
  });
  await bootStep("최근 검색어", () => loadRecent()); // 조회 최근 검색어
  await bootStep("마지막 스캔", async () => {
    S.LAST_SCAN = await history.getLastScan(); // 대시보드/홈 마지막 스캔 표시 복원
    if (S.LAST_SCAN) $("#last-scan").textContent = S.LAST_SCAN;
  });
  // 마지막 스캔 결과를 캐시에서 복원해 홈을 즉시 표시(자동 재스캔 없음). 새로고침은 수동 버튼.
  // D-day는 스캔 당시 값이 아니라 오늘 기준으로 다시 계산하고, 이미 만료된 고객은 뺀다
  // (미방문 탭 담당). 스캔일이 오늘이 아니면 홈에 '○월 ○일 스캔 결과' 안내가 뜬다.
  // 발송 상태는 캐시가 아니라 실제 이력 기준으로 보정(다른 탭에서 보낸 건 반영).
  await bootStep("대상 목록", async () => {
    S.SCAN_DATE = await history.getDueCacheDate();
    S.RESULTS = refreshDueOffsets(await history.loadDueList(), today());
  });
  await bootStep("발송 이력", () => reconcileSentFlags());
  await bootStep("화면 표시", () => {
    renderDueList();
    renderState("idle");
  });
  showBootErrors();
  // 지난 실행 중/후에 도착한 발송 결과(실패) 반영 — 홈 표시 후 비동기로.
  void reconcileSendResults();
  // Onboarding first-run gates the session check: finishOnb() calls refreshHome()
  // after the login step, so we don't show the login banner over a fresh login.
  let onboarding = false;
  await bootStep("시작 안내", async () => { onboarding = await maybeOnboard(); });
  if (!onboarding) await bootStep("폰클 세션", () => refreshHome());
  void checkUpdate().catch(() => undefined);
  // Keep checking while the app runs (Android throttles this timer when backgrounded;
  // the visibilitychange handler covers foreground returns).
  window.setInterval(() => void checkUpdate().catch(() => undefined), UPDATE_POLL_MS);
}

installHooks({ showScreen, rerenderCurrent, renderDashboard });
void boot();
