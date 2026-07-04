/**
 * Bridge to the native `Poncle` Capacitor plugin (Kotlin). All Poncle network
 * access goes NATIVE, for two reasons:
 *   1. CORS: m.poncle.co.kr sends no CORS headers, so a WebView fetch is blocked.
 *      A native HttpURLConnection/OkHttp request has no origin and is not blocked.
 *   2. Cookies: the customer's real login session lives in the native WebView
 *      CookieManager (set during the in-app login), and the native request reuses
 *      those cookies (exactly like the PC app's requests.Session did).
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
  /** True when ok is false due to a retryable transport error (timeout/IO/non-200),
   *  as opposed to a genuine session-expired login page. */
  netError?: boolean;
  total: number;
  list: PoncleRow[];
}

export interface PonclePlugin {
  /** Launch the in-app WebView login. Resolves when a valid session cookie is
   *  captured (ok=true) or the user cancels (ok=false). */
  login(options?: { baseUrl?: string }): Promise<{ ok: boolean }>;
  /** Clear the stored Poncle cookies (사용자 로그아웃). */
  logout(options?: { baseUrl?: string }): Promise<void>;
  /** True if cookies are currently stored (not necessarily still valid). */
  hasSession(options?: { baseUrl?: string }): Promise<{ value: boolean }>;
  /** Probe /open/listOpen with scale=1; true if it returns data right now. */
  check(options?: { baseUrl?: string }): Promise<{ value: boolean }>;
  /** One authenticated GET /open/listOpen with the given query params. */
  listOpen(options: { baseUrl?: string; params: Record<string, string> }): Promise<ListOpenResult>;
  /** One authenticated GET /pending/listPending (미결관리) with the given params. */
  listPending(options: { baseUrl?: string; params: Record<string, string> }): Promise<ListOpenResult>;

  // -- saved credentials (WebView login autofill) -------------------------
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
