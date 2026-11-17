/**
 * verify-release.mjs extra checks (audit 2026-11-17 I4): minSdk increase is
 * blocked unless explicitly allowed, arm64-v8a must be packaged, new
 * permissions are listed, and a changed poncle-ext without a manifest version
 * bump fails (a folder that did not exist at the previous tag passes).
 */
import { describe, expect, it } from "vitest";
import {
  checkArm64,
  checkExtBump,
  checkMinSdk,
  cmpDotted,
  gradleMinSdk,
  manifestPermissions,
  newPermissions,
  parseBadging,
} from "../scripts/release-checks.mjs";

const BADGING = [
  "package: name='com.poncleexpiry.app' versionCode='30' versionName='1.2.17' platformBuildVersionName='15'",
  "sdkVersion:'26'",
  "targetSdkVersion:'35'",
  "uses-permission: name='android.permission.INTERNET'",
  "uses-permission: name='android.permission.SEND_SMS'",
  "uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'",
  "uses-permission: name='android.permission.INTERNET'",
  "application-label:'약정만료 알리미'",
  "native-code: 'arm64-v8a' 'armeabi-v7a'",
].join("\n");

describe("parseBadging", () => {
  it("reads minSdk, ABIs and de-duplicated sorted permissions", () => {
    const b = parseBadging(BADGING);
    expect(b.minSdk).toBe(26);
    expect(b.nativeCode).toEqual(["arm64-v8a", "armeabi-v7a"]);
    expect(b.permissions).toEqual([
      "android.permission.INTERNET",
      "android.permission.REQUEST_INSTALL_PACKAGES",
      "android.permission.SEND_SMS",
    ]);
  });
  it("missing fields are null / empty", () => {
    expect(parseBadging("")).toEqual({ minSdk: null, nativeCode: [], permissions: [] });
  });
});

describe("minSdk", () => {
  it("reads variables.gradle", () => {
    expect(gradleMinSdk("ext {\n    minSdkVersion = 23\n    compileSdkVersion = 35\n}")).toBe(23);
    expect(gradleMinSdk("nothing")).toBeNull();
  });
  it("an increase FAILS unless --allow-minsdk-change", () => {
    expect(checkMinSdk(23, 26, false).ok).toBe(false);
    expect(checkMinSdk(23, 26, false).detail).toContain("--allow-minsdk-change");
    const allowed = checkMinSdk(23, 26, true);
    expect(allowed.ok).toBe(true);
    expect(allowed.detail).toContain("minSdk: 26");
  });
  it("same or lower passes; an unreadable APK value fails; unknown previous passes", () => {
    expect(checkMinSdk(26, 26, false).ok).toBe(true);
    expect(checkMinSdk(26, 24, false).ok).toBe(true);
    expect(checkMinSdk(26, null, true).ok).toBe(false);
    expect(checkMinSdk(null, 26, false).ok).toBe(true);
  });
});

describe("arm64-v8a", () => {
  it("is required", () => {
    expect(checkArm64(["arm64-v8a", "armeabi-v7a"]).ok).toBe(true);
    expect(checkArm64(["armeabi-v7a"]).ok).toBe(false);
    expect(checkArm64([]).ok).toBe(false);
  });
});

describe("permissions", () => {
  it("reads the source manifest and lists only the new ones", () => {
    const xml = `<manifest>
      <uses-permission android:name="android.permission.INTERNET" />
      <uses-permission
          android:name="android.permission.SEND_SMS" /></manifest>`;
    const prev = manifestPermissions(xml);
    expect(prev).toEqual(["android.permission.INTERNET", "android.permission.SEND_SMS"]);
    expect(newPermissions(parseBadging(BADGING).permissions, prev)).toEqual([
      "android.permission.REQUEST_INSTALL_PACKAGES",
    ]);
    expect(newPermissions(["a"], null)).toEqual(["a"]);
  });
});

