/**
 * 고객 조회 screen.
 */
import { Preferences } from "@capacitor/preferences";
import { buildLookupResults, lookupInformedAt, lookupToDueItem, type LookupResult } from "../domain/lookup";
import { dedupeRecentQueries, pushRecentQuery } from "../domain/lookup-recent";
import { cleanPlan } from "../domain/plan";
import { PoncleClient, SessionExpired } from "../domain/poncle-client";
import { today } from "../domain/plaindate";
import type { PoncleRow } from "../domain/types";
import { nativePoncleGateway, poncleLogin } from "../native/adapters";
import { appConfirm } from "../ui/dialog";
import { systemShowsCopyToast } from "../ui/copy-toast";
import { getDeviceSdkInt } from "../native/appupdate";
import { history, S } from "../app/state";
import { $, $$, esc, toast } from "../app/dom";
import { LK_WARN_ICON, LK_ERR_ICON, LK_CALL_ICON, LK_COPY_ICON } from "../app/icons";
import { refreshClockSkew } from "../app/status";
import { probeSession } from "../app/session";
import { isContractType } from "../domain/template-match";
import { lookupTruncation, type LookupTrunc } from "../ui/lookup-trunc";
import { LOOKUP_IGNORED_SUB, LOOKUP_IGNORED_TITLE, applyLookupQuery } from "../ui/lookup-filter";
import { onSend } from "./send";

/* 고객 조회(lookup) 상태 */
type LookupState = "initial" | "loading" | "results" | "empty" | "ignored" | "err-session" | "err-network";
let LK_STATE: LookupState = "initial";
let LK_RESULTS: LookupResult[] = [];
let LK_RECENT: string[] = [];
let LK_LAST_QUERY = "";
/** Bumped per lookup request: a slower earlier response is ignored (#49). */
let LK_SEQ = 0;
/** First-page cut-off of the last lookup (3-12): null = everything was shown. */
let LK_TRUNC: LookupTrunc | null = null;
/** The last lookup's 요금제유지 미결 fetch failed (L11): 유지일 unknown for 1단계 customers. */
let LK_PENDING_FAILED = false;
const LK_RECENT_KEY = "lookup_recent";
const LOOKUP_SOON_DAYS = 30; // "곧 만료"로 볼 임계(조회 화면 전용)

/* ---------- lookup (고객 조회) ---------- */

/** Entry when the 조회 tab opens: reflect current state + input chrome. */
export function openLookup(): void {
  updateLookupInputChrome($<HTMLInputElement>("#lk-query").value);
  renderLookup();
}

function updateLookupInputChrome(value: string): void {
  const q = value.trim();
  $("#lk-clear").classList.toggle("hidden", value.length === 0);
  $("#lk-tooshort").classList.toggle("hidden", !(q.length > 0 && q.length < 2));
}

/** 요금제유지 미결 rows for the 조회 join, so a 유심 customer's 만료 is the 폰클 유지일
 *  (same key as the home scan). A failure leaves those customers on the fallback
 *  (개통 + 기본 개월) date, which can be days off: `failed` says so (L11). */
async function lookupPendingRows(client: PoncleClient): Promise<{ rows: PoncleRow[]; failed: boolean }> {
  try {
    return { rows: await client.fetchPending(), failed: false };
  } catch (e) {
    if (e instanceof SessionExpired) throw e;
    return { rows: [], failed: true };
  }
}

/** A 요금제 유지(1단계) customer whose 유지일 couldn't be read in this lookup (L11). */
function lookupDegraded(r: LookupResult): boolean {
  return r.degraded === true || (LK_PENDING_FAILED && !isContractType(r.openhow));
}

