/**
 * User settings: defaults + validation + persistence. Port of backend/config.py.
 * The pure parts (DEFAULTS, deepMerge, migrate, withDefaults) are synchronous and
 * unit-tested; load/save wrap Capacitor Preferences (async, device-only storage).
 */
import { Preferences } from "@capacitor/preferences";
import { MILESTONE_SOURCES, STATUSES, TELECOMS, type AppConfig, type MessageTemplate } from "./types";

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

  // Daily scan time (24h HH:MM) from the PC version. Unused on the phone, which
  // scans only when the user taps 스캔 (or right after onboarding's login); kept so
  // backups stay compatible.
  run_time: "09:00",

  // Conditional outbound templates. Empty here: the built-in starters are seeded
  // once by seedDefaultTemplates, and staff manage them under 설정 > 발송 문구
  // 템플릿. When none match a customer the send sheet opens on 직접 입력.
  // Placeholders (sender.renderTemplate): {customer} {telecom} {model} {expiry}
  // {opendate} {when} {phone} {agency} {plan} {staff} {months} {years}.
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

/** Shared tail of both starter templates (매장 안내 + 연락처). */
const STORE_FOOTER = `방문 시 신분증만 지참해 주시면
편하게 도와드리겠습니다. 😊

👇 지금 바로 채팅으로 재고 및 상담 문의하기 👇
📞 친절상담: 010-9595-9505
🏠 찾아오시는 길: 경기도 광주시 중앙로 91 (역동, 경기광주 CGV 건물 앞 1층) 휴대폰 DC마트!

💬 KakaoTalk: 365dc
http://pf.kakao.com/_xizFan`;

/**
 * Built-in starter templates for 휴대폰 DC마트 (2단계 모델). Seeded once into a
 * user's config (see seedDefaultTemplates) — NOT part of DEFAULTS.templates, so the
 * user can freely edit/delete them. Selected by 시점(source): 요금제 유지 시점은
 * 템플릿1, 약정 만료 시점은 템플릿2. Bodies use {customer}/{months}/{years}/{when}
 * (sender.renderTemplate), so the 약정 개월 and 안내 시점 settings read correctly
 * (#60: no hard-coded '2년전' / '종료되어').
 */
export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    id: "default-keepdate",
    name: "요금제 유지 안내 (1단계)",
    telecoms: [], // 모든 통신사
    statuses: [], // 모든 상태 (요금제 유지는 유심/약정 대상 공통)
    sources: ["keepdate"], // 요금제 유지 시점에만
    body: `안녕하세요 {customer} 고객님 😊

{months}개월 전 휴대폰 개통 도와드렸던 경기광주 휴대폰 DC마트입니다.

현재 이용하고 계신 요금제보다 더 저렴한 요금제로 변경이 가능하여 안내해 드립니다.

더 저렴한 요금제로 변경하여 통신비를 절약하실 수 있으니, 편하신 시간에 매장에 방문하셔서 혜택을 받아보세요.

🎁 방문 고객 특별 혜택
✔ 더 낮은 요금제 + 데이터 완전무제한 프로모션 변경
✔ 유심비 전액 서비스
✔ 필름 무료 교체 부착

${STORE_FOOTER}`,
  },
  {
    id: "default-term",
    name: "약정 만료 안내 (2단계)",
    telecoms: [], // 모든 통신사
    statuses: ["신규", "번호이동", "기변"], // 약정 대상 (유심은 약정 없음)
    sources: ["term"], // 약정 만료 시점에만
    body: `안녕하세요 {customer} 고객님 😊

{years}년 전 휴대폰 개통 도와드렸던 경기광주 휴대폰 DC마트입니다.

현재 사용 중이신 약정의 만료 시점을 안내드립니다.
📅 약정 만료: {when}

시간 괜찮으실 때 매장 방문해주시면
✔ 요금제 변경
✔ 재약정 상담
편하게 도와드리겠습니다 😊


🎁 방문 고객 특별 혜택
✔ 케이스 무료 교체 서비스
✔ 필름 무료 교체 부착 서비스

${STORE_FOOTER}`,
  },
];

