/**
 * Stale scan cache (audit 1-13 / 1-32): a cached due list must show today's D-day,
 * drop already-expired rows, and say when it's from an earlier day.
 */
import { describe, expect, it } from "vitest";
import { refreshDueOffsets, staleScanNotice, staleSendWarning } from "../src/domain/due-item";
import { daysUntil, makeDate } from "../src/domain/plaindate";
import type { DueItem } from "../src/domain/types";

const due = (expiry: string, offset: number, over: Partial<DueItem> = {}): DueItem => ({
  id: `010|${expiry}`, phone: "010", customer: "", opendate: "", expiry_date: expiry,
  milestone_offset: offset, telecom: "", agency: "", openhow: "", plan: "", model: "", staff: "",
  already_sent: false, source: "term", ...over,
});

describe("daysUntil", () => {
  it("expiry - today in whole days (negative once past)", () => {
    const t = makeDate(2026, 11, 16);
    expect(daysUntil("2026-11-16", t)).toBe(0);
    expect(daysUntil("2026-11-19", t)).toBe(3);
    expect(daysUntil("2026-07-07", t)).toBe(-132);
    expect(daysUntil("2027-01-01", t)).toBe(46); // across a year boundary
  });
  it("invalid input -> null", () => {
    const t = makeDate(2026, 11, 16);
    expect(daysUntil("", t)).toBeNull();
    expect(daysUntil("2026-13-40", t)).toBeNull();
    expect(daysUntil("abc", t)).toBeNull();
  });
});

describe("refreshDueOffsets", () => {
  it("recomputes milestone_offset from expiry vs today", () => {
    const out = refreshDueOffsets([due("2026-07-10", 7)], makeDate(2026, 7, 8));
    expect(out[0].milestone_offset).toBe(2);
  });
  it("drops rows whose expiry already passed (they belong to 미방문)", () => {
    const out = refreshDueOffsets(
      [due("2026-07-07", 0), due("2026-11-20", 130)],
      makeDate(2026, 11, 16),
    );
    expect(out.map((r) => r.expiry_date)).toEqual(["2026-11-20"]);
    expect(out[0].milestone_offset).toBe(4);
  });
  it("does not mutate the input items", () => {
    const item = due("2026-07-10", 7);
    refreshDueOffsets([item], makeDate(2026, 7, 8));
    expect(item.milestone_offset).toBe(7);
  });
  it("keeps rows with an unparseable expiry untouched", () => {
    const item = due("", 3);
    expect(refreshDueOffsets([item], makeDate(2026, 7, 8))).toEqual([item]);
  });
});

describe("staleScanNotice", () => {
  const t = makeDate(2026, 11, 16);
  it("null when the cache is from today", () => {
    expect(staleScanNotice("2026-11-16", t, 3)).toBeNull();
  });
  it("names the scan day when the cache is from an earlier day", () => {
    expect(staleScanNotice("2026-07-07", t, 3)).toBe("7월 7일 스캔 결과입니다 — 지금 다시 스캔하세요");
  });
  it("unknown scan date (pre-upgrade cache) with rows -> generic notice", () => {
    expect(staleScanNotice("", t, 2)).toBe("이전에 저장된 스캔 결과입니다 — 지금 다시 스캔하세요");
  });
  it("never scanned -> no notice; an old EMPTY scan is still stale", () => {
    expect(staleScanNotice("", t, 0)).toBeNull();
    expect(staleScanNotice("2026-07-07", t, 0)).toBe("7월 7일 스캔 결과입니다 — 지금 다시 스캔하세요");
  });
});

describe("staleSendWarning (send from an old list needs an explicit confirm)", () => {
  const t = makeDate(2026, 11, 16);
  it("null for today's scan (send without an extra prompt)", () => {
    expect(staleSendWarning("2026-11-16", t)).toBeNull();
  });
  it("names the scan day and asks before sending", () => {
    const w = staleSendWarning("2026-07-07", t)!;
    expect(w).toContain("7월 7일 스캔 결과입니다");
    expect(w).toContain("그래도 보낼까요?");
  });
  it("unknown scan date (pre-upgrade cache) -> generic warning", () => {
    const w = staleSendWarning("", t)!;
    expect(w).toContain("이전에 저장된 스캔 결과입니다");
    expect(w).toContain("그래도 보낼까요?");
  });
});
