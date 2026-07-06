// @vitest-environment happy-dom
/**
 * Controller-level E2E for the WebView-layer fixes. Boots the REAL app controller
 * (src/main.ts) against the real index.html in a happy-dom document, with only the
 * native Capacitor plugins mocked (SMS / Poncle gateway / storage). Drives real user
 * clicks and asserts the observable outcome — this is the closest automated proxy to
 * running the app on the device for the fixes that live in the WebView:
 *   #1 send-first-then-record (no phantom "sent" on a failed/interrupted send)
 *   #3 scan re-entry guard (parallel scans can't race)
 *   #2 restore confirmation before a history-shrinking overwrite
 *   #8 stored-XSS neutralized when the 이력 list renders an untrusted channel
 *
 * The native-only fixes (#5 permission→settings, #6 login autofill guard) are Java
 * and are covered by the on-device smoke script, not here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoncleRow } from "../../src/domain/types";

// Shared, hoisted control surface referenced by the vi.mock factories AND the tests.
const ctl = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  gwRows: [] as PoncleRow[],
  gwPending: [] as PoncleRow[],
  pendingCalls: 0,
  openCalls: 0,
  pendingGate: null as null | { promise: Promise<void>; resolve: () => void },
  sms: { calls: [] as Array<{ phone: string; text: string }>, mode: "resolve" as "resolve" | "reject" | "manual", rejectMsg: "발송 실패", pending: null as null | { res: () => void; rej: (e: Error) => void } },
  confirmReturn: true,
  confirmCalls: [] as string[],
  openedSettings: 0,
  openedUrls: [] as string[],
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: ctl.prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => { ctl.prefs.set(key, value); },
    remove: async ({ key }: { key: string }) => { ctl.prefs.delete(key); },
  },
}));
vi.mock("@capacitor/share", () => ({ Share: { share: async () => ({}) } }));
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { writeFile: async () => ({ uri: "x" }), readFile: async () => ({ data: "" }) },
  Directory: { Documents: "DOCUMENTS", External: "EXTERNAL" },
  Encoding: { UTF8: "utf8" },
}));
// Avoid a real GitHub fetch during boot's update check (return "no update").
vi.mock("../../src/domain/updater", () => ({
  checkForUpdate: async () => ({ available: false, url: "", version: "", notes: "" }),
}));

vi.mock("../../src/native/adapters", () => ({
  nativePoncleGateway: () => ({
    check: async () => true,
    listPending: async () => {
      ctl.pendingCalls++;
      if (ctl.pendingGate) await ctl.pendingGate.promise;
      return { ok: true, total: ctl.gwPending.length, list: ctl.gwPending };
    },
    listOpen: async () => {
      ctl.openCalls++;
      return { ok: true, total: ctl.gwRows.length, list: ctl.gwRows };
    },
  }),
  poncleLogin: async () => true,
  poncleHasSession: async () => true,
  poncleLogout: async () => {},
  getAppVersion: async () => "1.0.0",
  getPoncleCredentialsMeta: async () => ({ hasCreds: false, id: "" }),
  savePoncleCredentials: async () => true,
  clearPoncleCredentials: async () => {},
  requestSmsPermission: async () => true,
  openExternalUrl: async (url: string) => { ctl.openedUrls.push(url); },
  openAppSettings: async () => { ctl.openedSettings++; },
  sendSms: async (phone: string, text: string) => {
    ctl.sms.calls.push({ phone, text });
    if (ctl.sms.mode === "manual") return new Promise<void>((res, rej) => { ctl.sms.pending = { res, rej }; });
    if (ctl.sms.mode === "reject") throw new Error(ctl.sms.rejectMsg);
    return;
  },
}));

// A 기변 opened 2024-07-03, 24-month term -> expiry 2026-07-03 == fake TODAY (D-0).
const dueRow: PoncleRow = {
  openphone: "010-1111-2222", customer: "홍길동", opendate: "24-07-03",
  openhowx: "기변", telecomx: "SK텔레콤", agencytitle: "CD대리점", model: "Galaxy S",
};

const BODY_HTML = (() => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : html;
})();

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 12): Promise<void> { for (let i = 0; i < n; i++) await flush(); }
const $ = <T extends Element = Element>(s: string) => document.querySelector(s) as T;
function sentLog(): Array<Record<string, unknown>> {
  const raw = ctl.prefs.get("sent_log");
  return raw ? JSON.parse(raw) : [];
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function bootApp(): Promise<void> {
  await import("../../src/main");
  await settle();
}
/** Run a manual scan from the home button and let it settle. */
async function scan(): Promise<void> {
  ($("#btn-scan") as HTMLButtonElement).click();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-03T09:00:00"));
  ctl.prefs.clear();
  ctl.gwRows = []; ctl.gwPending = [];
  ctl.pendingCalls = 0; ctl.openCalls = 0; ctl.pendingGate = null;
  ctl.sms.calls.length = 0; ctl.sms.mode = "resolve"; ctl.sms.pending = null;
  ctl.confirmReturn = true; ctl.confirmCalls.length = 0;
  ctl.openedSettings = 0; ctl.openedUrls.length = 0;
  // Skip onboarding; turn 실제 발송 ON so the send path exercises sendSms.
  ctl.prefs.set("onboarded_v1", "1");
  ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true }));
  document.body.innerHTML = BODY_HTML;
  window.confirm = ((msg?: string) => { ctl.confirmCalls.push(String(msg ?? "")); return ctl.confirmReturn; }) as typeof window.confirm;
  vi.resetModules();
});
afterEach(() => { vi.useRealTimers(); });

