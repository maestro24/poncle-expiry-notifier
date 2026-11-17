/**
 * Bridge to the native `Sms` Capacitor plugin (Java, SmsManager). Sending goes
 * native so the employee's phone sends the customer message directly, with no PC
 * bridge and no messaging-app round trip. SEND_SMS is requested at first use.
 *
 * Send contract: send() resolves `{ id }` at hand-off to the OS (milliseconds) and
 * REJECTS up front (Korean message) when the phone can't send at all (비행기 모드,
 * 유심 없음, 기본 SIM 미지정, 권한 거부). The real radio outcome arrives later via
 * the sent-intent and is queued natively; the app drains it with getSendResults()
 * and confirms with ackSendResults() once it has applied the outcome.
 */
import { registerPlugin } from "@capacitor/core";
import { parseSendResults, type SmsSendResult } from "../domain/history";
import { INVALID_MOBILE_MESSAGE, isValidKrMobile } from "../domain/sender";

/** The one invalid-number text (L7). It is sender.ts INVALID_MOBILE_MESSAGE, which
 *  SmsPlugin.java INVALID_MOBILE_MESSAGE copies verbatim, so the app says the same
 *  thing whichever layer catches a bad number. Used by toasts and the 설정 test field. */
export const INVALID_NUMBER_MESSAGE: string = INVALID_MOBILE_MESSAGE;
/** The message without the "(010으로 …)" format hint. */
export const INVALID_NUMBER_TEXT: string = INVALID_MOBILE_MESSAGE.replace(/\s*\(.*\)\s*$/, "");

export interface SmsPlugin {
  /** Send an SMS to `phone` with `text`. Resolves `{ id }` once the OS accepts the
   *  message for sending (not after carrier delivery). Rejects with a Korean reason
   *  on preflight failure (airplane mode / no SIM / no default SIM / permission). */
  send(options: { phone: string; text: string }): Promise<{ id: string }>;
  /** Queued async send outcomes not yet acknowledged. */
  getSendResults(): Promise<{ results: SmsSendResult[] }>;
  /** Drop the given outcomes from the native queue (after the app applied them). */
  ackSendResults(options: { ids: string[] }): Promise<void>;
  /** Whether SEND_SMS is currently granted. */
  checkPermission(): Promise<{ granted: boolean }>;
  /** Prompt for SEND_SMS (no-op if already granted). Returns the new state. */
  requestPermission(): Promise<{ granted: boolean }>;
  /** Open this app's system settings page so the user can flip a permanently-denied
   *  SEND_SMS permission back on (the request dialog no longer appears once denied). */
  openAppSettings(): Promise<void>;
}

export const Sms = registerPlugin<SmsPlugin>("Sms", {
  // Web fallback (browser preview / vitest): no telephony -> reject clearly.
  web: async () => ({
    send: async () => {
      throw new Error("SMS is only available on the Android device");
    },
    getSendResults: async () => ({ results: [] }),
    ackSendResults: async () => {},
    checkPermission: async () => ({ granted: false }),
    requestPermission: async () => ({ granted: false }),
    openAppSettings: async () => {},
  }),
});

/** Send and return the native send id ("" if the native layer returned none).
 *  Rejects exactly like Sms.send (preflight / permission / hand-off failure), and
 *  up front for a number that isn't a Korean mobile (#40: a landline or two
 *  numbers run together would otherwise be handed to SmsManager). */
export async function sendSmsTracked(phone: string, text: string): Promise<string> {
  if (!isValidKrMobile(phone)) throw new Error(INVALID_NUMBER_MESSAGE);
  const res = (await Sms.send({ phone, text })) as { id?: unknown } | undefined;
  return typeof res?.id === "string" ? res.id : "";
}

/** Pending async send outcomes, validated. Never throws (an older native build
 *  without the method, or a bridge error, yields []). */
export async function fetchSendResults(): Promise<SmsSendResult[]> {
  try {
    return parseSendResults(await Sms.getSendResults());
  } catch {
    return [];
  }
}

/** Acknowledge applied outcomes so the native queue drops them. Never throws: an
 *  un-acked outcome is simply re-delivered and re-applied (idempotent). */
export async function ackSendResults(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await Sms.ackSendResults({ ids });
  } catch {
    /* re-delivered next time; applying is idempotent */
  }
}
