import { describe, expect, it } from "vitest";
import { cmpVersions, isTrustedApkUrl, parseVersion, pickAndroidUpdate, type GhRelease } from "../src/domain/updater";

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

const GH = "https://github.com/maestro24/poncle-expiry-notifier/releases/download";
const rel = (tag: string, apk = true): GhRelease => ({
  tag_name: tag,
  body: "notes for " + tag,
  assets: apk ? [{ name: "app-debug.apk", browser_download_url: `${GH}/${tag}/${tag}.apk` }] : [],
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
    expect(u.url).toBe(`${GH}/android-v1.1.0/android-v1.1.0.apk`);
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

  it("rejects an apk asset hosted off a non-GitHub domain (no broken update offered)", () => {
    const evil: GhRelease = {
      tag_name: "android-v2.0.0",
      body: "x",
      assets: [{ name: "app-debug.apk", browser_download_url: "https://evil.example.com/app.apk" }],
    };
    const u = pickAndroidUpdate([evil], "1.0.0");
    expect(u.available).toBe(false);
    expect(u.url).toBe("");
  });

  it("does not fall back to a non-apk first asset", () => {
    const rel2: GhRelease = {
      tag_name: "android-v2.0.0",
      body: "x",
      assets: [{ name: "notes.txt", browser_download_url: `${GH}/android-v2.0.0/notes.txt` }],
    };
    expect(pickAndroidUpdate([rel2], "1.0.0").available).toBe(false);
  });
});

describe("isTrustedApkUrl", () => {
  it("accepts github.com and githubusercontent hosts", () => {
    expect(isTrustedApkUrl("https://github.com/o/r/releases/download/t/a.apk")).toBe(true);
    expect(isTrustedApkUrl("https://objects.githubusercontent.com/x/a.apk")).toBe(true);
  });
  it("rejects other hosts and junk", () => {
    expect(isTrustedApkUrl("https://evil.example.com/a.apk")).toBe(false);
    expect(isTrustedApkUrl("https://github.com.evil.com/a.apk")).toBe(false);
    expect(isTrustedApkUrl("not a url")).toBe(false);
    expect(isTrustedApkUrl(null)).toBe(false);
    expect(isTrustedApkUrl("")).toBe(false);
  });
});
