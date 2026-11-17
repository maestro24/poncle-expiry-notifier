# Releasing a new Android version

The app self-updates by checking GitHub Releases for the newest `android-v*` tag
and comparing it to the installed `versionName`. When a newer one exists, the app
shows an update popup that opens the APK download link.

**Build type:** ship the **release** build (`assembleRelease`), never `assembleDebug`.
A debug build is `android:debuggable="true"`: anyone with USB debugging can `run-as`
into the app and read the stored cookies, Poncle credentials and send history, and
Capacitor logs every plugin call's arguments (customer phone numbers and SMS text)
to logcat. The release build is not debuggable, so both are off. `minifyEnabled`
stays `false`.

**Signing:** every release APK must be signed with the *same* key so Android
allows an in-place update (no uninstall). The `release` buildType in
`android/app/build.gradle` uses `signingConfig signingConfigs.debug`, i.e. it is
signed with the machine's debug keystore, the same key every earlier (debug-built)
release used, so it updates existing installs in place. Every
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

1. Install the toolchain: JDK 21 (Android Studio JBR), Android SDK Platform 36, clone the
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

### Known risk: the signing key uses public default passwords (accepted for now)

Signing releases with the debug keystore is a **deliberate trade-off** so existing
installs update in place. Be aware of what it leaves open:

- The keystore's passwords and alias are the well-known defaults (`android` /
  `androiddebugkey`). The **private key itself is still unique to our keystore
  file**, so the defaults only protect it as well as the file is protected. Whoever
  holds a copy of that `debug.keystore` file can sign an APK that Android accepts
  as an in-place update of this app.
- Such an update would inherit the granted `SEND_SMS` permission and the app's
  stored data (Poncle cookies + saved login, send history, customer phone numbers).
- Making the release non-debuggable closes `run-as` and the logcat leak, but
  **does not** change this. Exploiting it still needs the attacker to get both
  the keystore file and a sideloaded APK onto the store phone.

Until rotation, treat `debug.keystore` like a production secret: never commit it,
never upload it to CI or a shared drive, copy it only over USB or private storage,
and keep the number of machines that hold it to a minimum.

**Planned fix (later):** move to a private release keystore with strong passwords,
kept outside the repo. Use APK Signature Scheme v3 key rotation
(`apksigner rotate` to create a lineage from the old key to the new one, then sign
with `--lineage`) so Android 9+ installs **update in place** onto the new key. Check
the minSdk first: devices older than Android 9 (API 28) ignore the rotation proof
and would need a one-time uninstall. Once rotated, publish only APKs signed with
the new key.

## Toolchain (since v1.2.17: GeckoView)

