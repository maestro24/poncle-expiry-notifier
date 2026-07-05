/**
 * 미방문 고객(unvisited) scan pass — customers whose contract already expired but
 * who have NOT returned to the store.
 *
 * The signal for "returned" is Poncle's own data: a store visit (재계약 / 번호이동 /
 * 기변) creates a NEW 개통 row for the SAME phone number (the number is preserved
 * across MNP/기변). So a phone is 미방문 iff its LATEST 개통 row is expired and no
 * newer 개통 exists. When the customer comes back a newer row appears, their
 * "latest" contract becomes future-dated, and they drop off automatically.
 *
 * Pure: fetching/joining is orchestrated in scan.ts. Runs off the SAME open +
 * pending rows the due scan already fetched (the fetch window is widened by
 * scanOpenDateBounds so recently-expired rows are present).
 */
import { entryFromRow, field } from "./due-item";
import { computeExpiry, parseOpendate, unvisitedFloor } from "./expiry";
import { KeepDueRow, isKeepPending, keepDueItem, normalizePhone, parseKeepdate } from "./keepdate";
import { PlainDate, daysBetween, toIso } from "./plaindate";
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
 * 약정 계산 기준 미방문: for each phone's LATEST open row, surface it when that
 * contract's expiry is in [today - lookback, today). Skips 유지일 phones
 * (blacklist — judged by keepUnvisited instead) and 무약정 rows (no expiry).
 */
export function termUnvisited(
  openRows: PoncleRow[],
  config: AppConfig,
  todayD: PlainDate,
  blacklist: Set<string>,
  sentKeys: Set<string>,
): DueItem[] {
  const floor = unvisitedFloor(config, todayD);
  const out: DueItem[] = [];
  for (const [phone, row] of latestOpenByPhone(openRows)) {
    if (blacklist.has(phone)) continue;
    const expiry = computeExpiry(row, config);
    if (expiry === null) continue; // 무약정
    if (!expiredWithinLookback(expiry, todayD, floor)) continue;
    const item = entryFromRow(row, daysBetween(todayD, expiry), expiry); // offset = D+
    item.source = "term";
    item.id = `${item.phone}|${item.expiry_date}`;
    item.already_sent = sentKeys.has(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 요금제 유지일 기준 미방문: a 요금제유지 미결 whose 유지일 is past (within look-back)
 * and not 해결, with no re-activation after the 유지일. Symmetric to keepDueRows,
 * but backward-looking.
 */
export function keepUnvisited(
  pendingRows: PoncleRow[],
  openRows: PoncleRow[],
  config: AppConfig,
  todayD: PlainDate,
  sentKeys: Set<string>,
): DueItem[] {
  const floor = unvisitedFloor(config, todayD);
  const latest = latestOpenByPhone(openRows);
  const out: DueItem[] = [];
  for (const r of pendingRows) {
    if (!isKeepPending(r)) continue;
    if (field(r, "condx") === "해결") continue; // 해결 = handled/visited
    const kd = parseKeepdate(field(r, "pendingdate"));
    if (kd === null) continue;
    if (!expiredWithinLookback(kd, todayD, floor)) continue;
    const display = field(r, "openphone") || field(r, "phone");
    const digits = normalizePhone(display);
    const openRow = latest.get(digits) ?? null;
    // Returned after the 유지일? A newer 개통 (opendate > 유지일) means they came back.
    if (openRow) {
      const od = parseOpendate(field(openRow, "opendate"));
      if (od !== null && od.getTime() > kd.getTime()) continue;
    }
    const kdr: KeepDueRow = {
      phone: display,
      phoneDigits: digits,
      keepdateIso: toIso(kd),
      offset: daysBetween(todayD, kd), // D+
      name: field(r, "name") || field(r, "customer"),
    };
    const item = keepDueItem(kdr, openRow);
    item.already_sent = sentKeys.has(item.id);
    out.push(item);
  }
  return out;
}

/**
 * The full 미방문 list from one scan's rows: term + keepdate passes merged by
 * phone|expiry (keepdate wins), unsent first, then most-recently-expired first.
 * Manual 제외(exclude) overrides are applied by the caller (History.handledKeys).
 */
export function computeUnvisited(
  openRows: PoncleRow[],
  pendingRows: PoncleRow[],
  config: AppConfig,
  todayD: PlainDate,
  blacklist: Set<string>,
  sentKeys: Set<string>,
): DueItem[] {
  const term = termUnvisited(openRows, config, todayD, blacklist, sentKeys);
  const keep = keepUnvisited(pendingRows, openRows, config, todayD, sentKeys);
  const byKey = new Map<string, DueItem>();
  for (const it of keep) byKey.set(it.id, it);
  for (const it of term) if (!byKey.has(it.id)) byKey.set(it.id, it);
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.already_sent !== b.already_sent) return a.already_sent ? 1 : -1;
    // newest expiry first (smallest D+ on top)
    return a.expiry_date < b.expiry_date ? 1 : a.expiry_date > b.expiry_date ? -1 : 0;
  });
}
