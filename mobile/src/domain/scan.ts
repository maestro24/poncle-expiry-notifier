/**
 * Scan orchestrator: fetch -> compute expiry -> build the "due list". Port of
 * backend/scan.py. Produces the list of customers whose contract is due today
 * (per the configured milestones) and flags which were already alerted. Sending
 * is a separate, explicit per-row action (sender.ts).
 */
import { COHORT_WINDOW_DAYS, updateCohort } from "./cohort";
import { entryFromRow, field } from "./due-item";
import { contractTermMonths, keepdateDefaultMonths, milestoneDue, scanOpenDateBounds } from "./expiry";
import type { History } from "./history";
import { dueKey, keepDueItem, keepDueRows, keepPhoneSet } from "./keepdate";
import { NetworkError, PoncleClient, PoncleGateway, SessionExpired } from "./poncle-client";
import { PlainDate, today } from "./plaindate";
import { isContractType } from "./template-match";
import type { AppConfig, DueItem, PoncleRow } from "./types";
import { computeUnvisited, latestOpenByPhone } from "./unvisited";

export { entryFromRow } from "./due-item";

export type ScanState = "idle" | "scanning" | "session_expired" | "error";

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
): Promise<ScanResult> {
  const empty = { results: [] as DueItem[], unvisited: [] as DueItem[], pendingDegraded: false, targets: 0, sent: 0, pending: 0 };
  const client = new PoncleClient(gw, cfg);

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
  const blacklist = keepPhoneSet(pendingRows);
  const keepRows = keepDueRows(pendingRows, cfg, todayD);

  // Open list (pass 2 source; the join source for pass 1; and — via the widened
  // look-back bounds — the 미방문 source). One fetch feeds all three.
  const bounds = scanOpenDateBounds(cfg, todayD);
  let openRows: PoncleRow[];
  try {
    openRows = await client.fetchCandidates(bounds);
  } catch (e) {
    return errorResult(e, empty)!;
  }

  // Latest 개통 per phone = the customer's current contract (drives the milestones).
  const latestOpen = latestOpenByPhone(openRows);

  // Pass A — 요금제 유지 (1단계) from 폰클 유지일. Join type/telecom from the latest
  // opens, else a targeted per-phone lookup (few — 유지일 customers opened outside window).
  const keepItems: DueItem[] = [];
  for (const k of keepRows) {
    let openRow = latestOpen.get(k.phoneDigits) ?? null;
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
    const due = milestoneDue(field(row, "opendate"), keepDefault, cfg, todayD);
    if (!due) continue;
    const item = entryFromRow(row, due[0], due[1]);
    item.source = "keepdate";
    stage1Default.push(item);
  }

  // Pass C — 약정 만료 (2단계): 약정 대상만, 개통 + 약정 개월. 유지일 유무와 무관.
  const termMonths = contractTermMonths(cfg);
  const termItems: DueItem[] = [];
  for (const [, row] of latestOpen) {
    if (!isContractType(field(row, "openhowx"))) continue;
    const due = milestoneDue(field(row, "opendate"), termMonths, cfg, todayD);
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

  // already_sent + id (dedup on normalized phone|expiry), loaded once.
  const sentKeys = await history.dedupKeySet();
  for (const item of results) {
    item.id = dueKey(item.phone, item.expiry_date);
    item.already_sent = sentKeys.has(item.id);
  }

  // unsent before sent, then by opendate ascending (mirror scan.py sort key).
  results.sort((a, b) => {
    if (a.already_sent !== b.already_sent) return a.already_sent ? 1 : -1;
    return a.opendate < b.opendate ? -1 : a.opendate > b.opendate ? 1 : 0;
  });

  // 미방문 고객: expired-but-not-returned, derived from the same widened fetch.
  // 대표 만료(약정 대상=약정 24개월, 유심=요금제 유지 6개월)가 지난 최신 개통.
  const unvisited = computeUnvisited(openRows, cfg, todayD, sentKeys);

  // 재방문 전환율 코호트 갱신 (auxiliary; a degraded 미결 fetch gives an empty
  // blacklist so the expired set is unreliable → skip. Never fail a scan over it).
  if (!pendingDegraded) {
    try {
      const prevCohort = await history.loadCohort();
      await history.saveCohort(
        updateCohort(prevCohort, unvisited, openRows, sentKeys, todayD, COHORT_WINDOW_DAYS),
      );
    } catch {
      /* ignore cohort persistence errors */
    }
  }

  const sent = results.filter((r) => r.already_sent).length;
  return {
    status: "ok",
    state: "idle",
    results,
    unvisited,
    pendingDegraded,
    targets: results.length,
    sent,
    pending: results.length - sent,
  };
}
