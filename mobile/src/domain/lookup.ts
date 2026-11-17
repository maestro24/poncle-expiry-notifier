/**
 * 고객 조회(lookup) — turn live 개통 rows from a name/phone search into per-customer
 * result cards with a contract-status label. Pure; fetching is done in the app
 * layer via PoncleClient.searchCustomers, sent-history join by the caller.
 *
 * Each phone's LATEST 개통 row is the current contract (same rule as 미방문). A
 * customer with more than one 개통 row has re-signed at least once (재계약 완료).
 */
import { field } from "./due-item";
import { unvisitedFloor } from "./expiry";
import { currentKeepdates, dueKey, normalizePhone } from "./keepdate";
import { PlainDate, daysBetween, toIso } from "./plaindate";
import { isContractType } from "./template-match";
import type { AppConfig, DueItem, MilestoneSource, PoncleRow, SentMatchTarget } from "./types";
import { latestOpenByPhone, representativeExpiry } from "./unvisited";

/** A SentIndex-like source: per-milestone sentAt and, when present, the newest real
 *  send to the phone across 1단계/2단계/manual records (SentIndex.latestSentAt). */
export interface LookupSentIndex {
  sentAt(t: SentMatchTarget): string;
  latestSentAt?(phone: string): string;
}

/** Real-send lookup for the 안내 이력 join: a SentIndex or, legacy, a Map of
 *  dueKey -> sent_at. */
export type LookupSentSource = ReadonlyMap<string, string> | LookupSentIndex;

function informedAtFor(sent: LookupSentSource, t: SentMatchTarget & { id: string }): string {
  if (!("sentAt" in sent) || typeof sent.sentAt !== "function") {
    return (sent as ReadonlyMap<string, string>).get(t.id) ?? "";
  }
  const idx = sent as LookupSentIndex;
  // '안내 이력' = what this customer last received from us, whatever it was for:
  // a 약정 고객's 1단계 (keepdate) send or a 직접 입력 (manual) send counts (B11/C1).
  const latest = typeof idx.latestSentAt === "function" ? idx.latestSentAt(t.phone) : "";
  const own = t.expiry_date ? idx.sentAt(t) : "";
  return latest > own ? latest : own;
}

/** The 조회 card's '안내 이력' for a result, from a fresh SentIndex (after a send). */
export function lookupInformedAt(sent: LookupSentSource, r: LookupResult): string {
  return informedAtFor(sent, { ...lookupTarget(r), id: r.id });
}

function lookupTarget(r: Pick<LookupResult, "phone" | "expiry_date" | "opendate" | "openhow">): SentMatchTarget {
  return { phone: r.phone, expiry_date: r.expiry_date, opendate: r.opendate, openhow: r.openhow, source: lookupSource(r.openhow) };
}

export type LookupTone = "ok" | "warn" | "danger" | "muted";

export interface LookupStatus {
  label: string;
  tone: LookupTone;
}

export interface LookupResult {
  id: string; // phone|expiry (matches the sent-log dedup key)
  phone: string;
  customer: string;
  opendate: string;
  expiry_date: string; // "" when 무약정 (no computable expiry)
  telecom: string;
  agency: string;
  model: string;
  plan: string;
  openhow: string;
  staff: string;
  status: LookupStatus;
  informedAt: string; // sent_at of our last alert, "" if never contacted
  /** Signed days until expiry (expiry - today; negative once passed, D+N). 0 for 무약정. */
  offsetDays: number;
  /** True when the 요금제유지 미결 fetch failed and this result's 만료 depends on it
   *  (유심 등 = 요금제 유지; it fell back to 개통+기본 개월, possibly days off): the
   *  caller warns and blocks sending it, like a degraded scan item (audit L11).
   *  Absent = trustworthy. */
  degraded?: boolean;
}

/**
 * Contract status for a looked-up customer.
 * - 무약정 (no expiry) -> muted.
 * - expired within the 미방문 tracking window (expiry >= `lookbackFloor`) -> danger
 *   "만료 지남 · 미방문 · D+N"; expired before it -> danger "만료 지남" (no 미방문/D+N:
 *   the app no longer tracks that customer — audit D3). Without a floor every
 *   expired customer reads as 미방문 (legacy).
 * - expiring within the window -> warn "곧 만료 · D-N".
 * - active with a prior 개통 (re-signed) -> ok "재계약 완료".
 * - otherwise active -> ok "여유 · 만료 <date>".
 */
