/**
 * Send-state matching over the sent log: milestone stage inference (inferSource)
 * and the SentIndex snapshot (exact phone|expiry key + same-contract fallback).
 * Split out of history.ts; re-exported from there.
 */
import { contractTermMonths, keepdateDefaultMonths, parseOpendate } from "./expiry";
import { dueKey, normalizePhone } from "./keepdate";
import { addMonths, daysBetween, parseIso, toIso } from "./plaindate";
import { countsAsHandled, countsAsSent, isManualRecord, sentStateOf, type SentRecord } from "./sent-record";
import { isContractType } from "./template-match";
import type { AppConfig, MilestoneSource, SentMatchTarget, SentState } from "./types";

/** The configured months of both stages (요금제 유지 기본 개월 / 약정 개월), which
 *  decide a legacy record's stage. Missing fields use the app defaults. */
export type StageConfig = Partial<Pick<AppConfig, "keepdate_default_months" | "default_term_months">>;

/**
 * The milestone stage of a record / item: its explicit `source`, else a non-contract
 * 개통유형 (유심 등 -> only 1단계), else (legacy records without `source`) the stage
 * whose CONFIGURED months put its milestone closest to the record's expiry — a
 * fixed 개통→만료 gap would misclassify a 1단계 once 요금제 유지 기본 개월 is set to
 * 9+ (audit 1-29). "" when undeterminable (unknown opendate/expiry, or both stages
 * equally close), which disables the contract fallback for it (exact key only).
 */
export function inferSource(t: SentMatchTarget, cfg: StageConfig = {}): MilestoneSource | "" {
  if (t.source === "manual") return ""; // not a milestone
  if (t.source === "keepdate" || t.source === "term") return t.source;
  const how = String(t.openhow ?? "").trim();
  if (how && !isContractType(how)) return "keepdate";
  const open = parseOpendate(String(t.opendate ?? ""));
  const exp = parseIso(String(t.expiry_date ?? ""));
  if (!open || !exp) return "";
  const full = cfg as AppConfig; // the month helpers default any missing field
  const toKeep = Math.abs(daysBetween(exp, addMonths(open, keepdateDefaultMonths(full))));
  const toTerm = Math.abs(daysBetween(exp, addMonths(open, contractTermMonths(full))));
  if (toKeep === toTerm) return "";
  return toKeep < toTerm ? "keepdate" : "term";
}

/** phone|opendate|stage — one contract's one milestone, independent of how its
 *  expiry was computed. null when any part is unknown. */
function contractKey(t: SentMatchTarget, cfg: StageConfig): string | null {
  const phone = normalizePhone(t.phone);
  const open = parseOpendate(String(t.opendate ?? ""));
  const src = inferSource(t, cfg);
  if (!phone || !open || !src) return null;
  return `${phone}|${toIso(open)}|${src}`;
}

/** Strongest record among candidates: handled first, then the newest send. */
function pickBest(recs: readonly SentRecord[], pred: (r: SentRecord) => boolean): SentRecord | undefined {
  let best: SentRecord | undefined;
  for (const r of recs) {
    if (!pred(r)) continue;
    if (!best || (r.sent_at || "") > (best.sent_at || "")) best = r;
  }
  return best;
}

/**
 * Snapshot index over the sent log for send-state matching (audit 1-29, 1-9/1-10,
 * 1-30). A target matches its exact normalized phone|expiry record first; when that
 * is missing or not handled, a record of the SAME contract (phone + opendate) and
 * stage (source) still matches — so changing 약정 개월, a degraded scan's 개통+기본
 * 개월 date, or a 유지일 vs 개통+6개월 key never makes an alerted customer look unsent.
 * Keys are unchanged (backward compatible); the fallback only adds matches.
 */
export class SentIndex {
  private readonly byKey = new Map<string, SentRecord>();
  private readonly byContract = new Map<string, SentRecord[]>();
  /** Newest counted (real, not failed) send per digits phone — ANY record, manual too. */
  private readonly latestByPhone = new Map<string, string>();

