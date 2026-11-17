import { describe, expect, it } from "vitest";
import {
  buildBackup,
  classifyShareError,
  excludedKeysToAdd,
  mergeCohort,
  historyToCsv,
  isAllowedPoncleBaseUrl,
  mergeHistory,
  missingFromBackup,
  parseBackup,
  sanitizeRecord,
} from "../src/domain/export";
import type { SentRecord } from "../src/domain/history";
import { DEFAULTS, restoreConfig } from "../src/domain/config";

const rec = (over: Partial<SentRecord> = {}): SentRecord => ({
  phone: "010-1234-5678",
  customer: "홍길동",
  opendate: "2024-01-05",
  expiry_date: "2026-01-05",
  milestone_offset: 0,
  telecom: "KT",
  agency: "강남점",
  plan: "5G",
  model: "갤럭시",
  openhow: "기변",
  staff: "",
  channel: "sms",
  sent_at: "2025-12-20T10:30:00",
  body: "안녕하세요",
  ...over,
});

describe("buildBackup + parseBackup round-trip", () => {
  it("round-trips history + config", () => {
    const backup = buildBackup({ poncle_base_url: "https://m.poncle.co.kr" } as never, [rec()], "2026-07-05T00:00:00");
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed).not.toBeNull();
    expect(parsed!.history).toHaveLength(1);
    expect(parsed!.history[0].phone).toBe("010-1234-5678");
    expect(parsed!.config).not.toBeNull();
  });

  it("rejects non-backup JSON and junk", () => {
    expect(parseBackup("not json")).toBeNull();
    expect(parseBackup(JSON.stringify({ app: "other", history: [] }))).toBeNull();
    expect(parseBackup(JSON.stringify({ app: "poncle-expiry", history: "nope" }))).toBeNull();
    expect(parseBackup(JSON.stringify(["array"]))).toBeNull();
  });
});

describe("parseBackup sanitization (hostile / corrupt files)", () => {
  it("drops records missing phone or expiry_date", () => {
    const backup = {
      app: "poncle-expiry",
      history: [rec(), { customer: "무전화" }, { phone: "010", customer: "무만료" }],
    };
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed!.history).toHaveLength(1);
  });

  it("coerces non-string fields so downstream .slice/.toLowerCase can't throw", () => {
    const backup = {
      app: "poncle-expiry",
      history: [{ phone: 1012345678, expiry_date: "2026-01-05", sent_at: 20251220, customer: null }],
    };
    const parsed = parseBackup(JSON.stringify(backup));
    const r = parsed!.history[0];
    expect(typeof r.phone).toBe("string");
    expect(typeof r.sent_at).toBe("string");
    expect(typeof r.customer).toBe("string");
    expect(() => r.sent_at.slice(0, 10)).not.toThrow();
  });

  // Updated for audit L8: parseBackup used to strip the URL silently, so the restore
  // never reported it. restoreConfig (the only path to saveConfig) now drops it,
  // keeps THIS phone's URL and lists it as skipped.
  it("a non-poncle poncle_base_url never reaches the restored config, and is reported", () => {
    const backup = {
      app: "poncle-expiry",
      history: [rec()],
      config: { poncle_base_url: "https://evil.example.com", deliver_alerts: true },
    };
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed!.config).not.toBeNull();
    const current = { ...DEFAULTS, poncle_base_url: "https://m.poncle.co.kr" };
    const { config, dropped } = restoreConfig(parsed!.config, current);
    expect(config.poncle_base_url).toBe("https://m.poncle.co.kr");
    expect(dropped).toContain("poncle_base_url");
    // other config keys survive
    expect(config.deliver_alerts).toBe(true);
  });

  it("keeps a legitimate poncle_base_url", () => {
    const backup = {
      app: "poncle-expiry",
      history: [rec()],
      config: { poncle_base_url: "https://m.poncle.co.kr" },
    };
    const parsed = parseBackup(JSON.stringify(backup));
    expect((parsed!.config as unknown as Record<string, unknown>).poncle_base_url).toBe("https://m.poncle.co.kr");
  });
});

