/**
 * Async native send outcomes (sent-intent results): applies failures/deliveries to
 * the log and polls while a send from this session has no result yet.
 */
import { ResultPoller } from "../domain/result-poll";
import { ackSendResults, fetchSendResults } from "../native/sms";
import { history, S } from "../app/state";
import { hooks } from "../app/hooks";
import { $, toast } from "../app/dom";
import { reconcileSentFlags } from "../app/sent-state";
import { sendFailureNotice } from "../ui/send-failure";

/* ---------- async send results (native sent-intent outcomes) ---------- */
/** Native send ids returned by Sms.send whose record isn't written yet — a result
 *  for one of these must wait (not be acked) or it would be lost. */
export const INFLIGHT_SMS_IDS = new Set<string>();
/** Ids of 설정 테스트 / 홈 테스트 대상 sends (never recorded) — for a failure toast. */
export const TEST_SMS_IDS = new Set<string>();
let resultsReconciling: Promise<void> | null = null;

/**
 * Drain native send outcomes: a 'fail' marks the matching record failed (so it no
 * longer counts as sent anywhere), an 'ok' marks it delivered. Persist first, then
 * ack (a crash in between just re-applies, idempotently). Runs at boot, on every
 * foreground return, and repeatedly while a send from this session has no result
 * (RESULT_POLLER).
 */
export function reconcileSendResults(): Promise<void> {
  if (resultsReconciling) return resultsReconciling;
  resultsReconciling = (async () => {
    try {
      const results = (await fetchSendResults()).filter((r) => !INFLIGHT_SMS_IDS.has(r.id));
      if (!results.length) return;
      const out = await history.applySendResults(results);
      await ackSendResults(results.map((r) => r.id));
      RESULT_POLLER.settle(results.map((r) => r.id));
      const testFails = results.filter((r) => r.status === "fail" && TEST_SMS_IDS.has(r.id));
      for (const r of results) TEST_SMS_IDS.delete(r.id);
      if (out.failed.length || out.resendFailed.length || out.delivered) {
        await reconcileSentFlags();
        await history.cacheDueList(S.RESULTS);
        hooks.rerenderCurrent();
      }
      // I6: who failed and why; a test failure in the same batch is still mentioned.
      const notice = sendFailureNotice({ failed: out.failed, resendFailed: out.resendFailed, testFails });
      if (notice.testMsg) $("#test-sms-msg").textContent = notice.testMsg;
      if (notice.toast) toast(notice.toast, { err: true });
    } catch {
      /* storage glitch: results stay queued natively and are retried next time */
    } finally {
      resultsReconciling = null;
    }
  })();
  return resultsReconciling;
}

/** Re-checks native results every ~10s (first ~5s after a send) while any send
 *  from this session has no outcome yet, for up to 3 min after the latest send. A
 *  late carrier failure then surfaces while the app stays open in the store,
 *  instead of only on the next foreground return or restart. */
const RESULT_POLLER = new ResultPoller(
  {
    check: () => reconcileSendResults(),
    isVisible: () => document.visibilityState === "visible",
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    now: () => Date.now(),
  },
  { firstMs: 5_000, intervalMs: 10_000, windowMs: 180_000 },
);

/** Poll for this hand-off's outcome until it arrives (or the window ends). */
export function scheduleResultChecks(smsId: string): void {
  RESULT_POLLER.track(smsId);
}
