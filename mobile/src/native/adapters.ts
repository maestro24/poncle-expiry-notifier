/**
 * Adapt the native Capacitor plugins to the domain-layer interfaces, so the
 * pure logic (poncle-client / scan / sender) stays plugin-agnostic and testable.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { preferencesKV, type KV } from "../domain/history";
import { isTransientHttpStatus, type PoncleGateway } from "../domain/poncle-client";
import type { AppConfig } from "../domain/types";
import { AppUpdate } from "./appupdate";
import { Poncle } from "./poncle";
import { Sms } from "./sms";

// -- server clock (improvement 3-16) ---------------------------------------
/** The last valid server `Date` seen on a Poncle response, plus the device clock
 *  at that moment (so the skew stays meaningful however long ago it was seen). */
let serverClock: { iso: string; skewMs: number } | null = null;

/** Remember a native `serverDate` (ISO string) when it is a real date; anything
 *  else (absent on older native builds, garbage) keeps the previous value. */
function noteServerDate(raw: unknown): void {
  if (typeof raw !== "string" || raw.trim() === "") return;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return;
  serverClock = { iso: new Date(ms).toISOString(), skewMs: ms - Date.now() };
}

/** ISO-8601 UTC time from the last Poncle response's HTTP `Date` header, or null
 *  when none has been seen yet this session (or the native build predates it). */
export function lastServerDate(): string | null {
  return serverClock ? serverClock.iso : null;
}

/** Server time minus device time (ms) measured when lastServerDate() arrived:
 *  positive = the device clock is BEHIND. Null when unknown. Compare against a
 *  threshold (e.g. one day) rather than diffing lastServerDate() with "now", which
 *  would drift as the observation ages. Includes network latency (~seconds). */
export function lastClockSkewMs(): number | null {
  return serverClock ? serverClock.skewMs : null;
}

/** Test hook: forget the observed server clock. */
export function resetServerClockForTest(): void {
  serverClock = null;
}

/** A PoncleGateway backed by the native Poncle plugin (requests run in the
 *  logged-in Gecko page). */
export function nativePoncleGateway(cfg: AppConfig): PoncleGateway {
  const baseUrl = cfg.poncle_base_url;
  return {
    // A transport failure (no response) or a transient server status (5xx/408/
    // 429) is not an expiry: throw so the session probe reports 'unknown' instead
    // of the 재로그인 banner on a network blip or a Poncle outage (audit 1-18).
    check: async () => {
      const r = await Poncle.check({ baseUrl });
      noteServerDate(r.serverDate);
      if (r.netError || isTransientHttpStatus(r.status)) throw new Error("폰클 서버에 연결할 수 없습니다");
      return r.value;
    },
    listOpen: async (params) => {
      const r = await Poncle.listOpen({ baseUrl, params });
      noteServerDate(r.serverDate);
      return r;
    },
    listPending: async (params) => {
      const r = await Poncle.listPending({ baseUrl, params });
      noteServerDate(r.serverDate);
      return r;
    },
  };
}

/** Deliver an SMS from this device via the native Sms plugin. */
export async function sendSms(phone: string, text: string): Promise<void> {
  await Sms.send({ phone, text });
}

/** Whether SEND_SMS is currently granted. */
export async function checkSmsPermission(): Promise<boolean> {
  return (await Sms.checkPermission()).granted;
}

/** Prompt for SEND_SMS (no-op if already granted). Returns the resulting state. */
export async function requestSmsPermission(): Promise<boolean> {
  return (await Sms.requestPermission()).granted;
}

/** Open this app's system settings (to re-enable a permanently-denied SMS permission). */
export async function openAppSettings(): Promise<void> {
  await Sms.openAppSettings();
}

/** Installed app versionName (e.g. "1.0.0"). */
export async function getAppVersion(): Promise<string> {
  return (await AppUpdate.getVersion()).version;
}

/** Open a URL in the system browser / download manager (for APK download). */
export async function openExternalUrl(url: string): Promise<void> {
  await AppUpdate.openUrl({ url });
}