  /** `cfg` supplies the stage months used to classify legacy (source-less) records;
   *  pass the app config so a changed 기본 개월/약정 개월 is honored. Manual records
   *  are left out of every milestone match (audit B1) — only latestSentAt sees them. */
  constructor(records: readonly SentRecord[], private readonly cfg: StageConfig = {}) {
    for (const r of records) {
      if (countsAsSent(r)) {
        const p = normalizePhone(r.phone);
        const at = r.sent_at || "";
        if (p && at > (this.latestByPhone.get(p) ?? "")) this.latestByPhone.set(p, at);
      }
      if (isManualRecord(r)) continue;
      this.byKey.set(dueKey(r.phone, r.expiry_date), r); // last wins (as recordsByKey)
      const ck = contractKey(r, cfg);
      if (ck) this.byContract.set(ck, [...(this.byContract.get(ck) ?? []), r]);
    }
  }

  /** Exact-key handled membership — drop-in for the old dedupKeySet Set. */
  has(key: string): boolean {
    const r = this.byKey.get(key);
    return !!r && countsAsHandled(r);
  }

  /** Exact keys that are handled (real send or skip), like History.dedupKeySet. */
  keySet(): Set<string> {
    const out = new Set<string>();
    for (const [k, r] of this.byKey) if (countsAsHandled(r)) out.add(k);
    return out;
  }

  /** Exact keys of REAL sends only (sms, not reported failed) — the 재방문 코호트's
   *  'informed' set. Skips / record-only / failed are not informing the customer. */
  sentKeySet(): Set<string> {
    const out = new Set<string>();
    for (const [k, r] of this.byKey) if (countsAsSent(r)) out.add(k);
    return out;
  }

  /** Exact keys whose deciding record is a send reported FAILED — the 재방문 코호트
   *  lowers 'informed' for them unless a real send exists (audit L6). */
  failedKeySet(): Set<string> {
    const out = new Set<string>();
    for (const [k, r] of this.byKey) if (sentStateOf(r) === "failed") out.add(k);
    return out;
  }

  /** The real-send records (one per exact key), for the cohort's early re-contract
   *  detection. */
  sentRecords(): SentRecord[] {
    return Array.from(this.byKey.values()).filter(countsAsSent);
  }

  /** The record that decides this target's state (exact, else same contract+stage). */
  recordFor(t: SentMatchTarget): SentRecord | undefined {
    const exact = this.byKey.get(dueKey(t.phone, t.expiry_date));
    if (exact && countsAsHandled(exact)) return exact;
    const ck = contractKey(t, this.cfg);
    const same = ck ? this.byContract.get(ck) ?? [] : [];
    return pickBest(same, countsAsHandled) ?? exact ?? pickBest(same, () => true);
  }

  stateOf(t: SentMatchTarget): SentState {
    return sentStateOf(this.recordFor(t));
  }

  /** Handled = a real (not failed) SMS or a manual skip. */
  isHandled(t: SentMatchTarget): boolean {
    const s = this.stateOf(t);
    return s === "sent" || s === "skipped";
  }

  /** sent_at of the real (counted) send for this target, "" if none (조회 '안내함'). */
  sentAt(t: SentMatchTarget): string {
    const exact = this.byKey.get(dueKey(t.phone, t.expiry_date));
    if (exact && countsAsSent(exact)) return exact.sent_at;
    const ck = contractKey(t, this.cfg);
    return (ck && pickBest(this.byContract.get(ck) ?? [], countsAsSent)?.sent_at) || "";
  }

  /** sent_at of the newest real (counted) send to this phone across EVERY record —
   *  1단계 (keepdate), 2단계 (term) and manual — "" if none. The 조회 '안내 이력'
   *  (audit B11): what this customer last received from us, whatever it was for. */
  latestSentAt(phone: string): string {
    return this.latestByPhone.get(normalizePhone(phone)) ?? "";
  }
}
