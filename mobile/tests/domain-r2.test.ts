/**
 * Stage R2 (re-audit LOW items, docs/audit-2026-11-17.md '### LOW') — domain lane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cohortStats, updateCohort, type CohortEntry } from "../src/domain/cohort";
import {
  CONFIG_FIELD_LABEL, DEFAULTS, DEFAULT_TEMPLATES, configFieldLabel, droppedFieldLabels, migrateTemplateList,
  restoreConfig, validateRestoredConfig, withDefaults,
} from "../src/domain/config";
import { sentTrend } from "../src/domain/dashboard";
import { buildBackup, mergeCohort, parseBackup } from "../src/domain/export";
import { SentIndex, type SentRecord } from "../src/domain/history";
import { buildLookupResults, lookupToDueItem } from "../src/domain/lookup";
import { makeDate } from "../src/domain/plaindate";
import { isValidKrMobile, normalizeKrMobile, renderTemplate } from "../src/domain/sender";
import type { AppConfig, DueItem, PoncleRow } from "../src/domain/types";
import {
  UPDATE_CHECK_TIMEOUT_MS, checkForUpdate, isTrustedApkUrl, parseVersion, pickAndroidUpdate, type GhRelease,
} from "../src/domain/updater";

const TODAY = makeDate(2026, 7, 3);
const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over });
const item = (over: Partial<DueItem> = {}): DueItem => ({
  id: "", phone: "010-1111-2222", customer: "홍길동", opendate: "24-06-01", expiry_date: "2026-06-01",
  milestone_offset: 0, telecom: "KT", agency: "", openhow: "기변", plan: "", model: "", staff: "",
  already_sent: false, source: "term", ...over,
});
const rec = (over: Partial<SentRecord> = {}): SentRecord => ({
  phone: "010-1111-2222", customer: "고객", opendate: "24-06-01", expiry_date: "2026-06-01",
  milestone_offset: 0, telecom: "KT", agency: "", plan: "", model: "", openhow: "기변", staff: "",
  channel: "sms", sent_at: "2026-06-01T09:00:00", ...over,
});

/* ---------------- L5 cohort dedupe per contract (phone|opendate) ---------------- */
describe("L5 cohort: a changed 약정 개월 does not double-count one contract", () => {
  it("the same contract under a new expiry replaces the old entry (facts carried over)", () => {
    const first = updateCohort([], [item()], [], new Set(["01011112222|2026-06-01"]), TODAY, 90);
    expect(first).toHaveLength(1);
    expect(first[0].opendate).toBe("2024-06-01");
    // 약정 개월 changed: same 개통, different expiry
    const second = updateCohort(first, [item({ expiry_date: "2026-06-15" })], [], new Set(), TODAY, 90);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ expiry: "2026-06-15", informed: true, firstSeen: first[0].firstSeen });
    expect(cohortStats(second, TODAY, 90).total).toBe(1);
  });
  it("a legacy entry (no opendate) is backfilled on an exact match, then merged later", () => {
    const legacy: CohortEntry[] = [
      { phone: "010-1111-2222", expiry: "2026-06-01", informed: false, revisited: false, firstSeen: "2026-06-02" },
    ];
    const a = updateCohort(legacy, [item()], [], new Set(), TODAY, 90);
    expect(a[0].opendate).toBe("2024-06-01");
    const b = updateCohort(a, [item({ expiry_date: "2026-06-20" })], [], new Set(), TODAY, 90);
    expect(b.map((e) => e.expiry)).toEqual(["2026-06-20"]);
    expect(b[0].firstSeen).toBe("2026-06-02");
  });
  it("different contracts of one phone stay separate", () => {
    const prev: CohortEntry[] = [
      { phone: "010-1111-2222", expiry: "2026-05-01", opendate: "2024-05-01", informed: false, revisited: false, firstSeen: "2026-05-02" },
    ];
    const out = updateCohort(prev, [item()], [], new Set(), TODAY, 90);
    expect(out).toHaveLength(2);
  });
  it("backup restore keeps a valid opendate and drops a malformed one", () => {
    const b = buildBackup(cfg(), [], "x", {
      cohort: [
        { phone: "010-1", expiry: "2026-06-01", opendate: "2024-06-01", informed: true, revisited: false, firstSeen: "2026-06-02" },
        { phone: "010-2", expiry: "2026-06-01", opendate: "junk" as string, informed: true, revisited: false, firstSeen: "2026-06-02" },
      ],
    });
    const parsed = parseBackup(JSON.stringify(b))!;
    expect(parsed.cohort[0].opendate).toBe("2024-06-01");
    expect(parsed.cohort[1]).not.toHaveProperty("opendate");
    // merge keeps it too
    expect(mergeCohort([], parsed.cohort)[0].opendate).toBe("2024-06-01");
  });
});