async function submitLookup(): Promise<void> {
  const q = $<HTMLInputElement>("#lk-query").value.trim();
  updateLookupInputChrome(q);
  if (q.length < 2) return;
  const seq = ++LK_SEQ; // a newer request (or 지우기) makes this one's answer stale
  LK_STATE = "loading";
  renderLookup();
  try {
    const client = new PoncleClient(nativePoncleGateway(S.CFG), S.CFG);
    const res = await client.searchCustomersWithTotal(q);
    if (seq !== LK_SEQ) return;
    const rows = res.list;
    const pending = rows.length ? await lookupPendingRows(client) : { rows: [], failed: false };
    // SentIndex: '안내함' also for a send under a differently computed expiry.
    const sent = await history.sentIndex(S.CFG);
    if (seq !== LK_SEQ) return;
    // pending.failed also marks the domain results degraded, so a send that reaches
    // the shared confirm flow is blocked there too (DueItem.degraded, audit L11).
    const built = buildLookupResults(rows, S.CFG, today(), LOOKUP_SOON_DAYS, sent, pending.rows, pending.failed);
    // I5: only rows that actually contain the query — a server that ignored the
    // search field must not show (and offer sends to) unrelated customers.
    const filtered = applyLookupQuery(built, q);
    LK_RESULTS = filtered.rows;
    LK_PENDING_FAILED = pending.failed;
    // L19: the server's own (unclamped) count decides, when the domain reports it.
    LK_TRUNC = filtered.ignored ? null : lookupTruncation(rows.length, res.total, Number(S.CFG.page_size) || 100, res.serverTotal);
    LK_LAST_QUERY = q;
    LK_STATE = filtered.ignored ? "ignored" : LK_RESULTS.length ? "results" : "empty";
    pushRecent(q);
  } catch (e) {
    if (seq !== LK_SEQ) return;
    LK_STATE = e instanceof SessionExpired ? "err-session" : "err-network";
  }
  refreshClockSkew(); // 조회 responses carry Poncle's date too (#58)
  renderLookup();
}

/** 조회 화면의 '로그인' (세션 만료 배너): log in, then re-run THIS lookup — not a
 *  full scan, and the banner doesn't linger (#43). */
async function lookupLogin(): Promise<void> {
  const ok = await poncleLogin(S.CFG).catch(() => false);
  if (!ok) { toast("로그인이 완료되지 않았습니다"); return; }
  void probeSession(); // 홈 배너 / 설정 세션 표시도 맞춘다
  await submitLookup();
}

function pushRecent(q: string): void {
  LK_RECENT = pushRecentQuery(LK_RECENT, q);
  void Preferences.set({ key: LK_RECENT_KEY, value: JSON.stringify(LK_RECENT) });
}

export async function loadRecent(): Promise<void> {
  const { value } = await Preferences.get({ key: LK_RECENT_KEY });
  if (!value) return;
  try {
    const a = JSON.parse(value);
    if (Array.isArray(a)) LK_RECENT = dedupeRecentQueries(a.filter((x): x is string => typeof x === "string"));
  } catch {
    /* ignore corrupt recent list */
  }
}

function clearLookup(): void {
  $<HTMLInputElement>("#lk-query").value = "";
  LK_SEQ++; // drop any lookup still in flight
  LK_STATE = "initial";
  LK_RESULTS = [];
  LK_TRUNC = null;
  LK_PENDING_FAILED = false;
  updateLookupInputChrome("");
  renderLookup();
}

