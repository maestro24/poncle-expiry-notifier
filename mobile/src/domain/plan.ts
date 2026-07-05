/**
 * Poncle 요금제(plan) string handling.
 *
 * Poncle's `plan` field (from /open/listOpen and the 개통정보 detail's 가입정보)
 * is free-text and inconsistent — e.g. "베이직4GB", "초이스110 폰케어",
 * "lte7gb/통화기본18600", "LTE (7GB+/통화기본) / 18600", "프리티음성기본7GB  26400".
 *
 * DISPLAY and AGGREGATION are deliberately separated:
 *  - cleanPlan(): light cleanup for showing ONE plan verbatim — trims and
 *    collapses internal whitespace, nothing more. It never rewrites the plan's
 *    meaning, because for a single card the raw text (including an embedded
 *    monthly fee like "26400") is the most trustworthy thing to show staff.
 *  - A semantic normalizer for GROUPING (요금제별 집계) — stripping prices and
 *    punctuation to bucket "lte7gb/통화기본18600" and "LTE (7GB+/통화기본)/18600"
 *    together — is intentionally NOT built yet: it is lossy and only pays off
 *    once a real aggregation view (e.g. a 대시보드 요금제 분포) needs it. Add a
 *    `planKey()` here when that day comes.
 */

/** Light display cleanup for a single plan string. Returns "" when absent. */
export function cleanPlan(raw: string | null | undefined): string {
  if (raw == null) return "";
  return String(raw).replace(/\s+/g, " ").trim();
}
