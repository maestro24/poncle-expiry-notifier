import { describe, expect, it } from "vitest";
import {
  DEFAULTS, DEFAULT_TEMPLATES, clampTermInput, deepMerge, migrate, migrateTemplateList, prepareRestoredConfig,
  LEGACY_DEFAULT_TEMPLATE_BODIES, restoreConfig, upgradeUntouchedDefaultTemplates, validateRestoredConfig, withDefaults,
} from "../src/domain/config";

describe("clampTermInput (#39: 약정 개월 입력 범위)", () => {
  it("keeps an in-range integer with no message", () => {
    expect(clampTermInput("default_term_months", "24", 24)).toEqual({ value: 24, message: null });
    expect(clampTermInput("keepdate_default_months", "0", 6)).toEqual({ value: 0, message: null });
    expect(clampTermInput("unvisited_lookback_months", "36", 6)).toEqual({ value: 36, message: null });
  });
  it("clamps out-of-range values and says so", () => {
    const hi = clampTermInput("default_term_months", "240", 24);
    expect(hi.value).toBe(60);
    expect(hi.message).toContain("1~60");
    const lo = clampTermInput("default_term_months", "-24", 24);
    expect(lo.value).toBe(1);
    expect(lo.message).toContain("1개월로");
    expect(clampTermInput("keepdate_default_months", "61", 6).value).toBe(60);
    expect(clampTermInput("unvisited_lookback_months", "99", 6).value).toBe(36);
    expect(clampTermInput("unvisited_lookback_months", "-1", 6).value).toBe(0);
  });
  it("blank / non-numeric input keeps the current value with a message", () => {
    const r = clampTermInput("default_term_months", "", 30);
    expect(r.value).toBe(30);
    expect(r.message).toContain("숫자");
    expect(clampTermInput("default_term_months", "abc", 30).value).toBe(30);
  });
  it("drops a fractional part", () => {
    expect(clampTermInput("default_term_months", "24.7", 24).value).toBe(24);
  });
});

describe("validateRestoredConfig / restoreConfig (#41: restored field types)", () => {
  it("drops wrongly typed fields ('false' string is not a boolean, a non-array list)", () => {
    const { valid, dropped } = validateRestoredConfig({
      deliver_alerts: "false",
      notify_offsets_days: "30",
      default_term_months: "24",
      templates: { not: "an array" },
      keepdate_default_months: 6,
    });
    expect(dropped.sort()).toEqual(["default_term_months", "deliver_alerts", "notify_offsets_days", "templates"].sort());
    expect(valid).toEqual({ keepdate_default_months: 6 });
  });
  it("drops out-of-range months and bad offsets", () => {
    const { dropped } = validateRestoredConfig({
      default_term_months: 240, unvisited_lookback_months: -3, notify_offsets_days: [30, "x"], page_size: 0,
    });
    expect(dropped.sort()).toEqual(["default_term_months", "notify_offsets_days", "page_size", "unvisited_lookback_months"].sort());
  });
  it("accepts a well-formed config untouched", () => {
    const { valid, dropped } = validateRestoredConfig({
      deliver_alerts: true, notify_offsets_days: [30], default_term_months: 36, keepdate_default_months: 0,
      unvisited_lookback_months: 12, run_time: "09:00", templates: [],
    });
    expect(dropped).toEqual([]);
    expect(valid.deliver_alerts).toBe(true);
    expect(valid.default_term_months).toBe(36);
  });
  it("a non-object config is all dropped (nothing applied)", () => {
    expect(validateRestoredConfig("x")).toEqual({ valid: {}, dropped: [] });
  });
  it("restoreConfig keeps THIS phone's value for every dropped field", () => {
    const current = { ...DEFAULTS, deliver_alerts: false, default_term_months: 30, templates: [] };
    const { config, dropped } = restoreConfig(
      { deliver_alerts: "false", default_term_months: 36, templates: 5 },
      current,
    );
    expect(dropped.sort()).toEqual(["deliver_alerts", "templates"]);
    expect(config.deliver_alerts).toBe(false); // NOT turned on by the truthy string
    expect(config.default_term_months).toBe(36); // valid field applied
    expect(config.templates).toEqual([]); // kept, no .map crash
  });
});

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

