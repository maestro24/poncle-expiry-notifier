/**
 * Async native SMS send results (Sms.getSendResults): payload validation and the
 * pure application of results to stored records, including the 재발송 prev_sent
 * chain. History.applySendResults persists what applySendResultsToRows computes.
 * Split out of history.ts; re-exported from there.
 */
import {
  countsAsSent,
  revertToPrev,
  sendStats,
  withSendStats,
  type PrevSend,
  type SentRecord,
} from "./sent-record";

/** One async SMS send outcome from the native layer (Sms.getSendResults). */
export interface SmsSendResult {
  id: string;
  status: "ok" | "fail";
  reason?: string;
  at: string;
}

/** Outcome of applying native send results to the stored records. */
export interface ApplyResultsOutcome {
  /** Records now marked failed (need a resend). */
  failed: SentRecord[];
  /** 재발송s that failed and were reverted to the earlier counted send (still handled). */
  resendFailed: SentRecord[];
  /** Number of records newly marked delivered. */
  delivered: number;
  /** Result ids that matched no stored record (test sends, superseded sends). */
  unmatched: string[];
}

/** Validate the untrusted native getSendResults payload into SmsSendResult[]. */
export function parseSendResults(raw: unknown): SmsSendResult[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { results?: unknown }).results;
  if (!Array.isArray(list)) return [];
  const out: SmsSendResult[] = [];
  for (const r of list) {
    if (typeof r !== "object" || r === null) continue;
    const { id, status, reason, at } = r as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    if (status !== "ok" && status !== "fail") continue;
    const item: SmsSendResult = { id, status, at: typeof at === "string" ? at : "" };
    if (typeof reason === "string" && reason) item.reason = reason;
    out.push(item);
  }
  return out;
}

/** The native send ids of a prev_sent chain (newest first). */
function chainIds(prev: PrevSend | undefined): string[] {
  const out: string[] = [];
  for (let p = prev; p; p = p.prev_sent) if (p.sms_id) out.push(p.sms_id);
  return out;
}

function chainSentAts(prev: PrevSend | undefined): string[] {
  const out: string[] = [];
  for (let p = prev; p; p = p.prev_sent) out.push(p.sent_at);
  return out;
}

/** The chain without the send `id` (its older sends re-attached in its place), plus
 *  the removed entry; null when `id` is not in the chain. Pure. */
function dropFromChain(prev: PrevSend | undefined, id: string): { chain: PrevSend | undefined; removed: PrevSend } | null {
  if (!prev) return null;
  if (prev.sms_id === id) return { chain: prev.prev_sent, removed: prev };
  const inner = dropFromChain(prev.prev_sent, id);
  if (!inner) return null;
  const { prev_sent: _p, ...head } = prev;
  return { chain: inner.chain ? { ...head, prev_sent: inner.chain } : head, removed: inner.removed };
}

/** The chain with the send `id` confirmed delivered (a confirmed send needs nothing
 *  older behind it); null when `id` is not in the chain. Pure. */
function confirmInChain(prev: PrevSend | undefined, id: string): PrevSend | null {
  if (!prev) return null;
  if (prev.sms_id === id) {
    const { prev_sent: _p, ...head } = prev;
    return { ...head, delivery: "delivered" };
  }
  const inner = confirmInChain(prev.prev_sent, id);
  return inner ? { ...prev, prev_sent: inner } : null;
}

/** `rec` after an EARLIER send of its 재발송 chain failed (audit B5): that send leaves
 *  the chain and no longer counts; the first-send date moves on if it was the first. */
function withoutFailedPrev(rec: SentRecord, drop: { chain: PrevSend | undefined; removed: PrevSend }): SentRecord {
  const { prev_sent: _p, ...base } = rec;
  const out: SentRecord = drop.chain ? { ...base, prev_sent: drop.chain } : base;
  const stats = sendStats(rec);
  const own = countsAsSent(rec) ? 1 : 0;
  let first = stats.first;
  if (first === drop.removed.sent_at) {
    const left = chainSentAts(drop.chain);
    if (own) left.push(rec.sent_at);
    first = left.filter((d) => !!d).sort()[0] ?? "";
  }
  return withSendStats(out, { first, count: Math.max(own, stats.count - 1) });
}

/** Records after applying send results, whether anything changed (needs a write),
 *  and the outcome reported to the caller. */
export interface AppliedSendResults {
  next: SentRecord[];
  changed: boolean;
  outcome: ApplyResultsOutcome;
}

/** Apply native send results to `rows` (see History.applySendResults). Pure. */
export function applySendResultsToRows(rows: readonly SentRecord[], results: readonly SmsSendResult[]): AppliedSendResults {
  const byId = new Map(results.map((r) => [r.id, r]));
  const matched = new Set<string>();
  const failed: SentRecord[] = [];
  const resendFailed: SentRecord[] = [];
  let delivered = 0;
  let changed = false;
  const next = rows.map((stored) => {
    // Earlier sends of a 재발송 chain first, so a same-batch failure of the
    // latest send already sees what is left behind it.
    let rec = stored;
    for (const id of chainIds(rec.prev_sent)) {
      const r = byId.get(id);
      if (!r || id === rec.sms_id) continue;
      if (r.status === "fail") {
        const drop = dropFromChain(rec.prev_sent, id);
        if (!drop) continue;
        matched.add(id);
        rec = withoutFailedPrev(rec, drop);
        changed = true;
      } else {
        const chain = confirmInChain(rec.prev_sent, id);
        if (!chain) continue;
        matched.add(id);
        if (JSON.stringify(chain) !== JSON.stringify(rec.prev_sent)) {
          rec = { ...rec, prev_sent: chain };
          changed = true;
        }
      }
    }
    const res = rec.sms_id ? byId.get(rec.sms_id) : undefined;
    if (!res) return rec;
    matched.add(res.id);
    const reason = res.reason || "발송 실패";
    if (res.status === "fail" && rec.prev_sent) {
      // A failed 재발송 must not erase the earlier real send: revert to it.
      const upd = revertToPrev(rec, rec.prev_sent, reason);
      resendFailed.push(upd);
      changed = true;
      return upd;
    }
    if (res.status === "fail") {
      // Only a TRANSITION to failed is reported (a re-applied result for an
      // already-failed record must not raise a second '발송 실패' toast).
      if (rec.delivery === "failed") return rec;
      const stats = sendStats(rec); // the failed send no longer counts
      const upd: SentRecord = withSendStats(
        { ...rec, delivery: "failed", fail_reason: reason },
        { first: stats.first, count: stats.count - 1 },
      );
      failed.push(upd);
      changed = true;
      return upd;
    }
    if (rec.delivery === "delivered" && !rec.prev_sent) return rec;
    if (rec.delivery !== "delivered") delivered++;
    changed = true;
    const { prev_sent: _p, ...ok } = rec; // confirmed: the backup is no longer needed
    return { ...ok, delivery: "delivered" as const };
  });
  const unmatched = results.map((r) => r.id).filter((id) => !matched.has(id));
  return { next, changed, outcome: { failed, resendFailed, delivered, unmatched } };
}