describe("isAllowedPoncleBaseUrl", () => {
  it("accepts poncle.co.kr and subdomains", () => {
    expect(isAllowedPoncleBaseUrl("https://m.poncle.co.kr")).toBe(true);
    expect(isAllowedPoncleBaseUrl("https://poncle.co.kr/open")).toBe(true);
  });
  it("rejects other hosts and junk", () => {
    expect(isAllowedPoncleBaseUrl("https://evil.example.com")).toBe(false);
    expect(isAllowedPoncleBaseUrl("https://poncle.co.kr.evil.com")).toBe(false);
    expect(isAllowedPoncleBaseUrl("ftp://poncle.co.kr")).toBe(false);
    expect(isAllowedPoncleBaseUrl("not a url")).toBe(false);
    expect(isAllowedPoncleBaseUrl(null)).toBe(false);
  });
});

describe("sanitizeRecord", () => {
  it("returns null for non-objects and missing keys", () => {
    expect(sanitizeRecord(null)).toBeNull();
    expect(sanitizeRecord("x")).toBeNull();
    expect(sanitizeRecord({ phone: "010" })).toBeNull();
  });
  it("defaults channel to sms and milestone_offset to 0", () => {
    const r = sanitizeRecord({ phone: "010", expiry_date: "2026-01-05" });
    expect(r!.channel).toBe("sms");
    expect(r!.milestone_offset).toBe(0);
  });
  it("coerces an unknown/hostile channel to a safe known value (no stored XSS)", () => {
    // The 이력 list renders the channel tag; an unknown value used to fall through
    // to innerHTML unescaped. A restored/hostile backup carrying HTML in `channel`
    // must be neutralized to a known value that maps to a fixed label.
    const evil = sanitizeRecord({
      phone: "010", expiry_date: "2026-01-05",
      channel: "<img src=x onerror=alert(1)>",
    });
    expect(evil!.channel).toBe("record-only");
    expect(sanitizeRecord({ phone: "010", expiry_date: "2026-01-05", channel: "skipped" })!.channel).toBe("skipped");
    expect(sanitizeRecord({ phone: "010", expiry_date: "2026-01-05", channel: "record-only" })!.channel).toBe("record-only");
  });
});

describe("historyToCsv", () => {
  it("prefixes a BOM and escapes commas/quotes/newlines", () => {
    const csv = historyToCsv([rec({ customer: 'A,B"C', body: "line1\nline2" })]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"A,B""C"');
    expect(csv).toContain('"line1\nline2"');
  });

  /** Parse our own CSV output back into cells (RFC 4180 quoting). */
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let q = false;
    const s = text.replace(/^﻿/, "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\r" && s[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
      else cell += c;
    }
    row.push(cell);
    rows.push(row);
    return rows;
  }

  it("neutralizes spreadsheet formulas: = + - @ TAB CR leading cells get a ' prefix (#42)", () => {
    const csv = historyToCsv([rec({ customer: "=HYPERLINK(\"x\")", agency: "+1+1", model: "-2", body: "@SUM(A1)", plan: "\tx" })]);
    const [, row] = parseCsv(csv);
    expect(row).toContain("'=HYPERLINK(\"x\")");
    expect(row).toContain("'+1+1");
    expect(row).toContain("'-2");
    expect(row).toContain("'@SUM(A1)");
    expect(row).toContain("'\tx");
  });

  it("quotes a bare CR so it can't split the row (#42)", () => {
    const csv = historyToCsv([rec({ body: "a\rb" })]);
    expect(csv).toContain('"a\rb"');
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2); // header + one record
  });

  it("has 만료일 / 요금제 / 담당 columns aligned with the values (3-6)", () => {
    const csv = historyToCsv([rec({ staff: "김직원" })]);
    const [header, row] = parseCsv(csv);
    const col = (name: string) => row[header.indexOf(name)];
    expect(col("만료일")).toBe("2026-01-05");
    expect(col("요금제")).toBe("5G");
    expect(col("담당")).toBe("김직원");
    expect(col("고객명")).toBe("홍길동");
    expect(header.length).toBe(row.length);
  });

  it("a send later reported failed reads '발송 실패', not '발송'", () => {
    const csv = historyToCsv([rec({ delivery: "failed", fail_reason: "신호 없음" })]);
    const [header, row] = parseCsv(csv);
    expect(row[header.indexOf("상태")]).toBe("발송 실패");
  });
});