describe("poncle-ext version bump vs the previous tag", () => {
  const files = (version: string, bg: string) =>
    new Map([
      ["manifest.json", JSON.stringify({ version })],
      ["background.js", bg],
    ]);

  it("passes when the previous tag had no poncle-ext folder", () => {
    expect(checkExtBump(null, files("1.0.5", "x")).ok).toBe(true);
    expect(checkExtBump(new Map(), files("1.0.5", "x")).ok).toBe(true);
  });
  it("passes when nothing changed (CRLF vs LF is not a change)", () => {
    expect(checkExtBump(files("1.0.5", "a\r\nb"), files("1.0.5", "a\nb")).ok).toBe(true);
  });
  it("FAILS when a file changed but the version did not go up", () => {
    const r = checkExtBump(files("1.0.5", "old"), files("1.0.5", "new"));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("background.js");
    expect(checkExtBump(files("1.0.5", "old"), files("1.0.4", "new")).ok).toBe(false);
  });
  it("an added or removed file is a change too", () => {
    const cur = files("1.0.5", "x").set("extra.js", "y");
    expect(checkExtBump(files("1.0.5", "x"), cur).ok).toBe(false);
  });
  it("passes when it changed and the version went up", () => {
    expect(checkExtBump(files("1.0.9", "old"), files("1.0.10", "new")).ok).toBe(true);
  });
  it("cmpDotted compares numerically", () => {
    expect(cmpDotted("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(cmpDotted("1.0", "1.0.0")).toBe(0);
    expect(cmpDotted("1.0.4", "1.0.5")).toBeLessThan(0);
  });
});

/* ---- poncle-ext as PACKAGED in the APK (lane not_done: a stale APK built before
 *      the last poncle-ext edit must not pass because only the tree was checked) ---- */
import { deflateRawSync } from "node:zlib";
import { apkExtFiles, checkApkExt, zipEntries } from "../scripts/release-checks.mjs";

/** Minimal zip writer: stored (0) or deflated (8) entries + central directory. */
function makeZip(entries: Array<{ name: string; text: string; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.text, "utf8");
    const data = e.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("poncle-ext packaged in the APK", () => {
  const tree = new Map([
    ["manifest.json", '{"version":"1.0.5"}'],
    ["background.js", "bg v2\n"],
  ]);
  it("zipEntries reads stored and deflated entries", () => {
    const zip = makeZip([
      { name: "AndroidManifest.xml", text: "x" },
      { name: "assets/poncle-ext/background.js", text: "bg v2\n", deflate: true },
    ]);
    const m = zipEntries(zip, (n) => n.startsWith("assets/"));
    expect([...m.keys()]).toEqual(["assets/poncle-ext/background.js"]);
    expect(m.get("assets/poncle-ext/background.js")!.toString("utf8")).toBe("bg v2\n");
  });
  it("apkExtFiles keeps only assets/poncle-ext/* keyed by file name", () => {
    const zip = makeZip([
      { name: "assets/poncle-ext/manifest.json", text: '{"version":"1.0.5"}' },
      { name: "assets/other.txt", text: "no" },
    ]);
    expect([...apkExtFiles(zip).keys()]).toEqual(["manifest.json"]);
  });
  it("same files as the tree (CRLF ignored) pass", () => {
    const apk = new Map([["manifest.json", '{"version":"1.0.5"}'], ["background.js", "bg v2\r\n"]]);
    expect(checkApkExt(apk, tree).ok).toBe(true);
  });
  it("a stale APK (older background.js / version) fails and names the files", () => {
    const apk = new Map([["manifest.json", '{"version":"1.0.4"}'], ["background.js", "bg v1\n"]]);
    const r = checkApkExt(apk, tree);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("background.js");
    expect(r.detail).toContain("manifest.json");
  });
  it("an APK without the folder fails (the bridge would be missing)", () => {
    expect(checkApkExt(new Map(), tree).ok).toBe(false);
  });
});

/* ---- reading a folder at a published tag (review: `git ls-tree` resolves its
 *      pathspec against the cwd, so from mobile/ a repo-root path matched
 *      nothing, the previous poncle-ext looked absent and the bump check
 *      always passed) ---- */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lsTreeArgs } from "../scripts/release-checks.mjs";

describe("lsTreeArgs (repo-root paths from mobile/)", () => {
  const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  it("lists a repo-root folder at HEAD when run from mobile/", () => {
    const r = spawnSync("git", lsTreeArgs("HEAD", "mobile/android/app/src/main"), { cwd: mobileDir, encoding: "utf8" });
    expect(r.status).toBe(0);
    const names = r.stdout.split(/\r?\n/).filter(Boolean);
    expect(names).toContain("mobile/android/app/src/main/AndroidManifest.xml");
  });
});
