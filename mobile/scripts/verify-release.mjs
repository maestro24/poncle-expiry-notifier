#!/usr/bin/env node
/**
 * Pre-publish check for an Android release APK (audit 1-38). Run it BEFORE
 * `gh release create android-vX.Y.Z ...`; it exits 1 if any check fails.
 *
 *   node scripts/verify-release.mjs --tag android-v1.2.17 [--apk <path>] [--prev-code <n>]
 *       [--prev-apk <path>] [--allow-minsdk-change]
 *
 * Checks:
 *   1. the tag is `android-vX.Y.Z` and X.Y.Z == the APK's versionName
 *      (a mismatch makes every install show the update popup forever);
 *   2. the APK's versionName/versionCode match android/app/build.gradle (stale APK);
 *   3. the tag is NOT already published: the tag list comes from
 *      `git ls-remote --tags origin` (the remote, not local tags), and an
 *      existing tag FAILS (audit B14 — never re-publish a version);
 *   4. versionCode is strictly greater than the latest PUBLISHED release's and
 *      the tag's version is higher than it (latest = highest android-v* tag on
 *      origin, versionCode read from that tag's build.gradle; or --prev-code);
 *   5. the signing certificate SHA-1 is the canonical key (in-place updates);
 *   6. the APK is NOT debuggable;
 *   7. the APK packages arm64-v8a (every current phone);
 *   8. minSdk did not go up vs the latest published release (its
 *      variables.gradle, or --prev-apk) unless --allow-minsdk-change: a higher
 *      minSdk silently strands every older phone (audit 2026-11-17 I4);
 *   9. poncle-ext (the GeckoView bridge extension) did not change vs the latest
 *      published tag without a manifest "version" bump (GeckoView keeps the
 *      installed copy otherwise); a tag without the folder passes. The folder
 *      must also match scripts/poncle-ext.lock.json (scripts/poncle-ext-lock.mjs);
 *  10. the poncle-ext PACKAGED in the APK (assets/poncle-ext/*) equals the working
 *      tree — an APK built before the last poncle-ext edit/bump fails (rebuild).
 * It also PRINTS the APK's permissions and which are new vs the previous
 * release (--prev-apk badging, else that tag's source AndroidManifest.xml, so
 * library-merged permissions then show as new too); review them, no FAIL.
 *
 * Tools: aapt + apksigner from the newest Android SDK build-tools found via
 * ANDROID_HOME / ANDROID_SDK_ROOT / android/local.properties (sdk.dir).
 * No dependencies; Node 18+.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestReleaseTag, parseRemoteTags, semverCmp, TAG_RE } from "./release-tags.mjs";
import {
  apkExtFiles,
  checkApkExt,
  checkArm64,
  checkExtBump,
  checkMinSdk,
  gradleMinSdk,
  lsTreeArgs,
  manifestPermissions,
  newPermissions,
  parseBadging,
} from "./release-checks.mjs";
import { checkExtLock, readExtFiles, readLock } from "./poncle-ext-lock.mjs";

const CANONICAL_SHA1 = "9b7af897909350c95659dab296293384bafe23f7";
const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRADLE_FILE = join(MOBILE_DIR, "android", "app", "build.gradle");
const GRADLE_REPO_PATH = "mobile/android/app/build.gradle";
const VARIABLES_REPO_PATH = "mobile/android/variables.gradle";
const MANIFEST_REPO_PATH = "mobile/android/app/src/main/AndroidManifest.xml";
const EXT_REPO_DIR = "mobile/android/app/src/main/assets/poncle-ext";
const DEFAULT_APK = join(MOBILE_DIR, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");

function parseArgs(argv) {
  const out = { tag: "", apk: DEFAULT_APK, prevCode: null, prevApk: null, allowMinSdkChange: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} 값이 없습니다`);
      return v;
    };
    if (a === "--tag") out.tag = next();
    else if (a === "--apk") out.apk = resolve(next());
    else if (a === "--prev-code") out.prevCode = Number(next());
    else if (a === "--prev-apk") out.prevApk = resolve(next());
    else if (a === "--allow-minsdk-change") out.allowMinSdkChange = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        "usage: node scripts/verify-release.mjs --tag android-vX.Y.Z [--apk path] [--prev-code n] [--prev-apk path] [--allow-minsdk-change]",
      );
      process.exit(0);
    } else fail(`알 수 없는 인자: ${a}`);
  }
  if (!out.tag) fail("--tag android-vX.Y.Z 가 필요합니다 (게시할 태그)");
  if (out.prevCode !== null && !Number.isInteger(out.prevCode)) fail("--prev-code 는 정수여야 합니다");
  if (out.prevApk && !existsSync(out.prevApk)) fail(`--prev-apk 파일이 없습니다: ${out.prevApk}`);
  return out;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

function run(cmd, args, opts = {}) {
  // Windows build-tools ship apksigner as a .bat, which Node only runs via a shell.
  const isBat = process.platform === "win32" && /\.(bat|cmd)$/i.test(cmd);
  const res = isBat
    ? spawnSync(`"${cmd}"`, args.map((x) => `"${x}"`), { encoding: "utf8", shell: true, ...opts })
    : spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.error) throw res.error;
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function sdkDir() {
  for (const v of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (v && existsSync(v)) return v;
  }
  const lp = join(MOBILE_DIR, "android", "local.properties");
  if (existsSync(lp)) {
    const m = readFileSync(lp, "utf8").match(/^sdk\.dir=(.*)$/m);
    if (m) {
      const dir = m[1].trim().replace(/\\:/g, ":").replace(/\\\\/g, "\\");
      if (existsSync(dir)) return dir;
    }
  }
  fail("Android SDK를 찾지 못했습니다 (ANDROID_HOME 또는 android/local.properties 의 sdk.dir)");
}

/** apksigner needs Java: keep JAVA_HOME if set, else fall back to Android
 *  Studio's bundled JBR (the JDK this project builds with). */