/**
 * Exact default bodies shipped in v1.2.9–v1.2.16, per default id. A stored default
 * whose body is byte-identical to one of these was never edited by the user and is
 * upgraded to the current wording (upgradeUntouchedDefaultTemplates); any other
 * body is the user's and is never touched.
 */
export const LEGACY_DEFAULT_TEMPLATE_BODIES: Readonly<Record<string, readonly string[]>> = {
  "default-keepdate": [`안녕하세요 {customer}고객님 😊

{months}개월 전 휴대폰 개통 도와드렸던 경기광주 휴대폰 DC마트입니다.

현재 이용하고 계신 요금제보다 더 저렴한 요금제로 변경이 가능하여 안내해 드립니다.

더 저렴한 요금제로 변경하여 통신비를 절약하실 수 있으니, 편하신 시간에 매장에 방문하셔서 혜택을 받아보세요.

🎁 방문 고객 특별 혜택
✔ 더 낮은 요금제 + 데이터 완전무제한 프로모션 변경
✔ 유심비 전액 서비스
✔ 필름 무료 교체 부착

${STORE_FOOTER}`],
  "default-term": [`안녕하세요 {customer}고객님 😊

2년전 휴대폰 개통 도와드렸던 경기광주 휴대폰 DC마트입니다.

현재 사용 중이신 약정이 종료되어 안내드립니다.

시간 괜찮으실 때 매장 방문해주시면
✔ 요금제 변경
✔ 재약정 상담
편하게 도와드리겠습니다 😊


🎁 방문 고객 특별 혜택
✔ 케이스 무료 교체 서비스
✔ 필름 무료 교체 부착 서비스

${STORE_FOOTER}`],
};

/**
 * #60/#61: replace the body of a default template the user never edited (body
 * byte-identical to a legacy default) with the current default body. Name and
 * conditions are kept (the user may have changed only those); user templates and
 * edited bodies are returned unchanged. Pure: returns a new array.
 */
export function upgradeUntouchedDefaultTemplates(templates: readonly MessageTemplate[]): MessageTemplate[] {
  return templates.map((t) => {
    const legacy = Object.prototype.hasOwnProperty.call(LEGACY_DEFAULT_TEMPLATE_BODIES, t.id)
      ? LEGACY_DEFAULT_TEMPLATE_BODIES[t.id]
      : undefined;
    if (!legacy || !legacy.includes(t.body)) return t;
    const current = DEFAULT_TEMPLATES.find((d) => d.id === t.id);
    return current && current.body !== t.body ? { ...t, body: current.body } : t;
  });
}

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
  const cfg = migrate(merged as unknown as Record<string, unknown>) as unknown as AppConfig;
  // Untouched old default wording -> current wording (#60/#61); edits never touched.
  return Array.isArray(cfg.templates) ? { ...cfg, templates: upgradeUntouchedDefaultTemplates(cfg.templates) } : cfg;
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

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Telecom codes of the v1.1.0 app (TELECOMS was ["KT","SK","LG"] until v1.1.1) and
 *  their main-line display today. Never migrated in stored configs, so an old backup
 *  can still carry them; mapped before the allowed check so such a template is kept
 *  instead of silently dropped on restore. */
const LEGACY_TELECOMS: Readonly<Record<string, string>> = { SK: "SK텔레콤", LG: "LG유플러스" };

/**
 * One untrusted condition group -> its allowed values, deduped (audit L20). null when
 * the group named values but none is allowed: emptied, it would turn into a wildcard
 * ('모든 …') and match customers the template never matched before. `legacy` renames
 * retired codes before the check.
 */
function conditionGroup(
  v: unknown,
  allowed: readonly string[],
  legacy: Readonly<Record<string, string>> = {},
): string[] | null {
  const given = strArray(v).map((x) => (Object.prototype.hasOwnProperty.call(legacy, x) ? legacy[x] : x));
  const kept = Array.from(new Set(given.filter((x) => allowed.includes(x))));
  return given.length > 0 && kept.length === 0 ? null : kept;
}

