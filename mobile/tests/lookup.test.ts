import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/domain/config";
import { buildLookupResults, lookupStatus, lookupToDueItem } from "../src/domain/lookup";
import { makeDate } from "../src/domain/plaindate";
import type { AppConfig, PoncleRow } from "../src/domain/types";

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over });
const TODAY = makeDate(2026, 7, 3);
const WINDOW = 30;

const row = (phone: string, opendate: string, over: Partial<PoncleRow> = {}): PoncleRow => ({
  openphone: phone, customer: "고객", opendate, openhowx: "기변",
  telecomx: "KT", agencytitle: "CD대리점", model: "Galaxy", plan: "5G", membername: "김담당", ...over,
});

describe("lookupStatus", () => {
  it("무약정 (no expiry) -> muted", () => {
    expect(lookupStatus(null, TODAY, WINDOW, false)).toEqual({ label: "무약정", tone: "muted" });
  });
  it("expired -> danger with D+", () => {
    const s = lookupStatus(makeDate(2026, 6, 1), TODAY, WINDOW, false);
    expect(s.tone).toBe("danger");
    expect(s.label).toContain("D+32");
  });
  it("within window -> warn with D-", () => {
    const s = lookupStatus(makeDate(2026, 7, 20), TODAY, WINDOW, false);
    expect(s.tone).toBe("warn");
    expect(s.label).toContain("D-17");
  });
  it("active with a prior contract -> 재계약 완료 (ok)", () => {
    expect(lookupStatus(makeDate(2028, 6, 1), TODAY, WINDOW, true)).toEqual({ label: "재계약 완료", tone: "ok" });
  });
  it("active, no prior -> 여유 (ok)", () => {
    const s = lookupStatus(makeDate(2027, 1, 1), TODAY, WINDOW, false);
    expect(s.tone).toBe("ok");
    expect(s.label).toContain("여유");
  });
});

describe("buildLookupResults", () => {
  it("groups by phone (latest = current), flags re-sign, joins informed, sorts newest 개통 first", () => {
    const rows = [
      row("010-1111-2222", "24-07-20"), // expiry 2026-07-20 -> 곧 만료 D-17
      row("010-3333-4444", "24-05-01"), // expiry 2026-05-01 -> 만료 지남
      row("010-5555-6666", "23-01-01"), // old contract...
      row("010-5555-6666", "26-06-01"), // ...re-signed -> latest opendate -> newest
      row("010-7777-8888", "", { openhowx: "번호이동" }), // empty opendate -> 무약정 (no computable 만료)
    ];
    const sent = new Map([["010-3333-4444|2026-05-01", "2026-04-20T09:00:00"]]);
    const out = buildLookupResults(rows, cfg(), TODAY, WINDOW, sent);

    // Sorted by opendate descending (most recent contract on top); empty opendate last.
    expect(out.map((r) => r.phone)).toEqual([
      "010-5555-6666", // 26-06-01 (newest opendate)
      "010-1111-2222", // 24-07-20
      "010-3333-4444", // 24-05-01
      "010-7777-8888", // "" (무약정, sorts last)
    ]);
    const byPhone = Object.fromEntries(out.map((r) => [r.phone, r]));
    expect(byPhone["010-5555-6666"].status.label).toBe("재계약 완료");
    expect(byPhone["010-1111-2222"].status.tone).toBe("warn");
    expect(byPhone["010-3333-4444"].status.tone).toBe("danger");
    expect(byPhone["010-3333-4444"].informedAt).toBe("2026-04-20T09:00:00");
    expect(byPhone["010-1111-2222"].informedAt).toBe("");
    expect(byPhone["010-7777-8888"].status.label).toBe("무약정");
    expect(byPhone["010-7777-8888"].expiry_date).toBe("");
    // offsetDays = days until expiry (>=0); 무약정 -> 0
    expect(byPhone["010-1111-2222"].offsetDays).toBe(17); // 2026-07-20 - 2026-07-03
    expect(byPhone["010-3333-4444"].offsetDays).toBe(0); // expired -> clamped to 0
    expect(byPhone["010-7777-8888"].offsetDays).toBe(0); // 무약정
  });

  it("lookupToDueItem carries the real D-day offset so {when} renders D-N, not 오늘", () => {
    const rows = [row("010-1111-2222", "24-07-20")];
    const [r] = buildLookupResults(rows, cfg(), TODAY, WINDOW, new Map([["010-1111-2222|2026-07-20", "x"]]));
    const item = lookupToDueItem(r);
    expect(item.phone).toBe("010-1111-2222");
    expect(item.expiry_date).toBe("2026-07-20");
    expect(item.milestone_offset).toBe(17); // NOT 0
    expect(item.already_sent).toBe(true);
    expect(item.source).toBe("term");
  });
});
