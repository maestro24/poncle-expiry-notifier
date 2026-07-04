import { describe, expect, it } from "vitest";
import { PoncleClient, SessionExpired, rowKey } from "../src/domain/poncle-client";
import { DEFAULTS } from "../src/domain/config";
import type { AppConfig, PoncleRow } from "../src/domain/types";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULTS, ...over };
}
const row = (idx: string, phone: string, opendate: string): PoncleRow => ({ idx, openphone: phone, opendate });
const BOUNDS = { sdate: "2024-06-12", edate: "2024-07-20" };

describe("rowKey", () => {
  it("prefers idx", () => expect(rowKey({ idx: "7", openphone: "x" })).toBe("idx:7"));
  it("falls back to phone|date", () =>
    expect(rowKey({ openphone: "010", opendate: "24-01-01" })).toBe("pd:010|24-01-01"));
});

describe("fetchByDateRange paging + dedup", () => {
  it("pages until total and dedups by rowKey", async () => {
    const calls: Array<Record<string, string>> = [];
    const gw = {
      check: async () => true,
      listOpen: async (p: Record<string, string>) => {
        calls.push(p);
        const start = Number(p.start);
        if (start === 0) return { ok: true, total: 3, list: [row("1", "a", "24-06-15"), row("2", "b", "24-06-16")] };
        return { ok: true, total: 3, list: [row("1", "a", "24-06-15"), row("3", "c", "24-06-17")] };
      },
    };
    const client = new PoncleClient(gw, cfg({ page_size: 2 }));
    const out = await client.fetchCandidates(BOUNDS);
    expect(out.map(rowKey).sort()).toEqual(["idx:1", "idx:2", "idx:3"]);
    expect(calls.length).toBe(2);
    expect(calls[0].sdate).toBe("2024-06-12"); // used the range filter
  });

  it("empty range returns [] (no fallback)", async () => {
    let fullScanUsed = false;
    const gw = {
      check: async () => true,
      listOpen: async (p: Record<string, string>) => {
        if (p.sdate !== "") return { ok: true, total: 0, list: [] as PoncleRow[] };
        fullScanUsed = true;
        return { ok: true, total: 1, list: [row("z", "z", "24-06-15")] };
      },
    };
    const out = await new PoncleClient(gw, cfg()).fetchCandidates(BOUNDS);
    expect(out).toEqual([]);
    expect(fullScanUsed).toBe(false);
  });
});

describe("filter-ineffective fallback", () => {
  it("absurdly large total -> falls back to full scan", async () => {
    let recentUsed = false;
    const gw = {
      check: async () => true,
      listOpen: async (p: Record<string, string>) => {
        if (p.sdate !== "") return { ok: true, total: 999999, list: [row("1", "a", "24-06-15")] };
        recentUsed = true;
        return { ok: true, total: 1, list: [row("9", "z", "24-06-15")] };
      },
    };
    const out = await new PoncleClient(gw, cfg({ page_size: 100 })).fetchCandidates(BOUNDS);
    expect(recentUsed).toBe(true);
    expect(out.map(rowKey)).toEqual(["idx:9"]);
  });
});

describe("session expiry", () => {
  it("ok:false throws SessionExpired", async () => {
    const gw = {
      check: async () => false,
      listOpen: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }),
    };
    await expect(new PoncleClient(gw, cfg()).fetchCandidates(BOUNDS)).rejects.toBeInstanceOf(SessionExpired);
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
          return { ok: true, total: 500, list: [row("1", "a", "24-06-15"), row("old", "b", "2000-01-01")] };
        }
        return { ok: true, total: 500, list: [row("x", "c", "24-06-15")] };
      },
    };
    // disable server filter to force fetchRecent; earliest comes from bounds.sdate
    const out = await new PoncleClient(gw, cfg({ use_server_date_filter: false, page_size: 100 })).fetchCandidates(BOUNDS);
    expect(pages).toBe(1);
    expect(out.map(rowKey)).toEqual(["idx:1"]);
  });
});
