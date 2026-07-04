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

function gatewayReturning(rows: PoncleRow[]) {
  return {
    check: async () => true,
    listOpen: async () => ({ ok: true, total: rows.length, list: rows }),
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
});

describe("runScan", () => {
  it("session expired when listOpen returns ok:false (login page)", async () => {
    const gw = { check: async () => true, listOpen: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }) };
    const res = await runScan(gw, cfg(), new History(memKV()), TODAY);
    expect(res.status).toBe("session_expired");
  });

  it("network error (retryable) reports error state, not session_expired", async () => {
    const gw = { check: async () => true, listOpen: async () => ({ ok: false, netError: true, total: 0, list: [] as PoncleRow[] }) };
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
