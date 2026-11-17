/**
 * Stage 2 (P1) domain fixes — audit 1-4, 1-9/1-10, 1-12, 1-14, 1-15, 1-16, 1-29,
 * 1-30, 1-33, 1-36, improvement 3-2 and review leftovers L2/L4.
 */
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/domain/config";
import { correctCohortInformed, type CohortEntry } from "../src/domain/cohort";
import { refreshDueOffsets } from "../src/domain/due-item";
import {
  CATCH_UP_MAX_DAYS,
  catchUpAnchor,
  catchUpDaysSince,
  formatWhen,
  milestoneDue,
  scanOpenDateBounds,
} from "../src/domain/expiry";
import { History, SentIndex, inferSource, type KV, type SentRecord } from "../src/domain/history";
import { keepDueRows, keepPhoneSet } from "../src/domain/keepdate";
import { buildLookupResults, lookupToDueItem } from "../src/domain/lookup";
import { addMonths, makeDate, toIso } from "../src/domain/plaindate";
import { runScan } from "../src/domain/scan";
import {
  OPENDATE_MISSING_MARK,
  formatDdayLabel,
  hasKnownOpendate,
  renderTemplate,
  templateNeedsOpendate,
} from "../src/domain/sender";
import type { AppConfig, DueItem, PoncleRow } from "../src/domain/types";
import { computeUnvisited, latestOpenByPhone } from "../src/domain/unvisited";

function memKV(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}
const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over });
const TODAY = makeDate(2026, 7, 3);

const open = (phone: string, opendate: string, over: Partial<PoncleRow> = {}): PoncleRow => ({
  openphone: phone, customer: "고객", opendate, openhowx: "기변", telecomx: "KT",
  agencytitle: "CD대리점", model: "m", ...over,
});
const pend = (phone: string, pendingdate: string, over: Partial<PoncleRow> = {}): PoncleRow => ({
  gubunx: "요금제유지", condx: "접수", pendingdate, openphone: phone, name: "고객", ...over,
});
const rec = (over: Partial<SentRecord> = {}): SentRecord => ({
  phone: "010-1111-2222", customer: "고객", opendate: "24-07-03", expiry_date: "2026-07-03",
  milestone_offset: 0, telecom: "KT", agency: "", plan: "", model: "", openhow: "기변", staff: "",
  channel: "sms", sent_at: "2026-07-03T09:00:00", ...over,
});
const item = (over: Partial<DueItem> = {}): DueItem => ({
  id: "", phone: "010-1111-2222", customer: "홍길동", opendate: "24-07-03", expiry_date: "2026-07-03",
  milestone_offset: 0, telecom: "KT", agency: "", openhow: "기변", plan: "", model: "", staff: "",
  already_sent: false, source: "term", ...over,
});

function gw(rows: PoncleRow[], pending: PoncleRow[] = []) {
  return {
    check: async () => true,
    listOpen: async () => ({ ok: true, total: rows.length, list: rows }),
    listPending: async () => ({ ok: true, total: pending.length, list: pending }),
  };
}
/** Honors the server sdate/edate opendate filter like real Poncle. */
function filterGw(rows: PoncleRow[], pending: PoncleRow[] = []) {
  const iso = (od: string) => {
    const p = String(od).split("-");
    let y = Number(p[0]);
    if (y < 100) y += 2000;
    return `${y}-${p[1]}-${p[2]}`;
  };
  return {
    check: async () => true,
    listPending: async () => ({ ok: true, total: pending.length, list: pending }),
    listOpen: async (p: Record<string, string>) => {
      const list = rows.filter((r) => {
        const od = iso(String(r.opendate ?? ""));
        return (!p.sdate || od >= p.sdate) && (!p.edate || od <= p.edate);
      });
      return { ok: true, total: list.length, list };
    },
  };
}
const NOFILTER = { use_server_date_filter: false, notify_offsets_days: [0] };

