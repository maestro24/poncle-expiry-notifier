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
}

export const Sms = registerPlugin<SmsPlugin>("Sms", {
  // Web fallback (browser preview / vitest): no telephony -> reject clearly.
  web: async () => ({
    send: async () => {
      throw new Error("SMS is only available on the Android device");
    },
  }),
});
