/**
 * Scan orchestrator: fetch -> compute expiry -> build the "due list". Port of
 * backend/scan.py. Produces the list of customers whose contract is due today
 * (per the configured milestones) and flags which were already alerted. Sending
 * is a separate, explicit per-row action (sender.ts).
 */
import { COHORT_WINDOW_DAYS, updateCohort } from "./cohort";
import { entryFromRow } from "./due-item";
import { dueWithin, scanOpenDateBounds } from "./expiry";
import type { History } from "./history";
import { keepDueItem, keepDueRows, keepPhoneSet, normalizePhone } from "./keepdate";
import { NetworkError, PoncleClient, PoncleGateway, SessionExpired } from "./poncle-client";
import { PlainDate, today } from "./plaindate";
import type { AppConfig, DueItem, PoncleRow } from "./types";
import { computeUnvisited } from "./unvisited";

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
  return { status: "error", state: "error", error: String(e), ...empty };
}

/**
 * Run one scan (hybrid 유지일 + 약정 계산). Pure of any UI; returns the due list.
 *
 * Pass 1 — 유지일: 요금제유지 미결에서 유지일이 안내시점 범위인 고객 (전화번호로 개통
 *   목록에 조인해 유형/통신사를 붙임).
 * Pass 2 — 약정: 개통 목록을 개통일+약정개월로 판단 (기존). 단 유지일이 등록된 전화번호
 *   (블랙리스트)는 날짜 불문 전부 제외 — 그 고객은 유지일로만 판단.
 * 두 패스를 전화번호로 병합 (유지일 우선). 미결이 0건이면 패스1 공집합 → 기존과 동일.
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

  const openByPhone = new Map<string, PoncleRow>();
  for (const r of openRows) {
    const p = normalizePhone(String(r["openphone"] ?? ""));
    if (p && !openByPhone.has(p)) openByPhone.set(p, r);
  }

  // Pass 1: 유지일 items. Join type/telecom from the windowed opens, else a
  // targeted per-phone lookup (few — only 유지일 customers opened outside the window).
  const keepItems: DueItem[] = [];
  for (const k of keepRows) {
    let openRow = openByPhone.get(k.phoneDigits) ?? null;
    if (openRow === null) {
      try {
        openRow = await client.fetchOpenByPhone(k.phone);
      } catch {
        openRow = null; // join failure -> wildcard-only match, still surfaced
      }
    }
    keepItems.push(keepDueItem(k, openRow));
  }

  // Pass 2: 약정 계산 items, skipping every 유지일 phone (blacklist).
  const termItems: DueItem[] = [];
  for (const row of openRows) {
    const phone = normalizePhone(String(row["openphone"] ?? ""));
    if (phone && blacklist.has(phone)) continue;
    for (const [offset, expiry] of dueWithin(row, cfg, todayD)) {
      const item = entryFromRow(row, offset, expiry);
      item.source = "term";
      termItems.push(item);
    }
  }

  // Merge by phone (유지일 wins). Blacklist already prevents overlap; this is a net.
  const byPhone = new Map<string, DueItem>();
  for (const it of keepItems) byPhone.set(normalizePhone(it.phone), it);
  for (const it of termItems) {
    const p = normalizePhone(it.phone);
    if (!byPhone.has(p)) byPhone.set(p, it);
  }
  const results = Array.from(byPhone.values());

  // already_sent + id (dedup on phone|expiry), loaded once.
  const sentKeys = await history.dedupKeySet();
  for (const item of results) {
    item.id = `${item.phone}|${item.expiry_date}`;
    item.already_sent = sentKeys.has(item.id);
  }

  // unsent before sent, then by opendate ascending (mirror scan.py sort key).
  results.sort((a, b) => {
    if (a.already_sent !== b.already_sent) return a.already_sent ? 1 : -1;
    return a.opendate < b.opendate ? -1 : a.opendate > b.opendate ? 1 : 0;
  });

  // 미방문 고객: expired-but-not-returned, derived from the same widened fetch.
  const unvisited = computeUnvisited(openRows, pendingRows, cfg, todayD, blacklist, sentKeys);

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
