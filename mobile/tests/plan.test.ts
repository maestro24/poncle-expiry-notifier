import { describe, expect, it } from "vitest";
import { cleanPlan } from "../src/domain/plan";

describe("cleanPlan", () => {
  it("returns '' for null/undefined/empty", () => {
    expect(cleanPlan(null)).toBe("");
    expect(cleanPlan(undefined)).toBe("");
    expect(cleanPlan("")).toBe("");
    expect(cleanPlan("   ")).toBe("");
  });

  it("trims outer whitespace", () => {
    expect(cleanPlan("  베이직4GB  ")).toBe("베이직4GB");
  });

  it("collapses internal runs of whitespace to a single space", () => {
    expect(cleanPlan("프리티음성기본7GB  26400")).toBe("프리티음성기본7GB 26400");
    expect(cleanPlan("LTE (7GB+/통화기본) / 18600")).toBe("LTE (7GB+/통화기본) / 18600");
    expect(cleanPlan("a\t\nb")).toBe("a b");
  });

  it("leaves an already-clean plan unchanged (never rewrites meaning)", () => {
    expect(cleanPlan("초이스110 폰케어")).toBe("초이스110 폰케어");
    expect(cleanPlan("lte7gb/통화기본18600")).toBe("lte7gb/통화기본18600");
  });
});