/* ---------------- #13 (1-9, 1-10) 유지일 대표 만료 ---------------- */
describe("#13 keepdate customers use the 폰클 유지일 as representative expiry", () => {
  // 유심 opened 26-01-01: default 개통+6개월 = 2026-07-01, but 폰클 유지일 = 2026-07-02.
  const usim = open("010-2222-3333", "26-01-01", { openhowx: "유심신규" });
  const keep = pend("010-2222-3333", "2026-07-02");

  it("computeUnvisited keys a 유심 customer on the pendingdate (same as home Pass A)", () => {
    const out = computeUnvisited([usim], cfg(), TODAY, new Set(), [keep]);
    expect(out.map((r) => r.id)).toEqual(["01022223333|2026-07-02"]);
    expect(out[0].expiry_date).toBe("2026-07-02");
  });
  it("ignores a 유지일 from a PREVIOUS contract (before the latest opendate)", () => {
    const out = computeUnvisited([usim], cfg(), TODAY, new Set(), [pend("010-2222-3333", "2025-12-01")]);
    expect(out[0].expiry_date).toBe("2026-07-01");
  });
  it("약정 대상 keep the term (약정 만료) as representative expiry", () => {
    const row = open("010-1111-2222", "24-06-01");
    const out = computeUnvisited([row], cfg(), TODAY, new Set(), [pend("010-1111-2222", "2024-12-01")]);
    expect(out[0].expiry_date).toBe("2026-06-01");
  });
  it("lookup joins the 유지일 so its key/informed matches home", () => {
    const sent = new Map([["01022223333|2026-07-02", "2026-07-02T09:00:00"]]);
    const [r] = buildLookupResults([usim], cfg(), TODAY, 30, sent, [keep]);
    expect(r.expiry_date).toBe("2026-07-02");
    expect(r.id).toBe("01022223333|2026-07-02");
    expect(r.informedAt).toBe("2026-07-02T09:00:00");
  });
  it("runScan: 미방문 uses the 유지일 key", async () => {
    const res = await runScan(gw([usim], [keep]), cfg(NOFILTER), new History(memKV()), TODAY);
    expect(res.unvisited.map((r) => r.id)).toEqual(["01022223333|2026-07-02"]);
  });
});

/* ---------------- #15 (1-30) degraded scan ---------------- */
describe("#15 degraded 미결 fetch flags Pass B items", () => {
  const degradedGw = (rows: PoncleRow[]) => ({
    check: async () => true,
    listPending: async () => ({ ok: false, netError: true, total: 0, list: [] as PoncleRow[] }),
    listOpen: async () => ({ ok: true, total: rows.length, list: rows }),
  });
  it("Pass B (개통+기본 개월) items are degraded:true; term items are not", async () => {
    const rows = [
      open("010-6666-7777", "26-01-03", { openhowx: "유심신규" }), // Pass B 2026-07-03
      open("010-1111-2222", "24-07-03"), // term 2026-07-03
    ];
    const res = await runScan(degradedGw(rows), cfg(NOFILTER), new History(memKV()), TODAY);
    const by = Object.fromEntries(res.results.map((r) => [r.phone, r]));
    expect(res.pendingDegraded).toBe(true);
    expect(by["010-6666-7777"].degraded).toBe(true);
    expect(by["010-1111-2222"].degraded).toBeFalsy();
  });
  it("a normal scan never sets degraded", async () => {
    const res = await runScan(gw([open("010-6666-7777", "26-01-03")]), cfg(NOFILTER), new History(memKV()), TODAY);
    expect(res.results.every((r) => !r.degraded)).toBe(true);
  });
  it("a stage-1 send under the 유지일 key still counts for the degraded Pass B item", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-6666-7777", opendate: "26-01-03", expiry_date: "2026-07-05", openhow: "유심신규" }));
    const res = await runScan(degradedGw([open("010-6666-7777", "26-01-03", { openhowx: "유심신규" })]), cfg(NOFILTER), h, TODAY);
    expect(res.results[0].expiry_date).toBe("2026-07-03");
    expect(res.results[0].already_sent).toBe(true);
  });
});

