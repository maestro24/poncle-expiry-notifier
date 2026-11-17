/**
 * Stage R3 (re-audit 2026-11-17, '3) 개선 제안' + '2) 가능성 높음') domain items:
 * I1 (upgrade catch-up anchor), I3 (catchUpCapped), I8 (Korean aliases + loose
 * token warning), I9 (backup template schema + restore facts), I11 (CSV columns),
 * I12 (sent_log size), U1 (latestOpenByPhone date compare), U2 (legacy 제외 keys).
 */
import { describe, expect, it } from "vitest";
import { DEFAULTS, TEMPLATE_SCHEMA_VERSION, restoreConfig } from "../src/domain/config";
import { CATCH_UP_MAX_DAYS, catchUpAnchor, catchUpCapped, isNewerOpenRow } from "../src/domain/expiry";
import * as exportMod from "../src/domain/export";
import { buildBackup, historyToCsv, parseBackup, restoreFacts } from "../src/domain/export";
import {
  History,
  SENT_LOG_WARN_BYTES,
  sentLogSizeWarning,
  utf8ByteLength,
  type KV,
  type SentRecord,
} from "../src/domain/history";
import { makeDate } from "../src/domain/plaindate";
import { PoncleClient } from "../src/domain/poncle-client";
import { runScan } from "../src/domain/scan";
import { KOREAN_TOKEN_ALIASES, TEMPLATE_VAR_CHIPS, renderTemplate, unknownTemplateTokens } from "../src/domain/sender";
import type { AppConfig, DueItem, MessageTemplate, PoncleRow } from "../src/domain/types";
import { latestOpenByPhone } from "../src/domain/unvisited";

function memKV(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}
const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over });
const TODAY = makeDate(2026, 11, 17);
const NOFILTER = { use_server_date_filter: false, notify_offsets_days: [0] };

