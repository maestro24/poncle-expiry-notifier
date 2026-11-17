/**
 * Pure helpers for verify-release.mjs (audit 2026-11-17 I4): minSdk / ABI /
 * permission checks from `aapt dump badging`, and the poncle-ext "changed but
 * manifest version not bumped" rule against the previous published tag.
 * No I/O here (zipEntries/apkExtFiles parse an APK already read into a Buffer).
 */
import { inflateRawSync } from "node:zlib";

/** Compares dotted numeric versions ("1.0.10" > "1.0.9"); missing parts = 0. */
export function cmpDotted(a, b) {
  const pa = String(a ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `aapt dump badging` output -> { minSdk, nativeCode, permissions }. */
export function parseBadging(out) {
  const text = String(out ?? "");
  const sdk = text.match(/^sdkVersion:'(\d+)'/m);
  const native = text.match(/^native-code:(.*)$/m);
  const permissions = [];
  for (const m of text.matchAll(/^uses-permission(?:-sdk-23)?: name='([^']+)'/gm)) {
    if (!permissions.includes(m[1])) permissions.push(m[1]);
  }
  return {
    minSdk: sdk ? Number(sdk[1]) : null,
    nativeCode: native ? [...native[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [],
    permissions: permissions.sort(),
  };
}

/** `minSdkVersion = N` from android/variables.gradle text, or null. */
export function gradleMinSdk(text) {
  const m = String(text ?? "").match(/minSdkVersion\s*=?\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** <uses-permission android:name="..."> names from an AndroidManifest.xml. */
export function manifestPermissions(xml) {
  const out = [];
  for (const m of String(xml ?? "").matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*android:name="([^"]+)"/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out.sort();
}

/** Permissions in `current` that `previous` did not have (sorted). */
export function newPermissions(current, previous) {
  const prev = new Set(previous ?? []);
  return [...new Set(current ?? [])].filter((p) => !prev.has(p)).sort();
}

/**
 * minSdk must not go up silently: raising it drops every phone below the new
 * level from self-updates (they download ~170 MB and the install fails).
 * -> { ok, detail }. Unknown values pass with a note (nothing to compare).
 */
export function checkMinSdk(prev, cur, allowChange) {
  if (cur == null) return { ok: false, detail: "APK 의 minSdk(sdkVersion)를 읽지 못했습니다" };
  if (prev == null) return { ok: true, detail: `이번 ${cur} (이전 값을 읽지 못해 비교 생략)` };
  if (cur <= prev) return { ok: true, detail: `이전 ${prev}, 이번 ${cur}` };
  if (allowChange) {
    return {
      ok: true,
      detail: `이전 ${prev} → 이번 ${cur} (--allow-minsdk-change: 릴리스 노트 첫 줄과 'minSdk: ${cur}' 표식을 확인하세요)`,
    };
  }
  return {
    ok: false,
    detail: `minSdk 가 ${prev} → ${cur} 로 올랐습니다. 의도한 변경이면 --allow-minsdk-change 를 붙이고 릴리스 노트를 고치세요`,
  };
}

/** The APK must carry the 64-bit ARM engine (every current phone). */
export function checkArm64(nativeCode) {
  const abis = nativeCode ?? [];
  return {
    ok: abis.includes("arm64-v8a"),
    detail: abis.length ? abis.join(", ") : "(native-code 없음)",
  };
}

/** Line endings must not count as a change (Windows checkouts use CRLF). */
export function normalizeText(s) {
  return String(s ?? "").replace(/\r\n/g, "\n");
}

/** manifest.json text -> its "version", or null. */
export function manifestVersion(text) {
  try {
    const v = JSON.parse(String(text ?? "")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * `git ls-tree` arguments listing a folder at `sha`, by its REPO-ROOT path
 * (e.g. "mobile/android/..."). verify-release runs git from mobile/, and
 * ls-tree resolves a pathspec against the cwd — without --full-tree the
 * root-relative path matched nothing and the folder looked absent.
 * --full-tree implies --full-name: output paths are repo-root relative too.
 */
export function lsTreeArgs(sha, repoDir) {
  return ["ls-tree", "--full-tree", "--name-only", sha, `${repoDir.replace(/\/+$/, "")}/`];
}

/**
 * poncle-ext vs the previous published tag. GeckoView's ensureBuiltIn keeps an
 * installed copy whose manifest version is unchanged, so changed files with the
 * same version never reach existing installs.
 * prevFiles: Map(name -> text) at the previous tag, or null when the folder did
 * not exist there (first GeckoView release: passes). curFiles: Map for this build.
 */
export function checkExtBump(prevFiles, curFiles) {
  if (!prevFiles || prevFiles.size === 0) {
    return { ok: true, detail: "이전 태그에 poncle-ext 폴더 없음 (첫 도입)" };
  }
  const names = [...new Set([...prevFiles.keys(), ...curFiles.keys()])].sort();
  const changed = names.filter((n) => normalizeText(prevFiles.get(n)) !== normalizeText(curFiles.get(n)));
  const prevV = manifestVersion(prevFiles.get("manifest.json"));
  const curV = manifestVersion(curFiles.get("manifest.json"));
  if (changed.length === 0) return { ok: true, detail: `변경 없음 (version ${curV ?? "?"})` };
  if (curV && prevV && cmpDotted(curV, prevV) > 0) {
    return { ok: true, detail: `변경 ${changed.join(", ")} · version ${prevV} → ${curV}` };
  }
  return {
    ok: false,
    detail: `변경 ${changed.join(", ")} 인데 manifest version 이 ${prevV ?? "?"} → ${curV ?? "?"} 입니다 — poncle-ext/manifest.json 의 version 을 올리세요`,
  };
}

/**
 * Entries of a zip (an APK) whose name passes `want`, as Map(name -> Buffer).
 * Reads the central directory (stored and deflated entries; no zip64 — an APK's
 * assets never need it). Throws on a buffer that is not a zip. Node built-ins only.
 */
export function zipEntries(buf, want = () => true) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip 끝 레코드(EOCD)를 찾지 못했습니다");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 중앙 디렉터리가 손상되었습니다");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    // The local header's own name/extra lengths can differ from the central copy.
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else throw new Error(`지원하지 않는 zip 압축 방식 ${method}: ${name}`);
  }
  return out;
}

/** The APK's packaged assets/poncle-ext/* as Map(file name -> text). */
export function apkExtFiles(apkBuf) {
  const prefix = "assets/poncle-ext/";
  const files = new Map();
  const entries = zipEntries(apkBuf, (n) => n.startsWith(prefix) && n.length > prefix.length && !n.endsWith("/"));
  for (const [name, data] of entries) files.set(name.slice(prefix.length), data.toString("utf8"));
  return files;
}

/**
 * poncle-ext as PACKAGED in the APK vs the working tree. checkExtBump/lock only
 * look at the tree, so an APK built before the last poncle-ext edit (or bump)
 * would otherwise pass. CRLF/LF differences are ignored.
 */
export function checkApkExt(apkFiles, treeFiles) {
  if (!apkFiles || apkFiles.size === 0) {
    return { ok: false, detail: "APK에 assets/poncle-ext 가 없습니다 — 폰클 브리지가 빠진 빌드입니다" };
  }
  const names = [...new Set([...apkFiles.keys(), ...treeFiles.keys()])].sort();
  const diff = names.filter((n) => normalizeText(apkFiles.get(n)) !== normalizeText(treeFiles.get(n)));
  const v = manifestVersion(apkFiles.get("manifest.json"));
  if (diff.length === 0) return { ok: true, detail: `APK의 poncle-ext == 작업 트리 (version ${v ?? "?"})` };
  return {
    ok: false,
    detail: `APK의 ${diff.join(", ")} 이(가) 작업 트리와 다릅니다 (APK version ${v ?? "?"}) — 마지막 수정 후 다시 빌드하세요`,
  };
}
