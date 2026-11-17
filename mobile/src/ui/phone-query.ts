/**
 * Home due-list search (L16): a phone-looking query matches by digits, so
 * "01011112222", "010-1111-2222" and "+82 10-1111-2222" find the same customer
 * (the 이력 search already does this). '+82' follows the shared phone rule (K3):
 * "+82 10…" -> "010…", "+82 010…" -> "010…"; a '+' that is not +82 is no
 * domestic number and only matches as text.
 */
import { isPhoneQuery } from "../domain/history";
import { normalizePhone } from "../domain/keepdate";

/** The domestic digits a phone-looking query stands for; "" for anything else. */
export function phoneQueryDigits(query: string): string {
  const q = String(query ?? "").trim();
  if (!isPhoneQuery(q)) return "";
  const digits = normalizePhone(q);
  if (!q.startsWith("+")) return digits;
  if (!digits.startsWith("82")) return "";
  const rest = digits.slice(2);
  return rest.startsWith("0") ? rest : `0${rest}`;
}

/** Whether a due row matches the home search box (name/phone text, or phone digits). */
export function matchesDueQuery(row: { customer?: unknown; phone?: unknown }, query: string): boolean {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const phone = String(row.phone ?? "");
  if (String(row.customer ?? "").toLowerCase().includes(q) || phone.includes(q)) return true;
  const digits = phoneQueryDigits(q);
  return !!digits && normalizePhone(phone).includes(digits);
}
