/**
 * K1 / audit L43: the send history (sent_log) is written through a native
 * commit()-backed store, with a read-through migration from Capacitor
 * Preferences so nothing is lost on the upgrade to 1.2.17.
 */
import { describe, expect, it } from "vitest";
import { createDurableKV, type DurableKVNative } from "../src/native/adapters";
import type { KV } from "../src/domain/history";

function memKV(init: Record<string, string> = {}): KV & { data: Map<string, string>; sets: number } {
  const data = new Map(Object.entries(init));
  const kv = {
    data,
    sets: 0,
    async get(key: string) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    async set(key: string, value: string) {
      kv.sets++;
      data.set(key, value);
    },
  };
  return kv;
}

function fakeNative(init: Record<string, string> = {}): DurableKVNative & { data: Map<string, string>; sets: number } {
  const data = new Map(Object.entries(init));
  const n = {
    data,
    sets: 0,
    async get({ key }: { key: string }) {
      return { value: data.has(key) ? (data.get(key) as string) : null };
    },
    async set({ key, value }: { key: string; value: string }) {
      n.sets++;
      data.set(key, value);
      return { ok: true };
    },
  };
  return n;
}

describe("createDurableKV", () => {
  it("falls back to the legacy store when the native plugin is unavailable (web)", async () => {
    const legacy = memKV({ sent_log: "[1]" });
    const kv = createDurableKV(null, legacy);
    expect(await kv.get("sent_log")).toBe("[1]");
    await kv.set("sent_log", "[2]");
    expect(legacy.data.get("sent_log")).toBe("[2]");
  });

  it("migrates an existing Preferences value on first read and keeps the old copy", async () => {
    const legacy = memKV({ sent_log: "[old]" });
    const native = fakeNative();
    const kv = createDurableKV(native, legacy);
    expect(await kv.get("sent_log")).toBe("[old]");
    expect(native.data.get("sent_log")).toBe("[old]");
    expect(legacy.data.get("sent_log")).toBe("[old]"); // never deleted
  });

  it("prefers the durable copy once it exists", async () => {
    const legacy = memKV({ sent_log: "[stale]" });
    const native = fakeNative({ sent_log: "[fresh]" });
    const kv = createDurableKV(native, legacy);
    expect(await kv.get("sent_log")).toBe("[fresh]");
    expect(native.sets).toBe(0);
  });

  it("writes go to the durable store only", async () => {
    const legacy = memKV();
    const native = fakeNative();
    const kv = createDurableKV(native, legacy);
    await kv.set("sent_log", "[a]");
    expect(native.data.get("sent_log")).toBe("[a]");
    expect(legacy.sets).toBe(0);
  });

  it("a write racing the first read is never overwritten by the migration", async () => {
    const legacy = memKV({ sent_log: "[old]" });
    const native = fakeNative();
    const kv = createDurableKV(native, legacy);
    const read = kv.get("sent_log");
    const write = kv.set("sent_log", "[new]");
    await Promise.all([read, write]);
    expect(native.data.get("sent_log")).toBe("[new]");
    expect(await kv.get("sent_log")).toBe("[new]");
  });

  it("a write before any read still migrates nothing over it", async () => {
    const legacy = memKV({ sent_log: "[old]" });
    const native = fakeNative();
    const kv = createDurableKV(native, legacy);
    await kv.set("sent_log", "[new]");
    expect(await kv.get("sent_log")).toBe("[new]");
  });

  it("nothing anywhere reads as null", async () => {
    const kv = createDurableKV(fakeNative(), memKV());
    expect(await kv.get("sent_log")).toBeNull();
  });

  it("a failed durable write rejects (the caller must not think it was saved)", async () => {
    const native = fakeNative();
    native.set = async () => {
      throw new Error("commit failed");
    };
    const kv = createDurableKV(native, memKV());
    await expect(kv.set("sent_log", "[x]")).rejects.toThrow();
  });

  it("a native set that reports ok:false rejects", async () => {
    const native = fakeNative();
    native.set = async () => ({ ok: false });
    const kv = createDurableKV(native, memKV());
    await expect(kv.set("sent_log", "[x]")).rejects.toThrow();
  });
});
