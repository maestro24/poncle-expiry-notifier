/**
 * Stage R1 (re-audit 2026-11-17) domain fixes — B1/B11 (C1 manual source), B2, B3,
 * B5 (C4), B6 (C2), B8 (C3), B15 (C5), D1, D3.
 */
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/domain/config";
import { excludedKeysToAdd, mergeHistory, missingFromBackup, parseBackup, buildBackup } from "../src/domain/export";
import {
  History,
  SentIndex,
  inferSource,
  sendStats,
  sentStateOf,
  withResendBackup,
  type KV,
  type SentRecord,
} from "../src/domain/history";
import { keepDueRows } from "../src/domain/keepdate";
import { buildLookupResults, lookupInformedAt, lookupStatus } from "../src/domain/lookup";
import { makeDate } from "../src/domain/plaindate";
import { dueItemToEntry } from "../src/domain/sender";
import type { AppConfig, DueItem, PoncleRow } from "../src/domain/types";
import { checkForUpdate, parseMinSdk, pickAndroidUpdate, type GhRelease } from "../src/domain/updater";
import { applyRestoredExtras } from "../src/ui/restore-extras";

function memKV(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}
const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over });

const rec = (over: Partial<SentRecord> = {}): SentRecord => ({
  phone: "010-1111-2222", customer: "고객", opendate: "26-05-17", expiry_date: "2028-05-17",
  milestone_offset: 0, telecom: "KT", agency: "", plan: "", model: "", openhow: "기변", staff: "",
  channel: "sms", sent_at: "2026-07-03T09:00:00", ...over,
});
const item = (over: Partial<DueItem> = {}): DueItem => ({
  id: "", phone: "010-1111-2222", customer: "홍길동", opendate: "26-05-17", expiry_date: "2028-05-17",
  milestone_offset: 0, telecom: "KT", agency: "", openhow: "기변", plan: "", model: "", staff: "",
  already_sent: false, source: "term", ...over,
});
const pend = (phone: string, pendingdate: string, over: Partial<PoncleRow> = {}): PoncleRow => ({
  gubunx: "요금제유지", condx: "접수", pendingdate, openphone: phone, name: "고객", ...over,
});

/* ---------------- B2 keepdate: window first, then one per phone ---------------- */
describe("B2 keepDueRows applies the window before picking one 유지일 per phone", () => {
  const TODAY = makeDate(2026, 11, 17);
  it("a near 유지일 in the window survives a later (out-of-window) one for the same phone", () => {
    const rows = [pend("010-1", "2026-11-18"), pend("010-1", "2027-05-18")];
    const out = keepDueRows(rows, cfg({ notify_offsets_days: [7] }), TODAY);
    expect(out.map((r) => r.keepdateIso)).toEqual(["2026-11-18"]);
  });
  it("two in the window -> the latest one (1-36 dedupe kept)", () => {
    const rows = [pend("010-1", "2026-11-18"), pend("010-1", "2026-11-20")];
    const out = keepDueRows(rows, cfg({ notify_offsets_days: [7] }), TODAY);
    expect(out.map((r) => r.keepdateIso)).toEqual(["2026-11-20"]);
  });
  it("policy: a later unresolved 유지일 OUTSIDE the window never suppresses the in-window one", () => {
    // Possible 'date correction' (old 접수 left behind, corrected date later): the
    // in-window 유지일 is still offered — a possibly-stale alert the staff sees (and
    // can 해결 in 폰클) beats a silent miss. Once the later one enters the window it wins.
    const rows = [pend("010-1", "2026-11-20"), pend("010-1", "2026-12-30")];
    expect(keepDueRows(rows, cfg({ notify_offsets_days: [7] }), TODAY).map((r) => r.keepdateIso)).toEqual(["2026-11-20"]);
    const later = makeDate(2026, 12, 25); // the old one is past the catch-up, the later one due
    expect(keepDueRows(rows, cfg({ notify_offsets_days: [7] }), later, 7).map((r) => r.keepdateIso)).toEqual(["2026-12-30"]);
  });
});

