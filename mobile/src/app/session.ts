/**
 * Poncle session state: the authoritative probe, the home 로그인 banner and the
 * 설정 '폰클 세션' text.
 */
import { nativePoncleGateway, poncleHasSession } from "../native/adapters";
import { type SessionView, S } from "./state";
import { $ } from "./dom";
import { showBanner, refreshClockSkew, renderState, shownState } from "./status";

/** 설정 '폰클 세션' text from the last authoritative probe (no network here). */
export function refreshSessionState(): void {
  const text: Record<SessionView, string> = {
    none: "로그아웃 상태 · 로그인이 필요합니다",
    probing: "로그인 상태 확인 중…",
    ok: "로그인됨",
    expired: "세션 만료 · 다시 로그인이 필요합니다",
    unknown: "로그인 정보 있음 · 세션 확인 전 (네트워크 연결 후 확인됩니다)",
  };
  $("#session-state").textContent = text[S.SESSION];
}

/** Re-evaluate session + the home banner. Does NOT auto-scan — scanning is manual
 *  ("지금 다시 스캔" 버튼). The last scan is restored from cache in boot() instead. */
export async function refreshHome(): Promise<void> {
  // Non-blocking: boot renders the cached list first; the probe sets the banner later.
  void probeSession();
}

/**
 * Establish the Poncle session authoritatively. Cookie presence alone is NOT
 * trusted (the restored cookie survives a server-side expiry, which hid the
 * 재로그인 banner after a reboot): no cookie -> logged out; cookie + online -> one
 * check() round-trip decides. Offline (or a probe that throws) leaves it 'unknown'
 * and the banner untouched. Concurrent callers share one in-flight probe; callers
 * run it at most once per boot / foreground return (and after an explicit login).
 */
let sessionProbe: Promise<void> | null = null;
export function probeSession(): Promise<void> {
  if (sessionProbe) return sessionProbe;
  const epoch = S.SESSION_EPOCH;
  // A scan that started meanwhile set S.SESSION/banner from a fresher answer — drop ours.
  const report = (s: SessionView): void => { if (epoch === S.SESSION_EPOCH) setSession(s); };
  sessionProbe = (async () => {
    try {
      const has = await poncleHasSession(S.CFG).catch(() => false);
      if (!has) { report("none"); return; }
      if (typeof navigator !== "undefined" && navigator.onLine === false) { report("unknown"); return; }
      report("probing");
      let ok: boolean | null;
      try { ok = await nativePoncleGateway(S.CFG).check(); } catch { ok = null; }
      refreshClockSkew(); // boot / foreground probe: re-judge the phone's date (#58)
      report(ok === null ? "unknown" : ok ? "ok" : "expired");
    } finally {
      sessionProbe = null;
    }
  })();
  return sessionProbe;
}

/** Record a probe outcome, mirror it on the home banner, the status badge (L15)
 *  and the 설정 text. */
function setSession(s: SessionView): void {
  S.SESSION = s;
  if (S.CURRENT === "settings") refreshSessionState();
  if (S.SCANNING) return; // a scan owns the banner; it sets S.SESSION/banner itself
  if (s === "none" || s === "expired") showBanner("session");
  else if (s === "ok" && !$("#session-banner").classList.contains("hidden")) showBanner("none");
  // The badge a failed scan left: '세션만료' clears once the session is back, and
  // an expired probe says so on the badge too.
  if (s === "ok" && shownState() === "session_expired") renderState("idle");
  else if (s === "expired" && shownState() === "idle") renderState("session_expired");
}

/** The user logged out (설정): any probe begun before is stale, and home shows the
 *  로그인 banner (L14). */
export function markLoggedOut(): void {
  S.SESSION_EPOCH++;
  setSession("none");
}
