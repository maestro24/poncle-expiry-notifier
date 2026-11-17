/**
 * #56 (audit 3-7): when a paging safety cap cuts a fetch short, the scan result says
 * so (`truncated`), so the home screen can tell the user the list may be incomplete.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/domain/config";
import { History, KV } from "../src/domain/history";
import { makeDate } from "../src/domain/plaindate";
import { runScan } from "../src/domain/scan";
import type { AppConfig, PoncleRow } from "../src/domain/types";

function memKV(): KV {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}
const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULTS, ...over });
const TODAY = makeDate(2026, 7, 3);

/** listOpen always answers a FULL page with an unparseable (0) total. */
function endlessGateway() {
  let n = 0;
  return {
    check: async () => true,
    listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
    listOpen: async (p: Record<string, string>) => {
      const scale = Number(p.scale) || 100;
      const list: PoncleRow[] = Array.from({ length: scale }, () => {
        n++;
        return { idx: String(n), openphone: `010-1000-${String(n % 10000).padStart(4, "0")}`, opendate: "20-01-01", openhowx: "기변" };
      });
      return { ok: true, total: 0, list };
    },
  };
}

describe("runScan reports a paging-cap truncation (#56)", () => {
  it("truncated = true when the cap stopped a fetch that still had full pages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await runScan(endlessGateway(), cfg(), new History(memKV()), TODAY, { maxPages: 3 });
    expect(res.status).toBe("ok");
    expect(res.truncated).toBe(true);
    warn.mockRestore();
  });

  it("truncated = false on a normal scan", async () => {
    const gw = {
      check: async () => true,
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
      listOpen: async () => ({ ok: true, total: 1, list: [{ openphone: "010-1111-2222", opendate: "24-07-03", openhowx: "기변" }] }),
    };
    const res = await runScan(gw, cfg({ use_server_date_filter: false }), new History(memKV()), TODAY);
    expect(res.truncated).toBe(false);
  });
});

/* L4 (audit 2026-11-17): a cut-off scan is as unreliable as a degraded 미결 fetch —
 * the 유지일 blacklist / expired set may be incomplete, so Pass B dates are flagged
 * (sending blocked) and the 재방문 코호트 is not rewritten from a partial list. */
describe("L4: a truncated scan is handled like a degraded one", () => {
  const usimRow: PoncleRow = { idx: "u1", openphone: "010-6666-7777", opendate: "26-01-03", openhowx: "유심신규" }; // Pass B 2026-07-03
  const termRow: PoncleRow = { idx: "t1", openphone: "010-1111-2222", opendate: "24-07-03", openhowx: "기변" }; // term 2026-07-03

  it("a cut-off 미결 list flags Pass B items degraded and skips the cohort write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const gw = {
      check: async () => true,
      // Endless full pages with an unparseable total: the paging cap cuts it short.
      listPending: async (p: Record<string, string>) => {
        const scale = Number(p.scale) || 100;
        const list: PoncleRow[] = Array.from({ length: scale }, () => {
          n++;
          return { idx: `p${n}`, openphone: `010-9000-${String(n % 10000).padStart(4, "0")}` };
        });
        return { ok: true, total: 0, list };
      },
      listOpen: async () => ({ ok: true, total: 2, list: [usimRow, termRow] }),
    };
    const h = new History(memKV());
    const save = vi.spyOn(h, "saveCohort");
    const res = await runScan(gw, cfg({ use_server_date_filter: false }), h, TODAY, { maxPages: 3 });
    expect(res.status).toBe("ok");
    expect(res.truncated).toBe(true);
    const by = Object.fromEntries(res.results.map((r) => [r.phone, r]));
    expect(by["010-6666-7777"].degraded).toBe(true);
    expect(by["010-1111-2222"].degraded).toBeFalsy();
    expect(save).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a cut-off open list does not rewrite the cohort either", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = new History(memKV());
    const save = vi.spyOn(h, "saveCohort");
    const res = await runScan(endlessGateway(), cfg(), h, TODAY, { maxPages: 3 });
    expect(res.truncated).toBe(true);
    expect(save).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a complete scan still writes the cohort and flags nothing", async () => {
    const gw = {
      check: async () => true,
      listPending: async () => ({ ok: true, total: 0, list: [] as PoncleRow[] }),
      listOpen: async () => ({ ok: true, total: 2, list: [usimRow, termRow] }),
    };
    const h = new History(memKV());
    const save = vi.spyOn(h, "saveCohort");
    const res = await runScan(gw, cfg({ use_server_date_filter: false }), h, TODAY);
    expect(res.truncated).toBe(false);
    expect(res.results.every((r) => !r.degraded)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
