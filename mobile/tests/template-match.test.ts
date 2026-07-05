import { describe, expect, it } from "vitest";
import {
  conditionSummary,
  isContractType,
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
  it("keeps the 10 exact display values", () => {
    expect(normalizeTelecom("KT")).toBe("KT");
    expect(normalizeTelecom("SK텔레콤")).toBe("SK텔레콤");
    expect(normalizeTelecom("LG유플러스")).toBe("LG유플러스");
    expect(normalizeTelecom("U+알뜰모바일")).toBe("U+알뜰모바일");
    expect(normalizeTelecom("KT엠모바일")).toBe("KT엠모바일");
    expect(normalizeTelecom("SK텔링크")).toBe("SK텔링크");
    expect(normalizeTelecom("스카이라이프")).toBe("스카이라이프");
    expect(normalizeTelecom("기타통신사(KT)")).toBe("기타통신사(KT)");
    expect(normalizeTelecom("기타통신사(SKT)")).toBe("기타통신사(SKT)");
    expect(normalizeTelecom("기타통신사(LGT)")).toBe("기타통신사(LGT)");
  });
  it("maps unambiguous short codes to the display", () => {
    expect(normalizeTelecom("SKT")).toBe("SK텔레콤");
    expect(normalizeTelecom("LGUMOBI")).toBe("U+알뜰모바일");
    expect(normalizeTelecom("SKYLIFE")).toBe("스카이라이프");
    expect(normalizeTelecom(" KT ")).toBe("KT"); // trims
  });
  it("returns '' for unknown/blank/ambiguous", () => {
    expect(normalizeTelecom("")).toBe("");
    expect(normalizeTelecom("알뜰폰")).toBe("");
    expect(normalizeTelecom("ETC")).toBe(""); // 3 displays share this code
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
  it("telecom group OR (exact carriers)", () => {
    expect(templateMatches(item, tpl({ telecoms: ["SK텔레콤", "KT"] }))).toBe(true);
    expect(templateMatches(item, tpl({ telecoms: ["KT"] }))).toBe(false);
    // MVNO brands are independent from their parent carrier
    expect(templateMatches({ telecom: "SK텔링크", openhow: "기변" }, tpl({ telecoms: ["SK텔레콤"] }))).toBe(false);
    expect(templateMatches({ telecom: "스카이라이프", openhow: "기변" }, tpl({ telecoms: ["스카이라이프"] }))).toBe(true);
  });
  it("status group OR", () => {
    expect(templateMatches(item, tpl({ statuses: ["기변", "신규"] }))).toBe(true);
    expect(templateMatches(item, tpl({ statuses: ["신규"] }))).toBe(false);
  });
  it("groups AND", () => {
    expect(templateMatches(item, tpl({ telecoms: ["SK텔레콤"], statuses: ["기변"] }))).toBe(true);
    expect(templateMatches(item, tpl({ telecoms: ["SK텔레콤"], statuses: ["신규"] }))).toBe(false);
  });
  it("source(시점) group: keepdate vs term, empty = any", () => {
    expect(templateMatches({ ...item, source: "keepdate" }, tpl({ sources: ["keepdate"] }))).toBe(true);
    expect(templateMatches({ ...item, source: "term" }, tpl({ sources: ["keepdate"] }))).toBe(false);
    expect(templateMatches({ ...item, source: "term" }, tpl())).toBe(true); // empty sources = any
    expect(templateMatches(item, tpl({ sources: ["keepdate"] }))).toBe(false); // no source vs pinned -> no match
  });
  it("unknown carrier never matches a carrier-pinned template", () => {
    expect(templateMatches({ telecom: "알뜰폰", openhow: "기변" }, tpl({ telecoms: ["SK텔레콤"] }))).toBe(false);
    // but still matches a wildcard-telecom template
    expect(templateMatches({ telecom: "알뜰폰", openhow: "기변" }, tpl({ statuses: ["기변"] }))).toBe(true);
  });
});

describe("matchingTemplates", () => {
  it("returns matches in list order", () => {
    const a = tpl({ id: "a", telecoms: ["SK텔레콤"] });
    const b = tpl({ id: "b" }); // wildcard
    const c = tpl({ id: "c", telecoms: ["KT"] });
    const out = matchingTemplates({ telecom: "SK텔레콤", openhow: "기변" }, [a, b, c]);
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
  });
  it("empty template list -> no matches", () => {
    expect(matchingTemplates({ telecom: "SK텔레콤", openhow: "기변" }, [])).toEqual([]);
  });
});

describe("isContractType (약정 대상)", () => {
  it("신규/번호이동/기변 are contract types", () => {
    for (const t of ["신규", "번호이동", "기변", "기기변경"]) expect(isContractType(t)).toBe(true);
  });
  it("유심 variants and unmappable are not", () => {
    for (const t of ["유심신규", "유심MNP", "유심 MNP", "유심기변", ""]) expect(isContractType(t)).toBe(false);
  });
});

describe("conditionSummary", () => {
  it("labels wildcards and lists (시점 / 상태 / 통신사)", () => {
    expect(conditionSummary(tpl())).toBe("모든 시점 / 모든 상태 / 모든 통신사");
    expect(
      conditionSummary(tpl({ sources: ["keepdate"], statuses: ["기변"], telecoms: ["KT", "SK텔레콤"] })),
    ).toBe("요금제 유지 / 기변 / KT·SK텔레콤");
  });
});
