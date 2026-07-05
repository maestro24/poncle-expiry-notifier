import { describe, expect, it } from "vitest";
import {
  candidateOpenDateBounds,
  computeExpiry,
  contractTermMonths,
  isStandardOpenType,
  keepdateDefaultMonths,
  lookAheadDays,
  milestoneDue,
  monthsSinceOpen,
  parseOpendate,
  scanOpenDateBounds,
  unvisitedFloor,
} from "../src/domain/expiry";
import { DEFAULTS } from "../src/domain/config";
import { addDays, addMonths, makeDate, toIso } from "../src/domain/plaindate";
import type { AppConfig } from "../src/domain/types";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULTS, ...over };
}
const CFG = cfg({ notify_offsets_days: [0] });
const STD = { openhowx: "기변" };
const iso = (d: Date | null) => (d === null ? null : toIso(d));

describe("parseOpendate", () => {
  it("two-digit year", () => expect(iso(parseOpendate("24-06-15"))).toBe("2024-06-15"));
  it("four-digit year", () => expect(iso(parseOpendate("2024-06-15"))).toBe("2024-06-15"));
  it("bad input", () => {
    expect(parseOpendate("")).toBeNull();
    expect(parseOpendate("nope")).toBeNull();
    expect(parseOpendate("24-13-40")).toBeNull();
  });
});

describe("computeExpiry (month clamp)", () => {
  it("plain 24 months (약정 대상)", () => {
    expect(iso(computeExpiry({ opendate: "24-06-15", ...STD }, CFG))).toBe("2026-06-15");
  });
  it("leap clamp: Jan 31 + 1mo -> Feb 29 (2024)", () => {
    expect(iso(computeExpiry({ opendate: "24-01-31", ...STD }, cfg({ default_term_months: 1 })))).toBe("2024-02-29");
  });
  it("year boundary: Dec 31 + 2mo -> Feb 28 (2025)", () => {
    expect(iso(computeExpiry({ opendate: "24-12-31", ...STD }, cfg({ default_term_months: 2 })))).toBe("2025-02-28");
  });
});

describe("lookAheadDays", () => {
  it("max of offsets", () => {
    expect(lookAheadDays(cfg({ notify_offsets_days: [30, 7, 0] }))).toBe(30);
    expect(lookAheadDays(cfg({ notify_offsets_days: [0] }))).toBe(0);
    expect(lookAheadDays(cfg({ notify_offsets_days: [7] }))).toBe(7);
  });
});

describe("milestoneDue (range model)", () => {
  // 개통 24-06-15, 24개월 마일스톤 -> 26-06-15.
  const open = "24-06-15";
  const M = 24;

  it("D-0 window: only the milestone day itself", () => {
    const c = cfg({ notify_offsets_days: [0] });
    expect(milestoneDue(open, M, c, makeDate(2026, 6, 15))).toEqual([0, expect.any(Date)]);
    expect(milestoneDue(open, M, c, makeDate(2026, 6, 14))).toBeNull(); // 1 day out, window 0
  });

  it("D-30 window: within 30 days, with real days-until", () => {
    const c = cfg({ notify_offsets_days: [30] });
    expect(milestoneDue(open, M, c, makeDate(2026, 5, 16))![0]).toBe(30);
    expect(milestoneDue(open, M, c, makeDate(2026, 6, 3))![0]).toBe(12);
    expect(milestoneDue(open, M, c, makeDate(2026, 6, 15))![0]).toBe(0);
    expect(milestoneDue(open, M, c, makeDate(2026, 5, 15))).toBeNull(); // 31 days out
    expect(milestoneDue(open, M, c, makeDate(2026, 6, 16))).toBeNull(); // already expired
  });

  it("unparseable opendate / non-positive months -> null", () => {
    expect(milestoneDue("", M, CFG, makeDate(2026, 6, 15))).toBeNull();
    expect(milestoneDue(open, 0, CFG, makeDate(2026, 6, 15))).toBeNull();
  });
});

