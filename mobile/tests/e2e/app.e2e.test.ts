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
  openedSettings: 0,
  openedUrls: [] as string[],
  smsSeq: 0,
  smsResults: [] as Array<{ id: string; status: "ok" | "fail"; reason?: string; at: string }>,
  acked: [] as string[],
  checkOk: true as boolean,
  hasSession: true,
  pendingFail: false,
  share: { mode: "resolve" as "resolve" | "cancel" | "unavailable", calls: 0, last: null as null | Record<string, unknown> },
  clipboard: [] as string[],
  nativeDialogs: [] as string[],
  failSetKeys: new Set<string>(),
  /** Preferences.get throws for these keys (storage read failure). */
  failGetKeys: new Set<string>(),
  pendingNetErr: false,
  files: [] as Array<{ path: string; data: string }>,
  checkGate: null as null | { promise: Promise<void>; resolve: () => void },
  update: {
    result: { available: false, url: "", version: "", notes: "" } as { available: boolean; url: string; version: string; notes: string; error?: string; reason?: string },
    gate: null as null | { promise: Promise<void>; resolve: () => void },
    calls: 0,
    args: [] as unknown[],
  },
  /** Native Build.VERSION.SDK_INT as AppUpdate.getVersion reports it (B15/D4). */
  sdkInt: undefined as number | undefined,
  openUrlFail: false,
  smsPerm: true,
  loginOk: true,
  loginCalls: 0,
  openTotal: null as null | number,
  openFail: false,
  openGate: null as null | { promise: Promise<void>; resolve: () => void },
  /** Poncle's HTTP Date as the native layer reports it (#58); null = none seen. */
  serverDate: null as null | string,
  /** Server-minus-device ms captured when a mocked Poncle call answered (like adapters). */
  skewMs: null as null | number,
  /** Cache files the app deleted (L6), and what readdir lists. */
  deleted: [] as string[],
  cacheDir: [] as string[],
  /** check() throws (offline / transient) like the real adapter. */
  checkThrows: false,
  /** Native logout (clears the Gecko cookies; can take seconds). */
  logoutCalls: 0,
  logoutGate: null as null | { promise: Promise<void>; resolve: () => void },
  /** Preferences.get for this key waits on the gate (slow storage read). */
  getGate: null as null | { key: string; gate: { promise: Promise<void>; resolve: () => void }; hit?: boolean },
  /** listPending throws (a transport error the client does not classify). */
  pendingThrows: false,
  smsPermCalls: 0,
  /** Preferences.set for this key waits on the gate (slow storage write). */
  setGate: null as null | { key: string; gate: { promise: Promise<void>; resolve: () => void } },
}));

/** Mirror adapters.noteServerDate: remember the skew at response time. */
function noteSkew(): void {
  if (ctl.serverDate) ctl.skewMs = Date.parse(ctl.serverDate) - Date.now();
}

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      if (ctl.getGate && ctl.getGate.key === key) { ctl.getGate.hit = true; await ctl.getGate.gate.promise; }
      if (ctl.failGetKeys.has(key)) throw new Error(`storage read failed: ${key}`);
      return { value: ctl.prefs.get(key) ?? null };
    },
    set: async ({ key, value }: { key: string; value: string }) => {
      if (ctl.setGate && ctl.setGate.key === key) await ctl.setGate.gate.promise;
      if (ctl.failSetKeys.has(key)) throw new Error(`storage write failed: ${key}`);
      ctl.prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => { ctl.prefs.delete(key); },
  },
}));
vi.mock("@capacitor/share", () => ({
  Share: {
    share: async (opts: Record<string, unknown>) => {
      ctl.share.calls++;
      ctl.share.last = opts;
      if (ctl.share.mode === "cancel") throw new Error("Share canceled");
      if (ctl.share.mode === "unavailable") throw Object.assign(new Error("Share API not available in this browser"), { code: "UNAVAILABLE" });
      return {};
    },
  },
}));
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: {
    writeFile: async ({ path, data }: { path: string; data: string }) => { ctl.files.push({ path, data }); return { uri: "x" }; },
    readFile: async () => ({ data: "" }),
    readdir: async () => ({ files: ctl.cacheDir.map((name) => ({ name })) }),
    deleteFile: async ({ path }: { path: string }) => { ctl.deleted.push(path); },
  },
  Directory: { Documents: "DOCUMENTS", External: "EXTERNAL", Cache: "CACHE" },
  Encoding: { UTF8: "utf8" },
}));
// Avoid a real GitHub fetch during boot's update check (default: "no update").
vi.mock("../../src/domain/updater", () => ({
  checkForUpdate: async (...args: unknown[]) => {
    ctl.update.calls++;
    ctl.update.args = args;
    if (ctl.update.gate) await ctl.update.gate.promise;
    return { ...ctl.update.result };
  },
}));

vi.mock("../../src/native/appupdate", () => ({
  AppUpdate: {
    getVersion: async () => ({ version: "1.0.0", sdkInt: ctl.sdkInt }),
    openUrl: async () => {},
  },
  getDeviceSdkInt: async () => ctl.sdkInt,
}));

/** The tracked SMS send (native contract: resolves { id } at hand-off). */
async function fakeSend(phone: string, text: string): Promise<string> {
  ctl.sms.calls.push({ phone, text });
  const id = `sms-${++ctl.smsSeq}`;
  if (ctl.sms.mode === "manual") {
    return new Promise<string>((res, rej) => { ctl.sms.pending = { res: () => res(id), rej }; });
  }
  if (ctl.sms.mode === "reject") throw new Error(ctl.sms.rejectMsg);
  return id;
}
vi.mock("../../src/native/sms", () => ({
  INVALID_NUMBER_TEXT: "휴대폰 번호 형식이 올바르지 않습니다",
  INVALID_NUMBER_MESSAGE: "휴대폰 번호 형식이 올바르지 않습니다 (010으로 시작하는 10~11자리)",
  sendSmsTracked: (phone: string, text: string) => fakeSend(phone, text),
  fetchSendResults: async () => ctl.smsResults.filter((r) => !ctl.acked.includes(r.id)),
  ackSendResults: async (ids: string[]) => { ctl.acked.push(...ids); },
}));

vi.mock("../../src/native/adapters", () => ({
  nativePoncleGateway: () => ({
    check: async () => { if (ctl.checkGate) await ctl.checkGate.promise; if (ctl.checkThrows) throw new Error("폰클 서버에 연결할 수 없습니다"); noteSkew(); return ctl.checkOk; },
    listPending: async () => {
      ctl.pendingCalls++;
      noteSkew();
      if (ctl.pendingGate) await ctl.pendingGate.promise;
      if (ctl.pendingThrows) throw new Error("listPending bridge error");
      if (ctl.pendingFail) return { ok: false, netError: false, total: 0, list: [] };
      if (ctl.pendingNetErr) return { ok: false, netError: true, total: 0, list: [] };
      return { ok: true, total: ctl.gwPending.length, list: ctl.gwPending };
    },
    listOpen: async () => {
      ctl.openCalls++;
      noteSkew();
      const rows = ctl.gwRows; // the rows as of the request (a later change = a later request)
      const gate = ctl.openGate;
      ctl.openGate = null;
      if (gate) await gate.promise;
      if (ctl.openFail) return { ok: false, netError: false, total: 0, list: [] };
      return { ok: true, total: ctl.openTotal ?? rows.length, list: rows };
    },
  }),
  lastServerDate: () => ctl.serverDate,
  lastClockSkewMs: () => ctl.skewMs,
  poncleLogin: async () => { ctl.loginCalls++; return ctl.loginOk; },
  poncleHasSession: async () => ctl.hasSession,
  poncleLogout: async () => { ctl.logoutCalls++; if (ctl.logoutGate) await ctl.logoutGate.promise; },
  getAppVersion: async () => "1.0.0",
  getPoncleCredentialsMeta: async () => ({ hasCreds: false, id: "" }),
  savePoncleCredentials: async () => true,
  clearPoncleCredentials: async () => {},
  requestSmsPermission: async () => { ctl.smsPermCalls++; return ctl.smsPerm; },
  openExternalUrl: async (url: string) => {
    if (ctl.openUrlFail) throw new Error("No Activity found to handle Intent");
    ctl.openedUrls.push(url);
  },
  openAppSettings: async () => { ctl.openedSettings++; },
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
  ctl.openedSettings = 0; ctl.openedUrls.length = 0;
  ctl.smsSeq = 0; ctl.smsResults = []; ctl.acked = [];
  ctl.checkOk = true; ctl.hasSession = true; ctl.pendingFail = false;
  ctl.share.mode = "resolve"; ctl.share.calls = 0; ctl.clipboard = [];
  ctl.nativeDialogs = []; ctl.failSetKeys = new Set(); ctl.failGetKeys = new Set(); ctl.pendingNetErr = false; ctl.files = []; ctl.checkGate = null;
  ctl.update.result = { available: false, url: "", version: "", notes: "" }; ctl.update.gate = null; ctl.update.calls = 0; ctl.update.args = [];
  ctl.sdkInt = undefined;
  ctl.openUrlFail = false; ctl.smsPerm = true; ctl.loginOk = true; ctl.loginCalls = 0;
  ctl.openTotal = null; ctl.openFail = false; ctl.openGate = null; ctl.share.last = null;
  ctl.serverDate = null; ctl.skewMs = null; ctl.checkThrows = false; ctl.deleted = []; ctl.cacheDir = [];
  ctl.logoutCalls = 0; ctl.logoutGate = null;
  ctl.getGate = null; ctl.pendingThrows = false; ctl.smsPermCalls = 0; ctl.setGate = null;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (t: string) => { ctl.clipboard.push(t); } },
  });
  // Skip onboarding; turn 실제 발송 ON so the send path exercises sendSms.
  ctl.prefs.set("onboarded_v1", "1");
  ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true }));
  document.body.innerHTML = BODY_HTML;
  // #64: the app must never fall back to a native system dialog — any call is a bug.
  window.confirm = ((msg?: string) => { ctl.nativeDialogs.push(`confirm:${msg}`); return true; }) as typeof window.confirm;
  window.alert = ((msg?: string) => { ctl.nativeDialogs.push(`alert:${msg}`); }) as typeof window.alert;
  window.prompt = ((msg?: string) => { ctl.nativeDialogs.push(`prompt:${msg}`); return null; }) as typeof window.prompt;
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  expect(ctl.nativeDialogs, "no native window.confirm/alert/prompt (#64)").toEqual([]);
});

/* In-app dialog (#64) helpers: the custom .modal-overlay replaces window.confirm. */
function dialogOpen(): boolean {
  const d = document.querySelector("#app-dialog");
  return !!d && !d.classList.contains("hidden");
}
function dialogText(): string {
  return document.querySelector("#app-dialog-msg")?.textContent ?? "";
}
async function answerDialog(ok: boolean): Promise<void> {
  expect(dialogOpen(), "an in-app dialog should be open").toBe(true);
  (document.querySelector(ok ? "#app-dialog-ok" : "#app-dialog-cancel") as HTMLButtonElement).click();
  await settle();
}

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
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "안내";
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();

    // In-app dialog (not window.confirm) with Korean buttons; accept "설정 열기".
    expect(dialogText()).toContain("설정");
    expect($("#app-dialog-ok").textContent).toBe("설정 열기");
    expect($("#app-dialog-cancel").textContent).toBe("취소");
    await answerDialog(true);
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
    await bootApp();

    await restoreWith(JSON.stringify({ app: "poncle-expiry", history: [] })); // empty backup
    expect(dialogText()).toContain("2명");
    await answerDialog(false); // user cancels

    expect(sentLog().length, "history must be untouched after cancel").toBe(2);
  });

  it("confirming MERGES by key — current records the backup lacks are kept (1-22)", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([
      { phone: "010-1", expiry_date: "2026-01-01", channel: "sms", sent_at: "2026-06-01T09:00:00", customer: "A", opendate: "", milestone_offset: 0, telecom: "", agency: "", plan: "", model: "", openhow: "", staff: "" },
    ]));
    await bootApp();
    await restoreWith(JSON.stringify({ app: "poncle-expiry", history: [
      { phone: "010-9", expiry_date: "2026-03-01", channel: "sms", sent_at: "2026-06-03T09:00:00", customer: "Z" },
    ] }));
    expect(dialogText()).toContain("1명");
    await answerDialog(true);
    expect(sentLog().map((r) => r.phone).sort()).toEqual(["010-1", "010-9"]);
  });

  it("a same-size backup of DIFFERENT customers is not silently swapped (key diff, not counts)", async () => {
    const r = (phone: string) => ({ phone, expiry_date: "2026-01-01", channel: "sms", sent_at: "2026-06-01T09:00:00", customer: phone });
    ctl.prefs.set("sent_log", JSON.stringify([r("010-1"), r("010-2")]));
    await bootApp();
    await restoreWith(JSON.stringify({ app: "poncle-expiry", history: [r("010-8"), r("010-9")] }));
    expect(dialogOpen(), "different customers -> confirm even though counts match").toBe(true);
    await answerDialog(false);
    expect(sentLog().map((x) => x.phone)).toEqual(["010-1", "010-2"]);
  });

  it("a superset backup still asks first (B16), without a 'missing' warning", async () => {
    const r = (phone: string) => ({ phone, expiry_date: "2026-01-01", channel: "sms", sent_at: "2026-06-01T09:00:00", customer: phone });
    ctl.prefs.set("sent_log", JSON.stringify([r("010-1")]));
    await bootApp();
    await restoreWith(JSON.stringify({ app: "poncle-expiry", history: [r("010-1"), r("010-2")] }));
    expect(dialogOpen()).toBe(true);
    expect(dialogText()).not.toContain("백업 파일에 없습니다");
    expect($("#app-dialog-ok").textContent).toBe("복원");
    await answerDialog(true);
    expect(sentLog()).toHaveLength(2);
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

/* ---------------- P0 stage 1 ---------------- */
const recBase = { customer: "홍길동", opendate: "24-07-03", milestone_offset: 0, telecom: "SK텔레콤", agency: "", plan: "", model: "", openhow: "기변", staff: "" };

async function sendFromHome(text = "안내"): Promise<void> {
  ($("#due-list .btn-send") as HTMLButtonElement).click();
  await settle();
  ($("#confirm-text") as HTMLTextAreaElement).value = text;
  ($("#confirm-send") as HTMLButtonElement).click();
  await settle();
}
function foreground(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("E2E P0 #2: async send failure is reconciled (not left as 'sent')", () => {
  it("stores the native id, then a 'fail' result un-sends the customer and is acked", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    await sendFromHome();
    expect(sentLog()[0]).toMatchObject({ channel: "sms", sms_id: "sms-1" });
    expect($("#due-list .btn-send.resend"), "sent -> 재발송").toBeTruthy();

    ctl.smsResults = [{ id: "sms-1", status: "fail", reason: "유심이 없습니다", at: "2026-07-03T09:00:05" }];
    foreground();
    await settle(20);

    expect(sentLog()[0]).toMatchObject({ delivery: "failed", fail_reason: "유심이 없습니다" });
    expect(ctl.acked).toContain("sms-1");
    expect($("#toast").textContent).toContain("홍길동 문자 발송 실패가 확인되었습니다 — 유심이 없습니다");
    const btn = $("#due-list .btn-send") as HTMLButtonElement;
    expect(btn.classList.contains("resend")).toBe(false);
    expect(btn.textContent).toBe("다시 보내기");
    expect($("#due-list .sent-badge.fail")?.textContent).toContain("발송 실패");
    expect($("#c-sent").textContent).toBe("0");
  });

  it("an 'ok' result marks the record delivered and keeps it sent", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    await sendFromHome();
    ctl.smsResults = [{ id: "sms-1", status: "ok", at: "2026-07-03T09:00:05" }];
    foreground();
    await settle(20);
    expect(sentLog()[0]).toMatchObject({ channel: "sms", delivery: "delivered" });
    expect(ctl.acked).toContain("sms-1");
    expect($("#c-sent").textContent).toBe("1");
  });

  it("a failed 재발송 keeps the earlier delivered send (customer stays handled)", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([
      { ...recBase, phone: "010-1111-2222", expiry_date: "2026-07-03", channel: "sms", sent_at: "2026-07-01T09:00:00", body: "원문", sms_id: "old-1", delivery: "delivered" },
    ]));
    await bootApp();
    await scan();
    ($("#due-list .btn-send.resend") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "재안내";
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();
    expect(sentLog()[0]).toMatchObject({ sms_id: "sms-1", body: "재안내", prev_sent: { sms_id: "old-1", delivery: "delivered" } });

    ctl.smsResults = [{ id: "sms-1", status: "fail", reason: "비행기 모드", at: "2026-07-03T09:00:05" }];
    foreground();
    await settle(20);

    const log = sentLog();
    expect(log.length).toBe(1);
    expect(log[0]).toMatchObject({ sms_id: "old-1", body: "원문", delivery: "delivered", sent_at: "2026-07-01T09:00:00" });
    expect(ctl.acked).toContain("sms-1");
    expect($("#toast").textContent).toContain("재발송 실패");
    expect($("#due-list .btn-send.resend"), "still handled -> 재발송").toBeTruthy();
    expect($("#c-sent").textContent).toBe("1");
  });

  it("a preflight rejection (no SIM) records nothing", async () => {
    ctl.gwRows = [dueRow];
    ctl.sms.mode = "reject";
    ctl.sms.rejectMsg = "유심이 없어 문자를 보낼 수 없습니다";
    await bootApp();
    await scan();
    await sendFromHome();
    expect(sentLog().length).toBe(0);
    expect($("#toast").textContent).toContain("유심이 없어");
  });
});