/* ---------------- B3 loadDueList drops test rows + cleans the cache ---------------- */
describe("B3 loadDueList never restores a test row", () => {
  it("filters test rows and rewrites the cache once", async () => {
    const kv = memKV();
    kv.m.set("due_cache", JSON.stringify([item({ id: "a" }), item({ id: "t", phone: "010-1234-5678", test: true })]));
    const h = new History(kv);
    const rows = await h.loadDueList();
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    const stored = JSON.parse(kv.m.get("due_cache") ?? "[]") as DueItem[];
    expect(stored.some((r) => r.test)).toBe(false);
  });
});

/* ---------------- B5 / C4 results match the prev_sent chain ---------------- */
describe("B5 applySendResults matches earlier sends kept in prev_sent", () => {
  async function resent(): Promise<History> {
    const h = new History(memKV());
    const a = rec({ sms_id: "A", sent_at: "2026-07-01T09:00:00", body: "a" });
    await h.putRecord(a);
    await h.putRecord(withResendBackup(rec({ sms_id: "B", sent_at: "2026-07-02T09:00:00", body: "b" }), a));
    return h;
  }
  it("A fails first: matched, removed from the chain, count drops; then B fails -> failed", async () => {
    const h = await resent();
    expect(sendStats((await h.exportAll())[0]).count).toBe(2);
    const o1 = await h.applySendResults([{ id: "A", status: "fail", reason: "x", at: "" }]);
    expect(o1.unmatched).toEqual([]);
    const [r1] = await h.exportAll();
    expect(r1.sms_id).toBe("B");
    expect(r1.prev_sent).toBeUndefined();
    expect(sendStats(r1)).toEqual({ first: "2026-07-02T09:00:00", count: 1 });
    await h.applySendResults([{ id: "B", status: "fail", reason: "y", at: "" }]);
    const [r2] = await h.exportAll();
    expect(sentStateOf(r2)).toBe("failed");
    expect(sendStats(r2).count).toBe(0);
  });
  it("A fails, then B ok -> delivered with one send", async () => {
    const h = await resent();
    await h.applySendResults([{ id: "A", status: "fail", at: "" }]);
    await h.applySendResults([{ id: "B", status: "ok", at: "" }]);
    const [r] = await h.exportAll();
    expect(r.delivery).toBe("delivered");
    expect(sendStats(r).count).toBe(1);
  });
  it("A ok (confirmed), then B fails -> reverted to the delivered A", async () => {
    const h = await resent();
    const o = await h.applySendResults([{ id: "A", status: "ok", at: "" }]);
    expect(o.unmatched).toEqual([]);
    expect((await h.exportAll())[0].prev_sent?.delivery).toBe("delivered");
    await h.applySendResults([{ id: "B", status: "fail", at: "" }]);
    const [r] = await h.exportAll();
    expect(sentStateOf(r)).toBe("sent");
    expect(r.sms_id).toBe("A");
    expect(r.delivery).toBe("delivered");
  });
  it("a fail for a send in a deeper chain entry is matched too", async () => {
    const h = new History(memKV());
    const a = rec({ sms_id: "A", sent_at: "2026-07-01T09:00:00" });
    await h.putRecord(a);
    const b = withResendBackup(rec({ sms_id: "B", sent_at: "2026-07-02T09:00:00" }), a);
    await h.putRecord(b);
    await h.putRecord(withResendBackup(rec({ sms_id: "C", sent_at: "2026-07-03T09:00:00" }), (await h.exportAll())[0]));
    const o = await h.applySendResults([{ id: "A", status: "fail", at: "" }]);
    expect(o.unmatched).toEqual([]);
    const [r] = await h.exportAll();
    expect(r.prev_sent?.sms_id).toBe("B");
    expect(r.prev_sent?.prev_sent).toBeUndefined();
    expect(sendStats(r)).toEqual({ first: "2026-07-02T09:00:00", count: 2 });
  });
});

