/**
 * Read open-line rows from Poncle's /open/listOpen endpoint. Port of
 * backend/poncle_client.py, adapted to the range (look-ahead-window) scan model.
 * Pure paging/dedup/fallback logic over an injected gateway (the native Poncle
 * bridge in the app, a fake in tests). Contract math lives in expiry.ts.
 */
import { PlainDate, addMonths } from "./plaindate";
import { isNewerOpenRow, parseOpendate } from "./expiry";
import { normalizeKrMobile } from "./sender";
import type { AppConfig, PoncleRow } from "./types";

/** Poncle answered with the login page: the session is genuinely expired. */
export class SessionExpired extends Error {}

/** A retryable transport failure (timeout / IO / non-200), NOT a logout. */
export class NetworkError extends Error {}

/** Server date filter looks unreliable -> fall back to a bounded full scan. */
class FilterIneffective extends Error {
  constructor(public total: number) {
    super(`date filter unreliable (grand_total=${total})`);
  }
}

/** Result shape shared by the list endpoints. */
export interface ListResult {
  ok: boolean;
  total: number;
  list: PoncleRow[];
  netError?: boolean;
  /** HTTP status the server answered with (native builds >= 1.2.17); absent when
   *  no response arrived or on older builds. */
  status?: number;
  /** The server's HTTP `Date` header as an ISO-8601 UTC string (native builds
   *  >= 1.2.17); absent when the response carried none / on older builds. Used to
   *  detect a wrong device clock (improvement 3-16). */
  serverDate?: string;
}

/** 고객 조회 result: the first page of matches plus the server's total count. */
export interface CustomerSearchResult {
  list: PoncleRow[];
  /** Server total clamped to at least list.length (never reads lower than what was shown). */
  total: number;
  /** The server's own total, unclamped; 0 when missing/unparseable (audit L19). Lets
   *  the UI tell "exactly page_size matches" from "a full page, total unknown". */
  serverTotal?: number;
}

/** A server status that means "try again later", not "logged out": 5xx, 408
 *  (request timeout) and 429 (rate limited). 401/403 and every other status are
 *  NOT transient here — the caller decides what they mean (audit 1-18). */
export function isTransientHttpStatus(status: number | undefined): boolean {
  if (typeof status !== "number" || !Number.isFinite(status)) return false;
  return status >= 500 || status === 408 || status === 429;
}

/** Authenticated GETs returning {ok,total,list,netError?}. Native plugin implements them. */
export interface PoncleGateway {
  check(): Promise<boolean>;
  listOpen(params: Record<string, string>): Promise<ListResult>;
  /** GET /pending/listPending (미결관리) — carries the 요금제 유지일(pendingdate). */
  listPending(params: Record<string, string>): Promise<ListResult>;
}

/** Optional knobs for PoncleClient (tests / callers that want the cap notice). */
export interface PoncleClientOptions {
  /** Override every paging loop's safety cap (default: 2000 open / 50 pending). */
  maxPages?: number;
  /** Called when a paging loop stops because it hit the safety cap while the
   *  server still had full pages — i.e. the result may be incomplete. */
  onTruncated?: (what: string, pages: number) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Whether another page should be requested after one that returned `got` rows.
 *  A parseable positive `total` is authoritative (`nextStart < total`); when the
 *  server total is missing / unparseable (the native layer reads it as 0) a FULL
 *  page means "there may be more" (improvement 3-7: an unparseable total used to
 *  end the scan silently after the first page). An empty page always stops. */
function hasMorePages(got: number, scale: number, nextStart: number, total: number): boolean {
  if (got === 0) return false;
  if (Number.isFinite(total) && total > 0) return nextStart < total;
  return got >= scale;
}

function baseParams(
  start: number,
  scale: number,
  sdate = "",
  edate = "",
): Record<string, string> {
  return {
    start: String(start),
    sort: "opendate",
    by: "desc",
    viewsum: "0",
    sdate,
    edate,
    openhow: "",
    cond: "",
    agency: "",
    member: "",
    mgubun: "",
    mmodel: "",
    s: "all",
    q: "",
    scale: String(scale),
  };
}

/** Poncle's list search field (`s`) for a query. The list form currently offers
 *  all / openphone / customer / … — the old "customer-openphone" value was
 *  retired and an unknown `s` is silently ignored (the whole table comes back).
 *  Phone-looking queries search the phone field with digits only; anything
 *  else searches the customer name.
 *
 *  Poncle stores the domestic form (010…). A complete mobile number goes
 *  through normalizeKrMobile (sender.ts — the one shared rule, also mirrored by
 *  native SmsPlugin.normalizeNumber), so "+82 10-…", "+82 010-…" and "8210…"
 *  all search as "010…" (audit L17). A partial number only has an explicit
 *  "+82" country code rewritten with the same rule (+82 then 1 -> 01, +82 then 0
 *  -> 0); a '+' number that is not +82 is foreign and is searched as typed. */
export function searchFieldFor(query: string): { s: string; q: string } {
  const q = query.trim();
  const digits = q.replace(/[^0-9]/g, "");
  const phoneLike = digits.length >= 3 && /^[0-9+\-\s().]+$/.test(q);
  if (!phoneLike) return { s: "customer", q };
  const full = normalizeKrMobile(q);
  if (full) return { s: "openphone", q: full };
  if (q.startsWith("+") && digits.startsWith("82")) {
    const rest = digits.slice(2);
    return { s: "openphone", q: rest.startsWith("0") ? rest : `0${rest}` };
  }
  return { s: "openphone", q: digits };
}

/** Query params for /pending/listPending filtered to 요금제유지 (gubun=2). */
function pendingParams(start: number, scale: number): Record<string, string> {
  return {
    start: String(start),
    sort: "pendingdate",
    by: "desc",
    subject: "",
    sdate: "",
    edate: "",
    gubun: "2", // 요금제유지
    cond: "",
    cate: "",
    agency: "",
    member: "",
    condmember: "",
    s: "phone",
    q: "",
    scale: String(scale),
  };
}

/** Stable identity for a row (Poncle's line idx if present, else phone+date). */
export function rowKey(row: PoncleRow): string {
  const idx = String(row["idx"] ?? "").trim();
  if (idx) return `idx:${idx}`;
  return `pd:${row["openphone"] ?? ""}|${row["opendate"] ?? ""}`;
}

export class PoncleClient {
  /** True once any fetch on this client stopped at a paging safety cap (results
   *  possibly incomplete). Sticky for the client's lifetime (one client per scan). */
  truncated = false;