describe("E2E P0 #3: record-only (practice) is not 'sent'", () => {
  it("shows '기록만 됨(미발송)' + '실제 발송' in delivery mode, and a real send upserts to sms", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([
      { ...recBase, phone: "010-1111-2222", expiry_date: "2026-07-03", channel: "record-only", sent_at: "2026-07-01T09:00:00" },
    ]));
    await bootApp();
    await scan();
    expect($("#due-list .sent-badge.rec")?.textContent).toBe("기록만 됨(미발송)");
    expect(($("#due-list .btn-send") as HTMLButtonElement).textContent).toBe("실제 발송");
    expect($("#c-sent").textContent).toBe("0");

    await sendFromHome("진짜 안내");
    expect(ctl.sms.calls.length).toBe(1);
    const log = sentLog();
    expect(log.length).toBe(1);
    expect(log[0]).toMatchObject({ channel: "sms", body: "진짜 안내" });
    expect($("#c-sent").textContent).toBe("1");
  });

  it("practice mode never downgrades a real send to a record; badge follows the RECORD", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: false }));
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([
      { ...recBase, phone: "010-1111-2222", expiry_date: "2026-07-03", channel: "sms", sent_at: "2026-07-01T09:00:00", body: "원문" },
    ]));
    await bootApp();
    await scan();
    expect($("#due-list .sent-badge")?.textContent).toBe("✓ 발송됨");
    ($("#due-list .btn-send.resend") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "x";
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();
    expect(sentLog()[0]).toMatchObject({ channel: "sms", body: "원문" });
  });
});

describe("E2E P0 #5: stale scan cache + session probe", () => {
  it("a failed (session-expired) scan does not update '마지막 스캔'", async () => {
    ctl.prefs.set("last_scan_at", "7/7 20:22");
    await bootApp();
    expect($("#last-scan").textContent).toBe("7/7 20:22");
    ctl.pendingFail = true;
    await scan();
    expect($("#status-label").textContent).toBe("세션만료");
    expect($("#last-scan").textContent).toBe("7/7 20:22");
    expect(ctl.prefs.get("last_scan_at")).toBe("7/7 20:22");
  });

  it("restores a July cache in November with today's D-day, drops expired rows, and says it's old", async () => {
    vi.setSystemTime(new Date("2026-11-16T09:00:00"));
    const item = (phone: string, expiry: string, offset: number) => ({
      id: `${phone}|${expiry}`, phone, customer: "고객", opendate: "24-07-07", expiry_date: expiry,
      milestone_offset: offset, telecom: "KT", agency: "", openhow: "기변", plan: "", model: "", staff: "",
      already_sent: false, source: "term",
    });
    ctl.prefs.set("due_cache", JSON.stringify([item("010-1", "2026-07-07", 0), item("010-2", "2026-11-19", 135)]));
    ctl.prefs.set("due_cache_date", "2026-07-07");
    await bootApp();
    const ddays = Array.from(document.querySelectorAll("#due-list .lc-dday")).map((e) => e.textContent);
    expect(ddays).toEqual(["D-3"]); // 07-07 row dropped (expired), 11-19 is D-3 today
    expect($("#stale-banner").classList.contains("hidden")).toBe(false);
    expect($("#stale-title").textContent).toBe("7월 7일 스캔 결과입니다 — 지금 다시 스캔하세요");
  });

  it("sending from an old list needs an explicit confirm naming the scan day", async () => {
    vi.setSystemTime(new Date("2026-11-16T09:00:00"));
    ctl.prefs.set("due_cache", JSON.stringify([{
      id: "010-2|2026-11-19", phone: "010-2", customer: "고객", opendate: "24-11-19", expiry_date: "2026-11-19",
      milestone_offset: 135, telecom: "KT", agency: "", openhow: "기변", plan: "", model: "", staff: "",
      already_sent: false, source: "term",
    }]));
    ctl.prefs.set("due_cache_date", "2026-07-07");
    await bootApp();

    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect(dialogText()).toContain("7월 7일 스캔 결과입니다");
    expect(dialogText()).toContain("그래도 보낼까요?");
    await answerDialog(false); // user backs out
    expect($("#confirm-modal").classList.contains("hidden"), "no send modal after cancel").toBe(true);

    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    await answerDialog(true); // user insists
    expect($("#confirm-modal").classList.contains("hidden")).toBe(false);
  });

  it("Android back closes the in-app dialog (= 취소), then the send sheet, then is not consumed", async () => {
    vi.setSystemTime(new Date("2026-11-16T09:00:00"));
    ctl.prefs.set("due_cache", JSON.stringify([{
      id: "010-2|2026-11-19", phone: "010-2", customer: "고객", opendate: "24-11-19", expiry_date: "2026-11-19",
      milestone_offset: 135, telecom: "KT", agency: "", openhow: "기변", plan: "", model: "", staff: "",
      already_sent: false, source: "term",
    }]));
    ctl.prefs.set("due_cache_date", "2026-07-07");
    await bootApp();
    const back = (window as unknown as { __poncleHandleBack?: () => boolean }).__poncleHandleBack;
    expect(typeof back).toBe("function");

    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect(dialogOpen()).toBe(true);
    expect(back!()).toBe(true); // dialog dismissed like 취소
    await settle();
    expect(dialogOpen()).toBe(false);
    expect($("#confirm-modal").classList.contains("hidden"), "back = cancel: no send sheet").toBe(true);

    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    await answerDialog(true);
    expect($("#confirm-modal").classList.contains("hidden")).toBe(false);
    expect(back!()).toBe(true); // closes the send sheet
    expect($("#confirm-modal").classList.contains("hidden")).toBe(true);
    expect(back!()).toBe(false); // nothing open: native default (leave the app)
  });

  it("a fresh scan today sends without the stale confirm", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect(dialogOpen()).toBe(false);
    expect($("#confirm-modal").classList.contains("hidden")).toBe(false);
  });

  it("a successful scan today clears the stale notice", async () => {
    ctl.prefs.set("due_cache", JSON.stringify([]));
    ctl.prefs.set("due_cache_date", "2026-06-01");
    await bootApp();
    expect($("#stale-banner").classList.contains("hidden")).toBe(false);
    ctl.gwRows = [dueRow];
    await scan();
    expect($("#stale-banner").classList.contains("hidden")).toBe(true);
    expect(ctl.prefs.get("due_cache_date")).toBe("2026-07-03");
  });

  it("boot shows the session banner when the cookie exists but the server says logged out", async () => {
    ctl.checkOk = false; // authoritative probe: not logged in
    await bootApp();
    await settle();
    expect($("#session-banner").classList.contains("hidden")).toBe(false);
    ($("#nav-settings") as HTMLButtonElement).click();
    await settle();
    expect($("#session-state").textContent).toContain("세션 만료");
  });

  it("boot keeps the banner hidden and settings say 로그인됨 when the probe succeeds", async () => {
    await bootApp();
    await settle();
    expect($("#session-banner").classList.contains("hidden")).toBe(true);
    ($("#nav-settings") as HTMLButtonElement).click();
    await settle();
    expect($("#session-state").textContent).toBe("로그인됨");
  });
});

describe("E2E P0 #6: test target uses MY number only", () => {
  it("refuses without a saved test number (no hard-coded fallback)", async () => {
    await bootApp();
    ($("#btn-test-target") as HTMLButtonElement).click();
    await settle();
    expect($("#toast").textContent).toBe("설정 > 문자 발송 테스트에 내 번호를 먼저 입력하세요");
    expect(document.querySelectorAll("#due-list .listcard").length).toBe(0);
  });

  it("uses the persisted 설정 test number and never records or caches the test row", async () => {
    await bootApp();
    ($("#nav-settings") as HTMLButtonElement).click();
    await settle();
    const input = $("#s-test-phone") as HTMLInputElement;
    input.value = "010-5555-0000";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(JSON.parse(ctl.prefs.get("app_config")!).test_phone).toBe("010-5555-0000");

    ($("#btn-test-target") as HTMLButtonElement).click();
    await settle();
    expect($("#due-list .lc-phone")?.textContent).toBe("010-5555-0000");
    await sendFromHome("테스트");
    expect(ctl.sms.calls[0].phone).toBe("010-5555-0000");
    expect(sentLog().length).toBe(0);
    expect(JSON.parse(ctl.prefs.get("due_cache") ?? "[]")).toEqual([]);
  });
});

describe("E2E P0 #7: cancelling a share leaks nothing", () => {
  const seedLog = () => ctl.prefs.set("sent_log", JSON.stringify([
    { ...recBase, phone: "010-1111-2222", expiry_date: "2026-07-03", channel: "sms", sent_at: "2026-07-01T09:00:00", body: "개인정보" },
  ]));

  it("backup share cancel: no second share, no clipboard, backup not marked done", async () => {
    ctl.share.mode = "cancel";
    seedLog();
    await bootApp();
    ($("#btn-export-backup") as HTMLButtonElement).click();
    await settle();
    expect(ctl.share.calls).toBe(1);
    expect(ctl.clipboard).toEqual([]);
    // B4: an ambiguous 'cancel' asks (Quick Share etc. end as cancelled) — '아니요'
    // keeps the backup unrecorded.
    expect(dialogText()).toContain("취소");
    await answerDialog(false);
    expect(ctl.share.calls).toBe(1);
    expect(ctl.clipboard).toEqual([]);
    expect(ctl.prefs.has("last_backup_at")).toBe(false);
    expect($("#toast").textContent).toContain("기록되지 않았습니다");
  });

  it("backup share 'cancel' that the user confirms as saved records the backup date (B4)", async () => {
    ctl.share.mode = "cancel";
    seedLog();
    await bootApp();
    ($("#btn-export-backup") as HTMLButtonElement).click();
    await settle();
    await answerDialog(true);
    expect(ctl.share.calls).toBe(1);
    expect(ctl.prefs.has("last_backup_at")).toBe(true);
  });

  it("CSV share cancel / unavailable: nothing on the clipboard", async () => {
    seedLog();
    ctl.share.mode = "cancel";
    await bootApp();
    ($("#btn-export-csv") as HTMLButtonElement).click();
    await settle();
    ctl.share.mode = "unavailable";
    ($("#btn-export-csv") as HTMLButtonElement).click();
    await settle();
    expect(ctl.share.calls).toBe(2);
    expect(ctl.clipboard).toEqual([]);
  });

  it("a completed backup share records the backup time", async () => {
    await bootApp();
    ($("#btn-export-backup") as HTMLButtonElement).click();
    await settle();
    expect(ctl.prefs.has("last_backup_at")).toBe(true);
  });
});

