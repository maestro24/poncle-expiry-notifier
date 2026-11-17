/**
 * Stage 4a UI helpers (pure, no DOM): SMS length line (#61), clock-skew gate (#58),
 * 이력 paging (#59), template delete/undo (#54), exported-file cleanup (L6).
 */
import { describe, expect, it } from "vitest";
import { smsLengthLabel } from "../src/ui/sms-length";
import { CLOCK_SKEW_TITLE, evaluateClockSkew, serverNowIso } from "../src/ui/clock-skew";
import { clockSkewDays } from "../src/domain/plaindate";
import { HISTORY_PAGE, firstSendNote, historyCountLabel, historyPage } from "../src/ui/history-paging";
import { removeTemplate, restoreTemplateAt } from "../src/ui/template-undo";
import { isExportFileName, purgeExportFiles, type CacheFs } from "../src/ui/export-files";
import type { MessageTemplate } from "../src/domain/types";

describe("smsLengthLabel (#61)", () => {
  it("empty text -> no line", () => {
    expect(smsLengthLabel({ chars: 0, bytes: 0, segments: 0, lms: false })).toBe("");
  });
  it("a short message reads as 단문 with the 90-byte budget", () => {
    const s = smsLengthLabel({ chars: 20, bytes: 40, segments: 1, lms: false });
    expect(s).toContain("20자");
    expect(s).toContain("40/90바이트");
    expect(s).toContain("단문");
  });
  it("a long message says 장문(LMS) / 분할 N건", () => {
    const s = smsLengthLabel({ chars: 300, bytes: 600, segments: 5, lms: true });
    expect(s).toContain("300자");
    expect(s).toContain("600바이트");
    expect(s).toContain("장문(LMS)");
    expect(s).toContain("분할 5건");
  });
  it("accepts sender.smsLengthInfo's shape (kind / tooLong)", () => {
    expect(smsLengthLabel({ chars: 10, bytes: 20, segments: 1, kind: "SMS" })).toContain("단문");
    const s = smsLengthLabel({ chars: 2000, bytes: 4000, segments: 30, kind: "LMS", tooLong: true });
    expect(s).toContain("장문(LMS)");
    expect(s).toContain("한도");
  });
});

describe("evaluateClockSkew (#58)", () => {
  const now = new Date("2026-11-16T10:00:00");
  it("no server date yet -> unknown (never blocks)", () => {
    expect(evaluateClockSkew(null, now, () => 5)).toBeNull();
    expect(evaluateClockSkew("", now, () => 5)).toBeNull();
  });
  it("same day -> not blocked", () => {
    expect(evaluateClockSkew("2026-11-16T01:00:00Z", now, () => 0)).toEqual({ blocked: false, days: 0 });
  });
  it("one day or more either way -> blocked", () => {
    expect(evaluateClockSkew("2026-11-15T01:00:00Z", now, () => 1)?.blocked).toBe(true);
    expect(evaluateClockSkew("2026-11-20T01:00:00Z", now, () => -4)).toEqual({ blocked: true, days: 4 });
  });
  it("a helper that throws or returns NaN is 'unknown', not a block", () => {
    expect(evaluateClockSkew("x", now, () => Number.NaN)).toBeNull();
    expect(evaluateClockSkew("x", now, () => { throw new Error("bad"); })).toBeNull();
  });
  it("uses the agreed banner wording", () => {
    expect(CLOCK_SKEW_TITLE).toBe("휴대폰 날짜가 실제와 다릅니다 — 날짜/시간 자동 설정을 켜 주세요");
  });
});

describe("serverNowIso (#58: judge from the measured skew, not an aging server date)", () => {
  it("unknown skew -> null", () => {
    expect(serverNowIso(null, new Date())).toBeNull();
    expect(serverNowIso(Number.NaN, new Date())).toBeNull();
  });
  it("a correct clock seen two days ago is still correct now (no drift false positive)", () => {
    // Observed at 2026-11-14 with zero skew; the app is re-judged offline on 11-16.
    const later = new Date("2026-11-16T10:00:00");
    const iso = serverNowIso(0, later);
    expect(iso).toBe(later.toISOString());
    expect(evaluateClockSkew(iso, later, clockSkewDays)).toEqual({ blocked: false, days: 0 });
  });
  it("a phone 23h ahead (date off by one) is blocked with the real clockSkewDays", () => {
    // Korea Nov 16 10:00 (01:00Z); the phone's wall clock shows Nov 17 09:00.
    const phone = new Date(2026, 10, 17, 9, 0, 0);
    expect(evaluateClockSkew("2026-11-16T01:00:00Z", phone, clockSkewDays)).toEqual({ blocked: true, days: 1 });
  });
  it("a phone two days behind stays flagged", () => {
    const now = new Date("2026-11-16T10:00:00");
    const iso = serverNowIso(2 * 86_400_000 + 5_000, now);
    expect(evaluateClockSkew(iso, now, clockSkewDays)).toEqual({ blocked: true, days: 2 });
  });
});

describe("historyPage / historyCountLabel (#59)", () => {
  const rows = Array.from({ length: 450 }, (_, i) => i);
  it("shows the first page and says how many remain", () => {
    const p = historyPage(rows, HISTORY_PAGE);
    expect(p.visible).toHaveLength(HISTORY_PAGE);
    expect(p.total).toBe(450);
    expect(p.remaining).toBe(450 - HISTORY_PAGE);
  });
  it("never shows more than exist", () => {
    const p = historyPage(rows, 10_000);
    expect(p.visible).toHaveLength(450);
    expect(p.remaining).toBe(0);
  });
  it("the count label states the REAL total (no silent 1000 cap)", () => {
    expect(historyCountLabel(1500, 200)).toBe("총 1,500건 중 200건 표시");
    expect(historyCountLabel(12, 12)).toBe("12건");
    expect(historyCountLabel(0, 0)).toBe("");
  });
});

