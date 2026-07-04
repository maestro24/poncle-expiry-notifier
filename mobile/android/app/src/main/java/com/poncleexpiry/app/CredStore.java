package com.poncleexpiry.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * At-rest encrypted store for the Poncle login id/password used by WebView
 * autofill. Backed by Android EncryptedSharedPreferences (AES-256, key in the
 * hardware-backed KeyStore). The password never leaves the device except when the
 * native login WebView injects it into Poncle's own login form, and is never logged.
 *
 * Self-healing: if the on-disk store can't be opened (KeyStore reset after a
 * backup/restore or OEM security-patch invalidation makes the ciphertext
 * undecryptable), we delete the corrupt store and recreate a fresh one instead of
 * throwing forever — which would otherwise leave autofill permanently broken. The
 * cost is that the saved credentials are lost and the user re-enters them once.
 */
public final class CredStore {
    private static final String FILE = "poncle_creds";
    private static final String K_ID = "id";
    private static final String K_PW = "pw";

    private CredStore() {}

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
            // Undecryptable / corrupt store -> drop it and start clean.
            deleteStore(ctx);
            return build(ctx); // if this still throws, callers handle it
        }
    }

    private static void deleteStore(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try { ctx.deleteSharedPreferences(FILE); } catch (Exception ignored) {}
        }
    }

    public static void save(Context ctx, String id, String pw) throws Exception {
        prefs(ctx).edit()
            .putString(K_ID, id == null ? "" : id)
            .putString(K_PW, pw == null ? "" : pw)
            .apply();
    }

    public static void clear(Context ctx) {
        try {
            prefs(ctx).edit().clear().apply();
        } catch (Exception e) {
            deleteStore(ctx);
        }
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
