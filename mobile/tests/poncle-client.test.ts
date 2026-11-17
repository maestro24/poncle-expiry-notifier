import { describe, expect, it } from "vitest";
import {
  NetworkError,
  PoncleClient,
  SessionExpired,
  isTransientHttpStatus,
  rowKey,
} from "../src/domain/poncle-client";
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
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
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
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
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
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
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
      listPending: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }),
      listOpen: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }),
    };
    await expect(new PoncleClient(gw, cfg()).fetchCandidates(BOUNDS)).rejects.toBeInstanceOf(SessionExpired);
  });
});

describe("HTTP status classification (audit 1-18)", () => {
  type Res = { ok: boolean; total: number; list: PoncleRow[]; netError?: boolean; status?: number };
  const failing = (res: Res, okAfter = Infinity) => {
    let calls = 0;
    const fn = async (): Promise<Res> => {
      calls++;
      return calls > okAfter ? { ok: true, total: 1, list: [row("1", "a", "24-06-15")] } : res;
    };
    return { fn, calls: () => calls };
  };
  const gwFrom = (listOpen: () => Promise<Res>, listPending: () => Promise<Res> = listOpen) => ({
    check: async () => true,
    listOpen,
    listPending,
  });

  it("isTransientHttpStatus: 5xx / 408 / 429 are retryable, auth + others are not", () => {
    for (const s of [500, 502, 503, 504, 408, 429]) expect(isTransientHttpStatus(s)).toBe(true);
    for (const s of [200, 302, 401, 403, 404, undefined]) expect(isTransientHttpStatus(s)).toBe(false);
  });

  it("a 503 without netError is a NetworkError (retried), never SessionExpired", async () => {
    const f = failing({ ok: false, total: 0, list: [], netError: false, status: 503 });
    await expect(new PoncleClient(gwFrom(f.fn), cfg()).fetchCandidates(BOUNDS)).rejects.toBeInstanceOf(NetworkError);
    expect(f.calls()).toBe(3);
  });

  it("a transient 429 is retried and the scan succeeds on the next attempt", async () => {
    const f = failing({ ok: false, total: 0, list: [], status: 429 }, 1);
    const out = await new PoncleClient(gwFrom(f.fn), cfg()).fetchCandidates(BOUNDS);
    expect(out.map(rowKey)).toEqual(["idx:1"]);
    expect(f.calls()).toBe(2);
  });

  it("netError:true (no response) is retried then raised as NetworkError", async () => {
    const f = failing({ ok: false, total: 0, list: [], netError: true });
    await expect(new PoncleClient(gwFrom(f.fn), cfg()).fetchCandidates(BOUNDS)).rejects.toBeInstanceOf(NetworkError);
    expect(f.calls()).toBe(3);
  });

  it("401 / 403 stay a session expiry (fail fast, no retry)", async () => {
    for (const status of [401, 403]) {
      const f = failing({ ok: false, total: 0, list: [], netError: false, status });
      await expect(new PoncleClient(gwFrom(f.fn), cfg()).fetchCandidates(BOUNDS)).rejects.toBeInstanceOf(
        SessionExpired,
      );
      expect(f.calls()).toBe(1);
    }
  });

  it("fetchPending on a 500 raises NetworkError (so the scan degrades instead of logging out)", async () => {
    const f = failing({ ok: false, total: 0, list: [], netError: false, status: 500 });
    const ok = failing({ ok: true, total: 0, list: [] });
    await expect(new PoncleClient(gwFrom(ok.fn, f.fn), cfg()).fetchPending()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("fetchOpenByPhone exact-match only (audit 1-17)", () => {
  const gwWith = (list: PoncleRow[]) => ({
    check: async () => true,
    listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
    listOpen: async () => ({ ok: true, total: list.length, list }),
  });

  it("picks the exact phone match (latest opendate) over other customers' rows", async () => {
    const gw = gwWith([
      row("b", "010-9999-0000", "24-09-01"),
      row("a-old", "010-1111-2222", "22-01-01"),
      row("a-new", "010-1111-2222", "24-03-01"),
    ]);
    const out = await new PoncleClient(gw, cfg()).fetchOpenByPhone("010-1111-2222");
    expect(out?.idx).toBe("a-new");
  });

  it("returns null when no row's phone matches exactly (no fallback to another customer)", async () => {
    const gw = gwWith([row("b", "010-9999-0000", "24-09-01"), row("c", "010-1111-2223", "24-08-01")]);
    const out = await new PoncleClient(gw, cfg()).fetchOpenByPhone("010-1111-2222");
    expect(out).toBeNull();
  });

  it("matches across formatting differences (hyphens / spaces)", async () => {
    const gw = gwWith([row("b", "010-9999-0000", "24-09-01"), row("a", "010 1111 2222", "24-03-01")]);
    const out = await new PoncleClient(gw, cfg()).fetchOpenByPhone("01011112222");
    expect(out?.idx).toBe("a");
    const out2 = await new PoncleClient(gwWith([row("a", "01011112222", "24-03-01")]), cfg()).fetchOpenByPhone(
      "010-1111-2222",
    );
    expect(out2?.idx).toBe("a");
  });

  it("returns null for an empty result list", async () => {
    const out = await new PoncleClient(gwWith([]), cfg()).fetchOpenByPhone("010-1111-2222");
    expect(out).toBeNull();
  });
});

describe("searchCustomersWithTotal: first-page cap is visible (improvement 3-12)", () => {
  const gwWith = (total: number, list: PoncleRow[], calls: Array<Record<string, string>> = []) => ({
    check: async () => true,
    listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
    listOpen: async (p: Record<string, string>) => {
      calls.push(p);
      return { ok: true, total, list };
    },
  });

  it("returns the server total alongside the (first-page) list so the UI can show truncation", async () => {
    const list = Array.from({ length: 3 }, (_, i) => row(String(i), `010-0000-000${i}`, "24-01-01"));
    const calls: Array<Record<string, string>> = [];
    const out = await new PoncleClient(gwWith(250, list, calls), cfg({ page_size: 3 })).searchCustomersWithTotal(
      " 홍길동 ",
    );
    expect(out.list).toHaveLength(3);
    expect(out.total).toBe(250);
    expect(calls).toHaveLength(1); // still a single page request
    expect(calls[0].q).toBe("홍길동");
    expect(calls[0].start).toBe("0");
  });

  it("total never reads lower than the rows actually returned (bad/missing server total)", async () => {
    const list = [row("1", "010-1111-2222", "24-01-01"), row("2", "010-1111-3333", "24-01-01")];
    const out = await new PoncleClient(gwWith(0, list), cfg()).searchCustomersWithTotal("010-1111");
    expect(out.total).toBe(2);
  });

  it("L19: also returns the UNclamped server total so 'exactly page_size' is not read as cut off", async () => {
    const list = Array.from({ length: 3 }, (_, i) => row(String(i), `010-0000-000${i}`, "24-01-01"));
    const exact = await new PoncleClient(gwWith(3, list), cfg({ page_size: 3 })).searchCustomersWithTotal("홍길동");
    expect(exact.total).toBe(3);
    expect(exact.serverTotal).toBe(3);
    const missing = await new PoncleClient(gwWith(Number.NaN, list), cfg({ page_size: 3 })).searchCustomersWithTotal(
      "홍길동",
    );
    expect(missing.total).toBe(3); // clamped as before
    expect(missing.serverTotal).toBe(0); // missing / unparseable -> 0, never the clamp
    const more = await new PoncleClient(gwWith(250, list), cfg({ page_size: 3 })).searchCustomersWithTotal("홍길동");
    expect(more.serverTotal).toBe(250);
  });

  it("a query shorter than 2 chars makes no request and returns an empty result", async () => {
    const calls: Array<Record<string, string>> = [];
    const out = await new PoncleClient(gwWith(9, [row("1", "x", "24-01-01")], calls), cfg()).searchCustomersWithTotal(
      " a ",
    );
    expect(out).toEqual({ list: [], total: 0 });
    expect(calls).toHaveLength(0);
  });

  it("searchCustomers keeps returning just the list (backward compatible)", async () => {
    const list = [row("1", "010-1111-2222", "24-01-01")];
    const out = await new PoncleClient(gwWith(500, list), cfg()).searchCustomers("홍길동");
    expect(out).toEqual(list);
  });

  it("propagates SessionExpired like the scan fetches", async () => {
    const gw = {
      check: async () => false,
      listPending: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }),
      listOpen: async () => ({ ok: false, total: 0, list: [] as PoncleRow[], netError: false }),
    };
    await expect(new PoncleClient(gw, cfg()).searchCustomersWithTotal("홍길동")).rejects.toBeInstanceOf(
      SessionExpired,
    );
  });
});

describe("full-scan floor", () => {
  it("stops paging once rows pass the earliest floor", async () => {
    let pages = 0;
    const gw = {
      check: async () => true,
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
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

describe("paging survives an unparseable / zero total (improvement 3-7)", () => {
  /** A fake listOpen serving `rows` in pages, always reporting `total` (0 = native
   *  parse failure). Honors start/scale like the server. */
  const pagedGw = (rows: PoncleRow[], total: number, calls: Array<Record<string, string>> = []) => ({
    check: async () => true,
    listPending: async (p: Record<string, string>) => {
      calls.push(p);
      const start = Number(p.start);
      const scale = Number(p.scale);
      return { ok: true, total, list: rows.slice(start, start + scale) };
    },
    listOpen: async (p: Record<string, string>) => {
      calls.push(p);
      const start = Number(p.start);
      const scale = Number(p.scale);
      return { ok: true, total, list: rows.slice(start, start + scale) };
    },
  });
  const rows5 = [1, 2, 3, 4, 5].map((n) => row(String(n), `p${n}`, "24-06-15"));

  it("date-range fetch keeps paging while pages are full when total reads 0", async () => {
    const calls: Array<Record<string, string>> = [];
    const out = await new PoncleClient(pagedGw(rows5, 0, calls), cfg({ page_size: 2 })).fetchCandidates(BOUNDS);
    expect(out.map(rowKey).sort()).toEqual(["idx:1", "idx:2", "idx:3", "idx:4", "idx:5"]);
    expect(calls.length).toBe(3); // 2 + 2 + 1 (short page ends it)
  });

  it("date-range fetch with a valid total does not request past it", async () => {
    const rows4 = rows5.slice(0, 4);
    const calls: Array<Record<string, string>> = [];
    const out = await new PoncleClient(pagedGw(rows4, 4, calls), cfg({ page_size: 2 })).fetchCandidates(BOUNDS);
    expect(out.length).toBe(4);
    expect(calls.length).toBe(2);
  });

  it("full-scan fallback keeps paging while pages are full when total reads 0", async () => {
    const calls: Array<Record<string, string>> = [];
    const out = await new PoncleClient(
      pagedGw(rows5, 0, calls),
      cfg({ use_server_date_filter: false, page_size: 2 }),
    ).fetchCandidates({ sdate: "2024-01-01", edate: "2024-12-31" });
    expect(out.length).toBe(5);
    expect(calls.length).toBe(3);
  });

  it("fetchPending keeps paging while pages are full when total reads 0", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => row(`m${i}`, `p${i}`, "24-06-15"));
    const calls: Array<Record<string, string>> = [];
    const out = await new PoncleClient(pagedGw(many, 0, calls), cfg()).fetchPending();
    expect(out.length).toBe(1500);
    expect(calls.length).toBe(16); // 15 full pages of 100 + the empty page that ends it
  });

  it("fetchPending asks for a page size Poncle honors (100, not 1000)", async () => {
    const calls: Array<Record<string, string>> = [];
    await new PoncleClient(pagedGw([], 0, calls), cfg()).fetchPending();
    expect(calls[0]?.scale).toBe("100");
  });

  it("fetchPending keeps paging when the server returns fewer rows than asked but total says more", async () => {
    // Poncle caps / rewrites unsupported sizes (scale=1000 -> 500 rows, 300 -> 10):
    // a short page is NOT the last one while start < total (2026-11-17: 미결 661건 중
    // 일부만 받아 오늘 유지일 고객이 빠짐).
    const all = Array.from({ length: 661 }, (_, i) => row(`k${i}`, `p${i}`, "24-06-15"));
    const calls: Array<Record<string, string>> = [];
    const capped = {
      check: async () => true,
      listOpen: async () => ({ ok: true, total: 0, list: [] }),
      listPending: async (p: Record<string, string>) => {
        calls.push(p);
        const start = Number(p.start);
        return { ok: true, total: 661, list: all.slice(start, start + Math.min(Number(p.scale), 30)) };
      },
    };
    const out = await new PoncleClient(capped, cfg()).fetchPending();
    expect(out.length).toBe(661);
    expect(new Set(out.map(rowKey)).size).toBe(661);
  });

  it("the page cap still applies and reports the truncation", async () => {
    const endless = {
      check: async () => true,
      listPending: async () => ({ ok: true, total: 0, list: [row("x", "x", "24-06-15")] }),
      listOpen: async (p: Record<string, string>) => ({
        ok: true,
        total: 0,
        list: [row(`r${p.start}`, `p${p.start}`, "24-06-15")],
      }),
    };
    const truncated: Array<{ what: string; pages: number }> = [];
    const client = new PoncleClient(endless, cfg({ page_size: 1 }), {
      maxPages: 5,
      onTruncated: (what, pages) => truncated.push({ what, pages }),
    });
    const out = await client.fetchCandidates(BOUNDS);
    expect(out.length).toBe(5);
    expect(truncated).toEqual([{ what: "listOpen(range)", pages: 5 }]);
    expect(client.truncated).toBe(true);
  });

  it("no truncation notice when paging ends naturally", async () => {
    const truncated: string[] = [];
    const client = new PoncleClient(pagedGw(rows5, 0), cfg({ page_size: 2 }), {
      onTruncated: (what) => truncated.push(what),
    });
    await client.fetchCandidates(BOUNDS);
    expect(truncated).toEqual([]);
    expect(client.truncated).toBe(false);
  });
});

describe("search field matches Poncle's current form (s options: all/openphone/customer/…)", () => {
  // Poncle removed the old "customer-openphone" option; the server silently ignores
  // an unknown `s`, which returned the whole table for every search.
  const capture = () => {
    const calls: Array<Record<string, string>> = [];
    const gw = {
      check: async () => true,
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
      listOpen: async (p: Record<string, string>) => {
        calls.push(p);
        return { ok: true, total: 0, list: [] as PoncleRow[] };
      },
    };
    return { gw, calls };
  };

  it("phone join searches the openphone field", async () => {
    const { gw, calls } = capture();
    await new PoncleClient(gw, cfg()).fetchOpenByPhone("010-1111-2222");
    expect(calls[0].s).toBe("openphone");
    expect(calls[0].q).toBe("01011112222");
  });

  it("a digits query in 조회 searches openphone (digits only)", async () => {
    const { gw, calls } = capture();
    await new PoncleClient(gw, cfg()).searchCustomersWithTotal("010-2009-1027");
    expect(calls[0].s).toBe("openphone");
    expect(calls[0].q).toBe("01020091027");
  });

  it("a name query in 조회 searches the customer field", async () => {
    const { gw, calls } = capture();
    await new PoncleClient(gw, cfg()).searchCustomersWithTotal("홍길동");
    expect(calls[0].s).toBe("customer");
    expect(calls[0].q).toBe("홍길동");
  });

  it("never sends the retired customer-openphone value", async () => {
    const { gw, calls } = capture();
    await new PoncleClient(gw, cfg()).fetchCandidates(BOUNDS);
    for (const c of calls) expect(c.s).not.toBe("customer-openphone");
  });
});

describe("searchFieldFor +82 numbers", () => {
  it("rewrites +82 10 ... to the domestic 010 form", async () => {
    const { searchFieldFor } = await import("../src/domain/poncle-client");
    expect(searchFieldFor("+82 10-1234-5678")).toEqual({ s: "openphone", q: "01012345678" });
    expect(searchFieldFor("+821012345678")).toEqual({ s: "openphone", q: "01012345678" });
  });
  it("leaves domestic numbers and names alone", async () => {
    const { searchFieldFor } = await import("../src/domain/poncle-client");
    expect(searchFieldFor("010-1234-5678")).toEqual({ s: "openphone", q: "01012345678" });
    expect(searchFieldFor("8210")).toEqual({ s: "openphone", q: "8210" });
    expect(searchFieldFor("홍길동")).toEqual({ s: "customer", q: "홍길동" });
  });
  it("rewrites +82 010 ... too (audit L17: q was 8201012345678)", async () => {
    const { searchFieldFor } = await import("../src/domain/poncle-client");
    expect(searchFieldFor("+82 010-1234-5678")).toEqual({ s: "openphone", q: "01012345678" });
    expect(searchFieldFor("+8201012345678")).toEqual({ s: "openphone", q: "01012345678" });
  });
  it("a full bare 82… mobile number follows normalizeKrMobile (K3)", async () => {
    const { searchFieldFor } = await import("../src/domain/poncle-client");
    expect(searchFieldFor("821012345678")).toEqual({ s: "openphone", q: "01012345678" });
    expect(searchFieldFor("82 010 1234 5678")).toEqual({ s: "openphone", q: "01012345678" });
  });
  it("a partial +82 number keeps the domestic prefix rule (+82 then 1 -> 01)", async () => {
    const { searchFieldFor } = await import("../src/domain/poncle-client");
    expect(searchFieldFor("+82 10-1234")).toEqual({ s: "openphone", q: "0101234" });
    expect(searchFieldFor("+82 010-1234")).toEqual({ s: "openphone", q: "0101234" });
  });
  it("a '+' number that is not +82 is never rewritten to a domestic number (K3)", async () => {
    const { searchFieldFor } = await import("../src/domain/poncle-client");
    // Same rule as SmsPlugin.normalizeNumber: a foreign number is not a Korean
    // mobile, so its digits are searched as typed (never "0" + rest).
    expect(searchFieldFor("+1 202 555 0100")).toEqual({ s: "openphone", q: "12025550100" });
    expect(searchFieldFor("+01012345678").q).not.toBe("");
  });
});
