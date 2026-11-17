/**
 * The stored send record (SentRecord) and its pure helpers: send state, record
 * identity, first-send/send-count stats and the 재발송 prev_sent backup chain.
 * Split out of history.ts; re-exported from there.
 */
import { dueKey } from "./keepdate";
import type { RecordSource, SentState } from "./types";

export interface SentRecord {
  phone: string;
  customer: string;
  opendate: string;
  expiry_date: string;
  milestone_offset: number;
  telecom: string;
  agency: string;
  plan: string;
  model: string;
  openhow: string;
  staff: string;
  channel: string; // "sms" | "record-only" | "skipped"
  sent_at: string; // ISO local datetime
  body?: string; // the actual message text sent (empty for skips)
  /** Native send id (Sms.send result) used to match the async send result. */
  sms_id?: string;
  /** Async send outcome reported by the native layer. Absent on old records and
   *  until the result arrives — absent counts as sent (migration-safe). */
  delivery?: "delivered" | "failed";
  /** Native failure reason (Korean) when delivery === "failed". */
  fail_reason?: string;
  /** 재발송 over a counted send: the earlier send, restored if this one fails, so
   *  a failed resend never erases a real send (customer would re-surface as unsent). */
  prev_sent?: PrevSend;
  /** Reason the latest 재발송 failed (the record was reverted to the earlier send). */
  resend_fail_reason?: string;
  /** Which milestone the record was for (요금제 유지 1단계 vs 약정 만료 2단계), or
   *  "manual" for a 직접 입력 send outside any milestone (never satisfies one — audit
   *  B1). Absent on records written before v1.2.17 — then inferred (see inferSource). */
  source?: RecordSource;
  /** sent_at of the FIRST counted send of this customer milestone, kept across
   *  재발송 (audit 3-15). Stored only when it differs from what the record alone
   *  implies (see sendStats) — absent on single sends and pre-v1.2.17 records. */
  first_sent_at?: string;
  /** Number of counted (not failed) SMS sends to this customer milestone. Same
   *  storage rule as first_sent_at. */
  send_count?: number;
}

/** First counted send + number of counted sends behind one record. */
export interface SendStats {
  /** ISO datetime of the first counted send ("" when none). */
  first: string;
  count: number;
}

/** What a record implies on its own: one send when it is a counted SMS. */
function impliedStats(rec: SentRecord): SendStats {
  return countsAsSent(rec) ? { first: rec.sent_at, count: 1 } : { first: "", count: 0 };
}

/** The record's send stats: its stored first_sent_at/send_count, else derived from
 *  the record itself (migration-safe for records written before these fields). */
export function sendStats(rec: SentRecord): SendStats {
  const implied = impliedStats(rec);
  const count = typeof rec.send_count === "number" && Number.isInteger(rec.send_count) && rec.send_count >= 0
    ? rec.send_count
    : implied.count;
  if (count === 0) return { first: "", count: 0 };
  return { first: rec.first_sent_at || implied.first || rec.sent_at, count };
}

/** `rec` carrying `stats`, storing the fields only where they differ from what the
 *  record alone implies (so a plain single send keeps its old shape). Pure. */
export function withSendStats(rec: SentRecord, stats: SendStats): SentRecord {
  const { first_sent_at: _f, send_count: _c, ...base } = rec;
  const count = Math.max(0, stats.count);
  const first = count > 0 ? stats.first : "";
  const implied = impliedStats(base);
  if (implied.count === count && implied.first === first) return base;
  return { ...base, first_sent_at: first, send_count: count };
}

/** 이력 detail line, e.g. '최초 발송 2026-06-01 · 3회'; "" when never really sent. */
export function sendSummaryLabel(rec: SentRecord): string {
  const { first, count } = sendStats(rec);
  return count > 0 ? `최초 발송 ${first.slice(0, 10)} · ${count}회` : "";
}

/** Validate untrusted (backup-file) first_sent_at/send_count; only well-formed
 *  values are returned (spread the result into a sanitized record). */
export function sanitizeSendStats(raw: unknown): Pick<SentRecord, "first_sent_at" | "send_count"> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Pick<SentRecord, "first_sent_at" | "send_count"> = {};
  if (typeof r.first_sent_at === "string" && r.first_sent_at) out.first_sent_at = r.first_sent_at;
  if (typeof r.send_count === "number" && Number.isInteger(r.send_count) && r.send_count >= 0) out.send_count = r.send_count;
  return out;
}

/** The send-identifying part of an earlier counted send kept by a 재발송. Nested
 *  only while the earlier send itself is still awaiting its result. */
export interface PrevSend {
  sent_at: string;
  body?: string;
  sms_id?: string;
  delivery?: "delivered";
  prev_sent?: PrevSend;
}

