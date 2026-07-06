import { describe, expect, it } from "vitest";
import {
  buildBackup,
  historyToCsv,
  isAllowedPoncleBaseUrl,
  parseBackup,
  restoreLosesHistory,
  sanitizeRecord,
} from "../src/domain/export";
import type { SentRecord } from "../src/domain/history";

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

  it("strips a non-poncle poncle_base_url from a restored config", () => {
    const backup = {
      app: "poncle-expiry",
      history: [rec()],
      config: { poncle_base_url: "https://evil.example.com", deliver_alerts: true },
    };
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed!.config).not.toBeNull();
    expect((parsed!.config as unknown as Record<string, unknown>).poncle_base_url).toBeUndefined();
    // other config keys survive
    expect((parsed!.config as unknown as Record<string, unknown>).deliver_alerts).toBe(true);
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

describe("restoreLosesHistory (guard a full-replace restore)", () => {
  it("flags a restore that shrinks or wipes a non-empty history", () => {
    expect(restoreLosesHistory(10, 0)).toBe(true); // empty/wrong file over real data
    expect(restoreLosesHistory(10, 3)).toBe(true); // fewer records
  });
  it("allows a growing/equal restore and any restore over an empty store", () => {
    expect(restoreLosesHistory(10, 10)).toBe(false);
    expect(restoreLosesHistory(10, 25)).toBe(false);
    expect(restoreLosesHistory(0, 0)).toBe(false); // nothing to lose
  });
});

describe("historyToCsv", () => {
  it("prefixes a BOM and escapes commas/quotes/newlines", () => {
    const csv = historyToCsv([rec({ customer: 'A,B"C', body: "line1\nline2" })]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"A,B""C"');
    expect(csv).toContain('"line1\nline2"');
  });
});
