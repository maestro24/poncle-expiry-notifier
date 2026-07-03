import { describe, expect, it } from "vitest";
import { DEFAULTS, deepMerge, migrate, withDefaults } from "../src/domain/config";

const OLD_DEFAULT_TEMPLATE =
  "[약정만료] {customer}님 ({phone}) 2년 약정 만료 {when}. " +
  "개통 {opendate} · {telecom} · {agency}";

describe("migrate", () => {
  it("prunes removed keys (channels/term_overrides/skip_zero_term)", () => {
    const out = migrate({ channels: { desktop_toast: true }, message_template: "hi" });
    expect(out).not.toHaveProperty("channels");
  });
  it("prunes PC-only keys", () => {
    const out = migrate({ run_on_startup: true, autostart_enabled: true, phone_remote_enabled: true });
    expect(out).not.toHaveProperty("run_on_startup");
    expect(out).not.toHaveProperty("autostart_enabled");
    expect(out).not.toHaveProperty("phone_remote_enabled");
  });
  it("upgrades un-customized old default template", () => {
    const out = migrate({ message_template: OLD_DEFAULT_TEMPLATE });
    expect(out.message_template).toBe(DEFAULTS.message_template);
  });
  it("preserves a custom template", () => {
    const custom = "안녕하세요 {customer}님, 직접 쓴 문구입니다.";
    expect(migrate({ message_template: custom }).message_template).toBe(custom);
  });
  it("shipped default is customer-facing", () => {
    expect(DEFAULTS.message_template).toContain("{customer}");
    expect(DEFAULTS.message_template).not.toContain("[약정만료]");
  });
});

describe("deepMerge / withDefaults", () => {
  it("stored values override defaults, unknown defaults preserved", () => {
    const c = withDefaults({ default_term_months: 12, agency_term_months: { CD대리점: 9 } });
    expect(c.default_term_months).toBe(12);
    expect(c.nonstandard_term_months).toBe(6); // default kept
    expect(c.agency_term_months).toEqual({ CD대리점: 9 });
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