The Poncle login and all authenticated Poncle requests run in an embedded
**GeckoView** (Mozilla's Firefox engine), because Android System WebView logins
are rejected by Poncle's reCAPTCHA v3 (procLogin result 8). See
`android/app/src/main/java/com/poncleexpiry/app/GeckoHost.java`.

- **Android Gradle Plugin 8.12.3**, **Gradle 8.13** (wrapper), **compileSdk 36**
  (Android SDK Platform 36 must be installed), targetSdk 35, **minSdk 26**
  (Android 8.0), JDK 21 (Android Studio JBR).
- **GeckoView `org.mozilla.geckoview:geckoview:153.0.20260810162159`**, from
  Mozilla's Maven repository `https://maven.mozilla.org/maven2/` (declared in
  `android/build.gradle`, restricted to the `org.mozilla.geckoview` group). 153 is
  the newest GeckoView that builds on compileSdk 36 (see "Known risk: GeckoView
  engine age" below). GeckoView 153 declares `minSdkVersion 26` (144 declared 21), so the app's
  minSdk went from 23 to 26. See "Android 6.x / 7.x phones (minSdk 26)" below.
- **APK size**: GeckoView adds a native engine per ABI. Only `arm64-v8a` and
  `armeabi-v7a` are packaged (`ndk.abiFilters`; the app no longer installs on
  x86-only devices/emulators) and native libraries are stored compressed
  (`packaging.jniLibs.useLegacyPackaging true`) to keep the self-update download
  smaller. The release APK is about **168 MB** with GeckoView 153 (150 MB with 144; a few MB before GeckoView); dropping
  `armeabi-v7a` would bring it to roughly 90 MB. GitHub release assets allow
  this size; the in-app updater downloads it like before.
- **Bridge extension**: `android/app/src/main/assets/poncle-ext/` (manifest,
  `background.js`, `content.js`) is installed with GeckoView's
  `ensureBuiltIn`, which keeps an installed copy whose `version` is unchanged.
  **Bump `"version"` in `poncle-ext/manifest.json` whenever any file in that
  folder changes**, or existing installs keep running the old scripts. Then run
  `node scripts/poncle-ext-lock.mjs` to record it in `scripts/poncle-ext.lock.json`
  (it refuses when the files changed but the version did not go up).
  `tests/poncle-ext.test.ts` fails until the lock matches, and verify-release
  fails when the folder changed vs the previous published tag without a bump.
- `npx cap sync android` regenerates `capacitor.settings.gradle`,
  `app/capacitor.build.gradle` and `capacitor-cordova-android-plugins/build.gradle`
  (which still names AGP 8.7.2 in its own buildscript; the root 8.12.3 wins).
  That is expected; do not hand-edit those files.
- After the upgrade to the Gecko build, the old WebView session cannot be reused:
  every user logs in to Poncle **once** (saved id/password stay and are
  auto-filled). 1.2.17 also deletes the WebView-era Poncle cookies from the
  System WebView jar (`app_webview/`) once on first start and on every logout
  (`CookieManager.removeAllCookies`; the app's own UI keeps nothing in cookies).
- **Send history storage (1.2.17)**: `sent_log` moves from Capacitor
  Preferences (`CapacitorStorage.xml`, written with `apply()`) to the native
  `DurableKV` plugin (`poncle_durable_kv.xml`, written with `commit()`), so a
  process killed right after a send cannot lose the record. The first read
  copies the old Preferences value over and keeps the old copy (a downgrade to
  1.2.16 still sees the history as of the upgrade).

### Android 6.x / 7.x phones (minSdk 26)

Since 1.2.17 the minimum is **Android 8.0 (API 26)**; 1.2.16 and older ran on
Android 6.0+ (API 23). What that means for a phone on Android 6.x / 7.x:

- It **keeps working on the build it has** (1.2.16 or older): scans, sends and
  history are unaffected. It just never gets 1.2.17+.
- Builds up to 1.2.16 cannot compare the phone's Android version with the
  release, so they still show the update popup on every launch, and tapping
  업데이트 downloads the ~168 MB APK whose install then fails ("앱이 설치되지
  않았습니다" / parse error). The popup shows the release notes, so their **first
  line must say "Android 8.0 이상 필요"** (template in Steps 4) — that is the only
  warning these users get. Tell them to tap 나중에.
- 1.2.17+ reads `minSdk: N` from the notes and `getVersion().sdkInt`, and shows a
  one-time "이 휴대폰은 새 버전을 설치할 수 없습니다" notice instead of a popup.
- To move such a user to 1.2.17+: export a backup (설정 → 백업 파일 내보내기) on
  the old phone, install on an Android 8.0+ phone, import the backup there.
- Before any FUTURE minSdk increase: verify-release blocks it unless run with
  `--allow-minsdk-change`; only pass that after updating the notes' first line
  and the `minSdk:` marker.

### Headless worker (verify on a device before each release)

All scans / checks run in a hidden **worker** `GeckoSession` that has **no
GeckoView attached** (`GeckoHost.openWorker`). The 2026-11 spike only proved
`content.fetch` in a session shown in a GeckoView; a view-less session is a
background tab to Gecko unless it is marked active, so the worker calls
`setActive(true)` explicitly. **Status: not yet verified on a device.**

- Check: smoke-test §10 "헤드리스 워커" (force-stop, relaunch, scan **without**
  opening the login screen). Record the result (date, device, pass/fail) here.
- If it fails (every scan ends as a network error after ~20 s, "worker page
  unavailable"): attach the worker to an off-screen **1x1 `GeckoView`** owned by
  `MainActivity` (added to the Capacitor root layout, `setSession(worker)`,
  re-attached on activity recreate) and keep `setActive(true)`.
- The worker's top-level navigation is pinned to its own page
  (`/open/mobile`), the login redirect (`/member/login`) and the site root
  (`PoncleHosts.isWorkerUrl`). Anything else — above all `/member/logout`
  fired by a page idle/session timer — is refused and the current document
  stays, so the shared session is never logged out behind the user's back.
  (An XHR-only logout call from page script is not covered by this pin.)

### Login result observer

The login screen learns Poncle's `procLogin` answer (result 8 = reCAPTCHA
rejection) from a page-context observer that the content script injects as an
inline `<script>`. Firefox applies the page's CSP to such scripts. As of
2026-11-17 `https://m.poncle.co.kr/member/login` sends **no CSP** (header or
meta), so the inline observer runs. If Poncle adds a `script-src` without
`'unsafe-inline'`, the content script detects the missing observer and hooks
`XMLHttpRequest.open` through Xray (`wrappedJSObject` + `exportFunction`)
instead. If neither reports a result and Poncle clears the password field after
a submit, the app shows a generic "로그인 확인 필요" notice.

### Known risk: GeckoView engine age

GeckoView is **pinned to 153.0.20260810162159** (August 2026; Firefox 153), up
from 144 (October 2025). It is still about three months and six Firefox releases
behind current (159/160 at the 2026-11-17 review), so it lacks the Firefox
security fixes shipped since 153 (renderer / sandbox CVEs). It holds the Poncle
session cookie and the autofilled password, so an unpatched engine is the
largest remaining attack surface. Mitigations in place: top-level navigation is
pinned to Poncle hosts (login screen) and to the worker allowlist (worker); the
bridge extension's content scripts and cookie access are limited to
`m.poncle.co.kr`; no popups.

Why not newer (checked 2026-11-17 from the AAR metadata):

| GeckoView | needs |
|---|---|
| 145–153 | 153: minSdk 26 (144 was 21); `androidx.core` ≤ 1.18 (compileSdk 36, AGP ≥ 8.9.1) — builds on the current toolchain |
| 154–158 | `androidx.core` 1.19.0: **compileSdk 37** and **AGP ≥ 9.1** |
| 159–160 | the GeckoView AAR itself: **compileSdk 37.2** (`minCompileSdk=37`, `minCompileMinorSdk=2`); `androidx.core` 1.19.1 (AGP ≥ 9.1) |

Path to 159+ (current Firefox), in this order:

1. Install **Android SDK Platform 37** (with minor API level 2) in the SDK
   Manager. Set `compileSdkVersion` to 37 (minor 2) in `variables.gradle`.
2. AGP 9 (tested 2026-11-17: **AGP 9.3.3 + Gradle 9.5.0**, the minimum Gradle
   for 9.3.x). Capacitor 7.6.7's modules build under it **without editing
   `node_modules`** given these changes in our own files:
   - `android/gradle.properties`: `android.builtInKotlin=false` and
     `android.newDsl=false` (`@capacitor/filesystem` applies `kotlin-android`
     itself and the Capacitor modules use the legacy DSL/variant API; both flags
     are deprecated and go away in AGP 10, so Capacitor 8 is needed before then),
     plus `android.onlyEnableUnitTestForTheTestedBuildType=false` (otherwise AGP 9
     creates no `testReleaseUnitTest` task).
   - `android/app/build.gradle`: `getDefaultProguardFile('proguard-android.txt')`
     → `'proguard-android-optimize.txt'` (AGP 9 rejects the former).
3. Bump GeckoView. Our Java sources compile unchanged against the 159 API (no
   GeckoView deprecation warnings), checked by compiling with the AAR-metadata
   check skipped; re-run the smoke test (§10 login + headless worker).

- **At every release**, check `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/`
  for a newer version that still builds, and move to it when it passes the
  smoke test (§10 login + headless worker).

## Steps

1. Bump the version in `mobile/android/app/build.gradle`:
   - `versionName "1.0.1"`  (this is what the updater compares)
   - `versionCode 2`        (must strictly increase each release)

   Current: **1.2.18 / versionCode 31** (1.2.17 was 30 — the published tag).
   If anything in `assets/poncle-ext/` changed, bump its manifest version too
   and run `node scripts/poncle-ext-lock.mjs` (see Toolchain).

2. Run both test suites FIRST. **Any failure (non-zero exit) = stop; do not
   build or publish.**
   ```bash
   cd mobile && npx tsc --noEmit && npx vitest run   # types + TS domain/e2e + poncle-ext/release-check tests
   cd android
   JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew :app:testReleaseUnitTest
   ```
   The JVM tests (`android/app/src/test/java/com/poncleexpiry/app/`) cover the
   pure native helpers: SMS number normalization, the procLogin result parser,
   the server-Date ISO formatter and the CredStore wipe-only-on-definitive-failure
   rule, the SMS sent-result lifecycle (`SmsSentReceiver.fold` per-part state
   machine incl. the "일부만 전송되었을 수 있습니다" partial failure, the JS
   result shape, ack tombstones, pruning, the LIMIT_EXCEEDED reason), GeckoHost's
   startup ordering (`StartupGate`: restore once, ready once, give-up timer),
   plus the Gecko bridge helpers (request-id matching, response classification,
   HTTP Date parsing, cookie (de)serialization / filtering, the Poncle top-frame
   pinning rules).

3. Build the APK (only after step 2 passed):
   ```bash
   cd mobile
   npm run build
   npx cap sync android
   cd android
   JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleRelease
   ```
   `npm run apk` runs the same three steps (`npm run build && npx cap sync android
   && cd android && ./gradlew assembleRelease`; set JAVA_HOME first). Until 1.2.16
   it skipped the web build and produced a **debug** APK — never publish an APK
   from an older checkout's `npm run apk`. Always rebuild after the last source
   change: verify-release compares the APK's version with build.gradle, not its
   contents.
   Output: `mobile/android/app/build/outputs/apk/release/app-release.apk`

4. Verify the APK BEFORE publishing — run the script with the tag you are about
   to create. **Publish only when it ends with `모든 검사 통과` and exit code 0;
   any other exit code (1 = a check failed, 2 = could not run) means do not
   publish**:
   ```bash
   cd mobile                             # needs network: tags are read from origin
   node scripts/verify-release.mjs --tag android-v1.0.1
   # same thing: npm run release:verify -- --tag android-v1.0.1
   # 1.2.17 only (minSdk 23 -> 26 is intended):
   #   node scripts/verify-release.mjs --tag android-v1.2.17 --allow-minsdk-change
   ```
   It checks, and fails (exit 1) if any is wrong:
   - tag `android-vX.Y.Z` == the APK's `versionName` (a mismatch makes every
     install show the update popup on every launch — audit 1-38);
   - the APK's `versionName`/`versionCode` == `android/app/build.gradle` (not a
     stale APK from an earlier build);
   - the tag is NOT already on origin (`git ls-remote --tags origin`; local
     tags are ignored, so a clone without `git fetch --tags` cannot pass an
     already-published version — audit B14). Offline = FAIL;
   - the tag's version is higher than the latest published `android-v*` tag, and
     `versionCode` > that tag's (read from its `build.gradle`; the commit is
     fetched from origin if it is missing locally; `--prev-code N` overrides);
   - signing certificate SHA-1 == `9b7af897909350c95659dab296293384bafe23f7`;
   - the APK is NOT debuggable;
   - the APK contains `arm64-v8a` native code (every current phone);
   - minSdk did not go up vs the latest published release (its
     `variables.gradle`, or `--prev-apk`). An intended increase needs
     `--allow-minsdk-change` (1.2.17 itself: 23 → 26) and the release-notes
     first line + `minSdk:` marker updated (see "Android 6.x / 7.x phones");
   - `poncle-ext` did not change vs the latest published tag without a
     manifest version bump (a tag without the folder passes), and the folder
     matches `scripts/poncle-ext.lock.json`;
   - the `poncle-ext` packaged inside the APK (`assets/poncle-ext/*`) is the
     same as the working tree — an APK built before the last poncle-ext edit
     or version bump fails: rebuild it.
   It also prints the APK's permissions and the ones new since the previous
   release (vs `--prev-apk`, else that tag's source `AndroidManifest.xml`, so
   permissions merged in from libraries also show as new). Read the list; a
   new dangerous permission needs a reason before publishing.
   Options: `--apk <path>` (default: the release output above), `--prev-code N`,
   `--prev-apk <path>` (the previously published APK, for an exact minSdk /
   permission comparison), `--allow-minsdk-change`. It finds `aapt` /
   `apksigner` in the newest SDK build-tools (ANDROID_HOME or
   `android/local.properties`) and uses Android Studio's JBR if JAVA_HOME is unset.

   The same checks by hand (if you can't run Node):
   ```bash
   cd mobile/android
   BT="$ANDROID_HOME/build-tools/35.0.0"   # any installed build-tools version
   # a) Signature: SHA-1 must be the canonical key, or users can't update in place.
   "$BT/apksigner" verify --print-certs app/build/outputs/apk/release/app-release.apk \
     | grep -i "SHA-1"
   # must print ...SHA-1 digest: 9b7af897909350c95659dab296293384bafe23f7
   # (= 9B:7A:F8:97:90:93:50:C9:56:59:DA:B2:96:29:33:84:BA:FE:23:F7, lowercase, no colons)
   # b) Not debuggable: this must print NOTHING.
   "$BT/aapt" dump badging app/build/outputs/apk/release/app-release.apk \
     | grep -i "application-debuggable"
   # c) Version: versionName must equal the tag (without "android-v").
   "$BT/aapt" dump badging app/build/outputs/apk/release/app-release.apk | head -1
   ```
   After installing on a test phone you can double-check the flags:
   ```bash
   adb shell dumpsys package com.poncleexpiry.app | grep -i "pkgFlags"
   # must NOT contain DEBUGGABLE
   adb shell run-as com.poncleexpiry.app ls   # must fail: "package not debuggable"
   ```

5. Publish the release (asset name must end in `.apk`):
   ```bash
   cp mobile/android/app/build/outputs/apk/release/app-release.apk /tmp/poncle-expiry-alrimi-v1.0.1.apk
   gh release create android-v1.0.1 /tmp/poncle-expiry-alrimi-v1.0.1.apk \
     --repo maestro24/poncle-expiry-notifier \
     --title "약정만료 알리미 (Android) v1.0.1" \
     --notes-file notes.md
   ```
   Release-notes template (`notes.md`) — keep the first two lines exactly:
   ```text
   Android 8.0 이상 필요 (Android 7 이하 휴대폰은 이 버전을 설치할 수 없습니다)
   minSdk: 26

   이번 버전 변경 내용...
   ```
   - Line 1 is what builds up to 1.2.16 show verbatim in their update popup
     (they cannot compare the phone's Android version), so an Android 6.x/7.x
     user sees why the install would fail before downloading the APK. Keep it
     as long as minSdk stays 26.
   - `minSdk: N` must equal `minSdkVersion` in `android/variables.gradle`.
     Newer builds read it (with `AppUpdate.getVersion().sdkInt`) and do not offer
     a release the phone cannot install (audit B15: no popup, a one-time notice
     instead). Raise it here in the SAME release that raises the minSdk.

Existing installs (< 1.0.1) will show the update popup on next launch; tapping
업데이트 downloads this APK, and installing it updates in place.

## Backup / phone-switch policy (for support questions)

- Cloud backup is off (`allowBackup="false"`, `res/xml/data_extraction_rules.xml`).
- On Android 12+, a user-initiated device-to-device transfer copies the send
  history (`poncle_durable_kv.xml` since 1.2.17) and settings (so customers already texted are not texted again on the
  new phone), but NOT the saved Poncle login, the persisted session cookies, the
  GeckoView profile (`files/mozilla/`) or the old WebView data: after a phone
  switch the user logs in to Poncle once.
- On Android 11 and older nothing is transferred; use 설정 → 백업 파일 내보내기/가져오기.
