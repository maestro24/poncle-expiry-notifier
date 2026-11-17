import { afterEach, describe, expect, it, vi } from "vitest";
import { cohortStats, updateCohort } from "../src/domain/cohort";
import { DEFAULTS } from "../src/domain/config";
import { entryFromRow, field } from "../src/domain/due-item";
import { History, SentIndex, type KV, type SentRecord } from "../src/domain/history";
import { buildLookupResults } from "../src/domain/lookup";
import { makeDate } from "../src/domain/plaindate";
import { runScan } from "../src/domain/scan";
import {
  isValidKrMobile,
  normalizeKrMobile,
  renderTemplate,
  sendAlert,
  templateNeedsOpendate,
  unknownTemplateTokens,
} from "../src/domain/sender";
import { matchingTemplates } from "../src/domain/template-match";
import type { AppConfig, DueItem, MessageTemplate, PoncleRow } from "../src/domain/types";
import { checkForUpdate } from "../src/domain/updater";

function memKV(): KV {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}
const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over });
const TODAY = makeDate(2026, 7, 3);
const rec = (over: Partial<SentRecord> = {}): SentRecord => ({
  phone: "010-1111-2222", customer: "고객", opendate: "24-07-03", expiry_date: "2026-07-03",
  milestone_offset: 0, telecom: "KT", agency: "", plan: "", model: "", openhow: "기변", staff: "",
  channel: "sms", sent_at: "2026-07-03T09:00:00", ...over,
});
const item = (over: Partial<DueItem> = {}): DueItem => ({
  id: "", phone: "010-1111-2222", customer: "홍길동", opendate: "24-07-03", expiry_date: "2026-07-03",
  milestone_offset: 0, telecom: "SK텔레콤", agency: "PS&M", openhow: "기변", plan: "5G 요금제",
  model: "Galaxy S", staff: "", already_sent: false, ...over,
});

/* ---------------- #31 HTML entities decoded once at the data boundary ---------------- */
describe("#31 HTML entities", () => {
  it("field() decodes entities", () => {
    expect(field({ agencytitle: "PS&amp;M" }, "agencytitle")).toBe("PS&M");
    expect(field({ plan: "넷플릭스&amp;웨이브 " }, "plan")).toBe("넷플릭스&웨이브");
  });
  it("field() decodes exactly once (no double-decode)", () => {
    expect(field({ agencytitle: "A&amp;amp;B" }, "agencytitle")).toBe("A&amp;B");
  });
  it("entryFromRow yields clean agency/plan/customer", () => {
    const e = entryFromRow(
      { openphone: "010-1", customer: "김&#39;s", agencytitle: "PS&amp;M", plan: "넷플릭스&amp;웨이브", opendate: "24-07-03" },
      0,
      makeDate(2026, 7, 3),
    );
    expect(e.agency).toBe("PS&M");
    expect(e.plan).toBe("넷플릭스&웨이브");
    expect(e.customer).toBe("김's");
  });
  it("lookup rows are decoded", () => {
    const rows: PoncleRow[] = [
      { openphone: "010-1111-2222", customer: "홍", opendate: "25-01-01", openhowx: "기변", agencytitle: "PS&amp;M", plan: "A&amp;B" },
    ];
    const out = buildLookupResults(rows, cfg(), TODAY, 30, new Map());
    expect(out[0].agency).toBe("PS&M");
    expect(out[0].plan).toBe("A&B");
  });
  it("SMS {agency}/{plan} render clean text", () => {
    const e = entryFromRow({ openphone: "010-1", agencytitle: "PS&amp;M", plan: "A&amp;B", opendate: "24-07-03" }, 0, TODAY);
    expect(renderTemplate(e, "{agency}/{plan}", TODAY)).toBe("PS&M/A&B");
  });
});

/* ---------------- #34 update check error state ---------------- */
describe("#34 checkForUpdate error vs no-update", () => {
  afterEach(() => vi.unstubAllGlobals());
  const okJson = (data: unknown) => ({ ok: true, status: 200, json: async () => data });

  it("HTTP error -> available:false with error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    const u = await checkForUpdate("1.0.0");
    expect(u.available).toBe(false);
    expect(u.error).toBeTruthy();
    expect(u.error).toContain("403");
  });
  it("offline (fetch rejects) -> error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const u = await checkForUpdate("1.0.0");
    expect(u.available).toBe(false);
    expect(u.error).toBeTruthy();
  });
  it("unparseable / non-array body -> error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ message: "rate limited" })));
    expect((await checkForUpdate("1.0.0")).error).toBeTruthy();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })));
    expect((await checkForUpdate("1.0.0")).error).toBeTruthy();
  });
  it("clean 'no update' has no error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson([{ tag_name: "android-v1.0.0", assets: [] }])));
    const u = await checkForUpdate("1.0.0");
    expect(u.available).toBe(false);
    expect(u.error).toBeUndefined();
  });
});

