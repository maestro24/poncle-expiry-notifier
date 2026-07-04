import { describe, expect, it } from "vitest";
import {
  conditionSummary,
  matchingTemplates,
  normalizeStatus,
  normalizeTelecom,
  templateMatches,
} from "../src/domain/template-match";
import type { MessageTemplate } from "../src/domain/types";

function tpl(over: Partial<MessageTemplate> = {}): MessageTemplate {
  return { id: "t", name: "T", telecoms: [], statuses: [], body: "hi", ...over };
}

describe("normalizeTelecom", () => {
  it("maps carrier variants", () => {
    expect(normalizeTelecom("SK텔레콤")).toBe("SK");
    expect(normalizeTelecom("SKT")).toBe("SK");
    expect(normalizeTelecom("KT")).toBe("KT");
    expect(normalizeTelecom("올레 KT")).toBe("KT");
    expect(normalizeTelecom("LG유플러스")).toBe("LG");
    expect(normalizeTelecom("LG U+")).toBe("LG");
    expect(normalizeTelecom("엘지유플러스")).toBe("LG");
  });
  it("returns '' for unknown/blank", () => {
    expect(normalizeTelecom("")).toBe("");
    expect(normalizeTelecom("알뜰폰")).toBe("");
  });
});

describe("normalizeStatus", () => {
  it("maps canonical values", () => {
    expect(normalizeStatus("신규")).toBe("신규");
    expect(normalizeStatus("번호이동")).toBe("번호이동");
    expect(normalizeStatus("기변")).toBe("기변");
    expect(normalizeStatus("유심신규")).toBe("유심신규");
    expect(normalizeStatus("유심MNP")).toBe("유심MNP");
  });
  it("maps common spellings", () => {
    expect(normalizeStatus("기기변경")).toBe("기변");
    expect(normalizeStatus("유심 MNP")).toBe("유심MNP");
  });
  it("checks 유심 variants before plain ones", () => {
    // "유심신규" must not collapse to "신규"; "유심MNP" not to "번호이동".
    expect(normalizeStatus("유심신규")).not.toBe("신규");
    expect(normalizeStatus("유심MNP")).not.toBe("번호이동");
  });
  it("returns '' for unmappable", () => {
    expect(normalizeStatus("")).toBe("");
    expect(normalizeStatus("유심기변")).toBe(""); // no canonical bucket
    expect(normalizeStatus("보상")).toBe("");
  });
});

describe("templateMatches", () => {
  const item = { telecom: "SK텔레콤", openhow: "기변" };

  it("empty conditions = wildcard (matches anything)", () => {
    expect(templateMatches(item, tpl())).toBe(true);
    expect(templateMatches({ telecom: "", openhow: "" }, tpl())).toBe(true);
  });
  it("telecom group OR", () => {
    expect(templateMatches(item, tpl({ telecoms: ["SK", "KT"] }))).toBe(true);
    expect(templateMatches(item, tpl({ telecoms: ["KT"] }))).toBe(false);
  });
  it("status group OR", () => {
    expect(templateMatches(item, tpl({ statuses: ["기변", "신규"] }))).toBe(true);
    expect(templateMatches(item, tpl({ statuses: ["신규"] }))).toBe(false);
  });
  it("groups AND", () => {
    expect(templateMatches(item, tpl({ telecoms: ["SK"], statuses: ["기변"] }))).toBe(true);
    expect(templateMatches(item, tpl({ telecoms: ["SK"], statuses: ["신규"] }))).toBe(false);
  });
  it("unknown carrier never matches a carrier-pinned template", () => {
    expect(templateMatches({ telecom: "알뜰폰", openhow: "기변" }, tpl({ telecoms: ["SK"] }))).toBe(false);
    // but still matches a wildcard-telecom template
    expect(templateMatches({ telecom: "알뜰폰", openhow: "기변" }, tpl({ statuses: ["기변"] }))).toBe(true);
  });
});

describe("matchingTemplates", () => {
  it("returns matches in list order", () => {
    const a = tpl({ id: "a", telecoms: ["SK"] });
    const b = tpl({ id: "b" }); // wildcard
    const c = tpl({ id: "c", telecoms: ["KT"] });
    const out = matchingTemplates({ telecom: "SK텔레콤", openhow: "기변" }, [a, b, c]);
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
  });
  it("empty template list -> no matches", () => {
    expect(matchingTemplates({ telecom: "SK텔레콤", openhow: "기변" }, [])).toEqual([]);
  });
});

describe("conditionSummary", () => {
  it("labels wildcards and lists", () => {
    expect(conditionSummary(tpl())).toBe("모든 통신사 / 모든 상태");
    expect(conditionSummary(tpl({ telecoms: ["KT", "SK"], statuses: ["기변"] }))).toBe("KT·SK / 기변");
  });
});