/* ---------------- #16 (1-36) duplicate 유지일 per phone ---------------- */
describe("#16 keepDueRows dedupes per phone and skips empty phones", () => {
  it("two 유지일 미결 for one phone -> one row (latest 유지일)", () => {
    const rows = [pend("010-1", "2026-07-20"), pend("010-1", "2026-07-28")];
    const out = keepDueRows(rows, cfg({ notify_offsets_days: [30] }), TODAY);
    expect(out.map((r) => r.keepdateIso)).toEqual(["2026-07-28"]);
  });
  it("rows with an empty phone are skipped", () => {
    const rows = [pend("", "2026-07-03", { phone: "" }), pend("", "2026-07-03", { phone: "" })];
    expect(keepDueRows(rows, cfg(), TODAY)).toEqual([]);
  });
});

/* ---------------- #17 (1-12) record-only must not downgrade sms ---------------- */
describe("#17 putRecord never downgrades a real sms record to record-only", () => {
  it("keeps channel/sent_at/body of the sms record", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ body: "원문", sent_at: "2026-07-01T09:00:00" }));
    await h.putRecord(rec({ channel: "record-only", body: "연습", sent_at: "2026-07-03T10:00:00" }));
    const all = await h.exportAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ channel: "sms", body: "원문", sent_at: "2026-07-01T09:00:00" });
  });
  it("record-only over record-only / none still writes", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ channel: "record-only", body: "a" }));
    await h.putRecord(rec({ channel: "record-only", body: "b" }));
    expect((await h.exportAll()).map((r) => r.body)).toEqual(["b"]);
  });
  it("sms over sms (재발송) still replaces", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ body: "a" }));
    await h.putRecord(rec({ body: "b" }));
    expect((await h.exportAll()).map((r) => r.body)).toEqual(["b"]);
  });
});