describe("E2E: send flow (#1 send-first-then-record)", () => {
  it("does NOT record a send until sendSms resolves, then records it", async () => {
    ctl.gwRows = [dueRow];
    ctl.sms.mode = "manual"; // hold the send in-flight
    await bootApp();
    await scan();

    const sendBtn = $("#due-list .btn-send") as HTMLButtonElement;
    expect(sendBtn, "a due customer card with a send button should render").toBeTruthy();
    sendBtn.click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "안내 문자입니다";
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();

    // Send is in flight (awaited) — history must still be EMPTY. This is the fix:
    // a mid-send app kill here can never leave a phantom "sent" record.
    expect(ctl.sms.calls.length).toBe(1);
    expect(sentLog().length).toBe(0);

    ctl.sms.pending!.res(); // carrier confirms
    await settle();
    const log = sentLog();
    expect(log.length).toBe(1);
    expect(log[0]).toMatchObject({ phone: "010-1111-2222", channel: "sms" });
  });

  it("records NOTHING when the send fails (customer stays unsent)", async () => {
    ctl.gwRows = [dueRow];
    ctl.sms.mode = "reject";
    ctl.sms.rejectMsg = "문자 전송 실패";
    await bootApp();
    await scan();

    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "안내";
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();

    expect(ctl.sms.calls.length).toBe(1);
    expect(sentLog().length).toBe(0); // no phantom record
    // Card is still actionable (unsent): a fresh send button is present.
    expect($("#due-list .btn-send")).toBeTruthy();
  });

  it("offers the settings jump when a send fails on a permission denial (#5)", async () => {
    ctl.gwRows = [dueRow];
    ctl.sms.mode = "reject";
    ctl.sms.rejectMsg = "SMS 권한이 거부되었습니다";
    ctl.confirmReturn = true; // user accepts the "설정 열기" prompt
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "안내";
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();

    expect(ctl.confirmCalls.some((m) => m.includes("설정"))).toBe(true);
    expect(ctl.openedSettings).toBe(1);
  });
});

describe("E2E: scan re-entry guard (#3)", () => {
  it("a second scan while one is in flight is a no-op (no parallel scan)", async () => {
    ctl.gwRows = [dueRow];
    ctl.pendingGate = deferred(); // hold the first scan inside listPending
    await bootApp();

    ($("#btn-scan") as HTMLButtonElement).click(); // scan #1 -> hangs in listPending
    await settle();
    expect(ctl.pendingCalls).toBe(1);

    ($("#btn-scan") as HTMLButtonElement).click(); // scan #2 while #1 in flight
    await settle();
    expect(ctl.pendingCalls, "re-entry guard should block the second scan").toBe(1);

    ctl.pendingGate.resolve(); // let scan #1 finish
    await settle();
    // A later scan (nothing in flight) proceeds normally.
    await scan();
    expect(ctl.pendingCalls).toBe(2);
  });
});

describe("E2E: restore confirmation (#2)", () => {
  async function restoreWith(json: string): Promise<void> {
    const input = $("#restore-file") as HTMLInputElement;
    const file = new File([json], "backup.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    await settle();
  }

  it("prompts before a restore that shrinks history, and aborts on cancel", async () => {
    // Seed two existing sent records.
    ctl.prefs.set("sent_log", JSON.stringify([
      { phone: "010-1", expiry_date: "2026-01-01", channel: "sms", sent_at: "2026-06-01T09:00:00", customer: "A", opendate: "", milestone_offset: 0, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" },
      { phone: "010-2", expiry_date: "2026-02-01", channel: "sms", sent_at: "2026-06-02T09:00:00", customer: "B", opendate: "", milestone_offset: 0, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" },
    ]));
    ctl.confirmReturn = false; // user cancels the destructive restore
    await bootApp();

    await restoreWith(JSON.stringify({ app: "poncle-expiry", history: [] })); // empty backup

    expect(ctl.confirmCalls.length, "a confirm should have been shown").toBe(1);
    expect(sentLog().length, "history must be untouched after cancel").toBe(2);
  });

  it("proceeds with the overwrite when the user confirms", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([
      { phone: "010-1", expiry_date: "2026-01-01", channel: "sms", sent_at: "2026-06-01T09:00:00", customer: "A", opendate: "", milestone_offset: 0, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" },
    ]));
    ctl.confirmReturn = true;
    await bootApp();
    await restoreWith(JSON.stringify({ app: "poncle-expiry", history: [] }));
    expect(sentLog().length).toBe(0); // replaced after explicit confirm
  });
});

describe("E2E: history render escapes an untrusted channel (#8)", () => {
  it("renders a hostile channel value escaped, not as live HTML", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([
      {
        phone: "010-9", expiry_date: "2026-01-01", channel: "<img src=x onerror=alert(1)>",
        sent_at: "2026-06-01T09:00:00", customer: "피해자", opendate: "24-01-01",
        milestone_offset: 0, telecom: "KT", agency: "강남", plan: "5G", model: "G", openhow: "기변", staff: "", body: "x",
      },
    ]));
    await bootApp();
    // Go to 이력 (history) screen, 발송 tab.
    ($("#nav-history") as HTMLButtonElement).click();
    await settle();

    const list = $("#h-list");
    expect(list.querySelector("img"), "no live <img> node from the channel field").toBeNull();
    expect(list.innerHTML).toContain("&lt;img"); // rendered as escaped text
  });
});