describe("classifyShareError (audit 1-25: cancel is not a failure)", () => {
  it("Android 'Share canceled' rejection -> cancelled", () => {
    expect(classifyShareError(new Error("Share canceled"))).toBe("cancelled");
    expect(classifyShareError({ message: "Share cancelled" })).toBe("cancelled");
  });
  it("web navigator.share AbortError -> cancelled", () => {
    const e = new Error("The user aborted a request.");
    e.name = "AbortError";
    expect(classifyShareError(e)).toBe("cancelled");
  });
  it("Capacitor UNAVAILABLE / UNIMPLEMENTED -> unavailable", () => {
    expect(classifyShareError({ code: "UNAVAILABLE", message: "Share API not available in this browser" })).toBe("unavailable");
    expect(classifyShareError({ code: "UNIMPLEMENTED", message: "x" })).toBe("unavailable");
    expect(classifyShareError(new Error("Share API not available in this browser"))).toBe("unavailable");
  });
  it("anything else -> failed", () => {
    expect(classifyShareError(new Error("Can't share while sharing is in progress"))).toBe("failed");
    expect(classifyShareError("boom")).toBe("failed");
    expect(classifyShareError(undefined)).toBe("failed");
  });
});

describe("sanitizeRecord keeps send-result fields (a failed send must stay failed after restore)", () => {
  it("preserves delivery/fail_reason/sms_id when well-formed", () => {
    const r = sanitizeRecord({ ...rec(), delivery: "failed", fail_reason: "유심 없음", sms_id: "abc" });
    expect(r).toMatchObject({ delivery: "failed", fail_reason: "유심 없음", sms_id: "abc" });
  });
  it("drops an unknown delivery value; old records have none", () => {
    expect(sanitizeRecord({ ...rec(), delivery: "<b>" })!.delivery).toBeUndefined();
    expect(sanitizeRecord(rec())!).not.toHaveProperty("delivery");
  });
  it("keeps a known milestone source (#19 contract match) and drops anything else", () => {
    expect(sanitizeRecord({ ...rec(), source: "keepdate" })!.source).toBe("keepdate");
    expect(sanitizeRecord({ ...rec(), source: "term" })!.source).toBe("term");
    expect(sanitizeRecord({ ...rec(), source: "<b>" })!).not.toHaveProperty("source");
    expect(sanitizeRecord(rec())!).not.toHaveProperty("source");
  });
});

/* ---------------- P1 stage 2 ---------------- */
describe("missingFromBackup (1-22: key-difference restore guard)", () => {
  it("counts current dedup keys the backup does not carry (not just counts)", () => {
    const cur = [rec({ phone: "010-1", expiry_date: "2026-01-01" }), rec({ phone: "010-2", expiry_date: "2026-02-01" })];
    // Same size, completely different customers -> both current keys would be lost.
    const other = [rec({ phone: "010-8", expiry_date: "2026-01-01" }), rec({ phone: "010-9", expiry_date: "2026-02-01" })];
    expect(missingFromBackup(cur, other)).toBe(2);
    // A LARGER backup that still misses one current customer.
    expect(missingFromBackup(cur, [...other, rec({ phone: "010-1", expiry_date: "2026-01-01" })])).toBe(1);
  });
  it("normalizes phone format (hyphenated vs bare is the same customer)", () => {
    expect(missingFromBackup([rec({ phone: "010-1111-2222" })], [rec({ phone: "01011112222" })])).toBe(0);
  });
  it("is 0 for an empty store or a superset backup", () => {
    expect(missingFromBackup([], [rec()])).toBe(0);
    expect(missingFromBackup([rec()], [rec(), rec({ phone: "010-7" })])).toBe(0);
  });
});