function javaEnv() {
  if (process.env.JAVA_HOME) return process.env;
  const candidates = [
    "C:/Program Files/Android/Android Studio/jbr",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "/opt/android-studio/jbr",
  ];
  const jbr = candidates.find((p) => existsSync(p));
  return jbr ? { ...process.env, JAVA_HOME: jbr } : process.env;
}

function buildTools(sdk) {
  const root = join(sdk, "build-tools");
  if (!existsSync(root)) fail(`build-tools 폴더가 없습니다: ${root}`);
  const win = process.platform === "win32";
  const versions = readdirSync(root)
    .map((name) => ({ name, v: name.split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0) }))
    .sort((x, y) => semverCmp(y.v, x.v));
  for (const { name } of versions) {
    const dir = join(root, name);
    const aapt = join(dir, win ? "aapt.exe" : "aapt");
    const apksigner = join(dir, win ? "apksigner.bat" : "apksigner");
    if (existsSync(aapt) && existsSync(apksigner)) return { aapt, apksigner, version: name };
  }
  fail(`aapt 와 apksigner 가 함께 있는 build-tools 가 없습니다: ${root}`);
}

function gradleVersion(text) {
  const code = text.match(/versionCode\s+(\d+)/);
  const name = text.match(/versionName\s+["']([^"']+)["']/);
  return { code: code ? Number(code[1]) : null, name: name ? name[1] : null };
}

/** The published tags (Map name -> commit sha) from origin, or null when the
 *  remote cannot be read (offline / no origin): then nothing can be verified. */
function remoteTags() {
  const r = run("git", ["ls-remote", "--tags", "origin"], { cwd: MOBILE_DIR });
  if (r.code !== 0) return null;
  return parseRemoteTags(r.out);
}

/** Runs a git command that reads a published tag's commit. The commit may be
 *  missing locally (no `git fetch --tags`): then fetch just that tag's objects
 *  into FETCH_HEAD (no local ref is created, once per tag) and retry. */
const fetchedTags = new Set();
function gitAt(tag, args) {
  let r = run("git", args, { cwd: MOBILE_DIR });
  if (r.code !== 0 && !fetchedTags.has(tag)) {
    fetchedTags.add(tag);
    run("git", ["fetch", "--no-tags", "origin", `refs/tags/${tag}`], { cwd: MOBILE_DIR });
    r = run("git", args, { cwd: MOBILE_DIR });
  }
  return r;
}

