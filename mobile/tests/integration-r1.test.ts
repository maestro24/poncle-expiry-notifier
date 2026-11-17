/**
 * R1 integration checks: the B15 'can't install' notice names the real Android
 * versions (not a fixed 'Android 7 이하'), and the B14 release-tag helpers.
 */
import { describe, it, expect } from "vitest";
import { androidVersionName, releaseNotesForDisplay, unsupportedUpdateNotice } from "../src/ui/update-notice";
import { parseRemoteTags, latestReleaseTag, semverCmp, TAG_RE } from "../scripts/release-tags.mjs";

describe("B15: androidVersionName", () => {
  it("maps API levels to Android release names", () => {
    expect(androidVersionName(24)).toBe("7.0");
    expect(androidVersionName(26)).toBe("8.0");
    expect(androidVersionName(28)).toBe("9");
    expect(androidVersionName(32)).toBe("12L");
    expect(androidVersionName(33)).toBe("13");
    expect(androidVersionName(36)).toBe("16");
  });
  it("unknown or invalid levels give null", () => {
    expect(androidVersionName(undefined)).toBeNull();
    expect(androidVersionName(null)).toBeNull();
    expect(androidVersionName(0)).toBeNull();
    expect(androidVersionName(99)).toBeNull();
    expect(androidVersionName(26.5)).toBeNull();
  });
});

describe("B15: unsupportedUpdateNotice", () => {
  it("names this phone's Android and the release's minimum", () => {
    const n = unsupportedUpdateNotice({ deviceSdk: 27, minSdk: 28, version: "1.3.0" });
    expect(n.short).toBe("이 휴대폰(Android 8.1)은 새 버전을 설치할 수 없습니다");
    expect(n.detail).toContain("새 버전(v1.3.0)은 Android 9 이상에서만 설치됩니다");
    expect(n.detail).not.toContain("Android 7 이하");
  });
  it("falls back to neutral wording when a level is unknown", () => {
    const n = unsupportedUpdateNotice({ deviceSdk: undefined, minSdk: undefined, version: "" });
    expect(n.short).toBe("이 휴대폰은 새 버전을 설치할 수 없습니다");
    expect(n.detail).toContain("새 버전은 이 휴대폰보다 높은 Android 버전에서만 설치됩니다");
  });
});

describe("B15: the minSdk marker is not shown in the update popup", () => {
  it("drops only the 'minSdk: N' line", () => {
    const notes = "Android 8.0 이상 필요\nminSdk: 26\n\n- 수정 사항";
    expect(releaseNotesForDisplay(notes)).toBe("Android 8.0 이상 필요\n\n- 수정 사항");
    expect(releaseNotesForDisplay("- minSdk 표기 없음")).toBe("- minSdk 표기 없음");
    expect(releaseNotesForDisplay("")).toBe("");
  });
});

describe("B14: release-tags helpers", () => {
  it("parses ls-remote output; the peeled ^{} commit wins", () => {
    const out = [
      "aaaaaaa1111111111111111111111111111111aa\trefs/tags/android-v1.2.9",
      "bbbbbbb2222222222222222222222222222222bb\trefs/tags/android-v1.2.10",
      "ccccccc3333333333333333333333333333333cc\trefs/tags/android-v1.2.10^{}",
      "not a tag line",
    ].join("\n");
    const tags = parseRemoteTags(out);
    expect(tags.get("android-v1.2.9")).toBe("aaaaaaa1111111111111111111111111111111aa");
    expect(tags.get("android-v1.2.10")).toBe("ccccccc3333333333333333333333333333333cc");
    expect(tags.size).toBe(2);
  });
  it("latestReleaseTag orders numerically and honours exclude", () => {
    const tags = new Map([
      ["android-v1.2.9", "a"],
      ["android-v1.2.10", "b"],
      ["android-v1.2.16", "c"],
      ["v9.9.9", "x"],
    ]);
    expect(latestReleaseTag(tags)?.tag).toBe("android-v1.2.16");
    expect(latestReleaseTag(tags, "android-v1.2.16")?.tag).toBe("android-v1.2.10");
    expect(latestReleaseTag(new Map())).toBeNull();
  });
  it("semverCmp / TAG_RE", () => {
    expect(semverCmp([1, 2, 10], [1, 2, 9])).toBeGreaterThan(0);
    expect(semverCmp([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(TAG_RE.test("android-v1.2.17")).toBe(true);
    expect(TAG_RE.test("android-v1.2")).toBe(false);
  });
});