/** After a send from the 조회 tab: refresh the 안내 이력 badge from the sent log. */
export async function refreshLookupInformed(): Promise<void> {
  const sent = await history.sentIndex(S.CFG);
  // The log is authoritative: a send later reported failed drops back to '안내 내역 없음'.
  // '안내 이력' = the newest real send to this number — 1단계, 2단계 or 직접 입력 (B11/C1).
  // Same rule as the search itself (buildLookupResults), so the badge never flips on refresh.
  LK_RESULTS = LK_RESULTS.map((r) => ({ ...r, informedAt: lookupInformedAt(sent, r) }));
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
    $("#lk-login").onclick = () => void lookupLogin();
    return;
  }
  if (LK_STATE === "err-network") {
    body.innerHTML = `<div class="banner banner-error"><div class="banner-icon">${LK_ERR_ICON}</div><div class="banner-txt"><div class="banner-title">네트워크 오류가 발생했습니다</div><div class="banner-sub">잠시 후 다시 시도하세요</div></div><button class="banner-btn banner-btn-red" id="lk-retry">재시도</button></div>`;
    $("#lk-retry").onclick = () => void submitLookup();
    return;
  }
  if (LK_STATE === "ignored") {
    body.innerHTML = `<div class="banner banner-warn" role="status"><div class="banner-icon">${LK_WARN_ICON}</div><div class="banner-txt"><div class="banner-title">${LOOKUP_IGNORED_TITLE}</div><div class="banner-sub">${esc(LOOKUP_IGNORED_SUB)}</div></div><button class="banner-btn" id="lk-retry">재시도</button></div>`;
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
  const trunc = LK_TRUNC;
  const more = trunc
    ? `<div class="lk-more" role="status">검색 결과가 많습니다 — 더 구체적으로 검색하세요 (${
      trunc.total !== null ? `${trunc.total}건 중 ${trunc.shown}건 표시` : `${trunc.shown}건까지만 표시`
    })<div class="lk-more-sub">이름 일부만 입력하면 그 글자가 들어간 고객이 모두 나옵니다. 전체 이름이나 전화번호로 검색하면 정확합니다.</div></div>`
    : "";
  const degraded = LK_RESULTS.some(lookupDegraded)
    ? `<div class="lk-more" role="status">폰클 요금제유지 미결을 불러오지 못했습니다<div class="lk-more-sub">요금제 유지(1단계) 고객의 만료일이 정확하지 않을 수 있어 발송을 막았습니다. 잠시 후 다시 조회하세요.</div></div>`
    : "";
  body.innerHTML = more + degraded + `<div class="lk-count">${LK_RESULTS.length}명 검색됨</div>` + LK_RESULTS.map(lookupCardHtml).join("");
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
        ${lookupDegraded(r) ? `<span class="sent-badge fail lk-degraded">유지일 확인 필요</span>`
          : r.expiry_date ? `<button class="lk-send btn-send">알림 보내기</button>` : ""}
        <a class="lk-call" href="tel:${esc(digits)}" aria-label="통화">${LK_CALL_ICON}</a>
        <button class="lk-copy" aria-label="번호 복사">${LK_COPY_ICON}</button>
      </div>
    </div>`;
}

/** 조회 send. A customer who is NOT at a milestone ('여유' / '재계약 완료') must not
 *  get the auto-filled '약정이 종료되어' text: ask first, then open on 직접 입력. */
async function onLookupSend(r: LookupResult): Promise<void> {
  if (lookupDegraded(r)) {
    toast("폰클 미결 조회 실패로 요금제 유지 시점이 확실하지 않은 고객입니다 — 다시 조회한 뒤 보내세요", { err: true });
    return;
  }
  const item = lookupToDueItem(r);
  if (r.status.tone === "ok") {
    const go = await appConfirm(
      `${r.status.label} 고객입니다.\n아직 안내 시점이 아니어서(또는 이미 재계약해서) 자동 문구를 채우지 않습니다.\n\n문구를 직접 입력해 보낼까요?`,
      { title: "안내 시점이 아닌 고객", okLabel: "직접 입력" },
    );
    if (!go) return;
    // Not a milestone send (B1): stored as 'manual' so it never marks the customer's
    // future 요금제 유지 / 약정 만료 안내 as already sent.
    await onSend(item, { noAutoTemplate: true, recordSource: "manual" });
    return;
  }
  await onSend(item);
}

async function onLookupCopy(r: LookupResult): Promise<void> {
  try {
    await navigator.clipboard.writeText(r.phone);
  } catch {
    toast("복사에 실패했습니다", { err: true });
    return;
  }
  // Android 13+ announces every copy itself — a second (app) notice would stack (D4).
  const sdk = await getDeviceSdkInt().catch(() => undefined);
  if (!systemShowsCopyToast(sdk, navigator.userAgent)) toast("번호가 복사되었습니다");
}

/** 조회 input, submit and clear. */
export function bindLookup(): void {
  // 고객 조회 탭
  $("#lk-query").addEventListener("input", (e) => updateLookupInputChrome((e.target as HTMLInputElement).value));
  $("#lk-query").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void submitLookup(); });
  $("#lk-submit").onclick = () => void submitLookup();
  $("#lk-clear").onclick = () => clearLookup();
}
