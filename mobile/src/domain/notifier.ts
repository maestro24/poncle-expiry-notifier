/**
 * Render the outbound customer message from the template. Port of
 * backend/notifier.py. Picks one of two templates by 개통유형 (기변/신규 use the
 * standard template, everything else the non-standard one) and fills placeholders.
 */
import { isStandardOpenType } from "./expiry";
import type { AppConfig, PoncleRow } from "./types";

/**
 * Pick the message template by 개통유형: 기변/신규 -> message_template, 그 외
 * (번호이동/유심 등) -> message_template_nonstandard (falls back to the standard
 * template if the non-standard one is empty).
 */
export function templateForRow(config: AppConfig, row: PoncleRow): string {
  const standard = config.message_template ?? "";
  const openType = String(row["openhowx"] ?? row["openhow"] ?? "");
  if (isStandardOpenType(openType)) return standard;
  return (config.message_template_nonstandard || standard) as string;
}

/** Values available to a message template. */
export interface MessageEntry {
  customer?: string;
  phone?: string;
  expiry_date?: string;
  opendate?: string;
  telecom?: string;
  agency?: string;
  plan?: string;
  model?: string;
  staff?: string;
  milestone_offset?: number;
}

/**
 * Fill the message template. Missing placeholders degrade to '' (matches the
 * Python _Safe dict). Placeholders: {customer} {telecom} {model} {expiry}
 * {opendate} {when} {phone} {agency} {plan} {staff} {offset}.
 */
export function renderMessage(template: string, entry: MessageEntry, when: string): string {
  const values: Record<string, string> = {
    customer: entry.customer ?? "",
    phone: entry.phone ?? "",
    expiry: entry.expiry_date ?? "",
    opendate: entry.opendate ?? "",
    telecom: entry.telecom ?? "",
    agency: entry.agency ?? "",
    plan: entry.plan ?? "",
    model: entry.model ?? "",
    staff: entry.staff ?? "",
    offset: String(entry.milestone_offset ?? 0),
    when,
  };
  return String(template ?? "").replace(/\{(\w+)\}/g, (_m, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "",
  );
}
