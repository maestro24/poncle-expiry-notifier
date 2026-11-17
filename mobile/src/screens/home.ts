/**
 * Home screen: due list cards, search/filter, stale/degraded notices, the
 * 테스트 대상 row and the home send/call actions.
 */
import { staleScanNotice, staleSendWarning } from "../domain/due-item";
import { today } from "../domain/plaindate";
import { formatDdayLabel, isValidKrMobile } from "../domain/sender";
import type { DueItem } from "../domain/types";
import { openExternalUrl } from "../native/adapters";
import { INVALID_NUMBER_MESSAGE } from "../native/sms";
import { appConfirm } from "../ui/dialog";
import { S } from "../app/state";
import { hooks } from "../app/hooks";
import { $, $$, esc, toast, planLine, setPressed, todayIsoLocal } from "../app/dom";
import { dueEmptyText } from "../ui/empty-state";
import { matchesDueQuery } from "../ui/phone-query";
import { isDegraded, clockBlocksSend } from "../app/status";
import { reconcileSentFlags } from "../app/sent-state";
import { onSend } from "./send";

let DUE_QUERY = "";
let DUE_FILTER: "all" | "unsent" = "all";

/* ---------- home: cards + due list ---------- */
function renderCards(): void {
  const sent = S.RESULTS.filter((r) => r.already_sent).length;
  $("#c-targets").textContent = String(S.RESULTS.length);
  $("#c-pending").textContent = String(S.RESULTS.length - sent);
  $("#c-sent").textContent = String(sent);
}
function filteredResults(): DueItem[] {
  return S.RESULTS.filter((r) => {
    if (DUE_FILTER === "unsent" && r.already_sent) return false;
    // A phone-looking query also matches by digits (L16): '01011112222' finds 010-1111-2222.
    return matchesDueQuery(r, DUE_QUERY);
  });
}
export function renderDueList(): void {
  const list = $("#due-list");
  const rows = filteredResults();
  const unsent = S.RESULTS.filter((r) => !r.already_sent).length;
  $("#list-note").textContent = S.RESULTS.length ? `${S.RESULTS.length}명 · 미발송 ${unsent}명` : "";
  const empty = $("#due-empty");
  empty.classList.toggle("hidden", rows.length > 0);
  // 오늘 스캔에 성공했는데 대상이 0명이면 그렇게 말한다 (D2) — '다시 스캔' 안내가 아니라.
  empty.textContent = dueEmptyText({
    hasResults: S.RESULTS.length > 0,
    scanDateIso: S.SCAN_DATE,
    todayIso: todayIsoLocal(),
    lastScan: S.LAST_SCAN,
  });
  list.innerHTML = "";
  for (const item of rows) list.appendChild(dueCard(item));
  renderCards();
  renderStaleNotice();
  renderDegradedNotice();
  renderCatchUpNotice();
}

/** Home notice when the last scan's catch-up hit its 14-day cap (I3). */
function renderCatchUpNotice(): void {
  const box = document.querySelector<HTMLElement>("#catchup-banner");
  if (!box) return;
  box.classList.toggle("hidden", !S.CATCHUP_NOTICE);
  const sub = document.querySelector<HTMLElement>("#catchup-sub");
  if (sub) sub.textContent = S.CATCHUP_NOTICE;
}

/** Home warning while the shown list came from a scan whose 미결 fetch failed. */
function renderDegradedNotice(): void {
  const on = S.PENDING_DEGRADED || S.RESULTS.some(isDegraded);
  $("#degraded-banner").classList.toggle("hidden", !on);
}
/** Re-derive every home row's send state from the log and redraw home (entering
 *  home, foreground return): a send/restore made elsewhere shows up here. */
export async function refreshHomeSendState(): Promise<void> {
  try {
    await reconcileSentFlags();
  } catch {
    return; // storage glitch: keep the list as drawn; the next entry retries
  }
  if (S.CURRENT === "home") renderDueList();
}
/** Home notice when the shown list is not from a scan today (D-days are already
 *  re-derived for today by refreshDueOffsets; sending asks first, see onHomeSend). */
function renderStaleNotice(): void {
  const notice = staleScanNotice(S.SCAN_DATE, today(), S.RESULTS.filter((r) => !r.test).length);
  $("#stale-banner").classList.toggle("hidden", !notice);
  if (notice) $("#stale-title").textContent = notice;
}

