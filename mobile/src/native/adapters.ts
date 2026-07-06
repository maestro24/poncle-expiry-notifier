/**
 * Adapt the native Capacitor plugins to the domain-layer interfaces, so the
 * pure logic (poncle-client / scan / sender) stays plugin-agnostic and testable.
 */
import type { PoncleGateway } from "../domain/poncle-client";
import type { AppConfig } from "../domain/types";
import { AppUpdate } from "./appupdate";
import { Poncle } from "./poncle";
import { Sms } from "./sms";

/** A PoncleGateway backed by the native Poncle plugin (cookie-authed HTTP). */
export function nativePoncleGateway(cfg: AppConfig): PoncleGateway {
  const baseUrl = cfg.poncle_base_url;
  return {
    check: async () => (await Poncle.check({ baseUrl })).value,
    listOpen: async (params) => Poncle.listOpen({ baseUrl, params }),
    listPending: async (params) => Poncle.listPending({ baseUrl, params }),
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

/** Launch the in-app Poncle login WebView. Returns true if a session was captured. */
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