/* ---------------- P1 stage 2 ---------------- */
const smsRec = (over: Record<string, unknown> = {}) => ({
  ...recBase, phone: "010-1111-2222", expiry_date: "2026-07-03", channel: "sms", sent_at: "2026-07-01T09:00:00", body: "원문", ...over,
});
async function restoreFile(json: string): Promise<void> {
  const input = $("#restore-file") as HTMLInputElement;
  const file = new File([json], "backup.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(20);
  // B16: every restore asks first with a summary — accept it like the user would.
  if (dialogOpen()) { await answerDialog(true); await settle(20); }
}
async function nav(name: string): Promise<void> {
  ($(`#nav-${name}`) as HTMLButtonElement).click();
  await settle();
}
const dueCache = (): Array<Record<string, unknown>> => JSON.parse(ctl.prefs.get("due_cache") ?? "[]");
async function lookupFor(q: string): Promise<void> {
  await nav("lookup");
  ($("#lk-query") as HTMLInputElement).value = q;
  ($("#lk-submit") as HTMLButtonElement).click();
  await settle();
}

describe("E2E P1 #10: restore reconciles the home list + cache (1-1)", () => {
  it("a customer sent on the old phone shows as sent after restore (no duplicate send)", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    expect($("#c-sent").textContent).toBe("0");
    await nav("settings");
    await restoreFile(JSON.stringify({ app: "poncle-expiry", history: [smsRec()] }));
    expect(dueCache()[0], "cache reconciled right after restore").toMatchObject({ already_sent: true });
    await nav("home");
    expect($("#c-sent").textContent).toBe("1");
    expect($("#due-list .btn-send.resend"), "sent -> 재발송, not 알림 보내기").toBeTruthy();
  });
});

describe("E2E P1 #28/#29/L5: restored settings stick, templates migrate, test_phone stays local", () => {
  it("leaving 설정 after a restore keeps the restored config (no stale DOM overwrite)", async () => {
    await bootApp(); // current: deliver_alerts true
    await nav("settings");
    expect($("#s-deliver").classList.contains("on")).toBe(true);
    await restoreFile(JSON.stringify({ app: "poncle-expiry", history: [], config: { deliver_alerts: false } }));
    expect($("#s-deliver").classList.contains("on"), "settings form re-populated").toBe(false);
    await nav("home"); // showScreen auto-saves the settings form
    expect(JSON.parse(ctl.prefs.get("app_config")!).deliver_alerts).toBe(false);
  });

  it("an old (v1) backup does not resurrect the retired default templates", async () => {
    await bootApp();
    await nav("settings");
    await restoreFile(JSON.stringify({ app: "poncle-expiry", history: [], config: { templates: [
      { id: "default-newmnp", name: "old", telecoms: [], statuses: [], body: "1년전 … 약정이 종료되어" },
    ] } }));
    const ids = (JSON.parse(ctl.prefs.get("app_config")!).templates as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain("default-newmnp");
    expect(ids).toEqual(expect.arrayContaining(["default-keepdate", "default-term"]));
  });

  it("test_phone is never exported and a backup's test_phone is never applied", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, test_phone: "010-5555-0000" }));
    await bootApp();
    ($("#btn-export-backup") as HTMLButtonElement).click();
    await settle();
    expect(ctl.files.length).toBe(1);
    expect(JSON.parse(ctl.files[0].data).config).not.toHaveProperty("test_phone");

    await nav("settings");
    await restoreFile(JSON.stringify({ app: "poncle-expiry", history: [], config: { deliver_alerts: true, test_phone: "010-9999-9999" } }));
    expect(JSON.parse(ctl.prefs.get("app_config")!).test_phone).toBe("010-5555-0000");
    expect(($("#s-test-phone") as HTMLInputElement).value).toBe("010-5555-0000");
  });
});

describe("E2E P1 #8/#11: send state changed elsewhere shows on home", () => {
  it("sending from 조회 updates the matching home row and the due cache (1-7)", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    expect($("#due-list .btn-send.resend")).toBeNull();

    await lookupFor("홍길동");
    ($("#lk-body .lk-send") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "조회에서 안내";
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();
    expect(sentLog()).toHaveLength(1);

    await nav("home");
    expect($("#c-sent").textContent).toBe("1");
    expect($("#due-list .btn-send.resend")).toBeTruthy();
    expect(dueCache()[0]).toMatchObject({ already_sent: true, sent_state: "sent" });
  });

  it("entering home re-derives send state from the log", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    await nav("history");
    ctl.prefs.set("sent_log", JSON.stringify([smsRec()])); // written by another path
    await nav("home");
    expect($("#c-sent").textContent).toBe("1");
  });

  it("returning to the foreground re-derives home send state from the log", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    expect($("#c-sent").textContent).toBe("0");
    ctl.prefs.set("sent_log", JSON.stringify([smsRec()])); // written by another path
    foreground();
    await settle(20);
    expect($("#c-sent").textContent).toBe("1");
  });
});

describe("E2E P1 #12: a send during a scan keeps its mark after RESULTS is replaced (1-8)", () => {
  it("the scan result reflects a send made while it was in flight", async () => {
    ctl.prefs.set("due_cache", JSON.stringify([{
      id: "01011112222|2026-07-03", phone: "010-1111-2222", customer: "홍길동", opendate: "24-07-03", expiry_date: "2026-07-03",
      milestone_offset: 0, telecom: "SK텔레콤", agency: "", openhow: "기변", plan: "", model: "", staff: "", already_sent: false, source: "term",
    }]));
    ctl.prefs.set("due_cache_date", "2026-07-03");
    ctl.gwRows = [dueRow];
    ctl.pendingGate = deferred();
    await bootApp();
    ($("#btn-scan") as HTMLButtonElement).click(); // scan hangs in listPending
    await settle();
    await sendFromHome("스캔 중 발송");
    expect(sentLog()).toHaveLength(1);
    ctl.pendingGate.resolve();
    await settle(20);
    expect($("#c-sent").textContent).toBe("1");
    expect(dueCache()[0]).toMatchObject({ already_sent: true });
  });
});

describe("E2E P1 #9: the confirm sheet shows this customer's earlier send", () => {
  it("'이미 YYYY-MM-DD 발송됨' + the button reads 재발송", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([smsRec()]));
    await bootApp();
    await scan();
    ($("#due-list .btn-send.resend") as HTMLButtonElement).click();
    await settle();
    expect($("#confirm-prior").classList.contains("hidden")).toBe(false);
    expect($("#confirm-prior").textContent).toContain("이미 2026-07-01 발송됨");
    expect($("#confirm-send").textContent).toBe("재발송");
  });

  it("the same contract sent under a drifted expiry (약정 개월 changed) counts as sent (1-29)", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ phone: "01011112222", expiry_date: "2026-07-01", sent_at: "2026-06-28T09:00:00" })]));
    await bootApp();
    await scan();
    expect($("#c-sent").textContent).toBe("1");
    ($("#due-list .btn-send.resend") as HTMLButtonElement).click();
    await settle();
    expect($("#confirm-prior").textContent).toContain("이미 2026-06-28 발송됨");
    expect($("#confirm-send").textContent).toBe("재발송");
  });

  it("warns about a RECENT send to the same number whose record can't be tied to this contract", async () => {
    ctl.gwRows = [dueRow];
    // No opendate on the record -> not matchable by contract; same number, 5 days ago.
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ opendate: "", expiry_date: "2026-06-20", sent_at: "2026-06-28T09:00:00" })]));
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect($("#confirm-prior").textContent).toContain("이 번호로 2026-06-28");
    expect($("#confirm-send").textContent).toBe("보내기");
  });

  it("an old send to the same number (a previous contract) is not flagged", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ opendate: "", expiry_date: "2024-07-03", sent_at: "2024-07-01T09:00:00" })]));
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect($("#confirm-prior").classList.contains("hidden")).toBe(true);
  });

  it("no note and '보내기' for a customer never contacted", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect($("#confirm-prior").classList.contains("hidden")).toBe(true);
    expect($("#confirm-send").textContent).toBe("보내기");
  });
});

describe("E2E P1 #18: storage failures after a real send are not hidden by a success toast (1-11)", () => {
  it("history save failure keeps its warning", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    ctl.failSetKeys.add("sent_log");
    await sendFromHome();
    expect(ctl.sms.calls).toHaveLength(1);
    expect($("#toast").textContent).toContain("이력 저장에 실패");
    expect($("#toast").classList.contains("err")).toBe(true);
  });

  it("a list-cache failure has its own message (the record itself is saved)", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    ctl.failSetKeys.add("due_cache");
    await sendFromHome();
    expect(sentLog()).toHaveLength(1);
    expect($("#toast").textContent).not.toContain("이력 저장에 실패");
    expect($("#toast").textContent).toContain("목록");
    expect($("#toast").classList.contains("err")).toBe(true);
  });
});

describe("E2E P1 #17: practice mode never overwrites a real (even failed) sms record", () => {
  it("a failed sms record is not replaced by a practice record", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: false }));
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ delivery: "failed", fail_reason: "유심" })]));
    await bootApp();
    await scan();
    await sendFromHome("연습");
    expect(sentLog()[0]).toMatchObject({ channel: "sms", body: "원문", delivery: "failed" });
  });
});

describe("E2E P1 #24: 조회 doesn't auto-fill the '약정 종료' text for a 여유 customer (1-35)", () => {
  it("asks first, then opens the sheet on 직접 입력 with no template text", async () => {
    // 기변 opened 2026-01-05 -> 24-month term ends 2028: '여유'.
    ctl.gwRows = [{ ...dueRow, opendate: "26-01-05" }];
    await bootApp();
    await lookupFor("홍길동");
    expect($("#lk-body .lk-status").textContent).toContain("여유");
    ($("#lk-body .lk-send") as HTMLButtonElement).click();
    await settle();
    expect(dialogText()).toContain("여유");
    await answerDialog(true);
    expect($("#confirm-modal").classList.contains("hidden")).toBe(false);
    expect(($("#confirm-template") as HTMLSelectElement).value).toBe("__manual__");
    expect(($("#confirm-text") as HTMLTextAreaElement).value).toBe("");
  });

  it("cancelling the warning opens nothing", async () => {
    ctl.gwRows = [{ ...dueRow, opendate: "26-01-05" }];
    await bootApp();
    await lookupFor("홍길동");
    ($("#lk-body .lk-send") as HTMLButtonElement).click();
    await settle();
    await answerDialog(false);
    expect($("#confirm-modal").classList.contains("hidden")).toBe(true);
  });
});

describe("E2E P1 #25: unknown 개통일 blocks a {경과개월} message (1-33)", () => {
  it("refuses to send the untouched template text, sends once the text is edited", async () => {
    ctl.prefs.set("due_cache", JSON.stringify([{
      id: "01033334444|2026-07-03", phone: "010-3333-4444", customer: "무개통일", opendate: "", expiry_date: "2026-07-03",
      milestone_offset: 0, telecom: "KT", agency: "", openhow: "유심신규", plan: "", model: "", staff: "", already_sent: false, source: "keepdate",
    }]));
    ctl.prefs.set("due_cache_date", "2026-07-03");
    await bootApp();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect(($("#confirm-template") as HTMLSelectElement).value).toBe("default-keepdate");
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();
    expect(ctl.sms.calls).toHaveLength(0);
    expect($("#toast").textContent).toBe("개통일을 알 수 없어 {경과개월}이 들어간 문구는 보낼 수 없습니다 — 문구를 수정하세요");
    expect($("#confirm-modal").classList.contains("hidden"), "sheet stays open to edit").toBe(false);

    ($("#confirm-text") as HTMLTextAreaElement).value = "직접 고친 안내 문구";
    ($("#confirm-send") as HTMLButtonElement).click();
    await settle();
    expect(ctl.sms.calls).toHaveLength(1);
  });
});

describe("E2E P1 #15: degraded 미결 scan", () => {
  it("shows a warning banner on home", async () => {
    ctl.gwRows = [dueRow];
    ctl.pendingNetErr = true; // 미결 fetch fails transiently -> degraded (not a logout)
    await bootApp();
    ($("#btn-scan") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 1500)); // client retries with real backoff
    await settle(20);
    expect($("#status-label").textContent).toBe("대기중");
    expect($("#degraded-banner").classList.contains("hidden")).toBe(false);
    ctl.pendingNetErr = false;
    await scan(); // a healthy scan clears it
    expect($("#degraded-banner").classList.contains("hidden")).toBe(true);
  });

  it("blocks sending a row the scan marked degraded", async () => {
    ctl.prefs.set("due_cache", JSON.stringify([{
      id: "01011112222|2026-07-03", phone: "010-1111-2222", customer: "홍길동", opendate: "24-01-03", expiry_date: "2026-07-03",
      milestone_offset: 0, telecom: "SK텔레콤", agency: "", openhow: "유심신규", plan: "", model: "", staff: "", already_sent: false, source: "keepdate", degraded: true,
    }]));
    ctl.prefs.set("due_cache_date", "2026-07-03");
    await bootApp();
    expect($("#degraded-banner").classList.contains("hidden")).toBe(false);
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect($("#confirm-modal").classList.contains("hidden")).toBe(true);
    expect($("#toast").textContent).toContain("다시 스캔");
  });
});

describe("E2E P1 #20: catch-up anchor ignores degraded scans", () => {
  // 유심 opened 2026-01-01: 1단계 (개통+6개월) = 2026-07-01, two days before TODAY.
  const usimRow: PoncleRow = {
    openphone: "010-6666-7777", customer: "김유심", opendate: "26-01-01",
    openhowx: "유심신규", telecomx: "SK텔레콤", agencytitle: "CD대리점", model: "",
  };
  const cachedKeys = () => (JSON.parse(ctl.prefs.get("due_cache") ?? "[]") as Array<{ expiry_date: string; milestone_offset: number }>)
    .map((r) => [r.expiry_date, r.milestone_offset]);

  it("a clean scan catches up from the last CLEAN scan, not a later degraded one", async () => {
    ctl.prefs.set("last_clean_scan_date", "2026-07-01");
    ctl.prefs.set("due_cache_date", "2026-07-02"); // the last scan (07-02) was degraded
    ctl.prefs.set("due_cache", "[]");
    ctl.gwRows = [usimRow];
    await bootApp();
    await scan();
    expect(cachedKeys()).toEqual([["2026-07-01", -2]]);
    expect(ctl.prefs.get("last_clean_scan_date")).toBe("2026-07-03");
  });

  it("a degraded scan moves the scan date but NOT the catch-up anchor", async () => {
    ctl.prefs.set("last_clean_scan_date", "2026-07-01");
    ctl.prefs.set("due_cache_date", "2026-07-01");
    ctl.gwRows = [dueRow];
    ctl.pendingNetErr = true;
    await bootApp();
    ($("#btn-scan") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 1500)); // client retries with real backoff
    await settle(20);
    expect($("#degraded-banner").classList.contains("hidden")).toBe(false);
    expect(ctl.prefs.get("due_cache_date")).toBe("2026-07-03");
    expect(ctl.prefs.get("last_clean_scan_date")).toBe("2026-07-01");
  });

  it("pre-upgrade (no clean anchor yet) falls back to the cached scan date", async () => {
    ctl.prefs.set("due_cache_date", "2026-07-01");
    ctl.prefs.set("due_cache", "[]");
    ctl.gwRows = [usimRow];
    await bootApp();
    await scan();
    expect(cachedKeys()).toEqual([["2026-07-01", -2]]);
  });
});

