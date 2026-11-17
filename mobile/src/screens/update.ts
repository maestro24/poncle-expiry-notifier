/**
 * App update check + the 업데이트 prompt (boot, foreground, 30-min poll, manual).
 */
import { checkForUpdate, type UpdateInfo } from "../domain/updater";
import { Preferences } from "@capacitor/preferences";
import { getAppVersion, openExternalUrl } from "../native/adapters";
import { getDeviceSdkInt } from "../native/appupdate";
import { appAlert } from "../ui/dialog";
import { closeModal, openModal } from "../ui/modal";
import { updateRetryDelayMs } from "../ui/update-backoff";
import { releaseNotesForDisplay, unsupportedUpdateNotice } from "../ui/update-notice";
import { $, $$, toast } from "../app/dom";

/* ---------- update ---------- */
// Checked at boot, on every foreground return, and on a 30-min timer while running,
// so a new release surfaces the 설치 prompt during use — not only after a restart.
export const UPDATE_POLL_MS = 30 * 60 * 1000; // background poll cadence while foregrounded
const UPDATE_MIN_GAP_MS = 20 * 60 * 1000; // min gap between actual GitHub checks (rate-limit friendly)
let lastUpdateCheck = 0; // ms of the last check whose result was handled (in-memory debounce)
let updateDismissedVersion = "";
/** Consecutive failed AUTO checks (U8): the next auto check waits
 *  updateRetryDelayMs(n) after the last failure. Any handled answer resets it. */
let autoFailures = 0;
let lastAutoFailure = 0;

/** A check whose answer was handled: debounce from now, clear the failure backoff. */
function markHandled(): void {
  lastUpdateCheck = Date.now();
  autoFailures = 0;
} // version the user dismissed — muted THIS session only
/** Release version whose 'can't install on this phone' notice was shown (persisted:
 *  the notice is one-time per release, not every start — B15). */
const UNSUPPORTED_NOTICE_KEY = "update_unsupported_notified";

/** One network check's answer; info null = the installed version is unknown. */
interface UpdateCheckOutcome { current: string; info: UpdateInfo | null; sdkInt?: number }
/** The check in flight, shared by every caller (a manual tap during an auto check
 *  awaits the same request instead of being ignored). */
let updateInflight: Promise<UpdateCheckOutcome> | null = null;
function runUpdateCheck(): Promise<UpdateCheckOutcome> {
  if (updateInflight) return updateInflight;
  const run = (async (): Promise<UpdateCheckOutcome> => {
    const current = await getAppVersion().catch(() => "");
    if (!current || current === "0.0.0") return { current: "", info: null };
    // The device API level lets the check skip a release this phone can't install.
    const sdkInt = await getDeviceSdkInt().catch(() => undefined);
    try {
      return { current, info: await checkForUpdate(current, sdkInt), sdkInt };
    } catch {
      return { current, info: { available: false, version: "", url: "", notes: "", error: "확인 실패" }, sdkInt };
    }
  })();
  updateInflight = run;
  void run.finally(() => { if (updateInflight === run) updateInflight = null; });
  return run;
}

/** True if any overlay (onboarding, confirm-send, the in-app dialog, or the
 *  update modal itself) is currently open. We never pop the update prompt over
 *  one — it shares the same z-index and would stack. */
function anyModalOpen(): boolean {
  return $$(".modal-overlay:not(.hidden)").length > 0;
}

/**
 * `manual` (설정 > 업데이트 확인 버튼): bypass the debounce + session-mute and always
 * answer — '이미 최신 버전입니다', '업데이트 확인 실패' (a failed check is never shown
 * as 최신, 1-28), or the prompt. The debounce is only stamped when the result was
 * actually handled (no update / prompt shown / already dismissed): a failed or
 * held-back (overlay open) auto check is retried on the next trigger.
 */
export async function checkUpdate(manual = false): Promise<void> {
  if (!manual) {
    if (anyModalOpen()) return; // auto: don't stack over another overlay
    if (Date.now() - lastUpdateCheck < UPDATE_MIN_GAP_MS) return;
    if (updateInflight) return; // the running check will show its own result
    if (Date.now() - lastAutoFailure < updateRetryDelayMs(autoFailures)) return; // U8 backoff
  }
  if (manual) toast("업데이트 확인 중…");
  const { current, info, sdkInt } = await runUpdateCheck();
  if (!info) {
    if (manual) toast("버전 정보를 확인할 수 없습니다", { err: true });
    return;
  }
  if (info.error) {
    if (manual) toast("업데이트 확인 실패 — 잠시 후 다시 시도하세요", { err: true });
    else { autoFailures++; lastAutoFailure = Date.now(); }
    return;
  }
  if (info.reason === "unsupported") {
    // Never the 업데이트 popup (it would download ~170MB and fail to install): a
    // one-time notice for the auto check, a plain answer for the manual one.
    markHandled();
    const notice = unsupportedUpdateNotice({ deviceSdk: sdkInt, minSdk: info.minSdk, version: info.version });
    if (manual) { toast(`${notice.short} (지금 버전을 계속 쓰시면 됩니다)`, { err: true }); return; }
    await notifyUnsupportedOnce(info.version, `${notice.short}.
${notice.detail}`);
    return;
  }
  if (!info.available || !info.url) {
    markHandled();
    if (manual) toast(`이미 최신 버전입니다 (v${current})`);
    return;
  }
  // Don't nag: once the user dismisses a version (나중에 OR 업데이트), stay quiet until
  // a newer one appears (or the app restarts, which re-prompts). A MANUAL check always shows.
  if (!manual && updateDismissedVersion === info.version) {
    markHandled();
    return;
  }
  // A modal may have opened during the awaits above — hold it (not stamped) for later.
  if (!manual && anyModalOpen()) return;
  showUpdatePrompt(current, info);
  markHandled();
}

/** Show the 'can't install' notice once per release version (persisted). A storage
 *  failure only means it may show again on a later start — never the popup. */
async function notifyUnsupportedOnce(version: string, message: string): Promise<void> {
  const seen = await Preferences.get({ key: UNSUPPORTED_NOTICE_KEY }).then((r) => r.value ?? "", () => "");
  if (seen === version) return;
  if (anyModalOpen()) return; // retried on a later check (lastUpdateCheck gap)
  await Preferences.set({ key: UNSUPPORTED_NOTICE_KEY, value: version }).catch(() => undefined);
  await appAlert(message, { title: "업데이트 안내" });
}

/** Fill and open the 업데이트 prompt. 업데이트 mutes this version only once the
 *  download page actually opened; a failure says so and keeps the prompt up. */
function showUpdatePrompt(current: string, info: UpdateInfo): void {
  $("#upd-current").textContent = "v" + current;
  $("#upd-latest").textContent = "v" + info.version;
  $("#upd-notes").textContent = releaseNotesForDisplay(info.notes || "");
  const modal = $("#update-modal");
  const now = $<HTMLButtonElement>("#upd-now");
  now.disabled = false;
  $("#upd-later").onclick = () => {
    closeModal(modal);
    updateDismissedVersion = info.version;
  };
  now.onclick = async () => {
    now.disabled = true;
    try {
      await openExternalUrl(info.url);
    } catch {
      toast("다운로드 페이지를 열 수 없습니다 — 다시 시도하세요", { err: true });
      return;
    } finally {
      now.disabled = false;
    }
    updateDismissedVersion = info.version; // muted so it won't re-pop mid-download
    closeModal(modal);
  };
  openModal(modal, $("#upd-later")); // I13: focus into the sheet, back to the opener on close
}