/* ---------------- #19 (1-29) robust sent-state matching ---------------- */
describe("#19 SentIndex matches a contract by phone+opendate+source when the expiry differs", () => {
  // sent at 24개월: 24-08-03 + 24 = 2026-08-03 (no source field: an old record)
  const sent24 = rec({ opendate: "24-08-03", expiry_date: "2026-08-03" });

  it("exact key still matches", () => {
    const idx = new SentIndex([sent24]);
    expect(idx.isHandled({ phone: "01011112222", expiry_date: "2026-08-03" })).toBe(true);
    expect(idx.has("01011112222|2026-08-03")).toBe(true);
  });
  it("same phone+opendate+source with a different expiry -> handled (약정 개월 changed)", () => {
    const idx = new SentIndex([sent24]);
    const t = { phone: "010-1111-2222", expiry_date: "2026-07-03", opendate: "24-08-03", openhow: "기변", source: "term" as const };
    expect(idx.isHandled(t)).toBe(true);
    expect(idx.stateOf(t)).toBe("sent");
    expect(idx.recordFor(t)?.expiry_date).toBe("2026-08-03");
    expect(idx.sentAt(t)).toBe("2026-07-03T09:00:00");
  });
  it("a different stage (keepdate vs term) of the same contract does NOT match", () => {
    const idx = new SentIndex([sent24]);
    expect(idx.isHandled({ phone: "010-1111-2222", expiry_date: "2025-02-03", opendate: "24-08-03", source: "keepdate" })).toBe(false);
  });
  it("unknown opendate never falls back; record-only/failed never count", () => {
    expect(new SentIndex([sent24]).isHandled({ phone: "010-1111-2222", expiry_date: "2026-07-03", opendate: "", source: "term" })).toBe(false);
    const practice = new SentIndex([{ ...sent24, channel: "record-only" }]);
    const t = { phone: "010-1111-2222", expiry_date: "2026-07-03", opendate: "24-08-03", source: "term" as const };
    expect(practice.isHandled(t)).toBe(false);
    expect(practice.stateOf(t)).toBe("recorded");
    expect(practice.sentAt(t)).toBe("");
  });
  it("an explicit record.source wins over the gap heuristic", () => {
    const keepRec = rec({ opendate: "24-08-03", expiry_date: "2026-08-03", source: "keepdate" });
    const idx = new SentIndex([keepRec]);
    expect(idx.isHandled({ phone: "010-1111-2222", expiry_date: "2026-07-03", opendate: "24-08-03", source: "term" })).toBe(false);
  });
  it("a legacy (no source) record's stage follows the CONFIGURED months, not a fixed gap", () => {
    // 요금제 유지 기본 개월 = 10: a legacy 1단계 send 24-01-01 -> 2024-11-01 (305 days)
    const legacy1 = rec({ opendate: "24-01-01", expiry_date: "2024-11-01" });
    const c10 = cfg({ keepdate_default_months: 10 });
    const term = { phone: "010-1111-2222", expiry_date: "2026-01-01", opendate: "24-01-01", openhow: "기변", source: "term" as const };
    const idx = new SentIndex([legacy1], c10);
    expect(idx.stateOf(term)).toBe("none"); // the 약정 만료 (2단계) is still offered
    expect(idx.isHandled({ ...term, expiry_date: "2024-11-03", source: "keepdate" })).toBe(true);
    expect(inferSource(legacy1, c10)).toBe("keepdate");
    // and a legacy 2단계 send stays 'term' after 약정 개월 changes 24 -> 30
    expect(inferSource(rec({ opendate: "24-01-01", expiry_date: "2026-01-01" }), cfg({ default_term_months: 30 }))).toBe("term");
  });
  it("legacy stage is ambiguous (no contract fallback) when both stages use the same months", () => {
    const c = cfg({ keepdate_default_months: 24, default_term_months: 24 });
    const legacy = rec({ opendate: "24-01-01", expiry_date: "2026-01-01" });
    expect(inferSource(legacy, c)).toBe("");
    const idx = new SentIndex([legacy], c);
    expect(idx.isHandled({ phone: "010-1111-2222", expiry_date: "2026-01-05", opendate: "24-01-01", source: "term" })).toBe(false);
    expect(idx.isHandled({ phone: "010-1111-2222", expiry_date: "2026-01-01", opendate: "24-01-01", source: "term" })).toBe(true); // exact key
  });
  it("History.sentIndex / findRecord take the config for legacy stages", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ opendate: "24-01-01", expiry_date: "2024-11-01" }));
    const term = { phone: "010-1111-2222", expiry_date: "2026-01-01", opendate: "24-01-01", openhow: "기변", source: "term" as const };
    const c10 = cfg({ keepdate_default_months: 10 });
    expect((await h.sentIndex(c10)).stateOf(term)).toBe("none");
    expect(await h.findRecord(term, c10)).toBeNull();
  });
  it("runScan with 기본 개월 10: a legacy 1단계 send does not mark the 약정 만료 sent", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ opendate: "24-07-03", expiry_date: "2025-05-03" })); // 10개월 1단계 (legacy)
    const res = await runScan(gw([open("010-1111-2222", "24-07-03")]), cfg({ ...NOFILTER, keepdate_default_months: 10 }), h, TODAY);
    const term = res.results.find((r) => r.source === "term")!;
    expect(term.expiry_date).toBe("2026-07-03");
    expect(term.already_sent).toBe(false);
  });
  it("runScan marks already_sent after 약정 개월 24 -> 23", async () => {
    const h = new History(memKV());
    await h.putRecord(sent24);
    const res = await runScan(gw([open("010-1111-2222", "24-08-03")]), cfg({ ...NOFILTER, default_term_months: 23 }), h, TODAY);
    const term = res.results.find((r) => r.source === "term")!;
    expect(term.expiry_date).toBe("2026-07-03");
    expect(term.already_sent).toBe(true);
    expect(term.sent_state).toBe("sent");
  });
  it("History.findRecord / sentIndex expose the fallback", async () => {
    const h = new History(memKV());
    await h.putRecord(sent24);
    const t = { phone: "010-1111-2222", expiry_date: "2026-07-03", opendate: "24-08-03", source: "term" as const };
    expect((await h.findRecord(t))?.expiry_date).toBe("2026-08-03");
    expect(await h.findRecord({ ...t, source: "keepdate" })).toBeNull();
    expect((await h.sentIndex()).isHandled(t)).toBe(true);
  });
  it("computeUnvisited accepts a SentIndex", () => {
    const idx = new SentIndex([rec({ opendate: "24-06-01", expiry_date: "2026-06-05" })]);
    const out = computeUnvisited([open("010-1111-2222", "24-06-01")], cfg(), TODAY, idx);
    expect(out[0].expiry_date).toBe("2026-06-01");
    expect(out[0].already_sent).toBe(true);
  });
  it("lookup accepts a SentIndex for informedAt", () => {
    const idx = new SentIndex([rec({ opendate: "24-07-20", expiry_date: "2026-08-20" })]);
    const [r] = buildLookupResults([open("010-1111-2222", "24-07-20")], cfg(), TODAY, 30, idx);
    expect(r.expiry_date).toBe("2026-07-20");
    expect(r.informedAt).toBe("2026-07-03T09:00:00");
  });
});

