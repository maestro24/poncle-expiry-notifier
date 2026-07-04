# Releasing a new Android version

The app self-updates by checking GitHub Releases for the newest `android-v*` tag
and comparing it to the installed `versionName`. When a newer one exists, the app
shows an update popup that opens the APK download link.

**Signing:** every release APK must be signed with the *same* key so Android
allows an in-place update (no uninstall). We ship the debug-signed APK, and every
machine's `~/.android/debug.keystore` is different, so a build on a fresh machine
would be signed with a different key and the update would fail with a signature
mismatch. Do NOT let CI build the release APK for the same reason.

The canonical signing key is this project's debug keystore:
- Path: `~/.android/debug.keystore` (Windows: `C:\Users\<you>\.android\debug.keystore`)
- alias `androiddebugkey`, storepass/keypass `android`
- **SHA1 `9B:7A:F8:97:90:93:50:C9:56:59:DA:B2:96:29:33:84:BA:FE:23:F7`** (a build must
  match this or it will not update in place)

## Building releases on another computer (shared debug keystore)

To release from a second machine WITHOUT forcing users to reinstall, copy the
canonical debug keystore to that machine so its builds carry the same signature:

1. Install the toolchain: JDK 21 (Android Studio JBR), Android SDK 35, clone the
   repo, `cd mobile && npm install`.
2. Back up the new machine's own keystore, then copy ours over it:
   ```bash
   mv ~/.android/debug.keystore ~/.android/debug.keystore.bak 2>/dev/null || true
   # transfer our debug.keystore securely (USB / private storage — it is a signing
   # key, never commit it or post it publicly), then place it at:
   #   ~/.android/debug.keystore
   ```
3. Verify the signature matches BEFORE releasing:
   ```bash
   keytool -list -v -keystore ~/.android/debug.keystore -storepass android \
     -alias androiddebugkey | grep SHA1
   # must print 9B:7A:F8:97:90:93:50:C9:56:59:DA:B2:96:29:33:84:BA:FE:23:F7
   ```
4. Build + publish exactly as in the Steps below. The APK will update existing
   installs in place.

If you ever want release-from-anywhere or CI automation instead, switch to a
dedicated release keystore (kept OUT of this public repo) + a `signingConfig` — but
that changes the signature, so existing installs must be uninstalled once.

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
