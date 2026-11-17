/**
 * Stage R1 UI helpers (pure, no DOM): empty-state copy (D2), the 미방문 기준일 note
 * (B7), the Android 13+ copy toast (D4), the restore summary (B16), the
 * clock-skew store guard (B10) and export-file
 * cleanup on the next export (B4).
 */
import { describe, expect, it, vi } from "vitest";
import { carrierEmptyText, dueEmptyText, lastScanClock, unvisitedBasisNote } from "../src/ui/empty-state";
import { androidMajorFromUa, systemShowsCopyToast } from "../src/ui/copy-toast";
import { restoreSummary } from "../src/ui/restore-summary";
import { withCohortGuard } from "../src/ui/clock-skew";
import { backupWasSaved, purgeExportFiles, type CacheFs } from "../src/ui/export-files";

describe("empty-state copy (D2)", () => {
  it("lastScanClock reads HH:MM out of the 'M/D HH:MM' label", () => {
    expect(lastScanClock("11/17 09:05")).toBe("09:05");
    expect(lastScanClock("")).toBe("");
    expect(lastScanClock("garbage")).toBe("");
  });

  it("a successful scan TODAY with no targets says so (not '스캔 결과가 없습니다')", () => {
    const t = dueEmptyText({ hasResults: false, scanDateIso: "2026-11-17", todayIso: "2026-11-17", lastScan: "11/17 09:05" });
    expect(t).toBe("오늘 안내할 대상이 없습니다 (마지막 스캔 09:05)");
  });

  it("never scanned / an older scan keeps the 'scan again' prompt", () => {
    expect(dueEmptyText({ hasResults: false, scanDateIso: "", todayIso: "2026-11-17", lastScan: "" })).toContain("지금 다시 스캔");
    expect(dueEmptyText({ hasResults: false, scanDateIso: "2026-11-16", todayIso: "2026-11-17", lastScan: "11/16 10:00" })).toContain("지금 다시 스캔");
  });

  it("rows exist but the filter hides them -> the filter message", () => {
    expect(dueEmptyText({ hasResults: true, scanDateIso: "2026-11-17", todayIso: "2026-11-17", lastScan: "" })).toBe("검색/필터에 맞는 대상이 없습니다.");
  });

  it("today without a usable label drops the time part", () => {
    expect(dueEmptyText({ hasResults: false, scanDateIso: "2026-11-17", todayIso: "2026-11-17", lastScan: "" })).toBe("오늘 안내할 대상이 없습니다");
  });

  it("dashboard 통신사별 분포 follows the same rule", () => {
    expect(carrierEmptyText("2026-11-17", "2026-11-17", "11/17 09:05")).toBe("오늘 안내할 대상이 없습니다 (마지막 스캔 09:05)");
    expect(carrierEmptyText("2026-11-10", "2026-11-17", "11/10 09:05")).toBe("스캔 결과가 없습니다");
  });
});

describe("unvisitedBasisNote (B7)", () => {
  it("today's clean scan -> plain basis line", () => {
    expect(unvisitedBasisNote("2026-11-17", "2026-11-17", 3)).toEqual({ text: "오늘 스캔 기준입니다", stale: false });
  });
  it("an older clean scan names the day and asks for a rescan", () => {
    const n = unvisitedBasisNote("2026-11-03", "2026-11-17", 3)!;
    expect(n.stale).toBe(true);
    expect(n.text).toContain("11월 3일 스캔 기준");
    expect(n.text).toContain("다시 스캔");
  });
  it("unknown date: a note only when there is something listed", () => {
    expect(unvisitedBasisNote("", "2026-11-17", 0)).toBeNull();
    expect(unvisitedBasisNote("", "2026-11-17", 2)!.stale).toBe(true);
  });
});

describe("copy toast on Android 13+ (D4)", () => {
  const ua = (v: string) => `Mozilla/5.0 (Linux; Android ${v}; SM-G981N Build/TP1A; wv) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36`;
  it("parses the Android major version from the WebView UA", () => {
    expect(androidMajorFromUa(ua("13"))).toBe(13);
    expect(androidMajorFromUa(ua("8.1.0"))).toBe(8);
    expect(androidMajorFromUa("Mozilla/5.0 (X11; Linux x86_64)")).toBeNull();
  });
  it("the native SDK level wins when known (33 = Android 13)", () => {
    expect(systemShowsCopyToast(33, ua("10"))).toBe(true);
    expect(systemShowsCopyToast(32, ua("13"))).toBe(false);
  });
  it("falls back to the UA, and to 'show our toast' when unknown", () => {
    expect(systemShowsCopyToast(undefined, ua("14"))).toBe(true);
    expect(systemShowsCopyToast(undefined, ua("12"))).toBe(false);
    expect(systemShowsCopyToast(null, "")).toBe(false);
  });
});

