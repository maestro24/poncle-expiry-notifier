import { describe, expect, it } from "vitest";
import { pushRecentQuery, dedupeRecentQueries, RECENT_LOOKUP_MAX } from "../src/domain/lookup-recent";

describe("pushRecentQuery", () => {
  it("puts the new query first", () => {
    expect(pushRecentQuery(["홍길동"], "01012345678")).toEqual(["01012345678", "홍길동"]);
  });

  it("treats hyphenated and digit-only forms of one number as the same entry", () => {
    const list = pushRecentQuery(["010-1234-5678", "홍길동"], "01012345678");
    expect(list).toEqual(["01012345678", "홍길동"]);
  });

  it("treats spaced and +82 forms as the same number", () => {
    expect(pushRecentQuery(["010 1234 5678"], "+82 10-1234-5678")).toEqual(["+82 10-1234-5678"]);
  });

  it("keeps the latest typed form when deduplicating", () => {
    expect(pushRecentQuery(["01012345678"], "010-1234-5678")).toEqual(["010-1234-5678"]);
  });

  it("dedupes names ignoring surrounding whitespace", () => {
    expect(pushRecentQuery(["홍길동", "김철수"], "  홍길동 ")).toEqual(["홍길동", "김철수"]);
  });

  it("does not merge different numbers", () => {
    expect(pushRecentQuery(["01012345678"], "01012345679")).toEqual(["01012345679", "01012345678"]);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: RECENT_LOOKUP_MAX }, (_, i) => `고객${i}`);
    const list = pushRecentQuery(many, "새고객");
    expect(list).toHaveLength(RECENT_LOOKUP_MAX);
    expect(list[0]).toBe("새고객");
  });

  it("does not mutate the input list", () => {
    const input = ["010-1234-5678"];
    pushRecentQuery(input, "01012345678");
    expect(input).toEqual(["010-1234-5678"]);
  });

  it("ignores a blank query", () => {
    expect(pushRecentQuery(["홍길동"], "   ")).toEqual(["홍길동"]);
  });
});

describe("dedupeRecentQueries", () => {
  it("collapses duplicates already saved by older versions, keeping the first (newest)", () => {
    expect(dedupeRecentQueries(["01012345678", "홍길동", "010-1234-5678", ""])).toEqual(["01012345678", "홍길동"]);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: RECENT_LOOKUP_MAX + 3 }, (_, i) => `고객${i}`);
    expect(dedupeRecentQueries(many)).toHaveLength(RECENT_LOOKUP_MAX);
  });
});
