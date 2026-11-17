/**
 * 재방문 전환율(cohort) tracking — the one dashboard metric that needs memory over
 * time. On each scan we persist the set of customers whose contract has expired,
 * whether we alerted them (informed), and whether they later came back (revisited
 * = a new 개통 appeared for the phone after the expiry). From that we compute the
 * revisit rate, split by whether an alert was sent — i.e. did our alerts help.
 *
 * Pure; persistence (History.loadCohort/saveCohort) and the scan wiring live
 * elsewhere. Bounded to a rolling window so the store can't grow forever.
 */
import { parseOpendate } from "./expiry";
import { dueKey, normalizePhone } from "./keepdate";
import { PlainDate, addDays, toIso } from "./plaindate";
import type { DueItem, PoncleRow } from "./types";
import { latestOpenByPhone } from "./unvisited";

export interface CohortEntry {
  phone: string;
  expiry: string; // ISO — the contract that expired
  informed: boolean; // we sent an alert for this contract
  revisited: boolean; // a newer 개통 appeared after the expiry
  firstSeen: string; // ISO date first added to the cohort
  /** ISO date of a re-contract that came BEFORE `expiry` (alerted, then re-contracted
   *  early). The entry is then dated by this day for the window/aging (it converted
   *  now, not at the old — possibly far-future — expiry). Absent otherwise and on
   *  entries written before v1.2.17 (migration-safe: the next scan fills it). */
  resolvedOn?: string;
  /** ISO 개통일 of the contract (audit L5): one contract is ONE entry even when its
   *  expiry moves (약정 개월 changed). Absent on entries written before v1.2.17 and
   *  backfilled when the scan sees the same phone|expiry again. */
  opendate?: string;
}

/** The day an entry counts in the 재방문 window: its early re-contract day when that
 *  precedes the expiry, else the expiry. */
export function cohortDate(e: Pick<CohortEntry, "expiry" | "resolvedOn">): string {
  return e.resolvedOn && e.resolvedOn < e.expiry ? e.resolvedOn : e.expiry;
}

export interface CohortStats {
  total: number;
  revisited: number;
  revisitRate: number; // %
  informed: number;
  informedRevisited: number;
  informedRate: number; // %
  uninformed: number;
  uninformedRevisited: number;
  uninformedRate: number; // %
}

/** Rolling window (days) over which 재방문 전환율 is measured. */
export const COHORT_WINDOW_DAYS = 90;

const keyOf = (phone: string, expiry: string): string => dueKey(phone, expiry);
/** phone|개통일 — one contract regardless of how its expiry was computed. */
const contractOf = (phone: string, openIso: string): string => `${normalizePhone(phone)}|${openIso}`;
/** ISO 개통일 of a raw Poncle/record opendate, or "" when unknown. */
function openIsoOf(raw: unknown): string {
  const od = parseOpendate(String(raw ?? ""));
  return od ? toIso(od) : "";
}

/** One contract's entry moved to a new expiry key: the stronger facts kept. */
function movedEntry(old: CohortEntry, expiry: string, openIso: string, informedNow: boolean): CohortEntry {
  return { ...old, expiry, opendate: openIso, informed: old.informed || informedNow };
}
const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 100) : 0);

/** A real (counted) send, as needed to spot an early re-contract. */
export interface CohortSend {
  phone: string;
  expiry_date: string;
  opendate?: string;
  sent_at: string;
}

/**
 * Fold one scan into the cohort: add newly-expired customers, refresh their
 * informed flag, mark revisits (a newer 개통), and age out past the window.
 * `sentKeys` must hold only REAL sends (SentIndex.sentKeySet — no skip/record-only/
 * failed). `realSends` (SentIndex.sentRecords) adds customers we alerted who then
 * re-contracted BEFORE expiry (latest 개통 on/after the send): they never reach the
 * 미방문 list, yet are the alert's success case (audit 1-19). `failedKeys`
 * (SentIndex.failedKeySet) are phone|expiry keys whose send was reported failed: an
 * entry there without a real send is NOT informed (audit L6). One contract (phone|
 * 개통일) is one entry — a changed 약정 개월 moves it to the new expiry (audit L5).
 */
