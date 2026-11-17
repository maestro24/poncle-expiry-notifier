/**
 * Device clock check (#58). Every D-day, {when} and 만료 판정 uses the phone's own
 * date; if it is off by a day or more, alerts go to the wrong customers or say the
 * wrong day. The native gateway reports Poncle's HTTP Date header (serverDate);
 * when the phone's date differs from it by >= 1 day, home shows a warning and
 * sending is blocked until the date is fixed.
 */

/** Home banner title (agreed wording). */
export const CLOCK_SKEW_TITLE = "휴대폰 날짜가 실제와 다릅니다 — 날짜/시간 자동 설정을 켜 주세요";

export interface ClockCheck {
  /** Sending must be refused (|skew| >= 1 day). */
  blocked: boolean;
  /** Absolute whole-day difference between the phone and the server. */
  days: number;
}

/**
 * Judge the device date against the last server date. `skewDays` is
 * plaindate.clockSkewDays (injected so this stays pure/testable). Null = unknown
 * (no server date yet, or it couldn't be read) — unknown never blocks.
 */
export function evaluateClockSkew(
  serverIso: string | null,
  deviceNow: Date,
  skewDays: (serverIso: string, deviceNow: Date) => number,
): ClockCheck | null {
  if (!serverIso) return null;
  let d: number;
  try {
    d = skewDays(serverIso, deviceNow);
  } catch {
    return null;
  }
  if (typeof d !== "number" || !Number.isFinite(d)) return null;
  const days = Math.abs(Math.trunc(d));
  return { blocked: days >= 1, days };
}

/**
 * The server's time "now", from the skew measured when the last Poncle response
 * arrived (adapters.lastClockSkewMs: server minus device ms). Unlike the raw last
 * server date this does not age: a correct phone that last reached Poncle two days
 * ago (e.g. an offline foreground probe) is not flagged. Null when unknown.
 */
export function serverNowIso(skewMs: number | null, deviceNow: Date): string | null {
  if (typeof skewMs !== "number" || !Number.isFinite(skewMs)) return null;
  const ms = deviceNow.getTime() + skewMs;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Sub-line of the banner / the refusal toast for a blocked send. */
export function clockSkewDetail(check: ClockCheck): string {
  return `실제 날짜와 ${check.days}일 차이가 납니다. 날짜가 맞을 때까지 문자 발송을 막습니다.`;
}

/**
 * B10: a scan run while the phone's date is wrong would persist the 재방문 코호트
 * against the wrong 'today' (entries aged out / lost for good). The skew is judged
 * when the cohort is written — after the scan's own Poncle responses carried the
 * server date — and the write is dropped while it is off. Every other member of
 * the store passes through unchanged.
 */
export function withCohortGuard<T extends { saveCohort(entries: never): Promise<void> }>(store: T, isSkewed: () => boolean): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "saveCohort") {
        return async (entries: never): Promise<void> => {
          if (isSkewed()) return;
          await target.saveCohort(entries);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