function dueCard(item: DueItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "listcard" + (item.already_sent ? " sent" : "");
  const dn = formatDdayLabel(Number(item.milestone_offset) || 0);
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
  const dn = formatDdayLabel(Number(item.milestone_offset) || 0);
  if (item.source === "keepdate") {
    // 1단계: 폰클 요금제유지 미결의 유지일, 없으면 개통+기본 개월. -> 템플릿 1.
    return `요금제 유지 시점 (1단계) · 요금제 유지 템플릿\n유지 예정 ${item.expiry_date} · ${dn}\n개통 ${item.opendate}`;
  }
  // 2단계: 약정 만료 (약정 대상, 개통+약정 개월). -> 템플릿 2.
  return `약정 만료 시점 (2단계) · 약정 만료 템플릿\n약정 만료 ${item.expiry_date} · ${dn}\n개통 ${item.opendate}`;
}
function actionEl(item: DueItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "lc-actions";
  // 기록만 됨(연습) / 발송 실패: 아직 안내되지 않은 고객 — 상태 배지 + 실제로 보내는 버튼.
  // 배지는 지금 모드(S.CFG)가 아니라 그 고객 '기록'의 상태를 따른다.
  const pendingState = !item.already_sent ? stateBadge(item.sent_state) : null;
  if (pendingState) row.appendChild(pendingState);
  if (!item.already_sent && isDegraded(item)) {
    const warn = document.createElement("span");
    warn.className = "sent-badge fail";
    warn.textContent = "유지일 확인 필요";
    row.appendChild(warn);
  }
  if (item.already_sent) {
    // 이미 발송(또는 제외 처리)된 고객: 상태 배지 + 재발송(기존 안내 이력 업데이트) + 통화.
    const badge = stateBadge(item.sent_state) ?? stateBadge("sent")!;
    const resend = document.createElement("button");
    resend.className = "btn-send resend";
    resend.textContent = "재발송";
    resend.title = "다시 보내고 기존 안내 이력을 갱신합니다";
    resend.onclick = () => void onHomeSend(item);
    const call = document.createElement("button");
    call.className = "btn-call";
    call.textContent = "통화";
    call.onclick = () => void onCall(item);
    row.appendChild(badge);
    row.appendChild(resend);
    row.appendChild(call);
    return row;
  }
  const send = document.createElement("button");
  send.className = "btn-send";
  send.textContent = sendLabel(item.sent_state);
  send.onclick = () => void onHomeSend(item);
  const call = document.createElement("button");
  call.className = "btn-call";
  call.textContent = "통화";
  call.title = "이 번호로 전화 걸기";
  call.onclick = () => void onCall(item);
  row.appendChild(send);
  row.appendChild(call);
  return row;
}

/** Send-button label for a not-yet-alerted row. A practice record in delivery mode
 *  becomes a REAL send (upserted to channel sms by doConfirmSend). */
export function sendLabel(state: DueItem["sent_state"]): string {
  if (state === "failed") return "다시 보내기";
  if (state === "recorded" && S.CFG.deliver_alerts) return "실제 발송";
  return "알림 보내기";
}

/** Status badge from the customer's RECORD (not the current mode); null for none. */
function stateBadge(state: DueItem["sent_state"]): HTMLElement | null {
  const spec: Partial<Record<NonNullable<DueItem["sent_state"]>, [string, string]>> = {
    sent: ["sent-badge", "✓ 발송됨"],
    skipped: ["sent-badge rec", "✓ 처리됨(제외)"],
    recorded: ["sent-badge rec", "기록만 됨(미발송)"],
    failed: ["sent-badge fail", "✕ 발송 실패"],
  };
  const s = state ? spec[state] : undefined;
  if (!s) return null;
  const badge = document.createElement("span");
  badge.className = s[0];
  badge.textContent = s[1];
  return badge;
}

/** Send from the home due list. That list may be a cached scan from an earlier day
 *  (customers may have re-contracted or left since), so sending from it needs an
 *  explicit confirm naming the scan day. Test rows are exempt (my own number). */
async function onHomeSend(item: DueItem): Promise<void> {
  if (clockBlocksSend(item)) return; // a wrong phone date refuses first — never ask, then refuse
  const warning = item.test ? null : staleSendWarning(S.SCAN_DATE, today());
  if (warning && !(await appConfirm(warning, { title: "이전 스캔 결과", okLabel: "보내기" }))) return;
  await onSend(item);
}

/** Open the phone dialer for this customer's number (ACTION_VIEW tel:). */
export async function onCall(item: DueItem): Promise<void> {
  const digits = String(item.phone || "").replace(/[^0-9+]/g, "");
  if (!digits) { toast("전화번호가 없습니다", { err: true }); return; }
  try {
    await openExternalUrl(`tel:${digits}`);
  } catch {
    toast("전화 앱을 열 수 없습니다", { err: true });
  }
}

/* ---------- test target ---------- */
/** Home '테스트 대상': a fake due row addressed ONLY to the user's own number from
 *  설정 > 문자 발송 테스트 — never a hard-coded number (a real stranger could own it). */
export function addTestTarget(): void {
  const phone = (S.CFG.test_phone ?? "").trim();
  if (!phone) {
    toast("설정 > 문자 발송 테스트에 내 번호를 먼저 입력하세요", { err: true });
    return;
  }
  if (!isValidKrMobile(phone)) {
    toast(`설정 > 문자 발송 테스트의 내 번호를 확인하세요 — ${INVALID_NUMBER_MESSAGE}`, { err: true });
    return;
  }
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const yy = `${p(now.getFullYear() % 100)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  // Test rows are exempt from dedup: always sendable, never recorded or cached.
  S.RESULTS = S.RESULTS.concat([{
    id: `test:${now.getTime()}`,
    phone, customer: "홍길동(테스트)", opendate: yy, expiry_date: iso,
    milestone_offset: 0, telecom: "SK텔레콤", agency: "테스트대리점", openhow: "번호이동",
    plan: "5G 프리미어 에센셜 55000", model: "테스트모델", staff: "", already_sent: false, test: true,
    source: "term", // 약정 만료(2단계) 템플릿으로 라우팅되도록
  }]);
  hooks.showScreen("home");
  renderDueList();
}

/** Home due-list search + filter chips. */
export function bindHomeFilters(): void {
  // Home due-list search + filter
  $("#due-query").addEventListener("input", (e) => {
    DUE_QUERY = (e.target as HTMLInputElement).value;
    renderDueList();
  });
  $$("#due-filter-chips .chip").forEach((c) => {
    c.onclick = () => {
      $$("#due-filter-chips .chip").forEach((x) => setPressed(x, x === c));
      DUE_FILTER = (c.dataset.duefilter as "all" | "unsent") ?? "all";
      renderDueList();
    };
  });
}