describe("term / keepdate months", () => {
  it("contractTermMonths = default_term_months (약정 개월)", () => {
    expect(contractTermMonths(CFG)).toBe(24);
    expect(contractTermMonths(cfg({ default_term_months: 30 }))).toBe(30);
  });
  it("keepdateDefaultMonths = keepdate_default_months (요금제 유지 기본)", () => {
    expect(keepdateDefaultMonths(CFG)).toBe(6);
    expect(keepdateDefaultMonths(cfg({ keepdate_default_months: 3 }))).toBe(3);
  });
  it("computeExpiry: 약정 대상=약정 개월(24), 유심=요금제 유지 기본(6)", () => {
    expect(iso(computeExpiry({ opendate: "24-06-15", openhowx: "기변" }, CFG))).toBe("2026-06-15");
    expect(iso(computeExpiry({ opendate: "24-06-15", openhowx: "번호이동" }, CFG))).toBe("2026-06-15");
    expect(iso(computeExpiry({ opendate: "24-06-15", openhowx: "유심신규" }, CFG))).toBe("2024-12-15");
    expect(iso(computeExpiry({ opendate: "24-06-15", openhowx: "유심MNP" }, CFG))).toBe("2024-12-15");
  });
  it("non-positive term -> no expiry", () => {
    expect(computeExpiry({ opendate: "24-06-15", openhowx: "기변" }, cfg({ default_term_months: 0 }))).toBeNull();
    expect(computeExpiry({ opendate: "24-06-15", openhowx: "유심신규" }, cfg({ keepdate_default_months: 0 }))).toBeNull();
  });
});

describe("open type classification", () => {
  it("standard (기변/신규)", () => {
    expect(isStandardOpenType("기변")).toBe(true);
    expect(isStandardOpenType("신규")).toBe(true);
  });
  it("nonstandard", () => {
    for (const t of ["번호이동", "유심신규", "유심MNP", ""]) expect(isStandardOpenType(t)).toBe(false);
  });
});

describe("candidateOpenDateBounds", () => {
  it("covers every (term, day-in-window) opendate for the range", () => {
    const c = cfg({ notify_offsets_days: [30] }); // window 30, terms {24, 6}
    const today = makeDate(2026, 7, 4);
    const b = candidateOpenDateBounds(c, today);
    // oldest opendate: expiry=today, term 24 -> 2024-07-04, minus 3-day buffer
    expect(b.sdate <= "2024-07-04").toBe(true);
    expect(b.sdate >= "2024-06-25").toBe(true);
    // newest opendate: expiry=today+30 (2026-08-03), term 6 -> 2026-02-03, plus buffer
    expect(b.edate >= "2026-02-03").toBe(true);
    expect(b.edate <= "2026-02-12").toBe(true);
  });

  it("a longer 약정 개월 widens the lower bound", () => {
    const c = cfg({ notify_offsets_days: [0], default_term_months: 36 });
    const b = candidateOpenDateBounds(c, makeDate(2026, 7, 4));
    // maxTerm now 36 -> oldest opendate ~ 2023-07-04
    expect(b.sdate <= "2023-07-04").toBe(true);
  });
});

describe("scanOpenDateBounds (미방문 look-back)", () => {
  const today = makeDate(2026, 7, 3); // floor at 6 months = 2026-01-03
  it("extends the UPPER bound to >= today so re-activation rows are fetched (auto-clear)", () => {
    const b = scanOpenDateBounds(cfg(), today);
    expect(b.edate >= "2026-07-03").toBe(true);
    // and still reaches back far enough for a 24-month contract expired ~6 months ago
    expect(b.sdate <= "2024-01-03").toBe(true);
  });
  it("due-only candidateOpenDateBounds is unchanged — upper stays in the past", () => {
    expect(candidateOpenDateBounds(cfg(), today).edate < "2026-07-03").toBe(true);
  });
  it("lookback 0 disables widening -> equals the due-only bounds", () => {
    const c = cfg({ unvisited_lookback_months: 0 });
    expect(scanOpenDateBounds(c, today)).toEqual(candidateOpenDateBounds(c, today));
  });
  it("unvisitedFloor is today minus the configured months", () => {
    expect(toIso(unvisitedFloor(cfg(), today))).toBe("2026-01-03");
    expect(toIso(unvisitedFloor(cfg({ unvisited_lookback_months: 3 }), today))).toBe("2026-04-03");
  });
});

