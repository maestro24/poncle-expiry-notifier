// @vitest-environment happy-dom
/**
 * Stage R2 (LOW) UI helpers: the history KV routing to the durable store (K1/L43),
 * home phone search (L16), the 조회 cut-off notice from the unclamped server total
 * (L19), the dashboard 임박 list (L24) and the toast queue behind an undo (L28).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIso } from "../src/domain/plaindate";
import type { KV } from "../src/domain/history";
import type { DueItem } from "../src/domain/types";
import { DURABLE_HISTORY_KEYS, resolveDurableKV, routeHistoryKV } from "../src/app/history-kv";
import { phoneQueryDigits, matchesDueQuery } from "../src/ui/phone-query";
import { lookupTruncation } from "../src/ui/lookup-trunc";
import { dashboardSoon, unvisitedNotDue } from "../src/ui/dashboard-soon";

function memKV(seed: Record<string, string> = {}): KV & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
  };
}

describe("routeHistoryKV (K1/L43)", () => {
  it("sends the sent_log key to the durable store and everything else to the base store", async () => {
    const base = memKV();
    const durable = memKV();
    const kv = routeHistoryKV(base, durable);
    await kv.set("sent_log", "[1]");
    await kv.set("unvisited_handled", "[]");
    expect(durable.data.get("sent_log")).toBe("[1]");
    expect(base.data.has("sent_log")).toBe(false);
    expect(base.data.get("unvisited_handled")).toBe("[]");
    expect(durable.data.has("unvisited_handled")).toBe(false);
    expect(await kv.get("sent_log")).toBe("[1]");
    expect(await kv.get("unvisited_handled")).toBe("[]");
  });

  it("without a durable store (web / older native build) everything stays on the base store", async () => {
    const base = memKV({ sent_log: "[old]" });
    const kv = routeHistoryKV(base, null);
    expect(await kv.get("sent_log")).toBe("[old]");
    await kv.set("sent_log", "[new]");
    expect(base.data.get("sent_log")).toBe("[new]");
  });

  it("only the send history is routed", () => {
    expect(DURABLE_HISTORY_KEYS).toEqual(["sent_log"]);
  });

  it("resolveDurableKV uses the adapter's durableKV() when present", async () => {
    const durable = memKV();
    expect(resolveDurableKV({ durableKV: () => durable })).toBe(durable);
  });

  it("resolveDurableKV is null when the adapter has none, throws, or returns junk", () => {
    expect(resolveDurableKV({})).toBeNull();
    expect(resolveDurableKV(null)).toBeNull();
    expect(resolveDurableKV({ durableKV: () => { throw new Error("no plugin"); } })).toBeNull();
    expect(resolveDurableKV({ durableKV: () => ({ get: 1 }) })).toBeNull();
    // a vitest mock module throws on a missing export: never let that escape
    const throwing = new Proxy({}, { get() { throw new Error("No export"); } });
    expect(resolveDurableKV(throwing)).toBeNull();
  });
});

describe("home phone search (L16)", () => {
  it("phone-looking queries compare by digits (domestic form)", () => {
    expect(phoneQueryDigits("01011112222")).toBe("01011112222");
    expect(phoneQueryDigits("010-1111-2222")).toBe("01011112222");
    expect(phoneQueryDigits("1111 2222")).toBe("11112222");
    expect(phoneQueryDigits("+82 10-1111-2222")).toBe("01011112222");
    expect(phoneQueryDigits("+82 010-1111-2222")).toBe("01011112222");
  });
  it("names and non-phone text have no digit form; '+' that is not +82 is not a domestic number (K3)", () => {
    expect(phoneQueryDigits("홍길동")).toBe("");
    expect(phoneQueryDigits("12")).toBe("");
    expect(phoneQueryDigits("+1 010-1111-2222")).toBe("");
  });
  it("matchesDueQuery finds '01011112222' in '010-1111-2222' and still matches names", () => {
    const row = { customer: "홍길동", phone: "010-1111-2222" };
    expect(matchesDueQuery(row, "01011112222")).toBe(true);
    expect(matchesDueQuery(row, "1111-2222")).toBe(true);
    expect(matchesDueQuery(row, "+82 10 1111 2222")).toBe(true);
    expect(matchesDueQuery(row, "길동")).toBe(true);
    expect(matchesDueQuery(row, "")).toBe(true);
    expect(matchesDueQuery(row, "01099998888")).toBe(false);
    expect(matchesDueQuery(row, "김철수")).toBe(false);
  });
});

describe("lookupTruncation (L19)", () => {
  it("the server's own total above what came back -> 'N건 중 M건'", () => {
    expect(lookupTruncation(100, 250, 100, 250)).toEqual({ shown: 100, total: 250 });
  });
  it("a full page whose server total is exactly that page is NOT cut off", () => {
    expect(lookupTruncation(100, 100, 100, 100)).toBeNull();
  });
  it("a full page without a usable server total keeps the 'may be more' notice (3-12)", () => {
    expect(lookupTruncation(100, 100, 100, 0)).toEqual({ shown: 100, total: null });
    expect(lookupTruncation(100, 100, 100, Number.NaN)).toEqual({ shown: 100, total: null });
  });
  it("a short result is never cut off", () => {
    expect(lookupTruncation(3, 3, 100, 3)).toBeNull();
    expect(lookupTruncation(3, 3, 100, 0)).toBeNull();
  });
  it("older domain (no unclamped total): previous behaviour", () => {
    expect(lookupTruncation(100, 250, 100)).toEqual({ shown: 100, total: 250 });
    expect(lookupTruncation(100, 100, 100)).toEqual({ shown: 100, total: null });
    expect(lookupTruncation(5, 5, 100)).toBeNull();
  });
});

describe("dashboard 임박 고객 (L24)", () => {
  const today = parseIso("2026-07-10")!;
  const row = (id: string, expiry: string, extra: Partial<DueItem> = {}): DueItem => ({
    id, phone: id, customer: id, opendate: "24-07-10", expiry_date: expiry, milestone_offset: 0,
    telecom: "", agency: "", openhow: "기변", plan: "", model: "", staff: "", already_sent: false,
    source: "term", ...extra,
  } as DueItem);

  it("already sent customers are not 임박", () => {
    const soon = dashboardSoon([row("a", "2026-07-11"), row("b", "2026-07-11", { already_sent: true })], today);
    expect(soon.map((x) => x.r.id)).toEqual(["a"]);
  });
  it("unsent D+N rows (catch-up) are included, most overdue first", () => {
    const soon = dashboardSoon([row("d3", "2026-07-13"), row("p2", "2026-07-08"), row("d0", "2026-07-10")], today);
    expect(soon.map((x) => [x.r.id, x.dd])).toEqual([["p2", -2], ["d0", 0], ["d3", 3]]);
  });
  it("beyond D-3 or past the catch-up window is not listed; test rows never", () => {
    const soon = dashboardSoon([
      row("d4", "2026-07-14"), row("old", "2026-06-20"), row("t", "2026-07-10", { test: true }),
    ], today);
    expect(soon).toEqual([]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`r${i}`, "2026-07-11"));
    expect(dashboardSoon(many, today).length).toBe(6);
  });
  it("the 미방문 count leaves out customers already on the due list (no double count)", () => {
    const due = [row("010|2026-07-08", "2026-07-08")];
    const unv = [row("010|2026-07-08", "2026-07-08"), row("011|2026-06-01", "2026-06-01")];
    expect(unvisitedNotDue(unv, due).map((r) => r.id)).toEqual(["011|2026-06-01"]);
  });
});

describe("toast queue behind an undo toast (L28)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="toast" class="toast hidden"></div>`;
    vi.resetModules();
  });
  afterEach(() => vi.useRealTimers());
  const el = () => document.querySelector("#toast") as HTMLElement;

  it("a plain toast waits while the undo toast is up, then shows", async () => {
    const { toast } = await import("../src/app/dom");
    const undo = vi.fn();
    toast("미방문 목록에서 제외했습니다", { undo });
    toast("저장되었습니다");
    expect(el().textContent).toContain("제외했습니다");
    expect(el().querySelector(".toast-undo")).toBeTruthy();
    vi.advanceTimersByTime(6000);
    expect(el().textContent).toBe("저장되었습니다");
    expect(el().classList.contains("hidden")).toBe(false);
    vi.advanceTimersByTime(2600);
    expect(el().classList.contains("hidden")).toBe(true);
    expect(undo).not.toHaveBeenCalled();
  });

  it("tapping 실행취소 runs the undo and then shows the queued toast", async () => {
    const { toast } = await import("../src/app/dom");
    const undo = vi.fn();
    toast("삭제했습니다", { undo });
    toast("다음 안내", { err: true });
    (el().querySelector(".toast-undo") as HTMLButtonElement).click();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(el().textContent).toBe("다음 안내");
    expect(el().className).toContain("err");
  });

  it("without an undo on screen, a new toast replaces the old one at once", async () => {
    const { toast } = await import("../src/app/dom");
    toast("하나");
    toast("둘");
    expect(el().textContent).toBe("둘");
  });
});
