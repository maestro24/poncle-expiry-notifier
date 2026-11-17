/** Types for poncle-ext-lock.mjs (bridge-extension manifest-version guard). */
export interface ExtLock {
  version: string;
  sha256: string;
}
export declare const EXT_DIR: string;
export declare const LOCK_PATH: string;
export declare function readExtFiles(dir?: string): Map<string, string>;
export declare function extDigest(files: Map<string, string>): string;
export declare function readLock(path?: string): ExtLock;
export declare function checkExtLock(
  lock: Partial<ExtLock> | null | undefined,
  files: Map<string, string>,
): { ok: boolean; reason: string };
