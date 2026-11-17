/**
 * 설정 screen (발송 시점, 실제 발송, 폰클 계정, 문자 테스트) and its 약정 기간 sub-screen.
 */
import { clampTermInput, saveConfig, type TermField } from "../domain/config";
import { isValidKrMobile } from "../domain/sender";
import type { AppConfig } from "../domain/types";
import { clearPoncleCredentials, getPoncleCredentialsMeta, poncleLogin, poncleLogout, requestSmsPermission, savePoncleCredentials } from "../native/adapters";
import { INVALID_NUMBER_MESSAGE, sendSmsTracked } from "../native/sms";
import { CONFIG_READ_FAILED_MESSAGE, S, history } from "../app/state";
import { $, $$, setSwitch, setPressed, toast } from "../app/dom";
import { historySizeWarning } from "../ui/history-size";
import { checkUpdate } from "./update";
import { markLoggedOut, probeSession } from "../app/session";
import { TEST_SMS_IDS, scheduleResultChecks } from "./send-results";
import { maybeOfferSmsSettings, noteSmsHandOff } from "./send";
import { applyScanSettings } from "./scan";

const DDAY_OPTIONS = [30, 14, 7, 3, 1, 0];

/** 설정 저장 button. */
export async function onSettingsSave(): Promise<void> {
  if (S.CONFIG_READ_FAILED) { toast(CONFIG_READ_FAILED_MESSAGE, { err: true }); return; }
  await saveSettingsNow();
  await applyScanSettings(true);
}

/* ---------- settings ---------- */
/** The 안내 시점 chips were tapped since 설정 was filled (L10). Until then the saved
 *  offsets are kept as they are — a value no chip shows (e.g. [5] from a restored
 *  backup, or several offsets) must not silently become '당일만'. */
let DDAY_TOUCHED = false;

function buildDDayChips(): void {
  DDAY_TOUCHED = false;
  const box = $("#dday-chips");
  box.innerHTML = "";
  const selected = Math.max(...(S.CFG.notify_offsets_days || [0]).map(Number));
  for (const v of DDAY_OPTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    setPressed(b, v === selected);
    b.dataset.dday = String(v);
    b.textContent = v === 0 ? "당일만" : `${v}일 전부터`;
    b.onclick = () => {
      for (const c of $$("#dday-chips .chip")) setPressed(c, c === b);
      DDAY_TOUCHED = true;
      void saveSettingsNow();
    };
    box.appendChild(b);
  }
}

export function populateSettings(): void {
  buildDDayChips();
  setSwitch($("#s-deliver"), !!S.CFG.deliver_alerts);
  $<HTMLInputElement>("#s-test-phone").value = S.CFG.test_phone ?? "";
}
/** Persist 설정 > 문자 발송 테스트의 내 번호 (also the 홈 테스트 대상 number). */
async function saveTestPhone(phone: string): Promise<void> {
  if ((S.CFG.test_phone ?? "") === phone) return;
  if (S.CONFIG_READ_FAILED) return; // U6: never write DEFAULTS over the real settings
  S.CFG = await saveConfig({ ...S.CFG, test_phone: phone });
}
function gatherSettings(): Partial<AppConfig> {
  const deliver = { deliver_alerts: $("#s-deliver").classList.contains("on") };
  if (!DDAY_TOUCHED) return deliver; // chips untouched: keep the saved 안내 시점 (L10)
  const offsets = $$("#dday-chips .chip")
    .filter((c) => c.classList.contains("on"))
    .map((c) => parseInt(c.dataset.dday!, 10));
  return { ...deliver, notify_offsets_days: offsets.length ? offsets : [0] };
}
/** Persist the current settings form immediately (auto-save; 저장 is optional). */
export async function saveSettingsNow(): Promise<void> {
  if (S.CONFIG_READ_FAILED) return; // U6: CFG is DEFAULTS — never write it over the real settings
  S.CFG = await saveConfig({ ...S.CFG, ...gatherSettings() });
}