describe("E2E P1 L1: a stale session probe can't override the scan's banner", () => {
  it("a boot probe that resolves after a successful scan doesn't raise the login banner", async () => {
    ctl.checkGate = deferred(); // hold the boot probe's check()
    ctl.checkOk = false; // ...which will (stalely) answer 'expired'
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan(); // succeeds -> session ok, banner none
    expect($("#session-banner").classList.contains("hidden")).toBe(true);
    ctl.checkGate.resolve();
    await settle(20);
    expect($("#session-banner").classList.contains("hidden"), "the scan's state wins").toBe(true);
  });
});

describe("E2E P1 #19: changing 약정 개월 warns that sent records are kept", () => {
  it("shows the note in the terms screen", async () => {
    await bootApp();
    ($("[data-nav=terms]") as HTMLButtonElement).click();
    await settle();
    expect($("#terms-change-note").classList.contains("hidden")).toBe(true);
    const input = $("#s-standard-term") as HTMLInputElement;
    input.value = "36";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect($("#terms-change-note").classList.contains("hidden")).toBe(false);
    expect($("#terms-change-note").textContent).toContain("이미 안내한 고객의 발송 기록은 그대로 유지");
    expect(JSON.parse(ctl.prefs.get("app_config")!).default_term_months).toBe(36);
  });
});

describe("E2E P1 #23: card D-day label from the shared helper", () => {
  it("D-0 reads '오늘 만료'", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    expect($("#due-list .lc-dday").textContent).toBe("오늘 만료");
  });
});

/* ---------------- P2 stage 3 (ui-main lane) ---------------- */
const back = (): boolean => (window as unknown as { __poncleHandleBack: () => boolean }).__poncleHandleBack();
const shown = (screen: string): boolean => !$(`#view-${screen}`).classList.contains("hidden");
const toastText = (): string => $("#toast").textContent ?? "";
const cfgNow = (): Record<string, unknown> => JSON.parse(ctl.prefs.get("app_config") ?? "{}");
async function clickSel(sel: string): Promise<void> {
  ($(sel) as HTMLElement).click();
  await settle();
}

describe("E2E P2 #30: hardware back navigates to the parent screen (1-26)", () => {
  it("settings/dashboard/lookup/history -> home; on home nothing is consumed", async () => {
    await bootApp();
    expect(back()).toBe(false); // home, nothing open: the activity backgrounds the app
    for (const s of ["settings", "dashboard", "lookup", "history"]) {
      await nav(s);
      expect(shown(s)).toBe(true);
      expect(back(), `back on ${s}`).toBe(true);
      await settle();
      expect(shown("home"), `${s} -> home`).toBe(true);
    }
  });

  it("terms -> settings -> home", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=terms]");
    expect(shown("terms")).toBe(true);
    expect(back()).toBe(true);
    await settle();
    expect(shown("settings")).toBe(true);
    expect(back()).toBe(true);
    await settle();
    expect(shown("home")).toBe(true);
  });

  it("template-edit -> templates -> settings; unchanged edit leaves without asking", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    await clickSel("#tpl-list .tpl-card .lc-top");
    expect(shown("template-edit")).toBe(true);
    expect(back()).toBe(true);
    await settle();
    expect(dialogOpen()).toBe(false);
    expect(shown("templates")).toBe(true);
    expect(back()).toBe(true);
    await settle();
    expect(shown("settings")).toBe(true);
  });

  it("unsaved template edits ask with the in-app confirm before discarding", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    await clickSel("#btn-tpl-new");
    ($("#te-name") as HTMLInputElement).value = "작성 중";
    expect(back()).toBe(true);
    await settle();
    expect(dialogText()).toContain("저장하지 않은");
    await answerDialog(false); // keep editing
    expect(shown("template-edit")).toBe(true);
    expect(($("#te-name") as HTMLInputElement).value).toBe("작성 중");
    // back while the confirm is up dismisses it (= keep editing)
    expect(back()).toBe(true);
    await settle();
    expect(dialogOpen()).toBe(true);
    expect(back()).toBe(true);
    await settle();
    expect(dialogOpen()).toBe(false);
    expect(shown("template-edit")).toBe(true);
    // the topbar back button asks too; confirming discards
    await clickSel("#view-template-edit .backbtn");
    await answerDialog(true);
    expect(shown("templates")).toBe(true);
  });

  it("back closes the update prompt like 나중에", async () => {
    ctl.update.result = { available: true, url: "https://github.com/o/r/releases/download/x/app.apk", version: "9.9.9", notes: "" };
    await bootApp();
    expect($("#update-modal").classList.contains("hidden")).toBe(false);
    expect(back()).toBe(true);
    expect($("#update-modal").classList.contains("hidden")).toBe(true);
  });
});

describe("E2E P2 #34: update check feedback (1-28)", () => {
  it("a failed manual check says so (never '최신 버전')", async () => {
    await bootApp();
    ctl.update.result = { available: false, url: "", version: "", notes: "", error: "서버 응답 오류 (HTTP 403)" };
    await nav("settings");
    await clickSel("#btn-check-update");
    expect(toastText()).toContain("업데이트 확인 실패");
    expect(toastText()).not.toContain("최신");
  });

  it("a clean 'no update' manual check says 최신", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("#btn-check-update");
    expect(toastText()).toContain("이미 최신 버전입니다");
  });

  it("a manual tap during the boot auto-check shares it and still answers", async () => {
    ctl.update.gate = deferred();
    await bootApp();
    expect(ctl.update.calls).toBe(1);
    await nav("settings");
    await clickSel("#btn-check-update");
    expect(toastText()).toContain("업데이트 확인 중");
    ctl.update.gate.resolve();
    await settle();
    expect(ctl.update.calls).toBe(1); // one shared network check
    expect(toastText()).toContain("이미 최신 버전입니다");
  });

  it("openUrl failure is surfaced, the prompt stays, and the version is not muted", async () => {
    const url = "https://github.com/o/r/releases/download/x/app.apk";
    ctl.update.result = { available: true, url, version: "9.9.9", notes: "" };
    ctl.openUrlFail = true;
    await bootApp();
    expect($("#update-modal").classList.contains("hidden")).toBe(false);
    await clickSel("#upd-now");
    expect(toastText()).toContain("열 수 없습니다");
    expect($("#update-modal").classList.contains("hidden")).toBe(false);
    ctl.openUrlFail = false;
    await clickSel("#upd-now");
    expect(ctl.openedUrls).toEqual([url]);
    expect($("#update-modal").classList.contains("hidden")).toBe(true);
  });
});

describe("E2E P2 #35: saving changed scan settings (1-31)", () => {
  it("with a live session, 저장 after changing 안내 시점 rescans", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("#dday-chips [data-dday='30']");
    const before = ctl.openCalls;
    await clickSel("#btn-save");
    expect(ctl.openCalls).toBeGreaterThan(before);
    expect(toastText()).toContain("다시 스캔");
  });

  it("without a session it says the change applies from the next scan", async () => {
    ctl.checkOk = false;
    await bootApp();
    await nav("settings");
    await clickSel("#dday-chips [data-dday='30']");
    await clickSel("#btn-save");
    expect(ctl.openCalls).toBe(0);
    expect(toastText()).toContain("다음 스캔부터 반영됩니다");
  });

  it("nothing scan-related changed: plain 저장되었습니다", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("#btn-save");
    expect(ctl.openCalls).toBe(0);
    expect(toastText()).toBe("저장되었습니다");
  });

  it("약정 개월 auto-saved on the terms screen: leaving 설정 rescans with a live session", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=terms]");
    const input = $("#s-standard-term") as HTMLInputElement;
    input.value = "36";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect($("#terms-change-note").classList.contains("hidden")).toBe(false);
    const before = ctl.openCalls;
    await nav("settings"); // still inside 설정: no scan yet
    expect(ctl.openCalls).toBe(before);
    await nav("home");
    await settle(30);
    expect(ctl.openCalls).toBeGreaterThan(before);
    expect(toastText()).toContain("다시 스캔");
  });

  it("안내 시점 chip auto-saved, no session: leaving 설정 says 다음 스캔부터 (once)", async () => {
    ctl.checkOk = false;
    await bootApp();
    await nav("settings");
    await clickSel("#dday-chips [data-dday='30']");
    await nav("home");
    await settle(30);
    expect(ctl.openCalls).toBe(0);
    expect(toastText()).toContain("다음 스캔부터 반영됩니다");
  });

  it("the terms note shows even when back is pressed right after editing", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=terms]");
    const input = $("#s-standard-term") as HTMLInputElement;
    input.value = "12";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect($("#terms-change-note").classList.contains("hidden")).toBe(false);
  });
});

describe("E2E P2 #36/#38: template list order + unknown tokens", () => {
  const ids = (): string[] => ((cfgNow().templates as Array<{ id: string }>) ?? []).map((t) => t.id);

  it("▼/▲ reorder the list (persisted) without opening the editor", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    expect(ids()).toEqual(["default-keepdate", "default-term"]);
    expect(($("#tpl-list .tpl-card .tpl-up") as HTMLButtonElement).disabled).toBe(true);
    await clickSel("#tpl-list .tpl-card .tpl-down");
    expect(ids()).toEqual(["default-term", "default-keepdate"]);
    expect(shown("templates")).toBe(true);
    const names = Array.from(document.querySelectorAll("#tpl-list .lc-name")).map((e) => e.textContent);
    expect(names[0]).toContain("약정 만료");
  });

  it("warns about an unknown {token} on save; cancel keeps editing, confirm saves", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    await clickSel("#btn-tpl-new");
    ($("#te-body") as HTMLTextAreaElement).value = "{이름}님 안녕하세요";
    await clickSel("#btn-te-save");
    expect(dialogText()).toContain("{이름}");
    await answerDialog(false);
    expect(shown("template-edit")).toBe(true);
    expect(ids()).toHaveLength(2);
    await clickSel("#btn-te-save");
    await answerDialog(true);
    expect(ids()).toHaveLength(3);
    expect(shown("templates")).toBe(true);
  });

  it("Korean aliases like {고객명} are accepted without a warning", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    await clickSel("#btn-tpl-new");
    ($("#te-body") as HTMLTextAreaElement).value = "{고객명}님 {만료일} 만료";
    await clickSel("#btn-te-save");
    expect(dialogOpen()).toBe(false);
    expect(ids()).toHaveLength(3);
  });
});

describe("E2E P2 #39: 약정 개월 range", () => {
  it("clamps an out-of-range value and shows an inline message", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=terms]");
    const input = $("#s-standard-term") as HTMLInputElement;
    input.value = "240";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(input.value).toBe("60");
    expect($("#terms-range-msg").classList.contains("hidden")).toBe(false);
    expect($("#terms-range-msg").textContent).toContain("1~60");
    expect(cfgNow().default_term_months).toBe(60);
  });
});

describe("E2E P2 #40: Korean mobile number check before sending", () => {
  it("a landline due row is refused with a clear toast; nothing is sent or recorded", async () => {
    ctl.gwRows = [{ ...dueRow, openphone: "02-123-4567" }];
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "안내";
    await clickSel("#confirm-send");
    expect(ctl.sms.calls).toEqual([]);
    expect(sentLog()).toEqual([]);
    expect(toastText()).toContain("휴대폰 번호");
    expect($("#confirm-modal").classList.contains("hidden")).toBe(false);
  });

  it("설정 테스트 문자 refuses a non-mobile number", async () => {
    await bootApp();
    await nav("settings");
    ($("#s-test-phone") as HTMLInputElement).value = "1234";
    await clickSel("#btn-test-sms");
    expect(ctl.sms.calls).toEqual([]);
    expect($("#test-sms-msg").textContent).toContain("휴대폰 번호");
  });
});

describe("E2E P2 #41: restored config field types", () => {
  it("deliver_alerts:'false' does not switch real sending on; valid fields apply; summary toast", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: false }));
    await bootApp();
    await nav("settings");
    await restoreFile(JSON.stringify({ app: "poncle-expiry", history: [], config: { deliver_alerts: "false", default_term_months: 36, templates: 7 } }));
    expect(cfgNow().deliver_alerts).toBe(false);
    expect(cfgNow().default_term_months).toBe(36);
    expect((cfgNow().templates as unknown[]).length).toBe(2); // kept, not wiped
    expect(toastText()).toContain("건너뛰");
  });
});

describe("E2E P2 #42: CSV export is a real file", () => {
  it("writes a BOM-prefixed .csv with 만료일 and shares the file (not text)", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([
      { ...recBase, phone: "010-1111-2222", expiry_date: "2026-07-03", channel: "sms", sent_at: "2026-07-01T09:00:00", body: "=1+1" },
    ]));
    await bootApp();
    await nav("settings");
    await clickSel("#btn-export-csv");
    const f = ctl.files.find((x) => x.path.endsWith(".csv"));
    expect(f).toBeTruthy();
    expect(f!.data.startsWith("﻿")).toBe(true);
    expect(f!.data).toContain("만료일");
    expect(f!.data).toContain("'=1+1");
    expect(ctl.share.last?.url).toBe("x");
    expect(ctl.share.last?.text).toBeUndefined();
  });
});

describe("E2E P2 #43/#44/#49: 고객 조회", () => {
  const many = (n: number): PoncleRow[] => Array.from({ length: n }, (_, i) => ({
    ...dueRow, openphone: `010-2000-${String(1000 + i)}`, customer: `김철수${i}`,
  }));

  it("says the result was cut off when the server has more than the first page (3-12)", async () => {
    ctl.gwRows = many(100);
    ctl.openTotal = 250;
    await bootApp();
    await lookupFor("김철수");
    const text = $("#lk-body").textContent ?? "";
    expect(text).toContain("검색 결과가 많습니다");
    expect(text).toContain("250건 중 100건");
  });

  it("no notice for a small result", async () => {
    ctl.gwRows = many(3);
    await bootApp();
    await lookupFor("김철수");
    expect($("#lk-body").textContent).not.toContain("검색 결과가 많습니다");
  });

  it("로그인 from the lookup banner re-runs the lookup (not a full scan)", async () => {
    ctl.openFail = true;
    await bootApp();
    await lookupFor("홍길동");
    expect($("#lk-login")).toBeTruthy();
    ctl.openFail = false;
    ctl.gwRows = [dueRow];
    await clickSel("#lk-login");
    await settle();
    expect(ctl.loginCalls).toBe(1);
    expect(document.querySelectorAll("#lk-body .lk-card").length).toBe(1);
    expect(ctl.prefs.has("due_cache_date")).toBe(false); // no scan ran
  });

  it("a slow earlier response never overwrites a newer query's results", async () => {
    ctl.gwRows = [{ ...dueRow, customer: "가나다" }];
    ctl.openGate = deferred();
    const gate = ctl.openGate;
    await bootApp();
    await lookupFor("가나다"); // stuck on the gate
    ctl.gwRows = [{ ...dueRow, openphone: "010-3333-4444", customer: "라마바" }];
    ($("#lk-query") as HTMLInputElement).value = "라마바";
    await clickSel("#lk-submit");
    expect($("#lk-body").textContent).toContain("라마바");
    gate.resolve();
    await settle();
    expect($("#lk-body").textContent).toContain("라마바");
    expect($("#lk-body").textContent).not.toContain("가나다");
  });
});