export function updateCohort(
  prev: ReadonlyArray<CohortEntry>,
  expiredItems: ReadonlyArray<DueItem>, // this scan's 미방문 (expired, not yet returned)
  openRows: ReadonlyArray<PoncleRow>,
  sentKeys: ReadonlySet<string>,
  todayD: PlainDate,
  windowDays: number,
  realSends: ReadonlyArray<CohortSend> = [],
  failedKeys: ReadonlySet<string> = new Set(),
): CohortEntry[] {
  const todayIso = toIso(todayD);
  const byKey = new Map<string, CohortEntry>();
  for (const e of prev) byKey.set(keyOf(e.phone, e.expiry), { ...e });
  // contract (phone|개통일) -> its entry's key, for entries that know their 개통일.
  const byContract = new Map<string, string>();
  for (const [k, e] of byKey) if (e.opendate) byContract.set(contractOf(e.phone, e.opendate), k);

  for (const it of expiredItems) {
    if (!it.expiry_date) continue;
    const k = keyOf(it.phone, it.expiry_date);
    const openIso = openIsoOf(it.opendate);
    const existing = byKey.get(k);
    if (existing) {
      existing.informed = existing.informed || sentKeys.has(k);
      if (openIso && !existing.opendate) {
        existing.opendate = openIso; // backfill a legacy entry (L5)
        byContract.set(contractOf(it.phone, openIso), k);
      }
      continue;
    }
    // Same contract already counted under another expiry (약정 개월 changed): move it.
    const otherKey = openIso ? byContract.get(contractOf(it.phone, openIso)) : undefined;
    const other = otherKey ? byKey.get(otherKey) : undefined;
    if (otherKey && other) {
      byKey.delete(otherKey);
      byKey.set(k, movedEntry(other, it.expiry_date, openIso, sentKeys.has(k)));
      byContract.set(contractOf(it.phone, openIso), k);
      continue;
    }
    const entry: CohortEntry = {
      phone: it.phone,
      expiry: it.expiry_date,
      informed: sentKeys.has(k),
      revisited: false,
      firstSeen: todayIso,
    };
    if (openIso) {
      entry.opendate = openIso;
      byContract.set(contractOf(it.phone, openIso), k);
    }
    byKey.set(k, entry);
  }

  const latest = latestOpenByPhone(openRows as PoncleRow[]);
  const latestOpenIso = (phone: string): string => {
    const row = latest.get(normalizePhone(phone));
    const od = row ? parseOpendate(String(row["opendate"] ?? "")) : null;
    return od ? toIso(od) : "";
  };

  // Re-contract after an alert: a NEW 개통 on/after the send day. One re-contract is
  // ONE conversion, credited to the customer's latest qualifying alert (a 1단계 and a
  // 2단계 send of the same contract must not count it twice) — audit L3.
  const creditSend = new Map<string, { s: CohortSend; newOpen: string }>();
  for (const s of realSends) {
    const expiry = String(s.expiry_date ?? "").trim();
    const sentDay = String(s.sent_at ?? "").slice(0, 10);
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(sentDay)) continue;
    const newOpen = latestOpenIso(s.phone);
    if (!newOpen || newOpen < sentDay) continue;
    const oldOpen = parseOpendate(String(s.opendate ?? ""));
    if (oldOpen && toIso(oldOpen) === newOpen) continue; // same contract, not a new one
    const p = normalizePhone(s.phone);
    const cur = creditSend.get(p);
    if (!cur || String(s.sent_at) > String(cur.s.sent_at)) creditSend.set(p, { s, newOpen });
  }
  for (const [p, { s, newOpen }] of creditSend) {
    const expiry = String(s.expiry_date).trim();
    const sendOpen = openIsoOf(s.opendate);
    // The send's contract may sit under a moved expiry key (L5): use that entry.
    const movedKey = sendOpen ? byContract.get(contractOf(s.phone, sendOpen)) : undefined;
    const k = byKey.has(keyOf(s.phone, expiry)) || !movedKey ? keyOf(s.phone, expiry) : movedKey;
    const existing = byKey.get(k);
    // Before the old expiry (early): it never reached 미방문 — date it by the re-contract.
    const early = newOpen < expiry;
    if (early && !existing) {
      // An entry of this phone that expired before the re-contract is already this
      // same conversion (marked revisited below) — don't add a second one.
      const counted = Array.from(byKey.values()).some(
        (e) => normalizePhone(e.phone) === p && e.expiry < newOpen,
      );
      if (counted) continue;
    }
    const base: CohortEntry = existing ?? { phone: s.phone, expiry, informed: true, revisited: true, firstSeen: todayIso };
    const next: CohortEntry = { ...base, informed: true, revisited: true };
    if (sendOpen && !next.opendate) next.opendate = sendOpen;
    if (early) next.resolvedOn = newOpen;
    byKey.set(k, next);
  }

  for (const e of byKey.values()) {
    const k = keyOf(e.phone, e.expiry);
    // A send later reported failed did not inform the customer (L6): unless a real
    // send exists for the key, the flag drops back.
    e.informed = sentKeys.has(k) || (e.informed && !failedKeys.has(k));
    const row = latest.get(normalizePhone(e.phone));
    if (row) {
      const od = parseOpendate(String(row["opendate"] ?? ""));
      if (od !== null && toIso(od) > e.expiry) e.revisited = true;
    }
  }

  const floor = toIso(addDays(todayD, -Math.max(1, windowDays)));
  return Array.from(byKey.values()).filter((e) => cohortDate(e) >= floor);
}

/**
 * Correct `informed` against the live sent log: an entry stays informed only when
 * a handled record (real send or skip) exists for its phone|expiry. Used once to undo
 * informed=true written while practice (record-only) records still counted as sent.
 * Pure: new objects, same order and length.
 */
export function correctCohortInformed(
  entries: ReadonlyArray<CohortEntry>,
  handledKeys: ReadonlySet<string>,
): CohortEntry[] {
  return entries.map((e) =>
    e.informed && !handledKeys.has(keyOf(e.phone, e.expiry)) ? { ...e, informed: false } : { ...e },
  );
}

/** Conversion stats over customers whose expiry is within [today-window, today). */
export function cohortStats(
  entries: ReadonlyArray<CohortEntry>,
  todayD: PlainDate,
  windowDays: number,
): CohortStats {
  const todayIso = toIso(todayD);
  const floor = toIso(addDays(todayD, -Math.max(1, windowDays)));
  const inWin = entries.filter((e) => {
    const d = cohortDate(e);
    return d >= floor && d < todayIso;
  });
  const informed = inWin.filter((e) => e.informed);
  const uninformed = inWin.filter((e) => !e.informed);
  const revisited = inWin.filter((e) => e.revisited).length;
  const infRev = informed.filter((e) => e.revisited).length;
  const uninfRev = uninformed.filter((e) => e.revisited).length;
  return {
    total: inWin.length,
    revisited,
    revisitRate: pct(revisited, inWin.length),
    informed: informed.length,
    informedRevisited: infRev,
    informedRate: pct(infRev, informed.length),
    uninformed: uninformed.length,
    uninformedRevisited: uninfRev,
    uninformedRate: pct(uninfRev, uninformed.length),
  };
}
