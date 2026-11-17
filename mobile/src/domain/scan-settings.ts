import type { AppConfig } from "./types";

/** The settings that shape a scan's result list (안내 시점 + 개월 수). */
export function scanSignature(c: AppConfig): string {
  const offsets = (c.notify_offsets_days || []).map(Number).sort((a, b) => a - b);
  return JSON.stringify([offsets, c.default_term_months, c.keepdate_default_months, c.unvisited_lookback_months]);
}

/** What to do after scan-shaping settings were saved (#35):
 *  - "none": the shown list already uses them (or the user was already told)
 *  - "rescan": a live session exists -> rescan now with the new settings
 *  - "after-running-scan": a scan is running with the old settings
 *  - "next-scan": no live session -> they apply from the next scan */
export type ScanSettingsAction = "none" | "rescan" | "after-running-scan" | "next-scan";

export function scanSettingsAction(
  currentSig: string,
  shownSig: string,
  notifiedSig: string,
  state: { scanning: boolean; sessionOk: boolean },
): ScanSettingsAction {
  if (currentSig === shownSig) return "none";
  if (!state.scanning && state.sessionOk) return "rescan";
  if (currentSig === notifiedSig) return "none";
  return state.scanning ? "after-running-scan" : "next-scan";
}
