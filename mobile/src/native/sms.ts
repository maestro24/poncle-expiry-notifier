/**
 * Bridge to the native `Sms` Capacitor plugin (Java, SmsManager). Sending goes
 * native so the employee's phone sends the customer message directly, with no PC
 * bridge and no messaging-app round trip. SEND_SMS is requested at first use.
 */
import { registerPlugin } from "@capacitor/core";

export interface SmsPlugin {
  /** Send an SMS to `phone` with `text`. Rejects if the permission is denied or
   *  the send fails. */
  send(options: { phone: string; text: string }): Promise<void>;
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
    checkPermission: async () => ({ granted: false }),
    requestPermission: async () => ({ granted: false }),
    openAppSettings: async () => {},
  }),
});
