/**
 * Late carrier failures (review: #2 only partly fixed): while any send this session
 * has no final native result, keep re-checking (not just at ~5s/~30s), bounded by a
 * window so a result that never comes can't poll forever.
 */
import { describe, expect, it } from "vitest";
import { ResultPoller } from "../src/domain/result-poll";

function harness(visible = true) {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const state = { visible, checks: 0 };
  const poller = new ResultPoller(
    {
      check: async () => { state.checks++; },
      isVisible: () => state.visible,
      setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); },
      now: () => t,
    },
    { firstMs: 5_000, intervalMs: 10_000, windowMs: 180_000 },
  );
  /** Advance the fake clock, firing due timers in order (and awaiting their checks). */
  async function advance(ms: number): Promise<void> {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    t = end;
  }
  return { poller, state, advance, timers };
}

describe("ResultPoller", () => {
  it("keeps checking past 30s while a send has no result", async () => {
    const h = harness();
    h.poller.track("s1");
    await h.advance(5_000);
    expect(h.state.checks).toBe(1);
    await h.advance(60_000); // 15s, 25s, ... 65s
    expect(h.state.checks).toBe(7);
  });

  it("stops once every tracked send has a result", async () => {
    const h = harness();
    h.poller.track("s1");
    await h.advance(5_000);
    h.poller.settle(["s1"]);
    await h.advance(60_000);
    expect(h.state.checks).toBe(1);
    expect(h.poller.pending).toBe(0);
  });

  it("gives up after the window (a result that never arrives)", async () => {
    const h = harness();
    h.poller.track("s1");
    await h.advance(600_000);
    const n = h.state.checks;
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThanOrEqual(19);
    await h.advance(600_000);
    expect(h.state.checks).toBe(n);
    expect(h.timers.length).toBe(0);
  });

  it("a later send extends the window; one loop only (no duplicate timers)", async () => {
    const h = harness();
    h.poller.track("s1");
    await h.advance(100_000);
    h.poller.track("s2");
    expect(h.timers.length).toBe(1);
    await h.advance(150_000); // past s1's window, inside s2's
    const n = h.state.checks;
    await h.advance(20_000);
    expect(h.state.checks).toBeGreaterThan(n);
  });

  it("skips the check while backgrounded (foreground return reconciles) but keeps the loop", async () => {
    const h = harness(false);
    h.poller.track("s1");
    await h.advance(30_000);
    expect(h.state.checks).toBe(0);
    h.state.visible = true;
    await h.advance(10_000);
    expect(h.state.checks).toBe(1);
  });

  it("ignores empty ids", () => {
    const h = harness();
    h.poller.track("");
    expect(h.poller.pending).toBe(0);
    expect(h.timers.length).toBe(0);
  });
});
