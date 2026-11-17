/**
 * Bridge to the native `AppUpdate` Capacitor plugin (Java). getVersion reads the
 * installed versionName; openUrl hands a URL to the system browser / download
 * manager (used to fetch and install a newer APK for this sideloaded build).
 */
import { registerPlugin } from "@capacitor/core";

export interface AppUpdatePlugin {
  /** sdkInt = Build.VERSION.SDK_INT (native builds from 1.2.17; absent on the
   *  web fallback and older builds). */
  getVersion(): Promise<{ version: string; sdkInt?: number }>;
  openUrl(options: { url: string }): Promise<void>;
}

export const AppUpdate = registerPlugin<AppUpdatePlugin>("AppUpdate", {
  // Web fallback (browser preview / vitest).
  web: async () => ({
    getVersion: async () => ({ version: "0.0.0" }),
    openUrl: async ({ url }: { url: string }) => {
      window.open(url, "_blank");
    },
  }),
});

/** Cached device SDK level: it never changes while the app runs. */
let sdkIntPromise: Promise<number | undefined> | null = null;

/**
 * The device's Android API level (Build.VERSION.SDK_INT), or undefined when the
 * native layer doesn't report it (web preview, older native build). Used to skip
 * an update this phone can't install (B15) and the double copy toast (D4).
 */
export function getDeviceSdkInt(): Promise<number | undefined> {
  sdkIntPromise ??= AppUpdate.getVersion().then(
    (r) => {
      const n = Number((r as { sdkInt?: unknown }).sdkInt);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    },
    () => undefined,
  );
  return sdkIntPromise;
}
