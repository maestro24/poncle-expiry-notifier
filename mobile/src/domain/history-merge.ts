/**
 * Backup-restore merge of send logs (mergeHistory): a union by record key where the
 * stronger record wins. Split out of history.ts; re-exported from there.
 */
import { recordKey, sentStateOf, type SentRecord } from "./sent-record";

/** Rank of a record for merge conflicts: a real send > manual skip > failed send >
 *  practice record. A practice/failed record must never replace a real send. */
function mergeRank(r: SentRecord): number {
  const s = sentStateOf(r);
  return s === "sent" ? 3 : s === "skipped" ? 2 : s === "failed" ? 1 : 0;
}

/**
 * A failed record is the LATER outcome of an unconfirmed send: the same native send
 * (sms_id), or one at/after it (a backup taken before the failure result arrived
 * carries the send without its outcome). A confirmed delivery is never overridden.
 */
function failureSupersedes(failed: SentRecord, sent: SentRecord): boolean {
  if (sentStateOf(failed) !== "failed" || sentStateOf(sent) !== "sent") return false;
  if (sent.delivery === "delivered") return false;
  if (failed.sms_id && failed.sms_id === sent.sms_id) return true;
  return (failed.sent_at || "") >= (sent.sent_at || "");
}

/** Whether `r` should replace `cur` for the same customer in a merge. */
function mergeWins(r: SentRecord, cur: SentRecord): boolean {
  if (failureSupersedes(r, cur)) return true;
  if (failureSupersedes(cur, r)) return false;
  const a = mergeRank(r);
  const b = mergeRank(cur);
  return a > b || (a === b && (r.sent_at || "") > (cur.sent_at || ""));
}

/**
 * Restore as a UNION by record key (recordKey: phone|expiry, manual sends apart):
 * every current customer stays, the backup's are added, and for a customer in both
 * the stronger record wins (real send > skip > failed > practice; equal rank ->
 * newer sent_at; full tie -> the current one) — except that a failure outcome of
 * the same (or an older, unconfirmed) send beats that send, so restoring an older
 * backup never hides a failed SMS as 'sent'. Pure: returns a new array.
 */
export function mergeHistory(existing: readonly SentRecord[], incoming: readonly SentRecord[]): SentRecord[] {
  const byKey = new Map<string, SentRecord>();
  const consider = (r: SentRecord): void => {
    const k = recordKey(r);
    const cur = byKey.get(k);
    if (!cur || mergeWins(r, cur)) byKey.set(k, r);
  };
  for (const r of existing) consider(r);
  for (const r of incoming) consider(r);
  return Array.from(byKey.values());
}

/** Outcome of History.mergeRestore: `added` = customers (record keys) the backup
 *  brought that this phone did not have; `kept` = the rest of the merged log. */
export interface MergeRestoreResult {
  added: number;
  kept: number;
}
