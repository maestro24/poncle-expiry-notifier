/**
 * nativePoncleGateway.check(): a transport failure (native netError) must NOT read
 * as "session expired" — it throws, so the boot/foreground session probe leaves
 * the state 'unknown' instead of showing the 재로그인 banner on a network blip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type ListRes = { ok: boolean; total: number; list: unknown[]; netError?: boolean; status?: number; serverDate?: unknown };

const ctl = vi.hoisted(() => ({
  res: { value: true } as { value: boolean; netError?: boolean; status?: number; serverDate?: unknown },
  list: { ok: true, total: 0, list: [] } as ListRes,
  logoutError: null as Error | null,
}));

vi.mock("../src/native/poncle", () => ({
  Poncle: {
    check: async () => ctl.res,
    listOpen: async () => ctl.list,
    listPending: async () => ctl.list,
    logout: async () => {
      if (ctl.logoutError) throw ctl.logoutError;
    },
  },
}));

import {
  lastClockSkewMs,
  lastServerDate,
  nativePoncleGateway,
  poncleLogout,
  resetServerClockForTest,
} from "../src/native/adapters";
import type { AppConfig } from "../src/domain/types";

const cfg = { poncle_base_url: "https://example.invalid" } as AppConfig;

describe("nativePoncleGateway.check", () => {
  beforeEach(() => {
    ctl.res = { value: true };
  });

  it("resolves true when the probe returns data", async () => {
    await expect(nativePoncleGateway(cfg).check()).resolves.toBe(true);
  });

  it("resolves false for a real session expiry (response, no data)", async () => {
    ctl.res = { value: false, netError: false };
    await expect(nativePoncleGateway(cfg).check()).resolves.toBe(false);
  });

  it("rejects on a transport failure so the caller can treat it as unknown", async () => {
    ctl.res = { value: false, netError: true };
    await expect(nativePoncleGateway(cfg).check()).rejects.toThrow();
  });

  it("rejects on a transient server status (5xx / 408 / 429) even without netError (audit 1-18)", async () => {
    for (const status of [500, 503, 408, 429]) {
      ctl.res = { value: false, netError: false, status };
      await expect(nativePoncleGateway(cfg).check()).rejects.toThrow();
    }
  });

  it("401 / 403 still resolve false (session expired)", async () => {
    for (const status of [401, 403]) {
      ctl.res = { value: false, netError: false, status };
      await expect(nativePoncleGateway(cfg).check()).resolves.toBe(false);
    }
  });

  it("an older native build without netError keeps the boolean contract", async () => {
    ctl.res = { value: false };
    await expect(nativePoncleGateway(cfg).check()).resolves.toBe(false);
  });
});

describe("server Date capture (improvement 3-16)", () => {
  beforeEach(() => {
    resetServerClockForTest();
    ctl.res = { value: true };
    ctl.list = { ok: true, total: 0, list: [] };
  });

  it("is null before any Poncle response", () => {
    expect(lastServerDate()).toBeNull();
    expect(lastClockSkewMs()).toBeNull();
  });

  it("records serverDate from check()", async () => {
    ctl.res = { value: true, serverDate: "2026-11-16T03:00:00Z" };
    await nativePoncleGateway(cfg).check();
    expect(lastServerDate()).toBe("2026-11-16T03:00:00.000Z");
  });

  it("records serverDate from list responses (open and pending)", async () => {
    ctl.list = { ok: true, total: 0, list: [], serverDate: "2026-11-16T04:00:00Z" };
    await nativePoncleGateway(cfg).listOpen({});
    expect(lastServerDate()).toBe("2026-11-16T04:00:00.000Z");
    ctl.list = { ok: true, total: 0, list: [], serverDate: "2026-11-16T05:00:00Z" };
    await nativePoncleGateway(cfg).listPending({});
    expect(lastServerDate()).toBe("2026-11-16T05:00:00.000Z");
  });

  it("records serverDate even when check() then throws for a transient status", async () => {
    ctl.res = { value: false, status: 503, serverDate: "2026-11-16T06:00:00Z" };
    await expect(nativePoncleGateway(cfg).check()).rejects.toThrow();
    expect(lastServerDate()).toBe("2026-11-16T06:00:00.000Z");
  });

  it("ignores a missing / garbage serverDate and keeps the last good one", async () => {
    ctl.res = { value: true, serverDate: "2026-11-16T03:00:00Z" };
    await nativePoncleGateway(cfg).check();
    for (const bad of [undefined, "", "not a date", 12345, null]) {
      ctl.res = { value: true, serverDate: bad };
      await nativePoncleGateway(cfg).check();
    }
    expect(lastServerDate()).toBe("2026-11-16T03:00:00.000Z");
  });

  it("lastClockSkewMs = server time minus device time at observation", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-14T03:00:00Z")); // device 2 days behind
      ctl.res = { value: true, serverDate: "2026-11-16T03:00:00Z" };
      await nativePoncleGateway(cfg).check();
      expect(lastClockSkewMs()).toBe(2 * 86_400_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("poncleLogout (audit B13)", () => {
  beforeEach(() => {
    ctl.logoutError = null;
  });

  it("resolves when the native side confirmed the Gecko cookies were cleared", async () => {
    await expect(poncleLogout(cfg)).resolves.toBeUndefined();
  });

  it("rejects when the native clear could not be confirmed (UI must not say 로그아웃됨)", async () => {
    ctl.logoutError = new Error("logout failed");
    await expect(poncleLogout(cfg)).rejects.toThrow("logout failed");
  });
});