/* ---------------- B6 / C2 mergeRestore inside the lock ---------------- */
describe("B6 History.mergeRestore merges against the LATEST log", () => {
  it("a failure recorded after the backup snapshot is not overwritten", async () => {
    const h = new History(memKV());
    const sent = rec({ sms_id: "s1" });
    await h.putRecord(sent);
    const snapshot = await h.exportAll(); // the backup file's view
    await h.applySendResults([{ id: "s1", status: "fail", reason: "x", at: "" }]);
    const res = await h.mergeRestore(snapshot);
    expect(res).toEqual({ added: 0, kept: 1 });
    expect(sentStateOf((await h.exportAll())[0])).toBe("failed");
  });
  it("is serialized with concurrent writes and counts added/kept", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-1", expiry_date: "2026-01-01" }));
    const w = h.putRecord(rec({ phone: "010-2", expiry_date: "2026-01-01" }));
    const r = h.mergeRestore([rec({ phone: "010-3", expiry_date: "2026-01-01" })]);
    await w;
    expect(await r).toEqual({ added: 1, kept: 2 });
    expect((await h.exportAll()).map((x) => x.phone).sort()).toEqual(["010-1", "010-2", "010-3"]);
  });
});

/* ---------------- B8 / C3 manual 제외 per contract ---------------- */
describe("B8 미방문 제외 matches the contract, not only phone|expiry", () => {
  const u = (expiry: string) => ({ phone: "010-1111-2222", expiry_date: expiry, opendate: "24-05-01" });
  it("an exclusion survives a key change (약정 개월 changed)", async () => {
    const h = new History(memKV());
    await h.setHandled("010-1111-2222", "2026-05-01", true, "24-05-01");
    expect(await h.isHandled(u("2026-05-01"))).toBe(true);
    expect(await h.isHandled(u("2026-06-01"))).toBe(true);
    expect((await h.exclusionIndex()).isHandled(u("2026-06-01"))).toBe(true);
    // a different (newer) contract is not excluded
    expect(await h.isHandled({ ...u("2028-05-01"), opendate: "26-05-01" })).toBe(false);
  });
  it("un-exclude with the opendate clears both keys", async () => {
    const h = new History(memKV());
    await h.setHandled("010-1111-2222", "2026-05-01", true, "24-05-01");
    await h.setHandled("010-1111-2222", "2026-06-01", false, "24-05-01");
    expect(await h.isHandled(u("2026-05-01"))).toBe(false);
    expect(await h.isHandled(u("2026-06-01"))).toBe(false);
  });
  it("legacy phone|expiry keys keep working (exact only)", async () => {
    const kv = memKV();
    kv.m.set("unvisited_handled", JSON.stringify(["010-1111-2222|2026-05-01"]));
    const h = new History(kv);
    expect(await h.isHandled(u("2026-05-01"))).toBe(true);
    expect(await h.isHandled(u("2026-06-01"))).toBe(false);
  });
  it("contract keys round-trip through a backup restore", async () => {
    const src = new History(memKV());
    await src.setHandled("010-1111-2222", "2026-05-01", true, "24-05-01");
    const keys = Array.from(await src.handledKeys());
    expect(excludedKeysToAdd(new Set(), keys).sort()).toEqual(keys.slice().sort());
    const backup = parseBackup(JSON.stringify(buildBackup(cfg(), [], "2026-07-03T00:00:00", { excluded: keys })));
    const dst = new History(memKV());
    await applyRestoredExtras(dst, { excluded: backup?.excluded ?? [], cohort: [] });
    expect(await dst.isHandled(u("2026-06-01"))).toBe(true);
  });
  it("legacy phone|expiry keys gain a contract key from unvisited_cache (one-time migration)", async () => {
    const kv = memKV();
    kv.m.set("unvisited_handled", JSON.stringify(["01011112222|2026-05-01", "010-9999-0000|2026-01-01"]));
    kv.m.set("unvisited_cache", JSON.stringify([item({ id: "x", expiry_date: "2026-05-01", opendate: "24-05-01" })]));
    const h = new History(kv);
    expect(await h.isHandled(u("2026-06-01"))).toBe(false);
    expect(await h.migrateLegacyExclusions()).toBe(1);
    expect(await h.isHandled(u("2026-06-01"))).toBe(true); // 24 -> 25 months
    expect(await h.isHandled(u("2026-05-01"))).toBe(true);
    const keys = await h.handledKeys();
    expect(keys.has("01011112222|2026-05-01")).toBe(true); // legacy key kept
    expect(keys.has("010-9999-0000|2026-01-01")).toBe(true); // no cache row: untouched
    // flag-guarded: a later run does nothing, even after the user un-excludes
    await h.setHandled("010-1111-2222", "2026-06-01", false, "24-05-01");
    expect(await h.migrateLegacyExclusions()).toBe(0);
    expect(await h.isHandled(u("2026-06-01"))).toBe(false);
  });
});

