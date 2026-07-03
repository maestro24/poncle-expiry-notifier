// Temporary bootstrap entry. Replaced by the real UI once the Android design
// (약정만료 알리미 (Android).dc.html) is wired in. Kept minimal so the toolchain
// (Vite build -> Capacitor sync -> Gradle APK) can be validated first.
const app = document.getElementById("app");
if (app) {
  app.textContent = "약정만료 알리미 (Android) - toolchain OK";
}
