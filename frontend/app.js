"use strict";
/* 약정만료 알리미 - frontend controller.
   Main screen = the scan-result list (customers whose contract is due). Each row
   has a "알림 보내기" button. Sending records the alert into 발송 이력; actual
   delivery only happens when 실제 발송(deliver_alerts) is on.
   In a plain browser (no pywebview) it falls back to mock data for preview. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STATE_MAP = {
  idle:            { text: "대기중",  cls: "" },
  scanning:        { text: "스캔중",  cls: "is-scanning" },
  session_expired: { text: "세션만료", cls: "is-expired" },
  error:           { text: "오류",   cls: "is-error" },
};

let RESULTS = [];          // current scan-result rows
let SETTINGS = null;
let LAST_STATUS = null;

/* ---------- backend bridge ---------- */
function hasApi() { return !!(window.pywebview && window.pywebview.api); }
async function call(method, ...args) {
  if (hasApi() && typeof window.pywebview.api[method] === "function") {
    try { return await window.pywebview.api[method](...args); }
    catch (e) { console.error(method, e); return null; }
  }
  return mock(method, args);
}

/* ---------- push hooks (from Python) ---------- */
window.__onResults = (list) => { RESULTS = list || []; renderResults(); recomputeCards(); };
window.__onState   = (state) => { renderState(state); };
window.__onStatus  = (status) => { renderStatus(status); };
window.__onUpdate  = (info) => { showUpdateModal(info); };
window.__onUpdateError = (msg) => {
  const p = $("#upd-progress");
  p.classList.remove("hidden");
  p.style.color = "var(--fail)";
  p.textContent = msg || "업데이트 실패";
  const now = $("#upd-now");
  if (now) { now.disabled = false; now.textContent = "다시 시도"; }
};

/* ---------- state / status ---------- */
function renderState(state) {
  const info = STATE_MAP[state] || STATE_MAP.idle;
  $("#state-pill").className = "state-pill " + info.cls;
  $("#state-text").textContent = info.text;
  const expired = (state === "session_expired") ||
                  (LAST_STATUS && LAST_STATUS.has_session === false);
  $("#session-banner").classList.toggle("hidden", !expired);
}

function renderStatus(status) {
  if (!status) return;
  LAST_STATUS = status;
  const c = status.counts || {};
  $("#c-targets").textContent = c.targets ?? RESULTS.length;
  $("#c-pending").textContent = c.pending ?? 0;
  $("#c-sent").textContent    = c.sent ?? 0;
  $("#last-run").textContent  = fmtWhen(status.last_run_at);
  $("#next-run").textContent  = fmtWhen(status.next_run_at);
  if (status.version) $("#app-version").textContent = "v" + status.version;
  renderState(status.state || "idle");
}

function recomputeCards() {
  const sent = RESULTS.filter((r) => r.already_sent).length;
  $("#c-targets").textContent = RESULTS.length;
  $("#c-pending").textContent = RESULTS.length - sent;
  $("#c-sent").textContent = sent;
}

/* ---------- results table ---------- */
function renderResults() {
  const tb = $("#r-rows");
  tb.innerHTML = "";
  $("#r-empty").classList.toggle("hidden", RESULTS.length > 0);
  $("#results-note").textContent = RESULTS.length
    ? `${RESULTS.length}명 · 미발송 ${RESULTS.filter((r) => !r.already_sent).length}명`
    : "";
  for (const item of RESULTS) {
    const tr = document.createElement("tr");
    if (item.already_sent) tr.className = "row-sent";
    tr.innerHTML = `
      <td>${esc(item.opendate)}</td>
      <td>${esc(item.agency)}</td>
      <td>${esc(item.customer)}</td>
      <td>${esc(item.phone)}</td>
      <td>${esc(item.openhow)}</td>
      <td>${esc(item.telecom)}</td>
      <td>${esc(item.model)}</td>
      <td class="cell-act"></td>`;
    const cell = tr.querySelector(".cell-act");
    cell.appendChild(makeActionEl(item));
    tb.appendChild(tr);
  }
}

function makeActionEl(item) {
  if (item.already_sent) {
    const b = document.createElement("span");
    b.className = "sent-badge";
    b.textContent = "발송됨";
    return b;
  }
  const btn = document.createElement("button");
  btn.className = "btn-send";
  btn.textContent = "알림 보내기";
  btn.onclick = () => sendAlert(item, btn);
  return btn;
}