/** Coerce one untrusted (backup-file) template; null when id/body are unusable or a
 *  condition group holds only unknown values (L20). */
function sanitizeTemplate(raw: unknown): MessageTemplate | null {
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.body !== "string") return null;
  const telecoms = conditionGroup(raw.telecoms, TELECOMS, LEGACY_TELECOMS);
  const statuses = conditionGroup(raw.statuses, STATUSES);
  const sources = "sources" in raw ? conditionGroup(raw.sources, MILESTONE_SOURCES) : [];
  if (telecoms === null || statuses === null || sources === null) return null;
  const t: MessageTemplate = {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "",
    telecoms: telecoms as MessageTemplate["telecoms"],
    statuses: statuses as MessageTemplate["statuses"],
    body: raw.body,
  };
  if ("sources" in raw) t.sources = sources as MessageTemplate["sources"];
  return t;
}

/** Sanitized templates with unique ids (the first of a repeated id wins — L20). */
function sanitizeTemplateList(raw: unknown): MessageTemplate[] {
  const seen = new Set<string>();
  const out: MessageTemplate[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const t = sanitizeTemplate(r);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/** Template list schema written into backups (I9/L9): 2 = the 2단계 (source-routed)
 *  templates. A backup carrying it is never mistaken for a pre-v2 list. */
export const TEMPLATE_SCHEMA_VERSION = 2;

/** True for a config written by the 2단계 app (v1.2.9+): keepdate_default_months
 *  arrived together with the v2 template seed and is always saved since (withDefaults
 *  fills it), so its presence tells a v2 template list from a pre-v2 one (L9). */
export function isV2Config(raw: unknown): boolean {
  return isObject(raw) && Object.prototype.hasOwnProperty.call(raw, "keepdate_default_months");
}

/**
 * The same template migration seedDefaultTemplates applies at upgrade, for a
 * template list coming from a RESTORED backup (the seed flag is already set, so a
 * restore would otherwise resurrect the retired v1 defaults). A pre-v2 list — it
 * still has a retired default id, or none of its templates carries `sources` —
 * gets the retired/default ids dropped and the current defaults appended. A v2
 * list is kept as-is so the user's edits/deletions of defaults are respected.
 * Malformed entries are dropped and ids deduped (L20). `fromV2Config` (isV2Config of
 * the backup's config) marks a list from the 2단계 app: then only a retired id makes
 * it pre-v2, so source-less user templates of a user who deleted the defaults don't
 * bring them back (L9). Pure.
 */
export function migrateTemplateList(raw: unknown, fromV2Config = false): MessageTemplate[] {
  const list = sanitizeTemplateList(raw);
  const retired = new Set(RETIRED_DEFAULT_TEMPLATE_IDS);
  const sourceless = !fromV2Config && list.length > 0 && !list.some((t) => Array.isArray(t.sources));
  const preV2 = list.some((t) => retired.has(t.id)) || sourceless;
  if (!preV2) return upgradeUntouchedDefaultTemplates(list);
  const drop = new Set([...RETIRED_DEFAULT_TEMPLATE_IDS, ...DEFAULT_TEMPLATES.map((t) => t.id)]);
  const defaults = DEFAULT_TEMPLATES.map((t) => ({
    ...t, telecoms: [...t.telecoms], statuses: [...t.statuses], sources: [...(t.sources ?? [])],
  }));
  return [...list.filter((t) => !drop.has(t.id)), ...defaults];
}

/** A restored backup config ready to save: templates migrated (see
 *  migrateTemplateList) and THIS device's test_phone kept (never the backup's). A
 *  setting the backup does not carry keeps THIS phone's value — an older backup
 *  missing a key must not reset it to DEFAULTS on save (audit L7). `fromV2Config`
 *  defaults to isV2Config(restored). */
export function prepareRestoredConfig(
  restored: AppConfig,
  current: AppConfig,
  fromV2Config: boolean = isV2Config(restored),
): AppConfig {
  const { test_phone: _theirs, ...rest } = restored as AppConfig & Record<string, unknown>;
  const { test_phone: _mine, ...currentRest } = current as AppConfig & Record<string, unknown>;
  // A backup without a templates key keeps the current templates (never wipes them).
  const templates = "templates" in restored ? migrateTemplateList(restored.templates, fromV2Config) : current.templates;
  const out: AppConfig = { ...(currentRest as AppConfig), ...(rest as AppConfig), templates };
  if (current.test_phone) out.test_phone = current.test_phone;
  return out;
}

/** Allowed range for each 약정 기간 input (#39). Out-of-range values made every
 *  약정 대상 look 무약정 (e.g. -24) or pushed expiries decades out (240). */
export const TERM_LIMITS = {
  default_term_months: { min: 1, max: 60, label: "약정 개월" },
  keepdate_default_months: { min: 0, max: 60, label: "요금제 유지 기본 개월" },
  unvisited_lookback_months: { min: 0, max: 36, label: "미방문 추적 기간" },
} as const;
export type TermField = keyof typeof TERM_LIMITS;

export interface ClampResult {
  value: number;
  /** Inline message for the user when the input was corrected; null when it was fine. */
  message: string | null;
}

/** Validate one 약정 기간 input: whole months within TERM_LIMITS. Blank/non-numeric
 *  keeps `current`; out of range is clamped to the nearest bound. Pure. */
export function clampTermInput(field: TermField, raw: string, current: number): ClampResult {
  const { min, max, label } = TERM_LIMITS[field];
  const text = String(raw ?? "").trim();
  const n = text === "" ? NaN : Number(text);
  if (!Number.isFinite(n)) {
    return { value: current, message: `${label}은 숫자로 입력하세요 (${min}~${max}개월)` };
  }
  const whole = Math.trunc(n);
  if (whole < min || whole > max) {
    const value = whole < min ? min : max;
    return { value, message: `${label}은 ${min}~${max}개월 사이로 입력하세요 — ${value}개월로 맞췄습니다` };
  }
  return { value: whole, message: null };
}

/** Korean names of the settings a restore can skip, for the summary toast. A
 *  null-prototype map: an inherited name ('constructor') is never a label (L21) —
 *  prefer configFieldLabel, which also covers unknown keys. */
export const CONFIG_FIELD_LABEL: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    deliver_alerts: "실제 발송",
    notify_offsets_days: "안내 시점",
    default_term_months: "약정 개월",
    keepdate_default_months: "요금제 유지 개월",
    unvisited_lookback_months: "미방문 추적 기간",
    templates: "발송 문구 템플릿",
    poncle_base_url: "폰클 주소",
    run_time: "스캔 시각",
    use_server_date_filter: "서버 날짜 필터",
    date_window_days: "조회 날짜 범위",
    scan_lookback_months: "스캔 조회 기간",
    page_size: "한 번에 가져올 건수",
    request_timeout_sec: "요청 제한 시간",
  }),
);