describe("restoreSummary (B16)", () => {
  const base = {
    exportedAt: "2026-11-10T14:05:00",
    backupHistory: 12,
    currentHistory: 10,
    missing: 0,
    templatesBefore: 3,
    templatesAfter: 3,
    templatesChanged: false,
    deliverBefore: true,
    deliverAfter: true,
  };
  it("always names the backup date, the history counts and asks", () => {
    const s = restoreSummary(base);
    expect(s.message).toContain("2026-11-10 14:05");
    expect(s.message).toContain("12건");
    expect(s.message).toContain("10건");
    expect(s.message).toContain("복원할까요");
    expect(s.okLabel).toBe("복원");
  });
  it("template replacement shows the count change", () => {
    const s = restoreSummary({ ...base, templatesAfter: 2, templatesChanged: true });
    expect(s.message).toContain("3개 → 2개");
  });
  it("실제 발송 turning OFF is spelled out", () => {
    const s = restoreSummary({ ...base, deliverAfter: false });
    expect(s.message).toContain("실제 발송: 켜짐 → 꺼짐");
  });
  it("unchanged 실제 발송 / templates say 그대로", () => {
    const s = restoreSummary(base);
    expect(s.message).toContain("템플릿: 그대로 (3개)");
    expect(s.message).toContain("실제 발송: 그대로 (켜짐)");
  });
  it("records this phone has but the file lacks -> N명 + '합쳐서 복원'", () => {
    const s = restoreSummary({ ...base, missing: 2 });
    expect(s.message).toContain("2명");
    expect(s.okLabel).toBe("합쳐서 복원");
  });
  it("a backup without settings says the settings stay", () => {
    const s = restoreSummary({ ...base, templatesAfter: null, deliverAfter: null });
    expect(s.message).toContain("설정·템플릿: 백업 파일에 없어 그대로 둡니다");
    expect(s.message).not.toContain("실제 발송:");
  });
  it("an unknown export date is said plainly", () => {
    expect(restoreSummary({ ...base, exportedAt: "" }).message).toContain("백업 날짜: 알 수 없음");
  });
});

describe("withCohortGuard (B10)", () => {
  it("drops cohort writes while the phone's date is wrong; reads pass through", async () => {
    let skewed = true;
    const saveCohort = vi.fn(async (_entries: unknown) => {});
    const store = { saveCohort, loadCohort: async () => [1, 2], name: "h" };
    const guarded = withCohortGuard(store, () => skewed);
    await guarded.saveCohort([] as never);
    expect(saveCohort).not.toHaveBeenCalled();
    expect(await guarded.loadCohort()).toEqual([1, 2]);
    skewed = false;
    await guarded.saveCohort([] as never);
    expect(saveCohort).toHaveBeenCalledTimes(1);
  });
});

describe("purgeExportFiles keep (B4: cleanup deferred to the next export)", () => {
  it("removes earlier export files but keeps the one being written", async () => {
    const removed: string[] = [];
    const fs: CacheFs = {
      list: async () => ["poncle-backup-2026-11-16.json", "poncle-backup-2026-11-17.json", "x.txt"],
      remove: async (n) => { removed.push(n); },
    };
    expect(await purgeExportFiles(fs, "poncle-backup-2026-11-17.json")).toBe(1);
    expect(removed).toEqual(["poncle-backup-2026-11-16.json"]);
  });
});

describe("backupWasSaved (B4: an ambiguous 'cancel' asks before recording the backup date)", () => {
  it("shared -> recorded without asking; failed -> never", async () => {
    const ask = vi.fn(async () => true);
    expect(await backupWasSaved("shared", ask)).toBe(true);
    expect(await backupWasSaved("failed", ask)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
  it("cancelled -> the user's answer decides (Quick Share / Bluetooth / 드라이브 저장)", async () => {
    expect(await backupWasSaved("cancelled", async () => true)).toBe(true);
    expect(await backupWasSaved("cancelled", async () => false)).toBe(false);
  });
});
