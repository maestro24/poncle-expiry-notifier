import { describe, expect, it } from "vitest";
import { carrierBreakdown, sentTrend } from "../src/domain/dashboard";
import { makeDate } from "../src/domain/plaindate";

const TODAY = makeDate(2026, 7, 3);

describe("sentTrend", () => {
  const rec = (date: string, channel = "sms") => ({ sent_at: `${date}T09:00:00`, channel });

  it("returns `days` buckets oldest→newest, counting non-skipped sends per day", () => {
    const rows = [
      rec("2026-07-03"), rec("2026-07-03"), // 2 today
      rec("2026-07-01"),                    // 1
      rec("2026-06-27", "skipped"),         // excluded (skip)
      rec("2026-05-01"),                    // outside 7-day window
    ];
    const t = sentTrend(rows, TODAY, 7);
    expect(t.length).toBe(7);
    expect(t[t.length - 1].dateIso).toBe("2026-07-03");
    expect(t[0].dateIso).toBe("2026-06-27");
    const byDate = Object.fromEntries(t.map((d) => [d.dateIso, d.count]));
    expect(byDate["2026-07-03"]).toBe(2);
    expect(byDate["2026-07-01"]).toBe(1);
    expect(byDate["2026-06-27"]).toBe(0); // the only 06-27 record was skipped
    expect(t.every((d) => typeof d.dayLabel === "string" && d.dayLabel.length === 1)).toBe(true);
  });

  it("empty history -> all zeros", () => {
    expect(sentTrend([], TODAY, 7).map((d) => d.count)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("carrierBreakdown", () => {
  it("counts by telecom, largest first, blank -> 미상", () => {
    const out = carrierBreakdown([
      { telecom: "KT" }, { telecom: "KT" }, { telecom: "SK텔레콤" }, { telecom: "" },
    ]);
    expect(out).toEqual([
      { name: "KT", count: 2 },
      { name: "SK텔레콤", count: 1 },
      { name: "미상", count: 1 },
    ]);
  });
  it("respects the limit", () => {
    const items = [{ telecom: "A" }, { telecom: "B" }, { telecom: "C" }, { telecom: "D" }];
    expect(carrierBreakdown(items, 2).length).toBe(2);
  });
});
