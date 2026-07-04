# Releasing a new Android version

The app self-updates by checking GitHub Releases for the newest `android-v*` tag
and comparing it to the installed `versionName`. When a newer one exists, the app
shows an update popup that opens the APK download link.

**Signing:** every release APK must be signed with the *same* key so Android
allows an in-place update (no uninstall). We currently ship the debug-signed APK
built on the original dev machine (its `~/.android/debug.keystore` is stable), so
**always build releases on that same machine**. Do NOT let CI build the release
APK — CI uses a different debug key and the update would fail with a signature
mismatch. (If the app ever needs to be buildable elsewhere, switch to a dedicated
release keystore kept OUT of this public repo.)

## Steps

1. Bump the version in `mobile/android/app/build.gradle`:
   - `versionName "1.0.1"`  (this is what the updater compares)
   - `versionCode 2`        (must strictly increase each release)

2. Build the APK:
   ```bash
   cd mobile
   npm run build
   npx cap sync android
   cd android
   JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug
   ```
   Output: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`

3. Publish the release (asset name must end in `.apk`):
   ```bash
   cp mobile/android/app/build/outputs/apk/debug/app-debug.apk /tmp/poncle-expiry-alrimi-v1.0.1.apk
   gh release create android-v1.0.1 /tmp/poncle-expiry-alrimi-v1.0.1.apk \
     --repo maestro24/poncle-expiry-notifier \
     --title "약정만료 알리미 (Android) v1.0.1" \
     --notes "이번 버전 변경 내용..."
   ```

Existing installs (< 1.0.1) will show the update popup on next launch; tapping
업데이트 downloads this APK, and installing it updates in place.
