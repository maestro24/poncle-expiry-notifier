/**
 * Android's bulk-SMS guard (audit I2): an app that sends more than 30 SMS within
 * 30 minutes gets a system '많은 양의 SMS를 보내고 있습니다' confirm, and a 거부
 * there makes the send fail (LIMIT_EXCEEDED). The staff member is told a little
 * before that point what the window will be and to press 허용.
 *
 * The OS counts SMS PARTS, not sends: SmsPlugin sends a long text with
 * divideMessage + sendMultipartTextMessage and SmsUsageMonitor counts every part
 * (a ~250-char Korean template is 4-5 parts, so the confirm comes around the 6th
 * or 7th such send). record() therefore takes the part count of each send.
 *
 * Counted per app process (in memory): every hand-off this session, customer and
 * test sends alike (the OS counts both). A restart mid-burst under-counts, which
 * only delays the notice — never blocks a send.
 */

export const SMS_LIMIT_WINDOW_MS = 30 * 60 * 1000;
export const SMS_LIMIT_COUNT = 30;
/** Warn at this many SMS parts within the window (a few before the OS confirm). */
export const SMS_VOLUME_WARN_AT = 25;

export function smsVolumeNotice(count: number): string {
  return `최근 30분 동안 문자를 ${count}건(긴 문자 분할 포함) 보냈습니다.\n` +
    "긴 문자는 여러 건으로 나뉘어 각각 세어집니다. " +
    `안드로이드는 30분에 ${SMS_LIMIT_COUNT}건을 넘으면 ‘많은 양의 SMS를 보내고 있습니다’ 확인 창을 띄웁니다. ` +
    "창이 뜨면 ‘허용’을 눌러 주세요 — ‘거부’하면 그 문자는 나가지 않고 발송 실패로 표시됩니다.";
}

/** A send's part count as the OS will count it: a whole number, at least 1. */
function partsOf(parts: number): number {
  return Number.isFinite(parts) && parts >= 1 ? Math.floor(parts) : 1;
}

export class SendVolumeMeter {
  /** One entry per SMS part handed off (a multipart send adds several). */
  private times: readonly number[] = [];
  /** The current burst already got its notice (re-armed once it drops below). */
  private warned = false;

  /** SMS parts within the window ending at `nowMs`. */
  count(nowMs: number): number {
    return this.times.filter((t) => nowMs - t < SMS_LIMIT_WINDOW_MS).length;
  }

  /** Record one hand-off of `parts` SMS parts; the notice text when the window
   *  reaches the threshold for the first time in the current burst, else null. */
  record(nowMs: number, parts = 1): string | null {
    const added = Array.from({ length: partsOf(parts) }, () => nowMs);
    this.times = [...this.times.filter((t) => nowMs - t < SMS_LIMIT_WINDOW_MS), ...added];
    const n = this.times.length;
    if (n < SMS_VOLUME_WARN_AT) {
      this.warned = false;
      return null;
    }
    if (this.warned) return null;
    this.warned = true;
    return smsVolumeNotice(n);
  }
}
