#!/usr/bin/env node
/**
 * poncle-ext manifest-version guard (audit 2026-11-17 I7).
 *
 * GeckoView's ensureBuiltIn() keeps an installed bridge extension whose
 * manifest "version" is unchanged, so editing background.js / content.js
 * without bumping the version silently never reaches existing installs.
 * scripts/poncle-ext.lock.json records {version, sha256} of the folder;
 * tests/poncle-ext.test.ts fails when the folder no longer matches it.
 *
 * After changing anything in android/app/src/main/assets/poncle-ext/:
 *   1. bump "version" in poncle-ext/manifest.json
 *   2. node scripts/poncle-ext-lock.mjs     (refuses when the version was not bumped)
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cmpDotted, manifestVersion, normalizeText } from "./release-checks.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = resolve(SCRIPTS_DIR, "..", "android", "app", "src", "main", "assets", "poncle-ext");
export const LOCK_PATH = join(SCRIPTS_DIR, "poncle-ext.lock.json");

/** Every file of the folder (flat) as Map(name -> text). */
export function readExtFiles(dir = EXT_DIR) {
  const files = new Map();
  for (const name of readdirSync(dir).sort()) files.set(name, readFileSync(join(dir, name), "utf8"));
  return files;
}

/** sha256 over the sorted (name, LF-normalized text) pairs. */
export function extDigest(files) {
  const h = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    h.update(name);
    h.update("\u0000");
    h.update(normalizeText(files.get(name)));
    h.update("\u0000");
  }
  return h.digest("hex");
}

export function readLock(path = LOCK_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** lock {version, sha256} vs the current files -> { ok, reason } ("" when ok). */
export function checkExtLock(lock, files) {
  const version = manifestVersion(files.get("manifest.json"));
  const sha256 = extDigest(files);
  const fix = "poncle-ext/manifest.json 의 version 을 올린 뒤 `node scripts/poncle-ext-lock.mjs` 를 실행하세요";
  if (!lock || typeof lock.version !== "string" || typeof lock.sha256 !== "string") {
    return { ok: false, reason: `poncle-ext.lock.json 이 없거나 형식이 틀렸습니다 — ${fix}` };
  }
  if (!version) return { ok: false, reason: "poncle-ext/manifest.json 에 version 이 없습니다" };
  if (version === lock.version) {
    if (sha256 === lock.sha256) return { ok: true, reason: "" };
    return { ok: false, reason: `poncle-ext 파일이 바뀌었는데 manifest version 이 ${version} 그대로입니다 — ${fix}` };
  }
  if (cmpDotted(version, lock.version) < 0) {
    return { ok: false, reason: `manifest version 이 ${lock.version} → ${version} 로 내려갔습니다` };
  }
  return { ok: false, reason: `manifest version ${version} 이(가) 기록되지 않았습니다 — \`node scripts/poncle-ext-lock.mjs\` 를 실행하세요` };
}

function main() {
  const files = readExtFiles();
  const version = manifestVersion(files.get("manifest.json"));
  const sha256 = extDigest(files);
  let lock = null;
  try {
    lock = readLock();
  } catch {
    lock = null;
  }
  if (!version) {
    console.error("ERROR: poncle-ext/manifest.json 에 version 이 없습니다");
    process.exit(1);
  }
  if (lock && lock.sha256 === sha256 && lock.version === version) {
    console.log(`poncle-ext ${version}: 변경 없음`);
    return;
  }
  if (lock && lock.sha256 !== sha256 && cmpDotted(version, lock.version) <= 0) {
    console.error(
      `ERROR: poncle-ext 가 바뀌었는데 manifest version 이 ${version} 입니다 (기록 ${lock.version}). version 을 올린 뒤 다시 실행하세요.`,
    );
    process.exit(1);
  }
  writeFileSync(LOCK_PATH, `${JSON.stringify({ version, sha256 }, null, 2)}\n`);
  console.log(`poncle-ext.lock.json 갱신: version ${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