/* ---------------- L6 cohort informed lowered after a failed send ---------------- */
describe("L6 cohort: informed drops back when the send was reported failed", () => {
  const prev: CohortEntry[] = [
    { phone: "010-1111-2222", expiry: "2026-06-01", informed: true, revisited: false, firstSeen: "2026-06-02" },
  ];
  const key = "01011112222|2026-06-01";
  it("a failed key without a real send -> informed false", () => {
    const out = updateCohort(prev, [item()], [], new Set(), TODAY, 90, [], new Set([key]));
    expect(out[0].informed).toBe(false);
  });
  it("a real send for the key keeps informed true", () => {
    const out = updateCohort(prev, [item()], [], new Set([key]), TODAY, 90, [], new Set([key]));
    expect(out[0].informed).toBe(true);
  });
  it("no failure info -> unchanged (OR as before)", () => {
    expect(updateCohort(prev, [item()], [], new Set(), TODAY, 90)[0].informed).toBe(true);
  });
  it("SentIndex.failedKeySet lists exact keys whose record failed", () => {
    const idx = new SentIndex([
      rec({ delivery: "failed" }),
      rec({ phone: "010-3333-4444", delivery: "delivered" }),
      rec({ phone: "010-5555-6666", channel: "record-only" }),
    ]);
    expect(Array.from(idx.failedKeySet())).toEqual([key]);
  });
});

/* ---------------- L7 missing keys keep the phone's value ---------------- */
describe("L7 restoring an old backup without a key keeps this phone's value", () => {
  it("keepdate_default_months absent from the backup -> current 3, not DEFAULTS 6", () => {
    const current = cfg({ keepdate_default_months: 3, unvisited_lookback_months: 12 });
    const { config } = restoreConfig({ deliver_alerts: true }, current);
    expect(config.keepdate_default_months).toBe(3);
    expect(config.unvisited_lookback_months).toBe(12);
    expect(config.deliver_alerts).toBe(true);
    expect(withDefaults(config).keepdate_default_months).toBe(3); // survives saveConfig's merge
  });
});

/* ---------------- L8 disallowed base URL is reported + kept ---------------- */
describe("L8 a disallowed poncle_base_url is reported as skipped and the current one kept", () => {
  const current = cfg({ poncle_base_url: "https://m.poncle.co.kr" });
  it("validateRestoredConfig drops it", () => {
    expect(validateRestoredConfig({ poncle_base_url: "https://evil.example.com" }).dropped).toEqual(["poncle_base_url"]);
    expect(validateRestoredConfig({ poncle_base_url: "https://m.poncle.co.kr" }).dropped).toEqual([]);
  });
  it("through parseBackup -> restoreConfig: dropped lists it, value is this phone's", () => {
    const parsed = parseBackup(JSON.stringify({
      app: "poncle-expiry", history: [], config: { poncle_base_url: "https://evil.example.com", deliver_alerts: true },
    }))!;
    const { config, dropped } = restoreConfig(parsed.config, current);
    expect(dropped).toContain("poncle_base_url");
    expect(config.poncle_base_url).toBe("https://m.poncle.co.kr");
    expect(config.deliver_alerts).toBe(true);
  });
});

/* ---------------- L9 a v2 backup's deliberately deleted defaults stay deleted ---------------- */
describe("L9 a v2-era backup with only source-less user templates is not treated as pre-v2", () => {
  const mine = { id: "tpl_mine", name: "내 문구", telecoms: [], statuses: [], body: "x" };
  it("config carries keepdate_default_months (v2 marker) -> defaults not resurrected", () => {
    const { config } = restoreConfig({ keepdate_default_months: 6, templates: [mine] }, cfg());
    expect(config.templates.map((t) => t.id)).toEqual(["tpl_mine"]);
  });
  it("a v1 backup (no v2 marker) still gets the v2 defaults", () => {
    const { config } = restoreConfig({ templates: [mine] }, cfg());
    expect(config.templates.map((t) => t.id)).toEqual(["tpl_mine", ...DEFAULT_TEMPLATES.map((t) => t.id)]);
  });
  it("retired v1 ids are still migrated even with the marker", () => {
    const { config } = restoreConfig(
      { keepdate_default_months: 6, templates: [{ ...mine, id: "default-usim" }] }, cfg(),
    );
    expect(config.templates.map((t) => t.id)).not.toContain("default-usim");
  });
});

