import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/domain/config";
import { makeDate } from "../src/domain/plaindate";
import { computeUnvisited, latestOpenByPhone } from "../src/domain/unvisited";
import type { AppConfig, PoncleRow } from "../src/domain/types";

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over });
const TODAY = makeDate(2026, 7, 3); // floor at 6-month lookback = 2026-01-03
const NONE = new Set<string>();

/** A 기변 open row whose 24-month contract expiry is derived from opendate. */
const openRow = (phone: string, opendate: string, over: Partial<PoncleRow> = {}): PoncleRow => ({
  openphone: phone,
  customer: "고객",
  opendate,
  openhowx: "기변",
  telecomx: "SK텔레콤",
  agencytitle: "CD대리점",
  model: "Galaxy",
  ...over,
});

describe("latestOpenByPhone", () => {
  it("keeps the row with the latest opendate per phone", () => {
    const rows = [
      openRow("010-1111-2222", "24-01-01"),
      openRow("010-1111-2222", "26-07-01"), // later activation (re-contract)
      openRow("010-3333-4444", "24-06-01"),
    ];
    const map = latestOpenByPhone(rows);
    expect(map.get("01011112222")?.opendate).toBe("26-07-01");
    expect(map.get("01033334444")?.opendate).toBe("24-06-01");
  });
});

describe("computeUnvisited", () => {
  it("includes a 약정 대상 whose 약정(24mo) expired within the look-back (source=term)", () => {
    // opendate 24-06-01 + 24m = 2026-06-01 (expired 32 days ago, within 6 months)
    const rows = [openRow("010-1111-2222", "24-06-01")];
    const out = computeUnvisited(rows, cfg(), TODAY, NONE);
    expect(out.length).toBe(1);
    expect(out[0].expiry_date).toBe("2026-06-01");
    expect(out[0].source).toBe("term");
    expect(out[0].id).toBe("010-1111-2222|2026-06-01");
    expect(out[0].milestone_offset).toBe(32); // D+32
    expect(out[0].already_sent).toBe(false);
  });

  it("uses 요금제 유지 기본 6개월 for 유심, source=keepdate", () => {
    // 유심 opendate 26-01-01 + 6mo = 2026-07-01 (expired 2 days ago, within the floor)
    const rows = [openRow("010-2222-3333", "26-01-01", { openhowx: "유심신규" })];
    const out = computeUnvisited(rows, cfg(), TODAY, NONE);
    expect(out.length).toBe(1);
    expect(out[0].expiry_date).toBe("2026-07-01");
    expect(out[0].source).toBe("keepdate");
  });

  it("excludes not-yet-expired / aged-out / 무약정(unparseable) rows", () => {
    expect(computeUnvisited([openRow("010-1", "24-08-01")], cfg(), TODAY, NONE)).toEqual([]); // future 2026-08-01
    expect(computeUnvisited([openRow("010-2", "23-01-01")], cfg(), TODAY, NONE)).toEqual([]); // aged out 2025-01-01
    expect(computeUnvisited([openRow("010-3", "")], cfg(), TODAY, NONE)).toEqual([]); // no computable 만료
  });

  it("auto-clears a returned customer: a newer open row makes the latest future-dated", () => {
    const rows = [
      openRow("010-1111-2222", "24-06-01"), // expired 2026-06-01
      openRow("010-1111-2222", "26-07-01"), // returned & re-contracted -> latest is future
    ];
    expect(computeUnvisited(rows, cfg(), TODAY, NONE)).toEqual([]);
  });

  it("tags already_sent from the sent key set", () => {
    const rows = [openRow("010-1111-2222", "24-06-01")];
    const sent = new Set(["010-1111-2222|2026-06-01"]);
    expect(computeUnvisited(rows, cfg(), TODAY, sent)[0].already_sent).toBe(true);
  });

  it("sorts unsent first, then newest expiry first", () => {
    const opens = [
      openRow("010-0001-0001", "24-05-01"), // term expiry 2026-05-01 (older)
      openRow("010-0002-0002", "24-06-01"), // term expiry 2026-06-01
      openRow("010-0003-0003", "26-01-01", { openhowx: "유심신규" }), // 유심 6mo -> 2026-07-01 (newest)
    ];
    const sent = new Set(["010-0002-0002|2026-06-01"]); // 0002 already alerted
    const out = computeUnvisited(opens, cfg(), TODAY, sent);
    // unsent (0003 @2026-07-01, 0001 @2026-05-01) before sent (0002); newest expiry first within unsent
    expect(out.map((r) => r.phone)).toEqual(["010-0003-0003", "010-0001-0001", "010-0002-0002"]);
    expect(out.find((r) => r.phone === "010-0003-0003")?.source).toBe("keepdate");
  });
});
