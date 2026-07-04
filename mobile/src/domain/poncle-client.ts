/**
 * Read open-line rows from Poncle's /open/listOpen endpoint. Port of
 * backend/poncle_client.py, adapted to the range (look-ahead-window) scan model.
 * Pure paging/dedup/fallback logic over an injected gateway (the native Poncle
 * bridge in the app, a fake in tests). Contract math lives in expiry.ts.
 */
import { PlainDate, addMonths } from "./plaindate";
import { parseOpendate } from "./expiry";
import type { AppConfig, PoncleRow } from "./types";

export class SessionExpired extends Error {}

/** Server date filter looks unreliable -> fall back to a bounded full scan. */
class FilterIneffective extends Error {
  constructor(public total: number) {
    super(`date filter unreliable (grand_total=${total})`);
  }
}

/** One authenticated GET returning {ok,total,list}. Native plugin implements it. */
export interface PoncleGateway {
  check(): Promise<boolean>;
  listOpen(params: Record<string, string>): Promise<{ ok: boolean; total: number; list: PoncleRow[] }>;
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
    s: "customer-openphone",
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

  private async get(params: Record<string, string>): Promise<{ total: number; list: PoncleRow[] }> {
    const res = await this.gw.listOpen(params);
    if (!res.ok) throw new SessionExpired("listOpen did not return data (session likely expired)");
    return { total: res.total, list: res.list };
  }

  /** Fetch every row whose opendate falls in [sdate, edate] via the server filter. */
  private async fetchByDateRange(sdate: string, edate: string): Promise<PoncleRow[]> {
    const scale = int(this.config.page_size, 100);
    const collected = new Map<string, PoncleRow>();
    const first = await this.get(baseParams(0, scale, sdate, edate));
    const total = first.total;
    // If the server ignores the filter it returns the whole table, which is
    // implausibly large for a bounded open-date range -> fall back to a
    // client-filtered full scan instead of trusting it.
    if (total > scale * 400) throw new FilterIneffective(total);
    for (const r of first.list) collected.set(rowKey(r), r);
    let start = scale;
    while (start < total) {
      const pg = await this.get(baseParams(start, scale, sdate, edate));
      for (const r of pg.list) collected.set(rowKey(r), r);
      if (pg.list.length === 0) break;
      start += scale;
    }
    return Array.from(collected.values());
  }

  /** Full-scan fallback: page rows opendate-desc, stop past `earliest`. */
  private async fetchRecent(earliest: PlainDate): Promise<PoncleRow[]> {
    const scale = int(this.config.page_size, 100);
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