/** Shown for a skipped key that is not a known setting (never the raw key). */
export const UNKNOWN_CONFIG_FIELD_LABEL = "알 수 없는 설정 항목";

/** Korean label of a restore-skipped setting key (own keys only — L21). */
export function configFieldLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(CONFIG_FIELD_LABEL, key) ? CONFIG_FIELD_LABEL[key] : UNKNOWN_CONFIG_FIELD_LABEL;
}

/** The skipped keys as unique Korean labels, in order (for the restore toast). */
export function droppedFieldLabels(dropped: readonly string[]): string[] {
  return Array.from(new Set(dropped.map(configFieldLabel)));
}

/** Host allowlist for a restored/entered poncle_base_url — must be poncle.co.kr
 *  (or a subdomain). Blocks a malicious/typo backup from repointing native traffic
 *  (session cookie, scan requests) at an arbitrary host. */
export function isAllowedPoncleBaseUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    return h === "poncle.co.kr" || h.endsWith(".poncle.co.kr");
  } catch {
    return false;
  }
}

const isInt = (v: unknown, min: number, max: number): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Type check per known setting. A field failing its check is dropped from a
 *  restored backup (the phone keeps its own value) instead of being applied as-is:
 *  deliver_alerts:"false" is truthy, a non-array list crashes `.map`. */
