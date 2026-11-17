/**
 * #50 (3-14): History mutations are read-modify-write over one JSON blob. With a
 * slow storage backend, concurrent writes started together (Promise.all) must all
 * land — none may be lost to an interleaved read of a stale snapshot.
 */
import { describe, expect, it } from "vitest";
import { History, type KV, type SentRecord } from "../src/domain/history";

/** In-memory KV whose get/set each take a different, random-ish delay. */
function slowKV(): KV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  let n = 0;
  const wait = () => new Promise<void>((r) => setTimeout(r, (n++ * 7) % 5));
  return {
    map,
    async get(k) { await wait(); return map.get(k) ?? null; },
    async set(k, v) { await wait(); map.set(k, v); },
  };
}

const rec = (i: number, over: Partial<SentRecord> = {}): SentRecord => ({
  phone: `010-1000-${String(1000 + i)}`, customer: `고객${i}`, opendate: "24-07-03", expiry_date: "2026-07-03",
  milestone_offset: 0, telecom: "KT", agency: "", plan: "", model: "", openhow: "기변", staff: "",
  channel: "sms", sent_at: `2026-07-01T09:00:${String(i % 60).padStart(2, "0")}`, ...over,
});

describe("History concurrent writes (#50)", () => {
  it("20 parallel putRecord calls all persist", async () => {
    const h = new History(slowKV());
    await Promise.all(Array.from({ length: 20 }, (_, i) => h.putRecord(rec(i))));
    expect(await h.exportAll()).toHaveLength(20);
  });

  it("mixed parallel writes (put, recordSent, applySendResults, remove) don't lose each other", async () => {
    const h = new History(slowKV());
    await h.putRecord(rec(0, { sms_id: "a" }));
    await h.putRecord(rec(1));
    await Promise.all([
      h.putRecord(rec(2)),
      h.recordSent({ ...rec(3) }, "record-only", "2026-07-01T10:00:00"),
      h.applySendResults([{ id: "a", status: "fail", reason: "신호 없음", at: "2026-07-01T09:01:00" }]),
      h.remove(rec(1).phone, rec(1).expiry_date),
      h.putRecord(rec(4)),
    ]);
    const all = await h.exportAll();
    expect(all.map((r) => r.customer).sort()).toEqual(["고객0", "고객2", "고객3", "고객4"]);
    expect(all.find((r) => r.customer === "고객0")?.delivery).toBe("failed");
  });

  it("parallel 제외 toggles and a restore (replaceAll) are serialized too", async () => {
    const h = new History(slowKV());
    await Promise.all(Array.from({ length: 10 }, (_, i) => h.setHandled(`010-2000-${1000 + i}`, "2026-05-01", true)));
    expect((await h.handledKeys()).size).toBe(10);
    await Promise.all([h.replaceAll([rec(7)]), h.putRecord(rec(8))]);
    expect((await h.exportAll()).map((r) => r.customer).sort()).toEqual(["고객7", "고객8"]);
  });
});
