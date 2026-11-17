/**
 * Text helpers for the stored send log: HTML-entity cleanup of a record's Poncle
 * text fields and the sent_log size (UTF-8 bytes) warning. Split out of history.ts;
 * re-exported from there.
 */
import { htmlUnescape } from "./html-entities";
import type { SentRecord } from "./sent-record";

/** Poncle text fields of a stored record (HTML-escaped by pre-v1.2.17 versions). */
const RECORD_TEXT_FIELDS = ["customer", "agency", "plan", "model", "staff", "telecom", "openhow"] as const;

/**
 * Decode HTML entities in a stored record's Poncle text fields (audit D1: "PS&amp;M"
 * saved before field() decoded at the boundary). The SMS `body` is left exactly as
 * sent. Clean text has no "&…;" so re-applying is a no-op; an unchanged record is
 * returned as the SAME object (pure otherwise).
 */
export function decodeSentRecordText(rec: SentRecord): SentRecord {
  let out: SentRecord | null = null;
  for (const k of RECORD_TEXT_FIELDS) {
    const v = rec[k];
    if (typeof v !== "string" || v.indexOf("&") === -1) continue;
    const d = htmlUnescape(v);
    if (d === v) continue;
    out = out ?? { ...rec };
    out[k] = d;
  }
  return out ?? rec;
}

/** sent_log size (bytes) past which 설정 shows a warning (I12). Every send re-writes
 *  the whole JSON value, so a very large log slows sends and risks the write. */
export const SENT_LOG_WARN_BYTES = 2 * 1024 * 1024;

/** UTF-8 byte length of a string (Korean = 3 bytes, astral = 4). Pure. */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** The 설정 warning for a sent_log of `bytes`, or null while under the threshold. */
export function sentLogSizeWarning(bytes: number): string | null {
  if (!(bytes > SENT_LOG_WARN_BYTES)) return null;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `발송 이력이 ${mb}MB로 커졌습니다 — 발송이 느려질 수 있으니 백업 파일을 저장해 두세요`;
}
