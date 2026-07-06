/**
 * 고객 조회(lookup) — turn live 개통 rows from a name/phone search into per-customer
 * result cards with a contract-status label. Pure; fetching is done in the app
 * layer via PoncleClient.searchCustomers, sent-history join by the caller.
 *
 * Each phone's LATEST 개통 row is the current contract (same rule as 미방문). A
 * customer with more than one 개통 row has re-signed at least once (재계약 완료).
 */
import { field } from "./due-item";
import { computeExpiry } from "./expiry";
import { dueKey, normalizePhone } from "./keepdate";
import { PlainDate, daysBetween, toIso } from "./plaindate";
import { isContractType } from "./template-match";
import type { AppConfig, DueItem, PoncleRow } from "./types";
import { latestOpenByPhone } from "./unvisited";

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
  offsetDays: number; // days until expiry (>=0), for the {when} placeholder on send
}

/**
 * Contract status for a looked-up customer.
 * - 무약정 (no expiry) -> muted.
 * - expired -> danger "만료 지남 · 미방문 · D+N".
 * - expiring within the window -> warn "곧 만료 · D-N".
 * - active with a prior 개통 (re-signed) -> ok "재계약 완료".
 * - otherwise active -> ok "여유 · 만료 <date>".
 */
export function lookupStatus(
  expiry: PlainDate | null,
  todayD: PlainDate,
  windowDays: number,
  hasPrior: boolean,
): LookupStatus {
  if (expiry === null) return { label: "무약정", tone: "muted" };
  const days = daysBetween(expiry, todayD); // expiry - today
  if (days < 0) return { label: `만료 지남 · 미방문 · D+${-days}`, tone: "danger" };
  if (days <= Math.max(0, windowDays)) return { label: `곧 만료 · D-${days}`, tone: "warn" };
  if (hasPrior) return { label: "재계약 완료", tone: "ok" };
  return { label: `여유 · 만료 ${toIso(expiry)}`, tone: "ok" };
}

/**
 * Build lookup cards from raw search rows. Groups by phone (latest = current),
 * flags re-signed customers, computes status, and joins our alert history.
 */
export function buildLookupResults(
  openRows: PoncleRow[],
  config: AppConfig,
  todayD: PlainDate,
  windowDays: number,
  sentByKey: Map<string, string>,
): LookupResult[] {
  const countByPhone = new Map<string, number>();
  for (const r of openRows) {
    const p = normalizePhone(field(r, "openphone"));
    if (p) countByPhone.set(p, (countByPhone.get(p) ?? 0) + 1);
  }

  const out: LookupResult[] = [];
  for (const [phoneDigits, row] of latestOpenByPhone(openRows)) {
    const expiry = computeExpiry(row, config);
    const hasPrior = (countByPhone.get(phoneDigits) ?? 1) > 1;
    const phone = field(row, "openphone");
    const expiryIso = expiry ? toIso(expiry) : "";
    const id = dueKey(phone, expiryIso);
    // days until expiry (clamped >=0), so an alert's {when} reads "D-N" not "오늘".
    const offsetDays = expiry ? Math.max(0, daysBetween(expiry, todayD)) : 0;
    out.push({
      id,
      phone,
      customer: field(row, "customer"),
      opendate: field(row, "opendate"),
      expiry_date: expiryIso,
      telecom: field(row, "telecomx") || field(row, "telecom"),
      agency: field(row, "agencytitle"),
      model: field(row, "model"),
      plan: field(row, "plan"),
      openhow: field(row, "openhowx"),
      staff: field(row, "membername") || field(row, "username"),
      status: lookupStatus(expiry, todayD, windowDays, hasPrior),
      informedAt: sentByKey.get(id) ?? "",
      offsetDays,
    });
  }

  // Most recently opened contract first (opendate desc) — the freshest 개통/재계약
  // on top. opendate is "yy-mm-dd", so a lexical compare orders correctly within
  // the 2000s (same convention as PoncleClient's latest-opendate lookup).
  return out.sort((a, b) => (a.opendate < b.opendate ? 1 : a.opendate > b.opendate ? -1 : 0));
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
    source: isContractType(r.openhow) ? "term" : "keepdate",
  };
}
