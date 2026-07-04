import { describe, expect, it } from "vitest";
import {
  candidateOpenDateBounds,
  computeExpiry,
  dueWithin,
  isStandardOpenType,
  lookAheadDays,
  parseOpendate,
  resolveTermMonths,
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
  it("plain 24 months", () => {
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

describe("dueWithin (range model)", () => {
  // 기변 opened 24-06-15 -> expiry 26-06-15.
  const row = { opendate: "24-06-15", ...STD };

  it("D-0 window: only the expiry day itself", () => {
    const c = cfg({ notify_offsets_days: [0] });
    expect(dueWithin(row, c, makeDate(2026, 6, 15))).toEqual([[0, expect.any(Date)]]);
    expect(dueWithin(row, c, makeDate(2026, 6, 14))).toEqual([]); // 1 day out, window 0
  });

  it("D-30 window: shows everyone expiring within 30 days, with real days-until", () => {
    const c = cfg({ notify_offsets_days: [30] });
    // 30 days before expiry -> included, offset 30
    const d30 = dueWithin(row, c, makeDate(2026, 5, 16));
    expect(d30.length).toBe(1);
    expect(d30[0][0]).toBe(30);
    // 12 days before -> still within window, offset reflects actual remaining days
    const d12 = dueWithin(row, c, makeDate(2026, 6, 3));
    expect(d12[0][0]).toBe(12);
    // on expiry day -> offset 0, still shown
    expect(dueWithin(row, c, makeDate(2026, 6, 15))[0][0]).toBe(0);
    // 31 days out -> just outside the window
    expect(dueWithin(row, c, makeDate(2026, 5, 15))).toEqual([]);
    // already expired -> excluded
    expect(dueWithin(row, c, makeDate(2026, 6, 16))).toEqual([]);
  });
});

describe("term resolution", () => {
  it("standard types use default", () => {
    expect(resolveTermMonths({ openhowx: "기변" }, CFG)).toBe(24);
    expect(resolveTermMonths({ openhowx: "신규" }, CFG)).toBe(24);
  });
  it("nonstandard uses nonstandard default", () => {
    expect(resolveTermMonths({ openhowx: "번호이동" }, CFG)).toBe(6);
    expect(resolveTermMonths({ openhowx: "유심MNP" }, CFG)).toBe(6);
  });
  it("유심신규 is nonstandard (exact match)", () => {
    expect(resolveTermMonths({ openhowx: "유심신규" }, CFG)).toBe(6);
  });
  it("agency override", () => {
    const c = cfg({ agency_term_months: { CD대리점: 12 } });
    const row = { opendate: "24-06-15", openhowx: "번호이동", agencytitle: "CD대리점" };
    expect(resolveTermMonths(row, c)).toBe(12);
    expect(iso(computeExpiry(row, c))).toBe("2025-06-15");
  });
  it("agency override ignored for standard type", () => {
    const c = cfg({ agency_term_months: { CD대리점: 12 } });
    expect(resolveTermMonths({ openhowx: "기변", agencytitle: "CD대리점" }, c)).toBe(24);
  });
  it("agency name HTML-entity normalization (PS&M vs PS&amp;M)", () => {
    const c = cfg({ agency_term_months: { "PS&M": 9 } });
    expect(resolveTermMonths({ openhowx: "번호이동", agencytitle: "PS&amp;M" }, c)).toBe(9);
  });
  it("zero term is skipped (no expiry)", () => {
    const c = cfg({ agency_term_months: { CD대리점: 0 } });
    expect(computeExpiry({ opendate: "24-06-15", openhowx: "번호이동", agencytitle: "CD대리점" }, c)).toBeNull();
  });
});

describe("open type classification", () => {
  it("standard", () => {
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

  it("agency override term widens the bounds", () => {
    const c = cfg({ notify_offsets_days: [0], agency_term_months: { X: 36 } });
    const b = candidateOpenDateBounds(c, makeDate(2026, 7, 4));
    // maxTerm now 36 -> oldest opendate ~ 2023-07-04
    expect(b.sdate <= "2023-07-04").toBe(true);
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

      expect(dueWithin(rowExpiringIn(0), c, today).length).toBe(1); // expiring today
      const edge = dueWithin(rowExpiringIn(W), c, today); // exactly at the window edge
      expect(edge.length).toBe(1);
      expect(edge[0][0]).toBe(W); // days-until reported correctly

      expect(dueWithin(rowExpiringIn(W + 1), c, today)).toEqual([]); // one past the window
      expect(dueWithin(rowExpiringIn(-1), c, today)).toEqual([]); // expired yesterday
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
