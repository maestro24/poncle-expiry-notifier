/**
 * App controller for 약정만료 알리미 (Android). Wires the DOM to the domain logic
 * (runs in-process in the WebView) and the native plugins. Framework-free vanilla TS.
 */
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { DEFAULTS, loadConfig, saveConfig, seedDefaultTemplates } from "./domain/config";
import { isStandardOpenType, normalizeAgency, resolveTermMonths } from "./domain/expiry";
import { buildBackup, historyToCsv, parseBackup } from "./domain/export";
import { History, preferencesKV } from "./domain/history";
import { cohortStats, COHORT_WINDOW_DAYS } from "./domain/cohort";
import { carrierBreakdown, sentTrend } from "./domain/dashboard";
import { buildLookupResults, lookupToDueItem, type LookupResult } from "./domain/lookup";
import { cleanPlan } from "./domain/plan";
import { PoncleClient, SessionExpired } from "./domain/poncle-client";
import { today } from "./domain/plaindate";
import { runScan, type ScanState } from "./domain/scan";
import { renderTemplate, sendAlert } from "./domain/sender";
import { conditionSummary, matchingTemplates } from "./domain/template-match";
import { checkForUpdate } from "./domain/updater";
import { STATUSES, TELECOMS, type AppConfig, type DueItem, type MessageTemplate, type StatusCode, type TelecomCode } from "./domain/types";
import {
  clearPoncleCredentials,
  getAppVersion,
  getPoncleCredentialsMeta,
  nativePoncleGateway,
  openExternalUrl,
  poncleHasSession,
  poncleLogin,
  poncleLogout,
  requestSmsPermission,
  savePoncleCredentials,
  sendSms,
} from "./native/adapters";

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;
const $$ = (s: string): HTMLElement[] => Array.from(document.querySelectorAll(s));

const history = new History(preferencesKV());
let CFG: AppConfig = { ...DEFAULTS };
let RESULTS: DueItem[] = [];
let LAST_SCAN = "";
let SCANNING = false; // a scan is in flight and owns the session/error banner
let DUE_QUERY = "";
let DUE_FILTER: "all" | "unsent" = "all";
let HIST_TAB: "sent" | "unvisited" = "sent";
let UNV_SHOW_EXCLUDED = false; // 미방문 탭: 수동 제외한 고객도 함께 볼지

/* 고객 조회(lookup) 상태 */
type LookupState = "initial" | "loading" | "results" | "empty" | "err-session" | "err-network";
let LK_STATE: LookupState = "initial";
let LK_RESULTS: LookupResult[] = [];
let LK_RECENT: string[] = [];
let LK_LAST_QUERY = "";
const LK_RECENT_KEY = "lookup_recent";
const LOOKUP_SOON_DAYS = 30; // "곧 만료"로 볼 임계(조회 화면 전용)

const AGENCIES = [
  "CD대리점", "DMB 엘지", "M&S분당도매센터", "MCC - 스테이지파이브SK", "MCC- SK텔링크",
  "MCC- 엠모바일", "MCC-KT엠모바일 후불유심", "mcc-kt중고후불", "MCC-미디어로그후불",
  "MCC-스카이라이프", "MCC-스테이지파이브KT", "MCC-코드모바일KT", "MCC-코드모바일LG",
  "MCC-프리티KT", "MCC-프리티LG", "MCC-프리티SK", "MCC-헬로비젼LG", "MCC/SK후불", "MCCKT",
  "PS&M", "SK경승컴퍼니온라인", "광운통신(라우터)", "대산LG", "메타레이kt", "미디어원KT",
  "쇼플러스", "유니컴즈(모빙) KT", "유니컴즈(모빙)LGT", "유니컴즈(모빙)SK", "유안-엔네트웍스",
  "티인포(mcc)",
];
const DDAY_OPTIONS = [30, 14, 7, 3, 1, 0];
const VARS: Array<[string, string]> = [
  ["고객명", "{customer}"], ["통신사", "{telecom}"], ["모델", "{model}"],
  ["만료일", "{expiry}"], ["개통일", "{opendate}"], ["시점", "{when}"],
  ["요금제", "{plan}"], ["경과개월", "{months}"], ["경과년수", "{years}"],
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

/* ---------- toast ---------- */
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string, opts: { err?: boolean; undo?: () => void } = {}): void {
  const el = $("#toast");
  el.className = "toast" + (opts.err ? " err" : "");
  el.textContent = msg;
  if (opts.undo) {
    const u = document.createElement("span");
    u.className = "toast-undo";
    u.textContent = "실행취소";
    u.onclick = () => { el.classList.add("hidden"); opts.undo!(); };
    el.appendChild(u);
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), opts.undo ? 6000 : 2600);
}

/* ---------- navigation ---------- */
type Screen = "home" | "dashboard" | "lookup" | "history" | "settings" | "terms" | "templates" | "template-edit";
// terms/templates/template-edit are sub-screens of 설정: the bottom-nav keeps
// 설정 highlighted while they're open.
const SETTINGS_FAMILY: Screen[] = ["settings", "terms", "templates", "template-edit"];
const ALL_SCREENS: Screen[] = ["home", "dashboard", "lookup", "history", "settings", "terms", "templates", "template-edit"];
let CURRENT: Screen = "home";
function showScreen(name: Screen): void {
  // Leaving a screen with editable inputs: commit pending edits (auto-save net).
  if (CURRENT === "settings" && name !== "settings") void saveSettingsNow();
  if (CURRENT === "terms" && name !== "terms") void saveTermsNow();
  CURRENT = name;
  for (const v of ALL_SCREENS) $(`#view-${v}`).classList.toggle("hidden", v !== name);
  const navName = SETTINGS_FAMILY.includes(name) ? "settings" : name;
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.nav === navName));
  if (name === "history") void loadHistory();
  if (name === "dashboard") void renderDashboard();
  if (name === "lookup") openLookup();
  if (name === "settings") { populateSettings(); void refreshSessionState(); void refreshCredsState(); }
  if (name === "terms") populateTerms();
  if (name === "templates") renderTemplateList();
}