/* ---------------- #20 (1-4) catch-up of passed milestones ---------------- */
describe("#20 milestones passed since the last successful scan are caught up", () => {
  it("catchUpDaysSince: days since the last scan, capped, never negative", () => {
    expect(catchUpDaysSince("2026-07-01", TODAY)).toBe(2);
    expect(catchUpDaysSince("2026-07-03", TODAY)).toBe(0);
    expect(catchUpDaysSince("", TODAY)).toBe(0);
    expect(catchUpDaysSince("garbage", TODAY)).toBe(0);
    expect(catchUpDaysSince("2026-08-01", TODAY)).toBe(0); // clock went back
    expect(catchUpDaysSince("2026-01-01", TODAY)).toBe(CATCH_UP_MAX_DAYS);
    expect(CATCH_UP_MAX_DAYS).toBe(14);
  });
  it("milestoneDue includes a milestone up to catchUpDays in the past (negative offset)", () => {
    const c = cfg({ notify_offsets_days: [0] });
    expect(milestoneDue("24-07-01", 24, c, TODAY)).toBeNull(); // default unchanged
    const due = milestoneDue("24-07-01", 24, c, TODAY, 2);
    expect(due![0]).toBe(-2);
    expect(toIso(due![1])).toBe("2026-07-01");
    expect(milestoneDue("24-06-30", 24, c, TODAY, 2)).toBeNull(); // 3 days ago > catch-up
  });
  it("keepDueRows catches up a passed 유지일", () => {
    const rows = [pend("010-1", "2026-07-01")];
    expect(keepDueRows(rows, cfg(), TODAY)).toEqual([]);
    expect(keepDueRows(rows, cfg(), TODAY, 2)[0].offset).toBe(-2);
  });
  it("runScan with sinceDate surfaces a weekend stage-1 milestone as overdue (D+2)", async () => {
    const row = open("010-6666-7777", "26-01-01"); // 개통+6개월 = 2026-07-01 (2 days ago)
    const without = await runScan(gw([row]), cfg(NOFILTER), new History(memKV()), TODAY);
    expect(without.results).toEqual([]);
    const withIt = await runScan(gw([row]), cfg(NOFILTER), new History(memKV()), TODAY, { sinceDate: "2026-06-30" });
    expect(withIt.results.map((r) => [r.source, r.expiry_date, r.milestone_offset])).toEqual([["keepdate", "2026-07-01", -2]]);
  });
  it("runScan catch-up widens the fetch bounds so the passed term milestone is fetched", async () => {
    const row = open("010-1111-2222", "24-06-25"); // 약정 만료 2026-06-25 (8 days ago)
    const c = cfg({ notify_offsets_days: [0], unvisited_lookback_months: 0 });
    const res = await runScan(filterGw([row]), c, new History(memKV()), TODAY, { sinceDate: "2026-06-19" });
    expect(res.results.map((r) => r.expiry_date)).toEqual(["2026-06-25"]);
    expect(res.results[0].milestone_offset).toBe(-8);
  });
  it("Pass A catch-up via sinceDate", async () => {
    const res = await runScan(
      gw([open("010-3333-4444", "26-01-01", { openhowx: "유심신규" })], [pend("010-3333-4444", "2026-07-02")]),
      cfg(NOFILTER), new History(memKV()), TODAY, { sinceDate: "2026-07-01" },
    );
    expect(res.results.map((r) => [r.expiry_date, r.milestone_offset])).toEqual([["2026-07-02", -1]]);
  });
  it("catchUpAnchor: the last CLEAN scan wins; pre-upgrade falls back to the scan date", () => {
    expect(catchUpAnchor("2026-07-01", "2026-07-02")).toBe("2026-07-01");
    expect(catchUpAnchor("", "2026-07-02")).toBe("2026-07-02");
    expect(catchUpAnchor("", "")).toBe("");
  });
  it("History persists the clean-scan anchor separately from the due cache date", async () => {
    const h = new History(memKV());
    expect(await h.getCleanScanDate()).toBe("");
    await h.cacheDueList([], "2026-07-02");
    await h.setCleanScanDate("2026-07-01");
    expect(await h.getCleanScanDate()).toBe("2026-07-01");
    expect(await h.getDueCacheDate()).toBe("2026-07-02");
  });
  it("consecutive degraded days: catching up from the clean anchor keeps the milestone", async () => {
    // milestone 07-01; degraded scans on 07-01 and 07-02; clean scan today (07-03)
    const row = open("010-6666-7777", "26-01-01", { openhowx: "유심신규" });
    const fromDegraded = await runScan(gw([row]), cfg(NOFILTER), new History(memKV()), TODAY, { sinceDate: "2026-07-02" });
    expect(fromDegraded.results).toEqual([]); // the bug: anchoring on the degraded day loses it
    const anchor = catchUpAnchor("2026-06-30", "2026-07-02");
    const fromClean = await runScan(gw([row]), cfg(NOFILTER), new History(memKV()), TODAY, { sinceDate: anchor });
    expect(fromClean.results.map((r) => [r.expiry_date, r.milestone_offset])).toEqual([["2026-07-01", -2]]);
  });
  it("refreshDueOffsets keeps a cached overdue (catch-up) row within the cap", () => {
    const cached = item({ expiry_date: "2026-07-01", milestone_offset: -2 });
    const out = refreshDueOffsets([cached], TODAY);
    expect(out.map((r) => r.milestone_offset)).toEqual([-2]);
    // beyond the cap it is dropped (belongs to 미방문)
    expect(refreshDueOffsets([item({ expiry_date: "2026-06-01", milestone_offset: -1 })], TODAY)).toEqual([]);
  });
  it("refreshDueOffsets re-derives an unsent D-0 row as overdue D+N on a later day (no rescan needed)", () => {
    // shown 'D-0' yesterday (cached offset 0), app reopened today: stays, as D+1
    const out = refreshDueOffsets([item({ expiry_date: "2026-07-02", milestone_offset: 0 })], TODAY);
    expect(out.map((r) => [r.expiry_date, r.milestone_offset])).toEqual([["2026-07-02", -1]]);
    // a cached D-3 that passed 2 days ago -> D+2
    expect(refreshDueOffsets([item({ expiry_date: "2026-07-01", milestone_offset: 3 })], TODAY)[0].milestone_offset).toBe(-2);
    // an already-handled row that passed is dropped (nothing left to do on home)
    expect(refreshDueOffsets([item({ expiry_date: "2026-07-02", milestone_offset: 0, already_sent: true })], TODAY)).toEqual([]);
    // past the catch-up cap it is dropped either way
    expect(refreshDueOffsets([item({ expiry_date: "2026-06-18", milestone_offset: 0 })], TODAY)).toEqual([]);
    expect(refreshDueOffsets([item({ expiry_date: "2026-06-19", milestone_offset: 0 })], TODAY)[0].milestone_offset).toBe(-CATCH_UP_MAX_DAYS);
  });
});

