/**
 * Re-derives the home list's send state from the sent log (serialized).
 */
import { sortDueItems } from "../domain/due-item";
import { history, S } from "./state";

/** Recompute S.RESULTS[].already_sent from the live sent-log (phone|expiry), so the
 *  home list + cache never diverge from history after a boot-restore or a failed
 *  send (keyed off the log, not a possibly-stale captured object). */
let reconcileChain: Promise<void> = Promise.resolve();
export function reconcileSentFlags(): Promise<void> {
  // Serialized: two overlapping runs (a send's markHandled + a scan's S.RESULTS swap)
  // could otherwise apply an OLDER log snapshot last and drop a fresh send's mark.
  const run = reconcileChain.then(async () => {
    // SentIndex: the exact phone|expiry record, else a send of the SAME contract and
    // stage under a differently computed expiry (약정 개월 변경, 유지일 vs 기본 개월).
    const idx = await history.sentIndex(S.CFG);
    // Re-sorted after re-flagging (#52): unsent first, most urgent (overdue) on top,
    // so a just-sent row drops below the customers still waiting.
    S.RESULTS = sortDueItems(S.RESULTS.map((r) => {
      if (r.test) return r; // test rows are never recorded
      const state = idx.stateOf(r);
      // Only a real (not failed) send or a manual skip is 'handled'. Practice records
      // and failed sends stay sendable, with their own badge.
      return { ...r, sent_state: state, already_sent: state === "sent" || state === "skipped" };
    }));
  });
  reconcileChain = run.catch(() => undefined);
  return run;
}
