/**
 * P0 send-state rules (audit 1-2, 1-5/1-6 JS half, Low "test row cached"):
 *  - only a real SMS that has not been reported failed counts as 'sent'
 *  - record-only (practice) records are a distinct, NOT-sent state
 *  - 'skipped' keeps its handled/excluded meaning
 *  - native send results reconcile records by sms_id (fail -> not sent)
 *  - test rows never reach the due cache; the cache remembers its scan date
 */
import { describe, expect, it } from "vitest";
import {
  History,
  countsAsSent,
  parseSendResults,
  sentStateOf,
  withResendBackup,
  type KV,
  type SentRecord,
} from "../src/domain/history";
import { sanitizeRecord } from "../src/domain/export";
import type { DueItem } from "../src/domain/types";

function memKV(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
  };
}

const rec = (over: Partial<SentRecord> = {}): SentRecord => ({
  phone: "010-1111-2222",
  customer: "홍길동",
  opendate: "24-07-03",
  expiry_date: "2026-07-03",
  milestone_offset: 0,
  telecom: "KT",
  agency: "",
  plan: "",
  model: "",
  openhow: "기변",
  staff: "",
  channel: "sms",
  sent_at: "2026-07-03T09:00:00",
  ...over,
});

const due = (phone: string, expiry: string, over: Partial<DueItem> = {}): DueItem => ({
  id: `${phone}|${expiry}`, phone, customer: "", opendate: "", expiry_date: expiry,
  milestone_offset: 0, telecom: "", agency: "", openhow: "", plan: "", model: "", staff: "",
  already_sent: false, source: "term", ...over,
});

describe("sentStateOf / countsAsSent", () => {
  it("old sms records (no delivery field) stay 'sent' (migration-safe)", () => {
    expect(sentStateOf(rec())).toBe("sent");
    expect(countsAsSent(rec())).toBe(true);
  });
  it("delivered sms is sent; failed sms is NOT sent", () => {
    expect(sentStateOf(rec({ delivery: "delivered" }))).toBe("sent");
    expect(sentStateOf(rec({ delivery: "failed", fail_reason: "무선 꺼짐" }))).toBe("failed");
    expect(countsAsSent(rec({ delivery: "failed" }))).toBe(false);
  });
  it("record-only is a distinct 'recorded' state, never sent", () => {
    expect(sentStateOf(rec({ channel: "record-only" }))).toBe("recorded");
    expect(countsAsSent(rec({ channel: "record-only" }))).toBe(false);
  });
  it("skipped keeps its handled meaning but is not a real send", () => {
    expect(sentStateOf(rec({ channel: "skipped" }))).toBe("skipped");
    expect(countsAsSent(rec({ channel: "skipped" }))).toBe(false);
  });
  it("no record -> none", () => {
    expect(sentStateOf(undefined)).toBe("none");
    expect(sentStateOf(null)).toBe("none");
  });
});

describe("History.dedupKeySet (what counts as already handled)", () => {
  it("record-only does NOT dedup (practice records must still be sendable)", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ channel: "record-only" }));
    expect((await h.dedupKeySet()).size).toBe(0);
    expect(await h.alreadySent("010-1111-2222", "2026-07-03")).toBe(false);
  });
  it("real sms and skipped dedup; a failed sms does not", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-1", channel: "sms" }));
    await h.putRecord(rec({ phone: "010-2", channel: "skipped" }));
    await h.putRecord(rec({ phone: "010-3", channel: "sms", delivery: "failed" }));
    await h.putRecord(rec({ phone: "010-4", channel: "record-only" }));
    const keys = await h.dedupKeySet();
    expect(keys.has("0101|2026-07-03")).toBe(true);
    expect(keys.has("0102|2026-07-03")).toBe(true);
    expect(keys.has("0103|2026-07-03")).toBe(false);
    expect(keys.has("0104|2026-07-03")).toBe(false);
  });
  it("recordSent upgrades a record-only record to a real sms (no 'already')", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ channel: "record-only" }));
    const { channel: _c, sent_at: _s, ...entry } = rec();
    expect(await h.recordSent(entry, "sms", "2026-07-04T09:00:00")).toBe(true);
    const all = await h.exportAll();
    expect(all.length).toBe(1);
    expect(all[0].channel).toBe("sms");
  });
  it("recordsByKey exposes the stored record per normalized key", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ channel: "record-only" }));
    const map = await h.recordsByKey();
    expect(map.get("01011112222|2026-07-03")?.channel).toBe("record-only");
  });
});