describe("E2E P2 #49: dashboard scan button + onboarding results", () => {
  it("the dashboard button shows 스캔 중 while any scan runs and redraws after", async () => {
    ctl.gwRows = [dueRow];
    ctl.pendingGate = deferred();
    await bootApp();
    ($("#btn-scan") as HTMLButtonElement).click();
    await settle();
    await nav("dashboard");
    const btn = () => $("#dash-scan") as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toContain("스캔 중");
    ctl.pendingGate.resolve();
    await settle(30);
    expect(btn().disabled).toBe(false);
    expect(btn().textContent).toBe("지금 스캔");
    expect($("#dash-body .dt-num").textContent).toBe("1");
  });

  it("onboarding shows ✓ only when the permission was granted / login succeeded", async () => {
    ctl.prefs.delete("onboarded_v1");
    ctl.smsPerm = false;
    await bootApp();
    expect($("#onboarding").classList.contains("hidden")).toBe(false);
    await clickSel("#onb-body button");
    expect($("#onb-body button").textContent).not.toContain("✓");
    ctl.smsPerm = true;
    await clickSel("#onb-body button");
    expect($("#onb-body button").textContent).toContain("✓");
    await clickSel("#onb-next");
    ctl.loginOk = false;
    await clickSel("#onb-body button");
    expect($("#onb-body button").textContent).not.toContain("✓");
  });
});

/* ---------------- P3 stage 4a ---------------- */
const tplIds = (): string[] => ((cfgNow().templates as Array<{ id: string }>) ?? []).map((t) => t.id);

describe("E2E P3 #50: doConfirmSend resend upsert", () => {
  it("재발송 of a delivered customer replaces the ONE record (new body/id) and keeps the earlier send as prev_sent", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ delivery: "delivered", sms_id: "old-1" })]));
    await bootApp();
    await scan();
    ($("#due-list .btn-send.resend") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "다시 안내";
    await clickSel("#confirm-send");
    const log = sentLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ channel: "sms", body: "다시 안내", sms_id: "sms-1" });
    expect((log[0].prev_sent as Record<string, unknown>).sent_at).toBe("2026-07-01T09:00:00");
    expect(toastText()).toContain("다시 보냈습니다");
  });
});

describe("E2E P3 #50: a history READ failure before sending releases the in-flight guard", () => {
  it("shows an error, sends nothing, and the next try is not '이미 처리 중'", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    ($("#confirm-text") as HTMLTextAreaElement).value = "안내";
    ctl.failGetKeys.add("sent_log"); // getRecord(prev) throws
    await clickSel("#confirm-send");
    expect(ctl.sms.calls).toHaveLength(0);
    expect(toastText()).toContain("이력을 읽지 못했습니다");
    expect($("#toast").classList.contains("err")).toBe(true);

    ctl.failGetKeys.clear();
    await sendFromHome("안내");
    expect(toastText()).not.toContain("이미 처리 중");
    expect(ctl.sms.calls).toHaveLength(1);
    expect(sentLog()).toHaveLength(1);
  });
});

describe("E2E P3 #53: onboarding runs the first scan after a successful login", () => {
  it("login in onboarding -> finishing scans right away (no manual tap)", async () => {
    ctl.prefs.delete("onboarded_v1");
    ctl.gwRows = [dueRow];
    await bootApp();
    await clickSel("#onb-next"); // -> 폰클 로그인 step
    await clickSel("#onb-body button");
    expect($("#onb-body button").textContent).toContain("✓");
    await clickSel("#onb-skip");
    await settle(20);
    expect(ctl.openCalls).toBeGreaterThan(0);
    expect(document.querySelectorAll("#due-list .listcard").length).toBe(1);
  });

  it("finishing WITHOUT a login only checks the session (no scan)", async () => {
    ctl.prefs.delete("onboarded_v1");
    ctl.gwRows = [dueRow];
    await bootApp();
    await clickSel("#onb-skip");
    await settle(20);
    expect(ctl.openCalls).toBe(0);
  });
});

describe("E2E P3 #54: template delete asks first and can be undone", () => {
  it("cancel keeps it; confirm deletes; 실행취소 restores it at its old position", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    await clickSel("#tpl-list .tpl-card .lc-top"); // first card = default-keepdate
    await clickSel("#btn-te-delete");
    expect(dialogOpen()).toBe(true);
    expect(dialogText()).toContain("요금제 유지");
    await answerDialog(false);
    expect(tplIds()).toEqual(["default-keepdate", "default-term"]);
    expect(shown("template-edit")).toBe(true);

    await clickSel("#btn-te-delete");
    await answerDialog(true);
    expect(tplIds()).toEqual(["default-term"]);
    expect(shown("templates")).toBe(true);
    expect(toastText()).toContain("삭제");
    await clickSel("#toast .toast-undo");
    await settle();
    expect(tplIds()).toEqual(["default-keepdate", "default-term"]);
    expect(document.querySelectorAll("#tpl-list .tpl-card").length).toBe(2);
  });
});

describe("E2E P3 #55: backup carries 미방문 제외 + 재방문 코호트", () => {
  const cohortEntry = { phone: "010-1111-2222", expiry: "2026-05-01", informed: true, revisited: false, firstSeen: "2026-05-02" };

  it("exports them and a restore merges them into this phone's own", async () => {
    ctl.prefs.set("unvisited_handled", JSON.stringify(["01011112222|2026-05-01"]));
    ctl.prefs.set("cohort_log", JSON.stringify([cohortEntry]));
    await bootApp();
    await nav("settings");
    await clickSel("#btn-export-backup");
    const file = ctl.files.find((f) => f.path.endsWith(".json"))!;
    const backup = JSON.parse(file.data);
    expect(backup.excluded).toEqual(["01011112222|2026-05-01"]);
    expect(backup.cohort).toEqual([cohortEntry]);

    await restoreFile(JSON.stringify({
      app: "poncle-expiry", history: [],
      excluded: ["010-3333-4444|2026-06-01", "bad"],
      cohort: [{ phone: "010-5555-6666", expiry: "2026-04-01", informed: false, revisited: true, firstSeen: "2026-04-01" }],
    }));
    expect(JSON.parse(ctl.prefs.get("unvisited_handled")!).sort()).toEqual(["01011112222|2026-05-01", "01033334444|2026-06-01"]);
    expect(JSON.parse(ctl.prefs.get("cohort_log")!)).toHaveLength(2);
    expect($("#backup-msg").textContent).toContain("미방문 제외 1명");
  });
});

describe("E2E P3 #58: phone date differs from Poncle's -> warn + block sending", () => {
  it("shows the banner and refuses to open the send sheet; a correct date clears it", async () => {
    ctl.gwRows = [dueRow];
    ctl.serverDate = "2026-07-06T00:00:00.000Z"; // 3 days after the phone's 2026-07-03
    await bootApp();
    expect($("#clock-banner").classList.contains("hidden")).toBe(false);
    expect($("#clock-title").textContent).toContain("휴대폰 날짜가 실제와 다릅니다");
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    expect($("#confirm-modal").classList.contains("hidden")).toBe(true);
    expect(toastText()).toContain("날짜/시간 자동 설정");
    expect(ctl.sms.calls).toEqual([]);

    ctl.serverDate = new Date().toISOString(); // the phone's (fake) now: same instant
    await scan();
    expect($("#clock-banner").classList.contains("hidden")).toBe(true);
    await sendFromHome();
    expect(ctl.sms.calls).toHaveLength(1);
  });

  it("a correct date seen days ago does not age into a false warning (offline foreground)", async () => {
    ctl.gwRows = [dueRow];
    ctl.serverDate = new Date().toISOString(); // correct phone clock
    await bootApp();
    await scan();
    expect($("#clock-banner").classList.contains("hidden")).toBe(true);
    // Two days in the background, then a foreground probe that cannot reach Poncle.
    vi.setSystemTime(new Date("2026-07-05T09:00:00"));
    ctl.checkThrows = true;
    foreground();
    await settle(20);
    expect($("#clock-banner").classList.contains("hidden")).toBe(true);
  });

  it("no server date seen (older native build) never blocks", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    expect($("#clock-banner").classList.contains("hidden")).toBe(true);
    await sendFromHome();
    expect(ctl.sms.calls).toHaveLength(1);
  });
});