async function sendAlert(item, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  const res = await call("send_alert", item);
  if (res && (res.status === "sent" || res.status === "already")) {
    item.already_sent = true;
    // swap the whole row rendering (mark it sent)
    const tr = btn.closest("tr");
    if (tr) {
      tr.className = "row-sent";
      const cell = tr.querySelector(".cell-act");
      cell.innerHTML = "";
      cell.appendChild(makeActionEl(item));
    }
    recomputeCards();
  } else {
    btn.disabled = false;
    btn.textContent = "알림 보내기";
    const msg = (res && res.error) ? res.error : "발송 실패";
    alert(msg);
  }
}

/* ---------- views ---------- */
function showView(name) {
  ["main", "history", "settings"].forEach((v) =>
    $("#view-" + v).classList.toggle("hidden", v !== name));
}

/* ---------- history ---------- */
async function loadHistory() {
  const rows = await call("get_history",
    $("#h-query").value.trim(), $("#h-start").value, $("#h-end").value) || [];
  const tb = $("#h-rows");
  tb.innerHTML = "";
  $("#h-empty").classList.toggle("hidden", rows.length > 0);
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(fmtDateTime(r.sent_at))}</td>
      <td>${esc(r.opendate || "-")}</td>
      <td>${esc(r.agency || "-")}</td>
      <td>${esc(r.customer || "-")}</td>
      <td>${esc(r.phone || "-")}</td>
      <td>${esc(r.openhow || "-")}</td>
      <td>${esc(r.telecom || "-")}</td>
      <td>${esc(r.model || "-")}</td>`;
    tb.appendChild(tr);
  }
}

/* ---------- settings ---------- */
function renderDeliverHint() {
  const on = !!(SETTINGS && SETTINGS.deliver_alerts);
  const el = $("#deliver-hint");
  el.textContent = on ? "실제 발송: 켜짐" : "실제 발송: 꺼짐 (기록만)";
  el.className = "deliver-hint " + (on ? "deliver-on" : "deliver-off");
}

// Known 거래처 (from Poncle's agency dropdown), decoded. Non-standard open types
// (번호이동/유심 등) use a per-agency term; these are pre-listed so they can be set.
const AGENCIES = [
  "CD대리점", "DMB 엘지", "M&S분당도매센터", "MCC - 스테이지파이브SK", "MCC- SK텔링크",
  "MCC- 엠모바일", "MCC-KT엠모바일 후불유심", "mcc-kt중고후불", "MCC-미디어로그후불",
  "MCC-스카이라이프", "MCC-스테이지파이브KT", "MCC-코드모바일KT", "MCC-코드모바일LG",
  "MCC-프리티KT", "MCC-프리티LG", "MCC-프리티SK", "MCC-헬로비젼LG", "MCC/SK후불", "MCCKT",
  "PS&M", "SK경승컴퍼니온라인", "광운통신(라우터)", "대산LG", "메타레이kt", "미디어원KT",
  "쇼플러스", "유니컴즈(모빙) KT", "유니컴즈(모빙)LGT", "유니컴즈(모빙)SK", "유안-엔네트웍스",
  "티인포(mcc)",
];

function decodeHtml(s) {
  const t = document.createElement("textarea");
  t.innerHTML = String(s ?? "");
  return t.value;
}

// The known agencies plus any extra 거래처 seen in the current scan results, so a
// real data agency is always editable even if it is not in the built-in list.
function agencyList() {
  const seen = new Set(AGENCIES);
  const extra = [];
  for (const r of RESULTS) {
    const name = decodeHtml(r.agency || "").trim();
    if (name && !seen.has(name)) { seen.add(name); extra.push(name); }
  }
  extra.sort((a, b) => a.localeCompare(b, "ko"));
  return AGENCIES.concat(extra);
}

function buildAgencyTerms(s) {
  const box = $("#agency-terms");
  box.innerHTML = "";
  const overrides = s.agency_term_months || {};
  const fallback = s.nonstandard_term_months ?? 6;
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
    input.value = (name in overrides) ? overrides[name] : fallback;
    row.appendChild(label);
    row.appendChild(input);
    box.appendChild(row);
  }
}

function populateSettings(s) {
  if (!s) return;
  SETTINGS = s;
  $("#s-deliver").checked = !!s.deliver_alerts;
  $("#s-standard-term").value = s.default_term_months ?? 24;
  $("#s-nonstandard-term").value = s.nonstandard_term_months ?? 6;
  buildAgencyTerms(s);
  const offsets = new Set((s.notify_offsets_days || []).map(String));
  $$(".s-offset").forEach((cb) => { cb.checked = offsets.has(cb.value); });
  $("#s-runtime").value = s.run_time || "09:00";
  $("#s-startup").checked = !!s.run_on_startup;
  $("#s-autostart").checked = !!s.autostart_enabled;
  $("#s-autoupdate").checked = s.auto_check_updates !== false;
  $("#s-current-ver").textContent = $("#app-version").textContent || "-";
  $("#s-template").value = s.message_template || "";
  renderDeliverHint();
}

function gatherSettings() {
  const offsets = $$(".s-offset").filter((cb) => cb.checked).map((cb) => parseInt(cb.value, 10));
  const nonstandard = parseInt($("#s-nonstandard-term").value, 10);
  const nonstandardTerm = Number.isFinite(nonstandard) ? nonstandard : 6;
  // Only store agencies whose term differs from the non-standard default, so the
  // default can still propagate to unset agencies.
  const agencyTerms = {};
  $$(".agency-term").forEach((inp) => {
    const v = parseInt(inp.value, 10);
    if (Number.isFinite(v) && v !== nonstandardTerm) agencyTerms[inp.dataset.agency] = v;
  });
  return {
    deliver_alerts: $("#s-deliver").checked,
    default_term_months: parseInt($("#s-standard-term").value, 10) || 24,
    nonstandard_term_months: nonstandardTerm,
    agency_term_months: agencyTerms,
    notify_offsets_days: offsets.length ? offsets : [0],
    run_time: $("#s-runtime").value || "09:00",
    run_on_startup: $("#s-startup").checked,
    autostart_enabled: $("#s-autostart").checked,
    auto_check_updates: $("#s-autoupdate").checked,
    message_template: $("#s-template").value,
  };
}

/* ---------- updates ---------- */
function showUpdateModal(info) {
  if (!info || !info.version) return;
  $("#upd-current").textContent = "v" + (info.current || "");
  $("#upd-latest").textContent = "v" + info.version;
  $("#upd-notes").textContent = info.notes || "";
  const p = $("#upd-progress");
  p.classList.add("hidden");
  p.style.color = "";
  p.textContent = "";
  const now = $("#upd-now");
  now.disabled = false;
  now.textContent = "지금 설치";
  $("#update-modal").classList.remove("hidden");
}

/* ---------- formatting ---------- */
function pad(n) { return String(n).padStart(2, "0"); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function parseIso(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
function fmtWhen(iso) {
  const d = parseIso(iso);
  if (!d) return "-";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `오늘 ${hm}`;
  if (diff === 1) return `내일 ${hm}`;
  if (diff === -1) return `어제 ${hm}`;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}`;
}
function fmtDateTime(iso) {
  const d = parseIso(iso);
  if (!d) return iso || "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- wire up ---------- */
function bind() {
  $("#btn-min").onclick = () => call("window_minimize");
  $("#btn-max").onclick = () => call("window_toggle_maximize");
  $("#btn-close").onclick = () => call("window_hide");
  $("#btn-login").onclick = () => call("open_login");

  $("#btn-scan").onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "스캔 중…";
    await call("run_scan_now");
    setTimeout(() => { b.disabled = false; b.textContent = "지금 다시 스캔"; }, 1500);
  };
  $("#btn-history").onclick = () => { showView("history"); loadHistory(); };
  $("#btn-settings").onclick = async () => {
    populateSettings(await call("get_settings"));
    showView("settings");
  };
  $$("[data-back]").forEach((b) => (b.onclick = () => showView("main")));
  $("#btn-h-search").onclick = loadHistory;
  $("#h-query").addEventListener("keydown", (e) => { if (e.key === "Enter") loadHistory(); });

  $("#upd-later").onclick = () => $("#update-modal").classList.add("hidden");
  $("#upd-now").onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = "다운로드 중…";
    const p = $("#upd-progress");
    p.classList.remove("hidden");
    p.style.color = "";
    p.textContent = "다운로드 중… 잠시 후 자동으로 재시작됩니다.";
    await call("apply_update");
  };
  $("#btn-check-update").onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    const msg = $("#update-msg");
    msg.style.color = ""; msg.textContent = "확인 중…";
    const res = await call("check_update");
    b.disabled = false;
    if (!res || res.status !== "ok") {
      msg.style.color = "var(--fail)"; msg.textContent = "확인 실패 (네트워크 확인)";
      return;
    }
    if (res.available) { msg.textContent = ""; showUpdateModal(res); }
    else {
      msg.style.color = "var(--ok)"; msg.textContent = "최신 버전입니다 (v" + res.current + ")";
      setTimeout(() => { msg.textContent = ""; }, 3000);
    }
  };

  $("#btn-save").onclick = async () => {
    const patch = gatherSettings();
    const msg = $("#save-msg");
    if (patch._error) { msg.style.color = "var(--fail)"; msg.textContent = patch._error; return; }
    const res = await call("save_settings", patch);
    msg.style.color = "var(--ok)";
    msg.textContent = (res && res.status === "ok") ? "저장되었습니다." : "저장 실패";
    if (res && res.settings) populateSettings(res.settings);
    setTimeout(() => { msg.textContent = ""; }, 2500);
  };
}

