/** Shared domain types for the contract-expiry logic. */

/** A raw row from Poncle's /open/listOpen JSON. Fields are loosely typed because
 *  Poncle returns strings/numbers inconsistently; the domain layer coerces. */
export type PoncleRow = Record<string, unknown>;

/**
 * Telecom carriers a template condition can target. These are Poncle's exact
 * telecomx display values (the 10 distinct carriers seen in the open list), each
 * an independent option: KT/SK/LG main lines plus their MVNO/기타 brands and
 * 스카이라이프. Matched by exact string equality against the row's telecomx.
 */
export const TELECOMS = [
  "KT",
  "SK텔레콤",
  "LG유플러스",
  "U+알뜰모바일",
  "KT엠모바일",
  "SK텔링크",
  "스카이라이프",
  "기타통신사(KT)",
  "기타통신사(SKT)",
  "기타통신사(LGT)",
] as const;
export type TelecomCode = (typeof TELECOMS)[number];

/** Canonical 개통 상태 a template condition can target. */
export const STATUSES = ["신규", "번호이동", "기변", "유심신규", "유심MNP"] as const;
export type StatusCode = (typeof STATUSES)[number];

/**
 * Which lifecycle milestone produced a due item / a template targets:
 * - "keepdate": 요금제 유지 시점 (폰클 유지일, 없으면 개통+기본 6개월) — 1단계.
 * - "term": 약정 만료 시점 (개통+약정 개월, 약정 대상만) — 2단계.
 */
export const MILESTONE_SOURCES = ["keepdate", "term"] as const;
export type MilestoneSource = (typeof MILESTONE_SOURCES)[number];

/**
 * A user-defined outbound message template with optional conditions. When
 * "알림 보내기" runs, the templates whose conditions match the customer's
 * telecom + 상태 are offered; if several match the staff picks one, if none
 * match the app prompts to add one. Empty condition array = matches any value.
 */
export interface MessageTemplate {
  id: string;
  name: string;
  telecoms: TelecomCode[];
  statuses: StatusCode[];
  /** Which milestone(s) this template targets. Empty/undefined = any milestone
   *  (backward-compatible with pre-2단계 templates). */
  sources?: MilestoneSource[];
  body: string;
}

/** User settings. Mirrors backend/config.py DEFAULTS. */
export interface AppConfig {
  poncle_base_url: string;
  /** 약정 개월 (2단계). 약정 대상(신규/번호이동/기변)의 약정 만료 = 개통 + 이 개월. 기본 24. */
  default_term_months: number;
  /** 요금제 유지 기본 개월 (1단계). 폰클에 요금제유지 미결이 없으면 개통 + 이 개월을
   *  요금제 유지 시점으로 본다. 기본 6. */
  keepdate_default_months: number;
  notify_offsets_days: number[];
  run_time: string;
  /** Conditional outbound templates (replaces the old fixed standard/nonstandard pair). */
  templates: MessageTemplate[];
  deliver_alerts: boolean;
  use_server_date_filter: boolean;
  date_window_days: number;
  scan_lookback_months: number;
  /** How many months past expiry a customer stays in the 미방문 고객 list before
   *  aging out. Also widens the scan's open-date fetch so recently-expired
   *  customers are re-derived. 0 disables 미방문 tracking. */
  unvisited_lookback_months: number;
  page_size: number;
  request_timeout_sec: number;
}

/** A due customer, ready for display and sending. Mirrors scan._entry_from_row. */
export interface DueItem {
  id: string;
  phone: string;
  customer: string;
  opendate: string;
  expiry_date: string;
  milestone_offset: number;
  telecom: string;
  agency: string;
  openhow: string;
  plan: string;
  model: string;
  staff: string;
  already_sent: boolean;
  /** Injected test row (010-1234-5678): exempt from dedup, never recorded. */
  test?: boolean;
  /** Which scan pass produced this item: 요금제 유지(keepdate) vs 약정 만료(term). */
  source?: MilestoneSource;
}
