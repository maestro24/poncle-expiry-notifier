import { describe, expect, it } from "vitest";
import { cohortStats, updateCohort, type CohortEntry } from "../src/domain/cohort";
import { decodeDueItemText, sortDueItems } from "../src/domain/due-item";
import {
  History,
  HISTORY_PAGE_SIZE,
  sanitizeSendStats,
  sendStats,
  sendSummaryLabel,
  type KV,
  type SentRecord,
} from "../src/domain/history";
import { clockSkewDays, CLOCK_SKEW_MESSAGE, makeDate } from "../src/domain/plaindate";
import { smsLengthInfo } from "../src/domain/sender";
import type { DueItem } from "../src/domain/types";

function memKV(): KV {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/** A KV whose every get/set resolves after a (varying) delay — reproduces the
 *  interleaving a real async store allows between read and write. */
function delayedKV(): KV & { raw: Map<string, string> } {
  const m = new Map<string, string>();
  let n = 0;
  const wait = () => new Promise<void>((r) => setTimeout(r, (n++ * 7) % 5));
  return {
    raw: m,
    get: async (k) => { await wait(); return m.get(k) ?? null; },
    set: async (k, v) => { await wait(); m.set(k, v); },
  };
}

const rec = (over: Partial<SentRecord> = {}): SentRecord => ({
  phone: "010-1111-2222", customer: "고객", opendate: "24-07-03", expiry_date: "2026-07-03",
  milestone_offset: 0, telecom: "KT", agency: "", plan: "", model: "", openhow: "기변", staff: "",
  channel: "sms", sent_at: "2026-07-03T09:00:00", ...over,
});
const item = (over: Partial<DueItem> = {}): DueItem => ({
  id: "", phone: "010-1111-2222", customer: "홍길동", opendate: "24-07-03", expiry_date: "2026-07-03",
  milestone_offset: 0, telecom: "KT", agency: "", openhow: "기변", plan: "", model: "", staff: "",
  already_sent: false, ...over,
});

/* ---------------- #50 History write lock under concurrency ---------------- */
describe("#50 History serializes concurrent writes (delayed KV)", () => {
  it("Promise.all of mixed writes loses none", async () => {
    const kv = delayedKV();
    const h = new History(kv);
    await Promise.all([
      h.putRecord(rec({ phone: "010-0000-0001", sms_id: "a" })),
      h.putRecord(rec({ phone: "010-0000-0002" })),
      h.recordSent(rec({ phone: "010-0000-0003" }), "sms", "2026-07-03T10:00:00"),
      h.putRecord(rec({ phone: "010-0000-0004", channel: "skipped" })),
      h.applySendResults([{ id: "a", status: "ok", at: "" }]),
      h.setHandled("010-9", "2026-01-01", true),
      h.setHandled("010-8", "2026-01-01", true),
      h.putRecord(rec({ phone: "010-0000-0005" })),
    ]);
    const all = await h.exportAll();
    expect(all.map((r) => r.phone).sort()).toEqual([
      "010-0000-0001", "010-0000-0002", "010-0000-0003", "010-0000-0004", "010-0000-0005",
    ]);
    expect(all.find((r) => r.phone === "010-0000-0001")?.delivery).toBe("delivered");
    expect(Array.from(await h.handledKeys()).sort()).toEqual(["0108|2026-01-01", "0109|2026-01-01"]);
  });

  it("concurrent resends of the same customer all count", async () => {
    const h = new History(delayedKV());
    await h.putRecord(rec({ sent_at: "2026-07-01T09:00:00" }));
    await Promise.all([
      h.putRecord(rec({ sent_at: "2026-07-02T09:00:00" })),
      h.putRecord(rec({ sent_at: "2026-07-03T09:00:00" })),
    ]);
    const r = await h.getRecord("010-1111-2222", "2026-07-03");
    expect(sendStats(r!)).toEqual({ count: 3, first: "2026-07-01T09:00:00" });
  });

  it("a failed write does not wedge the lock", async () => {
    let fail = true;
    const base = memKV();
    const kv: KV = { get: base.get, set: async (k, v) => { if (fail) { fail = false; throw new Error("io"); } return base.set(k, v); } };
    const h = new History(kv);
    await expect(h.putRecord(rec())).rejects.toThrow("io");
    expect(await h.putRecord(rec({ phone: "010-2" }))).toBe(true);
    expect((await h.exportAll()).map((r) => r.phone)).toEqual(["010-2"]);
  });
});

/* ---------------- #52 home order ---------------- */
describe("#52 sortDueItems", () => {
  it("unsent first, then expiry ascending (overdue on top)", () => {
    const list = [
      item({ phone: "1", expiry_date: "2026-07-10", milestone_offset: 7 }),
      item({ phone: "2", expiry_date: "2026-07-01", milestone_offset: -2, already_sent: true }),
      item({ phone: "3", expiry_date: "2026-07-05", milestone_offset: 2 }),
      item({ phone: "4", expiry_date: "2026-06-30", milestone_offset: -3 }),
      item({ phone: "5", expiry_date: "2026-07-03", milestone_offset: 0, already_sent: true }),
      item({ phone: "6", expiry_date: "", milestone_offset: 0 }),
    ];
    const out = sortDueItems(list);
    expect(out.map((i) => i.phone)).toEqual(["4", "3", "1", "6", "2", "5"]);
    expect(list.map((i) => i.phone)).toEqual(["1", "2", "3", "4", "5", "6"]); // pure
  });

  it("ties broken by opendate then phone (stable output)", () => {
    const out = sortDueItems([
      item({ phone: "b", opendate: "24-07-03" }),
      item({ phone: "a", opendate: "24-07-03" }),
      item({ phone: "c", opendate: "24-07-01" }),
    ]);
    expect(out.map((i) => i.phone)).toEqual(["c", "a", "b"]);
  });
});

/* ---------------- #57 first_sent_at / send_count ---------------- */
describe("#57 resend keeps first_sent_at and counts sends", () => {
  it("a single send stores no extra fields (shape unchanged)", async () => {
    const h = new History(memKV());
    const r = rec();
    await h.putRecord(r);
    expect(await h.getRecord(r.phone, r.expiry_date)).toEqual(r);
    expect(sendStats(r)).toEqual({ count: 1, first: r.sent_at });
  });

  it("resend over a legacy record derives first/count from it", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ sent_at: "2026-06-01T09:00:00" }));
    await h.putRecord(rec({ sent_at: "2026-06-05T09:00:00" }));
    await h.putRecord(rec({ sent_at: "2026-06-09T09:00:00" }));
    const r = (await h.getRecord("010-1111-2222", "2026-07-03"))!;
    expect(r.sent_at).toBe("2026-06-09T09:00:00");
    expect(r.first_sent_at).toBe("2026-06-01T09:00:00");
    expect(r.send_count).toBe(3);
    expect(sendSummaryLabel(r)).toBe("최초 발송 2026-06-01 · 3회");
  });

  it("a failed first send is not counted; the later real send becomes the first", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ sent_at: "2026-06-01T09:00:00", delivery: "failed" }));
    await h.putRecord(rec({ sent_at: "2026-06-02T09:00:00" }));
    const r = (await h.getRecord("010-1111-2222", "2026-07-03"))!;
    expect(sendStats(r)).toEqual({ count: 1, first: "2026-06-02T09:00:00" });
  });

  it("a skip over a real send keeps its stats without counting itself", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ sent_at: "2026-06-01T09:00:00", delivery: "failed" }));
    await h.putRecord(rec({ sent_at: "2026-06-02T09:00:00" }));
    await h.putRecord(rec({ sent_at: "2026-06-03T09:00:00", channel: "skipped" }));
    const r = (await h.getRecord("010-1111-2222", "2026-07-03"))!;
    expect(sendStats(r)).toEqual({ count: 1, first: "2026-06-02T09:00:00" });
    expect(sendSummaryLabel(r)).toBe("최초 발송 2026-06-02 · 1회");
  });

  it("a failed resend reverts and un-counts itself", async () => {
    const h = new History(memKV());
    const first = rec({ sent_at: "2026-06-01T09:00:00", sms_id: "1" });
    await h.putRecord(first);
    const { withResendBackup } = await import("../src/domain/history");
    await h.putRecord(withResendBackup(rec({ sent_at: "2026-06-05T09:00:00", sms_id: "2" }), first));
    expect(sendStats((await h.getRecord(first.phone, first.expiry_date))!).count).toBe(2);
    await h.applySendResults([{ id: "2", status: "fail", reason: "x", at: "" }]);
    const r = (await h.getRecord(first.phone, first.expiry_date))!;
    expect(r.sent_at).toBe("2026-06-01T09:00:00");
    expect(sendStats(r)).toEqual({ count: 1, first: "2026-06-01T09:00:00" });
  });

  it("a send reported failed (no backup) is un-counted", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ sent_at: "2026-06-01T09:00:00", delivery: "failed" }));
    await h.putRecord(rec({ sent_at: "2026-06-02T09:00:00", sms_id: "x" }));
    await h.putRecord(rec({ sent_at: "2026-06-03T09:00:00", sms_id: "y", delivery: undefined }));
    // 06-02 counted, 06-03 counted -> 2; then 06-03 fails without a backup in this path
    await h.applySendResults([{ id: "y", status: "fail", at: "" }]);
    const r = (await h.getRecord("010-1111-2222", "2026-07-03"))!;
    expect(r.delivery).toBe("failed");
    expect(sendStats(r)).toEqual({ count: 1, first: "2026-06-02T09:00:00" });
  });

  it("sendSummaryLabel is empty for practice/never-sent records", () => {
    expect(sendSummaryLabel(rec({ channel: "record-only" }))).toBe("");
    expect(sendSummaryLabel(rec({ delivery: "failed" }))).toBe("");
  });

  it("sanitizeSendStats keeps only well-formed values", () => {
    expect(sanitizeSendStats({ first_sent_at: "2026-06-01T09:00:00", send_count: 3 })).toEqual({ first_sent_at: "2026-06-01T09:00:00", send_count: 3 });
    expect(sanitizeSendStats({ first_sent_at: 5, send_count: "3" })).toEqual({});
    expect(sanitizeSendStats({ send_count: -1 })).toEqual({});
    expect(sanitizeSendStats({ send_count: 2.5 })).toEqual({});
    expect(sanitizeSendStats(null)).toEqual({});
  });
});

