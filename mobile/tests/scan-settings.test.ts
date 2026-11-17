import { describe, expect, it } from "vitest";
import { scanSettingsAction, scanSignature } from "../src/domain/scan-settings";
import type { AppConfig } from "../src/domain/types";

const cfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    notify_offsets_days: [7, 0],
    default_term_months: 24,
    keepdate_default_months: 6,
    unvisited_lookback_months: 6,
    ...over,
  }) as AppConfig;

describe("scanSignature (#35)", () => {
  it("ignores offset order", () => {
    expect(scanSignature(cfg({ notify_offsets_days: [0, 7] }))).toBe(scanSignature(cfg()));
  });
  it("changes with 안내 시점, 약정 개월, 요금제 유지, 미방문 기간", () => {
    const base = scanSignature(cfg());
    expect(scanSignature(cfg({ notify_offsets_days: [3] }))).not.toBe(base);
    expect(scanSignature(cfg({ default_term_months: 36 }))).not.toBe(base);
    expect(scanSignature(cfg({ keepdate_default_months: 12 }))).not.toBe(base);
    expect(scanSignature(cfg({ unvisited_lookback_months: 12 }))).not.toBe(base);
  });
});

describe("scanSettingsAction (#35: auto-saved 설정/약정 기간 changes)", () => {
  const shown = scanSignature(cfg());
  const changed = scanSignature(cfg({ default_term_months: 36 }));
  it("does nothing when the list was built with the current settings", () => {
    expect(scanSettingsAction(shown, shown, "", { scanning: false, sessionOk: true })).toBe("none");
  });
  it("rescans with a live session", () => {
    expect(scanSettingsAction(changed, shown, "", { scanning: false, sessionOk: true })).toBe("rescan");
  });
  it("says 다음 스캔부터 without a session", () => {
    expect(scanSettingsAction(changed, shown, "", { scanning: false, sessionOk: false })).toBe("next-scan");
  });
  it("says the running scan won't include it", () => {
    expect(scanSettingsAction(changed, shown, "", { scanning: true, sessionOk: true })).toBe("after-running-scan");
  });
  it("tells the user once per changed signature", () => {
    expect(scanSettingsAction(changed, shown, changed, { scanning: false, sessionOk: false })).toBe("none");
    // ...but a live session still rescans even if a notice was shown earlier
    expect(scanSettingsAction(changed, shown, changed, { scanning: false, sessionOk: true })).toBe("rescan");
  });
});
