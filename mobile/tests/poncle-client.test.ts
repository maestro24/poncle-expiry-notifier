import { describe, expect, it } from "vitest";
import { PoncleClient, SessionExpired, rowKey } from "../src/domain/poncle-client";
import { DEFAULTS } from "../src/domain/config";
import { makeDate } from "../src/domain/plaindate";
import type { AppConfig, PoncleRow } from "../src/domain/types";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULTS, ...over };
}
const row = (idx: string, phone: string, opendate: string): PoncleRow => ({
  idx,
  openphone: phone,
  opendate,
});

describe("rowKey", () => {
  it("prefers idx", () => expect(rowKey({ idx: "7", openphone: "x" })).toBe("idx:7"));
  it("falls back to phone|date", () =>
    expect(rowKey({ openphone: "010", opendate: "24-01-01" })).toBe("pd:010|24-01-01"));
});

describe("fetchByOpenDates paging + dedup", () => {
  it("pages until total and dedups by rowKey", async () => {
    const calls: Array<Record<string, string>> = [];
    const gw = {
      check: async () => true,
      listOpen: async (p: Record<string, string>) => {
        calls.push(p);
        const start = Number(p.start);
        // total 3, scale 2 -> two pages; row idx:1 repeats across pages (dedup).
        if (start === 0) return { ok: true, total: 3, list: [row("1", "a", "24-01-01"), row("2", "b", "24-01-01")] };
        return { ok: true, total: 3, list: [row("1", "a", "24-01-01"), row("3", "c", "24-01-01")] };
      },
    };
    const client = new PoncleClient(gw, cfg({ page_size: 2, date_window_days: 0 }));
    const out = await client.fetchCandidates([makeDate(2024, 1, 1)]);
    const keys = out.map(rowKey).sort();
    expect(keys).toEqual(["idx:1", "idx:2", "idx:3"]);
    expect(calls.length).toBe(2); // start=0 then start=2
  });
});

describe("filter-ineffective fallback", () => {
  it("too many rows -> falls back to full scan", async () => {
    let recentUsed = false;
    const gw = {
      check: async () => true,
      listOpen: async (p: Record<string, string>) => {
        const windowed = p.sdate !== "" || p.edate !== "";
        if (windowed) {
          // huge total (> scale*8) for the windowed query -> FilterIneffective
          return { ok: true, total: 9999, list: [row("1", "a", "24-01-01")] };
        }
        // full-scan path (no date filter): return one page then stop
        recentUsed = true;
        return { ok: true, total: 1, list: [row("9", "z", "24-01-01")] };
      },
    };
    const client = new PoncleClient(gw, cfg({ page_size: 100 }));
    const out = await client.fetchCandidates([makeDate(2024, 1, 1)]);
    expect(recentUsed).toBe(true);
    expect(out.map(rowKey)).toEqual(["idx:9"]);
  });

  it("zero rows across windows -> falls back to full scan", async () => {
    let recentUsed = false;
    const gw = {
      check: async () => true,
      listOpen: async (p: Record<string, string>) => {
        const windowed = p.sdate !== "" || p.edate !== "";
        if (windowed) return { ok: true, total: 0, list: [] as PoncleRow[] };
        recentUsed = true;
        return { ok: true, total: 1, list: [row("5", "y", "24-01-01")] };
      },
    };
    const client = new PoncleClient(gw, cfg({ page_size: 100 }));
    const out = await client.fetchCandidates([makeDate(2024, 1, 1)]);
    expect(recentUsed).toBe(true);
    expect(out.map(rowKey)).toEqual(["idx:5"]);
  });
});

describe("session expiry", () => {
  it("ok:false throws SessionExpired", async () => {
    const gw = {
      check: async () => false,
      listOpen: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }),
    };
    const client = new PoncleClient(gw, cfg({ date_window_days: 0 }));
    await expect(client.fetchCandidates([makeDate(2024, 1, 1)])).rejects.toBeInstanceOf(SessionExpired);
  });
});

describe("full-scan floor", () => {
  it("stops paging once rows pass the earliest floor", async () => {
    let pages = 0;
    const gw = {
      check: async () => true,
      listOpen: async (p: Record<string, string>) => {
        pages++;
        const start = Number(p.start);
        if (start === 0) {
          // newest page: one recent row + one very old row (past floor) -> stop
          return {
            ok: true,
            total: 500,
            list: [row("1", "a", "24-06-15"), row("old", "b", "2000-01-01")],
          };
        }
        return { ok: true, total: 500, list: [row("x", "c", "24-06-15")] };
      },
    };
    // disable server filter to force fetchRecent
    const client = new PoncleClient(gw, cfg({ use_server_date_filter: false, page_size: 100 }));
    const out = await client.fetchCandidates([makeDate(2024, 6, 15)]);
    expect(pages).toBe(1); // stopped after first page (hit old row past floor)
    expect(out.map(rowKey)).toEqual(["idx:1"]); // old row excluded
  });
});
