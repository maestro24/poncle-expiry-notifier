/**
 * Read open-line rows from Poncle's /open/listOpen endpoint. Port of
 * backend/poncle_client.py, adapted to the range (look-ahead-window) scan model.
 * Pure paging/dedup/fallback logic over an injected gateway (the native Poncle
 * bridge in the app, a fake in tests). Contract math lives in expiry.ts.
 */
import { PlainDate, addMonths } from "./plaindate";
import { parseOpendate } from "./expiry";
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
}

/** Authenticated GETs returning {ok,total,list,netError?}. Native plugin implements them. */
export interface PoncleGateway {
  check(): Promise<boolean>;
  listOpen(params: Record<string, string>): Promise<ListResult>;
  /** GET /pending/listPending (미결관리) — carries the 요금제 유지일(pendingdate). */
  listPending(params: Record<string, string>): Promise<ListResult>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    s: "customer-openphone",
    q: "",
    scale: String(scale),
  };
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
  constructor(
    private gw: PoncleGateway,
    private config: AppConfig,
  ) {}

  /** Retry transport errors a few times with backoff; a genuine session-expired
   *  (netError falsy) fails fast so the caller shows the re-login banner. */
  private async getWith(
    call: (p: Record<string, string>) => Promise<{ ok: boolean; total: number; list: PoncleRow[]; netError?: boolean }>,
    params: Record<string, string>,
  ): Promise<{ total: number; list: PoncleRow[] }> {
    for (let attempt = 0; ; attempt++) {
      const res = await call(params);
      if (res.ok) return { total: res.total, list: res.list };
      if (!res.netError) {
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
    const maxPages = 50; // safety cap
    for (let i = 0; i < maxPages; i++) {
      const res = await this.getPending(pendingParams(start, scale));
      for (const r of res.list) collected.push(r);
      start += scale;
      if (res.list.length < scale || start >= res.total) break;
    }
    return collected;
  }

  /** Look up the open row for a phone (to join type/telecom onto a 유지일 item).
   *  Returns the latest-opendate match, or null when the customer has no open row. */
  async fetchOpenByPhone(phone: string): Promise<PoncleRow | null> {
    const digits = phone.replace(/[^0-9]/g, "");
    if (!digits) return null;
    const params = baseParams(0, 5);
    params.q = phone; // s=customer-openphone
    const res = await this.get(params);
    const matches = res.list.filter(
      (r) => String(r["openphone"] ?? "").replace(/[^0-9]/g, "") === digits,
    );
    const pool = matches.length ? matches : res.list;
    // Latest opendate first ('yy-mm-dd' sorts lexically within the 2000s).
    pool.sort((a, b) => String(b["opendate"] ?? "").localeCompare(String(a["opendate"] ?? "")));
    return pool[0] ?? null;
  }

  /** Live customer search by name or phone for the 고객 조회 screen. The server
   *  filters on `s=customer-openphone`, so one query matches both. Returns every
   *  matching open row (a phone may have several 개통 over time); the caller groups
   *  by phone. Throws SessionExpired / NetworkError like the scan fetches. */
  async searchCustomers(query: string): Promise<PoncleRow[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const scale = Math.max(1, int(this.config.page_size, 100));
    const params = baseParams(0, scale);
    params.q = q;
    const res = await this.get(params);
    return res.list;
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
    const maxPages = 2000; // absolute safety cap (mirror fetchRecent)
    for (let i = 0; i < maxPages && start < total; i++) {
      const pg = await this.get(baseParams(start, scale, sdate, edate));
      for (const r of pg.list) collected.set(rowKey(r), r);
      if (pg.list.length === 0) break;
      start += scale;
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
    const maxPages = 2000; // absolute safety cap
    for (let i = 0; i < maxPages; i++) {
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
      if (start >= pg.total) break;
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