/* ---------- terms (약정 기간) sub-screen ---------- */
export function populateTerms(): void {
  // #s-standard-term = 약정 개월(2단계), #s-nonstandard-term = 요금제 유지 기본 개월(1단계).
  $<HTMLInputElement>("#s-standard-term").value = String(S.CFG.default_term_months ?? 24);
  $<HTMLInputElement>("#s-nonstandard-term").value = String(S.CFG.keepdate_default_months ?? 6);
  $<HTMLInputElement>("#s-unvisited-lookback").value = String(S.CFG.unvisited_lookback_months ?? 6);
  $("#terms-change-note").classList.add("hidden");
  $("#terms-range-msg").classList.add("hidden");
}
/** The 약정 기간 inputs, validated (#39): an out-of-range value is clamped, written
 *  back into its field and explained inline; a blank one keeps the saved value. */
function gatherTerms(): Partial<AppConfig> {
  const fields: Array<[TermField, string, number]> = [
    ["default_term_months", "#s-standard-term", S.CFG.default_term_months ?? 24],
    ["keepdate_default_months", "#s-nonstandard-term", S.CFG.keepdate_default_months ?? 6],
    ["unvisited_lookback_months", "#s-unvisited-lookback", S.CFG.unvisited_lookback_months ?? 6],
  ];
  const out: Partial<Record<TermField, number>> = {};
  const messages: string[] = [];
  for (const [field, sel, current] of fields) {
    const input = $<HTMLInputElement>(sel);
    const r = clampTermInput(field, input.value, current);
    if (r.message) {
      messages.push(r.message);
      input.value = String(r.value);
    }
    out[field] = r.value;
  }
  const box = $("#terms-range-msg");
  box.textContent = messages.join("\n");
  box.classList.toggle("hidden", messages.length === 0);
  return out;
}
export async function saveTermsNow(): Promise<void> {
  const next = gatherTerms();
  const monthsChanged =
    next.default_term_months !== S.CFG.default_term_months ||
    next.keepdate_default_months !== S.CFG.keepdate_default_months;
  // Months drive every 만료일 (and so the dedup key). Say plainly what happens to
  // the customers already alerted under the old value. Shown synchronously (the
  // 'change' event fires while still on the screen), not after the await, when
  // a back tap may already have switched S.CURRENT; populateTerms resets it.
  if (monthsChanged) $("#terms-change-note").classList.remove("hidden");
  if (S.CONFIG_READ_FAILED) return; // U6
  S.CFG = await saveConfig({ ...S.CFG, ...next });
}

/** 설정 > 데이터: warn when the send log has grown large (I12). The log is read
 *  through History (same store the sends use); a read failure just shows nothing. */
export async function refreshHistorySize(): Promise<void> {
  const box = document.querySelector<HTMLElement>("#history-size-msg");
  if (!box) return;
  let warning: string | null = null;
  try {
    // The STORED sent_log string as written (no parse + re-serialize of the whole log).
    warning = historySizeWarning(await history.storageBytes());
  } catch {
    warning = null;
  }
  box.textContent = warning ?? "";
  box.classList.toggle("hidden", !warning);
}

export async function refreshCredsState(): Promise<void> {
  const meta = await getPoncleCredentialsMeta().catch(() => ({ hasCreds: false, id: "" }));
  $<HTMLInputElement>("#s-poncle-id").value = meta.id || "";
  $("#creds-msg").textContent = meta.hasCreds ? "저장됨 · 로그인 화면에서 자동 입력됩니다" : "";
}

/** 약정 기간 sub-screen auto-save. */
export function bindTerms(): void {
  // Terms sub-screen: auto-save any term field on change (blur).
  $("#view-terms").addEventListener("change", () => void saveTermsNow());
}