/* ---------------- #21 (1-16) blacklist only for the current contract ---------------- */
describe("#21 keepPhoneSet ignores 유지일 of a previous contract", () => {
  it("with latestOpen: only 유지일 on/after the current opendate blacklist the phone", () => {
    const latest = latestOpenByPhone([open("010-1", "26-01-03"), open("010-2", "26-01-03")]);
    const set = keepPhoneSet([
      pend("010-1", "2020-01-01", { condx: "해결" }), // old contract
      pend("010-2", "2026-07-05"), // current contract
    ], latest);
    expect(set.has("0101")).toBe(false);
    expect(set.has("0102")).toBe(true);
  });
  it("runScan: an old resolved 유지일 no longer suppresses the current contract's 1단계", async () => {
    const res = await runScan(
      gw([open("010-1111-2222", "26-01-03")], [pend("010-1111-2222", "2020-01-01", { condx: "해결" })]),
      cfg(NOFILTER), new History(memKV()), TODAY,
    );
    expect(res.results.map((r) => [r.source, r.expiry_date])).toEqual([["keepdate", "2026-07-03"]]);
  });
  it("runScan: a 유지일 that passed BEFORE the re-contract is not surfaced (Pass A stale)", async () => {
    const res = await runScan(
      gw([open("010-1111-2222", "26-07-02", { openhowx: "유심신규" })], [pend("010-1111-2222", "2026-07-01")]),
      cfg(NOFILTER), new History(memKV()), TODAY, { sinceDate: "2026-06-30" },
    );
    expect(res.results).toEqual([]);
  });
});