const FIELD_CHECKS: Readonly<Record<string, (v: unknown) => boolean>> = {
  deliver_alerts: (v) => typeof v === "boolean",
  use_server_date_filter: (v) => typeof v === "boolean",
  notify_offsets_days: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => isInt(x, 0, 365)),
  default_term_months: (v) => isInt(v, TERM_LIMITS.default_term_months.min, TERM_LIMITS.default_term_months.max),
  keepdate_default_months: (v) => isInt(v, TERM_LIMITS.keepdate_default_months.min, TERM_LIMITS.keepdate_default_months.max),
  unvisited_lookback_months: (v) => isInt(v, TERM_LIMITS.unvisited_lookback_months.min, TERM_LIMITS.unvisited_lookback_months.max),
  date_window_days: (v) => isInt(v, 0, 365),
  scan_lookback_months: (v) => isInt(v, 1, 600),
  page_size: (v) => isInt(v, 1, 1000),
  request_timeout_sec: (v) => isInt(v, 1, 600),
  run_time: (v) => typeof v === "string",
  // Allowed host only (audit L8): a disallowed URL is skipped AND reported.
  poncle_base_url: (v) => isAllowedPoncleBaseUrl(v),
  templates: (v) => Array.isArray(v),
};

/** Keys that would reach an object's prototype when assigned (never restored). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export interface RestoredConfigCheck {
  /** The fields that passed their type check (unknown keys pass through untouched). */
  valid: Partial<AppConfig> & Record<string, unknown>;
  /** Keys whose value had the wrong type/range and were left out. */
  dropped: string[];
}

/** Field-by-field type validation of an untrusted (backup-file) config (#41). Pure. */
export function validateRestoredConfig(raw: unknown): RestoredConfigCheck {
  if (!isObject(raw)) return { valid: {}, dropped: [] };
  const valid: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    // Own keys only (L4): an inherited name ("constructor", "__proto__") must never
    // resolve to an Object.prototype member, and those keys never reach the result.
    if (UNSAFE_KEYS.has(k)) { dropped.push(k); continue; }
    const check = Object.prototype.hasOwnProperty.call(FIELD_CHECKS, k) ? FIELD_CHECKS[k] : undefined;
    if (check && !check(v)) dropped.push(k);
    else valid[k] = v;
  }
  return { valid: valid as RestoredConfigCheck["valid"], dropped };
}

/** Options for restoreConfig. */
export interface RestoreConfigOptions {
  /** The backup's template_schema (parseBackup; 0 = not recorded, pre-v1.2.17). */
  templateSchema?: number;
}

/** A restored backup config ready to save: type-validated (#41), templates migrated
 *  and test_phone kept local (prepareRestoredConfig). Every dropped field keeps
 *  THIS phone's current value. A backup that records TEMPLATE_SCHEMA_VERSION >= 2
 *  is trusted as a 2단계 template list outright (I9/L9); otherwise the config's own
 *  v2 marker decides. Pure. */
export function restoreConfig(
  raw: unknown,
  current: AppConfig,
  opts: RestoreConfigOptions = {},
): { config: AppConfig; dropped: string[] } {
  const { valid, dropped } = validateRestoredConfig(raw);
  // The v2 marker is read from the raw backup (a wrong-typed value still dates it).
  const fromV2 = (opts.templateSchema ?? 0) >= 2 || isV2Config(raw);
  const out = prepareRestoredConfig(valid as AppConfig, current, fromV2) as AppConfig & Record<string, unknown>;
  const cur = current as AppConfig & Record<string, unknown>;
  for (const k of dropped) {
    if (k in cur) out[k] = cur[k];
    else delete out[k];
  }
  return { config: out, dropped };
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
