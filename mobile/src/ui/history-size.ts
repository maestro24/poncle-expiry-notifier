/**
 * 설정 warning when the send log grows large (audit I12). The whole log is one
 * Preferences/durable-KV string that is read and rewritten on every send; past a
 * few MB that gets slow and a write can fail. No migration here — the warning
 * only asks the staff member to keep a backup file.
 */

import { SENT_LOG_WARN_BYTES, utf8ByteLength } from "../domain/history";

/** One threshold for the app: the domain's (History.storageBytes is measured against it). */
export const HISTORY_SIZE_WARN_BYTES = SENT_LOG_WARN_BYTES;

/** UTF-8 byte length (Korean = 3 bytes per syllable) — the domain counter. */
export const utf8Bytes = utf8ByteLength;

export function historySizeWarning(bytes: number): string | null {
  if (!(bytes >= HISTORY_SIZE_WARN_BYTES)) return null;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `발송 이력 데이터가 ${mb}MB로 커졌습니다. 더 커지면 발송·저장이 느려지거나 실패할 수 있으니 ‘백업 내보내기’로 백업 파일을 저장해 두세요.`;
}
