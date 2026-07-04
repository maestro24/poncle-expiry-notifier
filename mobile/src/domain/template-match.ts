/**
 * Match a due customer against the user's conditional message templates.
 *
 * A template carries two optional condition groups: telecoms and statuses.
 * Within a group the values are OR-ed; the two groups are AND-ed; an empty
 * group is a wildcard (matches any value). A customer's raw Poncle fields
 * (telecomx / openhowx) are first normalized to the canonical codes so minor
 * spelling/format differences ("SK텔레콤" vs "SKT", "기기변경" vs "기변") match.
 */
import { TELECOMS, type MessageTemplate, type StatusCode, type TelecomCode } from "./types";

interface Matchable {
  telecom?: string;
  openhow?: string;
}

const TELECOM_SET: ReadonlySet<string> = new Set(TELECOMS);
// Poncle also carries a short `telecom` code; if a row ever lacks the telecomx
// display (the app falls back to the code), map the unambiguous codes to their
// canonical display. "ETC" is intentionally absent: it maps to three distinct
// 기타통신사(...) displays and can't be resolved from the code alone.
const CODE_TO_DISPLAY: Record<string, TelecomCode> = {
  KT: "KT",
  SKT: "SK텔레콤",
  LGT: "LG유플러스",
  LGUMOBI: "U+알뜰모바일",
  KTMMOBILE: "KT엠모바일",
  SKTELINK: "SK텔링크",
  SKYLIFE: "스카이라이프",
};

/**
 * Resolve a Poncle telecom value to one of the 10 canonical carriers by exact
 * match on the telecomx display (or the unambiguous short code). Returns "" for
 * anything unrecognized, so an unknown carrier only matches wildcard templates.
 */
export function normalizeTelecom(raw: string): TelecomCode | "" {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (TELECOM_SET.has(s)) return s as TelecomCode;
  if (CODE_TO_DISPLAY[s]) return CODE_TO_DISPLAY[s];
  return "";
}

/**
 * Normalize a Poncle 개통유형 (openhowx) to one of the five canonical statuses.
 * Order matters: 유심 variants are checked before the plain ones so "유심MNP"
 * doesn't collapse to "번호이동". Returns "" for anything that can't be mapped.
 */
export function normalizeStatus(raw: string): StatusCode | "" {
  const s = String(raw ?? "").replace(/\s+/g, "");
  if (!s) return "";
  const has = (x: string) => s.includes(x);
  if (has("유심")) {
    if (has("MNP") || has("번호이동")) return "유심MNP";
    if (has("신규")) return "유심신규";
    return ""; // e.g. 유심기변 has no canonical bucket
  }
  if (has("MNP") || has("번호이동")) return "번호이동";
  if (has("기변") || has("기기변경")) return "기변";
  if (has("신규")) return "신규";
  return "";
}

/** True when the item's telecom + 상태 satisfy this template's conditions. */
export function templateMatches(item: Matchable, tpl: MessageTemplate): boolean {
  const tel = normalizeTelecom(item.telecom ?? "");
  const st = normalizeStatus(item.openhow ?? "");
  const telOk = !tpl.telecoms?.length || (tel !== "" && tpl.telecoms.includes(tel));
  const stOk = !tpl.statuses?.length || (st !== "" && tpl.statuses.includes(st));
  return telOk && stOk;
}

/** Templates that match the item, preserving list order (first = highest priority). */
export function matchingTemplates(item: Matchable, templates: MessageTemplate[]): MessageTemplate[] {
  return (templates ?? []).filter((t) => templateMatches(item, t));
}

/** Short human summary of a template's conditions, for list rows. */
export function conditionSummary(tpl: MessageTemplate): string {
  const tel = tpl.telecoms?.length ? tpl.telecoms.join("·") : "모든 통신사";
  const st = tpl.statuses?.length ? tpl.statuses.join("·") : "모든 상태";
  return `${tel} / ${st}`;
}