/* ---------------- L20 template condition values + id dedupe ---------------- */
describe("L20 restored templates: allowed condition values only, unique ids", () => {
  const base = { name: "n", body: "b", telecoms: [], statuses: [], sources: ["term"] };
  it("unknown values are dropped; known ones deduped", () => {
    const out = migrateTemplateList([
      { ...base, id: "a", telecoms: ["KT", "KT", "XX"], statuses: ["신규", "XYZ"], sources: ["term", "term"] },
    ]);
    expect(out[0]).toMatchObject({ telecoms: ["KT"], statuses: ["신규"], sources: ["term"] });
  });
  it("a condition group made only of unknown values drops the template (would widen to '모든')", () => {
    const out = migrateTemplateList([{ ...base, id: "a" }, { ...base, id: "b", sources: ["XYZ"] }]);
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });
  it("duplicate ids keep the first", () => {
    const out = migrateTemplateList([{ ...base, id: "dup", body: "1" }, { ...base, id: "dup", body: "2" }]);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("1");
  });
});

/* ---------------- L21 skipped-setting labels ---------------- */
describe("L21 skipped settings are named in Korean, never as code", () => {
  it("CONFIG_FIELD_LABEL has no inherited members", () => {
    expect(CONFIG_FIELD_LABEL["constructor"]).toBeUndefined();
    expect(CONFIG_FIELD_LABEL["toString"]).toBeUndefined();
  });
  it("configFieldLabel: every checked setting has a Korean label; others a generic one", () => {
    for (const k of ["page_size", "use_server_date_filter", "date_window_days", "scan_lookback_months", "request_timeout_sec", "poncle_base_url"])
      expect(configFieldLabel(k), k).toMatch(/[가-힣]/);
    expect(configFieldLabel("constructor")).not.toMatch(/function|constructor/);
    expect(configFieldLabel("constructor")).toMatch(/[가-힣]/);
  });
  it("droppedFieldLabels dedupes", () => {
    const labels = droppedFieldLabels(["deliver_alerts", "constructor", "__proto__", "prototype"]);
    expect(labels).toEqual(["실제 발송", configFieldLabel("constructor")]);
  });
});

/* ---------------- L18 / K3 one Korean mobile rule ---------------- */
describe("L18/K3 normalizeKrMobile matches the native normalizeNumber", () => {
  it("'+' followed by a non-82 country code is not a Korean mobile", () => {
    expect(normalizeKrMobile("+01012345678")).toBe("");
    expect(normalizeKrMobile("+1 010-1234-5678")).toBe("");
    expect(isValidKrMobile("+01012345678")).toBe(false);
  });
  it("+82 forms still normalize (leading 1 -> 010, kept 0)", () => {
    expect(normalizeKrMobile("+82 10-1234-5678")).toBe("01012345678");
    expect(normalizeKrMobile(" +82-010-1234-5678")).toBe("01012345678");
    expect(normalizeKrMobile("+821012345678")).toBe("01012345678");
    expect(normalizeKrMobile("821012345678")).toBe("01012345678");
    expect(normalizeKrMobile("010-1234-5678")).toBe("01012345678");
  });
});

/* ---------------- L23 {offset} recomputed from expiry vs today ---------------- */
describe("L23 {offset} = days until expiry as of today (same on every screen)", () => {
  it("a home item with a stale cached offset renders today's value", () => {
    expect(renderTemplate(item({ expiry_date: "2026-07-08", milestone_offset: -5 }), "{offset}", TODAY)).toBe("5");
  });
  it("a 미방문 item (D+ count stored positive) renders the same signed value", () => {
    expect(renderTemplate(item({ expiry_date: "2026-07-01", milestone_offset: 2 }), "{offset}", TODAY)).toBe("-2");
  });
});

/* ---------------- L25 resends counted on their own days ---------------- */
describe("L25 sentTrend counts every real send on the day it was sent", () => {
  const byDate = (rows: Parameters<typeof sentTrend>[0]) =>
    Object.fromEntries(sentTrend(rows, TODAY, 7).map((d) => [d.dateIso, d.count]));
  it("a pending resend's prev_sent chain stays on its own day", () => {
    const r = { sent_at: "2026-07-01T09:00:00", channel: "sms", prev_sent: { sent_at: "2026-06-29T09:00:00", prev_sent: { sent_at: "2026-06-28T09:00:00" } } };
    const d = byDate([r]);
    expect(d["2026-06-28"]).toBe(1);
    expect(d["2026-06-29"]).toBe(1);
    expect(d["2026-07-01"]).toBe(1);
  });
  it("a confirmed resend (chain dropped) still counts its first send via first_sent_at", () => {
    const r = { sent_at: "2026-07-01T09:00:00", channel: "sms", delivery: "delivered", first_sent_at: "2026-06-29T09:00:00", send_count: 2 };
    const d = byDate([r]);
    expect(d["2026-06-29"]).toBe(1);
    expect(d["2026-07-01"]).toBe(1);
  });
  it("first_sent_at is not double counted when it is already in the chain", () => {
    const r = {
      sent_at: "2026-07-01T09:00:00", channel: "sms", first_sent_at: "2026-06-29T09:00:00", send_count: 2,
      prev_sent: { sent_at: "2026-06-29T09:00:00" },
    };
    expect(sentTrend([r], TODAY, 7).reduce((a, x) => a + x.count, 0)).toBe(2);
  });
  it("a plain single send counts once; failed/practice still excluded", () => {
    const d = byDate([
      { sent_at: "2026-07-02T09:00:00", channel: "sms" },
      { sent_at: "2026-07-02T10:00:00", channel: "sms", delivery: "failed" },
      { sent_at: "2026-07-02T11:00:00", channel: "record-only" },
    ]);
    expect(d["2026-07-02"]).toBe(1);
  });
});

