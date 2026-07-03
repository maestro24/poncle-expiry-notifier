/**
 * App controller for 약정만료 알리미 (Android). Wires the DOM to the domain logic
 * (runs in-process in the WebView) and the native plugins (Poncle login/HTTP, SMS).
 * Deliberately framework-free and plain; the Android design reskins this later.
 */
import { DEFAULTS, loadConfig, saveConfig } from "./domain/config";
import { History, preferencesKV } from "./domain/history";
import { runScan, type ScanState } from "./domain/scan";
import { sendAlert } from "./domain/sender";
import {
  nativePoncleGateway,
  poncleHasSession,
  poncleLogin,
  poncleLogout,
  sendSms,
} from "./native/adapters";
import type { AppConfig, DueItem } from "./domain/types";

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;
const $$ = (s: string): HTMLElement[] => Array.from(document.querySelectorAll(s));

const history = new History(preferencesKV());
let CFG: AppConfig = { ...DEFAULTS };
let RESULTS: DueItem[] = [];

// 거래처 목록 (from Poncle's agency dropdown). Non-standard open types use a
// per-agency term; these are pre-listed so they can be set even before a scan.
const AGENCIES = [
  "CD대리점", "DMB 엘지", "M&S분당도매센터", "MCC - 스테이지파이브SK", "MCC- SK텔링크",
  "MCC- 엠모바일", "MCC-KT엠모바일 후불유심", "mcc-kt중고후불", "MCC-미디어로그후불",
  "MCC-스카이라이프", "MCC-스테이지파이브KT", "MCC-코드모바일KT", "MCC-코드모바일LG",
  "MCC-프리티KT", "MCC-프리티LG", "MCC-프리티SK", "MCC-헬로비젼LG", "MCC/SK후불", "MCCKT",
  "PS&M", "SK경승컴퍼니온라인", "광운통신(라우터)", "대산LG", "메타레이kt", "미디어원KT",
  "쇼플러스", "유니컴즈(모빙) KT", "유니컴즈(모빙)LGT", "유니컴즈(모빙)SK", "유안-엔네트웍스",
  "티인포(mcc)",
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
function showView(name: "main" | "history" | "settings"): void {
  for (const v of ["main", "history", "settings"]) {
    $(`#view-${v}`).classList.toggle("hidden", v !== name);
  }
}

/* ---------- state ---------- */
const STATE_TEXT: Record<ScanState, { text: string; cls: string }> = {
  idle: { text: "대기중", cls: "" },
  scanning: { text: "스캔중", cls: "is-scanning" },
  session_expired: { text: "세션만료", cls: "is-expired" },
  error: { text: "오류", cls: "is-error" },
};
function renderState(state: ScanState): void {
  const info = STATE_TEXT[state] ?? STATE_TEXT.idle;
  $("#state-pill").className = "state-pill " + info.cls;
  $("#state-text").textContent = info.text;
}
function showLoginBanner(show: boolean): void {
  $("#login-banner").classList.toggle("hidden", !show);
}

/* ---------- cards + results ---------- */
function renderCards(): void {
  const sent = RESULTS.filter((r) => r.already_sent).length;
  $("#c-targets").textContent = String(RESULTS.length);
  $("#c-pending").textContent = String(RESULTS.length - sent);
  $("#c-sent").textContent = String(sent);
}
function renderResults(): void {
  const list = $("#r-list");
  $("#r-empty").classList.toggle("hidden", RESULTS.length > 0);
  const unsent = RESULTS.filter((r) => !r.already_sent).length;
  $("#results-note").textContent = RESULTS.length ? `${RESULTS.length}명 · 미발송 ${unsent}명` : "";
  list.innerHTML = "";
  for (const item of RESULTS) {
    list.appendChild(rowEl(item));
  }
  renderCards();
}
function rowEl(item: DueItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "row" + (item.already_sent ? " sent" : "");
  row.dataset.id = item.id;
  row.innerHTML = `
    <div class="row-top">
      <span class="row-name">${esc(item.customer) || "-"}</span>
      <span class="row-phone">${esc(item.phone)}</span>
      <span class="row-tag">${esc(item.openhow) || "-"}</span>
    </div>
    <div class="row-meta">개통 ${esc(item.opendate)} · 만료 ${esc(item.expiry_date)}<br>
      ${esc(item.agency)} · ${esc(item.telecom)} · ${esc(item.model)}</div>
    <div class="row-act"></div>`;
  const act = row.querySelector(".row-act") as HTMLElement;
  act.appendChild(actionEl(item));
  return row;
}
function actionEl(item: DueItem): HTMLElement {
  if (item.already_sent) {
    const b = document.createElement("span");
    b.className = "sent-badge";
    b.textContent = "✓ 발송됨";
    return b;
  }
  const btn = document.createElement("button");
  btn.className = "btn-send";
  btn.textContent = "알림 보내기";
  btn.onclick = () => onSend(item, btn);
  return btn;
}

async function onSend(item: DueItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "전송 중…";
  const res = await sendAlert(item, CFG, { history, sendSms, nowIso });
  if (res.status === "sent" || res.status === "already") {
    item.already_sent = true;
    const row = btn.closest(".row") as HTMLElement | null;
    if (row) {
      row.className = "row sent";
      const act = row.querySelector(".row-act") as HTMLElement;
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
    if (res.status === "session_expired") {
      showLoginBanner(true);
      renderState("session_expired");
      return;
    }
    showLoginBanner(false);
    RESULTS = res.results;
    renderResults();
    renderState(res.status === "ok" ? "idle" : "error");
    if (res.status === "error") alert("스캔 오류: " + (res.error || ""));
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

/* ---------- login ---------- */
async function doLogin(): Promise<void> {
  const ok = await poncleLogin(CFG);
  if (ok) {
    showLoginBanner(false);
    await doScan();
  }
}

/* ---------- settings ---------- */
function decodeHtml(s: string): string {
  const t = document.createElement("textarea");
  t.innerHTML = String(s ?? "");
  return t.value;
}
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
function buildAgencyTerms(c: AppConfig): void {
  const box = $("#agency-terms");
  box.innerHTML = "";
  const overrides = c.agency_term_months || {};
  const fallback = c.nonstandard_term_months ?? 6;
  for (const name of agencyList()) {
    const row = document.createElement("div");
    row.className = "agency-row";
    const label = document.createElement("span");
    label.className = "agency-name";
    label.textContent = name;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "60";
    input.className = "agency-term";
    input.dataset.agency = name;
    input.value = String(name in overrides ? overrides[name] : fallback);
    row.appendChild(label);
    row.appendChild(input);
    box.appendChild(row);
  }
}
function renderDeliverHint(): void {
  const on = !!CFG.deliver_alerts;
  const el = $("#deliver-hint");
  el.textContent = on ? "실제 발송: 켜짐" : "실제 발송: 꺼짐 (기록만)";
  el.className = "deliver-hint " + (on ? "deliver-on" : "deliver-off");
}
function populateSettings(): void {
  $<HTMLInputElement>("#s-deliver").checked = !!CFG.deliver_alerts;
  $<HTMLInputElement>("#s-standard-term").value = String(CFG.default_term_months ?? 24);
  $<HTMLInputElement>("#s-nonstandard-term").value = String(CFG.nonstandard_term_months ?? 6);
  buildAgencyTerms(CFG);
  const offsets = new Set((CFG.notify_offsets_days || []).map(String));
  $$(".s-offset").forEach((cb) => { (cb as HTMLInputElement).checked = offsets.has((cb as HTMLInputElement).value); });
  $<HTMLTextAreaElement>("#s-template").value = CFG.message_template || "";
  $<HTMLTextAreaElement>("#s-template-nonstandard").value = CFG.message_template_nonstandard || "";
}
function gatherSettings(): Partial<AppConfig> {
  const offsets = $$(".s-offset")
    .filter((cb) => (cb as HTMLInputElement).checked)
    .map((cb) => parseInt((cb as HTMLInputElement).value, 10));
  const nonstandard = parseInt($<HTMLInputElement>("#s-nonstandard-term").value, 10);
  const nonstandardTerm = Number.isFinite(nonstandard) ? nonstandard : 6;
  const agencyTerms: Record<string, number> = {};
  $$(".agency-term").forEach((inp) => {
    const v = parseInt((inp as HTMLInputElement).value, 10);
    const name = (inp as HTMLInputElement).dataset.agency!;
    if (Number.isFinite(v) && v !== nonstandardTerm) agencyTerms[name] = v;
  });
  return {
    deliver_alerts: $<HTMLInputElement>("#s-deliver").checked,
    default_term_months: parseInt($<HTMLInputElement>("#s-standard-term").value, 10) || 24,
    nonstandard_term_months: nonstandardTerm,
    agency_term_months: agencyTerms,
    notify_offsets_days: offsets.length ? offsets : [0],
    message_template: $<HTMLTextAreaElement>("#s-template").value,
    message_template_nonstandard: $<HTMLTextAreaElement>("#s-template-nonstandard").value,
  };
}

/* ---------- history ---------- */
async function loadHistory(): Promise<void> {
  const rows = await history.search(
    $<HTMLInputElement>("#h-query").value.trim(),
    $<HTMLInputElement>("#h-start").value,
    $<HTMLInputElement>("#h-end").value,
  );
  const list = $("#h-list");
  $("#h-empty").classList.toggle("hidden", rows.length > 0);
  list.innerHTML = "";
  for (const r of rows) {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="row-top"><span class="row-name">${esc(r.customer) || "-"}</span>
        <span class="row-phone">${esc(r.phone)}</span>
        <span class="row-tag">${esc(r.openhow) || "-"}</span></div>
      <div class="row-meta">발송 ${esc(r.sent_at.replace("T", " "))} · 개통 ${esc(r.opendate)} · 만료 ${esc(r.expiry_date)}<br>
        ${esc(r.agency)} · ${esc(r.telecom)} · ${esc(r.model)}</div>`;
    list.appendChild(el);
  }
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
  showView("main");
  renderResults();
}

/* ---------- wire up ---------- */
function bind(): void {
  $("#btn-scan").onclick = doScan;
  $("#btn-login").onclick = doLogin;
  $("#btn-test-target").onclick = addTestTarget;
  $("#btn-history").onclick = () => { showView("history"); void loadHistory(); };
  $("#btn-settings").onclick = () => { populateSettings(); showView("settings"); };
  $$("[data-back]").forEach((b) => (b.onclick = () => showView("main")));
  $("#btn-h-search").onclick = () => void loadHistory();
  $("#h-query").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void loadHistory();
  });

  $("#btn-relogin").onclick = async () => {
    const ok = await poncleLogin(CFG);
    $("#session-msg").textContent = ok ? "로그인됨" : "취소됨";
  };
  $("#btn-logout").onclick = async () => {
    await poncleLogout(CFG);
    $("#session-msg").textContent = "로그아웃됨";
    showLoginBanner(true);
  };

  $("#btn-save").onclick = async () => {
    CFG = await saveConfig({ ...CFG, ...gatherSettings() });
    renderDeliverHint();
    const msg = $("#save-msg");
    msg.textContent = "저장되었습니다.";
    setTimeout(() => { msg.textContent = ""; }, 2000);
  };
}

/* ---------- boot ---------- */
async function boot(): Promise<void> {
  bind();
  CFG = await loadConfig();
  renderDeliverHint();
  renderState("idle");
  const hasSession = await poncleHasSession(CFG).catch(() => false);
  showLoginBanner(!hasSession);
  if (hasSession) await doScan();
}

void boot();