const open = (phone: string, opendate: string, over: Partial<PoncleRow> = {}): PoncleRow => ({
  openphone: phone, customer: "고객", opendate, openhowx: "기변", telecomx: "KT",
  agencytitle: "CD대리점", model: "m", ...over,
});
function gw(rows: PoncleRow[], pending: PoncleRow[] = []) {
  return {
    check: async () => true,
    listOpen: async () => ({ ok: true, total: rows.length, list: rows }),
    listPending: async () => ({ ok: true, total: pending.length, list: pending }),
  };
}
const rec = (over: Partial<SentRecord> = {}): SentRecord => ({
  phone: "010-1234-5678", customer: "홍길동", opendate: "2024-01-05", expiry_date: "2026-01-05",
  milestone_offset: 0, telecom: "KT", agency: "강남점", plan: "5G", model: "갤럭시", openhow: "기변",
  staff: "", channel: "sms", sent_at: "2025-12-20T10:30:00", body: "안녕하세요", ...over,
});
const item = (over: Partial<DueItem> = {}): DueItem => ({
  id: "", phone: "010-1111-2222", customer: "홍길동", opendate: "24-11-17", expiry_date: "2026-11-17",
  milestone_offset: 0, telecom: "KT", agency: "강남점", openhow: "기변", plan: "", model: "", staff: "김직원",
  already_sent: false, source: "term", ...over,
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

/* ---------------- I1: first scan after the upgrade ---------------- */
describe("I1 catchUpAnchor falls back to the legacy 'M/D HH:MM' last_scan_at", () => {
  it("recorded anchors still win (clean, then scan date)", () => {
    expect(catchUpAnchor("2026-11-10", "2026-11-12", "11/16 09:00", TODAY)).toBe("2026-11-10");
    expect(catchUpAnchor("", "2026-11-12", "11/16 09:00", TODAY)).toBe("2026-11-12");
  });
  it("v1.2.16 upgrade: only the display label exists -> its day (this year)", () => {
    expect(catchUpAnchor("", "", "11/10 18:42", TODAY)).toBe("2026-11-10");
    expect(catchUpAnchor("", "", "11/17 08:00", TODAY)).toBe("2026-11-17");
  });
  it("a label later in the calendar than today is last year's", () => {
    expect(catchUpAnchor("", "", "12/30 10:00", makeDate(2027, 1, 5))).toBe("2026-12-30");
  });
  it("an unreadable legacy label -> the full catch-up window", () => {
    expect(catchUpAnchor("", "", "어제", TODAY)).toBe("2026-11-03");
    expect(catchUpAnchor("", "", "2/30 10:00", TODAY)).toBe("2026-11-03");
    expect(CATCH_UP_MAX_DAYS).toBe(14);
  });
  it("never scanned (fresh install) -> no catch-up", () => {
    expect(catchUpAnchor("", "", "", TODAY)).toBe("");
    expect(catchUpAnchor("", "")).toBe(""); // the old 2-arg call still works
  });
  it("runScan from a legacy anchor surfaces the milestone that passed after the last scan", async () => {
    const row = open("010-6666-7777", "26-05-14", { openhowx: "유심신규" }); // +6개월 = 2026-11-14
    const since = catchUpAnchor("", "", "11/12 09:00", TODAY);
    const res = await runScan(gw([row]), cfg(NOFILTER), new History(memKV()), TODAY, { sinceDate: since });
    expect(res.results.map((r) => [r.expiry_date, r.milestone_offset])).toEqual([["2026-11-14", -3]]);
  });
});

/* ---------------- I3: catch-up cap reached ---------------- */
describe("I3 catchUpCapped", () => {
  it("true only when the anchor is older than the 14-day cap", () => {
    expect(catchUpCapped("2026-11-03", TODAY)).toBe(false); // exactly 14 days
    expect(catchUpCapped("2026-11-02", TODAY)).toBe(true);
    expect(catchUpCapped("", TODAY)).toBe(false);
    expect(catchUpCapped("2026-12-01", TODAY)).toBe(false);
  });
  it("runScan reports it on an ok scan", async () => {
    const h = () => new History(memKV());
    const long = await runScan(gw([]), cfg(NOFILTER), h(), TODAY, { sinceDate: "2026-10-01" });
    expect(long.status).toBe("ok");
    expect(long.catchUpCapped).toBe(true);
    const short = await runScan(gw([]), cfg(NOFILTER), h(), TODAY, { sinceDate: "2026-11-15" });
    expect(short.catchUpCapped).toBe(false);
    const none = await runScan(gw([]), cfg(NOFILTER), h(), TODAY);
    expect(none.catchUpCapped).toBe(false);
  });
});

/* ---------------- I8: Korean aliases + chips + loose tokens ---------------- */
describe("I8 template variables", () => {
  it("{담당}/{거래처}/{전화번호} render like {staff}/{agency}/{phone}", () => {
    expect(KOREAN_TOKEN_ALIASES["담당"]).toBe("staff");
    expect(KOREAN_TOKEN_ALIASES["거래처"]).toBe("agency");
    expect(KOREAN_TOKEN_ALIASES["전화번호"]).toBe("phone");
    const out = renderTemplate(item(), "{고객명} {담당} {거래처} {전화번호}", TODAY);
    expect(out).toBe("홍길동 김직원 강남점 010-1111-2222");
    expect(unknownTemplateTokens("{담당} {거래처} {전화번호}")).toEqual([]);
  });
  it("chips insert the Korean token, and every chip is a known alias", () => {
    const labels = TEMPLATE_VAR_CHIPS.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(["고객명", "담당", "거래처", "전화번호", "경과년수"]));
    for (const c of TEMPLATE_VAR_CHIPS) {
      expect(c.token).toBe(`{${c.label}}`);
      expect(KOREAN_TOKEN_ALIASES[c.label]).toBeTruthy();
    }
  });
  it("warns on tokens with spaces or full-width braces (they never fill)", () => {
    expect(unknownTemplateTokens("{ 고객명 } 님")).toEqual(["{ 고객명 }"]);
    expect(unknownTemplateTokens("｛고객명｝ 님 {customer}")).toEqual(["｛고객명｝"]);
    expect(unknownTemplateTokens("{고객명}님 {고객 명}")).toEqual(["{고객 명}"]);
    // known tokens and the old cases are unchanged
    expect(unknownTemplateTokens("{고객명} {이름} {customer} {foo} {이름} {agency}")).toEqual(["{이름}", "{foo}"]);
    expect(unknownTemplateTokens("안녕하세요 {customer}고객님")).toEqual([]);
  });
});

/* ---------------- I9: backup template schema + restore facts ---------------- */
describe("I9 backup records the template schema; restore facts", () => {
  const userTpl: MessageTemplate = { id: "u1", name: "내 문구", body: "{고객명}님", telecoms: [], statuses: [] } as MessageTemplate;
  it("buildBackup stamps template_schema; parseBackup reads it (absent -> 0)", () => {
    const b = buildBackup(cfg(), [], "2026-11-17T09:00:00");
    expect(b.template_schema).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(parseBackup(JSON.stringify(b))!.template_schema).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(parseBackup(JSON.stringify({ app: "poncle-expiry", history: [] }))!.template_schema).toBe(0);
    expect(parseBackup(JSON.stringify({ app: "poncle-expiry", history: [], template_schema: "x" }))!.template_schema).toBe(0);
  });
  it("a schema-2 backup keeps source-less user templates (no defaults brought back, L9)", () => {
    // A config without keepdate_default_months would read as pre-v2 on its own.
    const raw = { templates: [userTpl] };
    const legacy = restoreConfig(raw, cfg()).config.templates.map((t) => t.id);
    expect(legacy.length).toBeGreaterThan(1); // pre-v2 heuristic appends the defaults
    const v2 = restoreConfig(raw, cfg(), { templateSchema: TEMPLATE_SCHEMA_VERSION }).config.templates.map((t) => t.id);
    expect(v2).toEqual(["u1"]);
  });
  it("restoreFacts summarizes what the restore changes", () => {
    const backup = parseBackup(JSON.stringify(buildBackup(
      cfg({ templates: [userTpl], deliver_alerts: false }), [rec(), rec({ phone: "010-9" })], "2026-11-01T10:00:00",
    )))!;
    const current = [rec({ phone: "010-7777-8888" })];
    const facts = restoreFacts(backup, current, cfg({ templates: [], deliver_alerts: true }));
    expect(facts).toMatchObject({
      exportedAt: "2026-11-01T10:00:00",
      backupHistory: 2,
      currentHistory: 1,
      missing: 1,
      templatesBefore: 0,
      templatesAfter: 1,
      templatesChanged: true,
      deliverBefore: true,
      deliverAfter: false,
      templateSchema: TEMPLATE_SCHEMA_VERSION,
    });
  });
  it("restoreFacts: a file without settings changes no settings", () => {
    const backup = parseBackup(JSON.stringify(buildBackup(null, [], "x")))!;
    const facts = restoreFacts(backup, [], cfg({ deliver_alerts: true }));
    expect(facts.templatesAfter).toBeNull();
    expect(facts.deliverAfter).toBeNull();
    expect(facts.templatesChanged).toBe(false);
  });
});

/* ---------------- I11: CSV columns ---------------- */
describe("I11 historyToCsv adds 구분 / 실패 사유 / 발송 횟수", () => {
  it("fills the new columns from the record", () => {
    const csv = historyToCsv([
      rec({ source: "term", send_count: 3, first_sent_at: "2025-12-01T10:00:00" }),
      rec({ source: "manual", delivery: "failed", fail_reason: "신호 없음" }),
      rec({ source: "keepdate", channel: "record-only" }),
      rec({ resend_fail_reason: "유심 없음" }),
    ]);
    const [header, a, b, c, d] = parseCsv(csv);
    const col = (row: string[], name: string) => row[header.indexOf(name)];
    expect(header).toEqual(expect.arrayContaining(["구분", "실패 사유", "발송 횟수"]));
    expect([col(a, "구분"), col(a, "발송 횟수"), col(a, "실패 사유")]).toEqual(["약정 만료", "3", ""]);
    expect([col(b, "구분"), col(b, "발송 횟수"), col(b, "실패 사유")]).toEqual(["직접 입력", "0", "신호 없음"]);
    expect([col(c, "구분"), col(c, "발송 횟수")]).toEqual(["요금제 유지", "0"]);
    expect([col(d, "구분"), col(d, "발송 횟수"), col(d, "실패 사유")]).toEqual(["", "1", "재발송 실패: 유심 없음"]);
    for (const row of [a, b, c, d]) expect(row.length).toBe(header.length);
  });
  it("the unused restoreLosesHistory is gone", () => {
    expect("restoreLosesHistory" in exportMod).toBe(false);
  });
});

/* ---------------- I12: sent_log size ---------------- */
describe("I12 sent_log size helpers", () => {
  it("utf8ByteLength counts Korean as 3 bytes", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("고객")).toBe(6);
    expect(utf8ByteLength("😀")).toBe(4);
  });
  it("History.storageBytes measures the stored sent_log", async () => {
    const kv = memKV();
    const h = new History(kv);
    expect(await h.storageBytes()).toBe(0);
    const { channel: _c, sent_at: _s, ...entry } = rec();
    await h.recordSent(entry, "sms", "2026-11-17T09:00:00");
    expect(await h.storageBytes()).toBe(utf8ByteLength(kv.m.get("sent_log")!));
  });
  it("warning text appears only past the threshold", () => {
    expect(SENT_LOG_WARN_BYTES).toBe(2 * 1024 * 1024);
    expect(sentLogSizeWarning(SENT_LOG_WARN_BYTES)).toBeNull();
    const w = sentLogSizeWarning(SENT_LOG_WARN_BYTES + 1);
    expect(w).toContain("2.0MB");
    expect(w).toContain("백업");
  });
});