/** Deepest chain of not-yet-confirmed resends kept (bounds record growth). */
const MAX_PREV_DEPTH = 3;

function snapshotPrev(rec: Pick<SentRecord, "sent_at" | "body" | "sms_id" | "delivery" | "prev_sent">, depth = 1): PrevSend {
  const snap: PrevSend = { sent_at: rec.sent_at };
  if (rec.body !== undefined) snap.body = rec.body;
  if (rec.sms_id) snap.sms_id = rec.sms_id;
  if (rec.delivery === "delivered") snap.delivery = "delivered";
  // A confirmed delivery is final evidence; only an unconfirmed send needs the
  // older one behind it (it may still fail too).
  else if (rec.prev_sent && depth < MAX_PREV_DEPTH) snap.prev_sent = snapshotPrev(rec.prev_sent, depth + 1);
  return snap;
}

/** For a 재발송: attach the earlier record as `prev_sent` when it is a counted
 *  (real, not failed) send, so a failure of the new send can revert to it. */
export function withResendBackup(next: SentRecord, prev: SentRecord | null | undefined): SentRecord {
  const { prev_sent: _p, resend_fail_reason: _r, ...base } = next;
  if (!prev || !countsAsSent(prev)) return base;
  return { ...base, prev_sent: snapshotPrev(prev) };
}

/** The record as it was before a failed 재발송 (identity/customer fields kept). */
export function revertToPrev(rec: SentRecord, prev: PrevSend, reason: string): SentRecord {
  const {
    prev_sent: _p, body: _b, sms_id: _s, delivery: _d, fail_reason: _f, resend_fail_reason: _r,
    ...base
  } = rec;
  const out: SentRecord = { ...base, sent_at: prev.sent_at, resend_fail_reason: reason };
  if (prev.body !== undefined) out.body = prev.body;
  if (prev.sms_id) out.sms_id = prev.sms_id;
  if (prev.delivery) out.delivery = prev.delivery;
  if (prev.prev_sent) out.prev_sent = prev.prev_sent;
  // The failed resend no longer counts; the first send is unchanged.
  const stats = sendStats(rec);
  return withSendStats(out, { first: stats.first, count: Math.max(1, stats.count - 1) });
}

/** `next` replacing `prev` (same customer milestone): the earlier sends stay counted
 *  and the first send date is kept; `next` adds one send when it is a counted SMS. */
export function carrySendStats(next: SentRecord, prev: SentRecord): SentRecord {
  const before = sendStats(prev);
  const own = impliedStats(next);
  return withSendStats(next, { first: before.first || own.first, count: before.count + own.count });
}

/** Validate an untrusted (backup-file) prev_sent; undefined when malformed. */
export function sanitizePrevSend(raw: unknown, depth = 1): PrevSend | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.sent_at !== "string" || !r.sent_at) return undefined;
  const out: PrevSend = { sent_at: r.sent_at };
  if (typeof r.body === "string") out.body = r.body;
  if (typeof r.sms_id === "string" && r.sms_id) out.sms_id = r.sms_id;
  if (r.delivery === "delivered") out.delivery = "delivered";
  if (depth < MAX_PREV_DEPTH) {
    const inner = sanitizePrevSend(r.prev_sent, depth + 1);
    if (inner) out.prev_sent = inner;
  }
  return out;
}

/** The send state a stored record represents (see SentState). */
export function sentStateOf(rec: SentRecord | null | undefined): SentState {
  if (!rec) return "none";
  if (rec.channel === "sms") return rec.delivery === "failed" ? "failed" : "sent";
  if (rec.channel === "skipped") return "skipped";
  return "recorded"; // record-only (and any coerced unknown channel)
}

/** True only for a real SMS that was not reported failed. */
export function countsAsSent(rec: SentRecord): boolean {
  return sentStateOf(rec) === "sent";
}

/** True when the customer needs no further alert: a real send or a manual skip. */
export function countsAsHandled(rec: SentRecord): boolean {
  const s = sentStateOf(rec);
  return s === "sent" || s === "skipped";
}

/** A 직접 입력 send outside any milestone (조회 '여유' 고객). It never satisfies a
 *  milestone — neither by exact key nor by the contract fallback (audit B1). */
export function isManualRecord(rec: Pick<SentRecord, "source">): boolean {
  return rec.source === "manual";
}

/**
 * A stored record's identity: normalized phone|expiry for a milestone record, plus
 * "|manual" for a manual one — so a manual send and the same customer's later
 * milestone send (whose expiry can coincide) are kept as separate records and never
 * replace (or carry send counts into) each other. Backup merge uses the same key.
 */
export function recordKey(rec: Pick<SentRecord, "phone" | "expiry_date" | "source">): string {
  const k = dueKey(rec.phone, rec.expiry_date);
  return isManualRecord(rec) ? `${k}|manual` : k;
}
