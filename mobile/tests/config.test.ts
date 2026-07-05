import { describe, expect, it } from "vitest";
import { DEFAULTS, deepMerge, migrate, withDefaults } from "../src/domain/config";

describe("migrate", () => {
  it("prunes removed keys (channels/term_overrides/skip_zero_term)", () => {
    const out = migrate({ channels: { desktop_toast: true } });
    expect(out).not.toHaveProperty("channels");
  });
  it("prunes PC-only keys", () => {
    const out = migrate({ run_on_startup: true, autostart_enabled: true, phone_remote_enabled: true });
    expect(out).not.toHaveProperty("run_on_startup");
    expect(out).not.toHaveProperty("autostart_enabled");
    expect(out).not.toHaveProperty("phone_remote_enabled");
  });
  it("drops the retired fixed templates", () => {
    const out = migrate({ message_template: "old", message_template_nonstandard: "old2" });
    expect(out).not.toHaveProperty("message_template");
    expect(out).not.toHaveProperty("message_template_nonstandard");
  });
  it("drops the retired 거래처 약정 오버라이드 / 비표준 약정 개월 (2단계 개편)", () => {
    const out = migrate({ agency_term_months: { CD대리점: 9 }, nonstandard_term_months: 6 });
    expect(out).not.toHaveProperty("agency_term_months");
    expect(out).not.toHaveProperty("nonstandard_term_months");
  });
  it("ships an empty template list by default", () => {
    expect(DEFAULTS.templates).toEqual([]);
  });
});

describe("deepMerge / withDefaults", () => {
  it("stored values override defaults, unknown defaults preserved", () => {
    const c = withDefaults({ default_term_months: 12 });
    expect(c.default_term_months).toBe(12);
    expect(c.keepdate_default_months).toBe(6); // default kept
  });
  it("arrays replace, not merge", () => {
    const c = withDefaults({ notify_offsets_days: [0, 7, 30] });
    expect(c.notify_offsets_days).toEqual([0, 7, 30]);
  });
  it("deepMerge does not mutate base", () => {
    const base = { a: { b: 1 } };
    const out = deepMerge(base, { a: { c: 2 } });
    expect(out).toEqual({ a: { b: 1, c: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });
});