// Verify EVERY 안내 시점 option, not just D-30. 4th-of-month base date avoids any
// month-end/leap clamp so days-until is exact.
describe("all 안내시점 windows (당일/1/3/7/14/30)", () => {
  const today = makeDate(2026, 7, 4);
  const TERM = 24;
  // A 기변 row whose 24-month contract expires exactly `d` days from today.
  const rowExpiringIn = (d: number) => ({
    opendate: toIso(addMonths(addDays(today, d), -TERM)),
    openhowx: "기변",
  });

  for (const W of [0, 1, 3, 7, 14, 30]) {
    it(`window ${W}: includes today..D-${W}, excludes D-${W + 1} and expired`, () => {
      const c = cfg({ notify_offsets_days: [W] });
      // sanity: the constructed row really expires when intended
      expect(iso(computeExpiry(rowExpiringIn(W), c))).toBe(toIso(addDays(today, W)));

      expect(milestoneDue(rowExpiringIn(0).opendate, TERM, c, today)).not.toBeNull(); // expiring today
      const edge = milestoneDue(rowExpiringIn(W).opendate, TERM, c, today); // exactly at the window edge
      expect(edge).not.toBeNull();
      expect(edge![0]).toBe(W); // days-until reported correctly

      expect(milestoneDue(rowExpiringIn(W + 1).opendate, TERM, c, today)).toBeNull(); // one past the window
      expect(milestoneDue(rowExpiringIn(-1).opendate, TERM, c, today)).toBeNull(); // expired yesterday
    });

    it(`window ${W}: fetch bounds cover the boundary + longest/shortest term`, () => {
      const c = cfg({ notify_offsets_days: [W] });
      const b = candidateOpenDateBounds(c, today);
      const covered = (odIso: string) => b.sdate <= odIso && odIso <= b.edate;
      // expiring at the window edge with the max term (24) and the min term (6)
      expect(covered(toIso(addMonths(addDays(today, W), -24)))).toBe(true);
      expect(covered(toIso(addMonths(addDays(today, W), -6)))).toBe(true);
      // expiring today with the max term (24) and the min term (6)
      expect(covered(toIso(addMonths(today, -24)))).toBe(true);
      expect(covered(toIso(addMonths(today, -6)))).toBe(true);
    });
  }
});

describe("monthsSinceOpen", () => {
  const TODAY = makeDate(2026, 7, 5);
  it("counts completed whole months open->today", () => {
    expect(monthsSinceOpen("24-07-03", TODAY)).toBe(24); // day-of-month reached
    expect(monthsSinceOpen("24-07-05", TODAY)).toBe(24); // same day
    expect(monthsSinceOpen("24-11-05", TODAY)).toBe(20); // 1년 8개월
    expect(monthsSinceOpen("26-07-04", TODAY)).toBe(0); // this month
  });
  it("does not count the current month until the day-of-month is reached", () => {
    expect(monthsSinceOpen("24-07-10", TODAY)).toBe(23); // today day 5 < open day 10
  });
  it("returns 0 for unparseable or future opendates", () => {
    expect(monthsSinceOpen("", TODAY)).toBe(0);
    expect(monthsSinceOpen("garbage", TODAY)).toBe(0);
    expect(monthsSinceOpen("27-01-01", TODAY)).toBe(0); // future
  });
  it("counts a month-end opendate at the clamped monthiversary (no under-count)", () => {
    expect(monthsSinceOpen("24-08-31", makeDate(2026, 6, 30))).toBe(22); // not 21
    expect(monthsSinceOpen("24-01-31", makeDate(2026, 2, 28))).toBe(25); // not 24
    expect(monthsSinceOpen("23-03-31", makeDate(2024, 9, 30))).toBe(18); // -> {years}=2
  });
});