/* ---------------- B1 / B11 / C1 manual source ---------------- */
describe("C1 manual sends never satisfy a milestone", () => {
  const manual = rec({ source: "manual", sent_at: "2026-07-03T09:00:00" });
  const termTarget = { phone: "010-1111-2222", expiry_date: "2028-05-17", opendate: "26-05-17", openhow: "기변", source: "term" as const };

  it("SentIndex ignores manual records for exact key and contract fallback", () => {
    const idx = new SentIndex([manual]);
    expect(idx.stateOf(termTarget)).toBe("none");
    expect(idx.isHandled(termTarget)).toBe(false);
    expect(idx.has("01011112222|2028-05-17")).toBe(false);
    expect(idx.keySet().size).toBe(0);
    expect(idx.sentKeySet().size).toBe(0);
    expect(idx.sentRecords()).toEqual([]);
    expect(idx.stateOf({ ...termTarget, expiry_date: "2028-06-17" })).toBe("none");
    expect(idx.sentAt(termTarget)).toBe("");
    expect(inferSource(manual)).toBe("");
  });
  it("latestSentAt(phone) spans keepdate, term and manual sends", () => {
    const idx = new SentIndex([
      rec({ source: "keepdate", expiry_date: "2026-11-17", sent_at: "2026-11-10T09:00:00" }),
      rec({ source: "manual", sent_at: "2026-12-01T09:00:00" }),
      rec({ source: "term", expiry_date: "2026-05-17", sent_at: "2026-05-01T09:00:00", phone: "01099998888" }),
      rec({ source: "manual", expiry_date: "2028-01-01", sent_at: "2027-01-01T09:00:00", delivery: "failed" }),
    ]);
    expect(idx.latestSentAt("01011112222")).toBe("2026-12-01T09:00:00");
    expect(idx.latestSentAt("010-9999-8888")).toBe("2026-05-01T09:00:00");
    expect(idx.latestSentAt("010-0000-0000")).toBe("");
  });
  it("History keeps a manual record and the milestone record of the same key apart", async () => {
    const h = new History(memKV());
    await h.putRecord(manual);
    expect(await h.alreadySent("010-1111-2222", "2028-05-17")).toBe(false);
    expect(await h.getRecord("010-1111-2222", "2028-05-17")).toBeNull();
    expect((await h.getRecord("010-1111-2222", "2028-05-17", "manual"))?.source).toBe("manual");
    expect(await h.recordSent(dueItemToEntry(item()), "sms", "2028-05-10T09:00:00")).toBe(true);
    const h2 = new History(memKV());
    await h2.putRecord(manual);
    await h2.putRecord(rec({ source: "term", sent_at: "2028-05-11T09:00:00" }));
    const t2 = (await h2.exportAll()).find((r) => r.source === "term");
    expect(sendStats(t2!)).toEqual({ first: "2028-05-11T09:00:00", count: 1 }); // manual not carried
    const all = await h.exportAll();
    expect(all).toHaveLength(2);
    expect((await h.getRecord("010-1111-2222", "2028-05-17"))?.source).toBe("term");
    // undoing a skip never removes the manual record
    await h.remove("010-1111-2222", "2028-05-17");
    expect((await h.exportAll()).map((r) => r.source)).toEqual(["manual"]);
  });
  it("dueItemToEntry stores the manual source override", () => {
    expect(dueItemToEntry(item(), "x", "manual").source).toBe("manual");
    expect(dueItemToEntry(item(), "x").source).toBe("term");
  });
  it("backup merge/restore keeps manual and milestone records of the same key", () => {
    const term = rec({ source: "term", sent_at: "2028-05-11T09:00:00" });
    expect(mergeHistory([term], [manual])).toHaveLength(2);
    expect(missingFromBackup([term, manual], [term])).toBe(1);
    const parsed = parseBackup(JSON.stringify(buildBackup(cfg(), [manual], "2026-07-03T00:00:00")));
    expect(parsed?.history[0].source).toBe("manual");
  });
  it("B11 lookup '안내 이력' shows a 1단계 (keepdate) send of a 약정 customer", () => {
    const TODAY = makeDate(2026, 11, 17);
    const open: PoncleRow = { openphone: "010-1111-2222", customer: "고객", opendate: "26-05-17", openhowx: "기변", telecomx: "KT" };
    const idx = new SentIndex([rec({ source: "keepdate", expiry_date: "2026-11-17", sent_at: "2026-11-10T09:00:00" })]);
    const [r] = buildLookupResults([open], cfg(), TODAY, 7, idx);
    expect(r.informedAt).toBe("2026-11-10T09:00:00");
    expect(lookupInformedAt(idx, r)).toBe("2026-11-10T09:00:00");
  });
});

