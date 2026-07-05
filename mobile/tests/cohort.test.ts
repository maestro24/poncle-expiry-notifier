import { describe, expect, it } from "vitest";
import { cohortStats, updateCohort, type CohortEntry } from "../src/domain/cohort";
import { makeDate } from "../src/domain/plaindate";
import type { DueItem, PoncleRow } from "../src/domain/types";

const TODAY = makeDate(2026, 7, 3);
const WINDOW = 90; // floor = 2026-04-04

const expired = (phone: string, expiry: string): DueItem => ({
  id: `${phone}|${expiry}`, phone, customer: "고객", opendate: "", expiry_date: expiry,
  milestone_offset: 0, telecom: "", agency: "", openhow: "", plan: "", model: "", staff: "",
  already_sent: false, source: "term",
});
const openRow = (phone: string, opendate: string): PoncleRow => ({ openphone: phone, opendate });

describe("updateCohort", () => {
  it("adds newly-expired customers with the informed flag from sentKeys", () => {
    const out = updateCohort([], [expired("010-1", "2026-06-01")], [], new Set(["010-1|2026-06-01"]), TODAY, WINDOW);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ phone: "010-1", expiry: "2026-06-01", informed: true, revisited: false });
  });

  it("marks revisited when a newer 개통 (opendate > expiry) appears for the phone", () => {
    const prev: CohortEntry[] = [
      { phone: "010-1", expiry: "2026-06-01", informed: true, revisited: false, firstSeen: "2026-06-05" },
    ];
    // customer returned: they're no longer in the expired list, but a newer open row exists
    const out = updateCohort(prev, [], [openRow("010-1", "26-06-15")], new Set(), TODAY, WINDOW);
    expect(out[0].revisited).toBe(true);
    expect(out[0].informed).toBe(true); // preserved
  });

  it("does NOT mark revisited when the only 개통 is the original (opendate <= expiry)", () => {
    const prev: CohortEntry[] = [
      { phone: "010-1", expiry: "2026-06-01", informed: false, revisited: false, firstSeen: "2026-06-05" },
    ];
    const out = updateCohort(prev, [], [openRow("010-1", "24-06-01")], new Set(), TODAY, WINDOW);
    expect(out[0].revisited).toBe(false);
  });

  it("ages out entries whose expiry is older than the window", () => {
    const prev: CohortEntry[] = [
      { phone: "010-old", expiry: "2026-01-01", informed: true, revisited: false, firstSeen: "2026-01-05" },
    ];
    expect(updateCohort(prev, [], [], new Set(), TODAY, WINDOW)).toEqual([]);
  });
});

describe("cohortStats", () => {
  it("computes revisit rates overall and split by informed", () => {
    const entries: CohortEntry[] = [
      // informed: 3, of which 2 revisited
      { phone: "a", expiry: "2026-06-01", informed: true, revisited: true, firstSeen: "" },
      { phone: "b", expiry: "2026-06-02", informed: true, revisited: true, firstSeen: "" },
      { phone: "c", expiry: "2026-06-03", informed: true, revisited: false, firstSeen: "" },
      // uninformed: 2, of which 1 revisited
      { phone: "d", expiry: "2026-06-04", informed: false, revisited: true, firstSeen: "" },
      { phone: "e", expiry: "2026-06-05", informed: false, revisited: false, firstSeen: "" },
      // out of window (too old) -> excluded
      { phone: "f", expiry: "2026-01-01", informed: true, revisited: true, firstSeen: "" },
    ];
    const s = cohortStats(entries, TODAY, WINDOW);
    expect(s.total).toBe(5);
    expect(s.revisited).toBe(3);
    expect(s.revisitRate).toBe(60); // 3/5
    expect(s.informed).toBe(3);
    expect(s.informedRevisited).toBe(2);
    expect(s.informedRate).toBe(67); // 2/3
    expect(s.uninformed).toBe(2);
    expect(s.uninformedRate).toBe(50); // 1/2
  });

  it("empty cohort -> zeros, no divide-by-zero", () => {
    const s = cohortStats([], TODAY, WINDOW);
    expect(s).toMatchObject({ total: 0, revisitRate: 0, informedRate: 0, uninformedRate: 0 });
  });
});
