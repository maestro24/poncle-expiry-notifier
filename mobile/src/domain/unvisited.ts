/**
 * 미방문 고객(unvisited) — customers whose representative 만료 already passed but
 * who have NOT returned to the store.
 *
 * "Returned" is Poncle's own data: a store visit (재계약 / 번호이동 / 기변) creates a
 * NEW 개통 row for the SAME phone number (preserved across MNP/기변). So a phone is
 * 미방문 iff its LATEST 개통 row is past its 대표 만료 and no newer 개통 exists — when
 * the customer comes back a newer row appears and they drop off automatically.
 *
 * 대표 만료 (computeExpiry): 약정 대상(신규/번호이동/기변) = 약정 만료(개통+약정 개월),
 * 유심 등 그 외 = 요금제 유지(개통+기본 6개월). Tracked until unvisited_lookback_months
 * past that 만료. Pure: fetching/joining is orchestrated in scan.ts, off the SAME
 * widened open fetch the due scan already made.
 */
import { entryFromRow, field } from "./due-item";
import { computeExpiry, unvisitedFloor } from "./expiry";
import { normalizePhone } from "./keepdate";
import { PlainDate, daysBetween } from "./plaindate";
import { isContractType } from "./template-match";
import type { AppConfig, DueItem, PoncleRow } from "./types";

/**
 * Group open rows by (digits) phone, keeping the row with the latest opendate —
 * the customer's current contract. 'yy-mm-dd' sorts lexically within the 2000s,
 * matching PoncleClient.fetchOpenByPhone.
 */
export function latestOpenByPhone(openRows: PoncleRow[]): Map<string, PoncleRow> {
  const map = new Map<string, PoncleRow>();
  for (const r of openRows) {
    const phone = normalizePhone(field(r, "openphone"));
    if (!phone) continue;
    const prev = map.get(phone);
    if (!prev || field(r, "opendate") > field(prev, "opendate")) map.set(phone, r);
  }
  return map;
}

/** True if `expiry` is already past today but not older than the look-back floor. */
function expiredWithinLookback(expiry: PlainDate, todayD: PlainDate, floor: PlainDate): boolean {
  return expiry.getTime() < todayD.getTime() && expiry.getTime() >= floor.getTime();
}

/**
 * The full 미방문 list from one scan's open rows: for each phone's LATEST open row,
 * surface it when the customer's 대표 만료 is in [today - lookback, today). 무약정
 * (no computable 만료) rows are skipped. `source` is set so a 미방문 알림 routes to
 * the right template (약정 대상 -> term/T2, 그 외 -> keepdate/T1). Manual 제외
 * overrides are applied by the caller (History.handledKeys). Unsent first, then
 * most-recently-expired first.
 */
export function computeUnvisited(
  openRows: PoncleRow[],
  config: AppConfig,
  todayD: PlainDate,
  sentKeys: Set<string>,
): DueItem[] {
  const floor = unvisitedFloor(config, todayD);
  const out: DueItem[] = [];
  for (const [, row] of latestOpenByPhone(openRows)) {
    const expiry = computeExpiry(row, config);
    if (expiry === null) continue; // 무약정 / opendate 불명
    if (!expiredWithinLookback(expiry, todayD, floor)) continue;
    const item = entryFromRow(row, daysBetween(todayD, expiry), expiry); // offset = D+
    item.source = isContractType(field(row, "openhowx")) ? "term" : "keepdate";
    item.id = `${item.phone}|${item.expiry_date}`;
    item.already_sent = sentKeys.has(item.id);
    out.push(item);
  }
  return out.sort((a, b) => {
    if (a.already_sent !== b.already_sent) return a.already_sent ? 1 : -1;
    // newest expiry first (smallest D+ on top)
    return a.expiry_date < b.expiry_date ? 1 : a.expiry_date > b.expiry_date ? -1 : 0;
  });
}