/* ---------------- U1: latestOpenByPhone by parsed date ---------------- */
describe("U1 latestOpenByPhone compares parsed dates, order-independently", () => {
  it("mixed yy-mm-dd / yyyy-mm-dd picks the real latest either way round", () => {
    // As raw strings "26-03-01" > "2026-05-01" — the old compare picked the OLDER row.
    const a = open("010-1111-2222", "2026-05-01", { customer: "A" });
    const b = open("010-1111-2222", "26-03-01", { customer: "B" });
    expect(latestOpenByPhone([a, b]).get("01011112222")?.customer).toBe("A");
    expect(latestOpenByPhone([b, a]).get("01011112222")?.customer).toBe("A");
  });
  it("same day: the higher Poncle idx wins regardless of order", () => {
    const a = open("010-1111-2222", "2026-03-01", { customer: "A", idx: "120" });
    const b = open("010-1111-2222", "26-03-01", { customer: "B", idx: "95" });
    expect(latestOpenByPhone([a, b]).get("01011112222")?.customer).toBe("A");
    expect(latestOpenByPhone([b, a]).get("01011112222")?.customer).toBe("A");
  });
  it("a parseable date beats an unparseable one", () => {
    const bad = open("010-1111-2222", "??", { customer: "X" });
    const ok = open("010-1111-2222", "24-01-01", { customer: "Y" });
    expect(latestOpenByPhone([bad, ok]).get("01011112222")?.customer).toBe("Y");
    expect(latestOpenByPhone([ok, bad]).get("01011112222")?.customer).toBe("Y");
    expect(isNewerOpenRow(ok, bad)).toBe(true);
    expect(isNewerOpenRow(bad, ok)).toBe(false);
  });
  it("PoncleClient.fetchOpenByPhone uses the same rule", async () => {
    const rows = [open("010-1111-2222", "2026-05-01", { customer: "A" }), open("010-1111-2222", "26-03-01", { customer: "B" })];
    const client = new PoncleClient(gw(rows), cfg());
    expect((await client.fetchOpenByPhone("010-1111-2222"))?.customer).toBe("A");
  });
});

