/**
 * 이력 screen: 발송 이력 (paged, #59) and 미방문 고객 tabs.
 */
import { staleSendWarning } from "../domain/due-item";
import { recordKey, sentStateOf } from "../domain/history";
import { htmlUnescape } from "../domain/html-entities";
import { today } from "../domain/plaindate";
import { formatDdayLabel } from "../domain/sender";
import type { DueItem } from "../domain/types";
import { appConfirm } from "../ui/dialog";
import { unvisitedBasisNote } from "../ui/empty-state";
import { HISTORY_PAGE, firstSendNote, historyCountLabel, historyPage } from "../ui/history-paging";
import { SeqGuard, debounce } from "../ui/debounce";
import { history, S } from "../app/state";
import { $, $$, esc, toast, planLine, todayIsoLocal, daysSince } from "../app/dom";
import { onSend } from "./send";
import { clockBlocksSend } from "../app/status";
import { sendLabel, onCall } from "./home";

let HIST_TAB: "sent" | "unvisited" = "sent";
let UNV_SHOW_EXCLUDED = false; // 미방문 탭: 수동 제외한 고객도 함께 볼지

/** I10: a newer loadHistory/renderSentHistory makes an older one's answer stale —
 *  a slow search for '홍' never draws over the later '홍길동'. */
const HIST_SEQ = new SeqGuard();
/** Typing in the 이력 search box searches once per pause, not once per key. */
const HIST_QUERY_DEBOUNCE_MS = 250;

/** A stored-record text field for display (D1): records written before v1.2.17
 *  keep Poncle's HTML escaping ("PS&amp;M"); decode, then escape exactly once. */
const txt = (s: unknown): string => esc(htmlUnescape(String(s ?? "")));

/* ---------- history ---------- */

/** Entry point for the 이력 screen: refresh the tab badge and render the active tab. */
export async function loadHistory(): Promise<void> {
  const ticket = HIST_SEQ.next();
  // 미방문 목록은 마지막 스캔이 폰클에서 산출해 캐시한 것. 발송 여부(already_sent)는
  // 스캔 이후 바뀔 수 있어 이력에서 실시간 재계산한다. 수동 제외한 건은 기본 숨김이며,
  // "제외한 고객도 보기" 토글로 다시 볼 수 있다. 실제 재방문(새 개통) 건은 다음
  // 스캔에서 자동으로 빠진다 — 제외는 폰클에 안 잡히는 예외를 손으로 뺄 때만 쓴다.
  const cached = await history.loadUnvisited();
  const idx = await history.sentIndex(S.CFG);
  // 수동 제외는 계약 단위로 매칭(B8, contract C3): 약정 개월이 바뀌어 id(phone|만료일)가
  // 달라져도 같은 개통(phone|개통일)의 제외는 유지된다. 옛 phone|만료일 키도 그대로 통한다.
  const exclusions = await history.exclusionIndex(); // one read for the whole list
  if (!HIST_SEQ.isCurrent(ticket)) return;
  const excluded = new Set(cached.filter((r) => exclusions.isHandled(r)).map((r) => r.id));
  const enriched = cached.map((r) => {
    const state = idx.stateOf(r);
    return { ...r, sent_state: state, already_sent: state === "sent" || state === "skipped" };
  });
  const outstanding = enriched.filter((r) => !excluded.has(r.id));
  const need = outstanding.length; // 배지는 '실제 미방문'(제외 항목 제외) 수
  const badge = $("#hist-unvisited-count");
  badge.textContent = String(need);
  badge.classList.toggle("hidden", need === 0);
  $("#hist-sent").classList.toggle("hidden", HIST_TAB !== "sent");
  $("#hist-unvisited").classList.toggle("hidden", HIST_TAB !== "unvisited");
  $$("#hist-tabs .histtab").forEach((b) => b.classList.toggle("on", b.dataset.htab === HIST_TAB));
  if (HIST_TAB === "sent") { await renderSentHistory(ticket); return; }
  // 기준일 (B7): the 미방문 cache moves only with a clean scan.
  const cleanDate = await history.getCleanScanDate().catch(() => "");
  if (!HIST_SEQ.isCurrent(ticket)) return;
  renderUnvisitedBasis(cleanDate, cached.length);
  renderUnvisited(UNV_SHOW_EXCLUDED ? enriched : outstanding, excluded);
}

