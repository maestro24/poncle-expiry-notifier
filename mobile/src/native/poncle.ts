/**
 * Bridge to the native `Poncle` Capacitor plugin (Java). All Poncle network
 * access goes NATIVE, for two reasons:
 *   1. CORS: m.poncle.co.kr sends no CORS headers, so an app-WebView fetch is
 *      blocked.
 *   2. Session: the in-app login runs in an embedded GeckoView (Android System
 *      WebView logins are rejected by Poncle's reCAPTCHA v3). Authenticated GETs
 *      run inside a hidden Gecko page on m.poncle.co.kr with that login's cookies,
 *      which are persisted encrypted on-device so the login survives app restarts.
 *
 * The plugin exposes a tiny surface; all paging / expiry logic stays in TS so it
 * is unit-testable against a fake bridge (see poncle-client.ts / its test).
 */
import { registerPlugin } from "@capacitor/core";
import type { PoncleRow } from "../domain/types";

export interface ListOpenResult {
  /** True when the response was real data JSON; false when Poncle answered with
   *  the login page (session expired) OR a transport error (see netError). */
  ok: boolean;
  /** True when ok is false due to a retryable failure — no response at all
   *  (timeout/IO) or a transient server status (5xx/408/429) — as opposed to a
   *  genuine session expiry (401/403, login HTML, JSON without "list"). */
  netError?: boolean;
  /** HTTP status the server answered with; absent when no response arrived or on
   *  native builds older than 1.2.17. */
  status?: number;
  /** The response's HTTP `Date` header as ISO-8601 UTC (e.g.
   *  "2026-11-16T03:00:00Z"); absent when no response / no header / on native
   *  builds older than 1.2.17. Feeds the device clock-skew check (3-16). */
  serverDate?: string;
  total: number;
  list: PoncleRow[];
}

export interface PonclePlugin {
  /** Launch the in-app (GeckoView) login. Resolves when a verified session was
   *  captured (ok=true) or the user cancels (ok=false). */
  login(options?: { baseUrl?: string }): Promise<{ ok: boolean }>;
  /** Clear the stored Poncle cookies (사용자 로그아웃). REJECTS when the native
   *  side could not confirm the Gecko cookies were cleared (bridge reply and
   *  StorageController both failed) — the session may still be alive. */
  logout(options?: { baseUrl?: string }): Promise<void>;
  /** True if a Poncle cookie set is persisted (not necessarily still valid). */
  hasSession(options?: { baseUrl?: string }): Promise<{ value: boolean }>;
  /** Probe /open/listOpen with scale=1; true if it returns data right now.
   *  `netError` is true when no response arrived at all (timeout / IO) or the
   *  server answered with a transient status (5xx/408/429) — then `value` is false
   *  but the session is NOT known to be expired. `status` is the HTTP status when
   *  one arrived, `serverDate` its HTTP Date header (ISO-8601 UTC). Older native
   *  builds omit all three. */
  check(options?: {
    baseUrl?: string;
  }): Promise<{ value: boolean; netError?: boolean; status?: number; serverDate?: string }>;
  /** One authenticated GET /open/listOpen with the given query params. */
  listOpen(options: { baseUrl?: string; params: Record<string, string> }): Promise<ListOpenResult>;
  /** One authenticated GET /pending/listPending (미결관리) with the given params. */
  listPending(options: { baseUrl?: string; params: Record<string, string> }): Promise<ListOpenResult>;

  // -- saved credentials (login-screen autofill) -------------------------
  /** Store id/password encrypted on-device for login autofill. */
  saveCredentials(options: { id: string; pw: string }): Promise<{ ok: boolean }>;
  /** Whether creds are stored + the saved id (never returns the password). */
  getCredentialsMeta(): Promise<{ hasCreds: boolean; id: string }>;
  /** Delete the stored credentials. */
  clearCredentials(): Promise<void>;
}

export const Poncle = registerPlugin<PonclePlugin>("Poncle", {
  // Web fallback (browser preview / vitest): no native session, everything empty.
  web: async () => ({
    login: async () => ({ ok: false }),
    logout: async () => undefined,
    hasSession: async () => ({ value: false }),
    check: async () => ({ value: false }),
    listOpen: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }),
    listPending: async () => ({ ok: false, total: 0, list: [] as PoncleRow[] }),
    saveCredentials: async () => ({ ok: false }),
    getCredentialsMeta: async () => ({ hasCreds: false, id: "" }),
    clearCredentials: async () => undefined,
  }),
});