/* ---------------- P1 stage 2: restored config (1-24, L5) ---------------- */
describe("migrateTemplateList (1-24: an old backup must not resurrect retired defaults)", () => {
  const user = { id: "tpl_mine", name: "내 문구", telecoms: [], statuses: [], body: "x" };
  it("a v1 backup (retired default ids) gets the retired ids dropped and the v2 defaults injected", () => {
    const v1 = [
      { id: "default-usim", name: "old usim", telecoms: [], statuses: [], body: "old" },
      { id: "default-newmnp", name: "old newmnp", telecoms: [], statuses: [], body: "1년전 … 약정이 종료되어" },
      user,
    ];
    const out = migrateTemplateList(v1);
    const ids = out.map((t) => t.id);
    expect(ids).not.toContain("default-usim");
    expect(ids).not.toContain("default-newmnp");
    expect(ids).toContain("tpl_mine");
    for (const d of DEFAULT_TEMPLATES) expect(ids).toContain(d.id);
  });
  it("a v1 backup with only the user's own (source-less) templates also gets the v2 defaults", () => {
    const ids = migrateTemplateList([user]).map((t) => t.id);
    expect(ids).toEqual(["tpl_mine", ...DEFAULT_TEMPLATES.map((t) => t.id)]);
  });
  it("a v2 backup is kept as-is (user deletions/edits of defaults are respected)", () => {
    const v2 = [{ ...user, sources: ["term"] }, { ...DEFAULT_TEMPLATES[0], body: "수정한 문구" }];
    expect(migrateTemplateList(v2)).toEqual(v2);
    expect(migrateTemplateList([])).toEqual([]);
  });
  it("drops malformed entries and coerces condition arrays (no .map crash later)", () => {
    const out = migrateTemplateList([null, "x", { id: 1 }, { id: "a", name: "n", body: "b", telecoms: "KT", statuses: null, sources: ["term", 5] }]);
    expect(out).toEqual([{ id: "a", name: "n", body: "b", telecoms: [], statuses: [], sources: ["term"] }]);
    expect(migrateTemplateList("nope")).toEqual([]);
  });
  it("maps the v1.1.0 telecom codes SK/LG instead of dropping the template (review: L20 regression)", () => {
    const legacy = [
      { id: "mine", name: "SK 문구", telecoms: ["SK"], statuses: [], sources: ["term"], body: "내 문구" },
      { id: "both", name: "", telecoms: ["LG", "KT", "SK", "SK텔레콤"], statuses: [], sources: [], body: "b" },
    ];
    const out = migrateTemplateList(legacy, true);
    expect(out.map((t) => t.id)).toEqual(["mine", "both"]);
    expect(out[0].telecoms).toEqual(["SK텔레콤"]);
    expect(out[0].body).toBe("내 문구");
    expect(out[1].telecoms).toEqual(["LG유플러스", "KT", "SK텔레콤"]);
  });
  it("still drops a template whose telecoms are all unknown (never widened to 모든 통신사)", () => {
    expect(migrateTemplateList([{ id: "x", name: "", telecoms: ["XYZ"], statuses: [], sources: [], body: "b" }], true)).toEqual([]);
  });
});

describe("prepareRestoredConfig", () => {
  it("migrates templates and keeps THIS device's test_phone (L5)", () => {
    const restored = { deliver_alerts: true, test_phone: "010-9", templates: [{ id: "default-usim", name: "", telecoms: [], statuses: [], body: "x" }] };
    const out = prepareRestoredConfig(restored as never, { ...DEFAULTS, test_phone: "010-5555-0000" });
    expect(out.deliver_alerts).toBe(true);
    expect(out.test_phone).toBe("010-5555-0000");
    expect(out.templates.map((t) => t.id)).toEqual(DEFAULT_TEMPLATES.map((t) => t.id));
  });
  it("a backup config without templates keeps the current ones", () => {
    const mine = [{ id: "tpl_x", name: "x", telecoms: [], statuses: [], sources: [], body: "b" }];
    const out = prepareRestoredConfig({ deliver_alerts: false } as never, { ...DEFAULTS, templates: mine as never });
    expect(out.templates).toEqual(mine);
  });
  it("leaves test_phone unset when this device has none", () => {
    const out = prepareRestoredConfig({ test_phone: "010-9" } as never, { ...DEFAULTS });
    expect(out).not.toHaveProperty("test_phone");
  });
});

