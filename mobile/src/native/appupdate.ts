/**
 * Bridge to the native `AppUpdate` Capacitor plugin (Java). getVersion reads the
 * installed versionName; openUrl hands a URL to the system browser / download
 * manager (used to fetch and install a newer APK for this sideloaded build).
 */
import { registerPlugin } from "@capacitor/core";

export interface AppUpdatePlugin {
  getVersion(): Promise<{ version: string }>;
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
