/**
 * Exported files (이력 CSV / 백업 JSON) hold customer PII (이름·번호·문자 원문).
 * They are written to the app cache only so the share sheet can hand them over
 * (L6). The receiving app may still be reading the file after the sheet closes
 * (e.g. a mail draft attaches it later), so a SHARED file is removed on the next
 * app start / next export. A 'cancelled' share is removed the same way (B4): the
 * share plugin also reports Quick Share / Bluetooth / 드라이브 저장 as cancelled
 * while they are still sending. Only a definite failure is removed right away.
 */
import { Directory, Filesystem } from "@capacitor/filesystem";

/** poncle-history-YYYY-MM-DD.csv / poncle-backup-YYYY-MM-DD.json */
const EXPORT_FILE = /^poncle-(history|backup)-[\d-]+\.(csv|json)$/;

export function isExportFileName(name: string): boolean {
  return EXPORT_FILE.test(name);
}

/** Minimal cache-directory access (Capacitor Filesystem in the app). */
export interface CacheFs {
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

/** Delete every leftover export file (except `keep`, the one about to be written).
 *  Never throws; resolves how many were removed. */
export async function purgeExportFiles(fs: CacheFs, keep = ""): Promise<number> {
  let names: string[];
  try {
    names = await fs.list();
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names.filter((n) => isExportFileName(n) && n !== keep)) {
    try {
      await fs.remove(name);
      removed++;
    } catch {
      /* in use or already gone: retried next start */
    }
  }
  return removed;
}

/** How one share sheet ended ("cancelled" is ambiguous — see the header). */
export type ShareOutcome = "shared" | "cancelled" | "failed";

/**
 * Whether a backup share should count as a backup (the 대시보드 '백업 필요' reminder,
 * B4). "shared" counts; "failed" never does; an ambiguous "cancelled" — which
 * @capacitor/share also reports for Quick Share / Bluetooth / 드라이브 저장 that DID
 * receive the file — asks the user (`askSaved`) instead of guessing either way.
 */
export async function backupWasSaved(outcome: ShareOutcome, askSaved: () => Promise<boolean>): Promise<boolean> {
  if (outcome === "shared") return true;
  if (outcome === "failed") return false;
  return askSaved();
}

/** Remove one export file now (a share that definitely failed). Never throws. */
export async function removeExportFile(fs: CacheFs, name: string): Promise<void> {
  try {
    await fs.remove(name);
  } catch {
    /* purged on the next start */
  }
}

/** The app cache directory via Capacitor Filesystem. */
export function capacitorCacheFs(): CacheFs {
  return {
    async list() {
      const res = (await Filesystem.readdir({ path: "", directory: Directory.Cache })) as { files?: unknown[] };
      return (res.files ?? []).map((f) => (typeof f === "string" ? f : String((f as { name?: unknown }).name ?? "")));
    },
    async remove(name) {
      await Filesystem.deleteFile({ path: name, directory: Directory.Cache });
    },
  };
}
