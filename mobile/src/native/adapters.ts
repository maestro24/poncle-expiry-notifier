/**
 * Adapt the native Capacitor plugins to the domain-layer interfaces, so the
 * pure logic (poncle-client / scan / sender) stays plugin-agnostic and testable.
 */
import type { PoncleGateway } from "../domain/poncle-client";
import type { AppConfig } from "../domain/types";
import { Poncle } from "./poncle";
import { Sms } from "./sms";

/** A PoncleGateway backed by the native Poncle plugin (cookie-authed HTTP). */
export function nativePoncleGateway(cfg: AppConfig): PoncleGateway {
  const baseUrl = cfg.poncle_base_url;
  return {
    check: async () => (await Poncle.check({ baseUrl })).value,
    listOpen: async (params) => Poncle.listOpen({ baseUrl, params }),
  };
}

/** Deliver an SMS from this device via the native Sms plugin. */
export async function sendSms(phone: string, text: string): Promise<void> {
  await Sms.send({ phone, text });
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
