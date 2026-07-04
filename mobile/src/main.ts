/**
 * App controller for 약정만료 알리미 (Android). Wires the DOM (design ported from
 * the Android handoff) to the domain logic (runs in-process in the WebView) and
 * the native plugins (Poncle login/HTTP, SMS). Framework-free vanilla TS.
 */
import { DEFAULTS, loadConfig, saveConfig } from "./domain/config";
import { History, preferencesKV } from "./domain/history";
import { runScan, type ScanState } from "./domain/scan";
import { sendAlert } from "./domain/sender";
import {
  getAppVersion,
  nativePoncleGateway,
  openExternalUrl,
  poncleHasSession,
  poncleLogin,
  poncleLogout,
  requestSmsPermission,
  sendSms,
} from "./native/adapters";
import { checkForUpdate } from "./domain/updater";
import type { AppConfig, DueItem } from "./domain/types";

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;
const $$ = (s: string): HTMLElement[] => Array.from(document.querySelectorAll(s));

const history = new History(preferencesKV());
let CFG: AppConfig = { ...DEFAULTS };
let RESULTS: DueItem[] = [];
let LAST_SCAN = "";

// 거래처 목록 (from Poncle's agency dropdown). Non-standard open types use a
// per-agency term; pre-listed so they can be set even before a scan.
const AGENCIES = [
  "CD대리점", "DMB 엘지", "M&S분당도매센터", "MCC - 스테이지파이브SK", "MCC- SK텔링크",
  "MCC- 엠모바일", "MCC-KT엠모바일 후불유심", "mcc-kt중고후불", "MCC-미디어로그후불",
  "MCC-스카이라이프", "MCC-스테이지파이브KT", "MCC-코드모바일KT", "MCC-코드모바일LG",
  "MCC-프리티KT", "MCC-프리티LG", "MCC-프리티SK", "MCC-헬로비젼LG", "MCC/SK후불", "MCCKT",
  "PS&M", "SK경승컴퍼니온라인", "광운통신(라우터)", "대산LG", "메타레이kt", "미디어원KT",
  "쇼플러스", "유니컴즈(모빙) KT", "유니컴즈(모빙)LGT", "유니컴즈(모빙)SK", "유안-엔네트웍스",
  "티인포(mcc)",
];

// 안내 시점 options (days before expiry). 0 == expiry day.
const DDAY_OPTIONS = [30, 14, 7, 3, 1, 0];
// Template variable chips: label -> token the render engine understands.
const VARS: Array<[string, string]> = [
  ["고객명", "{customer}"], ["통신사", "{telecom}"], ["모델", "{model}"],
  ["만료일", "{expiry}"], ["개통일", "{opendate}"], ["시점", "{when}"],
];

