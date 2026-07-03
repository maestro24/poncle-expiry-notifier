import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.poncleexpiry.app",
  appName: "약정만료 알리미",
  webDir: "dist",
  android: {
    // We reuse the customer's real Poncle login session via a WebView, so keep
    // cookies/localStorage persistent across app launches.
    webContentsDebuggingEnabled: true,
  },
};

export default config;