export function lookupStatus(
  expiry: PlainDate | null,
  todayD: PlainDate,
  windowDays: number,
  hasPrior: boolean,
  lookbackFloor?: PlainDate | null,
): LookupStatus {
  if (expiry === null) return { label: "무약정", tone: "muted" };
  const days = daysBetween(expiry, todayD); // expiry - today
  if (days < 0) {
    if (lookbackFloor && expiry.getTime() < lookbackFloor.getTime()) return { label: "만료 지남", tone: "danger" };
    return { label: `만료 지남 · 미방문 · D+${-days}`, tone: "danger" };
  }
  if (days <= Math.max(0, windowDays)) return { label: `곧 만료 · D-${days}`, tone: "warn" };
  if (hasPrior) return { label: "재계약 완료", tone: "ok" };
  return { label: `여유 · 만료 ${toIso(expiry)}`, tone: "ok" };
}

/**
 * Build lookup cards from raw search rows. Groups by phone (latest = current),
 * flags re-signed customers, computes status, and joins our alert history.
 * `pendingRows` (요금제유지 미결) make a 유심 customer's 만료 the 폰클 유지일 so the
 * key matches the home scan (audit 1-9); `sent` should be History.sentIndex() so a
 * send under a differently-computed expiry still shows '안내함' (audit 1-29).
 * `pendingDegraded` = that 미결 fetch failed: the 유심 results are marked degraded.
 */
export function buildLookupResults(
  openRows: PoncleRow[],
  config: AppConfig,
  todayD: PlainDate,
  windowDays: number,
  sent: LookupSentSource,
  pendingRows: PoncleRow[] = [],
  pendingDegraded = false,
): LookupResult[] {
  const countByPhone = new Map<string, number>();
  for (const r of openRows) {
    const p = normalizePhone(field(r, "openphone"));
    if (p) countByPhone.set(p, (countByPhone.get(p) ?? 0) + 1);
  }

  const latest = latestOpenByPhone(openRows);
  const keepdates = currentKeepdates(pendingRows, latest);
  const floor = unvisitedFloor(config, todayD); // 미방문 tracking window (D3)
  const out: LookupResult[] = [];
  for (const [phoneDigits, row] of latest) {
    const expiry = representativeExpiry(row, config, keepdates);
    const hasPrior = (countByPhone.get(phoneDigits) ?? 1) > 1;
    const phone = field(row, "openphone");
    const expiryIso = expiry ? toIso(expiry) : "";
    const id = dueKey(phone, expiryIso);
    // Signed days until expiry: an expired customer's {when} reads "D+N", never "오늘".
    const offsetDays = expiry ? daysBetween(expiry, todayD) : 0;
    const opendate = field(row, "opendate");
    const openhow = field(row, "openhowx");
    const result: LookupResult = {
      id,
      phone,
      customer: field(row, "customer"),
      opendate,
      expiry_date: expiryIso,
      telecom: field(row, "telecomx") || field(row, "telecom"),
      agency: field(row, "agencytitle"),
      model: field(row, "model"),
      plan: field(row, "plan"),
      openhow,
      staff: field(row, "membername") || field(row, "username"),
      status: lookupStatus(expiry, todayD, windowDays, hasPrior, floor),
      informedAt: informedAtFor(sent, { ...lookupTarget({ phone, expiry_date: expiryIso, opendate, openhow }), id }),
      offsetDays,
    };
    // Only a 요금제 유지 만료 reads the 미결 유지일; 약정 대상 never depends on it.
    const degraded = pendingDegraded && expiry !== null && lookupSource(openhow) === "keepdate";
    out.push(degraded ? { ...result, degraded: true } : result);
  }

  // Most recently opened contract first (opendate desc) — the freshest 개통/재계약
  // on top. opendate is "yy-mm-dd", so a lexical compare orders correctly within
  // the 2000s (same convention as PoncleClient's latest-opendate lookup).
  return out.sort((a, b) => (a.opendate < b.opendate ? 1 : a.opendate > b.opendate ? -1 : 0));
}

/** 조회 milestone stage: 약정 대상 = 약정 만료(term), 유심 등 = 요금제 유지(keepdate). */
function lookupSource(openhow: string): MilestoneSource {
  return isContractType(openhow) ? "term" : "keepdate";
}

/** A DueItem view of a lookup result, so the existing send flow (onSend) works. */
export function lookupToDueItem(r: LookupResult): DueItem {
  return {
    id: r.id,
    phone: r.phone,
    customer: r.customer,
    opendate: r.opendate,
    expiry_date: r.expiry_date,
    milestone_offset: r.offsetDays,
    telecom: r.telecom,
    agency: r.agency,
    openhow: r.openhow,
    plan: r.plan,
    model: r.model,
    staff: r.staff,
    already_sent: !!r.informedAt,
    // 조회에서 발송 시 시점(source)로 템플릿을 고른다: 약정 대상=약정 만료(term/T2),
    // 유심 등=요금제 유지(keepdate/T1). r.status가 대표 만료(computeExpiry) 기준이라 일치.
    source: lookupSource(r.openhow),
    // A 만료 computed without the 미결 유지일 blocks sending like a degraded scan item.
    ...(r.degraded ? { degraded: true } : {}),
  };
}