/* ---------------- #58 device clock skew ---------------- */
describe("#58 clockSkewDays", () => {
  // Device dates are built from LOCAL components, so this holds in any test TZ.
  const dev = (d: number, h = 12, mi = 0, s = 0) => new Date(2026, 10, d, h, mi, s);
  it("same wall clock (KST) -> 0", () => {
    expect(clockSkewDays("2026-11-16T03:00:00Z", dev(16))).toBe(0);
    expect(clockSkewDays("Mon, 16 Nov 2026 03:00:00 GMT", dev(16))).toBe(0);
  });
  it("device a day ahead / behind -> +1 / -1", () => {
    expect(clockSkewDays("2026-11-16T03:00:00Z", dev(17))).toBe(1);
    expect(clockSkewDays("2026-11-16T03:00:00Z", dev(15, 11))).toBe(-1);
    expect(clockSkewDays("2026-11-16T03:00:00Z", dev(26))).toBe(10);
  });
  it("a few seconds across midnight is not a skew", () => {
    expect(clockSkewDays("2026-11-16T15:00:05Z", dev(16, 23, 59, 50))).toBe(0);
  });
  it("compares CALENDAR dates: 23h ahead across midnight is a different day", () => {
    // Korea: Nov 16 10:00 (01:00Z). Phone shows Nov 17 09:00 -> today()/D-day off by one.
    expect(clockSkewDays("2026-11-16T01:00:00Z", dev(17, 9))).toBe(1);
    // Korea: Nov 16 10:00. Phone shows Nov 15 11:00 (23h behind) -> -1.
    expect(clockSkewDays("2026-11-16T01:00:00Z", dev(15, 11))).toBe(-1);
  });
  it("a phone set to UTC (9h behind KST) is flagged while its date differs", () => {
    // Korea: Nov 17 03:00 (= Nov 16 18:00Z); a UTC-zoned phone shows Nov 16 18:00.
    expect(clockSkewDays("2026-11-16T18:00:00Z", dev(16, 18))).toBe(-1);
    // Korea: Nov 16 12:00 (03:00Z); the UTC phone shows Nov 16 03:00 -> same date.
    expect(clockSkewDays("2026-11-16T03:00:00Z", dev(16, 3))).toBe(0);
  });
  it("a few minutes of drift across midnight is tolerated (< 10 min), more is not", () => {
    expect(clockSkewDays("2026-11-16T15:05:00Z", dev(16, 23, 56))).toBe(0); // 9 min
    expect(clockSkewDays("2026-11-16T15:30:00Z", dev(16, 23, 50))).toBe(-1); // 40 min
  });
  it("unparseable server date -> 0 (cannot tell, never block)", () => {
    expect(clockSkewDays("", dev(16))).toBe(0);
    expect(clockSkewDays("garbage", dev(16))).toBe(0);
  });
  it("exports the user-facing message", () => {
    expect(CLOCK_SKEW_MESSAGE).toBe("휴대폰 날짜가 실제와 다릅니다 — 날짜/시간 자동 설정을 켜 주세요");
  });
});