/* ---------------- L32 / L33 / L34 updater ---------------- */
describe("L32 checkForUpdate times out", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("a hanging request resolves with an error after the timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => { /* never settles */ });
    }));
    const p = checkForUpdate("1.0.0");
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS + 10);
    const u = await p;
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(15000);
    expect(u.available).toBe(false);
    expect(u.error).toBeTruthy();
    expect(signal?.aborted).toBe(true);
  });
});

const GH = "https://github.com/maestro24/poncle-expiry-notifier/releases/download";
const release = (tag: string, over: Partial<GhRelease> = {}): GhRelease => ({
  tag_name: tag, body: "notes", assets: [{ name: "app.apk", browser_download_url: `${GH}/${tag}/app.apk` }], ...over,
});

describe("L33 an unparseable current version never offers an update", () => {
  it("'1.2.17-gecko' -> available:false", () => {
    const u = pickAndroidUpdate([release("android-v1.2.18")], "1.2.17-gecko");
    expect(u.available).toBe(false);
  });
  it("parseVersion rejects non-numeric / empty parts", () => {
    expect(parseVersion("1.2.17-gecko")).toBeNull();
    expect(parseVersion("1..2")).toBeNull();
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });
});

describe("L34 prerelease skipped; only this repo's release downloads trusted", () => {
  it("a newer prerelease is ignored", () => {
    const u = pickAndroidUpdate([release("android-v2.0.0", { prerelease: true }), release("android-v1.1.0")], "1.0.0");
    expect(u.available).toBe(true);
    expect(u.version).toBe("1.1.0");
  });
  it("isTrustedApkUrl requires https://github.com/<repo>/releases/download/", () => {
    expect(isTrustedApkUrl(`${GH}/android-v1/app.apk`)).toBe(true);
    expect(isTrustedApkUrl("https://github.com/someone/else/releases/download/t/a.apk")).toBe(false);
    expect(isTrustedApkUrl("https://objects.githubusercontent.com/x/a.apk")).toBe(false);
    expect(isTrustedApkUrl(`${GH.replace("https:", "http:")}/t/a.apk`)).toBe(false);
    expect(isTrustedApkUrl("https://github.com/maestro24/poncle-expiry-notifier/archive/a.apk")).toBe(false);
    expect(isTrustedApkUrl("https://user@github.com/maestro24/poncle-expiry-notifier/releases/download/t/a.apk")).toBe(false);
    expect(isTrustedApkUrl("https://github.com/o/r/releases/download/t/a.apk", "o/r")).toBe(true);
  });
});

/* ---------------- L11 lookup degraded when the 미결 fetch failed ---------------- */
describe("L11 조회: a failed 미결 fetch marks 유심 results degraded", () => {
  const row = (phone: string, openhowx: string): PoncleRow => ({
    openphone: phone, customer: "고객", opendate: "26-01-01", openhowx, telecomx: "KT",
  });
  const rows = [row("010-1111-0001", "유심신규"), row("010-1111-0002", "기변")];
  it("pendingDegraded -> 유심(요금제 유지) result degraded, 약정 대상 not", () => {
    const out = buildLookupResults(rows, cfg(), TODAY, 30, new Map(), [], true);
    const usim = out.find((r) => r.phone === "010-1111-0001")!;
    const term = out.find((r) => r.phone === "010-1111-0002")!;
    expect(usim.degraded).toBe(true);
    expect(term.degraded).toBeUndefined();
    expect(lookupToDueItem(usim).degraded).toBe(true);
    expect(lookupToDueItem(term).degraded).toBeUndefined();
  });
  it("a clean fetch leaves results undegraded", () => {
    const out = buildLookupResults(rows, cfg(), TODAY, 30, new Map(), []);
    expect(out.every((r) => r.degraded === undefined)).toBe(true);
  });
});
