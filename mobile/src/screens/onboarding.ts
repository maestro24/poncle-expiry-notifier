/**
 * First-run onboarding.
 */
import { Preferences } from "@capacitor/preferences";
import { saveConfig } from "../domain/config";
import { poncleLogin, requestSmsPermission } from "../native/adapters";
import { CONFIG_READ_FAILED_MESSAGE, S } from "../app/state";
import { $, toast } from "../app/dom";
import { closeModal, openModal } from "../ui/modal";
import { checkUpdate } from "./update";
import { refreshHome } from "../app/session";
import { doScan } from "./scan";

/* ---------- onboarding ---------- */
const ONB_KEY = "onboarded_v1";
/** An onboarding action resolves true only when it actually succeeded (권한 허용,
 *  로그인 완료) — the button shows ✓ just then (#49). */
interface OnbStep { title: string; body: string; action?: { label: string; run: () => Promise<boolean> } }
let onbIndex = 0;
let ONB_STEPS: OnbStep[] = [];
/** Per step: its action last ended "ok" / "retry" (L29) — going back to a step
 *  shows the same ✓ instead of a fresh button. */
let ONB_RESULT: Array<"ok" | "retry" | undefined> = [];
/** The onboarding login step succeeded: finishing runs the first scan (#53). */
let ONB_LOGGED_IN = false;
function buildOnbSteps(): OnbStep[] {
  return [
    {
      title: "약정만료 알리미",
      body: "폰클에서 약정 만료가 다가온 고객을 찾아, 이 폰에서 바로 문자로 안내합니다. 문자를 보내려면 문자 권한이 필요합니다.",
      action: {
        label: "문자 권한 허용",
        run: async () => {
          const granted = await requestSmsPermission();
          if (!granted) toast("문자 권한이 허용되지 않았습니다 — 다시 누르거나 나중에 설정에서 켤 수 있습니다", { err: true });
          return granted;
        },
      },
    },
    {
      title: "폰클 로그인",
      body: "폰클에 로그인하면 고객 목록을 읽어옵니다. 로그인 화면에서 보안문자(로봇 아님)만 직접 눌러 주세요. 아이디·비밀번호는 자동으로 저장돼 다음부터 자동 입력됩니다.",
      action: {
        label: "폰클 로그인",
        run: async () => {
          const ok = await poncleLogin(S.CFG);
          if (!ok) toast("로그인이 완료되지 않았습니다 — 다시 누르거나 나중에 로그인할 수 있습니다", { err: true });
          ONB_LOGGED_IN = ONB_LOGGED_IN || ok;
          return ok;
        },
      },
    },
    {
      title: "문자 발송 테스트",
      body: "실제로 문자가 나가는지 먼저 내 번호로 확인하는 걸 권장합니다. 설정 > ‘문자 발송 테스트’에서 내 번호로 보내 보세요.",
    },
    {
      title: "발송 모드 선택",
      body: "‘실제 발송’을 켜면 고객에게 진짜 문자가 나갑니다. 꺼두면 이력에만 기록됩니다(연습용). 지금 켤 수 있고, 나중에 설정에서 바꿀 수 있습니다.",
      action: {
        label: "실제 발송 켜기",
        run: async () => {
          if (S.CONFIG_READ_FAILED) { toast(CONFIG_READ_FAILED_MESSAGE, { err: true }); return false; } // U6
          S.CFG = await saveConfig({ ...S.CFG, deliver_alerts: true });
          return S.CFG.deliver_alerts === true;
        },
      },
    },
  ];
}
function renderOnb(): void {
  const s = ONB_STEPS[onbIndex];
  $("#onb-step").textContent = `${onbIndex + 1} / ${ONB_STEPS.length}`;
  $("#onb-title").textContent = s.title;
  const body = $("#onb-body");
  body.textContent = s.body;
  if (s.action) {
    const btn = document.createElement("button");
    btn.className = "btn-dark";
    const { label, run } = s.action;
    const step = onbIndex;
    const labelFor = (r: "ok" | "retry" | undefined): string =>
      r === "ok" ? `${label} ✓` : r === "retry" ? `${label} · 다시 시도` : label;
    btn.textContent = labelFor(ONB_RESULT[step]);
    btn.onclick = async () => {
      btn.disabled = true;
      let ok = false;
      try {
        ok = await run();
      } catch {
        toast(`${label}에 실패했습니다 — 다시 시도하세요`, { err: true });
      }
      btn.disabled = false;
      ONB_RESULT = ONB_RESULT.map((r, i) => (i === step ? (ok ? "ok" : "retry") : r));
      btn.textContent = labelFor(ONB_RESULT[step]);
    };
    body.appendChild(document.createElement("br"));
    body.appendChild(btn);
  }
  $("#onb-next").textContent = onbIndex >= ONB_STEPS.length - 1 ? "시작하기" : "다음";
}
async function finishOnb(): Promise<void> {
  closeModal($("#onboarding"));
  await Preferences.set({ key: ONB_KEY, value: "1" });
  if (ONB_LOGGED_IN) {
    // Logged in during onboarding: run the first scan right away (#53) instead of
    // leaving a fresh user on an empty home. The scan sets the session/banner itself.
    void doScan().catch(() => toast("스캔 실패", { err: true }));
  } else {
    // Not logged in: just check the session (shows the 로그인 banner when needed).
    await refreshHome();
  }
  // The boot-time update check bailed while onboarding was on screen; run it now.
  void checkUpdate();
}
export async function maybeOnboard(): Promise<boolean> {
  const { value } = await Preferences.get({ key: ONB_KEY }).catch(() => ({ value: null }));
  if (value === "1") return false;
  ONB_STEPS = buildOnbSteps();
  ONB_RESULT = ONB_STEPS.map(() => undefined);
  onbIndex = 0;
  ONB_LOGGED_IN = false;
  renderOnb();
  openModal($("#onboarding"), $("#onb-next"));
  return true;
}

/** Hardware back while onboarding is shown: one step back; false on the first step. */
export function onboardingBack(): boolean {
  if (onbIndex === 0) return false;
  onbIndex--;
  renderOnb();
  return true;
}

/** Onboarding next/skip. */
export function bindOnboarding(): void {
  // Onboarding
  $("#onb-next").onclick = async () => {
    if (onbIndex >= ONB_STEPS.length - 1) { await finishOnb(); return; }
    onbIndex++;
    renderOnb();
  };
  $("#onb-skip").onclick = () => void finishOnb();
}
