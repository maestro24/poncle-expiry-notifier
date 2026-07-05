import { describe, expect, it, vi } from "vitest";
import { History, KV } from "../src/domain/history";
import { runScan } from "../src/domain/scan";
import { renderTemplate, sendAlert } from "../src/domain/sender";
import { DEFAULTS } from "../src/domain/config";
import { makeDate } from "../src/domain/plaindate";
import type { AppConfig, DueItem, PoncleRow } from "../src/domain/types";

function memKV(): KV {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
  };
}
function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULTS, ...over };
}
const TODAY = makeDate(2026, 7, 3);

// A 기변 opened 2024-07-03 with 24-month term expires 2026-07-03 == TODAY (D-0).
const dueRow: PoncleRow = {
  openphone: "010-1111-2222",
  customer: "홍길동",
  opendate: "24-07-03",
  openhowx: "기변",
  telecomx: "SK텔레콤",
  agencytitle: "CD대리점",
  model: "Galaxy S",
};
// Opened 2024-07-01 -> expiry 2026-07-01, not due today.
const notDueRow: PoncleRow = { ...dueRow, openphone: "010-3333-4444", opendate: "24-07-01" };

function gatewayReturning(rows: PoncleRow[], pending: PoncleRow[] = []) {
  return {
    check: async () => true,
    listOpen: async () => ({ ok: true, total: rows.length, list: rows }),
    listPending: async () => ({ ok: true, total: pending.length, list: pending }),
  };
}

/** Gateway that HONORS the server sdate/edate opendate filter (like real Poncle),
 *  so tests exercise the windowed fetch — not the all-rows fake. */
function dateFilterGateway(rows: PoncleRow[], pending: PoncleRow[] = []) {
  const toIsoY = (od: string) => {
    const p = String(od).split("-");
    let y = Number(p[0]);
    if (y < 100) y += 2000;
    return `${y}-${p[1]}-${p[2]}`;
  };
  return {
    check: async () => true,
    listPending: async () => ({ ok: true, total: pending.length, list: pending }),
    listOpen: async (p: Record<string, string>) => {
      const sd = p.sdate || "";
      const ed = p.edate || "";
      const inRange = rows.filter((r) => {
        const od = toIsoY(String(r.opendate ?? ""));
        return (!sd || od >= sd) && (!ed || od <= ed);
      });
      return { ok: true, total: inRange.length, list: inRange };
    },
  };
}

