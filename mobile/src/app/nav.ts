/**
 * Navigation: screen switching (with leave-auto-save), the template-editor leave
 * confirm, Android hardware back and re-rendering whichever screen shows send state.
 */
import { appConfirm, dismissAppDialog } from "../ui/dialog";
import { type Screen, S } from "./state";
import { $, $$, toast } from "./dom";
import { refreshSessionState } from "./session";
import { renderDueList, refreshHomeSendState } from "../screens/home";
import { applyScanSettings } from "../screens/scan";
import { renderDashboard } from "../screens/dashboard";
import { loadHistory, enterHistory } from "../screens/history";
import { openLookup, refreshLookupInformed } from "../screens/lookup";
import { populateSettings, saveSettingsNow, populateTerms, saveTermsNow, refreshCredsState, refreshHistorySize } from "../screens/settings";
import { renderTemplateList, templateEditDirty } from "../screens/templates";
import { onboardingBack } from "../screens/onboarding";
import { cancelPendingConfirm } from "../screens/send";

/* ---------- navigation ---------- */

// terms/templates/template-edit are sub-screens of 설정: the bottom-nav keeps
// 설정 highlighted while they're open.
const SETTINGS_FAMILY: Screen[] = ["settings", "terms", "templates", "template-edit"];
const ALL_SCREENS: Screen[] = ["home", "dashboard", "lookup", "history", "settings", "terms", "templates", "template-edit"];
export function showScreen(name: Screen): void {
  // Leaving a screen with editable inputs: commit pending edits (auto-save net).
  const saves: Promise<void>[] = [];
  if (S.CURRENT === "settings" && name !== "settings") saves.push(saveSettingsNow());
  if (S.CURRENT === "terms" && name !== "terms") saves.push(saveTermsNow());
  // Leaving 설정 altogether: 안내 시점/개월 수 changed there (incl. the 약정 기간
  // sub-screen) take effect now — rescan with a live session, or say when (#35).
  if (SETTINGS_FAMILY.includes(S.CURRENT) && !SETTINGS_FAMILY.includes(name)) {
    void Promise.all(saves).then(
      () => applyScanSettings(false).catch(() => toast("스캔 실패", { err: true })),
      () => toast("설정을 저장하지 못했습니다", { err: true }),
    );
  }
  if (name !== S.CURRENT) cancelPendingConfirm(); // L27: no sheet pops up on another screen
  S.CURRENT = name;
  for (const v of ALL_SCREENS) $(`#view-${v}`).classList.toggle("hidden", v !== name);
  const navName = SETTINGS_FAMILY.includes(name) ? "settings" : name;
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.nav === navName));
  if (name === "home") void refreshHomeSendState();
  if (name === "history") enterHistory();
  if (name === "dashboard") void renderDashboard();
  if (name === "lookup") openLookup();
  if (name === "settings") { populateSettings(); refreshSessionState(); void refreshCredsState(); void refreshHistorySize(); }
  if (name === "terms") populateTerms();
  if (name === "templates") renderTemplateList();
}

/** Where back (hardware or topbar) goes from each screen; home has no parent. */
const PARENT: Partial<Record<Screen, Screen>> = {
  "template-edit": "templates",
  templates: "settings",
  terms: "settings",
  settings: "home",
  dashboard: "home",
  lookup: "home",
  history: "home",
};

/** A leave-the-editor confirm is on screen (a second tap/back doesn't queue another). */
let leaveConfirmOpen = false;

/** Navigate like a user tap. Leaving the template editor with unsaved edits asks
 *  first (in-app confirm); everything else switches at once. */
export async function navigate(name: Screen): Promise<void> {
  if (S.CURRENT === "template-edit" && name !== "template-edit" && templateEditDirty()) {
    if (leaveConfirmOpen) return;
    leaveConfirmOpen = true;
    const discard = await appConfirm("저장하지 않은 변경 내용이 있습니다.\n저장하지 않고 나갈까요?", {
      title: "템플릿 편집",
      okLabel: "나가기",
      cancelLabel: "계속 편집",
    }).finally(() => { leaveConfirmOpen = false; });
    if (!discard || S.CURRENT !== "template-edit") return;
  }
  showScreen(name);
}

/** Overlays the hardware back closes (like their own 취소/닫기), top-most first. */
function closeTopOverlay(): boolean {
  if (dismissAppDialog()) return true; // in-app confirm = 취소
  if (!$("#confirm-modal").classList.contains("hidden")) {
    $<HTMLButtonElement>("#confirm-cancel").click();
    return true;
  }
  if (!$("#update-modal").classList.contains("hidden")) {
    $<HTMLButtonElement>("#upd-later").click(); // = 나중에
    return true;
  }
  return false;
}

/**
 * Android hardware back (MainActivity asks this first): close the open dialog/sheet,
 * else step back through onboarding, else go to the parent screen. false only on
 * home with nothing open, so the activity's default back (background the app) runs.
 */
export function handleHardwareBack(): boolean {
  if (closeTopOverlay()) return true;
  if (leaveConfirmOpen) return true;
  if (!$("#onboarding").classList.contains("hidden")) return onboardingBack();
  const parent = PARENT[S.CURRENT];
  if (!parent) return false;
  void navigate(parent);
  return true;
}

/** Re-render whichever screen shows send state (after a send or a send result). */
export function rerenderCurrent(): void {
  if (S.CURRENT === "history") void loadHistory();
  else if (S.CURRENT === "lookup") void refreshLookupInformed();
  else if (S.CURRENT === "dashboard") void renderDashboard();
  else renderDueList();
}