/* ---------------- #59 history paging ---------------- */
describe("#59 history paging (no silent 1000 cap)", () => {
  async function seeded(n: number): Promise<History> {
    const rows: SentRecord[] = [];
    for (let i = 0; i < n; i++) {
      const d = String(i).padStart(5, "0");
      rows.push(rec({ phone: `010-1${d}`, customer: `c${d}`, sent_at: `2026-07-03T09:${String(i % 60).padStart(2, "0")}:00.${d}` }));
    }
    const h = new History(memKV());
    await h.replaceAll(rows);
    return h;
  }
  it("search() returns every match (beyond 1000)", async () => {
    const h = await seeded(1205);
    expect((await h.search()).length).toBe(1205);
  });
  it("searchPage reports the real total and pages through", async () => {
    const h = await seeded(1205);
    const p1 = await h.searchPage({ limit: 500 });
    expect(p1.total).toBe(1205);
    expect(p1.rows.length).toBe(500);
    expect(p1.hasMore).toBe(true);
    const p3 = await h.searchPage({ offset: 1000, limit: 500 });
    expect(p3.rows.length).toBe(205);
    expect(p3.hasMore).toBe(false);
    expect(p3.offset).toBe(1000);
    const all = [...p1.rows, ...(await h.searchPage({ offset: 500, limit: 500 })).rows, ...p3.rows];
    expect(new Set(all.map((r) => r.phone)).size).toBe(1205);
  });
  it("defaults to HISTORY_PAGE_SIZE and clamps bad paging input", async () => {
    const h = await seeded(HISTORY_PAGE_SIZE + 3);
    const p = await h.searchPage({ offset: -5, limit: 0 });
    expect(p.offset).toBe(0);
    expect(p.rows.length).toBe(HISTORY_PAGE_SIZE);
    expect(p.total).toBe(HISTORY_PAGE_SIZE + 3);
  });
});

