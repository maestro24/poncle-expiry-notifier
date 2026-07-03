import { describe, expect, it } from "vitest";
import {
  candidateOpenDates,
  computeExpiry,
  dueMilestones,
  isStandardOpenType,
  parseOpendate,
  resolveTermMonths,
} from "../src/domain/expiry";
import { templateForRow } from "../src/domain/notifier";
import { DEFAULTS } from "../src/domain/config";
import { addDays, makeDate, toIso } from "../src/domain/plaindate";
import type { AppConfig } from "../src/domain/types";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULTS, ...over };
}
const CFG = cfg({ notify_offsets_days: [0] });
const STD = { openhowx: "기변" };

const iso = (d: Date | null) => (d === null ? null : toIso(d));

describe("parseOpendate", () => {
  it("two-digit year", () => {
    expect(iso(parseOpendate("24-06-15"))).toBe("2024-06-15");
  });
  it("four-digit year", () => {
    expect(iso(parseOpendate("2024-06-15"))).toBe("2024-06-15");
  });
  it("bad input", () => {
    expect(parseOpendate("")).toBeNull();
    expect(parseOpendate("nope")).toBeNull();
    expect(parseOpendate("24-13-40")).toBeNull();
  });
});

describe("addMonths (via computeExpiry / candidate)", () => {
  it("plain 24 months", () => {
    expect(iso(computeExpiry({ opendate: "24-06-15", ...STD }, CFG))).toBe("2026-06-15");
  });
  it("leap clamp: Jan 31 + 1mo -> Feb 29 (2024)", () => {
    const c = cfg({ default_term_months: 1 });
    expect(iso(computeExpiry({ opendate: "24-01-31", ...STD }, c))).toBe("2024-02-29");
  });
  it("year boundary: Dec 31 + 2mo -> Feb 28 (2025)", () => {
    const c = cfg({ default_term_months: 2 });
    expect(iso(computeExpiry({ opendate: "24-12-31", ...STD }, c))).toBe("2025-02-28");
  });
});

describe("expiry & milestones", () => {
  it("core example: 기변 24-06-15 -> 26-06-15", () => {
    expect(iso(computeExpiry({ opendate: "24-06-15", ...STD }, CFG))).toBe("2026-06-15");
  });
  it("due today D-day", () => {
    const due = dueMilestones({ opendate: "24-06-15", ...STD }, CFG, makeDate(2026, 6, 15));
    expect(due.length).toBe(1);
    expect(due[0][0]).toBe(0);
    expect(iso(due[0][1])).toBe("2026-06-15");
  });
  it("not due on adjacent days", () => {
    const row = { opendate: "24-06-15", ...STD };
    expect(dueMilestones(row, CFG, makeDate(2026, 6, 14))).toEqual([]);
    expect(dueMilestones(row, CFG, makeDate(2026, 6, 16))).toEqual([]);
  });
  it("D-7 and D-day", () => {
    const c = cfg({ notify_offsets_days: [0, 7] });
    const row = { opendate: "24-06-15", ...STD };
    const d7 = dueMilestones(row, c, makeDate(2026, 6, 8));
    expect(d7.length).toBe(1);
    expect(d7[0][0]).toBe(7);
    const d0 = dueMilestones(row, c, makeDate(2026, 6, 15));
    expect(d0[0][0]).toBe(0);
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
    for (const t of ["번호이동", "유심신규", "유심MNP", ""]) {
      expect(isStandardOpenType(t)).toBe(false);
    }
  });
});

describe("template selection", () => {
  const TCFG = cfg({ message_template: "STD", message_template_nonstandard: "NON" });
  it("standard types use standard template", () => {
    expect(templateForRow(TCFG, { openhowx: "기변" })).toBe("STD");
    expect(templateForRow(TCFG, { openhowx: "신규" })).toBe("STD");
  });
  it("nonstandard types use nonstandard template", () => {
    expect(templateForRow(TCFG, { openhowx: "번호이동" })).toBe("NON");
    expect(templateForRow(TCFG, { openhowx: "유심MNP" })).toBe("NON");
    expect(templateForRow(TCFG, { openhowx: "유심신규" })).toBe("NON");
  });
  it("empty nonstandard falls back to standard", () => {
    const c = cfg({ message_template: "STD", message_template_nonstandard: "" });
    expect(templateForRow(c, { openhowx: "번호이동" })).toBe("STD");
  });
});

describe("candidate open dates", () => {
  it("D-day candidate = today - 24 months", () => {
    const cands = candidateOpenDates(CFG, makeDate(2026, 6, 15)).map(toIso);
    expect(cands).toContain("2024-06-15");
  });
  it("multi offset and terms", () => {
    const c = cfg({ notify_offsets_days: [0, 7], agency_term_months: { X: 12 } });
    const cands = candidateOpenDates(c, makeDate(2026, 6, 15)).map(toIso);
    expect(cands).toContain("2024-06-15"); // 24-month D-day
    expect(cands).toContain("2024-06-22"); // 24-month D-7
    expect(cands).toContain("2025-06-15"); // 12-month D-day (agency override)
    expect(cands).toContain("2025-12-15"); // 6-month D-day (nonstandard default)
  });
});

describe("window coverage regression (day-clamp absorbed by +/- window)", () => {
  const WINDOW = 3;
  function covered(opendate: Date, term: number, offset: number): boolean {
    const c = cfg({ default_term_months: term, notify_offsets_days: [offset] });
    const row = { opendate: toIso(opendate), ...STD };
    const expiry = computeExpiry(row, c)!;
    const todayD = addDays(expiry, -offset);
    expect(dueMilestones(row, c, todayD).length).toBeGreaterThan(0);
    const cands = candidateOpenDates(c, todayD);
    return cands.some(
      (cnd) => Math.abs(Math.round((cnd.getTime() - opendate.getTime()) / 86400000)) <= WINDOW,
    );
  }
  it("leap-day open, term 24", () => expect(covered(makeDate(2024, 2, 29), 24, 0)).toBe(true));
  it("month-end open, term 1", () => expect(covered(makeDate(2024, 8, 31), 1, 0)).toBe(true));
  it("month-end open, term 30", () => expect(covered(makeDate(2023, 12, 31), 30, 0)).toBe(true));
  it("plain mid-month still covered", () => expect(covered(makeDate(2024, 6, 15), 24, 0)).toBe(true));
  it("every month end, term 1", () => {
    for (let m = 1; m <= 12; m++) {
      const last = new Date(2024, m, 0).getDate();
      expect(covered(makeDate(2024, m, last), 1, 0)).toBe(true);
    }
  });
});
