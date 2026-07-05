import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/domain/config";
import { makeDate } from "../src/domain/plaindate";
import {
  computeUnvisited,
  keepUnvisited,
  latestOpenByPhone,
  termUnvisited,
} from "../src/domain/unvisited";
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

describe("termUnvisited", () => {
  it("includes a phone whose latest contract expired within the look-back", () => {
    // opendate 24-06-01 + 24m = 2026-06-01 (expired 32 days ago, within 6 months)
    const rows = [openRow("010-1111-2222", "24-06-01")];
    const out = termUnvisited(rows, cfg(), TODAY, NONE, NONE);
    expect(out.length).toBe(1);
    expect(out[0].expiry_date).toBe("2026-06-01");
    expect(out[0].source).toBe("term");
    expect(out[0].id).toBe("010-1111-2222|2026-06-01");
    expect(out[0].milestone_offset).toBe(32); // D+32
    expect(out[0].already_sent).toBe(false);
  });

  it("excludes contracts not yet expired (those are the due list's job)", () => {
    const rows = [openRow("010-1", "24-08-01")]; // expiry 2026-08-01 (future)
    expect(termUnvisited(rows, cfg(), TODAY, NONE, NONE)).toEqual([]);
  });

  it("excludes contracts expired before the look-back floor (aged out)", () => {
    const rows = [openRow("010-1", "23-01-01")]; // expiry 2025-01-01 (> 6 months ago)
    expect(termUnvisited(rows, cfg(), TODAY, NONE, NONE)).toEqual([]);
  });

  it("auto-clears a returned customer: a newer open row makes the latest future-dated", () => {
    const rows = [
      openRow("010-1111-2222", "24-06-01"), // expired 2026-06-01
      openRow("010-1111-2222", "26-07-01"), // returned & re-contracted -> latest is future
    ];
    expect(termUnvisited(rows, cfg(), TODAY, NONE, NONE)).toEqual([]);
  });

  it("skips 유지일 (blacklisted) phones — keepUnvisited judges those", () => {
    const rows = [openRow("010-1111-2222", "24-06-01")];
    const blacklist = new Set(["01011112222"]);
    expect(termUnvisited(rows, cfg(), TODAY, blacklist, NONE)).toEqual([]);
  });

  it("excludes 무약정 rows (term 0 -> no expiry)", () => {
    const rows = [openRow("010-1", "24-06-01", { openhowx: "번호이동", agencytitle: "무약정처" })];
    const out = termUnvisited(rows, cfg({ agency_term_months: { 무약정처: 0 } }), TODAY, NONE, NONE);
    expect(out).toEqual([]);
  });

  it("tags already_sent from the sent key set", () => {
    const rows = [openRow("010-1111-2222", "24-06-01")];
    const sent = new Set(["010-1111-2222|2026-06-01"]);
    expect(termUnvisited(rows, cfg(), TODAY, NONE, sent)[0].already_sent).toBe(true);
  });
});

describe("keepUnvisited", () => {
  const pending = (over: Partial<PoncleRow>): PoncleRow => ({
    gubunx: "요금제유지",
    condx: "접수",
    pendingdate: "2026-06-01",
    openphone: "010-9999-0000",
    name: "유지고객",
    ...over,
  });

  it("includes a passed, unresolved 유지일 with no re-activation", () => {
    const out = keepUnvisited([pending({})], [], cfg(), TODAY, NONE);
    expect(out.length).toBe(1);
    expect(out[0].source).toBe("keepdate");
    expect(out[0].expiry_date).toBe("2026-06-01");
    expect(out[0].customer).toBe("유지고객"); // name fallback (no open join)
  });

  it("excludes 해결 (resolved = handled)", () => {
    expect(keepUnvisited([pending({ condx: "해결" })], [], cfg(), TODAY, NONE)).toEqual([]);
  });

  it("excludes an aged-out 유지일", () => {
    expect(keepUnvisited([pending({ pendingdate: "2025-06-01" })], [], cfg(), TODAY, NONE)).toEqual([]);
  });

  it("auto-clears when a newer 개통 exists after the 유지일 (customer returned)", () => {
    const opens = [openRow("010-9999-0000", "26-06-15")]; // opened after 유지일 2026-06-01
    expect(keepUnvisited([pending({})], opens, cfg(), TODAY, NONE)).toEqual([]);
  });

  it("joins type/telecom from the open row when present", () => {
    const opens = [openRow("010-9999-0000", "24-01-01", { telecomx: "KT", openhowx: "유심신규" })];
    const out = keepUnvisited([pending({})], opens, cfg(), TODAY, NONE);
    expect(out[0].telecom).toBe("KT");
    expect(out[0].openhow).toBe("유심신규");
  });
});

describe("computeUnvisited", () => {
  it("merges term + keepdate, unsent first then newest expiry first", () => {
    const opens = [
      openRow("010-0001-0001", "24-05-01"), // term expiry 2026-05-01 (older)
      openRow("010-0002-0002", "24-06-01"), // term expiry 2026-06-01 (newer)
    ];
    const pending: PoncleRow[] = [
      { gubunx: "요금제유지", condx: "접수", pendingdate: "2026-06-20", openphone: "010-0003-0003", name: "K" },
    ];
    const sent = new Set(["010-0002-0002|2026-06-01"]); // 0002 already alerted
    const out = computeUnvisited(opens, pending, cfg(), TODAY, NONE, sent);
    // unsent (0001 @2026-05-01, 0003 @2026-06-20) before sent (0002); within unsent, newest expiry first
    expect(out.map((r) => r.phone)).toEqual(["010-0003-0003", "010-0001-0001", "010-0002-0002"]);
    expect(out.find((r) => r.phone === "010-0003-0003")?.source).toBe("keepdate");
  });
});