/* ---------- helpers ---------- */
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function nowShort(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function decodeHtml(s: string): string {
  const t = document.createElement("textarea");
  t.innerHTML = String(s ?? "");
  return t.value;
}

/* ---------- navigation ---------- */
type Screen = "home" | "history" | "settings";
function showScreen(name: Screen): void {
  for (const v of ["home", "history", "settings"] as Screen[]) {
    $(`#view-${v}`).classList.toggle("hidden", v !== name);
  }
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  if (name === "history") void loadHistory();
  if (name === "settings") { populateSettings(); void refreshSessionState(); }
}

/* ---------- state ---------- */
function renderState(state: ScanState): void {
  const badge = $("#status-badge");
  const label = $("#status-label");
  const spin = $("#status-spinner");
  const map: Record<ScanState, { cls: string; text: string; busy: boolean }> = {
    idle: { cls: "", text: "대기중", busy: false },
    scanning: { cls: "is-busy", text: "스캔중", busy: true },
    session_expired: { cls: "is-expired", text: "세션만료", busy: false },
    error: { cls: "is-error", text: "오류", busy: false },
  };
  const m = map[state] ?? map.idle;
  badge.className = "badge " + m.cls;
  label.textContent = m.text;
  spin.classList.toggle("hidden", !m.busy);
}
function showBanner(which: "session" | "error" | "none", errMsg?: string): void {
  $("#session-banner").classList.toggle("hidden", which !== "session");
  $("#error-banner").classList.toggle("hidden", which !== "error");
  if (which === "error" && errMsg) $("#error-sub").textContent = errMsg;
}

/* ---------- home: cards + due list ---------- */
function renderCards(): void {
  const sent = RESULTS.filter((r) => r.already_sent).length;
  $("#c-targets").textContent = String(RESULTS.length);
  $("#c-pending").textContent = String(RESULTS.length - sent);
  $("#c-sent").textContent = String(sent);
}
function renderDueList(): void {
  const list = $("#due-list");
  $("#due-empty").classList.toggle("hidden", RESULTS.length > 0);
  const unsent = RESULTS.filter((r) => !r.already_sent).length;
  $("#list-note").textContent = RESULTS.length ? `${RESULTS.length}명 · 미발송 ${unsent}명` : "";
  list.innerHTML = "";
  for (const item of RESULTS) list.appendChild(dueCard(item));
  renderCards();
}
function dueCard(item: DueItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "listcard" + (item.already_sent ? " sent" : "");
  card.innerHTML = `
    <div class="lc-top">
      <span class="lc-name">${esc(item.customer) || "-"}</span>
      <span class="lc-phone">${esc(item.phone)}</span>
      <span class="lc-tag tag-open">${esc(item.openhow) || "-"}</span>
    </div>
    <div class="lc-meta">개통 ${esc(item.opendate)} · 만료 ${esc(item.expiry_date)}<br>
      ${esc(item.agency)} · ${esc(item.telecom)} · ${esc(item.model)}</div>
    <div class="lc-act"></div>`;
  (card.querySelector(".lc-act") as HTMLElement).appendChild(actionEl(item));
  return card;
}
function actionEl(item: DueItem): HTMLElement {
  if (item.already_sent) {
    const b = document.createElement("span");
    b.className = "sent-badge" + (CFG.deliver_alerts ? "" : " rec");
    b.textContent = CFG.deliver_alerts ? "✓ 발송됨" : "✓ 기록됨(미발송)";
    return b;
  }
  const btn = document.createElement("button");
  btn.className = "btn-send";
  btn.textContent = "알림 보내기";
  btn.onclick = () => void onSend(item, btn);
  return btn;
}
async function onSend(item: DueItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "전송 중…";
  const res = await sendAlert(item, CFG, { history, sendSms, nowIso });
  if (res.status === "sent" || res.status === "already") {
    item.already_sent = true;
    const card = btn.closest(".listcard") as HTMLElement | null;
    if (card) {
      card.classList.add("sent");
      const act = card.querySelector(".lc-act") as HTMLElement;
      act.innerHTML = "";
      act.appendChild(actionEl(item));
    }
    renderCards();
  } else {
    btn.disabled = false;
    btn.textContent = "알림 보내기";
    alert(res.error || "발송 실패");
  }
}

/* ---------- scan ---------- */
async function doScan(): Promise<void> {
  renderState("scanning");
  const btn = $<HTMLButtonElement>("#btn-scan");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "스캔 중…";
  try {
    const res = await runScan(nativePoncleGateway(CFG), CFG, history);
    LAST_SCAN = nowShort();
    $("#last-scan").textContent = LAST_SCAN;
    if (res.status === "session_expired") {
      showBanner("session");
      renderState("session_expired");
      return;
    }
    if (res.status === "error") {
      showBanner("error", res.error);
      renderState("error");
      return;
    }
    showBanner("none");
    RESULTS = res.results;
    renderDueList();
    renderState("idle");
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

/* ---------- login ---------- */
async function doLogin(): Promise<void> {
  const ok = await poncleLogin(CFG);
  if (ok) {
    showBanner("none");
    await doScan();
  }
}

/* ---------- history ---------- */
async function loadHistory(): Promise<void> {
  const rows = await history.search(
    $<HTMLInputElement>("#h-query").value.trim(),
    $<HTMLInputElement>("#h-start").value,
    $<HTMLInputElement>("#h-end").value,
  );
  $("#h-count").textContent = rows.length ? `${rows.length}건` : "";
  $("#h-empty").classList.toggle("hidden", rows.length > 0);
  const list = $("#h-list");
  list.innerHTML = "";
  for (const r of rows) {
    const el = document.createElement("div");
    el.className = "listcard";
    const tagCls = r.channel === "sms" ? "tag-sent" : "tag-rec";
    const tagTxt = r.channel === "sms" ? "발송" : "기록";
    el.innerHTML = `
      <div class="lc-top"><span class="lc-name">${esc(r.customer) || "-"}</span>
        <span class="lc-phone">${esc(r.phone)}</span>
        <span class="lc-tag ${tagCls}">${tagTxt}</span></div>
      <div class="lc-meta">개통 ${esc(r.opendate)} · 만료 ${esc(r.expiry_date)} · 발송 ${esc(r.sent_at.replace("T", " ").slice(0, 16))}<br>
        ${esc(r.agency)} · ${esc(r.telecom)} · ${esc(r.model)}</div>`;
    list.appendChild(el);
  }
}

/* ---------- settings ---------- */
function agencyList(): string[] {
  const seen = new Set(AGENCIES);
  const extra: string[] = [];
  for (const r of RESULTS) {
    const name = decodeHtml(r.agency || "").trim();
    if (name && !seen.has(name)) { seen.add(name); extra.push(name); }
  }
  extra.sort((a, b) => a.localeCompare(b, "ko"));
  return AGENCIES.concat(extra);
}
function buildAgencyTerms(): void {
  const box = $("#agency-terms");
  box.innerHTML = "";
  const overrides = CFG.agency_term_months || {};
  const fallback = CFG.nonstandard_term_months ?? 6;
  for (const name of agencyList()) {
    const row = document.createElement("div");
    row.className = "ex-row";
    row.innerHTML = `<span class="ex-name">${esc(name)}</span>`;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "60";
    input.className = "numbox agency-term";
    input.dataset.agency = name;
    input.value = String(name in overrides ? overrides[name] : fallback);
    row.appendChild(input);
    box.appendChild(row);
  }
}
function buildDDayChips(): void {
  const box = $("#dday-chips");
  box.innerHTML = "";
  const active = new Set((CFG.notify_offsets_days || []).map(Number));
  for (const v of DDAY_OPTIONS) {
    const b = document.createElement("button");
    b.className = "chip" + (active.has(v) ? " on" : "");
    b.dataset.dday = String(v);
    b.textContent = v === 0 ? "당일" : `D-${v}`;
    b.onclick = () => b.classList.toggle("on");
    box.appendChild(b);
  }
}
function buildVarChips(): void {
  for (const holder of $$(".varchips")) {
    const targetId = holder.dataset.target!;
    holder.innerHTML = "";
    for (const [label, token] of VARS) {
      const b = document.createElement("button");
      b.className = "varchip";
      b.textContent = `{${label}}`;
      b.onclick = () => insertToken(targetId, token);
      holder.appendChild(b);
    }
  }
}
function insertToken(targetId: string, token: string): void {
  const ta = $<HTMLTextAreaElement>("#" + targetId);
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  const pos = start + token.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
}
function setToggle(el: HTMLElement, on: boolean): void {
  el.classList.toggle("on", on);
}
function populateSettings(): void {
  $<HTMLInputElement>("#s-standard-term").value = String(CFG.default_term_months ?? 24);
  $<HTMLInputElement>("#s-nonstandard-term").value = String(CFG.nonstandard_term_months ?? 6);
  buildAgencyTerms();
  buildDDayChips();
  buildVarChips();
  $<HTMLTextAreaElement>("#s-template").value = CFG.message_template || "";
  $<HTMLTextAreaElement>("#s-template-nonstandard").value = CFG.message_template_nonstandard || "";
  setToggle($("#s-deliver"), !!CFG.deliver_alerts);
}
function gatherSettings(): Partial<AppConfig> {
  const offsets = $$("#dday-chips .chip")
    .filter((c) => c.classList.contains("on"))
    .map((c) => parseInt(c.dataset.dday!, 10));
  const nonstandard = parseInt($<HTMLInputElement>("#s-nonstandard-term").value, 10);
  const nonstandardTerm = Number.isFinite(nonstandard) ? nonstandard : 6;
  const agencyTerms: Record<string, number> = {};
  $$(".agency-term").forEach((inp) => {
    const v = parseInt((inp as HTMLInputElement).value, 10);
    const name = (inp as HTMLInputElement).dataset.agency!;
    if (Number.isFinite(v) && v !== nonstandardTerm) agencyTerms[name] = v;
  });
  return {
    deliver_alerts: $("#s-deliver").classList.contains("on"),
    default_term_months: parseInt($<HTMLInputElement>("#s-standard-term").value, 10) || 24,
    nonstandard_term_months: nonstandardTerm,
    agency_term_months: agencyTerms,
    notify_offsets_days: offsets.length ? offsets : [0],
    message_template: $<HTMLTextAreaElement>("#s-template").value,
    message_template_nonstandard: $<HTMLTextAreaElement>("#s-template-nonstandard").value,
  };
}
async function refreshSessionState(): Promise<void> {
  const has = await poncleHasSession(CFG).catch(() => false);
  $("#session-state").textContent = has ? "로그인됨" : "로그아웃 상태 · 로그인이 필요합니다";
}

/* ---------- test target ---------- */
function addTestTarget(): void {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const yy = `${p(now.getFullYear() % 100)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  RESULTS = RESULTS.concat([{
    id: `010-1234-5678|${iso}|0-test-${now.getTime()}`,
    phone: "010-1234-5678", customer: "홍길동", opendate: yy, expiry_date: iso,
    milestone_offset: 0, telecom: "SK텔레콤", agency: "테스트대리점", openhow: "번호이동",
    plan: "", model: "테스트모델", staff: "", already_sent: false,
  }]);
  showScreen("home");
  renderDueList();
}

/* ---------- wire up ---------- */
function bind(): void {
  $$("[data-nav]").forEach((b) => (b.onclick = () => showScreen(b.dataset.nav as Screen)));
  $("#btn-scan").onclick = () => void doScan();
  $("#btn-login").onclick = () => void doLogin();
  $("#btn-retry").onclick = () => void doScan();
  $("#btn-test-target").onclick = addTestTarget;

  $("#h-query").addEventListener("input", () => void loadHistory());
  $("#h-start").addEventListener("change", () => void loadHistory());
  $("#h-end").addEventListener("change", () => void loadHistory());

  $("#s-deliver").onclick = async () => {
    const el = $("#s-deliver");
    const nowOn = !el.classList.contains("on");
    el.classList.toggle("on", nowOn);
    // Turning "실제 발송" on is the moment SMS permission matters -> prompt now.
    if (nowOn) await requestSmsPermission();
  };
  $("#btn-relogin").onclick = async () => {
    const ok = await poncleLogin(CFG);
    $("#session-state").textContent = ok ? "로그인됨" : "로그인 취소됨";
  };
  $("#btn-logout").onclick = async () => {
    await poncleLogout(CFG);
    $("#session-state").textContent = "로그아웃됨";
  };
  $("#btn-test-sms").onclick = async () => {
    const phone = $<HTMLInputElement>("#s-test-phone").value.trim();
    const msg = $("#test-sms-msg");
    if (!phone) { msg.textContent = "번호를 입력하세요"; return; }
    msg.textContent = "전송 중…";
    try {
      await sendSms(phone, "[약정만료 알리미] 테스트 문자입니다. 정상 수신되면 발송 설정이 완료된 것입니다.");
      msg.textContent = "전송 요청됨 ✓ 수신 확인해 보세요";
    } catch (e) {
      msg.textContent = "실패: " + (e instanceof Error ? e.message : String(e));
    }
  };

  $("#btn-save").onclick = async () => {
    CFG = await saveConfig({ ...CFG, ...gatherSettings() });
    const msg = $("#save-msg");
    msg.textContent = "저장되었습니다";
    renderDueList(); // refresh sent/record badges per new deliver setting
    setTimeout(() => { msg.textContent = ""; }, 2000);
  };
}

/* ---------- update ---------- */
async function checkUpdate(): Promise<void> {
  const current = await getAppVersion().catch(() => "");
  if (!current || current === "0.0.0") return; // web fallback / unknown
  const info = await checkForUpdate(current);
  if (!info.available || !info.url) return;
  $("#upd-current").textContent = "v" + current;
  $("#upd-latest").textContent = "v" + info.version;
  $("#upd-notes").textContent = info.notes || "";
  const modal = $("#update-modal");
  $("#upd-later").onclick = () => modal.classList.add("hidden");
  $("#upd-now").onclick = () => {
    void openExternalUrl(info.url);
    modal.classList.add("hidden");
  };
  modal.classList.remove("hidden");
}

/* ---------- boot ---------- */
async function boot(): Promise<void> {
  bind();
  CFG = await loadConfig();
  renderState("idle");
  // First launch: prompt for SMS permission up front (no-op if already granted).
  void requestSmsPermission();
  const hasSession = await poncleHasSession(CFG).catch(() => false);
  showBanner(hasSession ? "none" : "session");
  if (hasSession) await doScan();
  void checkUpdate();
}

void boot();