  constructor(
    private gw: PoncleGateway,
    private config: AppConfig,
    private opts: PoncleClientOptions = {},
  ) {}

  private cap(fallback: number): number {
    const n = this.opts.maxPages;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  /** Record + report that a paging loop ran into its cap with more data pending. */
  private noteTruncated(what: string, pages: number): void {
    this.truncated = true;
    console.warn(`[poncle] ${what}: stopped at the ${pages}-page safety cap; results may be incomplete`);
    try {
      this.opts.onTruncated?.(what, pages);
    } catch {
      // a notice callback must never break a scan
    }
  }

  /** Retry transport errors and transient server statuses (5xx/408/429) a few
   *  times with backoff; a genuine session-expired (no netError, non-transient
   *  status) fails fast so the caller shows the re-login banner. */
  private async getWith(
    call: (p: Record<string, string>) => Promise<ListResult>,
    params: Record<string, string>,
  ): Promise<{ total: number; list: PoncleRow[] }> {
    for (let attempt = 0; ; attempt++) {
      const res = await call(params);
      if (res.ok) return { total: res.total, list: res.list };
      if (!res.netError && !isTransientHttpStatus(res.status)) {
        throw new SessionExpired("list endpoint did not return data (session likely expired)");
      }
      if (attempt >= 2) throw new NetworkError("네트워크 오류로 스캔에 실패했습니다");
      await sleep(400 * (attempt + 1));
    }
  }

  private get(params: Record<string, string>): Promise<{ total: number; list: PoncleRow[] }> {
    return this.getWith((p) => this.gw.listOpen(p), params);
  }
  private getPending(params: Record<string, string>): Promise<{ total: number; list: PoncleRow[] }> {
    return this.getWith((p) => this.gw.listPending(p), params);
  }

  /** All 요금제유지 미결 rows (gubun=2), paged. Small set; carries the 유지일. */
  async fetchPending(): Promise<PoncleRow[]> {
    const scale = 1000;
    const collected: PoncleRow[] = [];
    let start = 0;
    const maxPages = this.cap(50); // safety cap
    for (let i = 0; ; i++) {
      const res = await this.getPending(pendingParams(start, scale));
      for (const r of res.list) collected.push(r);
      start += scale;
      // A short page is the last one (as before); a full page continues even when
      // the total is unparseable.
      if (res.list.length < scale || !hasMorePages(res.list.length, scale, start, res.total)) break;
      if (i + 1 >= maxPages) {
        this.noteTruncated("listPending", maxPages);
        break;
      }
    }
    return collected;
  }

  /** Look up the open row for a phone (to join type/telecom onto a 유지일 item).
   *  Returns the latest-opendate row whose phone matches exactly (digits only), or
   *  null when none does. Never falls back to another customer's row: the server
   *  search is fuzzy (partial phone match), and joining a different customer's row
   *  would put B's name/model into A's SMS. */
  async fetchOpenByPhone(phone: string): Promise<PoncleRow | null> {
    const digits = phone.replace(/[^0-9]/g, "");
    if (!digits) return null;
    const params = baseParams(0, 5);
    Object.assign(params, searchFieldFor(digits)); // s=openphone, digits only
    const res = await this.get(params);
    const matches = res.list.filter(
      (r) => String(r["openphone"] ?? "").replace(/[^0-9]/g, "") === digits,
    );
    // Latest 개통 by PARSED opendate (+ idx on a same-day tie) — the same rule as
    // latestOpenByPhone (U1), never the raw 'yy-mm-dd' text.
    return matches.reduce<PoncleRow | null>((best, r) => (!best || isNewerOpenRow(r, best) ? r : best), null);
  }

  /** Live customer search by name or phone for the 고객 조회 screen. The server
   *  picks the phone or customer-name field (searchFieldFor). Returns every
   *  matching open row (a phone may have several 개통 over time); the caller groups
   *  by phone. Throws SessionExpired / NetworkError like the scan fetches. */
  async searchCustomers(query: string): Promise<PoncleRow[]> {
    return (await this.searchCustomersWithTotal(query)).list;
  }

  /** searchCustomers plus the server's match count. Only the FIRST page (page_size
   *  rows) is fetched, so when `total > list.length` the UI should say the result
   *  was cut off and ask for a more specific query (improvement 3-12). The search
   *  is field-specific (searchFieldFor: s=openphone for a number, s=customer for
   *  a name — no longer the old 통합검색 that also matched staff names), so
   *  `total` counts that field's matches only (audit L41). `total` is never lower than the
   *  rows actually returned (a missing/unparseable server total reads as 0). */
  async searchCustomersWithTotal(query: string): Promise<CustomerSearchResult> {
    const q = query.trim();
    if (q.length < 2) return { list: [], total: 0 };
    const scale = Math.max(1, int(this.config.page_size, 100));
    const params = baseParams(0, scale);
    Object.assign(params, searchFieldFor(q));
    const res = await this.get(params);
    const total = Number.isFinite(res.total) && res.total > 0 ? res.total : 0;
    return { list: res.list, total: Math.max(total, res.list.length), serverTotal: total };
  }

  /** Fetch every row whose opendate falls in [sdate, edate] via the server filter. */
  private async fetchByDateRange(sdate: string, edate: string): Promise<PoncleRow[]> {
    const scale = Math.max(1, int(this.config.page_size, 100));
    const collected = new Map<string, PoncleRow>();
    const first = await this.get(baseParams(0, scale, sdate, edate));
    const total = first.total;
    // If the server ignores the filter it returns the whole table, which is
    // implausibly large for a bounded open-date range -> fall back to a
    // client-filtered full scan instead of trusting it.
    if (total > scale * 400) throw new FilterIneffective(total);
    for (const r of first.list) collected.set(rowKey(r), r);
    let start = scale;
    let more = hasMorePages(first.list.length, scale, start, total);
    const maxPages = this.cap(2000); // absolute safety cap (mirror fetchRecent)
    for (let pages = 1; more; pages++) {
      if (pages >= maxPages) {
        this.noteTruncated("listOpen(range)", maxPages);
        break;
      }
      const pg = await this.get(baseParams(start, scale, sdate, edate));
      for (const r of pg.list) collected.set(rowKey(r), r);
      start += scale;
      more = hasMorePages(pg.list.length, scale, start, total);
    }
    return Array.from(collected.values());
  }

  /** Full-scan fallback: page rows opendate-desc, stop past `earliest`. */
  private async fetchRecent(earliest: PlainDate): Promise<PoncleRow[]> {
    const scale = Math.max(1, int(this.config.page_size, 100));
    const lookbackMonths = int(this.config.scan_lookback_months, 40);
    const hardFloor = addMonths(today0(), -lookbackMonths);
    const floor = earliest.getTime() > hardFloor.getTime() ? earliest : hardFloor;

    const collected = new Map<string, PoncleRow>();
    let start = 0;
    const maxPages = this.cap(2000); // absolute safety cap
    for (let i = 0; ; i++) {
      const pg = await this.get(baseParams(start, scale));
      const rows = pg.list;
      if (rows.length === 0) break;
      let passedFloor = false;
      for (const r of rows) {
        const od = parseOpendate(String(r["opendate"] ?? ""));
        if (od !== null && od.getTime() < floor.getTime()) {
          passedFloor = true;
          continue;
        }
        collected.set(rowKey(r), r);
      }
      if (passedFloor) break; // desc-sorted: nothing older matters
      start += scale;
      if (!hasMorePages(rows.length, scale, start, pg.total)) break;
      if (i + 1 >= maxPages) {
        this.noteTruncated("listOpen(full)", maxPages);
        break;
      }
    }
    return Array.from(collected.values());
  }

  /**
   * Return the rows worth evaluating for the look-ahead window. Uses the server
   * date filter over [bounds.sdate, bounds.edate] when enabled and effective;
   * otherwise a bounded full scan. Either way the caller re-checks each row
   * client-side (dueWithin), so this only affects efficiency, never correctness.
   */
  async fetchCandidates(bounds: { sdate: string; edate: string }): Promise<PoncleRow[]> {
    if (this.config.use_server_date_filter !== false) {
      try {
        return await this.fetchByDateRange(bounds.sdate, bounds.edate);
      } catch (e) {
        if (!(e instanceof FilterIneffective)) throw e;
        // fall through to full scan
      }
    }
    const earliest = parseOpendate(bounds.sdate) ?? today0();
    return this.fetchRecent(earliest);
  }
}

function int(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function today0(): PlainDate {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
