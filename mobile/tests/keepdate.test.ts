import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/domain/config";
import {
  isKeepPending,
  keepDueItem,
  keepDueRows,
  keepPhoneSet,
  normalizePhone,
  parseKeepdate,
} from "../src/domain/keepdate";
import { makeDate, toIso } from "../src/domain/plaindate";
import type { AppConfig, PoncleRow } from "../src/domain/types";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULTS, ...over };
}
const TODAY = makeDate(2026, 7, 4);

function pend(over: Partial<Record<string, unknown>> = {}): PoncleRow {
  return {
    gubunx: "요금제유지",
    condx: "접수",
    pendingdate: "2027-01-03",
    openphone: "010-2335-4253",
    phone: "010-2335-4253",
    name: "홍길동",
    ...over,
  };
}

describe("normalizePhone", () => {
  it("keeps digits only", () => {
    expect(normalizePhone("010-2335-4253")).toBe("01023354253");
    expect(normalizePhone(" 010 2335 4253 ")).toBe("01023354253");
    expect(normalizePhone(null)).toBe("");
  });
});

describe("parseKeepdate", () => {
  it("parses yyyy-mm-dd and yy-mm-dd", () => {
    expect(toIso(parseKeepdate("2027-01-03")!)).toBe("2027-01-03");
    expect(toIso(parseKeepdate("27-01-03")!)).toBe("2027-01-03");
  });
  it("rejects invalid", () => {
    expect(parseKeepdate("")).toBeNull();
    expect(parseKeepdate("2027-13-40")).toBeNull();
    expect(parseKeepdate("nope")).toBeNull();
  });
});

describe("isKeepPending / keepPhoneSet", () => {
  it("only 요금제유지 rows count", () => {
    expect(isKeepPending(pend())).toBe(true);
    expect(isKeepPending(pend({ gubunx: "미수금" }))).toBe(false);
  });
  it("blacklist = all 요금제유지 phones regardless of date/cond", () => {
    const rows = [
      pend({ openphone: "010-1111-2222", pendingdate: "2020-01-01", condx: "해결" }), // past + resolved still blacklisted
      pend({ openphone: "010-3333-4444" }),
      pend({ gubunx: "할인예정", openphone: "010-9999-0000" }), // other category excluded
    ];
    const set = keepPhoneSet(rows);
    expect(set.has("01011112222")).toBe(true);
    expect(set.has("01033334444")).toBe(true);
    expect(set.has("01099990000")).toBe(false);
    expect(set.size).toBe(2);
  });
});

describe("keepDueRows", () => {
  const c = cfg({ notify_offsets_days: [0] }); // window 0 (당일만)

  it("includes 유지일 within window, sets offset", () => {
    const rows = [pend({ pendingdate: toIso(TODAY) })]; // 유지일 == today -> offset 0
    const out = keepDueRows(rows, c, TODAY);
    expect(out.length).toBe(1);
    expect(out[0].offset).toBe(0);
    expect(out[0].keepdateIso).toBe("2026-07-04");
    expect(out[0].phoneDigits).toBe("01023354253");
  });
  it("excludes past 유지일 and out-of-window", () => {
    const rows = [
      pend({ pendingdate: "2026-07-03" }), // yesterday
      pend({ pendingdate: "2026-07-10" }), // beyond window 0
    ];
    expect(keepDueRows(rows, c, TODAY).length).toBe(0);
  });
  it("respects a wider window", () => {
    const wide = cfg({ notify_offsets_days: [30] });
    const rows = [pend({ pendingdate: "2026-07-20" })]; // +16 days, within 30
    const out = keepDueRows(rows, wide, TODAY);
    expect(out.length).toBe(1);
    expect(out[0].offset).toBe(16);
  });
  it("excludes 해결 (already handled)", () => {
    const rows = [pend({ pendingdate: toIso(TODAY), condx: "해결" })];
    expect(keepDueRows(rows, c, TODAY).length).toBe(0);
  });
});

describe("keepDueItem", () => {
  const k = { phone: "010-2335-4253", phoneDigits: "01023354253", keepdateIso: "2027-01-03", offset: 0, name: "홍길동" };
  it("joins the open row for type/telecom", () => {
    const open: PoncleRow = { customer: "CABASAL", openhowx: "유심신규", telecomx: "U+알뜰모바일", opendate: "26-07-04", model: "5" };
    const item = keepDueItem(k, open);
    expect(item.expiry_date).toBe("2027-01-03");
    expect(item.openhow).toBe("유심신규");
    expect(item.telecom).toBe("U+알뜰모바일");
    expect(item.customer).toBe("CABASAL");
    expect(item.source).toBe("keepdate");
    expect(item.milestone_offset).toBe(0);
  });
  it("falls back to pending name + blank type when unmatched", () => {
    const item = keepDueItem(k, null);
    expect(item.customer).toBe("홍길동");
    expect(item.telecom).toBe("");
    expect(item.openhow).toBe("");
    expect(item.expiry_date).toBe("2027-01-03");
  });
});