/** 설정 controls. */
export function bindSettings(): void {
  // Settings
  $("#s-deliver").onclick = async () => {
    const el = $("#s-deliver");
    const nowOn = !el.classList.contains("on");
    setSwitch(el, nowOn);
    await saveSettingsNow();
    if (nowOn) {
      const granted = await requestSmsPermission();
      // Permanently denied ("다시 묻지 않음"): the request dialog no longer appears,
      // so guide the user to settings instead of leaving 발송 quietly broken.
      if (!granted) await maybeOfferSmsSettings("SMS 권한");
    }
  };
  // Auto-save any settings field on change (blur), so 저장 is optional.
  $("#view-settings").addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    // credentials + restore/test inputs manage their own state; skip them.
    if (t.closest("#s-poncle-id, #s-poncle-pw, #s-test-phone, #restore-file")) return;
    void saveSettingsNow();
  });
  $("#btn-relogin").onclick = async () => {
    const ok = await poncleLogin(S.CFG);
    if (!ok) { $("#session-state").textContent = "로그인 취소됨"; return; }
    await probeSession(); // 로그인 창이 닫혔다고 세션이 유효한 건 아니다 — 실제로 확인
  };
  $("#btn-logout").onclick = async () => {
    // The native logout clears the Gecko cookies through the bridge and can take
    // a few seconds (queued behind an in-flight request): show it, and ignore a
    // second tap meanwhile.
    const btn = $<HTMLButtonElement>("#btn-logout");
    if (btn.disabled) return;
    btn.disabled = true;
    $("#session-state").textContent = "로그아웃 중…";
    try {
      await poncleLogout(S.CFG);
      // L14: a probe still in flight must not report 'expired' over this, and home
      // shows the 로그인 banner (markLoggedOut bumps SESSION_EPOCH + setSession).
      markLoggedOut();
      $("#session-state").textContent = "로그아웃됨";
    } catch {
      $("#session-state").textContent = "로그아웃하지 못했습니다. 다시 시도해 주세요.";
    } finally {
      btn.disabled = false;
    }
  };
  const autoSaveCreds = async (): Promise<void> => {
    const id = $<HTMLInputElement>("#s-poncle-id").value.trim();
    const pw = $<HTMLInputElement>("#s-poncle-pw").value;
    if (!id || !pw) return;
    const ok = await savePoncleCredentials(id, pw);
    $("#creds-msg").textContent = ok ? "저장됨 · 로그인 화면에서 자동 입력됩니다" : "저장 실패";
  };
  $("#s-poncle-id").addEventListener("change", () => void autoSaveCreds());
  $("#s-poncle-pw").addEventListener("change", () => void autoSaveCreds());
  $("#btn-save-creds").onclick = async () => {
    const id = $<HTMLInputElement>("#s-poncle-id").value.trim();
    const pw = $<HTMLInputElement>("#s-poncle-pw").value;
    const msg = $("#creds-msg");
    if (!id || !pw) { msg.textContent = "아이디와 비밀번호를 모두 입력하세요"; return; }
    const ok = await savePoncleCredentials(id, pw);
    msg.textContent = ok ? "저장됨 · 로그인 화면에서 자동 입력됩니다" : "저장 실패";
  };
  $("#btn-clear-creds").onclick = async () => {
    await clearPoncleCredentials();
    $<HTMLInputElement>("#s-poncle-id").value = "";
    $<HTMLInputElement>("#s-poncle-pw").value = "";
    $("#creds-msg").textContent = "삭제됨";
  };
  $("#btn-check-update").onclick = () => void checkUpdate(true); // 수동 업데이트 확인
  $("#s-test-phone").addEventListener("change", (e) =>
    void saveTestPhone((e.target as HTMLInputElement).value.trim()));
  $("#btn-test-sms").onclick = async () => {
    const phone = $<HTMLInputElement>("#s-test-phone").value.trim();
    const msg = $("#test-sms-msg");
    if (!phone) { msg.textContent = "번호를 입력하세요"; return; }
    if (!isValidKrMobile(phone)) { msg.textContent = INVALID_NUMBER_MESSAGE; return; }
    await saveTestPhone(phone); // 홈 '테스트 대상'도 이 번호를 쓴다
    msg.textContent = "전송 중…";
    try {
      const text = "[약정만료 알리미] 테스트 문자입니다. 정상 수신되면 발송 설정이 완료된 것입니다.";
      const id = await sendSmsTracked(phone, text);
      if (id) TEST_SMS_IDS.add(id);
      noteSmsHandOff(text); // the OS counts test sends toward its 30-in-30-min limit too (I2)
      // Hand-off only — a radio failure (유심/신호) is reported a few seconds later.
      msg.textContent = "발송 요청됨 ✓ 수신 확인해 보세요 (실패하면 곧 알려 드립니다)";
      scheduleResultChecks(id);
    } catch (e) {
      msg.textContent = "실패: " + (e instanceof Error ? e.message : String(e));
    }
  };
}