/* ---------------- D1 decode stored history text ---------------- */
describe("D1 stored sent_log text is entity-decoded on read", () => {
  it("decodes agency/customer/plan/model/staff/telecom/openhow (body untouched), idempotently", async () => {
    const kv = memKV();
    kv.m.set("sent_log", JSON.stringify([rec({ agency: "PS&amp;M", customer: "A&amp;B", body: "PS&amp;M 원문" })]));
    const h = new History(kv);
    const [r] = await h.exportAll();
    expect(r.agency).toBe("PS&M");
    expect(r.customer).toBe("A&B");
    expect(r.body).toBe("PS&amp;M 원문");
    expect((await h.searchPage({})).rows[0].agency).toBe("PS&M");
    expect((await h.exportAll())[0].agency).toBe("PS&M");
    // a write persists the decoded text
    await h.setLastScan("x");
    await h.putRecord(rec({ phone: "010-9", expiry_date: "2026-01-01" }));
    expect(kv.m.get("sent_log")).not.toContain("&amp;M\"");
  });
});

/* ---------------- D3 lookup beyond the 미방문 tracking window ---------------- */
describe("D3 lookupStatus past the unvisited lookback", () => {
  const TODAY = makeDate(2026, 11, 17);
  it("within the tracking window keeps 미방문 · D+N", () => {
    const s = lookupStatus(makeDate(2026, 10, 17), TODAY, 7, false, makeDate(2026, 5, 17));
    expect(s.label).toBe("만료 지남 · 미방문 · D+31");
  });
  it("beyond the window shows only '만료 지남'", () => {
    const s = lookupStatus(makeDate(2015, 11, 1), TODAY, 7, false, makeDate(2026, 5, 17));
    expect(s.label).toBe("만료 지남");
    expect(s.tone).toBe("danger");
  });
  it("buildLookupResults uses unvisited_lookback_months", () => {
    const old: PoncleRow = { openphone: "010-1111-2222", customer: "고객", opendate: "13-01-01", openhowx: "기변", telecomx: "KT" };
    const [r] = buildLookupResults([old], cfg(), TODAY, 7, new Map());
    expect(r.status.label).toBe("만료 지남");
  });
});

/* ---------------- B15 / C5 minSdk gating ---------------- */
describe("B15 updates that need a newer Android are not offered", () => {
  const GH = "https://github.com/maestro24/poncle-expiry-notifier/releases/download";
  const r: GhRelease = {
    tag_name: "android-v1.2.18",
    body: "Android 8.0 이상 필요\nminSdk: 26\n- 수정",
    assets: [{ name: "app.apk", browser_download_url: `${GH}/android-v1.2.18/app.apk` }],
  };
  it("parseMinSdk reads a 'minSdk: N' line", () => {
    expect(parseMinSdk(r.body)).toBe(26);
    expect(parseMinSdk("no marker")).toBeNull();
  });
  it("sdkInt below minSdk -> unsupported", () => {
    const u = pickAndroidUpdate([r], "1.2.16", 24);
    expect(u.available).toBe(false);
    expect(u.reason).toBe("unsupported");
    expect(u.version).toBe("1.2.18");
  });
  it("sdkInt at/above minSdk, or unknown -> available", () => {
    expect(pickAndroidUpdate([r], "1.2.16", 26).available).toBe(true);
    expect(pickAndroidUpdate([r], "1.2.16").available).toBe(true);
  });
  it("checkForUpdate passes sdkInt through", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([r]), { status: 200 })) as typeof fetch;
    try {
      expect((await checkForUpdate("1.2.16", 24)).reason).toBe("unsupported");
      expect((await checkForUpdate("1.2.16")).available).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
