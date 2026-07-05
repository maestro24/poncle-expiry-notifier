/**
 * User settings: defaults + validation + persistence. Port of backend/config.py.
 * The pure parts (DEFAULTS, deepMerge, migrate, withDefaults) are synchronous and
 * unit-tested; load/save wrap Capacitor Preferences (async, device-only storage).
 */
import { Preferences } from "@capacitor/preferences";
import type { AppConfig, MessageTemplate } from "./types";

const CONFIG_KEY = "app_config";
/** One-shot guard so the built-in starter templates are seeded only once. Bumped
 *  to v2 for the 2단계 개편 (retire v1 templates, install source-routed ones). */
const DEFAULT_TEMPLATES_SEEDED_KEY = "default_templates_seeded_v2";

export const DEFAULTS: AppConfig = {
  poncle_base_url: "https://m.poncle.co.kr",

  // 약정 개월 (2단계): 약정 대상(신규/번호이동/기변)의 약정 만료 = 개통 + 이 개월.
  default_term_months: 24,
  // 요금제 유지 기본 개월 (1단계): 폰클에 요금제유지 미결이 없을 때 개통 + 이 개월.
  keepdate_default_months: 6,

  // Days BEFORE expiry to alert on. 0 == the expiry day itself.
  notify_offsets_days: [0],

  // Daily scan time (24h HH:MM, local). Foreground-only for now (scan on open).
  run_time: "09:00",

  // Conditional outbound templates. Empty by default: staff creates templates
  // (with telecom/상태 conditions) under 설정 > 발송 문구 템플릿. When none match
  // a customer the app prompts to add one. Placeholders: {customer} {telecom}
  // {model} {expiry} {opendate} {when} {phone} {agency} {plan} {staff}.
  templates: [],

  // Master switch for ACTUALLY sending the SMS. When false, "알림 보내기" only
  // records the send into 발송 이력 (staff can track handled customers).
  deliver_alerts: false,

  // 만료 후 매장에 다시 오지 않은 고객(미방문)을 몇 개월까지 추적할지. 기본 6개월.
  // 이 기간만큼 스캔의 개통일 조회 범위도 과거로 넓혀 최근 만료자를 다시 산출한다.
  unvisited_lookback_months: 6,

  // Scraping efficiency / safety knobs.
  use_server_date_filter: true,
  date_window_days: 3,
  scan_lookback_months: 40,
  page_size: 100,
  request_timeout_sec: 20,
};

/** v1 default template ids, retired by the 2단계 개편 (removed on the v2 seed). */
export const RETIRED_DEFAULT_TEMPLATE_IDS = ["default-usim", "default-newmnp"];

/**
 * Built-in starter templates for 휴대폰 DC마트 (2단계 모델). Seeded once into a
 * user's config (see seedDefaultTemplates) — NOT part of DEFAULTS.templates, so the
 * user can freely edit/delete them. Selected by 시점(source): 요금제 유지 시점은
 * 템플릿1, 약정 만료 시점은 템플릿2. Bodies use {customer}/{months} placeholders
 * (see notifier.renderMessage).
 */
