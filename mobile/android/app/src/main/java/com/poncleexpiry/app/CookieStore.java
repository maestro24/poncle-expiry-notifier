package com.poncleexpiry.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * At-rest encrypted store for the Poncle *session cookie* string, so a login
 * survives app process death. Android's CookieManager keeps session cookies
 * (no Expires/Max-Age — which is what Poncle's login sets) in memory only, so
 * they vanish whenever the OS recreates the process (cold start, or a
 * background kill after switching apps). We persist the cookie ourselves right
 * after login and re-inject it on the next launch (see PonclePlugin), turning
 * the throwaway session cookie into one that outlives the process — up to
 * Poncle's own server-side session timeout, which no client trick can extend.
 *
 * Same AES-256 EncryptedSharedPreferences + self-healing pattern as CredStore:
 * if the on-disk store can't be decrypted (KeyStore reset), we drop it and
 * recreate a fresh one rather than throwing forever.
 */
public final class CookieStore {
    private static final String FILE = "poncle_cookie";
    private static final String K_COOKIE = "cookie";
    private static final String K_URL = "url";

    private CookieStore() {}

    private static SharedPreferences build(Context ctx) throws Exception {
        MasterKey key = new MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build();
        return EncryptedSharedPreferences.create(
            ctx,
            FILE,
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    private static SharedPreferences prefs(Context ctx) throws Exception {
        try {
            return build(ctx);
        } catch (Exception first) {
            deleteStore(ctx);
            return build(ctx);
        }
    }

    private static void deleteStore(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try { ctx.deleteSharedPreferences(FILE); } catch (Exception ignored) {}
        }
    }

    /** Persist the cookie string together with the base URL it belongs to. */
    public static void save(Context ctx, String url, String cookie) throws Exception {
        prefs(ctx).edit()
            .putString(K_URL, url == null ? "" : url)
            .putString(K_COOKIE, cookie == null ? "" : cookie)
            .apply();
    }

    public static String getCookie(Context ctx) throws Exception {
        return prefs(ctx).getString(K_COOKIE, "");
    }

    public static String getUrl(Context ctx) throws Exception {
        return prefs(ctx).getString(K_URL, "");
    }

    public static void clear(Context ctx) {
        try {
            prefs(ctx).edit().clear().apply();
        } catch (Exception e) {
            deleteStore(ctx);
        }
    }
}
