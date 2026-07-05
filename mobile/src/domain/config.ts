/**
 * User settings: defaults + validation + persistence. Port of backend/config.py.
 * The pure parts (DEFAULTS, deepMerge, migrate, withDefaults) are synchronous and
 * unit-tested; load/save wrap Capacitor Preferences (async, device-only storage).
 */
import { Preferences } from "@capacitor/preferences";
import type { AppConfig, MessageTemplate } from "./types";

const CONFIG_KEY = "app_config";
/** One-shot guard so the built-in starter templates are seeded only once. */
const DEFAULT_TEMPLATES_SEEDED_KEY = "default_templates_seeded_v1";

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

/**
 * Built-in starter templates for 휴대폰 DC마트. Seeded once into a user's config
 * (see seedDefaultTemplates) — NOT part of DEFAULTS.templates, so the user can
 * freely edit/delete them without them reappearing. Bodies use the {customer},
 * {months}, {years} placeholders (see notifier.renderMessage).
 */
export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    id: "default-usim",
    name: "유심신규/유심MNP 전용 템플릿",
    // 통신사 무관 (유심 개통은 2년 약정이 아니라 빅3 포함 여부와 무관). 상태로만 구분.
    telecoms: [],
    statuses: ["유심신규", "유심MNP"],
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
    id: "default-newmnp",
    name: "신규/번호이동/기변 전용 템플릿",
    telecoms: [], // 통신사 상관 없음
    statuses: ["신규", "번호이동", "기변"],
    body: `안녕하세요 {customer}고객님 😊

{years}년전 휴대폰 개통 도와드렸던 경기광주 휴대폰 DC마트입니다.

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
  const have = new Set((cfg.templates ?? []).map((t) => t.id));
  const add = DEFAULT_TEMPLATES.filter((t) => !have.has(t.id));
  if (add.length) await saveConfig({ ...cfg, templates: [...cfg.templates, ...add] });
  await Preferences.set({ key: DEFAULT_TEMPLATES_SEEDED_KEY, value: "1" });
}
