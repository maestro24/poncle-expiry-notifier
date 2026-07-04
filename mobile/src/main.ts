/**
 * App controller for 약정만료 알리미 (Android). Wires the DOM to the domain logic
 * (runs in-process in the WebView) and the native plugins. Framework-free vanilla TS.
 */
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { DEFAULTS, loadConfig, saveConfig } from "./domain/config";
import { isStandardOpenType, normalizeAgency, resolveTermMonths } from "./domain/expiry";
import { buildBackup, historyToCsv, parseBackup } from "./domain/export";
import { History, preferencesKV } from "./domain/history";
import { runScan, type ScanState } from "./domain/scan";
import { dueItemToEntry, renderAlertText, sendAlert } from "./domain/sender";
import { checkForUpdate } from "./domain/updater";
import type { AppConfig, DueItem } from "./domain/types";
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
let DUE_QUERY = "";
let DUE_FILTER: "all" | "unsent" = "all";

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
type Screen = "home" | "history" | "settings";
let CURRENT: Screen = "home";
function showScreen(name: Screen): void {
  // Leaving settings: commit any pending edits (auto-save safety net).
  if (CURRENT === "settings" && name !== "settings") void saveSettingsNow();
  CURRENT = name;
  for (const v of ["home", "history", "settings"] as Screen[]) {
    $(`#view-${v}`).classList.toggle("hidden", v !== name);
  }
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  if (name === "history") void loadHistory();
  if (name === "settings") { populateSettings(); void refreshSessionState(); void refreshCredsState(); }
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
      </div>
      <div class="lc-meta">개통 ${esc(item.opendate)} · 만료 ${esc(item.expiry_date)} · <b>${dn}</b><br>
        ${esc(item.agency)} · ${esc(item.telecom)} · ${esc(item.model)}</div>
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
  const skip = document.createElement("button");
  skip.className = "btn-skip";
  skip.textContent = "제외";
  skip.title = "이미 다른 방법으로 안내함";
  skip.onclick = () => void onSkip(item);
  row.appendChild(send);
  row.appendChild(skip);
  return row;
}

/** After a send/skip, flip the row to its 'handled' state in place. */
function markHandled(item: DueItem): void {
  item.already_sent = true;
  renderDueList();
}

async function onSend(item: DueItem, btn: HTMLButtonElement): Promise<void> {
  // Test rows: send (if delivery on) but never record/dedup, so they stay re-sendable.
  if (item.test) {
    if (CFG.deliver_alerts) { openConfirm(item); return; }
    toast("테스트 대상: ‘실제 발송’이 꺼져 있어 아무것도 보내지 않습니다");
    return;
  }
  // Real send: confirm + preview/edit first. Record-only: no confirmation needed.
  if (CFG.deliver_alerts) {
    openConfirm(item);
    return;
  }
  btn.disabled = true;
  const res = await sendAlert(item, CFG, { history, sendSms, nowIso });
  if (res.status === "sent" || res.status === "already") {
    markHandled(item);
    toast("기록되었습니다 (실제 발송 꺼짐)");
  } else {
    btn.disabled = false;
    toast(res.error || "실패", { err: true });
  }
}

async function onSkip(item: DueItem): Promise<void> {
  await history.recordSent(dueItemToEntry(item, ""), "skipped", nowIso());
  markHandled(item);
  toast(`${item.customer || item.phone} 제외됨`, {
    undo: () => {
      void (async () => {
        await history.remove(item.phone, item.expiry_date);
        item.already_sent = false;
        renderDueList();
      })();
    },
  });
}

/* ---------- confirm send modal (real send) ---------- */
let confirmItem: DueItem | null = null;
function openConfirm(item: DueItem): void {
  confirmItem = item;
  $("#confirm-name").textContent = item.customer || "-";
  $("#confirm-phone").textContent = item.phone;
  $<HTMLTextAreaElement>("#confirm-text").value = renderAlertText(item, CFG);
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
      toast(res.error || "스캔 실패", { err: true });
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
  const tag: Record<string, [string, string]> = {
    sms: ["tag-sent", "발송"], "record-only": ["tag-rec", "기록"], skipped: ["tag-rec", "제외"],
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
        ${esc(r.agency)} · ${esc(r.telecom)} · ${esc(r.model)}</div>
      ${r.body ? `<div class="lc-why">${esc(r.body)}</div>` : ""}`;
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
  $<HTMLInputElement>("#s-standard-term").value = String(CFG.default_term_months ?? 24);
  $<HTMLInputElement>("#s-nonstandard-term").value = String(CFG.nonstandard_term_months ?? 6);
  buildAgencyTerms();
  buildDDayChips();
  buildVarChips();
  $<HTMLTextAreaElement>("#s-template").value = CFG.message_template || "";
  $<HTMLTextAreaElement>("#s-template-nonstandard").value = CFG.message_template_nonstandard || "";
  $("#s-deliver").classList.toggle("on", !!CFG.deliver_alerts);
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
/** Persist the current settings form immediately (auto-save; 저장 is optional). */
async function saveSettingsNow(): Promise<void> {
  CFG = await saveConfig({ ...CFG, ...gatherSettings() });
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
    plan: "", model: "테스트모델", staff: "", already_sent: false, test: true,
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

  // History filters
  $("#h-query").addEventListener("input", () => void loadHistory());
  $("#h-start").addEventListener("change", () => void loadHistory());
  $("#h-end").addEventListener("change", () => void loadHistory());

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
async function checkUpdate(): Promise<void> {
  const current = await getAppVersion().catch(() => "");
  if (!current || current === "0.0.0") return;
  const info = await checkForUpdate(current);
  if (!info.available || !info.url) return;
  $("#upd-current").textContent = "v" + current;
  $("#upd-latest").textContent = "v" + info.version;
  $("#upd-notes").textContent = info.notes || "";
  const modal = $("#update-modal");
  $("#upd-later").onclick = () => modal.classList.add("hidden");
  $("#upd-now").onclick = () => { void openExternalUrl(info.url); modal.classList.add("hidden"); };
  modal.classList.remove("hidden");
}

/** Re-evaluate session + refresh the home banner / scan. */
async function refreshHome(): Promise<void> {
  const hasSession = await poncleHasSession(CFG).catch(() => false);
  showBanner(hasSession ? "none" : "session");
  if (hasSession) await doScan();
}

/* ---------- boot ---------- */
async function boot(): Promise<void> {
  bind();
  CFG = await loadConfig();
  renderState("idle");
  // Onboarding first-run gates the session check: finishOnb() calls refreshHome()
  // after the login step, so we don't show the login banner over a fresh login.
  const onboarding = await maybeOnboard();
  if (!onboarding) await refreshHome();
  void checkUpdate();
}

void boot();