describe("E2E P3 #59/#57: 이력 shows the real total, pages, and the first-send note", () => {
  it("450 records: '총 450건 중 200건 표시', 더 보기 twice shows all", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({
      ...recBase, phone: `010-7${String(i).padStart(3, "0")}-0000`, expiry_date: "2026-07-03", channel: "sms",
      sent_at: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T09:00:00`,
    }));
    ctl.prefs.set("sent_log", JSON.stringify(rows));
    await bootApp();
    await nav("history");
    expect($("#h-count").textContent).toBe("총 450건 중 200건 표시");
    expect(document.querySelectorAll("#h-list .listcard").length).toBe(200);
    expect($("#h-more").classList.contains("hidden")).toBe(false);
    await clickSel("#h-more");
    expect(document.querySelectorAll("#h-list .listcard").length).toBe(400);
    await clickSel("#h-more");
    expect(document.querySelectorAll("#h-list .listcard").length).toBe(450);
    expect($("#h-more").classList.contains("hidden")).toBe(true);
    expect($("#h-count").textContent).toBe("450건");
    expect($("#h-retention").textContent).toContain("자동으로 지워지지 않습니다");
  });

  it("a resent customer's card says '최초 발송 YYYY-MM-DD · N회'", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ first_sent_at: "2026-06-01T10:00:00", send_count: 3 })]));
    await bootApp();
    await nav("history");
    expect($("#h-list .lc-meta").textContent).toContain("최초 발송 2026-06-01 · 3회");
  });
});

describe("E2E P3 #60/#61: default wording, untouched-default upgrade, SMS length line", () => {
  it("the 약정 만료 default renders {years}/{when} and '{customer} 고객님'; the sheet shows 장문 info", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    const text = ($("#confirm-text") as HTMLTextAreaElement).value;
    expect(text).toContain("홍길동 고객님");
    expect(text).toContain("2년 전 휴대폰 개통");
    expect(text).toContain("약정 만료: 오늘 2026-07-03");
    expect($("#confirm-len").textContent).toContain("장문(LMS)");
    const ta = $("#confirm-text") as HTMLTextAreaElement;
    ta.value = "짧은 안내";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect($("#confirm-len").textContent).toContain("단문");
    expect($("#confirm-len").textContent).toContain("5자");
  });

  it("an existing install's UNTOUCHED old default is upgraded; an edited one is kept", async () => {
    const { DEFAULT_TEMPLATES, LEGACY_DEFAULT_TEMPLATE_BODIES } = await import("../../src/domain/config");
    const [keep, term] = DEFAULT_TEMPLATES;
    ctl.prefs.set("default_templates_seeded_v2", "1");
    ctl.prefs.set("app_config", JSON.stringify({
      deliver_alerts: true,
      templates: [
        { ...keep, body: LEGACY_DEFAULT_TEMPLATE_BODIES["default-keepdate"][0] + "\n(매장 메모)" },
        { ...term, body: LEGACY_DEFAULT_TEMPLATE_BODIES["default-term"][0] },
      ],
    }));
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    const text = ($("#confirm-text") as HTMLTextAreaElement).value;
    expect(text).toContain("2년 전 휴대폰 개통");
    expect(text).not.toContain("종료되어");
    await clickSel("#confirm-cancel");
    await nav("settings");
    await clickSel("[data-nav=templates]");
    await clickSel("#tpl-list .tpl-card .lc-top");
    const body = ($("#te-body") as HTMLTextAreaElement).value;
    expect(body).toContain("{customer}고객님"); // the edited one stays exactly as the user left it
    expect(body).toContain("(매장 메모)");
  });
});

describe("E2E P3 #62: accessibility", () => {
  it("toggle is a switch with aria-checked; icon buttons are labelled; the toast is a live region", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: false }));
    await bootApp();
    await nav("settings");
    const sw = $("#s-deliver");
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await clickSel("#s-deliver");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    for (const b of Array.from(document.querySelectorAll(".backbtn"))) expect(b.getAttribute("aria-label")).toBe("뒤로");
    for (const b of Array.from(document.querySelectorAll(".navbtn"))) expect(b.getAttribute("aria-label")).toBeTruthy();
    expect($("#toast").getAttribute("aria-live")).toBeTruthy();
    expect($("#dday-chips .chip.on").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("E2E P3 #63/L7: dead UI removed, number message unified", () => {
  it("no never-opened modals, no #save-msg, no 거래처 예외 copy", async () => {
    await bootApp();
    expect(document.querySelector("#picker-modal")).toBeNull();
    expect(document.querySelector("#notpl-modal")).toBeNull();
    expect(document.querySelector("#save-msg")).toBeNull();
    expect($("#view-settings").textContent).not.toContain("거래처별 예외");
  });

  it("a landline is refused with the native wording", async () => {
    ctl.gwRows = [{ ...dueRow, openphone: "02-123-4567" }];
    await bootApp();
    await scan();
    await sendFromHome("안내");
    expect(toastText()).toContain("휴대폰 번호 형식이 올바르지 않습니다");
  });
});

describe("E2E P3 L6: exported files don't linger in the cache", () => {
  it("boot purges leftover export files only", async () => {
    ctl.cacheDir = ["poncle-backup-2026-07-01.json", "poncle-history-2026-07-02.csv", "other.txt"];
    await bootApp();
    expect(ctl.deleted.sort()).toEqual(["poncle-backup-2026-07-01.json", "poncle-history-2026-07-02.csv"]);
  });

  it("neither a cancelled (ambiguous, B4) nor a completed share deletes the file right away", async () => {
    await bootApp();
    await nav("settings");
    ctl.share.mode = "cancel";
    await clickSel("#btn-export-backup");
    expect(ctl.deleted).toEqual([]);
    ctl.share.mode = "resolve";
    await clickSel("#btn-export-backup");
    expect(ctl.deleted).toEqual([]);
  });
});

describe("E2E P3 #52: home order — unsent first, most urgent on top, re-sorted after a send", () => {
  it("D-0 before D-3; after sending the D-0 customer it drops below the unsent one", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, notify_offsets_days: [7] }));
    ctl.gwRows = [
      { ...dueRow, openphone: "010-3333-0003", customer: "삼일뒤", opendate: "24-07-06" },
      { ...dueRow, openphone: "010-3333-0000", customer: "오늘", opendate: "24-07-03" },
    ];
    await bootApp();
    await scan();
    const names = () => Array.from(document.querySelectorAll("#due-list .lc-name")).map((e) => e.textContent);
    expect(names()).toEqual(["오늘", "삼일뒤"]);
    await sendFromHome();
    expect(names()).toEqual(["삼일뒤", "오늘"]);
  });
});

describe("E2E P3 #56: a paging-cap cut-off is told to the user", () => {
  it("unparseable total + endless full pages -> scan finishes with a '일부만' notice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, page_size: 1 }));
    ctl.gwRows = [dueRow];
    ctl.openTotal = 0; // total unparseable -> a full page means "keep going" until the cap
    await bootApp();
    await scan();
    expect(ctl.openCalls).toBeGreaterThanOrEqual(2000);
    expect(toastText()).toContain("일부만");
    expect(document.querySelectorAll("#due-list .lc-name").length).toBe(1); // the list still shows
    warn.mockRestore();
  });

  it("a normal scan shows no cut-off notice", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    expect(toastText()).not.toContain("일부만");
  });
});

describe("E2E G3: logout waits for the native cookie clear", () => {
  it("shows a busy state, ignores a double tap, then reports 로그아웃됨", async () => {
    ctl.logoutGate = deferred();
    const gate = ctl.logoutGate;
    await bootApp();
    ($("#nav-settings") as HTMLButtonElement).click();
    await settle();
    const btn = $("#btn-logout") as HTMLButtonElement;
    btn.click();
    await settle();
    expect(btn.disabled).toBe(true);
    expect($("#session-state").textContent).toBe("로그아웃 중…");
    btn.click(); // impatient second tap while the native clear is still running
    await settle();
    expect(ctl.logoutCalls).toBe(1);
    gate.resolve();
    await settle();
    expect(btn.disabled).toBe(false);
    expect($("#session-state").textContent).toBe("로그아웃됨");
  });
});

/* ---------------- Stage R1 (audit 2026-11-17: B1–B16, D1–D5 UI) ---------------- */
const unvRow = (over: Record<string, unknown> = {}) => ({
  id: "01011112222|2026-05-01", phone: "010-1111-2222", customer: "미방문", opendate: "24-05-01", expiry_date: "2026-05-01",
  milestone_offset: -63, telecom: "SK텔레콤", agency: "", openhow: "기변", plan: "", model: "", staff: "", already_sent: false, source: "term",
  ...over,
});
async function openUnvisitedTab(): Promise<void> {
  await nav("history");
  await clickSel("#hist-tabs [data-htab='unvisited']");
}

describe("E2E R1 B1/B11: a 직접 입력 send to a '여유' customer is a manual record", () => {
  it("is stored as source 'manual', shows as 안내함 in 조회, and does not block the real milestone later", async () => {
    ctl.gwRows = [{ ...dueRow, opendate: "26-01-05" }]; // 24-month term ends 2028-01-05: 여유
    await bootApp();
    await lookupFor("홍길동");
    await clickSel("#lk-body .lk-send");
    await answerDialog(true);
    ($("#confirm-text") as HTMLTextAreaElement).value = "안부 문자";
    await clickSel("#confirm-send");
    const log = sentLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ source: "manual", channel: "sms" });
    expect($("#lk-body .lk-inf-yes")?.textContent).toContain("2026-07-03");

    // Two years on, the real 약정 만료 milestone of that customer is NOT 'sent'.
    vi.setSystemTime(new Date("2028-01-05T09:00:00"));
    await nav("home");
    await scan();
    expect($("#c-targets").textContent).not.toBe("0");
    expect($("#c-sent").textContent).toBe("0");
  });
});

describe("E2E R1 B4: an ambiguous share 'cancel' keeps the file; cleanup waits", () => {
  it("cancel: gentle toast, file kept, backup not marked done; the next export purges the earlier file", async () => {
    await bootApp();
    await nav("settings");
    ctl.share.mode = "cancel";
    await clickSel("#btn-export-backup");
    expect(ctl.deleted).toEqual([]);
    expect(ctl.prefs.has("last_backup_at")).toBe(false);
    expect($("#toast").classList.contains("err")).toBe(false);
    ctl.cacheDir = ["poncle-backup-2026-07-02.json", "poncle-backup-2026-07-03.json"];
    ctl.share.mode = "resolve";
    await clickSel("#btn-export-backup");
    expect(ctl.deleted).toEqual(["poncle-backup-2026-07-02.json"]);
    expect(ctl.prefs.has("last_backup_at")).toBe(true);
  });

  it("a definite failure (share unavailable) still deletes the file right away", async () => {
    await bootApp();
    await nav("settings");
    ctl.share.mode = "unavailable";
    await clickSel("#btn-export-backup");
    expect(ctl.deleted).toEqual(["poncle-backup-2026-07-03.json"]);
  });
});

describe("E2E R1 B6: restore merges against the log as it is AFTER the confirm", () => {
  it("a send failure that landed while the confirm was open is not overwritten", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ sms_id: "a-1" })]));
    await bootApp();
    await nav("settings");
    const input = $("#restore-file") as HTMLInputElement;
    const file = new File([JSON.stringify({ app: "poncle-expiry", history: [smsRec({ phone: "010-9999-0000", customer: "Z" })] })], "b.json");
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(20);
    expect(dialogOpen()).toBe(true);
    // Meanwhile the native result marks the first send failed.
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ sms_id: "a-1", delivery: "failed", fail_reason: "유심" })]));
    await answerDialog(true);
    await settle(20);
    const log = sentLog();
    expect(log).toHaveLength(2);
    expect(log.find((r) => r.phone === "010-1111-2222")).toMatchObject({ delivery: "failed" });
  });
});

describe("E2E R1 B7: 미방문 tab — 기준일 line + stale-send confirm", () => {
  it("names the clean scan day and asks before sending from an older list", async () => {
    ctl.prefs.set("unvisited_cache", JSON.stringify([unvRow()]));
    ctl.prefs.set("last_clean_scan_date", "2026-06-20");
    await bootApp();
    await openUnvisitedTab();
    expect($("#u-basis").classList.contains("hidden")).toBe(false);
    expect($("#u-basis").textContent).toContain("6월 20일 스캔 기준");
    await clickSel("#u-list .btn-send");
    expect(dialogText()).toContain("6월 20일");
    await answerDialog(false);
    expect($("#confirm-modal").classList.contains("hidden")).toBe(true);
    await clickSel("#u-list .btn-send");
    await answerDialog(true);
    expect($("#confirm-modal").classList.contains("hidden")).toBe(false);
  });

  it("today's clean scan: no confirm, plain basis line", async () => {
    ctl.prefs.set("unvisited_cache", JSON.stringify([unvRow()]));
    ctl.prefs.set("last_clean_scan_date", "2026-07-03");
    await bootApp();
    await openUnvisitedTab();
    expect($("#u-basis").textContent).toBe("오늘 스캔 기준입니다");
    await clickSel("#u-list .btn-send");
    expect(dialogOpen()).toBe(false);
    expect($("#confirm-modal").classList.contains("hidden")).toBe(false);
  });
});

describe("E2E R1 B8: a 미방문 제외 survives an expiry-key change of the same contract", () => {
  it("excluded under 2026-05-01 stays excluded when the row's expiry becomes 2026-06-01", async () => {
    ctl.prefs.set("unvisited_cache", JSON.stringify([unvRow()]));
    await bootApp();
    await openUnvisitedTab();
    await clickSel("#u-list .btn-recontact");
    expect($("#hist-unvisited-count").classList.contains("hidden")).toBe(true);
    // 약정 개월 changed -> the same 개통 now has another expiry (id).
    ctl.prefs.set("unvisited_cache", JSON.stringify([unvRow({ id: "01011112222|2026-06-01", expiry_date: "2026-06-01" })]));
    await nav("home");
    await openUnvisitedTab();
    expect($("#hist-unvisited-count").classList.contains("hidden")).toBe(true);
    expect(document.querySelectorAll("#u-list .listcard").length).toBe(0);
  });
});

describe("E2E R1 B9: a resend under a drifted expiry upserts the existing record", () => {
  it("one record (its own key), the earlier send kept as prev_sent, '다시 보냈습니다'", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ phone: "01011112222", expiry_date: "2026-07-01", sent_at: "2026-06-28T09:00:00", source: "term" })]));
    await bootApp();
    await scan();
    await clickSel("#due-list .btn-send.resend");
    ($("#confirm-text") as HTMLTextAreaElement).value = "다시 안내";
    await clickSel("#confirm-send");
    const log = sentLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ expiry_date: "2026-07-01", body: "다시 안내", channel: "sms" });
    expect((log[0].prev_sent as Record<string, unknown>).sent_at).toBe("2026-06-28T09:00:00");
    expect(toastText()).toContain("다시 보냈습니다");
    expect($("#due-list .btn-send.resend")).toBeTruthy();
  });
});

describe("E2E R1 B10: a scan with a wrong phone date persists nothing date-based", () => {
  it("no cohort / clean date / caches while skewed; a correct-date scan writes them", async () => {
    ctl.gwRows = [dueRow];
    ctl.serverDate = "2026-07-06T00:00:00.000Z"; // phone says 07-03
    await bootApp();
    await scan();
    expect(ctl.prefs.has("cohort_log")).toBe(false);
    expect(ctl.prefs.has("last_clean_scan_date")).toBe(false);
    expect(ctl.prefs.has("due_cache")).toBe(false);
    expect(ctl.prefs.has("unvisited_cache")).toBe(false);
    expect(toastText()).toContain("저장하지 않았습니다");

    ctl.serverDate = new Date().toISOString();
    await scan();
    expect(ctl.prefs.get("last_clean_scan_date")).toBe("2026-07-03");
    expect(ctl.prefs.has("due_cache")).toBe(true);
    expect(ctl.prefs.has("cohort_log")).toBe(true);
  });
});

describe("E2E R1 B15: a release this phone can't install never pops the update prompt", () => {
  const unsupported = { available: false, url: "", version: "1.2.17", notes: "", reason: "unsupported", minSdk: 26 };

  it("passes the SDK level, shows a one-time notice instead of the popup", async () => {
    ctl.sdkInt = 24;
    ctl.update.result = { ...unsupported };
    await bootApp();
    await settle(20);
    expect(ctl.update.args).toEqual(["1.0.0", 24]);
    expect($("#update-modal").classList.contains("hidden")).toBe(true);
    // Names this phone's Android (API 24) and the release's minimum (minSdk 26).
    expect(dialogText()).toContain("Android 7.0");
    expect(dialogText()).toContain("Android 8.0 이상");
    await answerDialog(true);
    expect(ctl.prefs.get("update_unsupported_notified")).toBe("1.2.17");
  });

  it("already notified for that version: nothing on boot; a manual check answers in a toast", async () => {
    ctl.sdkInt = 24;
    ctl.update.result = { ...unsupported };
    ctl.prefs.set("update_unsupported_notified", "1.2.17");
    await bootApp();
    await settle(20);
    expect(dialogOpen()).toBe(false);
    expect($("#update-modal").classList.contains("hidden")).toBe(true);
    await nav("settings");
    await clickSel("#btn-check-update");
    await settle(20);
    expect(toastText()).toContain("설치할 수 없습니다");
    expect($("#update-modal").classList.contains("hidden")).toBe(true);
  });
});

describe("E2E R1 B16: restore always confirms with what it changes", () => {
  it("names templates + 실제 발송 changes; cancel changes nothing", async () => {
    await bootApp(); // deliver_alerts: true, the default templates
    await nav("settings");
    const before = ctl.prefs.get("app_config");
    const input = $("#restore-file") as HTMLInputElement;
    const json = JSON.stringify({ app: "poncle-expiry", exported_at: "2026-06-30T18:20:00", history: [], config: {
      deliver_alerts: false, templates: [{ id: "mine", name: "내 템플릿", telecoms: [], statuses: [], body: "안녕하세요" }],
    } });
    Object.defineProperty(input, "files", { configurable: true, value: [new File([json], "b.json")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(20);
    expect(dialogOpen(), "no missing history, still asks").toBe(true);
    expect(dialogText()).toContain("2026-06-30 18:20");
    expect(dialogText()).toContain("실제 발송: 켜짐 → 꺼짐");
    expect(dialogText()).toMatch(/템플릿: \d+개 → \d+개/);
    await answerDialog(false);
    expect(ctl.prefs.get("app_config")).toBe(before);
    expect($("#s-deliver").classList.contains("on")).toBe(true);
  });
});

describe("E2E R1 D1: 이력 shows decoded text (no double escaping)", () => {
  it("'PS&amp;M' stored by an older version reads 'PS&M'", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([smsRec({ agency: "PS&amp;M", customer: "A&amp;B" })]));
    await bootApp();
    await nav("history");
    const text = $("#h-list").textContent ?? "";
    expect(text).toContain("PS&M");
    expect(text).toContain("A&B");
    expect(text).not.toContain("&amp;");
  });
});

describe("E2E R1 D2: a successful scan today with nobody due says so", () => {
  it("home and the dashboard 통신사별 분포 read '오늘 안내할 대상이 없습니다 (마지막 스캔 HH:MM)'", async () => {
    ctl.gwRows = [];
    await bootApp();
    await scan();
    expect($("#due-empty").textContent).toBe("오늘 안내할 대상이 없습니다 (마지막 스캔 09:00)");
    await nav("dashboard");
    await settle();
    const empties = Array.from(document.querySelectorAll("#dash-body .dash-empty")).map((e) => e.textContent);
    expect(empties).toContain("오늘 안내할 대상이 없습니다 (마지막 스캔 09:00)");
  });

  it("never scanned keeps the 'scan again' prompt", async () => {
    await bootApp();
    expect($("#due-empty").textContent).toContain("지금 다시 스캔");
  });
});

describe("E2E R1 D4: copying a number on Android 13+ doesn't stack a second notice", () => {
  it("SDK 33: no app toast", async () => {
    ctl.gwRows = [dueRow];
    ctl.sdkInt = 33;
    await bootApp();
    await lookupFor("홍길동");
    await clickSel("#lk-body .lk-copy");
    expect(ctl.clipboard).toEqual(["010-1111-2222"]);
    expect(toastText()).not.toContain("복사되었습니다");
  });

  it("older Android keeps the app's toast", async () => {
    ctl.gwRows = [dueRow];
    ctl.sdkInt = 30;
    await bootApp();
    await lookupFor("홍길동");
    await clickSel("#lk-body .lk-copy");
    expect(toastText()).toContain("번호가 복사되었습니다");
  });
});

describe("E2E R1 D5: 저장 after the leave-auto-save started the rescan says it rescans", () => {
  it("the rescan started by leaving 설정 is still running -> 저장 answers '다시 스캔'", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("#dday-chips [data-dday='30']");
    ctl.pendingGate = deferred();
    await nav("home"); // leaving 설정: auto-save + rescan (held in listPending)
    await settle(20);
    expect(ctl.pendingCalls).toBe(1);
    await nav("settings");
    await clickSel("#btn-save");
    expect(toastText()).toBe("저장했습니다 — 바뀐 기준으로 다시 스캔합니다");
    ctl.pendingGate.resolve();
    await settle(20);
  });
});

/* ---------------- Stage R2 (audit 2026-11-17 LOW, UI lane) ---------------- */
describe("E2E R2 L1: 설정 opened before the config loaded saves nothing", () => {
  it("tapping 설정 and back during boot keeps the stored 실제 발송/안내 시점", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, notify_offsets_days: [7] }));
    const gate = deferred();
    const getGate: NonNullable<typeof ctl.getGate> = { key: "app_config", gate };
    ctl.getGate = getGate;
    await import("../../src/main"); // module evaluated; boot() runs until the gated read
    for (let i = 0; i < 200 && !getGate.hit; i++) await flush();
    expect(getGate.hit, "boot is waiting on the config read").toBe(true);
    ($("#nav-settings") as HTMLButtonElement).click();
    await settle();
    ($("#nav-home") as HTMLButtonElement).click();
    await settle();
    ctl.getGate = null;
    gate.resolve();
    await settle(20);
    expect(cfgNow()).toMatchObject({ deliver_alerts: true, notify_offsets_days: [7] });
  });
});

describe("E2E R2 L3: a scan that runs past midnight is stored under its own day", () => {
  it("due_cache_date / clean date = the day the D-days were computed for", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    const gate = deferred();
    ctl.pendingGate = gate;
    ($("#btn-scan") as HTMLButtonElement).click();
    await settle();
    vi.setSystemTime(new Date("2026-07-04T00:00:30"));
    ctl.pendingGate = null;
    gate.resolve();
    await settle(20);
    expect(ctl.prefs.get("due_cache_date")).toBe("2026-07-03");
    expect(ctl.prefs.get("last_clean_scan_date")).toBe("2026-07-03");
  });
});

describe("E2E R2 L4: a cut-off (truncated) scan keeps the clean date and 미방문 cache", () => {
  it("shows the list but does not move the catch-up anchor or overwrite 미방문", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, page_size: 1 }));
    ctl.prefs.set("last_clean_scan_date", "2026-07-01");
    const unv = JSON.stringify([unvRow()]);
    ctl.prefs.set("unvisited_cache", unv);
    ctl.gwRows = [dueRow];
    ctl.openTotal = 0;
    await bootApp();
    await scan();
    expect(toastText()).toContain("일부만");
    expect(ctl.prefs.get("due_cache_date")).toBe("2026-07-03");
    expect(ctl.prefs.get("last_clean_scan_date")).toBe("2026-07-01");
    expect(ctl.prefs.get("unvisited_cache")).toBe(unv);
    warn.mockRestore();
  });
});

describe("E2E R2 L10: an 안내 시점 no chip shows is kept unless a chip is tapped", () => {
  it("[5] survives leaving 설정; tapping a chip then saves that chip", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, notify_offsets_days: [5] }));
    await bootApp();
    await nav("settings");
    await clickSel("#s-deliver"); // another setting changes -> auto-save runs
    await clickSel("#s-deliver");
    await nav("home");
    expect(cfgNow().notify_offsets_days).toEqual([5]);
    await nav("settings");
    await clickSel("#dday-chips [data-dday='7']");
    expect(cfgNow().notify_offsets_days).toEqual([7]);
  });
});

describe("E2E R2 L11: 조회 whose 미결 fetch failed blocks 요금제 유지 customers", () => {
  it("names the failure, blocks the 유심 card, keeps the 약정 card sendable", async () => {
    const usim: PoncleRow = { ...dueRow, openphone: "010-5555-6666", customer: "홍길동유심", openhowx: "유심신규" };
    ctl.gwRows = [dueRow, usim];
    ctl.pendingThrows = true;
    await bootApp();
    await lookupFor("홍길동");
    expect($("#lk-body").textContent).toContain("요금제유지 미결을 불러오지 못했습니다");
    const cards = Array.from(document.querySelectorAll("#lk-body .lk-card"));
    const card = (name: string) => cards.find((c) => c.querySelector(".lk-name")?.textContent === name)!;
    expect(card("홍길동유심").querySelector(".lk-send")).toBeNull();
    expect(card("홍길동유심").querySelector(".lk-degraded")).toBeTruthy();
    expect(card("홍길동").querySelector(".lk-send")).toBeTruthy();
  });

  it("a normal lookup shows no such notice", async () => {
    ctl.gwRows = [{ ...dueRow, openhowx: "유심신규" }];
    await bootApp();
    await lookupFor("홍길동");
    expect($("#lk-body").textContent).not.toContain("미결을 불러오지 못했습니다");
    expect($("#lk-body .lk-send")).toBeTruthy();
  });
});

describe("E2E R2 L14: logout shows the 로그인 banner and beats a probe in flight", () => {
  it("banner on; a late 'expired' probe answer does not overwrite 로그아웃됨", async () => {
    const gate = deferred();
    ctl.checkGate = gate; // the boot probe is stuck on the network
    await bootApp();
    await nav("settings");
    await clickSel("#btn-logout");
    expect($("#session-banner").classList.contains("hidden")).toBe(false);
    expect($("#session-state").textContent).toBe("로그아웃됨");
    ctl.checkOk = false;
    ctl.checkGate = null;
    gate.resolve();
    await settle();
    expect($("#session-state").textContent).toBe("로그아웃됨");
    expect($("#session-banner").classList.contains("hidden")).toBe(false);
  });
});

describe("E2E R2 L15: the status badge follows a restored session", () => {
  it("'세션만료' from a failed scan clears once a probe finds the session alive", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    ctl.openFail = true;
    await scan();
    expect($("#status-label").textContent).toBe("세션만료");
    ctl.openFail = false;
    ctl.checkOk = true;
    foreground();
    await settle();
    expect($("#status-label").textContent).toBe("대기중");
    expect($("#session-banner").classList.contains("hidden")).toBe(true);
  });
});

describe("E2E R2 L16: home search matches phone digits", () => {
  it("'01011112222' and '+82 10-1111-2222' find 010-1111-2222", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    const q = $("#due-query") as HTMLInputElement;
    for (const v of ["01011112222", "+82 10-1111-2222"]) {
      q.value = v;
      q.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      expect(document.querySelectorAll("#due-list .listcard").length, v).toBe(1);
    }
    q.value = "01099998888";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(document.querySelectorAll("#due-list .listcard").length).toBe(0);
  });
});

describe("E2E R2 L22: a restore that turns 실제 발송 ON says so and asks for the SMS permission", () => {
  it("notice dialog, then the permission request (denied -> 설정 열기 offer)", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: false }));
    ctl.smsPerm = false;
    await bootApp();
    await nav("settings");
    await restoreFile(JSON.stringify({ app: "poncle-expiry", exported_at: "2026-06-30T18:20:00", history: [], config: { deliver_alerts: true } }));
    expect(cfgNow().deliver_alerts).toBe(true);
    expect(dialogOpen()).toBe(true);
    expect(dialogText()).toContain("실제 문자가 나갑니다");
    expect($("#backup-msg").textContent).toContain("실제 발송이 켜졌습니다");
    await answerDialog(true);
    expect(ctl.smsPermCalls).toBe(1);
    expect(dialogText()).toContain("SMS 권한");
    await answerDialog(false);
  });

  it("a restore that keeps 실제 발송 as it was asks nothing more", async () => {
    await bootApp(); // deliver_alerts: true
    await nav("settings");
    await restoreFile(JSON.stringify({ app: "poncle-expiry", exported_at: "2026-06-30T18:20:00", history: [], config: { deliver_alerts: true } }));
    expect(dialogOpen()).toBe(false);
    expect(ctl.smsPermCalls).toBe(0);
  });
});

describe("E2E R2 L24: dashboard 임박 = unsent, D+N included, not counted again as 미방문", () => {
  it("a D+2 catch-up row is listed as D+2 and is not also a 미방문", async () => {
    const overdue = {
      id: "01077778888|2026-07-01", phone: "010-7777-8888", customer: "지난안내", opendate: "24-07-01", expiry_date: "2026-07-01",
      milestone_offset: -2, telecom: "KT", agency: "", openhow: "기변", plan: "", model: "", staff: "", already_sent: false, source: "term",
    };
    ctl.prefs.set("due_cache", JSON.stringify([overdue]));
    ctl.prefs.set("due_cache_date", "2026-07-03");
    ctl.prefs.set("unvisited_cache", JSON.stringify([overdue]));
    await bootApp();
    await nav("dashboard");
    await settle();
    const soon = $("#dash-body").textContent ?? "";
    expect(soon).toContain("지난안내");
    expect(soon).toContain("D+2");
    const nums = Array.from(document.querySelectorAll("#dash-body .dt-num")).map((n) => n.textContent);
    expect(nums).toEqual(["1", "1", "0"]); // 만료 예정 · 미발송 · 미방문 (not double counted)
  });
});

describe("E2E R2 L27: a send sheet still loading does not pop up on another screen", () => {
  it("navigating away while the sheet prepares drops it", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    const gate = deferred();
    ctl.getGate = { key: "sent_log", gate };
    ($("#due-list .btn-send") as HTMLButtonElement).click();
    await settle();
    await nav("settings");
    ctl.getGate = null;
    gate.resolve();
    await settle();
    expect($("#confirm-modal").classList.contains("hidden")).toBe(true);
  });
});

describe("E2E R2 L29: onboarding keeps a step's ✓ after going back", () => {
  it("permission granted -> 다음 -> back: still '✓'", async () => {
    ctl.prefs.delete("onboarded_v1");
    await bootApp();
    await clickSel("#onb-body button");
    expect($("#onb-body button").textContent).toContain("✓");
    await clickSel("#onb-next");
    expect(back()).toBe(true);
    await settle();
    expect($("#onb-body button").textContent).toContain("✓");
  });
});

describe("E2E R2 L31: an expanded 이력 card stays open across a result-poll redraw", () => {
  it("delivery result arrives while the 원문 is open -> still open", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    await sendFromHome("안내 원문입니다");
    await nav("history");
    await clickSel("#h-list .lc-tap");
    expect($("#h-list .lc-why").classList.contains("hidden")).toBe(false);
    ctl.smsResults = [{ id: "sms-1", status: "ok", at: "2026-07-03T09:00:05" }];
    foreground();
    await settle(20);
    expect(ctl.acked).toContain("sms-1");
    expect($("#h-list .lc-why").classList.contains("hidden")).toBe(false);
    expect($("#h-list .lc-why").textContent).toBe("안내 원문입니다");
  });
});

/* ---------------- R3: improvements + disputed items ---------------- */

describe("E2E R3 I7: a result that arrives while its record is being written waits (INFLIGHT), then the poller applies it", () => {
  it("not acked while in flight; the 5s poller applies the failure once the record exists", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    // Poller timers (5s / 10s) are captured; everything else runs for real.
    const realSetTimeout = window.setTimeout.bind(window);
    const pollTimers: Array<() => void> = [];
    const spy = vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 5_000 || ms === 10_000) { pollTimers.push(fn); return 0; }
      return realSetTimeout(fn, ms);
    }) as unknown as typeof window.setTimeout);
    try {
      const gate = deferred();
      ctl.setGate = { key: "sent_log", gate };
      ($("#due-list .btn-send") as HTMLButtonElement).click();
      await settle();
      ($("#confirm-text") as HTMLTextAreaElement).value = "안내";
      ($("#confirm-send") as HTMLButtonElement).click();
      await settle();
      expect(ctl.sms.calls.length).toBe(1); // handed off as sms-1, record write is blocked

      // The carrier failure lands NOW, before the record exists. (This app's own
      // reconcile — apps booted by earlier tests still listen on the document.)
      ctl.smsResults = [{ id: "sms-1", status: "fail", reason: "유심이 없습니다", at: "2026-07-03T09:00:05" }];
      const { reconcileSendResults } = await import("../../src/screens/send-results");
      await reconcileSendResults();
      await settle(20);
      expect(ctl.acked, "held while its record is not written").not.toContain("sms-1");
      expect(pollTimers.length, "no poll before the record exists").toBe(0);

      ctl.setGate = null;
      gate.resolve();
      await settle(20);
      expect(sentLog()[0]).toMatchObject({ sms_id: "sms-1", channel: "sms" });
      expect(pollTimers.length, "the poller is armed once the record exists").toBe(1);

      pollTimers.shift()!();
      await settle(20);
      expect(ctl.acked).toContain("sms-1");
      expect(sentLog()[0]).toMatchObject({ delivery: "failed", fail_reason: "유심이 없습니다" });
      expect(toastText()).toContain("홍길동");
      expect(pollTimers.length, "nothing left to poll").toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("E2E R3 I6: a test-send failure in the same batch as a real one", () => {
  it("names the customer and still reports the test failure", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, test_phone: "010-5555-6666" }));
    await bootApp();
    await scan();
    await sendFromHome(); // sms-1
    await nav("settings");
    await clickSel("#btn-test-sms"); // sms-2
    ctl.smsResults = [
      { id: "sms-1", status: "fail", reason: "유심이 없습니다", at: "2026-07-03T09:00:05" },
      { id: "sms-2", status: "fail", reason: "신호 없음", at: "2026-07-03T09:00:06" },
    ];
    foreground();
    await settle(20);
    expect(toastText()).toContain("홍길동");
    expect(toastText()).toContain("테스트 문자도 실패");
    expect($("#test-sms-msg").textContent).toBe("실패: 신호 없음");
  });
});

describe("E2E R3 I2: bulk-send notice before Android's 30-in-30-min confirm", () => {
  it("the 25th send within 30 min explains the system confirm once", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, test_phone: "010-5555-6666" }));
    await bootApp();
    await nav("settings");
    for (let i = 0; i < 24; i++) { ($("#btn-test-sms") as HTMLButtonElement).click(); await settle(3); }
    expect(dialogOpen()).toBe(false);
    await clickSel("#btn-test-sms");
    expect(dialogOpen()).toBe(true);
    expect(dialogText()).toContain("25건");
    expect(dialogText()).toContain("허용");
    await answerDialog(true);
    await clickSel("#btn-test-sms");
    expect(dialogOpen(), "once per burst").toBe(false);
  }, 30_000);
});

describe("E2E R3 I2: long texts count by SMS part (Android counts each part)", () => {
  it("the notice comes at the 5th send of a 5-part text, not the 25th send", async () => {
    ctl.gwRows = Array.from({ length: 6 }, (_, i) => ({
      ...dueRow, customer: `고객${i + 1}`, openphone: `010-2000-000${i + 1}`,
    }));
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true }));
    await bootApp();
    await scan();
    const longText = "안".repeat(300); // UCS-2, 67 per part -> 5 parts
    const sendNext = async (): Promise<void> => {
      ($("#due-list .btn-send:not(.resend)") as HTMLButtonElement).click();
      await settle();
      ($("#confirm-text") as HTMLTextAreaElement).value = longText;
      ($("#confirm-send") as HTMLButtonElement).click();
      await settle();
    };
    for (let i = 0; i < 4; i++) await sendNext(); // 20 parts
    expect(dialogOpen()).toBe(false);
    await sendNext(); // 25 parts
    expect(dialogOpen()).toBe(true);
    expect(dialogText()).toContain("25건(긴 문자 분할 포함)");
    expect(dialogText()).toContain("허용");
    await answerDialog(true);
    await sendNext();
    expect(dialogOpen(), "once per burst").toBe(false);
  }, 30_000);
});

describe("E2E R3 I3: catch-up capped notice", () => {
  it("a scan whose last clean scan is older than 14 days says so on home", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("last_clean_scan_date", "2026-06-10");
    await bootApp();
    expect($("#catchup-banner").classList.contains("hidden")).toBe(true);
    await scan();
    expect($("#catchup-banner").classList.contains("hidden")).toBe(false);
    expect($("#catchup-sub").textContent).toContain("6월 10일");
    expect($("#catchup-sub").textContent).toContain("23일");
    await scan(); // the clean date moved to today: gone
    expect($("#catchup-banner").classList.contains("hidden")).toBe(true);
  });
  it("a degraded 미결 scan keeps the notice and names the failing lookup", async () => {
    ctl.gwRows = [dueRow];
    ctl.prefs.set("last_clean_scan_date", "2026-06-10");
    ctl.pendingNetErr = true; // 미결 fetch fails -> degraded, the clean anchor stays
    await bootApp();
    ($("#btn-scan") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 1500)); // client retries with real backoff
    await settle(20);
    expect($("#degraded-banner").classList.contains("hidden")).toBe(false);
    expect($("#catchup-banner").classList.contains("hidden")).toBe(false);
    expect($("#catchup-sub").textContent).toContain("미결 조회 실패가 이어져");
    expect(ctl.prefs.get("last_clean_scan_date")).toBe("2026-06-10");
  });
});

describe("E2E R3 I1: first scan after upgrading from v1.2.16 catches up from last_scan_at", () => {
  it("only the legacy 'M/D HH:MM' label is stored -> it anchors the catch-up", async () => {
    ctl.gwRows = [dueRow];
    // v1.2.16 kept no due_cache_date / last_clean_scan_date, only the display label.
    ctl.prefs.set("last_scan_at", "6/1 09:30");
    await bootApp();
    await scan();
    // The anchor is 6/1 (32 days ago) -> past the 14-day window, which home names.
    expect($("#catchup-banner").classList.contains("hidden")).toBe(false);
    expect($("#catchup-sub").textContent).toContain("6월 1일");
  });
  it("a fresh install (no label) has no catch-up anchor and no notice", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    expect($("#catchup-banner").classList.contains("hidden")).toBe(true);
  });
});

describe("E2E R3 I5: 조회 when the server ignored the search field", () => {
  it("unrelated rows are not shown; the notice says the condition was not applied", async () => {
    ctl.gwRows = [dueRow, { ...dueRow, openphone: "010-3333-4444", customer: "김철수" }];
    await bootApp();
    await lookupFor("박영희");
    expect(document.querySelectorAll("#lk-body .lk-card").length).toBe(0);
    expect($("#lk-body").textContent).toContain("검색 조건이 적용되지 않았습니다");
  });
  it("rows that do contain the query are kept, others dropped", async () => {
    ctl.gwRows = [dueRow, { ...dueRow, openphone: "010-3333-4444", customer: "김철수" }];
    await bootApp();
    await lookupFor("홍길동");
    expect(document.querySelectorAll("#lk-body .lk-card").length).toBe(1);
    expect($("#lk-body").textContent).toContain("홍길동");
    expect($("#lk-body").textContent).not.toContain("김철수");
  });
});

describe("E2E R3 I8: variable chips insert the Korean token", () => {
  it("tapping {고객명} puts {고객명} into the 문구", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    await clickSel("#btn-tpl-new");
    const chip = Array.from(document.querySelectorAll<HTMLButtonElement>(".varchips .varchip")).find((b) => b.textContent === "{고객명}");
    expect(chip).toBeTruthy();
    chip!.click();
    expect(($("#te-body") as HTMLTextAreaElement).value).toBe("{고객명}");
  });
});

describe("E2E R3 I9: the restore summary counts the file's real sends", () => {
  it("names how many of the backup's records were real sends", async () => {
    await bootApp();
    await nav("settings");
    const backup = {
      app: "poncle-expiry", version: 1, exported_at: "2026-07-01T10:00:00", config: null,
      history: [smsRec(), smsRec({ phone: "010-2222-3333", channel: "record-only" })],
    };
    const input = $("#restore-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [new File([JSON.stringify(backup)], "b.json")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(20);
    expect(dialogText()).toContain("실제로 보낸 문자 1건");
    await answerDialog(false);
  });
  it("a template_schema 2 file restores its templates as they are (no defaults appended, L9)", async () => {
    await bootApp();
    await nav("settings");
    const userTpl = { id: "u1", name: "내 문구", body: "{고객명}님", telecoms: [], statuses: [] };
    // No keepdate_default_months: only the file's template_schema says it is 2단계.
    await restoreFile(JSON.stringify({
      app: "poncle-expiry", exported_at: "2026-06-30T18:20:00", template_schema: 2,
      history: [], config: { deliver_alerts: true, templates: [userTpl] },
    }));
    expect((cfgNow().templates as Array<{ id: string }>).map((t) => t.id)).toEqual(["u1"]);
  });
});

describe("E2E R3 I10: 이력 search waits for a pause in typing", () => {
  it("no redraw per key; the last query applies after the pause", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([
      smsRec(), smsRec({ phone: "010-3333-4444", customer: "김철수" }),
    ]));
    await bootApp();
    await nav("history");
    expect(document.querySelectorAll("#h-list .listcard").length).toBe(2);
    const q = $("#h-query") as HTMLInputElement;
    q.value = "김";
    q.dispatchEvent(new Event("input"));
    q.value = "김철수";
    q.dispatchEvent(new Event("input"));
    await settle();
    expect(document.querySelectorAll("#h-list .listcard").length, "not yet").toBe(2);
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(document.querySelectorAll("#h-list .listcard").length).toBe(1);
    expect($("#h-list").textContent).toContain("김철수");
  });
});

describe("E2E R3 I12: 설정 warns when the send log is large", () => {
  it("shows the size above 2 MB", async () => {
    const body = "가".repeat(1400); // ~4.2 KB per record in UTF-8
    ctl.prefs.set("sent_log", JSON.stringify(Array.from({ length: 600 }, (_, i) =>
      smsRec({ phone: `010-7${String(i).padStart(3, "0")}-0000`, body }))));
    await bootApp();
    await nav("settings");
    await settle();
    expect($("#history-size-msg").classList.contains("hidden")).toBe(false);
    expect($("#history-size-msg").textContent).toContain("MB");
  });
  it("silent for a normal log", async () => {
    ctl.prefs.set("sent_log", JSON.stringify([smsRec()]));
    await bootApp();
    await nav("settings");
    expect($("#history-size-msg").classList.contains("hidden")).toBe(true);
  });
});

describe("E2E R3 I13: sheets are dialogs that take and return focus", () => {
  it("the send sheet is role=dialog, focuses 취소 and gives focus back to the send button", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    await scan();
    expect($("#confirm-modal").getAttribute("role")).toBe("dialog");
    expect($("#confirm-modal").getAttribute("aria-modal")).toBe("true");
    const btn = $("#due-list .btn-send") as HTMLButtonElement;
    btn.focus();
    btn.click();
    await settle();
    expect(document.activeElement?.id).toBe("confirm-cancel");
    await clickSel("#confirm-cancel");
    expect(document.activeElement).toBe(btn);
  });
});

describe("E2E R3 U4: a save failure during restore is not reported as an unreadable file", () => {
  it("says the restore could not be saved", async () => {
    await bootApp();
    await nav("settings");
    ctl.failSetKeys.add("sent_log");
    await restoreFile(JSON.stringify({ app: "poncle-expiry", version: 1, exported_at: "", config: null, history: [smsRec()] }));
    expect($("#backup-msg").textContent).toContain("저장에 실패");
    expect($("#backup-msg").textContent).not.toContain("파일을 읽지 못했습니다");
    expect(toastText()).toContain("복원 중 저장에 실패");
  });
});

describe("E2E R3 U5: a scan that throws ends visibly", () => {
  it("badge and buttons leave '스캔 중', with an error toast", async () => {
    ctl.gwRows = [dueRow];
    await bootApp();
    ctl.failSetKeys.add("due_cache"); // cacheDueList throws after runScan answered
    await scan();
    expect($("#status-label").textContent).toBe("오류");
    const btn = $("#btn-scan") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).not.toContain("스캔 중");
    expect(toastText()).toContain("스캔 중 오류가 발생했습니다");
    ctl.failSetKeys.clear();
    await scan(); // and a retry works
    expect($("#status-label").textContent).toBe("대기중");
  });
});

describe("E2E R3 U6: a storage read failure at boot does not stop the app", () => {
  it("the update check still runs and a banner says what failed", async () => {
    ctl.failGetKeys.add("due_cache");
    await bootApp();
    expect(ctl.update.calls).toBe(1);
    expect($("#boot-error-banner").classList.contains("hidden")).toBe(false);
    expect($("#boot-error-sub").textContent).toContain("대상 목록");
  });
  it("unreadable settings are never overwritten with the defaults", async () => {
    ctl.prefs.set("app_config", JSON.stringify({ deliver_alerts: true, notify_offsets_days: [14] }));
    ctl.failGetKeys.add("app_config");
    await bootApp();
    expect(ctl.update.calls).toBe(1);
    expect($("#boot-error-sub").textContent).toContain("설정을 읽지 못해");
    await nav("settings");
    await nav("home"); // leave-auto-save
    await settle();
    expect(JSON.parse(ctl.prefs.get("app_config")!)).toEqual({ deliver_alerts: true, notify_offsets_days: [14] });
  });
});

describe("E2E R3 U7: template save failure keeps the editor", () => {
  it("a failed save says so and stays on the editor with the text", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    await clickSel("#btn-tpl-new");
    ($("#te-name") as HTMLInputElement).value = "새 문구";
    ($("#te-body") as HTMLTextAreaElement).value = "{고객명}님 안내";
    ctl.failSetKeys.add("app_config");
    await clickSel("#btn-te-save");
    expect(toastText()).toContain("템플릿을 저장하지 못했습니다");
    expect(shown("template-edit")).toBe(true);
    expect(($("#te-body") as HTMLTextAreaElement).value).toBe("{고객명}님 안내");
  });
  it("the edited template vanished meanwhile (e.g. a restore) -> saved as new, with a toast", async () => {
    await bootApp();
    await nav("settings");
    await clickSel("[data-nav=templates]");
    (document.querySelector("#tpl-list .tpl-card") as HTMLElement).click();
    await settle();
    expect(shown("template-edit")).toBe(true);
    // The list is replaced under the open editor (another path saved a new list).
    const { S } = await import("../../src/app/state");
    const editedId = S.CFG.templates[0].id;
    S.CFG = { ...S.CFG, templates: S.CFG.templates.slice(1) };
    ($("#te-body") as HTMLTextAreaElement).value = "{고객명}님 수정한 문구";
    await clickSel("#btn-te-save");
    expect(toastText()).toContain("새 템플릿으로 저장했습니다");
    const saved = cfgNow().templates as Array<{ id: string; body: string }>;
    const added = saved.find((t) => t.body === "{고객명}님 수정한 문구");
    expect(added).toBeTruthy();
    expect(added!.id).not.toBe(editedId);
  });
});

describe("E2E R3 U8: failed auto update checks back off", () => {
  it("a failure is not retried on every foreground; it is after the backoff, and success resets it", async () => {
    ctl.update.result = { available: false, url: "", version: "", notes: "", error: "HTTP 403" };
    await bootApp();
    expect(ctl.update.calls).toBe(1);
    foreground();
    await settle();
    expect(ctl.update.calls, "held by the backoff").toBe(1);
    vi.setSystemTime(new Date("2026-07-03T09:06:00")); // > 5 min
    foreground();
    await settle();
    expect(ctl.update.calls).toBe(2);
    vi.setSystemTime(new Date("2026-07-03T09:12:00")); // 6 min later, backoff is now 10 min
    foreground();
    await settle();
    expect(ctl.update.calls).toBe(2);
    // A manual check is never held back.
    ctl.update.result = { available: false, url: "", version: "", notes: "" };
    await nav("settings");
    await clickSel("#btn-check-update");
    expect(ctl.update.calls).toBe(3);
  });
});
