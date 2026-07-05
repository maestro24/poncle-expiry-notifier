/**
 * Fill an outbound customer message template's placeholders. Port of the
 * placeholder half of backend/notifier.py. Template SELECTION now lives in
 * template-match.ts (conditional templates); this module only renders a body.
 */

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

/** Derived time-since-open values ({months}/{years}), computed by the caller
 *  from the opendate + today (kept out of MessageEntry as they aren't row data). */
export interface RenderExtras {
  months?: number;
  years?: number;
}

/**
 * Fill the message template. Missing placeholders degrade to '' (matches the
 * Python _Safe dict). Placeholders: {customer} {telecom} {model} {expiry}
 * {opendate} {when} {phone} {agency} {plan} {staff} {offset} {months} {years}.
 */
export function renderMessage(
  template: string,
  entry: MessageEntry,
  when: string,
  extra: RenderExtras = {},
): string {
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
    months: extra.months == null ? "" : String(extra.months),
    years: extra.years == null ? "" : String(extra.years),
  };
  return String(template ?? "").replace(/\{(\w+)\}/g, (_m, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "",
  );
}