describe("mergeHistory (restore = union by dueKey, never loses or downgrades a send)", () => {
  it("keeps current records the backup lacks and adds the backup's", () => {
    const out = mergeHistory([rec({ phone: "010-1" })], [rec({ phone: "010-2" })]);
    expect(out.map((r) => r.phone).sort()).toEqual(["010-1", "010-2"]);
  });
  it("one record per key; a real send beats a practice record either way", () => {
    const sms = rec({ channel: "sms", sent_at: "2025-12-01T09:00:00", body: "진짜" });
    const practice = rec({ channel: "record-only", sent_at: "2025-12-30T09:00:00", body: "연습" });
    expect(mergeHistory([sms], [practice])).toEqual([sms]);
    expect(mergeHistory([practice], [sms])).toEqual([sms]);
  });
  it("a failed send loses to a LATER real send; same rank -> newer sent_at wins", () => {
    const failed = rec({ delivery: "failed", fail_reason: "x", sent_at: "2025-12-01T09:00:00" });
    const ok = rec({ sent_at: "2025-12-30T09:00:00" });
    expect(mergeHistory([failed], [ok])).toEqual([ok]);
    expect(mergeHistory([ok], [failed])).toEqual([ok]);
    const older = rec({ sent_at: "2025-12-01T09:00:00", body: "old" });
    const newer = rec({ sent_at: "2025-12-02T09:00:00", body: "new" });
    expect(mergeHistory([older], [newer])).toEqual([newer]);
    expect(mergeHistory([newer], [older])).toEqual([newer]);
  });
  it("the device's failure outcome beats an OLDER backup copy of the unconfirmed send", () => {
    // backup taken right after the send (no result yet); the device later learned it failed
    const backup = rec({ sent_at: "2025-12-01T09:00:00", sms_id: "s1" });
    const current = rec({ sent_at: "2025-12-01T09:00:00", sms_id: "s1", delivery: "failed", fail_reason: "통신 오류" });
    expect(mergeHistory([current], [backup])).toEqual([current]);
    expect(mergeHistory([backup], [current])).toEqual([current]);
    // a failure newer than the backup's (unconfirmed) send also wins
    const newerFail = rec({ sent_at: "2025-12-05T09:00:00", delivery: "failed", fail_reason: "x" });
    expect(mergeHistory([newerFail], [backup])).toEqual([newerFail]);
  });
  it("a CONFIRMED delivery is never downgraded by a failed record", () => {
    const delivered = rec({ sent_at: "2025-12-01T09:00:00", sms_id: "s1", delivery: "delivered" });
    const failed = rec({ sent_at: "2025-12-05T09:00:00", sms_id: "s2", delivery: "failed", fail_reason: "x" });
    expect(mergeHistory([failed], [delivered])).toEqual([delivered]);
  });
  it("does not mutate its inputs", () => {
    const a = [rec({ phone: "010-1" })];
    const b = [rec({ phone: "010-2" })];
    mergeHistory(a, b);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe("test_phone is device-local (L5: never exported, never restored)", () => {
  it("buildBackup strips test_phone from the exported config", () => {
    const b = buildBackup({ poncle_base_url: "https://m.poncle.co.kr", test_phone: "010-5555-0000" } as never, [], "x");
    expect(b.config).not.toHaveProperty("test_phone");
  });
  it("parseBackup drops a test_phone carried by an old backup", () => {
    const parsed = parseBackup(JSON.stringify({ app: "poncle-expiry", history: [], config: { deliver_alerts: true, test_phone: "010-9" } }));
    expect(parsed!.config).not.toHaveProperty("test_phone");
    expect((parsed!.config as unknown as Record<string, unknown>).deliver_alerts).toBe(true);
  });
});

describe("backup carries 미방문 제외 + 재방문 코호트 (#55)", () => {
  const cohortA = { phone: "010-1111-2222", expiry: "2026-05-01", informed: true, revisited: false, firstSeen: "2026-05-02" };

  it("buildBackup includes the exclusion keys and the cohort log; parseBackup round-trips them", () => {
    const b = buildBackup(null, [], "x", { excluded: new Set(["01011112222|2026-05-01"]), cohort: [cohortA] });
    expect(b.excluded).toEqual(["01011112222|2026-05-01"]);
    expect(b.cohort).toEqual([cohortA]);
    const parsed = parseBackup(JSON.stringify(b))!;
    expect(parsed.excluded).toEqual(["01011112222|2026-05-01"]);
    expect(parsed.cohort).toEqual([cohortA]);
  });

  it("an older backup without them parses with empty lists (nothing to merge)", () => {
    const parsed = parseBackup(JSON.stringify({ app: "poncle-expiry", history: [] }))!;
    expect(parsed.excluded).toEqual([]);
    expect(parsed.cohort).toEqual([]);
  });

  it("parseBackup normalizes exclusion keys and drops malformed ones", () => {
    const parsed = parseBackup(JSON.stringify({
      app: "poncle-expiry", history: [],
      excluded: ["010-3333-4444|2026-06-01", "garbage", "|2026-01-01", "01011112222|26-01-01", 7, null, "01011112222|2026-05-01"],
    }))!;
    expect(parsed.excluded).toEqual(["01033334444|2026-06-01", "01011112222|2026-05-01"]);
  });

  it("parseBackup keeps only well-typed cohort entries (no truthy 'false' strings)", () => {
    const parsed = parseBackup(JSON.stringify({
      app: "poncle-expiry", history: [],
      cohort: [
        cohortA,
        { ...cohortA, phone: "010-9", informed: "false" },
        { ...cohortA, expiry: "soon" },
        { phone: "", expiry: "2026-05-01", informed: true, revisited: true, firstSeen: "x" },
        "junk",
        { phone: "010-5555-6666", expiry: "2026-04-01", informed: false, revisited: true },
      ],
    }))!;
    expect(parsed.cohort).toEqual([
      cohortA,
      { phone: "010-5555-6666", expiry: "2026-04-01", informed: false, revisited: true, firstSeen: "2026-04-01" },
    ]);
  });

  it("excludedKeysToAdd: only the backup's keys this phone doesn't have (format-insensitive)", () => {
    const current = new Set(["01011112222|2026-05-01"]);
    expect(excludedKeysToAdd(current, ["01011112222|2026-05-01", "01033334444|2026-06-01"])).toEqual(["01033334444|2026-06-01"]);
    expect(excludedKeysToAdd(new Set(["010-1111-2222|2026-05-01"]), ["01011112222|2026-05-01"])).toEqual([]);
  });

  it("mergeCohort: union by phone|expiry; flags OR-ed, earliest firstSeen; inputs untouched", () => {
    const cur = [{ ...cohortA, informed: false, revisited: true, firstSeen: "2026-05-10" }];
    const inc = [{ ...cohortA, phone: "01011112222" }, { ...cohortA, phone: "010-7777-8888" }];
    const out = mergeCohort(cur, inc);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ ...cohortA, informed: true, revisited: true, firstSeen: "2026-05-02" });
    expect(out[1].phone).toBe("010-7777-8888");
    expect(cur[0].informed).toBe(false);
  });
});

describe("sanitizeRecord keeps the first-send fields (#57)", () => {
  it("keeps a string first_sent_at and a positive integer send_count; drops junk", () => {
    expect(sanitizeRecord({ ...rec(), first_sent_at: "2025-01-01T09:00:00", send_count: 3 }))
      .toMatchObject({ first_sent_at: "2025-01-01T09:00:00", send_count: 3 });
    const bad = sanitizeRecord({ ...rec(), first_sent_at: 5, send_count: "3" })!;
    expect(bad).not.toHaveProperty("first_sent_at");
    expect(bad).not.toHaveProperty("send_count");
  });
});

describe("backup keeps the L3 / #57 fields exactly as the domain stores them", () => {
  const base = { phone: "010-1111-2222", expiry: "2026-09-01", informed: true, revisited: true, firstSeen: "2026-09-01" };

  it("parseBackup keeps a well-formed cohort resolvedOn (early re-contract), drops a malformed one", () => {
    const parsed = parseBackup(JSON.stringify({
      app: "poncle-expiry", history: [],
      cohort: [{ ...base, resolvedOn: "2026-06-10" }, { ...base, phone: "010-3333-4444", resolvedOn: "soon" }],
    }))!;
    expect(parsed.cohort[0]).toEqual({ ...base, resolvedOn: "2026-06-10" });
    expect(parsed.cohort[1]).not.toHaveProperty("resolvedOn");
  });

  it("mergeCohort keeps resolvedOn from either side (earliest wins)", () => {
    const out = mergeCohort([{ ...base }], [{ ...base, resolvedOn: "2026-06-10" }]);
    expect(out[0].resolvedOn).toBe("2026-06-10");
    const both = mergeCohort([{ ...base, resolvedOn: "2026-07-01" }], [{ ...base, resolvedOn: "2026-06-10" }]);
    expect(both[0].resolvedOn).toBe("2026-06-10");
  });

  it("sanitizeRecord accepts send_count 0 (a rolled-back resend) like history.sanitizeSendStats", () => {
    expect(sanitizeRecord({ ...rec(), send_count: 0 })).toMatchObject({ send_count: 0 });
    expect(sanitizeRecord({ ...rec(), send_count: -1 })).not.toHaveProperty("send_count");
    expect(sanitizeRecord({ ...rec(), send_count: 1.5 })).not.toHaveProperty("send_count");
  });
});