/* ---------------- U2: legacy hyphenated 제외 keys ---------------- */
describe("U2 legacy hyphenated exclusion keys are normalized everywhere", () => {
  const u = (expiry: string, opendate = "24-05-01") => ({ phone: "01011112222", expiry_date: expiry, opendate });
  it("a hyphenated key matches a digits-only target and gains its contract key", async () => {
    const kv = memKV();
    kv.m.set("unvisited_handled", JSON.stringify(["010-1111-2222|2026-05-01"]));
    kv.m.set("unvisited_cache", JSON.stringify([{ ...item({ phone: "010-1111-2222", expiry_date: "2026-05-01", opendate: "24-05-01" }), id: "x" }]));
    const h = new History(kv);
    expect(await h.isHandled(u("2026-05-01"))).toBe(true);
    expect(await h.migrateLegacyExclusions()).toBe(1);
    expect(await h.isHandled(u("2026-06-01"))).toBe(true);
  });
  it("un-excluding clears the hyphenated legacy key", async () => {
    const kv = memKV();
    kv.m.set("unvisited_handled", JSON.stringify(["010-1111-2222|2026-05-01"]));
    const h = new History(kv);
    await h.setHandled("01011112222", "2026-05-01", false);
    expect(await h.isHandled(u("2026-05-01"))).toBe(false);
    expect((await h.handledKeys()).size).toBe(0);
  });
});
