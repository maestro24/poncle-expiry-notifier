/** Shared domain types for the contract-expiry logic. */

/** A raw row from Poncle's /open/listOpen JSON. Fields are loosely typed because
 *  Poncle returns strings/numbers inconsistently; the domain layer coerces. */
export type PoncleRow = Record<string, unknown>;

/** User settings. Mirrors backend/config.py DEFAULTS. */
export interface AppConfig {
  poncle_base_url: string;
  default_term_months: number;
  nonstandard_term_months: number;
  agency_term_months: Record<string, number>;
  notify_offsets_days: number[];
  run_time: string;
  message_template: string;
  message_template_nonstandard: string;
  deliver_alerts: boolean;
  use_server_date_filter: boolean;
  date_window_days: number;
  scan_lookback_months: number;
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
}
