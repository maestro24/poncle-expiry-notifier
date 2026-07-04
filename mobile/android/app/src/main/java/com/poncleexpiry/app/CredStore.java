package com.poncleexpiry.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * At-rest encrypted store for the Poncle login id/password used by the WebView
 * autofill. Backed by Android EncryptedSharedPreferences (AES-256, key in the
 * hardware-backed KeyStore). The password never leaves the device except when
 * the native login WebView injects it into Poncle's own login form, and it is
 * never logged.
 */
public final class CredStore {
    private static final String FILE = "poncle_creds";
    private static final String K_ID = "id";
    private static final String K_PW = "pw";

    private CredStore() {}

    private static SharedPreferences prefs(Context ctx) throws Exception {
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

    public static void save(Context ctx, String id, String pw) throws Exception {
        prefs(ctx).edit()
            .putString(K_ID, id == null ? "" : id)
            .putString(K_PW, pw == null ? "" : pw)
            .apply();
    }

    public static void clear(Context ctx) throws Exception {
        prefs(ctx).edit().clear().apply();
    }

    public static String getId(Context ctx) throws Exception {
        return prefs(ctx).getString(K_ID, "");
    }

    public static String getPw(Context ctx) throws Exception {
        return prefs(ctx).getString(K_PW, "");
    }

    public static boolean has(Context ctx) throws Exception {
        String id = getId(ctx);
        String pw = getPw(ctx);
        return id != null && !id.isEmpty() && pw != null && !pw.isEmpty();
    }
}