export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    id: "default-keepdate",
    name: "요금제 유지 안내 (1단계)",
    telecoms: [], // 모든 통신사
    statuses: [], // 모든 상태 (요금제 유지는 유심/약정 대상 공통)
    sources: ["keepdate"], // 요금제 유지 시점에만
    body: `안녕하세요 {customer}고객님 😊

{months}개월 전 휴대폰 개통 도와드렸던 경기광주 휴대폰 DC마트입니다.

현재 이용하고 계신 요금제보다 더 저렴한 요금제로 변경이 가능하여 안내해 드립니다.

더 저렴한 요금제로 변경하여 통신비를 절약하실 수 있으니, 편하신 시간에 매장에 방문하셔서 혜택을 받아보세요.

🎁 방문 고객 특별 혜택
✔ 더 낮은 요금제 + 데이터 완전무제한 프로모션 변경
✔ 유심비 전액 서비스
✔ 필름 무료 교체 부착

방문 시 신분증만 지참해 주시면
편하게 도와드리겠습니다. 😊

👇 지금 바로 채팅으로 재고 및 상담 문의하기 👇
📞 친절상담: 010-9595-9505
🏠 찾아오시는 길: 경기도 광주시 중앙로 91 (역동, 경기광주 CGV 건물 앞 1층) 휴대폰 DC마트!

💬 KakaoTalk: 365dc
http://pf.kakao.com/_xizFan`,
  },
  {
    id: "default-term",
    name: "약정 만료 안내 (2단계)",
    telecoms: [], // 모든 통신사
    statuses: ["신규", "번호이동", "기변"], // 약정 대상 (유심은 약정 없음)
    sources: ["term"], // 약정 만료 시점에만
    body: `안녕하세요 {customer}고객님 😊

2년전 휴대폰 개통 도와드렸던 경기광주 휴대폰 DC마트입니다.

현재 사용 중이신 약정이 종료되어 안내드립니다.

시간 괜찮으실 때 매장 방문해주시면
✔ 요금제 변경
✔ 재약정 상담
편하게 도와드리겠습니다 😊


🎁 방문 고객 특별 혜택
✔ 케이스 무료 교체 서비스
✔ 필름 무료 교체 부착 서비스

방문 시 신분증만 지참해 주시면
편하게 도와드리겠습니다. 😊

👇 지금 바로 채팅으로 재고 및 상담 문의하기 👇
📞 친절상담: 010-9595-9505
🏠 찾아오시는 길: 경기도 광주시 중앙로 91 (역동, 경기광주 CGV 건물 앞 1층) 휴대폰 DC마트!

💬 KakaoTalk: 365dc
http://pf.kakao.com/_xizFan`,
  },
];

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

/** Drop removed keys (including the retired fixed-template pair). */
export function migrate(cfg: Record<string, unknown>): Record<string, unknown> {
  delete cfg["channels"];
  delete cfg["term_overrides"];
  delete cfg["skip_zero_term"];
  // PC-only keys that have no meaning on the phone app.
  delete cfg["run_on_startup"];
  delete cfg["autostart_enabled"];
  delete cfg["auto_check_updates"];
  delete cfg["phone_remote_enabled"];
  // Retired: the old fixed standard/nonstandard templates (replaced by
  // conditional templates). Dropped on upgrade; staff re-creates templates.
  delete cfg["message_template"];
  delete cfg["message_template_nonstandard"];
  // Retired in the 2단계 개편: 거래처별 약정 오버라이드 + 비표준 약정 개월.
  delete cfg["agency_term_months"];
  delete cfg["nonstandard_term_months"];
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

/**
 * One-time seed of the built-in starter templates (DEFAULT_TEMPLATES) into the
 * saved config. Guarded by a Preferences flag so it runs once: it appends only
 * the default ids the user doesn't already have, so existing users get them on
 * upgrade and fresh installs get them on first launch. After it runs the user
 * fully controls the templates — edits and deletes are never undone.
 */
export async function seedDefaultTemplates(): Promise<void> {
  const { value } = await Preferences.get({ key: DEFAULT_TEMPLATES_SEEDED_KEY });
  if (value) return;
  const cfg = await loadConfig();
  // Drop the retired v1 defaults + any existing new-default ids (clean replace),
  // keep the user's own templates, then append the current defaults.
  const drop = new Set([...RETIRED_DEFAULT_TEMPLATE_IDS, ...DEFAULT_TEMPLATES.map((t) => t.id)]);
  const kept = (cfg.templates ?? []).filter((t) => !drop.has(t.id));
  await saveConfig({ ...cfg, templates: [...kept, ...DEFAULT_TEMPLATES] });
  await Preferences.set({ key: DEFAULT_TEMPLATES_SEEDED_KEY, value: "1" });
}