/** 발송 이력 rows on screen (#59): grows by HISTORY_PAGE per '더 보기'; a new
 *  search/date filter or re-entering the screen starts over. */
let HIST_SHOWN = HISTORY_PAGE;
/** recordKeys of the 발송 이력 cards whose 원문 is expanded (kept across redraws, L31). */
let HIST_EXPANDED = new Set<string>();

async function renderSentHistory(ticket: number = HIST_SEQ.next()): Promise<void> {
  // The whole match is counted (no silent 1000 cap); only a page is drawn.
  const all = await history.search(
    $<HTMLInputElement>("#h-query").value.trim(),
    $<HTMLInputElement>("#h-start").value,
    $<HTMLInputElement>("#h-end").value,
    Number.POSITIVE_INFINITY,
  );
  if (!HIST_SEQ.isCurrent(ticket)) return; // a newer search/redraw owns the list
  const page = historyPage(all, HIST_SHOWN);
  const rows = page.visible;
  $("#h-count").textContent = historyCountLabel(page.total, rows.length);
  $("#h-empty").classList.toggle("hidden", page.total > 0);
  const more = $<HTMLButtonElement>("#h-more");
  more.classList.toggle("hidden", page.remaining === 0);
  more.textContent = `더 보기 (${Math.min(HISTORY_PAGE, page.remaining)}건 더 · 남은 ${page.remaining}건)`;
  const list = $("#h-list");
  list.innerHTML = "";
  const tag: Record<string, [string, string]> = {
    sms: ["tag-sent", "발송완료"], "record-only": ["tag-rec", "기록"], skipped: ["tag-rec", "제외"],
  };
  for (const r of rows) {
    const el = document.createElement("div");
    el.className = "listcard";
    const failed = sentStateOf(r) === "failed";
    const [tagCls, tagTxt] = failed ? ["tag-fail", "발송 실패"] : tag[r.channel] ?? ["tag-rec", esc(r.channel)];
    const failLine = failed ? `<br>실패 사유: ${esc(r.fail_reason) || "-"} · 다시 보내 주세요` : "";
    const firstNote = firstSendNote(r); // 재발송 고객: '최초 발송 YYYY-MM-DD · N회' (#57)
    const firstLine = firstNote ? `<br>${esc(firstNote)}` : "";
    const hasBody = !!r.body;
    // 카드 헤더/메타는 lc-tap 안에 두고 탭하면 아래로 보낸 문자 원문이 펼쳐진다(다시 탭하면 접힘).
    el.innerHTML = `
      <div class="lc-tap">
        <div class="lc-top"><span class="lc-name">${txt(r.customer) || "-"}</span>
          <span class="lc-phone">${esc(r.phone)}</span>
          <span class="lc-tag ${tagCls}">${tagTxt}</span>${hasBody ? `<span class="lc-caret">▾</span>` : ""}</div>
        <div class="lc-meta">개통 ${esc(r.opendate)} · 만료 ${esc(r.expiry_date)} · 처리 ${esc(r.sent_at.replace("T", " ").slice(0, 16))}<br>
          ${txt(r.agency)} · ${txt(r.telecom)} · ${txt(r.model)}${planLine(htmlUnescape(r.plan))}${firstLine}${failLine}</div>
      </div>
      <div class="lc-why hidden"></div>`;
    if (hasBody) {
      const tap = el.querySelector(".lc-tap") as HTMLElement;
      const box = el.querySelector(".lc-why") as HTMLElement;
      const caret = el.querySelector(".lc-caret") as HTMLElement | null;
      box.textContent = r.body ?? ""; // pre-wrap CSS가 줄바꿈을 보낸 원문 그대로 살린다
      // 펼친 카드는 다시 그려도(발송 결과 폴링 등) 펼친 채로 둔다 (L31).
      const key = recordKey(r);
      const show = (open: boolean): void => {
        box.classList.toggle("hidden", !open);
        if (caret) caret.textContent = open ? "▴" : "▾";
      };
      show(HIST_EXPANDED.has(key));
      tap.onclick = () => {
        const open = !HIST_EXPANDED.has(key);
        HIST_EXPANDED = open
          ? new Set([...HIST_EXPANDED, key])
          : new Set([...HIST_EXPANDED].filter((k) => k !== key));
        show(open);
      };
    }
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

/** '○월 ○일 스캔 기준' line above the 미방문 list (B7). */
function renderUnvisitedBasis(cleanDateIso: string, count: number): void {
  const box = $("#u-basis");
  const note = unvisitedBasisNote(cleanDateIso, todayIsoLocal(), count);
  box.classList.toggle("hidden", !note);
  box.classList.toggle("stale", !!note?.stale);
  box.textContent = note?.text ?? "";
}

/** Send from the 미방문 tab. Its list is the last CLEAN scan's (degraded scans don't
 *  refresh it), so it can be much older than home's — a customer may have
 *  re-contracted since: an older list needs an explicit confirm naming the day (B7). */
async function onUnvisitedSend(item: DueItem): Promise<void> {
  if (clockBlocksSend(item)) return; // a wrong phone date refuses first — never ask, then refuse
  const clean = await history.getCleanScanDate().catch(() => "");
  const warning = staleSendWarning(clean, today());
  if (warning && !(await appConfirm(warning, { title: "이전 스캔 결과", okLabel: "보내기" }))) return;
  await onSend(item);
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
    const [uCls, uTxt] = r.already_sent
      ? ["tag-sent", "안내함"]
      : r.sent_state === "recorded" ? ["tag-rec", "기록만 됨(미발송)"]
      : r.sent_state === "failed" ? ["tag-miss", "발송 실패"]
      : ["tag-miss", "미발송"];
    const statusTag = isExcluded
      ? `<span class="u-tag tag-done">제외됨</span>`
      : `<span class="u-tag ${uCls}">${uTxt}</span>`;
    const el = document.createElement("div");
    el.className = "listcard" + (isExcluded ? " u-handled" : "");
    el.innerHTML = `
      <div class="lc-top">
        <span class="lc-name">${esc(r.customer) || "-"}</span>
        ${statusTag}
        <span class="lc-dday plus">${esc(formatDdayLabel(-dplus))}</span>
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
        send.textContent = sendLabel(r.sent_state);
        send.onclick = () => void onUnvisitedSend(r);
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
  await history.setHandled(r.phone, r.expiry_date, true, r.opendate);
  await loadHistory();
  toast("미방문 목록에서 제외했습니다", {
    undo: () => {
      void (async () => {
        await history.setHandled(r.phone, r.expiry_date, false, r.opendate);
        await loadHistory();
      })();
    },
  });
}

/** Bring an excluded customer back into the 미방문 list. */
async function unexcludeUnvisited(r: DueItem): Promise<void> {
  await history.setHandled(r.phone, r.expiry_date, false, r.opendate);
  await loadHistory();
  toast("제외를 해제했습니다");
}

/** Entering 이력: start from the first page and render the active tab. */
export function enterHistory(): void {
  HIST_SHOWN = HISTORY_PAGE;
  HIST_EXPANDED = new Set();
  void loadHistory();
}

/** 이력 tabs, filters, 더 보기 and the 제외 고객 toggle. */
export function bindHistory(): void {
  // History tabs (발송 이력 / 미방문 고객)
  $$("#hist-tabs .histtab").forEach((b) => {
    b.onclick = () => { HIST_TAB = (b.dataset.htab as "sent" | "unvisited") ?? "sent"; void loadHistory(); };
  });
  // History filters (발송 이력 tab): a new filter starts from the first page (#59).
  const searchLater = debounce(() => { HIST_SHOWN = HISTORY_PAGE; void loadHistory(); }, HIST_QUERY_DEBOUNCE_MS);
  const refilter = (): void => { searchLater.cancel(); HIST_SHOWN = HISTORY_PAGE; void loadHistory(); };
  $("#h-query").addEventListener("input", () => searchLater.call());
  $("#h-query").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") refilter(); });
  $("#h-start").addEventListener("change", refilter);
  $("#h-end").addEventListener("change", refilter);
  $("#h-more").onclick = () => { HIST_SHOWN += HISTORY_PAGE; void renderSentHistory(); };
  // 미방문 탭: 제외한 고객도 보기 토글
  $<HTMLInputElement>("#u-show-excluded").addEventListener("change", (e) => {
    UNV_SHOW_EXCLUDED = (e.target as HTMLInputElement).checked;
    void loadHistory();
  });
}