/** A file's text at a published tag's commit, or null. */
function fileAt(tag, sha, repoPath) {
  const r = gitAt(tag, ["show", `${sha}:${repoPath}`]);
  return r.code === 0 ? r.out : null;
}

/** build.gradle versionCode at a published tag's commit. */
function versionCodeAt(tag, sha) {
  const text = fileAt(tag, sha, GRADLE_REPO_PATH);
  return text === null ? null : gradleVersion(text).code;
}

/** poncle-ext files at a published tag: Map(name -> text); an empty Map when
 *  the folder did not exist there; null when the commit cannot be read. */
function extFilesAt(tag, sha) {
  const ls = gitAt(tag, lsTreeArgs(sha, EXT_REPO_DIR));
  if (ls.code !== 0) return null;
  const files = new Map();
  for (const line of ls.out.split(/\r?\n/)) {
    const path = line.trim();
    if (!path) continue;
    const text = fileAt(tag, sha, path);
    if (text === null) return null;
    files.set(path.slice(EXT_REPO_DIR.length + 1), text);
  }
  return files;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];
  const check = (ok, label, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  const tagMatch = args.tag.match(TAG_RE);
  if (!tagMatch) fail(`태그 형식이 android-vX.Y.Z 가 아닙니다: ${args.tag}`);
  const tagVersion = tagMatch.slice(1, 4).join(".");
  if (!existsSync(args.apk)) fail(`APK가 없습니다: ${args.apk} (assembleRelease 먼저)`);

  const tools = buildTools(sdkDir());
  console.log(`APK: ${args.apk}\nbuild-tools: ${tools.version}\n`);

  // aapt badging: package/version + debuggable flag.
  const badging = run(tools.aapt, ["dump", "badging", args.apk]);
  if (badging.code !== 0) fail(`aapt dump badging 실패:\n${badging.out}`);
  const pkg = badging.out.match(/package: name='([^']*)' versionCode='(\d+)' versionName='([^']*)'/);
  if (!pkg) fail("aapt 출력에서 versionCode/versionName 을 읽지 못했습니다");
  const apkCode = Number(pkg[2]);
  const apkName = pkg[3];

  check(apkName === tagVersion, "태그 == versionName", `tag ${args.tag}, APK versionName ${apkName}`);

  const gradle = gradleVersion(readFileSync(GRADLE_FILE, "utf8"));
  check(
    gradle.name === apkName && gradle.code === apkCode,
    "APK == build.gradle (오래된 APK 아님)",
    `build.gradle ${gradle.name}/${gradle.code}, APK ${apkName}/${apkCode}`,
  );

  const target = tagMatch.slice(1, 4).map(Number);
  const remote = remoteTags();
  if (!remote) {
    check(false, "태그 미게시 (원격)", "git ls-remote --tags origin 실패 — 네트워크/origin 을 확인하세요");
  } else {
    const sha = remote.get(args.tag);
    check(!sha, "태그 미게시 (원격)", sha ? `${args.tag} 이(가) 이미 origin 에 있습니다 (${sha.slice(0, 7)}) — 버전을 올리세요` : "");
  }

  const latest = remote ? latestReleaseTag(remote, args.tag) : null;
  if (latest) {
    check(
      semverCmp(target, latest.v) > 0,
      "태그 버전 > 최신 게시 태그",
      `최신 ${latest.tag}, 이번 ${args.tag}`,
    );
  }
  let prev = null;
  if (args.prevCode !== null) prev = { tag: "--prev-code", code: args.prevCode };
  else if (latest) {
    const code = versionCodeAt(latest.tag, latest.sha);
    if (code !== null) prev = { tag: latest.tag, code };
  }
  if (prev) {
    check(apkCode > prev.code, "versionCode 증가", `이전 ${prev.tag} = ${prev.code}, 이번 = ${apkCode}`);
  } else {
    check(
      false,
      "versionCode 증가",
      latest
        ? `${latest.tag} 의 build.gradle 을 읽지 못했습니다 (git fetch --tags 또는 --prev-code)`
        : "origin 에서 android-v* 태그를 찾지 못했습니다 (--prev-code 로 지정)",
    );
  }

  check(!/application-debuggable/.test(badging.out), "debuggable 아님", "");

  // --- ABI / minSdk / poncle-ext / permissions (audit 2026-11-17 I4) --------
  const info = parseBadging(badging.out);
  const arm = checkArm64(info.nativeCode);
  check(arm.ok, "arm64-v8a 포함", arm.detail);

  let prevInfo = null;
  if (args.prevApk) {
    const pb = run(tools.aapt, ["dump", "badging", args.prevApk]);
    if (pb.code !== 0) fail(`--prev-apk aapt dump badging 실패:\n${pb.out}`);
    prevInfo = parseBadging(pb.out);
  }
  let prevMinSdk = prevInfo ? prevInfo.minSdk : null;
  if (!prevInfo && latest) {
    const vars = fileAt(latest.tag, latest.sha, VARIABLES_REPO_PATH);
    prevMinSdk = vars === null ? null : gradleMinSdk(vars);
  }
  const ms = checkMinSdk(prevMinSdk, info.minSdk, args.allowMinSdkChange);
  check(ms.ok, "minSdk 상향 없음", ms.detail);

  if (latest) {
    const prevExt = extFilesAt(latest.tag, latest.sha);
    if (prevExt === null) {
      check(false, "poncle-ext 변경 시 version 올림", `${latest.tag} 의 파일을 읽지 못했습니다 (git fetch --tags)`);
    } else {
      const ext = checkExtBump(prevExt, readExtFiles());
      check(ext.ok, "poncle-ext 변경 시 version 올림", `${latest.tag} 대비 ${ext.detail}`);
    }
  }
  let lockRes;
  try {
    lockRes = checkExtLock(readLock(), readExtFiles());
  } catch (e) {
    lockRes = { ok: false, reason: `poncle-ext.lock.json 을 읽지 못했습니다: ${e.message}` };
  }
  check(lockRes.ok, "poncle-ext == poncle-ext.lock.json", lockRes.reason);

  let apkExt;
  try {
    apkExt = checkApkExt(apkExtFiles(readFileSync(args.apk)), readExtFiles());
  } catch (e) {
    apkExt = { ok: false, detail: `APK의 poncle-ext 를 읽지 못했습니다: ${e.message}` };
  }
  check(apkExt.ok, "APK 안의 poncle-ext == 작업 트리", apkExt.detail);

  let prevPerms = prevInfo ? prevInfo.permissions : null;
  let permBase = prevInfo ? "--prev-apk" : "";
  if (!prevPerms && latest) {
    const xml = fileAt(latest.tag, latest.sha, MANIFEST_REPO_PATH);
    if (xml !== null) {
      prevPerms = manifestPermissions(xml);
      permBase = `${latest.tag} 소스 매니페스트 (라이브러리 권한도 새 권한으로 보일 수 있음)`;
    }
  }
  console.log(`INFO  권한 ${info.permissions.length}개: ${info.permissions.join(", ") || "(없음)"}`);
  if (prevPerms) {
    const added = newPermissions(info.permissions, prevPerms);
    console.log(`INFO  새 권한 (기준: ${permBase}): ${added.length ? added.join(", ") : "없음"}`);
  } else {
    console.log("INFO  새 권한: 이전 릴리스와 비교하지 못했습니다 (--prev-apk 로 지정)");
  }

  const signer = run(tools.apksigner, ["verify", "--print-certs", args.apk], { env: javaEnv() });
  const sha1 = (signer.out.match(/certificate SHA-1 digest:\s*([0-9a-f]+)/i) || [])[1]?.toLowerCase();
  check(signer.code === 0, "서명 검증 (apksigner verify)", signer.code === 0 ? "" : signer.out.trim().split(/\r?\n/)[0]);
  check(sha1 === CANONICAL_SHA1, "서명 SHA-1 == 기존 키", `got ${sha1 ?? "(없음)"}`);

  const okAll = results.every(Boolean);
  console.log(okAll ? "\n모든 검사 통과 — 게시해도 됩니다." : "\n검사 실패 — 게시하지 마세요.");
  process.exit(okAll ? 0 : 1);
}

main();