/* ---------- boot ----------
   The real app MUST win over the browser-preview mock, even when pywebview is
   slow to inject window.pywebview (packaged/onefile cold start). So: keep polling
   for the real api forever and let a real boot override a mock boot; only fall
   back to mock when pywebview truly never appears. */
let realBooted = false;
let mockBooted = false;

async function runInit() {
  bind();
  const data = await call("get_bootstrap");
  if (data) {
    SETTINGS = data.settings;
    RESULTS = data.results || [];
    renderResults();
    renderStatus(data.status);
    recomputeCards();
    renderDeliverHint();
  }
}

async function bootReal() {
  if (realBooted) return;
  realBooted = true;
  await runInit();          // call() reaches Python; overrides any prior mock render
}
function bootMock() {
  if (realBooted || mockBooted) return;
  mockBooted = true;
  runInit();                // call() returns mock data (browser preview only)
}

window.addEventListener("pywebviewready", bootReal);
if (hasApi()) bootReal();
// Poll indefinitely for the api (covers a missed event / very slow injection).
(function pollForApi() {
  if (realBooted) return;
  if (hasApi()) { bootReal(); return; }
  setTimeout(pollForApi, 200);
})();
// Browser-only fallback: if pywebview never shows up at all, render the mock.
setTimeout(() => { if (typeof window.pywebview === "undefined") bootMock(); }, 5000);