/* ---------------- #22 (1-15) upper bound reaches today ---------------- */
describe("#22 scan fetch upper bound always reaches today", () => {
  it("lookback 0 still extends edate to today", () => {
    expect(scanOpenDateBounds(cfg({ unvisited_lookback_months: 0 }), TODAY).edate >= "2026-07-03").toBe(true);
  });
  it("runScan (lookback 0, date filter): a re-contracted customer's old term is not surfaced", async () => {
    const rows = [open("010-1111-2222", "24-07-03"), open("010-1111-2222", "26-06-01")];
    const res = await runScan(filterGw(rows), cfg({ notify_offsets_days: [0], unvisited_lookback_months: 0 }), new History(memKV()), TODAY);
    expect(res.results.filter((r) => r.phone === "010-1111-2222")).toEqual([]);
  });
});

/* ---------------- #23 (3-2, 1-14) D-day / {when} from expiry vs today ---------------- */
describe("#23 D-day labels and {when} come from expiry vs today", () => {
  it("formatDdayLabel", () => {
    expect(formatDdayLabel(0)).toBe("오늘 만료");
    expect(formatDdayLabel(3)).toBe("D-3");
    expect(formatDdayLabel(-2)).toBe("D+2 지남");
  });
  it("formatWhen renders past expiries as D+N", () => {
    expect(formatWhen(-12, makeDate(2026, 11, 4))).toBe("D+12 (2026-11-04)");
    expect(formatWhen(0, makeDate(2026, 11, 4))).toBe("오늘 2026-11-04");
    expect(formatWhen(3, makeDate(2026, 11, 4))).toBe("D-3 (2026-11-04)");
  });
  it("renderTemplate {when} ignores a stale milestone_offset", () => {
    const it2 = item({ expiry_date: "2026-07-05", milestone_offset: 5 }); // cached days ago
    expect(renderTemplate(it2, "{when}", TODAY)).toBe("D-2 (2026-07-05)");
  });
  it("renderTemplate {when} for an expired (미방문, positive D+ offset) customer reads D+N", () => {
    const uv = item({ expiry_date: "2026-06-21", milestone_offset: 12 });
    expect(renderTemplate(uv, "{when}", TODAY)).toBe("D+12 (2026-06-21)");
  });
  it("lookup offsetDays is signed (expired -> negative), not clamped to 오늘", () => {
    const [r] = buildLookupResults([open("010-1", "24-06-01")], cfg(), TODAY, 30, new Map());
    expect(r.offsetDays).toBe(-32);
    expect(lookupToDueItem(r).milestone_offset).toBe(-32);
    expect(renderTemplate(lookupToDueItem(r), "{when}", TODAY)).toBe("D+32 (2026-06-01)");
  });
});

