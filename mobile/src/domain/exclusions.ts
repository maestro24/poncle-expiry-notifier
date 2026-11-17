/**
 * Manual 미방문 제외(exclusion) keys (audit B8). Stored in History's
 * "unvisited_handled" list: legacy/exact "phone|expiry" keys plus contract keys
 * "open:<phone>|<개통일>", so a changed 약정 개월 (moving the expiry key) never
 * un-excludes a customer. Pure.
 */
import { parseOpendate } from "./expiry";
import { dueKey, normalizePhone } from "./keepdate";
import { toIso } from "./plaindate";

/** Prefix of a contract-level 미방문 제외 key: "open:<digits phone>|<개통 yyyy-mm-dd>". */
export const EXCLUSION_CONTRACT_PREFIX = "open:";

/** The contract-level 제외 key for (phone, opendate), or null when either is unknown. */
export function exclusionContractKey(phone: unknown, opendate: unknown): string | null {
  const p = normalizePhone(phone);
  const od = parseOpendate(String(opendate ?? ""));
  return p && od ? `${EXCLUSION_CONTRACT_PREFIX}${p}|${toIso(od)}` : null;
}

/** A stored 제외 key in canonical form (legacy hyphenated phone|expiry normalized,
 *  contract keys re-built); null when malformed. */
export function normalizeExclusionKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const head = raw.slice(0, bar);
  const tail = raw.slice(bar + 1).trim();
  if (head.startsWith(EXCLUSION_CONTRACT_PREFIX)) {
    return exclusionContractKey(head.slice(EXCLUSION_CONTRACT_PREFIX.length), tail);
  }
  const phone = normalizePhone(head);
  return phone && tail ? dueKey(phone, tail) : null;
}

/** What a 미방문 제외 is matched against (a DueItem satisfies it). */
export interface ExclusionTarget {
  phone: string;
  expiry_date: string;
  opendate?: string;
}

/**
 * Snapshot of the manual 미방문 제외 set (audit B8). A target is excluded by its
 * exact phone|expiry key (legacy and current) OR by its contract (phone + 개통일), so
 * changing 약정 개월 / 기본 개월 (which moves the expiry key) never un-excludes.
 */
export class ExclusionIndex {
  private readonly keys = new Set<string>();

  constructor(keys: Iterable<string>) {
    for (const k of keys) this.keys.add(normalizeExclusionKey(k) ?? k);
  }

  isHandled(t: ExclusionTarget): boolean {
    if (this.keys.has(dueKey(t.phone, t.expiry_date))) return true;
    const ck = exclusionContractKey(t.phone, t.opendate);
    return !!ck && this.keys.has(ck);
  }
}
