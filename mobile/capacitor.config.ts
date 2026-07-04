import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.poncleexpiry.app",
  appName: "약정만료 알리미",
  webDir: "dist",
  android: {
    // OFF in shipped builds: this app autofills the Poncle password into a login
    // WebView and holds customer PII, so remote WebView debugging (chrome://inspect
    // over ADB) must not be exposed. Flip to true only for local development.
    webContentsDebuggingEnabled: false,
  },
};

export default config;
