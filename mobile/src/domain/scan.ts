/**
 * Scan orchestrator: fetch -> compute expiry -> build the "due list". Port of
 * backend/scan.py. Produces the list of customers whose contract is due today
 * (per the configured milestones) and flags which were already alerted. Sending
 * is a separate, explicit per-row action (sender.ts).
 */
import { COHORT_WINDOW_DAYS, updateCohort } from "./cohort";
import { entryFromRow, field, sortDueItems } from "./due-item";
import {
  catchUpCapped,
  catchUpDaysSince,
  contractTermMonths,
  keepdateDefaultMonths,
  milestoneDue,
  scanOpenDateBounds,
} from "./expiry";
import type { History } from "./history";
import { dueKey, isStaleKeepdate, keepDueItem, keepDueRows, keepPhoneSet, parseKeepdate } from "./keepdate";
import { NetworkError, PoncleClient, PoncleGateway, SessionExpired } from "./poncle-client";
import { PlainDate, today } from "./plaindate";
import { isContractType } from "./template-match";
import type { AppConfig, DueItem, PoncleRow } from "./types";
import { computeUnvisited, latestOpenByPhone } from "./unvisited";

/** Optional scan inputs from the app layer. */
export interface ScanOptions {
  /**
   * ISO yyyy-mm-dd of the LAST SUCCESSFUL scan (History.getDueCacheDate()). When
   * given, milestones that passed since that day (inclusive, capped at
   * CATCH_UP_MAX_DAYS) are included with a NEGATIVE milestone_offset (D+N, overdue),
   * so a 1단계/유지일 that fell on a closed day is not lost (audit 1-4). Omitted or ""
   * -> no catch-up (classic behavior).
   */
  sinceDate?: string;
  /** Override the Poncle paging safety cap (tests). Omitted -> client defaults. */
  maxPages?: number;
}

export { entryFromRow } from "./due-item";

/** Shown when ScanResult.truncated: the list may be missing customers. */
export const SCAN_TRUNCATED_MESSAGE = "폰클 목록이 너무 많아 일부만 불러왔습니다 — 결과가 빠졌을 수 있으니 잠시 후 다시 스캔해 주세요";

export type ScanState ="idle" | "scanning" | "session_expired" | "error";

export interface ScanResult {
  status: "ok" | "session_expired" | "error";
  state: ScanState;
  results: DueItem[];
  /** 미방문 고객: expired-but-not-returned customers, from the same fetch. */
  unvisited: DueItem[];
  /** True when the 미결 fetch degraded to empty (network/native glitch, not logout).
   *  The due list still stands, but the 미방문 blacklist is missing, so the caller
   *  must NOT overwrite the persisted 미방문 cache with this scan's list. */
  pendingDegraded: boolean;
  /** True when a paging safety cap stopped a fetch that still had full pages, so
   *  the lists may be incomplete (audit 3-7). Only set on status "ok". */
  truncated?: boolean;
  /** True when `sinceDate` was older than CATCH_UP_MAX_DAYS, so milestones that
   *  passed before the cap were not re-surfaced (I3) — the caller should point the
   *  staff to the 미방문 list. Only set on status "ok". */
  catchUpCapped?: boolean;
  targets: number;
  sent: number;
  pending: number;
  error?: string;
}

function errorResult(e: unknown, empty: { results: DueItem[]; unvisited: DueItem[]; pendingDegraded: boolean; targets: number; sent: number; pending: number }): ScanResult | null {
  if (e instanceof SessionExpired) return { status: "session_expired", state: "session_expired", ...empty };
  if (e instanceof NetworkError) return { status: "error", state: "error", error: "네트워크 오류로 스캔에 실패했습니다. 잠시 후 다시 시도하세요.", ...empty };
  // Never surface a raw exception string (e.g. "TypeError: ...") to a non-technical
  // 점주 — log the detail for debugging, show a plain Korean message.
  console.error("scan failed:", e);
  return { status: "error", state: "error", error: "스캔 중 오류가 발생했습니다. 다시 시도해 주세요.", ...empty };
}

