// 조회 탭 "최근 조회" 목록. 같은 번호를 하이픈·공백·+82 형태로 다르게 입력해도
// 한 항목으로 취급한다 — 실제 검색(searchFieldFor)과 같은 정규화 기준을 쓴다.
import { searchFieldFor } from "./poncle-client";

export const RECENT_LOOKUP_MAX = 6;

/** Identity of a query as the server sees it: field + normalized value. */
function recentKey(query: string): string {
  const { s, q } = searchFieldFor(query);
  return `${s}:${q}`;
}

/** Drop blanks and later duplicates (first = newest wins), cap the length. */
export function dedupeRecentQueries(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const q = raw.trim();
    if (!q) continue;
    const key = recentKey(q);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= RECENT_LOOKUP_MAX) break;
  }
  return out;
}

/** New list with `query` first, replacing any earlier entry for the same number/name. */
export function pushRecentQuery(list: readonly string[], query: string): string[] {
  const q = query.trim();
  if (!q) return dedupeRecentQueries(list);
  return dedupeRecentQueries([q, ...list]);
}
