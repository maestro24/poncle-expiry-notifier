/**
 * 고객 조회 safety net (audit I5): if Poncle ever ignores the search field (a
 * renamed parameter, a server change) it answers with an unrelated first page of
 * customers — shown as if they matched, a send could reach the wrong person. The
 * client keeps only rows that actually contain the query (name, phone text or
 * phone digits); a non-empty answer with no such row is reported as 'the search
 * condition was not applied' instead of a list.
 */
import { searchFieldFor } from "../domain/poncle-client";
import { normalizePhone } from "../domain/keepdate";
import { matchesDueQuery } from "./phone-query";

export const LOOKUP_IGNORED_TITLE = "검색 조건이 적용되지 않았습니다";
export const LOOKUP_IGNORED_SUB = "폰클이 검색어와 상관없는 고객 목록을 보내 표시하지 않았습니다. 잠시 후 다시 조회하거나 전체 이름·전화번호로 검색하세요.";

export interface LookupQueryRow {
  customer?: unknown;
  phone?: unknown;
}

export interface LookupQueryResult<T> {
  rows: T[];
  /** The server sent rows, none of which contains the query. */
  ignored: boolean;
}

const squash = (s: unknown): string => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/** The phone digits Poncle was actually asked for (searchFieldFor, e.g.
 *  '821011112222' -> '01011112222'), so the client keeps what the server found. */
function serverPhoneDigits(query: string): string {
  const sf = searchFieldFor(String(query ?? ""));
  return sf.s === "openphone" ? normalizePhone(sf.q) : "";
}

function matches(row: LookupQueryRow, query: string): boolean {
  if (matchesDueQuery(row, query)) return true;
  const digits = serverPhoneDigits(query);
  if (digits && normalizePhone(row.phone).includes(digits)) return true;
  const q = squash(query);
  return !!q && squash(row.customer).includes(q); // '홍 길동' finds 홍길동
}

export function applyLookupQuery<T extends LookupQueryRow>(rows: readonly T[], query: string): LookupQueryResult<T> {
  const kept = rows.filter((r) => matches(r, query));
  return { rows: kept, ignored: rows.length > 0 && kept.length === 0 };
}
