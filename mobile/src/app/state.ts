/**
 * Shared app state: one object (no hidden copies) for the loaded config, the home
 * due list and the scan/session/navigation flags several screens read and write.
 * Screen-local state (조회 결과, 이력 탭, 템플릿 편집 …) stays in its screen module.
 */
import { DEFAULTS } from "../domain/config";
import { History, preferencesKV } from "../domain/history";
import type { AppConfig, DueItem } from "../domain/types";
import * as adapters from "../native/adapters";
import { resolveDurableKV, routeHistoryKV } from "./history-kv";

export type Screen = "home" | "dashboard" | "lookup" | "history" | "settings" | "terms" | "templates" | "template-edit";
/** Phoncle session as last established by an authoritative probe (not cookie presence). */
export type SessionView = "none" | "probing" | "ok" | "expired" | "unknown";

/** The send log goes to the native durable (commit) store when this build has one
 *  (L43, contract K1); everything else — and the web build — uses Preferences. */
export const history = new History(routeHistoryKV(preferencesKV(), resolveDurableKV(adapters)));

export interface AppState {
  CFG: AppConfig;
  RESULTS: DueItem[];
  LAST_SCAN: string;
  /** ISO date of the scan behind RESULTS ("" = unknown / pre-upgrade cache). */
  SCAN_DATE: string;
  SESSION: SessionView;
  /** A scan is in flight and owns the session/error banner. */
  SCANNING: boolean;
  /** Bumped whenever a scan starts: a session probe begun before that discards its
   *  (stale) answer instead of overriding the scan's banner state. */
  SESSION_EPOCH: number;
  /** The last successful scan's 요금제유지 미결 fetch failed (degraded to empty). */
  PENDING_DEGRADED: boolean;
  /** The screen on show. */
  CURRENT: Screen;
  /** scanSignature of the settings the shown list was built with ("" until boot). */
  SCAN_SIG: string;
  /** Boot could not read the saved settings (U6): CFG holds DEFAULTS, so nothing may
   *  write it back over the user's real settings until a restore (or restart) fixes it. */
  CONFIG_READ_FAILED: boolean;
  /** Home notice from the last scan whose catch-up hit its cap (I3); "" = none. */
  CATCHUP_NOTICE: string;
}

export const S: AppState = {
  CFG: { ...DEFAULTS },
  RESULTS: [],
  LAST_SCAN: "",
  SCAN_DATE: "",
  SESSION: "unknown",
  SCANNING: false,
  SESSION_EPOCH: 0,
  PENDING_DEGRADED: false,
  CURRENT: "home",
  SCAN_SIG: "",
  CONFIG_READ_FAILED: false,
  CATCHUP_NOTICE: "",
};

/** Message for a settings write refused while the saved settings are unreadable (U6). */
export const CONFIG_READ_FAILED_MESSAGE = "저장된 설정을 읽지 못해 변경 내용을 저장하지 않았습니다 — 앱을 다시 시작해 주세요";