describe("History", () => {
  it("dedup on (phone, expiry) ignoring offset", async () => {
    const h = new History(memKV());
    const e = { phone: "010", customer: "김", opendate: "24-01-01", expiry_date: "2026-01-01",
      milestone_offset: 25, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" };
    expect(await h.recordSent(e, "sms", "2026-07-03T09:00:00")).toBe(true);
    // same phone+expiry but a different offset (fewer days left) -> still deduped
    expect(await h.recordSent({ ...e, milestone_offset: 3 }, "sms", "2026-07-03T09:01:00")).toBe(false);
    expect(await h.alreadySent("010", "2026-01-01")).toBe(true);
    expect(await h.alreadySent("010", "2026-02-01")).toBe(false); // different expiry
  });
  it("search filters by query and date", async () => {
    const h = new History(memKV());
    await h.recordSent({ phone: "010-1", customer: "김수현", opendate: "", expiry_date: "2026-01-01",
      milestone_offset: 0, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" }, "sms", "2026-07-01T09:00:00");
    await h.recordSent({ phone: "010-2", customer: "이영희", opendate: "", expiry_date: "2026-02-01",
      milestone_offset: 0, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" }, "sms", "2026-07-02T09:00:00");
    expect((await h.search("김")).length).toBe(1);
    expect((await h.search("010-2")).length).toBe(1);
    expect((await h.search("", "2026-07-02")).length).toBe(1);
    expect((await h.search()).length).toBe(2);
  });

  const dueItem = (phone: string, expiry: string): DueItem => ({
    id: `${phone}|${expiry}`, phone, customer: "", opendate: "", expiry_date: expiry,
    milestone_offset: 0, telecom: "", agency: "", openhow: "", plan: "", model: "", staff: "",
    already_sent: false, source: "term",
  });
  const base = { customer: "", opendate: "", milestone_offset: 0, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" };

  it("cacheUnvisited round-trips the last scan's 미방문 list", async () => {
    const h = new History(memKV());
    expect(await h.loadUnvisited()).toEqual([]);
    const rows = [dueItem("010-a", "2026-06-10"), dueItem("010-b", "2026-06-20")];
    await h.cacheUnvisited(rows);
    expect((await h.loadUnvisited()).map((r) => r.phone)).toEqual(["010-a", "010-b"]);
    await h.cacheUnvisited([]); // a later scan with none clears it
    expect(await h.loadUnvisited()).toEqual([]);
  });

  it("setHandled toggles the manual 방문완료 key set (works without a sent record)", async () => {
    const h = new History(memKV());
    expect((await h.handledKeys()).size).toBe(0);
    await h.setHandled("010-x", "2026-06-01", true);
    expect((await h.handledKeys()).has("010-x|2026-06-01")).toBe(true);
    await h.setHandled("010-x", "2026-06-01", false);
    expect((await h.handledKeys()).has("010-x|2026-06-01")).toBe(false);
  });

  it("migrateRecontacted folds legacy 연락완료 flags into the handled set, once", async () => {
    const kv = memKV();
    await kv.set("sent_log", JSON.stringify([
      { ...base, phone: "010-z", expiry_date: "2026-06-01", channel: "sms",
        sent_at: "2026-05-25T09:00:00", recontacted: true },
      { ...base, phone: "010-y", expiry_date: "2026-06-05", channel: "sms",
        sent_at: "2026-05-25T09:00:00" }, // never marked
    ]));
    const h = new History(kv);
    await h.migrateRecontacted();
    const keys = await h.handledKeys();
    expect(keys.has("010-z|2026-06-01")).toBe(true);
    expect(keys.has("010-y|2026-06-05")).toBe(false);
    // idempotent: after an unset, re-running migration must NOT re-add the key
    await h.setHandled("010-z", "2026-06-01", false);
    await h.migrateRecontacted();
    expect((await h.handledKeys()).has("010-z|2026-06-01")).toBe(false);
  });
});

describe("runScan", () => {
  it("session expired when listOpen returns ok:false (login page)", async () => {
    const gw = {
      check: async () => true,
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
      listOpen: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }),
    };
    const res = await runScan(gw, cfg(), new History(memKV()), TODAY);
    expect(res.status).toBe("session_expired");
  });

  it("network error (retryable) reports error state, not session_expired", async () => {
    const gw = {
      check: async () => true,
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
      listOpen: async () => ({ ok: false, netError: true, total: 0, list: [] as PoncleRow[] }),
    };
    const res = await runScan(gw, cfg(), new History(memKV()), TODAY);
    expect(res.status).toBe("error");
  });

  it("builds the due list, ignores not-due rows, marks already_sent, sorts unsent first", async () => {
    const history = new History(memKV());
    const gw = gatewayReturning([dueRow, notDueRow]);
    const res = await runScan(gw, cfg({ use_server_date_filter: false }), history, TODAY);
    expect(res.status).toBe("ok");
    expect(res.results.length).toBe(1); // only the due row
    const item = res.results[0];
    expect(item.customer).toBe("홍길동");
    expect(item.expiry_date).toBe("2026-07-03");
    expect(item.already_sent).toBe(false);
    expect(res.targets).toBe(1);
    expect(res.pending).toBe(1);
    // notDueRow expired 2026-07-01 (2 days ago, within look-back) -> 미방문, not due
    expect(res.unvisited.map((r) => r.phone)).toEqual(["010-3333-4444"]);
    expect(res.unvisited[0].expiry_date).toBe("2026-07-01");
  });

  it("reflects a prior send as already_sent", async () => {
    const history = new History(memKV());
    await history.recordSent({ phone: "010-1111-2222", customer: "홍길동", opendate: "24-07-03",
      expiry_date: "2026-07-03", milestone_offset: 0, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" },
      "sms", "2026-07-03T09:00:00");
    const res = await runScan(gatewayReturning([dueRow]), cfg({ use_server_date_filter: false }), history, TODAY);
    expect(res.results[0].already_sent).toBe(true);
    expect(res.sent).toBe(1);
    expect(res.pending).toBe(0);
  });

  it("hybrid: 유지일 overrides term + blacklists the phone; term covers the rest", async () => {
    const openRows: PoncleRow[] = [
      // A: term-expiry == today, BUT has a future 유지일 -> suppressed, not due today
      { openphone: "010-1111-2222", customer: "A", opendate: "24-07-03", openhowx: "기변", telecomx: "SK텔레콤", agencytitle: "CD대리점", model: "m" },
      // B: term-expiry == today, no 유지일 -> term item
      { openphone: "010-2222-3333", customer: "B", opendate: "24-07-03", openhowx: "기변", telecomx: "KT", agencytitle: "CD대리점", model: "m" },
      // C: term-expiry 2026-07-01 (not today), but 유지일 == today -> keepdate item
      { openphone: "010-3333-4444", customer: "C", opendate: "26-01-01", openhowx: "유심신규", telecomx: "KT", agencytitle: "쇼플러스", model: "m" },
    ];
    const pending: PoncleRow[] = [
      { gubunx: "요금제유지", condx: "접수", pendingdate: "2026-07-10", openphone: "010-1111-2222", name: "A" },
      { gubunx: "요금제유지", condx: "접수", pendingdate: "2026-07-03", openphone: "010-3333-4444", name: "C" },
    ];
    const res = await runScan(gatewayReturning(openRows, pending), cfg({ use_server_date_filter: false, notify_offsets_days: [0] }), new History(memKV()), TODAY);
    expect(res.status).toBe("ok");
    const byPhone = Object.fromEntries(res.results.map((r) => [r.phone, r]));
    expect(byPhone["010-1111-2222"]).toBeUndefined(); // 유지일 있음(미래) -> term 제외, 범위 밖 -> 안 뜸
    expect(byPhone["010-2222-3333"]?.source).toBe("term");
    expect(byPhone["010-2222-3333"]?.expiry_date).toBe("2026-07-03");
    expect(byPhone["010-3333-4444"]?.source).toBe("keepdate");
    expect(byPhone["010-3333-4444"]?.expiry_date).toBe("2026-07-03");
    expect(byPhone["010-3333-4444"]?.openhow).toBe("유심신규"); // joined from open
    expect(byPhone["010-3333-4444"]?.telecom).toBe("KT");
    expect(res.targets).toBe(2);
  });

  it("미방문 auto-clears a returned customer even with the server date filter ON", async () => {
    // Regression: the widened fetch must reach opendate==today so a returning
    // customer's NEW 개통 row is fetched and their old expired row is superseded.
    const expired: PoncleRow = { openphone: "010-7777-8888", customer: "복귀",
      opendate: "24-07-01", openhowx: "기변", telecomx: "KT", agencytitle: "CD대리점", model: "m" };
    const returned: PoncleRow = { ...expired, opendate: "26-07-03" }; // returned TODAY
    // default cfg -> use_server_date_filter true (the previously-broken path)
    const before = await runScan(dateFilterGateway([expired]), cfg(), new History(memKV()), TODAY);
    expect(before.unvisited.map((r) => r.phone)).toEqual(["010-7777-8888"]); // expired -> 미방문
    const after = await runScan(dateFilterGateway([expired, returned]), cfg(), new History(memKV()), TODAY);
    expect(after.unvisited).toEqual([]); // new open row (opendate today) fetched -> auto-cleared
  });

  it("degraded 미결 fetch flags pendingDegraded (so the caller skips caching unvisited)", async () => {
    const gw = {
      check: async () => true,
      listPending: async () => ({ ok: false, netError: true, total: 0, list: [] as PoncleRow[] }),
      listOpen: async () => ({ ok: true, total: 1, list: [dueRow] }),
    };
    const res = await runScan(gw, cfg({ use_server_date_filter: false }), new History(memKV()), TODAY);
    expect(res.status).toBe("ok"); // due list still stands (term-only degrade)
    expect(res.pendingDegraded).toBe(true);
  });
});

describe("sendAlert", () => {
  const item: DueItem = {
    id: "x", phone: "010-1111-2222", customer: "홍길동", opendate: "24-07-03",
    expiry_date: "2026-07-03", milestone_offset: 0, telecom: "SK텔레콤", agency: "CD대리점",
    openhow: "기변", plan: "", model: "Galaxy S", staff: "", already_sent: false,
  };
  const nowIso = () => "2026-07-03T09:00:00";

  it("deliver off: records only, no SMS", async () => {
    const history = new History(memKV());
    const sendSms = vi.fn();
    const res = await sendAlert(item, cfg({ deliver_alerts: false }), { history, sendSms, nowIso }, "본문");
    expect(res.status).toBe("sent");
    expect(res.channel).toBe("record-only");
    expect(sendSms).not.toHaveBeenCalled();
    // second send is deduped
    expect((await sendAlert(item, cfg({ deliver_alerts: false }), { history, sendSms, nowIso }, "본문")).status).toBe("already");
  });

  it("deliver on: sends the resolved body and records channel sms", async () => {
    const history = new History(memKV());
    const sendSms = vi.fn(async () => undefined);
    const body = renderTemplate(item, "{customer}/{telecom}/{expiry}/{when}");
    expect(body).toBe("홍길동/SK텔레콤/2026-07-03/오늘 2026-07-03");
    const res = await sendAlert(item, cfg({ deliver_alerts: true }), { history, sendSms, nowIso }, body);
    expect(res.status).toBe("sent");
    expect(res.channel).toBe("sms");
    expect(sendSms).toHaveBeenCalledWith("010-1111-2222", body);
  });

  it("deliver on: SMS failure -> error, not recorded", async () => {
    const history = new History(memKV());
    const sendSms = vi.fn(async () => { throw new Error("permission denied"); });
    const res = await sendAlert(item, cfg({ deliver_alerts: true }), { history, sendSms, nowIso }, "본문");
    expect(res.status).toBe("error");
    expect(res.error).toContain("permission denied"); // native reason surfaced as-is
    expect(await history.alreadySent(item.phone, item.expiry_date)).toBe(false);
  });
});
