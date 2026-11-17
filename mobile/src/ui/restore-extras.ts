/**
 * Restore of the backup's 미방문 수동 제외 list and 재방문 코호트 (#55), merged into
 * this phone's own (never replaced): exclusions are a union, the cohort is merged
 * by phone|expiry (export.mergeCohort). The store is History in the app.
 */
import type { CohortEntry } from "../domain/cohort";
import { excludedKeysToAdd, mergeCohort } from "../domain/export";

export interface ExtrasStore {
  handledKeys(): Promise<Set<string>>;
  setHandled(phone: string, expiry: string, val: boolean): Promise<void>;
  loadCohort(): Promise<CohortEntry[]>;
  saveCohort(entries: CohortEntry[]): Promise<void>;
}

export interface RestoredExtras {
  /** Exclusions added from the file (ones this phone lacked). */
  excludedAdded: number;
  /** Cohort entries in the file (merged into this phone's log). */
  cohortRestored: number;
}

/** Merge the file's exclusions + cohort into the store. Throws on a storage error. */
export async function applyRestoredExtras(
  store: ExtrasStore,
  backup: { excluded: readonly string[]; cohort: readonly CohortEntry[] },
): Promise<RestoredExtras> {
  const add = excludedKeysToAdd(await store.handledKeys(), backup.excluded);
  for (const key of add) {
    const bar = key.lastIndexOf("|");
    await store.setHandled(key.slice(0, bar), key.slice(bar + 1), true);
  }
  if (backup.cohort.length) {
    await store.saveCohort(mergeCohort(await store.loadCohort(), backup.cohort));
  }
  return { excludedAdded: add.length, cohortRestored: backup.cohort.length };
}

/** ', 미방문 제외 N명' style suffix for the restore summary ("" when nothing came in). */
export function restoredExtrasNote(r: RestoredExtras): string {
  const parts: string[] = [];
  if (r.excludedAdded) parts.push(`미방문 제외 ${r.excludedAdded}명 추가`);
  if (r.cohortRestored) parts.push(`재방문 집계 ${r.cohortRestored}명`);
  return parts.length ? `, ${parts.join(", ")}` : "";
}