/* ---------- browser-preview mock ---------- */
function mock(method, args) {
  if (method === "get_bootstrap") {
    return {
      status: {
        state: "idle", last_run_at: isoToday(9, 0), next_run_at: isoTomorrow(9, 0),
        has_session: true, counts: { targets: 4, sent: 1, pending: 3 }, version: "1.2.0",
      },
      settings: mockSettings(),
      results: mockResults(),
    };
  }
  if (method === "get_settings") return mockSettings();
  if (method === "get_scan_results") return mockResults();
  if (method === "get_history") {
    return [{
      sent_at: isoToday(9, 0), opendate: "24-07-03", agency: "CD대리점", customer: "김수현",
      phone: "010-3123-4549", openhow: "기변", telecom: "SK텔레콤", model: "SM-S942N_256G 블랙",
    }];
  }
  if (method === "send_alert") return { status: "sent" };
  if (method === "save_settings") return { status: "ok", settings: (args && args[0]) || mockSettings() };
  if (method === "check_update") return { status: "ok", available: false, version: "1.2.0", current: "1.2.0", notes: "" };
  if (method === "apply_update") return { status: "downloading" };
  return { status: "ok" };
}
function mockSettings() {
  return {
    deliver_alerts: false, default_term_months: 24, nonstandard_term_months: 6,
    agency_term_months: {}, notify_offsets_days: [0], run_time: "09:00",
    run_on_startup: true, autostart_enabled: false, auto_check_updates: true,
    message_template: "안녕하세요 {customer}님. {telecom} 휴대폰({model}) 2년 약정이 {expiry}에 만료됩니다.",
  };
}
function mockResults() {
  return [
    r("24-07-03", "CD대리점", "배옥자", "010-3479-7780", "기변", "SK텔레콤", "SM-S947N_256G 코발트 바이올렛", false),
    r("24-07-03", "쇼플러스", "LI CHANGJI", "010-9131-6986", "번호이동", "KT", "SM-S948N_256G 스카이 블루", false),
    r("24-07-02", "DMB 엘지", "박지훈", "010-2658-1827", "기변", "LG유플러스", "UIP17-256", false),
    r("24-07-01", "MCC- 엠모바일", "이숙희", "010-3348-8236", "유심MNP", "KT엠모바일", "11", true),
  ];
}
function r(opendate, agency, customer, phone, openhow, telecom, model, sent) {
  return {
    id: `${phone}|x|0`, opendate, agency, customer, phone, openhow, telecom, model,
    expiry_date: "2026-07-03", milestone_offset: 0, already_sent: sent,
  };
}
function isoToday(h, m) { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); }
function isoTomorrow(h, m) { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); return d.toISOString(); }
