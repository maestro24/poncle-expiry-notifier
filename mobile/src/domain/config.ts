/**
 * User settings: defaults + validation + persistence. Port of backend/config.py.
 * The pure parts (DEFAULTS, deepMerge, migrate, withDefaults) are synchronous and
 * unit-tested; load/save wrap Capacitor Preferences (async, device-only storage).
 */
import { Preferences } from "@capacitor/preferences";
import type { AppConfig } from "./types";

const CONFIG_KEY = "app_config";

export const DEFAULTS: AppConfig = {
  poncle_base_url: "https://m.poncle.co.kr",

  // 기변 / 신규            -> default_term_months (표준, 보통 24)
  // 그 외 (번호이동 / 유심신규 / 유심MNP ...) -> 거래처(agencytitle)마다:
  //     agency_term_months[<거래처명>] if set, else nonstandard_term_months.
  default_term_months: 24,
  nonstandard_term_months: 6,
  agency_term_months: {},

  // Days BEFORE expiry to alert on. 0 == the expiry day itself.
  notify_offsets_days: [0],

  // Daily scan time (24h HH:MM, local). Foreground-only for now (scan on open).
  run_time: "09:00",

  // Outbound message sent TO the customer. Two templates, chosen by 개통유형 the
  // same way the term is. Placeholders: {customer} {telecom} {model} {expiry}
  // {opendate} {when} (also: {phone} {agency} {plan} {staff}).
  message_template:
    "안녕하세요 {customer}님. 사용 중이신 {telecom} 휴대폰({model})의 " +
    "2년 약정이 {expiry}에 만료됩니다. 기기변경/요금제 상담 원하시면 " +
    "편하게 연락 주세요.",
  message_template_nonstandard:
    "안녕하세요 {customer}님. {telecom}({model}) 약정이 {expiry}에 " +
    "만료됩니다. 재약정/번호이동/요금제 상담 원하시면 편하게 연락 주세요.",

  // Master switch for ACTUALLY sending the SMS. When false, "알림 보내기" only
  // records the send into 발송 이력 (staff can track handled customers).
  deliver_alerts: false,

  // Scraping efficiency / safety knobs.
  use_server_date_filter: true,
  date_window_days: 3,
  scan_lookback_months: 40,
  page_size: 100,
  request_timeout_sec: 20,
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `over` onto a deep copy of `base` (arrays/scalars replace). */
export function deepMerge<T>(base: T, over: unknown): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  if (!isObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (isObject(v) && isObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (Array.isArray(v)) {
      out[k] = [...v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

// The old PC internal-alert template; detect an un-customized old file so we can
// upgrade it to the customer-facing default.
const OLD_DEFAULT_TEMPLATE =
  "[약정만료] {customer}님 ({phone}) 2년 약정 만료 {when}. " +
  "개통 {opendate} · {telecom} · {agency}";

/** Drop removed keys and upgrade un-customized old defaults. */
export function migrate(cfg: Record<string, unknown>): Record<string, unknown> {
  delete cfg["channels"];
  delete cfg["term_overrides"];
  delete cfg["skip_zero_term"];
  // PC-only keys that have no meaning on the phone app.
  delete cfg["run_on_startup"];
  delete cfg["autostart_enabled"];
  delete cfg["auto_check_updates"];
  delete cfg["phone_remote_enabled"];
  if (cfg["message_template"] === OLD_DEFAULT_TEMPLATE) {
    cfg["message_template"] = DEFAULTS.message_template;
  }
  return cfg;
}

/** Merge stored settings over defaults and migrate. Pure; no I/O. */
export function withDefaults(raw: unknown): AppConfig {
  const merged = deepMerge(DEFAULTS, isObject(raw) ? raw : {});
  return migrate(merged as unknown as Record<string, unknown>) as unknown as AppConfig;
}

/** Load current settings (defaults merged with stored JSON). */
export async function loadConfig(): Promise<AppConfig> {
  const { value } = await Preferences.get({ key: CONFIG_KEY });
  if (!value) {
    await saveConfig(DEFAULTS);
    return withDefaults({});
  }
  try {
    return withDefaults(JSON.parse(value));
  } catch {
    await saveConfig(DEFAULTS);
    return withDefaults({});
  }
}

/** Persist full settings. */
export async function saveConfig(settings: Partial<AppConfig>): Promise<AppConfig> {
  const merged = withDefaults(settings);
  await Preferences.set({ key: CONFIG_KEY, value: JSON.stringify(merged) });
  return merged;
}

/** Merge a patch into the saved settings and return the new full settings. */
export async function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  const next = deepMerge(current, patch) as AppConfig;
  return saveConfig(next);
}
