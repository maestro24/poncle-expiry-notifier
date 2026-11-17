/**
 * Send-sheet length line (#61): how the typed message will go out — a single 단문
 * (90 bytes EUC-KR) or a long message the carrier delivers as 장문(LMS) / the phone
 * splits into N parts. The byte/segment math lives in sender.smsLengthInfo.
 */

/** The part of sender.smsLengthInfo's result this line needs (`lms` or `kind`). */
export interface SmsLengthInfo {
  chars: number;
  bytes: number;
  segments: number;
  lms?: boolean;
  kind?: "SMS" | "LMS";
  /** Over the carrier's 장문 limit. */
  tooLong?: boolean;
}

/** The single SMS byte budget (EUC-KR: 한글 2바이트, 영문/숫자 1바이트). */
export const SMS_SINGLE_BYTES = 90;

/** One-line summary under the send textarea; "" for an empty message. */
export function smsLengthLabel(info: SmsLengthInfo): string {
  if (!info || info.chars <= 0) return "";
  const lms = info.lms ?? info.kind === "LMS";
  if (!lms) return `${info.chars}자 · ${info.bytes}/${SMS_SINGLE_BYTES}바이트 · 단문(SMS)`;
  const base = `${info.chars}자 · ${info.bytes}바이트 · 장문(LMS)/분할 ${info.segments}건으로 발송될 수 있습니다`;
  return info.tooLong ? `${base} · 장문 한도를 넘어 일부가 잘릴 수 있습니다` : base;
}