/* ---------------- #36 most specific template first ---------------- */
describe("#36 matchingTemplates specificity", () => {
  const tpl = (over: Partial<MessageTemplate>): MessageTemplate =>
    ({ id: "t", name: "t", body: "b", telecoms: [], statuses: [], sources: [], ...over }) as MessageTemplate;
  it("more conditions first; ties keep list order", () => {
    const wild = tpl({ id: "wild" });
    const termOnly = tpl({ id: "termOnly", sources: ["term"] });
    const skt = tpl({ id: "skt", telecoms: ["SK텔레콤"] });
    const sktGi = tpl({ id: "sktGi", telecoms: ["SK텔레콤"], statuses: ["기변"] });
    const out = matchingTemplates({ telecom: "SK텔레콤", openhow: "기변", source: "term" }, [wild, termOnly, skt, sktGi]);
    expect(out.map((t) => t.id)).toEqual(["sktGi", "termOnly", "skt", "wild"]);
  });
  it("does not mutate the input list", () => {
    const list = [tpl({ id: "a" }), tpl({ id: "b", telecoms: ["KT"] })];
    matchingTemplates({ telecom: "KT" }, list);
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

/* ---------------- #38 Korean placeholder aliases ---------------- */
describe("#38 Korean template aliases", () => {
  it("renders every Korean alias like its English token", () => {
    const it2 = item({ opendate: "24-07-03" });
    const ko = renderTemplate(it2, "{고객명}|{통신사}|{모델}|{만료일}|{개통일}|{시점}|{요금제}|{경과개월}|{경과년수}", makeDate(2026, 7, 5));
    const en = renderTemplate(it2, "{customer}|{telecom}|{model}|{expiry}|{opendate}|{when}|{plan}|{months}|{years}", makeDate(2026, 7, 5));
    expect(ko).toBe(en);
    expect(ko.startsWith("홍길동|SK텔레콤|Galaxy S|2026-07-03|24-07-03|")).toBe(true);
  });
  it("Korean elapsed tokens need opendate (marker when unknown)", () => {
    expect(templateNeedsOpendate("{경과개월}개월")).toBe(true);
    expect(templateNeedsOpendate("{경과년수}년")).toBe(true);
    expect(renderTemplate(item({ opendate: "" }), "{경과개월}", TODAY)).toBe("(개통일 확인 필요)");
  });
  it("unknownTemplateTokens lists unknown {tokens} once, in order", () => {
    expect(unknownTemplateTokens("{고객명} {이름} {customer} {foo} {이름} {agency}")).toEqual(["{이름}", "{foo}"]);
    expect(unknownTemplateTokens("안녕하세요 {customer}고객님")).toEqual([]);
    expect(unknownTemplateTokens("")).toEqual([]);
  });
});

/* ---------------- #40 Korean mobile validation ---------------- */
describe("#40 isValidKrMobile", () => {
  it("accepts Korean mobiles (hyphens, +82)", () => {
    for (const p of ["010-1234-5678", "01012345678", "011-123-4567", "016 1234 5678", "+82 10-1234-5678", "+82-010-1234-5678", "821012345678"])
      expect(isValidKrMobile(p), p).toBe(true);
  });
  it("rejects junk / too long / landlines", () => {
    for (const p of ["", "010-1", "0101234567890123456789", "02-123-4567", "012-1234-5678", "abc", "1012345678"])
      expect(isValidKrMobile(p), p).toBe(false);
  });
  it("normalizeKrMobile", () => {
    expect(normalizeKrMobile("+82 10-1234-5678")).toBe("01012345678");
    expect(normalizeKrMobile("010-1234-5678")).toBe("01012345678");
    expect(normalizeKrMobile("010-1")).toBe("");
  });
  it("sendAlert refuses an invalid number before sending SMS", async () => {
    const history = new History(memKV());
    const sendSms = vi.fn(async () => undefined);
    const res = await sendAlert(item({ phone: "0101234567890123456789" }), cfg({ deliver_alerts: true }), { history, sendSms, nowIso: () => "2026-07-03T09:00:00" }, "본문");
    expect(res.status).toBe("error");
    expect(res.error).toContain("번호");
    expect(sendSms).not.toHaveBeenCalled();
  });
});

/* ---------------- #45 cohort: real sends only + early re-contract ---------------- */
describe("#45 cohort informed = real sms only; early re-contract included", () => {
  it("SentIndex.sentKeySet excludes skipped / record-only / failed", () => {
    const idx = new SentIndex([
      rec({ phone: "010-1", channel: "sms" }),
      rec({ phone: "010-2", channel: "skipped" }),
      rec({ phone: "010-3", channel: "record-only" }),
      rec({ phone: "010-4", channel: "sms", delivery: "failed" }),
    ]);
    expect(Array.from(idx.sentKeySet())).toEqual(["0101|2026-07-03"]);
    expect(idx.sentRecords().map((r) => r.phone)).toEqual(["010-1"]);
  });

  it("updateCohort adds an informed customer who re-contracted after the send", () => {
    const sends = [rec({ phone: "010-5", opendate: "24-06-10", expiry_date: "2026-06-10", sent_at: "2026-06-01T10:00:00" })];
    const open = [
      { openphone: "010-5", opendate: "24-06-10" },
      { openphone: "010-5", opendate: "26-06-05" },
    ];
    const out = updateCohort([], [], open, new Set(), TODAY, 90, sends);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ phone: "010-5", expiry: "2026-06-10", informed: true, revisited: true });
    expect(cohortStats(out, TODAY, 90).informedRate).toBe(100);
  });

  it("no new 개통 after the send -> not added by the send path", () => {
    const sends = [rec({ phone: "010-5", opendate: "24-06-10", expiry_date: "2026-06-10", sent_at: "2026-06-01T10:00:00" })];
    const out = updateCohort([], [], [{ openphone: "010-5", opendate: "24-06-10" }], new Set(), TODAY, 90, sends);
    expect(out).toEqual([]);
  });

  it("runScan: a skipped (발송 안 함) 미방문 customer is NOT informed; early re-contract is", async () => {
    const h = new History(memKV());
    // A: 기변 24-05-01 -> 만료 2026-05-01 (expired, not returned) — staff skipped it
    await h.putRecord(rec({ phone: "010-1111-2222", opendate: "24-05-01", expiry_date: "2026-05-01", channel: "skipped", sent_at: "2026-04-28T09:00:00" }));
    // B: 기변 24-06-10 -> 만료 2026-06-10; alerted 06-01, re-contracted 06-05 (before expiry)
    await h.putRecord(rec({ phone: "010-5555-6666", opendate: "24-06-10", expiry_date: "2026-06-10", sent_at: "2026-06-01T09:00:00" }));
    const rows: PoncleRow[] = [
      { openphone: "010-1111-2222", customer: "A", opendate: "24-05-01", openhowx: "기변", telecomx: "KT" },
      { openphone: "010-5555-6666", customer: "B", opendate: "24-06-10", openhowx: "기변", telecomx: "KT" },
      { openphone: "010-5555-6666", customer: "B", opendate: "26-06-05", openhowx: "기변", telecomx: "KT" },
    ];
    const gw = {
      check: async () => true,
      listOpen: async () => ({ ok: true, total: rows.length, list: rows }),
      listPending: async () => ({ ok: true, total: 0, list: [] }),
    };
    const res = await runScan(gw, cfg({ use_server_date_filter: false }), h, TODAY);
    expect(res.status).toBe("ok");
    const cohort = await h.loadCohort();
    const a = cohort.find((e) => e.phone === "010-1111-2222");
    const b = cohort.find((e) => e.phone === "010-5555-6666");
    expect(a?.informed).toBe(false);
    expect(b).toMatchObject({ informed: true, revisited: true, expiry: "2026-06-10" });
  });

  it("migrateCohortInformed drops informed backed only by a skip", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-2", expiry_date: "2026-06-01", channel: "skipped" }));
    await h.saveCohort([{ phone: "010-2", expiry: "2026-06-01", informed: true, revisited: false, firstSeen: "2026-06-02" }]);
    expect(await h.migrateCohortInformed()).toBe(1);
    expect((await h.loadCohort())[0].informed).toBe(false);
  });
});

/* ---------------- #46 history search by phone digits ---------------- */
describe("#46 history search normalizes phone", () => {
  it("matches regardless of hyphens", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-1111-2222", customer: "홍길동" }));
    await h.putRecord(rec({ phone: "01033334444", customer: "김철수", expiry_date: "2026-07-04" }));
    expect((await h.search("01011112222")).map((r) => r.customer)).toEqual(["홍길동"]);
    expect((await h.search("1111-2222")).map((r) => r.customer)).toEqual(["홍길동"]);
    expect((await h.search("010-3333-4444")).map((r) => r.customer)).toEqual(["김철수"]);
    expect((await h.search("홍")).map((r) => r.customer)).toEqual(["홍길동"]);
  });
});
