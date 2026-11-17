/**
 * The toast for late native send failures (audit I6): it names the customer and
 * the first failure reason, so the staff member knows WHO to resend to and WHY
 * without digging through 이력; a 설정/홈 테스트 send that failed in the same batch
 * is still mentioned (it used to be hidden behind the real failure).
 */
import type { SentRecord, SmsSendResult } from "../domain/history";
import { htmlUnescape } from "../domain/html-entities";

export interface SendFailureInput {
  failed: readonly SentRecord[];
  resendFailed: readonly SentRecord[];
  testFails: readonly SmsSendResult[];
}

export interface SendFailureNotice {
  /** Toast text, or null when nothing failed. */
  toast: string | null;
  /** The 설정 > 문자 발송 테스트 line, or null when no test send failed. */
  testMsg: string | null;
}

/** "홍길동" / "홍길동 외 2건" (records written before v1.2.17 may be HTML-escaped). */
function who(recs: readonly SentRecord[]): string {
  const first = recs[0];
  const name = htmlUnescape(String(first.customer ?? "")).trim() || String(first.phone ?? "").trim() || "고객";
  return recs.length > 1 ? `${name} 외 ${recs.length - 1}건` : name;
}

export function sendFailureNotice(i: SendFailureInput): SendFailureNotice {
  const testReason = i.testFails.length ? i.testFails[0].reason || "발송 실패" : "";
  const testMsg = testReason ? `실패: ${testReason}` : null;
  let main: string | null = null;
  if (i.failed.length) {
    const reason = i.failed[0].fail_reason || "발송 실패";
    main = `${who(i.failed)} 문자 발송 실패가 확인되었습니다 — ${reason} · 다시 보내 주세요`;
    if (i.resendFailed.length) main += ` (재발송 실패 ${i.resendFailed.length}건 별도)`;
  } else if (i.resendFailed.length) {
    const reason = i.resendFailed[0].resend_fail_reason || "발송 실패";
    main = `${who(i.resendFailed)} 재발송 실패 — ${reason} · 이전에 보낸 문자 이력은 그대로 유지됩니다`;
  }
  if (main) return { toast: testReason ? `${main} · 테스트 문자도 실패했습니다` : main, testMsg };
  if (testReason) return { toast: `테스트 문자 발송 실패 — ${testReason}`, testMsg };
  return { toast: null, testMsg: null };
}
