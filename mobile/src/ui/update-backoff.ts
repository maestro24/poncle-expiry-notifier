/**
 * Auto update-check backoff (audit U8): every foreground return / 30-min tick used
 * to re-ask GitHub after a failure. After N consecutive auto failures the next
 * auto check waits 5 min × 2^(N-1), at most 6 hours; any handled answer resets it.
 * A manual 업데이트 확인 is never held back.
 */

export const UPDATE_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const UPDATE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function updateRetryDelayMs(failures: number): number {
  const n = Math.floor(Number(failures) || 0);
  if (n <= 0) return 0;
  return Math.min(UPDATE_BACKOFF_MAX_MS, UPDATE_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 30));
}