/* ---------- state ---------- */
function renderState(state: ScanState): void {
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
function filteredResults(): DueItem[] {
  const q = DUE_QUERY.trim().toLowerCase();
  return RESULTS.filter((r) => {
    if (DUE_FILTER === "unsent" && r.already_sent) return false;
    if (q && !(String(r.customer).toLowerCase().includes(q) || String(r.phone).includes(q))) return false;
    return true;
  });
}
function renderDueList(): void {
  const list = $("#due-list");
  const rows = filteredResults();
  const unsent = RESULTS.filter((r) => !r.already_sent).length;
  $("#list-note").textContent = RESULTS.length ? `${RESULTS.length}명 · 미발송 ${unsent}명` : "";
  const empty = $("#due-empty");
  empty.classList.toggle("hidden", rows.length > 0);
  empty.textContent = RESULTS.length === 0
    ? "스캔 결과가 없습니다. “지금 다시 스캔”을 눌러 주세요."
    : "검색/필터에 맞는 대상이 없습니다.";
  list.innerHTML = "";
  for (const item of rows) list.appendChild(dueCard(item));
  renderCards();
}
/** A "요금제 …" meta line (with a leading <br>), empty when the plan is blank.
 *  Shared by the home due list and the 이력 cards. Light display cleanup only. */
function planLine(plan: string): string {
  const p = cleanPlan(plan);
  return p ? `<br>요금제 ${esc(p)}` : "";
}

function dueCard(item: DueItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "listcard" + (item.already_sent ? " sent" : "");
  const dn = item.milestone_offset === 0 ? "오늘 만료" : `D-${item.milestone_offset}`;
  card.innerHTML = `
    <div class="lc-tap">
      <div class="lc-top">
        <span class="lc-name">${esc(item.customer) || "-"}</span>
        <span class="lc-phone">${esc(item.phone)}</span>
        <span class="lc-tag tag-open">${esc(item.openhow) || "-"}</span>
        <span class="lc-dday">${dn}</span>
      </div>
      <div class="lc-meta">개통 ${esc(item.opendate)} · 만료 ${esc(item.expiry_date)}<br>
        ${esc(item.agency)} · ${esc(item.telecom)} · ${esc(item.model)}${planLine(item.plan)}</div>
    </div>
    <div class="lc-why hidden"></div>
    <div class="lc-act"></div>`;
  // Tap the card body (name/info) to reveal the "why" detail; no visible clutter.
  const tap = card.querySelector(".lc-tap") as HTMLElement;
  const whyBox = card.querySelector(".lc-why") as HTMLElement;
  tap.onclick = () => {
    const hidden = whyBox.classList.toggle("hidden");
    if (!hidden) whyBox.textContent = whyText(item);
  };
  (card.querySelector(".lc-act") as HTMLElement).appendChild(actionEl(item));
  return card;
}
function whyText(item: DueItem): string {
  // 요금제 유지일 기준으로 뜬 건은 약정 계산이 아니라 폰클 미결의 유지일을 그대로 씀.
  if (item.source === "keepdate") {
    const dn = item.milestone_offset === 0 ? "오늘" : `${item.milestone_offset}일 전`;
    return `요금제 유지일 기준 (미결 등록)\n유지일 ${item.expiry_date} · ${dn}`;
  }
  const term = resolveTermMonths({ openhowx: item.openhow, agencytitle: item.agency }, CFG);
  let basis: string;
  if (isStandardOpenType(item.openhow)) {
    basis = "표준(기변/신규)";
  } else {
    const overrides = CFG.agency_term_months || {};
    const norm = normalizeAgency(item.agency);
    const hasOverride = Object.keys(overrides).some((k) => normalizeAgency(k) === norm);
    basis = hasOverride ? "거래처 예외" : "그 외 기본";
  }
  const dn = item.milestone_offset === 0 ? "오늘 만료" : `만료 ${item.milestone_offset}일 전 (D-${item.milestone_offset})`;
  return `적용 약정 ${term}개월 · ${basis}\n개통 ${item.opendate} → 만료 ${item.expiry_date} · ${dn}`;
}
function actionEl(item: DueItem): HTMLElement {
  if (item.already_sent) {
    const b = document.createElement("span");
    b.className = "sent-badge" + (CFG.deliver_alerts ? "" : " rec");
    b.textContent = CFG.deliver_alerts ? "✓ 발송됨" : "✓ 기록됨(미발송)";
    return b;
  }
  const row = document.createElement("div");
  row.className = "lc-actions";
  const send = document.createElement("button");
  send.className = "btn-send";
  send.textContent = "알림 보내기";
  send.onclick = () => void onSend(item, send);
  const call = document.createElement("button");
  call.className = "btn-call";
  call.textContent = "통화";
  call.title = "이 번호로 전화 걸기";
  call.onclick = () => void onCall(item);
  row.appendChild(send);
  row.appendChild(call);
  return row;
}

/** After a send/skip, flip the row to its 'handled' state and refresh the list
 *  the send came from (home due list, or the 미방문 tab). */
function markHandled(item: DueItem): void {
  item.already_sent = true;
  if (CURRENT === "history") void loadHistory(); // 미방문 탭에서 보낸 경우: 안내함으로 갱신
  else if (CURRENT === "lookup") void refreshLookupInformed(); // 조회에서 보낸 경우
  else renderDueList();
}

async function onSend(item: DueItem, _btn: HTMLButtonElement): Promise<void> {
  // Record-only test rows can't demonstrate delivery; say so and stop.
  if (item.test && !CFG.deliver_alerts) {
    toast("테스트 대상: ‘실제 발송’이 꺼져 있어 아무것도 보내지 않습니다");
    return;
  }
  // Pick the outbound template by the customer's telecom + 상태.
  const matches = matchingTemplates(item, CFG.templates);
  if (matches.length === 0) { openNoTemplate(); return; }
  if (matches.length === 1) { proceedSend(item, matches[0]); return; }
  openPicker(item, matches); // several match -> staff chooses
}

/** Render the chosen template and either confirm (real send) or record (off). */
function proceedSend(item: DueItem, tpl: MessageTemplate): void {
  const body = renderTemplate(item, tpl.body);
  // Real send, or a test row while delivery is ON: confirm + preview/edit first.
  if (CFG.deliver_alerts || item.test) { openConfirm(item, body); return; }
  void recordOnlySend(item, body);
}

async function recordOnlySend(item: DueItem, body: string): Promise<void> {
  const res = await sendAlert(item, CFG, { history, sendSms, nowIso }, body);
  if (res.status === "sent" || res.status === "already") {
    markHandled(item);
    toast("기록되었습니다 (실제 발송 꺼짐)");
  } else {
    toast(res.error || "실패", { err: true });
  }
}

/* ---------- template picker + no-template prompt ---------- */
function openPicker(item: DueItem, matches: MessageTemplate[]): void {
  $("#picker-name").textContent = item.customer || "-";
  $("#picker-phone").textContent = item.phone;
  const list = $("#picker-list");
  list.innerHTML = "";
  for (const t of matches) {
    const b = document.createElement("button");
    b.className = "picker-item";
    b.innerHTML = `<div class="picker-item-name">${esc(t.name) || "(이름 없음)"}</div>
      <div class="picker-item-sub">${esc(conditionSummary(t))}</div>
      <div class="picker-item-preview">${esc(renderTemplate(item, t.body))}</div>`;
    b.onclick = () => { $("#picker-modal").classList.add("hidden"); proceedSend(item, t); };
    list.appendChild(b);
  }
  $("#picker-modal").classList.remove("hidden");
}
function openNoTemplate(): void {
  $("#notpl-modal").classList.remove("hidden");
}

/** Open the phone dialer for this customer's number (ACTION_VIEW tel:). */
async function onCall(item: DueItem): Promise<void> {
  const digits = String(item.phone || "").replace(/[^0-9+]/g, "");
  if (!digits) { toast("전화번호가 없습니다", { err: true }); return; }
  try {
    await openExternalUrl(`tel:${digits}`);
  } catch {
    toast("전화 앱을 열 수 없습니다", { err: true });
  }
}

/* ---------- confirm send modal (real send) ---------- */
let confirmItem: DueItem | null = null;
function openConfirm(item: DueItem, body: string): void {
  confirmItem = item;
  $("#confirm-name").textContent = item.customer || "-";
  $("#confirm-phone").textContent = item.phone;
  $<HTMLTextAreaElement>("#confirm-text").value = body;
  $("#confirm-modal").classList.remove("hidden");
}
async function doConfirmSend(): Promise<void> {
  const item = confirmItem;
  if (!item) return;
  const text = $<HTMLTextAreaElement>("#confirm-text").value;
  const btn = $<HTMLButtonElement>("#confirm-send");
  btn.disabled = true;
  btn.textContent = "전송 중…";

  // Test row: send directly, do NOT record or mark handled (re-sendable).
  if (item.test) {
    try {
      await sendSms(item.phone, text);
      toast("테스트 문자를 보냈습니다");
    } catch (e) {
      toast(e instanceof Error ? e.message : "발송 실패", { err: true });
    }
    btn.disabled = false;
    btn.textContent = "보내기";
    $("#confirm-modal").classList.add("hidden");
    confirmItem = null;
    return;
  }

  const res = await sendAlert(item, CFG, { history, sendSms, nowIso }, text);
  btn.disabled = false;
  btn.textContent = "보내기";
  $("#confirm-modal").classList.add("hidden");
  confirmItem = null;
  if (res.status === "sent") {
    markHandled(item);
    toast("문자를 보냈습니다");
  } else if (res.status === "already") {
    markHandled(item);
    toast("이미 발송된 고객입니다");
  } else {
    toast(res.error || "발송 실패", { err: true });
  }
}

/* ---------- scan ---------- */
async function doScan(): Promise<void> {
  renderState("scanning");
  const btn = $<HTMLButtonElement>("#btn-scan");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "스캔 중…";
  SCANNING = true; // a scan owns the session/error banner until it finishes
  try {
    const res = await runScan(nativePoncleGateway(CFG), CFG, history);
    LAST_SCAN = nowShort();
    $("#last-scan").textContent = LAST_SCAN;
    void history.setLastScan(LAST_SCAN); // 대시보드가 재시작 후에도 표시하도록 영속화
    if (res.status === "session_expired") {
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
    showBanner("none");
    RESULTS = res.results;
    await history.cacheDueList(res.results); // 대시보드 3숫자/임박/통신사 캐시
    // 미결 조회가 저하(빈 블랙리스트)된 스캔이면 미방문 캐시를 덮어쓰지 않는다 —
    // 그대로 두면 이전 정상 스캔 결과가 유지된다. 정상 스캔에서만 갱신.
    if (!res.pendingDegraded) await history.cacheUnvisited(res.unvisited);
    renderDueList();
    renderState("idle");
  } finally {
    SCANNING = false; // release the banner before re-enabling the button
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
function todayIsoLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Whole-day difference todayIso - expiryIso (UTC math, tz-safe). */
function daysSince(expiryIso: string, todayIso: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  return Math.round((ms(todayIso) - ms(expiryIso)) / 86400000);
}

/** Entry point for the 이력 screen: refresh the tab badge and render the active tab. */
async function loadHistory(): Promise<void> {
  // 미방문 목록은 마지막 스캔이 폰클에서 산출해 캐시한 것. 발송 여부(already_sent)는
  // 스캔 이후 바뀔 수 있어 이력에서 실시간 재계산한다. 수동 제외한 건은 기본 숨김이며,
  // "제외한 고객도 보기" 토글로 다시 볼 수 있다. 실제 재방문(새 개통) 건은 다음
  // 스캔에서 자동으로 빠진다 — 제외는 폰클에 안 잡히는 예외를 손으로 뺄 때만 쓴다.
  const cached = await history.loadUnvisited();
  const excluded = await history.handledKeys();
  const sentKeys = await history.dedupKeySet();
  const enriched = cached.map((r) => ({ ...r, already_sent: sentKeys.has(r.id) }));
  const outstanding = enriched.filter((r) => !excluded.has(r.id));
  const need = outstanding.length; // 배지는 '실제 미방문'(제외 항목 제외) 수
  const badge = $("#hist-unvisited-count");
  badge.textContent = String(need);
  badge.classList.toggle("hidden", need === 0);
  $("#hist-sent").classList.toggle("hidden", HIST_TAB !== "sent");
  $("#hist-unvisited").classList.toggle("hidden", HIST_TAB !== "unvisited");
  $$("#hist-tabs .histtab").forEach((b) => b.classList.toggle("on", b.dataset.htab === HIST_TAB));
  if (HIST_TAB === "sent") { await renderSentHistory(); return; }
  renderUnvisited(UNV_SHOW_EXCLUDED ? enriched : outstanding, excluded);
}

async function renderSentHistory(): Promise<void> {
  const rows = await history.search(
    $<HTMLInputElement>("#h-query").value.trim(),
    $<HTMLInputElement>("#h-start").value,
    $<HTMLInputElement>("#h-end").value,
  );
  $("#h-count").textContent = rows.length ? `${rows.length}건` : "";
  $("#h-empty").classList.toggle("hidden", rows.length > 0);
  const list = $("#h-list");
  list.innerHTML = "";
  const tag: Record<string, [string, string]> = {
    sms: ["tag-sent", "발송완료"], "record-only": ["tag-rec", "기록"], skipped: ["tag-rec", "제외"],
  };
  for (const r of rows) {
    const el = document.createElement("div");
    el.className = "listcard";
    const [tagCls, tagTxt] = tag[r.channel] ?? ["tag-rec", r.channel];
    el.innerHTML = `
      <div class="lc-top"><span class="lc-name">${esc(r.customer) || "-"}</span>
        <span class="lc-phone">${esc(r.phone)}</span>
        <span class="lc-tag ${tagCls}">${tagTxt}</span></div>
      <div class="lc-meta">개통 ${esc(r.opendate)} · 만료 ${esc(r.expiry_date)} · 처리 ${esc(r.sent_at.replace("T", " ").slice(0, 16))}<br>
        ${esc(r.agency)} · ${esc(r.telecom)} · ${esc(r.model)}${planLine(r.plan)}</div>
      ${r.body ? `<div class="lc-why">${esc(r.body)}</div>` : ""}`;
    list.appendChild(el);
  }
}

/** A 통화 button for a 미방문 card (opens the dialer for this number). */
function unvisitedCallButton(item: DueItem): HTMLButtonElement {
  const call = document.createElement("button");
  call.className = "btn-call";
  call.textContent = "통화";
  call.title = "이 번호로 전화 걸기";
  call.onclick = () => void onCall(item);
  return call;
}

function renderUnvisited(rows: DueItem[], excluded: Set<string>): void {
  const list = $("#u-list");
  $("#u-empty").classList.toggle("hidden", rows.length > 0);
  list.innerHTML = "";
  const today = todayIsoLocal();
  for (const r of rows) {
    const dplus = daysSince(r.expiry_date, today);
    const kind = r.source === "keepdate" ? "요금제 유지일" : "약정 만료";
    const meta = [esc(r.telecom) || "통신사 미상", esc(r.model)].filter(Boolean).join(" · ");
    const isExcluded = excluded.has(r.id);
    const statusTag = isExcluded
      ? `<span class="u-tag tag-done">제외됨</span>`
      : `<span class="u-tag ${r.already_sent ? "tag-sent" : "tag-miss"}">${r.already_sent ? "안내함" : "미발송"}</span>`;
    const el = document.createElement("div");
    el.className = "listcard" + (isExcluded ? " u-handled" : "");
    el.innerHTML = `
      <div class="lc-top">
        <span class="lc-name">${esc(r.customer) || "-"}</span>
        ${statusTag}
        <span class="lc-dday plus">D+${dplus}</span>
      </div>
      <div class="lc-phone u-phone">${esc(r.phone)}</div>
      <div class="lc-meta">${kind} ${esc(r.expiry_date)}${meta ? " · " + meta : ""}</div>
      <div class="u-act"></div>`;
    const act = el.querySelector(".u-act") as HTMLElement;
    if (isExcluded) {
      // 제외된 건: 통화 + 제외 해제(다시 미방문 목록으로)
      act.appendChild(unvisitedCallButton(r));
      const back = document.createElement("button");
      back.className = "btn-recontact ghost";
      back.textContent = "제외 해제";
      back.onclick = () => void unexcludeUnvisited(r);
      act.appendChild(back);
    } else {
      // 아직 안내 안 한 고객만 발송 버튼(홈과 동일: 발송한 건은 배지만) — 알림 보내기 · 통화 · 제외
      if (!r.already_sent) {
        const send = document.createElement("button");
        send.className = "btn-send";
        send.textContent = "알림 보내기";
        send.onclick = () => void onSend(r, send);
        act.appendChild(send);
      }
      act.appendChild(unvisitedCallButton(r));
      const done = document.createElement("button");
      done.className = "btn-recontact";
      done.textContent = "제외";
      done.title = "이 고객을 미방문 목록에서 빼기 (폰클에 안 잡히는 예외용)";
      done.onclick = () => void excludeUnvisited(r);
      act.appendChild(done);
    }
    list.appendChild(el);
  }
}

/** Manually drop a customer from the 미방문 list. Real returns auto-clear on the
 *  next scan (a new 개통 appears); this is only for cases Poncle won't reflect. */
async function excludeUnvisited(r: DueItem): Promise<void> {
  await history.setHandled(r.phone, r.expiry_date, true);
  await loadHistory();
  toast("미방문 목록에서 제외했습니다", {
    undo: () => {
      void (async () => {
        await history.setHandled(r.phone, r.expiry_date, false);
        await loadHistory();
      })();
    },
  });
}

/** Bring an excluded customer back into the 미방문 list. */
async function unexcludeUnvisited(r: DueItem): Promise<void> {
  await history.setHandled(r.phone, r.expiry_date, false);
  await loadHistory();
  toast("제외를 해제했습니다");
}

/* ---------- dashboard (대시보드) ---------- */
async function renderDashboard(): Promise<void> {
  const body = $("#dash-body");
  const todayD = today();
  const todayIso = todayIsoLocal();

  const due = await history.loadDueList();
  const targets = due.length;
  const unsent = due.filter((r) => !r.already_sent).length;
  const cachedUnv = await history.loadUnvisited();
  const excluded = await history.handledKeys();
  const unvisitedCount = cachedUnv.filter((r) => !excluded.has(r.id)).length;

  const soon = due
    .map((r) => ({ r, dd: -daysSince(r.expiry_date, todayIso) })) // days until expiry
    .filter((x) => x.dd >= 0 && x.dd <= 3)
    .sort((a, b) => a.dd - b.dd)
    .slice(0, 6);

  const trend = sentTrend(await history.exportAll(), todayD, 7);
  const trendMax = Math.max(1, ...trend.map((d) => d.count));
  const carriers = carrierBreakdown(due);
  const carrierMax = Math.max(1, ...carriers.map((c) => c.count));
  const cohort = cohortStats(await history.loadCohort(), todayD, COHORT_WINDOW_DAYS);

  const lastBackup = await history.getLastBackup();
  const backupDays = lastBackup ? Math.max(0, daysSince(lastBackup.slice(0, 10), todayIso)) : null;
  const showBackup = backupDays === null || backupDays >= 14;

  const bar = (pctH: number) => `height:${Math.max(0, Math.min(100, pctH))}%`;

  body.innerHTML = `
    <div class="dash-today">
      <div class="dash-today-title">오늘의 할 일</div>
      <div class="dash-today-nums">
        <div><div class="dt-num">${targets}</div><div class="dt-lbl">만료 예정</div></div>
        <div><div class="dt-num dt-warn">${unsent}</div><div class="dt-lbl">미발송 대기</div></div>
        <div><div class="dt-num dt-danger">${unvisitedCount}</div><div class="dt-lbl">미방문</div></div>
      </div>
      <div class="dash-today-foot">
        <span>마지막 스캔 <b>${esc(LAST_SCAN || "없음")}</b></span>
        <button class="dt-scan" id="dash-scan">지금 스캔</button>
      </div>
    </div>
    ${showBackup ? `
    <div class="banner banner-warn">
      <div class="banner-icon">${LK_WARN_ICON}</div>
      <div class="banner-txt">
        <div class="banner-title">${backupDays === null ? "데이터 백업을 한 적이 없습니다" : `데이터 백업이 ${backupDays}일 전입니다`}</div>
        <div class="banner-sub">이력·중복방지 기록은 폰에만 저장돼요. 설정에서 백업하세요.</div>
      </div>
      <button class="banner-btn" id="dash-backup-go">백업</button>
    </div>` : ""}
    <div class="dash-card">
      <div class="dash-h">임박 고객</div>
      <div class="dash-sub">D-3 이내 만료 대상</div>
      ${soon.length ? soon.map((x) => `
        <div class="dash-soon">
          <div class="ds-info"><div class="ds-name">${esc(x.r.customer) || "-"}</div><div class="ds-phone">${esc(x.r.phone)}</div></div>
          <span class="lc-dday ${x.dd === 0 ? "urgent" : ""}">${x.dd === 0 ? "D-day" : "D-" + x.dd}</span>
        </div>`).join("") : `<div class="dash-empty">임박 대상이 없습니다</div>`}
    </div>
    <div class="dash-card">
      <div class="dash-h">발송 추세</div>
      <div class="dash-sub">최근 7일 일별 발송 건수</div>
      <div class="dash-bars">
        ${trend.map((d) => `
          <div class="db-col">
            <div class="db-val">${d.count}</div>
            <div class="db-bartrack"><div class="db-bar" style="${bar((d.count / trendMax) * 100)}"></div></div>
            <div class="db-day">${esc(d.dayLabel)}</div>
          </div>`).join("")}
      </div>
    </div>
    <div class="dash-card">
      <div class="dash-h">통신사별 분포</div>
      <div class="dash-sub">이번 만료 대상 기준</div>
      ${carriers.length && targets ? carriers.map((c) => `
        <div class="dash-crow">
          <div class="dc-top"><span>${esc(c.name)}</span><span class="dc-cnt">${c.count}명</span></div>
          <div class="dc-track"><div class="dc-fill" style="width:${Math.round((c.count / carrierMax) * 100)}%"></div></div>
        </div>`).join("") : `<div class="dash-empty">스캔 결과가 없습니다</div>`}
    </div>
    <div class="dash-card">
      <div class="dash-h">재방문 전환율</div>
      ${cohort.total === 0 ? `
        <div class="dash-sub">최근 ${COHORT_WINDOW_DAYS}일 만료 고객 재방문 현황</div>
        <div class="dash-empty">아직 집계할 만료 고객이 없습니다.<br/>스캔을 계속하면 데이터가 쌓입니다.</div>
      ` : `
        <div class="dash-sub">최근 ${COHORT_WINDOW_DAYS}일 만료 ${cohort.total}명 중 재방문 현황</div>
        <div class="dash-rate"><span class="dr-big">${cohort.revisitRate}%</span><span class="dr-cap">${cohort.revisited}명 재방문</span></div>
        <div class="dash-div"></div>
        <div class="dash-sub2">안내 발송 여부별 재방문율</div>
        <div class="dash-crow">
          <div class="dc-top"><span>안내 발송함 (${cohort.informed}명)</span><span class="dc-pct-ok">${cohort.informedRate}%</span></div>
          <div class="dc-track"><div class="dc-fill dc-green" style="width:${cohort.informedRate}%"></div></div>
        </div>
        <div class="dash-crow">
          <div class="dc-top"><span>안내 미발송 (${cohort.uninformed}명)</span><span class="dc-pct-mut">${cohort.uninformedRate}%</span></div>
          <div class="dc-track"><div class="dc-fill dc-grey" style="width:${cohort.uninformedRate}%"></div></div>
        </div>
      `}
    </div>`;

  $("#dash-scan").onclick = () => void dashScan();
  const backupGo = document.querySelector("#dash-backup-go") as HTMLElement | null;
  if (backupGo) backupGo.onclick = () => showScreen("settings");
}

async function dashScan(): Promise<void> {
  const btn = $<HTMLButtonElement>("#dash-scan");
  btn.disabled = true;
  btn.textContent = "스캔 중…";
  try {
    await doScan();
  } finally {
    if (CURRENT === "dashboard") void renderDashboard();
  }
}

/* ---------- lookup (고객 조회) ---------- */
const LK_WARN_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2.5L1.5 21h21L12 2.5z" stroke="white" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9V13" stroke="white" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1" fill="white"/></svg>`;
const LK_ERR_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.5" stroke="white" stroke-width="1.8"/><path d="M12 8V13" stroke="white" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1" fill="white"/></svg>`;
const LK_CALL_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 4H9L11 9L8.5 10.5C9.5 12.7 11.3 14.5 13.5 15.5L15 13L20 15V19C20 20.1 19.1 21 18 21C10.3 20.5 3.5 13.7 3 6C3 4.9 3.9 4 5 4Z" stroke="#1e7a37" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
const LK_COPY_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="12" rx="2" stroke="#4b4d51" stroke-width="1.8"/><path d="M16 8V6C16 4.9 15.1 4 14 4H6C4.9 4 4 4.9 4 6V14C4 15.1 4.9 16 6 16H8" stroke="#4b4d51" stroke-width="1.8"/></svg>`;

/** Entry when the 조회 tab opens: reflect current state + input chrome. */
function openLookup(): void {
  updateLookupInputChrome($<HTMLInputElement>("#lk-query").value);
  renderLookup();
}

function updateLookupInputChrome(value: string): void {
  const q = value.trim();
  $("#lk-clear").classList.toggle("hidden", value.length === 0);
  $("#lk-tooshort").classList.toggle("hidden", !(q.length > 0 && q.length < 2));
}

/** phone|expiry -> latest sent_at, for the 안내 이력 join (skips 'skipped'). */
async function lookupSentIndex(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const r of await history.exportAll()) {
    if (r.channel === "skipped") continue;
    const key = `${r.phone}|${r.expiry_date}`;
    const prev = map.get(key);
    if (!prev || r.sent_at > prev) map.set(key, r.sent_at);
  }
  return map;
}

async function submitLookup(): Promise<void> {
  const q = $<HTMLInputElement>("#lk-query").value.trim();
  updateLookupInputChrome(q);
  if (q.length < 2) return;
  LK_STATE = "loading";
  renderLookup();
  try {
    const client = new PoncleClient(nativePoncleGateway(CFG), CFG);
    const rows = await client.searchCustomers(q);
    const sent = await lookupSentIndex();
    LK_RESULTS = buildLookupResults(rows, CFG, today(), LOOKUP_SOON_DAYS, sent);
    LK_LAST_QUERY = q;
    LK_STATE = LK_RESULTS.length ? "results" : "empty";
    pushRecent(q);
  } catch (e) {
    LK_STATE = e instanceof SessionExpired ? "err-session" : "err-network";
  }
  renderLookup();
}

function pushRecent(q: string): void {
  LK_RECENT = [q, ...LK_RECENT.filter((r) => r !== q)].slice(0, 6);
  void Preferences.set({ key: LK_RECENT_KEY, value: JSON.stringify(LK_RECENT) });
}

async function loadRecent(): Promise<void> {
  const { value } = await Preferences.get({ key: LK_RECENT_KEY });
  if (!value) return;
  try {
    const a = JSON.parse(value);
    if (Array.isArray(a)) LK_RECENT = a.filter((x) => typeof x === "string").slice(0, 6);
  } catch {
    /* ignore corrupt recent list */
  }
}

function clearLookup(): void {
  $<HTMLInputElement>("#lk-query").value = "";
  LK_STATE = "initial";
  LK_RESULTS = [];
  updateLookupInputChrome("");
  renderLookup();
}

/** After a send from the 조회 tab: refresh the 안내 이력 badge from the sent log. */
async function refreshLookupInformed(): Promise<void> {
  const sent = await lookupSentIndex();
  LK_RESULTS = LK_RESULTS.map((r) => ({ ...r, informedAt: sent.get(r.id) ?? r.informedAt }));
  if (LK_STATE === "results") renderLookupResults();
}

function renderLookup(): void {
  const body = $("#lk-body");
  if (LK_STATE === "loading") {
    body.innerHTML = `<div class="lk-center"><div class="spinner"></div><div class="lk-note">조회 중…</div></div>`;
    return;
  }
  if (LK_STATE === "err-session") {
    body.innerHTML = `<div class="banner banner-warn"><div class="banner-icon">${LK_WARN_ICON}</div><div class="banner-txt"><div class="banner-title">폰클 세션이 만료되었습니다</div><div class="banner-sub">재로그인 후 다시 조회하세요</div></div><button class="banner-btn" id="lk-login">로그인</button></div>`;
    $("#lk-login").onclick = () => void doLogin();
    return;
  }
  if (LK_STATE === "err-network") {
    body.innerHTML = `<div class="banner banner-error"><div class="banner-icon">${LK_ERR_ICON}</div><div class="banner-txt"><div class="banner-title">네트워크 오류가 발생했습니다</div><div class="banner-sub">잠시 후 다시 시도하세요</div></div><button class="banner-btn banner-btn-red" id="lk-retry">재시도</button></div>`;
    $("#lk-retry").onclick = () => void submitLookup();
    return;
  }
  if (LK_STATE === "empty") {
    body.innerHTML = `<div class="lk-center lk-empty">‘${esc(LK_LAST_QUERY)}’ 일치하는 고객이 없습니다</div>`;
    return;
  }
  if (LK_STATE === "results") {
    renderLookupResults();
    return;
  }
  const chips = LK_RECENT.length
    ? `<div class="lk-recent-label">최근 조회</div><div class="lk-recent">${LK_RECENT.map((q) => `<button class="lk-chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`
    : "";
  body.innerHTML = `${chips}<div class="lk-center lk-initial"><svg width="34" height="34" viewBox="0 0 24 24" fill="none"><circle cx="10.5" cy="10.5" r="6.5" stroke="#d7d9db" stroke-width="2"/><path d="M20 20L15 15" stroke="#d7d9db" stroke-width="2" stroke-linecap="round"/></svg><div>고객명 또는 전화번호를 검색해<br/>현재 약정 상태를 바로 확인하세요</div></div>`;
  for (const b of $$("#lk-body .lk-chip")) {
    b.onclick = () => {
      const q = b.dataset.q ?? "";
      $<HTMLInputElement>("#lk-query").value = q;
      updateLookupInputChrome(q);
      void submitLookup();
    };
  }
}

function renderLookupResults(): void {
  const body = $("#lk-body");
  body.innerHTML = `<div class="lk-count">${LK_RESULTS.length}명 검색됨</div>` + LK_RESULTS.map(lookupCardHtml).join("");
  for (const el of $$("#lk-body .lk-card")) {
    const r = LK_RESULTS.find((x) => x.id === el.dataset.id);
    if (!r) continue;
    const send = el.querySelector(".lk-send") as HTMLElement | null;
    if (send) send.onclick = () => void onLookupSend(r);
    (el.querySelector(".lk-copy") as HTMLElement).onclick = () => void onLookupCopy(r);
  }
}

function lookupCardHtml(r: LookupResult): string {
  const digits = String(r.phone).replace(/[^0-9+]/g, "");
  const informed = r.informedAt
    ? `<span class="lk-inf-yes">안내함 · ${esc(r.informedAt.slice(0, 10))} 발송</span>`
    : `<span class="lk-inf-no">안내 내역 없음</span>`;
  return `
    <div class="lk-card" data-id="${esc(r.id)}">
      <div class="lk-card-top">
        <span class="lk-name">${esc(r.customer) || "-"}</span>
        <span class="lk-status tone-${r.status.tone}">${esc(r.status.label)}</span>
      </div>
      <div class="lk-phone">${esc(r.phone)}</div>
      <div class="lk-grid">
        <div><div class="lk-k">개통일</div><div class="lk-v">${esc(r.opendate) || "-"}</div></div>
        <div><div class="lk-k">만료일</div><div class="lk-v">${esc(r.expiry_date) || "무약정"}</div></div>
        <div><div class="lk-k">통신사 · 거래처</div><div class="lk-v">${esc(r.telecom) || "-"} · ${esc(r.agency) || "-"}</div></div>
        <div><div class="lk-k">모델</div><div class="lk-v">${esc(r.model) || "-"}</div></div>
        <div><div class="lk-k">담당</div><div class="lk-v">${esc(r.staff) || "-"}</div></div>
        <div><div class="lk-k">안내 이력</div><div class="lk-v">${informed}</div></div>
        <div class="lk-full"><div class="lk-k">요금제</div><div class="lk-v">${esc(cleanPlan(r.plan)) || "-"}</div></div>
      </div>
      <div class="lk-actions">
        ${r.expiry_date ? `<button class="lk-send btn-send">알림 보내기</button>` : ""}
        <a class="lk-call" href="tel:${esc(digits)}" aria-label="통화">${LK_CALL_ICON}</a>
        <button class="lk-copy" aria-label="번호 복사">${LK_COPY_ICON}</button>
      </div>
    </div>`;
}

async function onLookupSend(r: LookupResult): Promise<void> {
  await onSend(lookupToDueItem(r), document.createElement("button"));
}

async function onLookupCopy(r: LookupResult): Promise<void> {
  try {
    await navigator.clipboard.writeText(r.phone);
    toast("번호가 복사되었습니다");
  } catch {
    toast("복사에 실패했습니다", { err: true });
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
  const selected = Math.max(...(CFG.notify_offsets_days || [0]).map(Number));
  for (const v of DDAY_OPTIONS) {
    const b = document.createElement("button");
    b.className = "chip" + (v === selected ? " on" : "");
    b.dataset.dday = String(v);
    b.textContent = v === 0 ? "당일만" : `${v}일 전부터`;
    b.onclick = () => {
      for (const c of $$("#dday-chips .chip")) c.classList.remove("on");
      b.classList.add("on");
      void saveSettingsNow();
    };
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
function populateSettings(): void {
  buildDDayChips();
  $("#s-deliver").classList.toggle("on", !!CFG.deliver_alerts);
}
function gatherSettings(): Partial<AppConfig> {
  const offsets = $$("#dday-chips .chip")
    .filter((c) => c.classList.contains("on"))
    .map((c) => parseInt(c.dataset.dday!, 10));
  return {
    deliver_alerts: $("#s-deliver").classList.contains("on"),
    notify_offsets_days: offsets.length ? offsets : [0],
  };
}
/** Persist the current settings form immediately (auto-save; 저장 is optional). */
async function saveSettingsNow(): Promise<void> {
  CFG = await saveConfig({ ...CFG, ...gatherSettings() });
}

/* ---------- terms (약정 기간) sub-screen ---------- */
function populateTerms(): void {
  $<HTMLInputElement>("#s-standard-term").value = String(CFG.default_term_months ?? 24);
  $<HTMLInputElement>("#s-nonstandard-term").value = String(CFG.nonstandard_term_months ?? 6);
  $<HTMLInputElement>("#s-unvisited-lookback").value = String(CFG.unvisited_lookback_months ?? 6);
  buildAgencyTerms();
}
function gatherTerms(): Partial<AppConfig> {
  const nonstandard = parseInt($<HTMLInputElement>("#s-nonstandard-term").value, 10);
  const nonstandardTerm = Number.isFinite(nonstandard) ? nonstandard : 6;
  const lookbackRaw = parseInt($<HTMLInputElement>("#s-unvisited-lookback").value, 10);
  const lookback = Number.isFinite(lookbackRaw) ? Math.max(0, Math.min(36, lookbackRaw)) : 6;
  const agencyTerms: Record<string, number> = {};
  $$(".agency-term").forEach((inp) => {
    const v = parseInt((inp as HTMLInputElement).value, 10);
    const name = (inp as HTMLInputElement).dataset.agency!;
    if (Number.isFinite(v) && v !== nonstandardTerm) agencyTerms[name] = v;
  });
  return {
    default_term_months: parseInt($<HTMLInputElement>("#s-standard-term").value, 10) || 24,
    nonstandard_term_months: nonstandardTerm,
    unvisited_lookback_months: lookback,
    agency_term_months: agencyTerms,
  };
}
async function saveTermsNow(): Promise<void> {
  CFG = await saveConfig({ ...CFG, ...gatherTerms() });
}

/* ---------- templates (발송 문구) sub-screens ---------- */
let editingId: string | null = null;
function newTemplateId(): string {
  return "tpl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function renderTemplateList(): void {
  const list = $("#tpl-list");
  const tpls = CFG.templates || [];
  $("#tpl-empty").classList.toggle("hidden", tpls.length > 0);
  list.innerHTML = "";
  for (const t of tpls) {
    const card = document.createElement("div");
    card.className = "listcard tpl-card";
    const preview = t.body.trim().replace(/\s+/g, " ").slice(0, 80);
    card.innerHTML = `
      <div class="lc-top"><span class="lc-name">${esc(t.name) || "(이름 없음)"}</span>
        <span class="lc-tag tag-open">${esc(conditionSummary(t))}</span></div>
      <div class="lc-meta">${esc(preview) || "(내용 없음)"}</div>`;
    card.onclick = () => openTemplateEdit(t.id);
    list.appendChild(card);
  }
}
function buildCheckChips(holderId: string, options: readonly string[], selected: string[]): void {
  const box = $("#" + holderId);
  box.innerHTML = "";
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "checkchip" + (selected.includes(opt) ? " on" : "");
    b.dataset.val = opt;
    b.textContent = opt;
    b.onclick = () => b.classList.toggle("on");
    box.appendChild(b);
  }
}
function gatherCheck(holderId: string): string[] {
  return $$("#" + holderId + " .checkchip")
    .filter((c) => c.classList.contains("on"))
    .map((c) => c.dataset.val!);
}
function openTemplateEdit(id: string | null): void {
  editingId = id;
  const t = id ? (CFG.templates || []).find((x) => x.id === id) : null;
  $("#te-title").textContent = t ? "템플릿 수정" : "새 템플릿";
  $<HTMLInputElement>("#te-name").value = t?.name || "";
  $<HTMLTextAreaElement>("#te-body").value = t?.body || "";
  buildCheckChips("te-telecoms", TELECOMS, t?.telecoms ?? []);
  buildCheckChips("te-statuses", STATUSES, t?.statuses ?? []);
  buildVarChips();
  $("#te-msg").textContent = "";
  $("#btn-te-delete").classList.toggle("hidden", !t);
  showScreen("template-edit");
}
async function saveTemplate(): Promise<void> {
  const name = $<HTMLInputElement>("#te-name").value.trim();
  const body = $<HTMLTextAreaElement>("#te-body").value.trim();
  if (!body) { $("#te-msg").textContent = "문구를 입력하세요"; return; }
  const telecoms = gatherCheck("te-telecoms") as TelecomCode[];
  const statuses = gatherCheck("te-statuses") as StatusCode[];
  const tpls: MessageTemplate[] = [...(CFG.templates || [])];
  if (editingId) {
    const i = tpls.findIndex((x) => x.id === editingId);
    if (i >= 0) tpls[i] = { id: editingId, name, telecoms, statuses, body };
  } else {
    tpls.push({ id: newTemplateId(), name, telecoms, statuses, body });
  }
  CFG = await saveConfig({ ...CFG, templates: tpls });
  toast("템플릿을 저장했습니다");
  showScreen("templates");
}
async function deleteTemplate(): Promise<void> {
  if (!editingId) return;
  const tpls = (CFG.templates || []).filter((x) => x.id !== editingId);
  CFG = await saveConfig({ ...CFG, templates: tpls });
  toast("템플릿을 삭제했습니다");
  showScreen("templates");
}
async function refreshSessionState(): Promise<void> {
  const has = await poncleHasSession(CFG).catch(() => false);
  $("#session-state").textContent = has ? "로그인됨" : "로그아웃 상태 · 로그인이 필요합니다";
}
async function refreshCredsState(): Promise<void> {
  const meta = await getPoncleCredentialsMeta().catch(() => ({ hasCreds: false, id: "" }));
  $<HTMLInputElement>("#s-poncle-id").value = meta.id || "";
  $("#creds-msg").textContent = meta.hasCreds ? "저장됨 · 로그인 화면에서 자동 입력됩니다" : "";
}

/* ---------- export / backup ---------- */
async function shareText(title: string, text: string): Promise<void> {
  try {
    await Share.share({ title, text, dialogTitle: title });
  } catch {
    // Web preview / no share target: copy to clipboard as a fallback.
    try { await navigator.clipboard.writeText(text); toast("클립보드에 복사했습니다"); } catch { toast("공유를 사용할 수 없습니다", { err: true }); }
  }
}
async function exportCsv(): Promise<void> {
  const rows = await history.exportAll();
  if (rows.length === 0) { toast("내보낼 이력이 없습니다"); return; }
  await shareText("발송 이력 (CSV)", historyToCsv(rows));
}
async function exportBackup(): Promise<void> {
  const backup = buildBackup(CFG, await history.exportAll(), nowIso());
  await shareText("약정만료 알리미 백업", JSON.stringify(backup));
  await history.setLastBackup(nowIso()); // 대시보드 백업 리마인더 기준
}
async function doRestore(): Promise<void> {
  const text = $<HTMLTextAreaElement>("#restore-text").value.trim();
  const msg = $("#backup-msg");
  const backup = parseBackup(text);
  if (!backup) { msg.textContent = "백업 형식이 아닙니다"; return; }
  await history.replaceAll(backup.history);
  if (backup.config) CFG = await saveConfig(backup.config);
  $<HTMLTextAreaElement>("#restore-text").value = "";
  msg.textContent = `복원됨 (이력 ${backup.history.length}건)`;
  toast("복원되었습니다");
}

/* ---------- onboarding ---------- */
const ONB_KEY = "onboarded_v1";
interface OnbStep { title: string; body: string; action?: { label: string; run: () => Promise<void> } }
let onbIndex = 0;
let ONB_STEPS: OnbStep[] = [];
function buildOnbSteps(): OnbStep[] {
  return [
    {
      title: "약정만료 알리미",
      body: "폰클에서 약정 만료가 다가온 고객을 찾아, 이 폰에서 바로 문자로 안내합니다. 문자를 보내려면 문자 권한이 필요합니다.",
      action: { label: "문자 권한 허용", run: async () => { await requestSmsPermission(); } },
    },
    {
      title: "폰클 로그인",
      body: "폰클에 로그인하면 고객 목록을 읽어옵니다. 로그인 화면에서 보안문자(로봇 아님)만 직접 눌러 주세요. 아이디·비밀번호는 자동으로 저장돼 다음부터 자동 입력됩니다.",
      action: { label: "폰클 로그인", run: async () => { await poncleLogin(CFG); } },
    },
    {
      title: "문자 발송 테스트",
      body: "실제로 문자가 나가는지 먼저 내 번호로 확인하는 걸 권장합니다. 설정 > ‘문자 발송 테스트’에서 내 번호로 보내 보세요.",
    },
    {
      title: "발송 모드 선택",
      body: "‘실제 발송’을 켜면 고객에게 진짜 문자가 나갑니다. 꺼두면 이력에만 기록됩니다(연습용). 지금 켤 수 있고, 나중에 설정에서 바꿀 수 있습니다.",
      action: { label: "실제 발송 켜기", run: async () => { CFG = await saveConfig({ ...CFG, deliver_alerts: true }); } },
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
    btn.textContent = s.action.label;
    btn.onclick = async () => { btn.disabled = true; await s.action!.run(); btn.disabled = false; btn.textContent = s.action!.label + " ✓"; };
    body.appendChild(document.createElement("br"));
    body.appendChild(btn);
  }
  $("#onb-next").textContent = onbIndex >= ONB_STEPS.length - 1 ? "시작하기" : "다음";
}
async function finishOnb(): Promise<void> {
  $("#onboarding").classList.add("hidden");
  await Preferences.set({ key: ONB_KEY, value: "1" });
  // The onboarding login step may have just logged in -> re-check session so the
  // home banner clears and a scan runs without a manual tap.
  await refreshHome();
  // The boot-time update check bailed while onboarding was on screen; run it now.
  void checkUpdate();
}
async function maybeOnboard(): Promise<boolean> {
  const { value } = await Preferences.get({ key: ONB_KEY }).catch(() => ({ value: null }));
  if (value === "1") return false;
  ONB_STEPS = buildOnbSteps();
  onbIndex = 0;
  renderOnb();
  $("#onboarding").classList.remove("hidden");
  return true;
}

/* ---------- test target ---------- */
function addTestTarget(): void {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const yy = `${p(now.getFullYear() % 100)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  // Test rows are exempt from dedup: always sendable, never recorded.
  RESULTS = RESULTS.concat([{
    id: `test:${now.getTime()}`,
    phone: "010-1234-5678", customer: "홍길동(테스트)", opendate: yy, expiry_date: iso,
    milestone_offset: 0, telecom: "SK텔레콤", agency: "테스트대리점", openhow: "번호이동",
    plan: "5G 프리미어 에센셜 55000", model: "테스트모델", staff: "", already_sent: false, test: true,
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

  // Home due-list search + filter
  $("#due-query").addEventListener("input", (e) => {
    DUE_QUERY = (e.target as HTMLInputElement).value;
    renderDueList();
  });
  $$("#due-filter-chips .chip").forEach((c) => {
    c.onclick = () => {
      $$("#due-filter-chips .chip").forEach((x) => x.classList.remove("on"));
      c.classList.add("on");
      DUE_FILTER = (c.dataset.duefilter as "all" | "unsent") ?? "all";
      renderDueList();
    };
  });

  // Confirm-send modal
  $("#confirm-cancel").onclick = () => { $("#confirm-modal").classList.add("hidden"); confirmItem = null; };
  $("#confirm-send").onclick = () => void doConfirmSend();

  // Template picker + no-template prompt
  $("#picker-cancel").onclick = () => $("#picker-modal").classList.add("hidden");
  $("#notpl-close").onclick = () => $("#notpl-modal").classList.add("hidden");
  $("#btn-notpl-add").onclick = () => { $("#notpl-modal").classList.add("hidden"); openTemplateEdit(null); };

  // Templates
  $("#btn-tpl-new").onclick = () => openTemplateEdit(null);
  $("#btn-te-save").onclick = () => void saveTemplate();
  $("#btn-te-delete").onclick = () => void deleteTemplate();

  // Terms sub-screen: auto-save any term field on change (blur).
  $("#view-terms").addEventListener("change", () => void saveTermsNow());

  // History tabs (발송 이력 / 미방문 고객)
  $$("#hist-tabs .histtab").forEach((b) => {
    b.onclick = () => { HIST_TAB = (b.dataset.htab as "sent" | "unvisited") ?? "sent"; void loadHistory(); };
  });
  // History filters (발송 이력 tab)
  $("#h-query").addEventListener("input", () => void loadHistory());
  $("#h-start").addEventListener("change", () => void loadHistory());
  $("#h-end").addEventListener("change", () => void loadHistory());
  // 미방문 탭: 제외한 고객도 보기 토글
  $<HTMLInputElement>("#u-show-excluded").addEventListener("change", (e) => {
    UNV_SHOW_EXCLUDED = (e.target as HTMLInputElement).checked;
    void loadHistory();
  });

  // 고객 조회 탭
  $("#lk-query").addEventListener("input", (e) => updateLookupInputChrome((e.target as HTMLInputElement).value));
  $("#lk-query").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void submitLookup(); });
  $("#lk-submit").onclick = () => void submitLookup();
  $("#lk-clear").onclick = () => clearLookup();

  // Settings
  $("#s-deliver").onclick = async () => {
    const el = $("#s-deliver");
    const nowOn = !el.classList.contains("on");
    el.classList.toggle("on", nowOn);
    await saveSettingsNow();
    if (nowOn) await requestSmsPermission();
  };
  // Auto-save any settings field on change (blur), so 저장 is optional.
  $("#view-settings").addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    // credentials + restore/test inputs manage their own state; skip them.
    if (t.closest("#s-poncle-id, #s-poncle-pw, #s-test-phone, #restore-text")) return;
    void saveSettingsNow();
  });
  $("#btn-relogin").onclick = async () => {
    const ok = await poncleLogin(CFG);
    $("#session-state").textContent = ok ? "로그인됨" : "로그인 취소됨";
  };
  $("#btn-logout").onclick = async () => {
    await poncleLogout(CFG);
    $("#session-state").textContent = "로그아웃됨";
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
  $("#btn-test-sms").onclick = async () => {
    const phone = $<HTMLInputElement>("#s-test-phone").value.trim();
    const msg = $("#test-sms-msg");
    if (!phone) { msg.textContent = "번호를 입력하세요"; return; }
    msg.textContent = "전송 중…";
    try {
      await sendSms(phone, "[약정만료 알리미] 테스트 문자입니다. 정상 수신되면 발송 설정이 완료된 것입니다.");
      msg.textContent = "전송됨 ✓ 수신 확인해 보세요";
    } catch (e) {
      msg.textContent = "실패: " + (e instanceof Error ? e.message : String(e));
    }
  };

  // Backup / export
  $("#btn-export-csv").onclick = () => void exportCsv();
  $("#btn-export-backup").onclick = () => void exportBackup();
  $("#btn-restore").onclick = () => void doRestore();

  $("#btn-save").onclick = async () => {
    await saveSettingsNow();
    renderDueList();
    toast("저장되었습니다");
  };

  // Onboarding
  $("#onb-next").onclick = async () => {
    if (onbIndex >= ONB_STEPS.length - 1) { await finishOnb(); return; }
    onbIndex++;
    renderOnb();
  };
  $("#onb-skip").onclick = () => void finishOnb();
}

/* ---------- update ---------- */
// Checked at boot, on every foreground return, and on a 30-min timer while running,
// so a new release surfaces the 설치 prompt during use — not only after a restart.
const UPDATE_POLL_MS = 30 * 60 * 1000; // background poll cadence while foregrounded
const UPDATE_MIN_GAP_MS = 20 * 60 * 1000; // min gap between actual GitHub checks (rate-limit friendly)
let lastUpdateCheck = 0; // ms of the last network check (in-memory debounce)
let updateDismissedVersion = ""; // version the user dismissed — muted THIS session only
let updateChecking = false; // re-entrancy guard for overlapping triggers

/** True if any overlay (onboarding, confirm-send, picker, no-template, or the
 *  update modal itself) is currently open. We never pop the update prompt over
 *  one — it shares the same z-index and would stack. */
function anyModalOpen(): boolean {
  return $$(".modal-overlay:not(.hidden)").length > 0;
}

async function checkUpdate(): Promise<void> {
  if (updateChecking) return;
  if (anyModalOpen()) return; // don't stack over another overlay; a later trigger retries
  const now = Date.now();
  if (now - lastUpdateCheck < UPDATE_MIN_GAP_MS) return;
  updateChecking = true;
  lastUpdateCheck = now;
  try {
    const current = await getAppVersion().catch(() => "");
    if (!current || current === "0.0.0") return;
    const info = await checkForUpdate(current);
    if (!info.available || !info.url) return;
    // Don't nag: once the user dismisses a version (나중에 OR 업데이트), stay quiet until
    // a newer one appears (or the app restarts, which re-prompts — prior behavior).
    if (updateDismissedVersion === info.version) return;
    // A modal may have opened during the awaits above — re-check before showing.
    if (anyModalOpen()) return;
    $("#upd-current").textContent = "v" + current;
    $("#upd-latest").textContent = "v" + info.version;
    $("#upd-notes").textContent = info.notes || "";
    const modal = $("#update-modal");
    $("#upd-later").onclick = () => {
      modal.classList.add("hidden");
      updateDismissedVersion = info.version;
    };
    $("#upd-now").onclick = () => {
      void openExternalUrl(info.url);
      updateDismissedVersion = info.version; // muted so it won't re-pop mid-download
      modal.classList.add("hidden");
    };
    modal.classList.remove("hidden");
  } finally {
    updateChecking = false;
  }
}

/** Re-evaluate session + refresh the home banner / scan. */
async function refreshHome(): Promise<void> {
  const hasSession = await poncleHasSession(CFG).catch(() => false);
  showBanner(hasSession ? "none" : "session");
  if (hasSession) await doScan();
}

/**
 * Re-check the session when the app returns to the foreground, to clear a now-stale
 * "세션 만료" banner once the native layer has restored the persisted cookie. Two
 * deliberate choices:
 *  - We only act when a session banner is actually showing (nothing else to fix),
 *    which also means we only hit the network in the recovery case.
 *  - We probe with the authoritative check() (a real listOpen round-trip), NOT mere
 *    cookie presence: the restored cookie is present even after a *server-side*
 *    timeout, so a presence check would wrongly clear a legitimate banner. We clear
 *    ONLY on a positive probe; a negative result (true expiry OR a transient network
 *    error — check() can't tell them apart) leaves the banner untouched. We never
 *    force a scan; the user taps 스캔 when ready.
 */
let resumeChecking = false;
async function onForeground(): Promise<void> {
  if (resumeChecking || SCANNING) return; // a scan owns the banner; don't race it
  if ($("#session-banner").classList.contains("hidden")) return; // nothing to recover
  resumeChecking = true;
  try {
    const ok = await nativePoncleGateway(CFG).check().catch(() => false);
    if (SCANNING) return; // a scan started during the probe — let it set the banner
    // Re-read: state may have changed while the probe was in flight.
    if ($("#session-banner").classList.contains("hidden")) return;
    if (ok) showBanner("none"); // session genuinely valid again — clear stale banner
  } finally {
    resumeChecking = false;
  }
}

/* ---------- boot ---------- */
async function boot(): Promise<void> {
  bind();
  await seedDefaultTemplates(); // 기본 템플릿 2종 최초 1회 주입 (이후 수정/삭제 자유)
  CFG = await loadConfig();
  await history.migrateRecontacted(); // v1.1.x 연락완료 -> 제외(handled), one-time
  await loadRecent(); // 조회 최근 검색어
  LAST_SCAN = await history.getLastScan(); // 대시보드/홈 마지막 스캔 표시 복원
  if (LAST_SCAN) $("#last-scan").textContent = LAST_SCAN;
  renderState("idle");
  // Onboarding first-run gates the session check: finishOnb() calls refreshHome()
  // after the login step, so we don't show the login banner over a fresh login.
  const onboarding = await maybeOnboard();
  if (!onboarding) await refreshHome();
  void checkUpdate();
  // Keep checking while the app runs (Android throttles this timer when backgrounded;
  // the visibilitychange handler covers foreground returns).
  window.setInterval(() => void checkUpdate(), UPDATE_POLL_MS);
}

void boot();