describe("parseSendResults (untrusted native payload)", () => {
  it("keeps well-formed results, drops junk", () => {
    const out = parseSendResults({
      results: [
        { id: "a", status: "ok", at: "2026-07-03T09:00:00" },
        { id: "b", status: "fail", reason: "비행기 모드", at: "x" },
        { id: "", status: "ok" },
        { id: "c", status: "weird" },
        "nope",
        null,
      ],
    });
    expect(out).toEqual([
      { id: "a", status: "ok", at: "2026-07-03T09:00:00" },
      { id: "b", status: "fail", reason: "비행기 모드", at: "x" },
    ]);
  });
  it("non-object / missing results -> []", () => {
    expect(parseSendResults(null)).toEqual([]);
    expect(parseSendResults({})).toEqual([]);
    expect(parseSendResults({ results: "x" })).toEqual([]);
  });
});

describe("History.applySendResults", () => {
  it("fail marks the matching record failed (no longer sent); ok marks delivered", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-1", sms_id: "s1" }));
    await h.putRecord(rec({ phone: "010-2", sms_id: "s2" }));
    const out = await h.applySendResults([
      { id: "s1", status: "fail", reason: "서비스 지역 아님", at: "t" },
      { id: "s2", status: "ok", at: "t" },
      { id: "zzz", status: "fail", reason: "?", at: "t" }, // unmatched (e.g. test send)
    ]);
    expect(out.failed.map((r) => r.phone)).toEqual(["010-1"]);
    expect(out.unmatched).toEqual(["zzz"]);
    const r1 = await h.getRecord("010-1", "2026-07-03");
    expect(r1?.delivery).toBe("failed");
    expect(r1?.fail_reason).toBe("서비스 지역 아님");
    expect((await h.getRecord("010-2", "2026-07-03"))?.delivery).toBe("delivered");
    const keys = await h.dedupKeySet();
    expect(keys.has("0101|2026-07-03")).toBe(false);
    expect(keys.has("0102|2026-07-03")).toBe(true);
  });
  it("a result for a superseded send (record re-sent with a new id) is ignored", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ sms_id: "new" }));
    const out = await h.applySendResults([{ id: "old", status: "fail", reason: "x", at: "t" }]);
    expect(out.failed).toEqual([]);
    expect(out.unmatched).toEqual(["old"]);
    expect(countsAsSent((await h.getRecord("010-1111-2222", "2026-07-03"))!)).toBe(true);
  });
  it("empty results is a no-op", async () => {
    const kv = memKV();
    const h = new History(kv);
    expect(await h.applySendResults([])).toEqual({ failed: [], resendFailed: [], delivered: 0, unmatched: [] });
    expect(kv.m.has("sent_log")).toBe(false);
  });
});