/* ---------------- #61 SMS length info ---------------- */
describe("#61 smsLengthInfo", () => {
  it("empty text", () => {
    expect(smsLengthInfo("")).toMatchObject({ chars: 0, bytes: 0, kind: "SMS", segments: 0 });
  });
  it("ASCII counts 1 byte, GSM-7 segments", () => {
    expect(smsLengthInfo("hello")).toMatchObject({ chars: 5, bytes: 5, kind: "SMS", encoding: "GSM7", segments: 1 });
    expect(smsLengthInfo("a".repeat(160))).toMatchObject({ kind: "LMS", segments: 1 });
    expect(smsLengthInfo("a".repeat(161)).segments).toBe(2);
    expect(smsLengthInfo("a".repeat(306)).segments).toBe(2);
    expect(smsLengthInfo("a".repeat(307)).segments).toBe(3);
  });
  it("GSM extension chars take two septets", () => {
    expect(smsLengthInfo("{".repeat(80))).toMatchObject({ encoding: "GSM7", segments: 1 });
    expect(smsLengthInfo("{".repeat(81)).segments).toBe(2);
  });
  it("Hangul counts 2 bytes: 45 chars = 90 bytes SMS, 46 = LMS", () => {
    expect(smsLengthInfo("가".repeat(45))).toMatchObject({ chars: 45, bytes: 90, kind: "SMS", encoding: "UCS2", segments: 1 });
    expect(smsLengthInfo("가".repeat(46))).toMatchObject({ bytes: 92, kind: "LMS" });
  });
  it("UCS-2 multipart: 70 single, then 67 per part", () => {
    expect(smsLengthInfo("가".repeat(70)).segments).toBe(1);
    expect(smsLengthInfo("가".repeat(71)).segments).toBe(2);
    expect(smsLengthInfo("가".repeat(134)).segments).toBe(2);
    expect(smsLengthInfo("가".repeat(135)).segments).toBe(3);
  });
  it("mixed text and newlines", () => {
    const info = smsLengthInfo("홍길동 고객님\n안녕하세요 2년");
    expect(info.chars).toBe(16);
    expect(info.bytes).toBe(2 * 12 + 4); // 12 Hangul; 2 spaces + \n + "2"
    expect(info.encoding).toBe("UCS2");
  });
  it("emoji: one char, 4 bytes, two UTF-16 units", () => {
    expect(smsLengthInfo("😀")).toMatchObject({ chars: 1, bytes: 4, encoding: "UCS2", segments: 1 });
    expect(smsLengthInfo("😀".repeat(35)).segments).toBe(1); // 70 units
    expect(smsLengthInfo("😀".repeat(36)).segments).toBe(2);
  });
  it("Korean label", () => {
    expect(smsLengthInfo("가".repeat(10)).label).toBe("10자 · 20/90바이트 (단문)");
    expect(smsLengthInfo("가".repeat(100)).label).toBe("100자 · 200바이트 · 장문(LMS) / 분할 2건");
  });
  it("flags text over the 2000-byte LMS limit", () => {
    expect(smsLengthInfo("가".repeat(1000)).tooLong).toBe(false);
    expect(smsLengthInfo("가".repeat(1001)).tooLong).toBe(true);
  });
});