/**
 * Run one scan (2단계 마일스톤). Pure of any UI; returns the due list.
 *
 * 전화번호별 최신 개통마다 최대 2개 마일스톤을 산출:
 *  - 요금제 유지 (1단계, source=keepdate): 폰클 요금제유지 미결의 유지일(Pass A),
 *    없으면 개통 + 기본 개월(Pass B). 모든 개통 대상.
 *  - 약정 만료 (2단계, source=term): 약정 대상(신규/번호이동/기변)만, 개통 + 약정 개월(Pass C).
 * phone|만료일로 병합하므로 한 고객의 1·2단계 알림이 각각 살아남는다(보통 만료일이 다름).
 * 만료일이 같아 충돌하는 드문 경우엔 약정 만료(term)가 우선한다.
 */
export async function runScan(
  gw: PoncleGateway,
  cfg: AppConfig,
  history: History,
  todayD: PlainDate = today(),
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const empty = { results: [] as DueItem[], unvisited: [] as DueItem[], pendingDegraded: false, targets: 0, sent: 0, pending: 0 };
  const client = new PoncleClient(gw, cfg, opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {});
  const catchUp = catchUpDaysSince(opts.sinceDate ?? "", todayD);

  // Fetch the 요금제유지 미결 FIRST so the term-pass blacklist is accurate. A real
  // logout surfaces (session_expired); any other pending failure degrades to
  // term-only (empty pending) rather than killing the whole scan — that is exactly
  // the pre-유지일 behavior, so a transient pending glitch never blocks scanning.
  let pendingRows: PoncleRow[];
  let pendingDegraded = false;
  try {
    pendingRows = await client.fetchPending();
  } catch (e) {
    if (e instanceof SessionExpired) return { status: "session_expired", state: "session_expired", ...empty };
    pendingRows = [];
    pendingDegraded = true; // 미방문 blacklist is now empty -> don't trust/persist unvisited
  }
  const keepRows = keepDueRows(pendingRows, cfg, todayD, catchUp);

  // Open list (pass 2 source; the join source for pass 1; and — via the widened
  // look-back bounds — the 미방문 source). One fetch feeds all three.
  const bounds = scanOpenDateBounds(cfg, todayD, catchUp);
  let openRows: PoncleRow[];
  try {
    openRows = await client.fetchCandidates(bounds);
  } catch (e) {
    return errorResult(e, empty)!;
  }

  // A paging cap cut a fetch short (L4): the 유지일 blacklist / expired set may be
  // incomplete, exactly like a failed 미결 fetch -> flag Pass B dates and don't
  // persist the cohort from it. `pendingDegraded` (reported) stays the fetch failure.
  const unreliable = pendingDegraded || client.truncated;

  // Latest 개통 per phone = the customer's current contract (drives the milestones).
  const latestOpen = latestOpenByPhone(openRows);
  // Pass B blacklist: only 유지일 of the CURRENT contract (audit 1-16).
  const blacklist = keepPhoneSet(pendingRows, latestOpen);

  // Pass A — 요금제 유지 (1단계) from 폰클 유지일. Join type/telecom from the latest
  // opens, else a targeted per-phone lookup (few — 유지일 customers opened outside window).
  const keepItems: DueItem[] = [];
  for (const k of keepRows) {
    let openRow = latestOpen.get(k.phoneDigits) ?? null;
    // A 유지일 that predates the current 개통 belongs to a previous contract.
    const kd = parseKeepdate(k.keepdateIso);
    if (openRow !== null && kd !== null && isStaleKeepdate(kd, openRow)) continue;
    if (openRow === null) {
      try {
        openRow = await client.fetchOpenByPhone(k.phone);
      } catch {
        openRow = null; // join failure -> wildcard-only match, still surfaced
      }
    }
    keepItems.push(keepDueItem(k, openRow));
  }

  // Pass B — 요금제 유지 (1단계) 기본값: phones WITHOUT a 폰클 유지일, 개통 + 기본 개월.
  const keepDefault = keepdateDefaultMonths(cfg);
  const stage1Default: DueItem[] = [];
  for (const [phone, row] of latestOpen) {
    if (blacklist.has(phone)) continue; // 폰클 유지일 있음 -> Pass A가 처리
    const due = milestoneDue(field(row, "opendate"), keepDefault, cfg, todayD, catchUp);
    if (!due) continue;
    const item = entryFromRow(row, due[0], due[1]);
    item.source = "keepdate";
    // Without the 미결 list we can't tell whether this customer has a 폰클 유지일, so
    // the 개통+기본 개월 date may be wrong (audit 1-30): flag it for the caller.
    if (unreliable) item.degraded = true;
    stage1Default.push(item);
  }

  // Pass C — 약정 만료 (2단계): 약정 대상만, 개통 + 약정 개월. 유지일 유무와 무관.
  const termMonths = contractTermMonths(cfg);
  const termItems: DueItem[] = [];
  for (const [, row] of latestOpen) {
    if (!isContractType(field(row, "openhowx"))) continue;
    const due = milestoneDue(field(row, "opendate"), termMonths, cfg, todayD, catchUp);
    if (!due) continue;
    const item = entryFromRow(row, due[0], due[1]);
    item.source = "term";
    termItems.push(item);
  }

  // Merge by id (phone|만료일) so a customer's 1단계 + 2단계 coexist (normally
  // different dates). On the RARE same-date collision — e.g. keepdate 기본 개월 ==
  // 약정 개월 (both are user-editable in 설정), or a 폰클 유지일 that lands exactly on
  // 개통+약정 — the 약정 만료(term) milestone WINS (term is listed first, first-wins).
  // 약정 만료가 계약 고객에게 더 실행가능한 알림이며, 이렇게 하지 않으면 term이 조용히
  // 사라져 계약 만료 안내를 놓친다.
  const byKey = new Map<string, DueItem>();
  for (const it of [...termItems, ...keepItems, ...stage1Default]) {
    const key = dueKey(it.phone, it.expiry_date);
    if (!byKey.has(key)) byKey.set(key, it);
  }
  const results = Array.from(byKey.values());

  // already_sent + id (normalized phone|expiry), loaded once. The SentIndex also
  // matches a send of the SAME contract+stage under a different expiry (약정 개월
  // changed, degraded 개통+기본 개월 date, 유지일 vs 기본 개월) — audit 1-29/1-30.
  const sentIdx = await history.sentIndex(cfg);
  for (const item of results) {
    item.id = dueKey(item.phone, item.expiry_date);
    item.sent_state = sentIdx.stateOf(item);
    item.already_sent = item.sent_state === "sent" || item.sent_state === "skipped";
  }

  // unsent before sent, then most urgent first (expiry ascending: overdue on top) —
  // the same order the UI re-applies after re-flagging (sortDueItems, audit 3-9).
  const sorted = sortDueItems(results);

  // 미방문 고객: expired-but-not-returned, derived from the same widened fetch.
  // 대표 만료(약정 대상=약정 개월, 유심=폰클 유지일 또는 개통+기본 개월)가 지난 최신 개통.
  const unvisited = computeUnvisited(openRows, cfg, todayD, sentIdx, pendingRows);
  if (unreliable) {
    // 유심 customers' 대표 만료 needs the 유지일; without it the date may be wrong.
    for (const it of unvisited) if (it.source === "keepdate") it.degraded = true;
  }

  // 재방문 전환율 코호트 갱신 (auxiliary; a degraded 미결 fetch gives an empty
  // blacklist so the expired set is unreliable → skip; so does a cut-off fetch, L4.
  // Never fail a scan over it).
  if (!unreliable) {
    try {
      await history.migrateCohortInformed(); // one-shot: undo record-only 'informed' (L4)
      // informed = a REAL sms (not failed); a skip / record-only isn't informing.
      const cohortKeys = sentIdx.sentKeySet();
      // (sentAt also matches the same contract+stage under a different expiry key.)
      for (const it of unvisited) if (sentIdx.sentAt(it)) cohortKeys.add(it.id);
      const prevCohort = await history.loadCohort();
      await history.saveCohort(
        updateCohort(
          prevCohort, unvisited, openRows, cohortKeys, todayD, COHORT_WINDOW_DAYS, sentIdx.sentRecords(),
          sentIdx.failedKeySet(), // a failed send no longer counts as 안내함 (L6)
        ),
      );
    } catch {
      /* ignore cohort persistence errors */
    }
  }

  const sent = sorted.filter((r) => r.already_sent).length;
  return {
    status: "ok",
    state: "idle",
    results: sorted,
    unvisited,
    pendingDegraded,
    truncated: client.truncated,
    catchUpCapped: catchUpCapped(opts.sinceDate ?? "", todayD),
    targets: sorted.length,
    sent,
    pending: sorted.length - sent,
  };
}