describe("template delete + undo (#54)", () => {
  const t = (id: string): MessageTemplate => ({ id, name: id, telecoms: [], statuses: [], body: id });
  const list = [t("a"), t("b"), t("c")];
  it("removeTemplate returns the new list, the removed template and its old index (input untouched)", () => {
    const r = removeTemplate(list, "b");
    expect(r?.list.map((x) => x.id)).toEqual(["a", "c"]);
    expect(r?.removed.id).toBe("b");
    expect(r?.index).toBe(1);
    expect(list).toHaveLength(3);
    expect(removeTemplate(list, "zz")).toBeNull();
  });
  it("restoreTemplateAt puts it back at its old position (clamped), once", () => {
    const r = removeTemplate(list, "b")!;
    expect(restoreTemplateAt(r.list, r.removed, r.index).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(restoreTemplateAt([t("a")], r.removed, 5).map((x) => x.id)).toEqual(["a", "b"]);
    expect(restoreTemplateAt(list, r.removed, 0).map((x) => x.id)).toEqual(["a", "b", "c"]); // already there
  });
});

describe("exported file cleanup (L6)", () => {
  it("recognizes only this app's export files", () => {
    expect(isExportFileName("poncle-history-2026-11-16.csv")).toBe(true);
    expect(isExportFileName("poncle-backup-2026-11-16.json")).toBe(true);
    expect(isExportFileName("other.json")).toBe(false);
    expect(isExportFileName("poncle-backup-2026-11-16.json.tmp")).toBe(false);
  });
  it("deletes leftover export files and tolerates a failing delete", async () => {
    const removed: string[] = [];
    const fs: CacheFs = {
      list: async () => ["poncle-history-2026-11-01.csv", "keep.txt", "poncle-backup-2026-11-02.json", "poncle-backup-2026-11-03.json"],
      remove: async (name) => {
        if (name.endsWith("03.json")) throw new Error("busy");
        removed.push(name);
      },
    };
    expect(await purgeExportFiles(fs)).toBe(2);
    expect(removed).toEqual(["poncle-history-2026-11-01.csv", "poncle-backup-2026-11-02.json"]);
  });
  it("a listing failure is not an error (nothing deleted)", async () => {
    const fs: CacheFs = { list: async () => { throw new Error("no dir"); }, remove: async () => {} };
    expect(await purgeExportFiles(fs)).toBe(0);
  });
});

describe("firstSendNote (#57 shown in 이력)", () => {
  it("a resent record shows '최초 발송 YYYY-MM-DD · N회'", () => {
    expect(firstSendNote({ sent_at: "2026-11-10T09:00:00", first_sent_at: "2026-10-01T10:00:00", send_count: 3 }))
      .toBe("최초 발송 2026-10-01 · 3회");
  });
  it("nothing for a single send, an old record without the fields, or junk values", () => {
    expect(firstSendNote({ sent_at: "2026-11-10T09:00:00", first_sent_at: "2026-11-10T09:00:00", send_count: 1 })).toBe("");
    expect(firstSendNote({ sent_at: "2026-11-10T09:00:00" })).toBe("");
    expect(firstSendNote({ sent_at: "x", first_sent_at: 5, send_count: "3" })).toBe("");
  });
  it("a count without a first date still says how many times", () => {
    expect(firstSendNote({ sent_at: "2026-11-10T09:00:00", send_count: 2 })).toBe("2회 발송");
  });
});

describe("applyRestoredExtras (#55: exclusions union + cohort merge into a real History)", () => {
  it("adds only the missing exclusions and merges the cohort by key", async () => {
    const { History } = await import("../src/domain/history");
    const { applyRestoredExtras, restoredExtrasNote } = await import("../src/ui/restore-extras");
    const map = new Map<string, string>();
    const h = new History({ get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); } });
    await h.setHandled("010-1111-2222", "2026-05-01", true);
    await h.saveCohort([{ phone: "010-1111-2222", expiry: "2026-05-01", informed: false, revisited: false, firstSeen: "2026-05-03" }]);
    const r = await applyRestoredExtras(h, {
      excluded: ["01011112222|2026-05-01", "01033334444|2026-06-01"],
      cohort: [
        { phone: "01011112222", expiry: "2026-05-01", informed: true, revisited: false, firstSeen: "2026-05-02" },
        { phone: "010-5555-6666", expiry: "2026-04-01", informed: false, revisited: true, firstSeen: "2026-04-01" },
      ],
    });
    expect(r).toEqual({ excludedAdded: 1, cohortRestored: 2 });
    expect(Array.from(await h.handledKeys()).sort()).toEqual(["01011112222|2026-05-01", "01033334444|2026-06-01"]);
    const cohort = await h.loadCohort();
    expect(cohort).toHaveLength(2);
    expect(cohort[0]).toMatchObject({ informed: true, firstSeen: "2026-05-02" });
    expect(restoredExtrasNote(r)).toBe(", 미방문 제외 1명 추가, 재방문 집계 2명");
    expect(restoredExtrasNote({ excludedAdded: 0, cohortRestored: 0 })).toBe("");
  });
});