/* ---------------- L1 decode cached rows ---------------- */
describe("L1 cached due/unvisited rows are entity-decoded on load", () => {
  it("decodeDueItemText decodes text fields and is idempotent on clean text", () => {
    const raw = item({ agency: "PS&amp;M", plan: "넷플릭스&amp;웨이브", customer: "김&#39;s", model: "A&lt;B" });
    const once = decodeDueItemText(raw);
    expect(once).toMatchObject({ agency: "PS&M", plan: "넷플릭스&웨이브", customer: "김's", model: "A<B" });
    expect(decodeDueItemText(once)).toEqual(once);
    expect(raw.agency).toBe("PS&amp;M"); // pure
    const clean = item({ agency: "PS&M" });
    expect(decodeDueItemText(clean)).toBe(clean); // unchanged -> same object
  });
  it("loadDueList / loadUnvisited decode an older (escaped) cache", async () => {
    const kv = memKV();
    await kv.set("due_cache", JSON.stringify([item({ agency: "PS&amp;M" })]));
    await kv.set("unvisited_cache", JSON.stringify([item({ plan: "A&amp;B" })]));
    const h = new History(kv);
    expect((await h.loadDueList())[0].agency).toBe("PS&M");
    expect((await h.loadUnvisited())[0].plan).toBe("A&B");
  });
});