/* ---------------- #25 (1-33) unknown opendate ---------------- */
describe("#25 {months}/{years} with an unknown opendate", () => {
  it("templateNeedsOpendate", () => {
    expect(templateNeedsOpendate("{months}개월 전 개통")).toBe(true);
    expect(templateNeedsOpendate("{years}년 전")).toBe(true);
    expect(templateNeedsOpendate("{customer}님 {when}")).toBe(false);
    expect(templateNeedsOpendate("")).toBe(false);
  });
  it("hasKnownOpendate", () => {
    expect(hasKnownOpendate(item())).toBe(true);
    expect(hasKnownOpendate(item({ opendate: "" }))).toBe(false);
    expect(hasKnownOpendate(item({ opendate: "garbage" }))).toBe(false);
  });
  it("renders a visible marker instead of a false '1'", () => {
    const out = renderTemplate(item({ opendate: "" }), "{months}개월/{years}년", TODAY);
    expect(out).toBe(`${OPENDATE_MISSING_MARK}개월/${OPENDATE_MISSING_MARK}년`);
    expect(out).not.toContain("1");
  });
});

/* ---------------- L2 only transitions to failed are reported ---------------- */
describe("L2 applySendResults reports only NEW failures", () => {
  it("re-applying a fail result to an already-failed record is not re-reported", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ sms_id: "s1" }));
    const first = await h.applySendResults([{ id: "s1", status: "fail", reason: "x", at: "t" }]);
    expect(first.failed).toHaveLength(1);
    const again = await h.applySendResults([{ id: "s1", status: "fail", reason: "x", at: "t" }]);
    expect(again.failed).toEqual([]);
    expect((await h.getRecord("010-1111-2222", "2026-07-03"))?.delivery).toBe("failed");
  });
});

/* ---------------- L4 cohort informed migration ---------------- */
describe("L4 cohort informed=true from record-only is corrected once", () => {
  const entry = (phone: string, informed: boolean): CohortEntry =>
    ({ phone, expiry: "2026-06-01", informed, revisited: false, firstSeen: "2026-06-02" });

  it("correctCohortInformed keeps informed only when a handled record exists", () => {
    const out = correctCohortInformed([entry("010-1", true), entry("010-2", true), entry("010-3", false)], new Set(["0101|2026-06-01"]));
    expect(out.map((e) => e.informed)).toEqual([true, false, false]);
  });
  it("History.migrateCohortInformed runs once", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-1", expiry_date: "2026-06-01" }));
    await h.putRecord(rec({ phone: "010-2", expiry_date: "2026-06-01", channel: "record-only" }));
    await h.saveCohort([entry("010-1", true), entry("010-2", true)]);
    expect(await h.migrateCohortInformed()).toBe(1);
    expect((await h.loadCohort()).map((e) => e.informed)).toEqual([true, false]);
    await h.saveCohort([entry("010-2", true)]); // set later by a real send elsewhere
    expect(await h.migrateCohortInformed()).toBe(0); // one-shot
    expect((await h.loadCohort())[0].informed).toBe(true);
  });
  it("runScan applies the migration before updating the cohort", async () => {
    const h = new History(memKV());
    await h.putRecord(rec({ phone: "010-2", expiry_date: "2026-06-01", channel: "record-only" }));
    await h.saveCohort([entry("010-2", true)]);
    await runScan(gw([]), cfg(NOFILTER), h, TODAY);
    expect((await h.loadCohort())[0].informed).toBe(false);
  });
});

// keep the import used (addMonths) for bound sanity in a readable way
it("sanity: 24-06-25 + 24 months is 2026-06-25", () => {
  expect(toIso(addMonths(makeDate(2024, 6, 25), 24))).toBe("2026-06-25");
});