describe("재발송 over a real send keeps the earlier send (review: resend fail)", () => {
  const first = rec({ sms_id: "s1", delivery: "delivered", body: "원문", sent_at: "2026-07-01T09:00:00" });
  const resend = (over: Partial<SentRecord> = {}) =>
    rec({ sms_id: "s2", body: "재안내", sent_at: "2026-07-03T10:00:00", ...over });

  it("withResendBackup snapshots a counted send; not a failed/practice/absent one", () => {
    expect(withResendBackup(resend(), first).prev_sent).toEqual({
      sent_at: "2026-07-01T09:00:00", body: "원문", sms_id: "s1", delivery: "delivered",
    });
    expect(withResendBackup(resend(), null).prev_sent).toBeUndefined();
    expect(withResendBackup(resend(), rec({ delivery: "failed" })).prev_sent).toBeUndefined();
    expect(withResendBackup(resend(), rec({ channel: "record-only" })).prev_sent).toBeUndefined();
  });

  it("a failed resend reverts to the earlier delivered send (still handled)", async () => {
    const h = new History(memKV());
    await h.putRecord(first);
    await h.putRecord(withResendBackup(resend(), first));
    const out = await h.applySendResults([{ id: "s2", status: "fail", reason: "비행기 모드", at: "t" }]);
    expect(out.failed).toEqual([]);
    expect(out.resendFailed.map((r) => r.phone)).toEqual(["010-1111-2222"]);
    const back = (await h.getRecord("010-1111-2222", "2026-07-03"))!;
    expect(countsAsSent(back)).toBe(true);
    expect(back).toMatchObject({ sent_at: "2026-07-01T09:00:00", body: "원문", sms_id: "s1", delivery: "delivered", resend_fail_reason: "비행기 모드" });
    expect(back.prev_sent).toBeUndefined();
    expect((await h.dedupKeySet()).has("01011112222|2026-07-03")).toBe(true);
    expect(await h.alreadySent("010-1111-2222", "2026-07-03")).toBe(true);
  });

  it("re-applying the same fail result is idempotent (no double revert)", async () => {
    const h = new History(memKV());
    await h.putRecord(withResendBackup(resend(), first));
    await h.applySendResults([{ id: "s2", status: "fail", reason: "x", at: "t" }]);
    const out = await h.applySendResults([{ id: "s2", status: "fail", reason: "x", at: "t" }]);
    expect(out.unmatched).toEqual(["s2"]);
    expect((await h.getRecord("010-1111-2222", "2026-07-03"))).toMatchObject({ sms_id: "s1", delivery: "delivered" });
  });

  it("an ok resend is delivered and drops the backup", async () => {
    const h = new History(memKV());
    await h.putRecord(withResendBackup(resend(), first));
    await h.applySendResults([{ id: "s2", status: "ok", at: "t" }]);
    const back = (await h.getRecord("010-1111-2222", "2026-07-03"))!;
    expect(back).toMatchObject({ sms_id: "s2", body: "재안내", delivery: "delivered" });
    expect(back.prev_sent).toBeUndefined();
  });

  it("two pending resends that both fail fall back to the confirmed first send", async () => {
    const h = new History(memKV());
    const b = withResendBackup(resend(), first);
    const c = withResendBackup(resend({ sms_id: "s3", body: "세번째" }), b);
    await h.putRecord(c);
    await h.applySendResults([{ id: "s3", status: "fail", reason: "x", at: "t" }]);
    expect(await h.getRecord("010-1111-2222", "2026-07-03")).toMatchObject({ sms_id: "s2" });
    await h.applySendResults([{ id: "s2", status: "fail", reason: "y", at: "t" }]);
    const back = (await h.getRecord("010-1111-2222", "2026-07-03"))!;
    expect(back).toMatchObject({ sms_id: "s1", body: "원문", delivery: "delivered" });
    expect(countsAsSent(back)).toBe(true);
  });

  it("a backup survives a backup-file round trip (sanitizeRecord)", () => {
    const r = sanitizeRecord(withResendBackup(resend(), first))!;
    expect(r.prev_sent).toEqual({ sent_at: "2026-07-01T09:00:00", body: "원문", sms_id: "s1", delivery: "delivered" });
    expect(sanitizeRecord({ ...rec(), prev_sent: { sent_at: 5, delivery: "bogus" } })!.prev_sent).toBeUndefined();
  });
});

describe("History.cacheDueList", () => {
  it("never persists test rows", async () => {
    const h = new History(memKV());
    await h.cacheDueList([due("010-1", "2026-07-03"), due("010-9", "2026-07-03", { test: true })]);
    const back = await h.loadDueList();
    expect(back.map((r) => r.phone)).toEqual(["010-1"]);
  });
  it("records the scan date only when given; later re-caches keep it", async () => {
    const h = new History(memKV());
    expect(await h.getDueCacheDate()).toBe("");
    await h.cacheDueList([due("010-1", "2026-07-03")], "2026-07-03");
    expect(await h.getDueCacheDate()).toBe("2026-07-03");
    await h.cacheDueList([due("010-1", "2026-07-03")]); // e.g. after a send
    expect(await h.getDueCacheDate()).toBe("2026-07-03");
  });
});