/* ---------------- L2 history search: digits only for phone-like queries ---------------- */
describe("L2 history search", () => {
  it("a name query with a digit does not match every phone containing it", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-1111-2222", customer: "홍길동" }));
    await h.putRecord(rec({ phone: "010-3333-4441", customer: "김철수", expiry_date: "2026-07-04" }));
    expect(await h.search("홍1")).toEqual([]);
    expect(await h.search("a12")).toEqual([]);
    expect((await h.search("12")).length).toBe(0); // < 3 digits: no digit compare
    expect((await h.search("4441")).map((r) => r.customer)).toEqual(["김철수"]);
    expect((await h.search("010 3333")).map((r) => r.customer)).toEqual(["김철수"]);
  });
});

/* ---------------- L3 cohort early re-contract attribution ---------------- */
describe("L3 early re-contract attributed to the re-contract date", () => {
  const TODAY = makeDate(2026, 7, 3);
  const send = (over: Partial<SentRecord> = {}) => rec({ phone: "010-5", opendate: "24-08-10", expiry_date: "2026-08-10", sent_at: "2026-06-20T10:00:00", ...over });
  const opens = [{ openphone: "010-5", opendate: "24-08-10" }, { openphone: "010-5", opendate: "26-06-25" }];

  it("counts now, even though the old expiry is still in the future", () => {
    const out = updateCohort([], [], opens, new Set(), TODAY, 90, [send()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ phone: "010-5", expiry: "2026-08-10", informed: true, revisited: true, resolvedOn: "2026-06-25" });
    const s = cohortStats(out, TODAY, 90);
    expect(s.total).toBe(1);
    expect(s.informedRate).toBe(100);
  });

  it("one re-contract alerted at both stages is one conversion", () => {
    const out = updateCohort([], [], opens, new Set(), TODAY, 90, [
      send({ expiry_date: "2026-07-01", sent_at: "2026-06-20T10:00:00" }), // 1단계 (keepdate)
      send({ expiry_date: "2026-08-10", sent_at: "2026-06-22T10:00:00" }), // 2단계 (term)
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].expiry).toBe("2026-08-10"); // the latest alert gets the credit
    expect(cohortStats(out, TODAY, 90).total).toBe(1);
  });

  it("an early re-contract already counted via an expired (미방문) entry is not added twice", () => {
    const prev: CohortEntry[] = [{ phone: "010-5", expiry: "2026-05-01", informed: true, revisited: false, firstSeen: "2026-05-02" }];
    const out = updateCohort(prev, [], opens, new Set(), TODAY, 90, [send()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ expiry: "2026-05-01", revisited: true });
  });

  it("ages out by the re-contract date, not the far-future old expiry", () => {
    const out = updateCohort([], [], opens, new Set(), TODAY, 90, [send({ expiry_date: "2026-12-10" })]);
    expect(out).toHaveLength(1);
    const prev: CohortEntry[] = out;
    // 90 days after 2026-10-01 starts at 07-03 > 06-25 (re-contract) -> aged out
    expect(updateCohort(prev, [], opens, new Set(), makeDate(2026, 10, 1), 90, [send({ expiry_date: "2026-12-10" })])).toEqual([]);
  });

  it("a re-contract after expiry keeps the classic entry (no resolvedOn)", () => {
    const out = updateCohort([], [], [{ openphone: "010-5", opendate: "24-06-10" }, { openphone: "010-5", opendate: "26-06-20" }], new Set(), TODAY, 90, [
      send({ opendate: "24-06-10", expiry_date: "2026-06-10", sent_at: "2026-06-01T10:00:00" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].resolvedOn).toBeUndefined();
    expect(out[0]).toMatchObject({ expiry: "2026-06-10", informed: true, revisited: true });
  });
});
