/** Types for release-checks.mjs (pure helpers of verify-release.mjs). */
export interface CheckResult {
  ok: boolean;
  detail: string;
}
export declare function cmpDotted(a: string, b: string): number;
export declare function parseBadging(out: string): {
  minSdk: number | null;
  nativeCode: string[];
  permissions: string[];
};
export declare function gradleMinSdk(text: string | null | undefined): number | null;
export declare function manifestPermissions(xml: string | null | undefined): string[];
export declare function newPermissions(current: string[], previous: string[] | null | undefined): string[];
export declare function checkMinSdk(prev: number | null, cur: number | null, allowChange: boolean): CheckResult;
export declare function checkArm64(nativeCode: string[] | null | undefined): CheckResult;
export declare function normalizeText(s: string | null | undefined): string;
export declare function manifestVersion(text: string | null | undefined): string | null;
export declare function lsTreeArgs(sha: string, repoDir: string): string[];
export declare function checkExtBump(
  prevFiles: Map<string, string> | null,
  curFiles: Map<string, string>,
): CheckResult;
export declare function zipEntries(buf: Buffer, want?: (name: string) => boolean): Map<string, Buffer>;
export declare function apkExtFiles(apkBuf: Buffer): Map<string, string>;
export declare function checkApkExt(
  apkFiles: Map<string, string> | null,
  treeFiles: Map<string, string>,
): CheckResult;