describe("default template wording (#60/#61)", () => {
  const term = DEFAULT_TEMPLATES.find((t) => t.id === "default-term")!;
  const keep = DEFAULT_TEMPLATES.find((t) => t.id === "default-keepdate")!;

  it("new installs: the 약정 만료 default uses {years}/{when}, not a fixed '2년전' / '종료되어'", () => {
    expect(term.body).toContain("{years}년 전");
    expect(term.body).toContain("{when}");
    expect(term.body).not.toContain("2년전");
    expect(term.body).not.toContain("종료되어");
  });

  it("new installs: both defaults put a space in '{customer} 고객님'", () => {
    for (const t of [term, keep]) {
      expect(t.body).toContain("{customer} 고객님");
      expect(t.body).not.toContain("{customer}고객님");
    }
  });

  it("existing installs: an UNTOUCHED old default body is upgraded (conditions/name kept)", () => {
    const oldTerm = { ...term, name: "내 이름", telecoms: ["KT"], body: LEGACY_DEFAULT_TEMPLATE_BODIES["default-term"][0] };
    const oldKeep = { ...keep, body: LEGACY_DEFAULT_TEMPLATE_BODIES["default-keepdate"][0] };
    const out = upgradeUntouchedDefaultTemplates([oldTerm, oldKeep] as never);
    expect(out[0].body).toBe(term.body);
    expect(out[0].name).toBe("내 이름");
    expect(out[0].telecoms).toEqual(["KT"]);
    expect(out[1].body).toBe(keep.body);
  });

  it("never modifies a user-edited default, a user template, or an already-current body", () => {
    const edited = { ...term, body: LEGACY_DEFAULT_TEMPLATE_BODIES["default-term"][0] + " " };
    const mine = { id: "tpl_x", name: "", telecoms: [], statuses: [], body: LEGACY_DEFAULT_TEMPLATE_BODIES["default-term"][0] };
    const input = [edited, mine, keep];
    const out = upgradeUntouchedDefaultTemplates(input as never);
    expect(out[0].body).toBe(edited.body);
    expect(out[1].body).toBe(mine.body);
    expect(out[2]).toEqual(keep);
    expect(input[0].body).toBe(edited.body); // pure: input untouched
  });

  it("the legacy bodies are the exact v1.2.9–v1.2.16 texts ('{customer}고객님', '2년전')", () => {
    expect(LEGACY_DEFAULT_TEMPLATE_BODIES["default-term"][0]).toContain("{customer}고객님 😊\n\n2년전 휴대폰 개통");
    expect(LEGACY_DEFAULT_TEMPLATE_BODIES["default-keepdate"][0]).toContain("{customer}고객님 😊\n\n{months}개월 전");
  });

  it("withDefaults (every load) and a restored backup upgrade an untouched old default", () => {
    const stored = { templates: [{ ...term, body: LEGACY_DEFAULT_TEMPLATE_BODIES["default-term"][0] }] };
    expect(withDefaults(stored).templates[0].body).toBe(term.body);
    expect(migrateTemplateList(stored.templates)[0].body).toBe(term.body);
  });
});

describe("validateRestoredConfig own-key lookup (L4)", () => {
  it("a '__proto__' / 'constructor' key neither throws nor reaches the result", () => {
    const raw = JSON.parse('{"__proto__": {"deliver_alerts": true}, "constructor": 1, "prototype": 2, "default_term_months": 24}');
    const r = validateRestoredConfig(raw);
    expect(r.valid.default_term_months).toBe(24);
    expect(Object.getPrototypeOf(r.valid)).toBe(Object.prototype);
    expect((r.valid as Record<string, unknown>).deliver_alerts).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r.valid, "constructor")).toBe(false);
    expect(r.dropped).toEqual(expect.arrayContaining(["__proto__", "constructor", "prototype"]));
  });
});