/** Launch the in-app Poncle login (GeckoView). Returns true if a session was captured. */
export async function poncleLogin(cfg: AppConfig): Promise<boolean> {
  const { ok } = await Poncle.login({ baseUrl: cfg.poncle_base_url });
  return ok;
}

/** True if Poncle cookies are stored (not necessarily still valid). */
export async function poncleHasSession(cfg: AppConfig): Promise<boolean> {
  const { value } = await Poncle.hasSession({ baseUrl: cfg.poncle_base_url });
  return value;
}

/** Clear the stored Poncle session (logout). */
export async function poncleLogout(cfg: AppConfig): Promise<void> {
  await Poncle.logout({ baseUrl: cfg.poncle_base_url });
}

/** Store Poncle id/password (encrypted, device-only) for login autofill. */
export async function savePoncleCredentials(id: string, pw: string): Promise<boolean> {
  return (await Poncle.saveCredentials({ id, pw })).ok;
}

/** Whether creds are stored + the saved id (never the password). */
export async function getPoncleCredentialsMeta(): Promise<{ hasCreds: boolean; id: string }> {
  return Poncle.getCredentialsMeta();
}

/** Delete the stored Poncle credentials. */
export async function clearPoncleCredentials(): Promise<void> {
  await Poncle.clearCredentials();
}

// -- durable key/value store (K1, audit L43) ---------------------------------
/** Native `DurableKV` plugin (Java DurableKVPlugin): SharedPreferences written
 *  with commit(), i.e. on disk before the call resolves. Capacitor Preferences
 *  uses apply(), so a process killed right after a send could lose the record
 *  (and text the customer again on the next scan). */
export interface DurableKVNative {
  get(options: { key: string }): Promise<{ value: string | null }>;
  /** Resolves ok:true only after the value was committed to disk. */
  set(options: { key: string; value: string }): Promise<{ ok: boolean }>;
}

const DurableKVPlugin = registerPlugin<DurableKVNative>("DurableKV");

/** True when the native durable store exists (native build >= 1.2.17). */
export function isDurableKVAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("DurableKV");
  } catch {
    return false;
  }
}

/**
 * A KV over the native commit()-backed store, migrating from `legacy` (the
 * Capacitor Preferences KV) by read-through: the first access to a key that has
 * no durable value copies the legacy value over (the legacy copy is kept, so a
 * downgrade still finds its data). Every access to a key waits for that one
 * migration, so a write can never be overwritten by a migration that started
 * before it. `native` null (web preview / tests / older native build) = plain
 * `legacy`. A failed durable write REJECTS: the caller must not believe it was
 * saved.
 */
export function createDurableKV(native: DurableKVNative | null, legacy: KV): KV {
  if (!native) return legacy;
  const migrations = new Map<string, Promise<void>>();
  const write = async (key: string, value: string): Promise<void> => {
    const r = await native.set({ key, value });
    if (!r || r.ok !== true) throw new Error("이력을 저장하지 못했습니다");
  };
  const migrate = (key: string): Promise<void> => {
    let p = migrations.get(key);
    if (!p) {
      p = (async () => {
        const { value } = await native.get({ key });
        if (value !== null && value !== undefined) return;
        const old = await legacy.get(key);
        if (old !== null) await write(key, old);
      })();
      // A failed migration is retried on the next access (never cached).
      p.catch(() => migrations.delete(key));
      migrations.set(key, p);
    }
    return p;
  };
  return {
    async get(key: string): Promise<string | null> {
      await migrate(key);
      const { value } = await native.get({ key });
      return value ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      await migrate(key);
      await write(key, value);
    },
  };
}

/** The send-history KV for the app: the native durable store with a one-time
 *  read-through migration from Capacitor Preferences; Preferences itself on the
 *  web / when the native plugin is missing. */
export function durableKV(): KV {
  return createDurableKV(isDurableKVAvailable() ? DurableKVPlugin : null, preferencesKV());
}
