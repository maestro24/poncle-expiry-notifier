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
import { normalizePhone } from "./keepdate";
import { PlainDate, addDays, toIso } from "./plaindate";
import type { DueItem, PoncleRow } from "./types";
import { latestOpenByPhone } from "./unvisited";

export interface CohortEntry {
  phone: string;
  expiry: string; // ISO — the contract that expired
  informed: boolean; // we sent an alert for this contract
  revisited: boolean; // a newer 개통 appeared after the expiry
  firstSeen: string; // ISO date first added to the cohort
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

const keyOf = (phone: string, expiry: string): string => `${phone}|${expiry}`;
const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 100) : 0);

/**
 * Fold one scan into the cohort: add newly-expired customers, refresh their
 * informed flag, mark revisits (a newer 개통), and age out past the window.
 */
export function updateCohort(
  prev: ReadonlyArray<CohortEntry>,
  expiredItems: ReadonlyArray<DueItem>, // this scan's 미방문 (expired, not yet returned)
  openRows: ReadonlyArray<PoncleRow>,
  sentKeys: ReadonlySet<string>,
  todayD: PlainDate,
  windowDays: number,
): CohortEntry[] {
  const todayIso = toIso(todayD);
  const byKey = new Map<string, CohortEntry>();
  for (const e of prev) byKey.set(keyOf(e.phone, e.expiry), { ...e });

  for (const it of expiredItems) {
    if (!it.expiry_date) continue;
    const k = keyOf(it.phone, it.expiry_date);
    const existing = byKey.get(k);
    if (existing) existing.informed = existing.informed || sentKeys.has(k);
    else
      byKey.set(k, {
        phone: it.phone,
        expiry: it.expiry_date,
        informed: sentKeys.has(k),
        revisited: false,
        firstSeen: todayIso,
      });
  }

  const latest = latestOpenByPhone(openRows as PoncleRow[]);
  for (const e of byKey.values()) {
    e.informed = e.informed || sentKeys.has(keyOf(e.phone, e.expiry));
    const row = latest.get(normalizePhone(e.phone));
    if (row) {
      const od = parseOpendate(String(row["opendate"] ?? ""));
      if (od !== null && toIso(od) > e.expiry) e.revisited = true;
    }
  }

  const floor = toIso(addDays(todayD, -Math.max(1, windowDays)));
  return Array.from(byKey.values()).filter((e) => e.expiry >= floor);
}

/** Conversion stats over customers whose expiry is within [today-window, today). */
export function cohortStats(
  entries: ReadonlyArray<CohortEntry>,
  todayD: PlainDate,
  windowDays: number,
): CohortStats {
  const todayIso = toIso(todayD);
  const floor = toIso(addDays(todayD, -Math.max(1, windowDays)));
  const inWin = entries.filter((e) => e.expiry >= floor && e.expiry < todayIso);
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
