import { describe, expect, it } from "vitest";
import { cmpVersions, parseVersion, pickAndroidUpdate, type GhRelease } from "../src/domain/updater";

describe("parseVersion", () => {
  it("strips android-v prefix", () => expect(parseVersion("android-v1.2.3")).toEqual([1, 2, 3]));
  it("plain semver", () => expect(parseVersion("1.0")).toEqual([1, 0]));
  it("non-numeric -> null", () => expect(parseVersion("android-vbeta")).toBeNull());
});

describe("cmpVersions", () => {
  it("orders correctly", () => {
    expect(cmpVersions([1, 0, 0], [1, 0, 1])).toBe(-1);
    expect(cmpVersions([1, 1], [1, 0, 9])).toBe(1);
    expect(cmpVersions([1, 2], [1, 2, 0])).toBe(0);
  });
});

const rel = (tag: string, apk = true): GhRelease => ({
  tag_name: tag,
  body: "notes for " + tag,
  assets: apk ? [{ name: "app-debug.apk", browser_download_url: `https://x/${tag}.apk` }] : [],
});

describe("pickAndroidUpdate", () => {
  const releases = [
    rel("v1.2.0"), // PC release, ignored
    rel("android-v1.0.0"),
    rel("android-v1.1.0"),
    { tag_name: "android-vbeta" } as GhRelease, // unparseable, ignored
  ];

  it("picks newest android-v* above current", () => {
    const u = pickAndroidUpdate(releases, "1.0.0");
    expect(u.available).toBe(true);
    expect(u.version).toBe("1.1.0");
    expect(u.url).toBe("https://x/android-v1.1.0.apk");
    expect(u.notes).toContain("android-v1.1.0");
  });

  it("no update when current is newest", () => {
    expect(pickAndroidUpdate(releases, "1.1.0").available).toBe(false);
    expect(pickAndroidUpdate(releases, "2.0.0").available).toBe(false);
  });

  it("ignores PC v* tags entirely", () => {
    const u = pickAndroidUpdate([rel("v9.9.9")], "1.0.0");
    expect(u.available).toBe(false);
  });

  it("no android releases -> not available", () => {
    expect(pickAndroidUpdate([], "1.0.0").available).toBe(false);
  });
});
