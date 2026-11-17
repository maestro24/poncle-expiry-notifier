package com.poncleexpiry.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyPermanentlyInvalidatedException;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.security.GeneralSecurityException;
import java.util.Locale;

import javax.crypto.BadPaddingException;

/**
 * At-rest encrypted store for the Poncle login id/password used by WebView
 * autofill. Backed by Android EncryptedSharedPreferences (AES-256, key in the
 * hardware-backed KeyStore). The password never leaves the device except when the
 * native login WebView injects it into Poncle's own login form, and is never logged.
 *
 * The opened store is cached for the process (improvement 3-17): building it
 * initialises the KeyStore master key and the Tink keyset, which is slow and was
 * repeated on every read.
 *
 * Self-healing, but only on a DEFINITIVE decrypt failure (see
 * {@link #isDefinitiveDecryptFailure}, and on the value read path
 * {@link #isDefinitiveReadFailure}): if the ciphertext can never be decrypted
 * again (KeyStore key invalidated / lost after a restore, tag mismatch, corrupt
 * keyset) we delete the store and recreate a fresh one instead of throwing
 * forever, at the cost of the user re-entering the credentials once. A transient
 * error (KeyStore busy, IO) is rethrown and the saved credentials are KEPT, so a
 * hiccup no longer silently wipes them.
 */
public final class CredStore {
    private static final String FILE = "poncle_creds";
    private static final String K_ID = "id";
    private static final String K_PW = "pw";

    private static final Object LOCK = new Object();
    private static volatile SharedPreferences cached;

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
        SharedPreferences p = cached;
        if (p != null) return p;
        synchronized (LOCK) {
            if (cached != null) return cached;
            Context app = appContext(ctx);
            try {
                cached = build(app);
            } catch (Exception first) {
                if (!isDefinitiveDecryptFailure(first)) throw first; // transient: keep the store
                deleteStoreLocked(app);
                cached = build(app); // if this still throws, callers handle it
            }
            return cached;
        }
    }

    /**
     * Read one string. A value that can't be decrypted ({@link #isDefinitiveReadFailure})
     * first gets one retry on a freshly built store (drops a possibly stale cached
     * instance); only if that fails the same way is the store wiped and "" returned, so
     * the store self-heals instead of throwing on every getId/getPw. Transient errors
     * are rethrown and the credentials kept.
     */
    private static String read(Context ctx, String key) throws Exception {
        try {
            return readOnce(ctx, key);
        } catch (Exception e) {
            if (!isDefinitiveReadFailure(e)) throw e;
        }
        synchronized (LOCK) { cached = null; } // rebuild once, then retry
        try {
            return readOnce(ctx, key);
        } catch (Exception again) {
            if (!isDefinitiveReadFailure(again)) throw again;
            deleteStore(ctx);
            return "";
        }
    }

    private static String readOnce(Context ctx, String key) throws Exception {
        String v = prefs(ctx).getString(key, "");
        return v == null ? "" : v;
    }

    static Context appContext(Context ctx) {
        Context app = ctx.getApplicationContext();
        return app != null ? app : ctx;
    }

    private static void deleteStore(Context ctx) {
        synchronized (LOCK) {
            deleteStoreLocked(appContext(ctx));
        }
    }

    private static void deleteStoreLocked(Context app) {
        cached = null;
        wipePrefsFile(app, FILE);
    }

    /** Remove a SharedPreferences file (API 24+), or empty it on API 23. */
    static void wipePrefsFile(Context app, String file) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try { app.deleteSharedPreferences(file); } catch (Exception ignored) {}
        } else {
            try { app.getSharedPreferences(file, Context.MODE_PRIVATE).edit().clear().commit(); } catch (Exception ignored) {}
        }
    }

    /**
     * True when {@code t} (or any cause, up to a bounded depth) proves the stored
     * ciphertext can never be decrypted again: an AEAD tag / padding mismatch
     * (AEADBadTagException extends BadPaddingException), a KeyStore key that was
     * permanently invalidated, or a corrupt Tink keyset (shaded protobuf parse
     * error, matched by class name). Anything else is treated as transient.
     * Package-private + pure for JVM unit tests.
     */
    static boolean isDefinitiveDecryptFailure(Throwable t) {
        Throwable cur = t;
        for (int depth = 0; cur != null && depth < 12; depth++) {
            if (cur instanceof BadPaddingException) return true;
            if (cur instanceof KeyPermanentlyInvalidatedException) return true;
            if ("InvalidProtocolBufferException".equals(cur.getClass().getSimpleName())) return true;
            if (cur.getCause() == cur) break;
            cur = cur.getCause();
        }
        return false;
    }

    /**
     * Read-path variant of {@link #isDefinitiveDecryptFailure}. Tink's AEAD wrappers
     * swallow the per-key AEADBadTagException and throw a cause-less
     * GeneralSecurityException("decryption failed"), which EncryptedSharedPreferences
     * wraps as SecurityException("Could not decrypt value. ..."). So on the value read
     * path a SecurityException / GeneralSecurityException whose message mentions
     * "decrypt" is also definitive (value decryption is pure software AES-GCM with the
     * already-loaded keyset; no KeyStore call can make it transient). Package-private +
     * pure for JVM unit tests.
     */
    static boolean isDefinitiveReadFailure(Throwable t) {
        if (isDefinitiveDecryptFailure(t)) return true;
        Throwable cur = t;
        for (int depth = 0; cur != null && depth < 12; depth++) {
            if (cur instanceof SecurityException || cur instanceof GeneralSecurityException) {
                String m = cur.getMessage();
                if (m != null && m.toLowerCase(Locale.ROOT).contains("decrypt")) return true;
            }
            if (cur.getCause() == cur) break;
            cur = cur.getCause();
        }
        return false;
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
            deleteStore(ctx); // the user asked to forget them: unreadable or not, drop it
        }
    }

    public static String getId(Context ctx) throws Exception {
        return read(ctx, K_ID);
    }

    public static String getPw(Context ctx) throws Exception {
        return read(ctx, K_PW);
    }

    public static boolean has(Context ctx) throws Exception {
        String id = getId(ctx);
        String pw = getPw(ctx);
        return id != null && !id.isEmpty() && pw != null && !pw.isEmpty();
    }
}
