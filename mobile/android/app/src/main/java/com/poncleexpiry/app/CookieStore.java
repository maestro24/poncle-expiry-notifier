package com.poncleexpiry.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONArray;

/**
 * At-rest encrypted store for the Poncle cookies exported from GeckoView, so a
 * login survives app process death. Gecko keeps Poncle's session cookie (MXSID,
 * no Expires) in memory only; GeckoHost exports the full cookie set (HttpOnly
 * included) through the bridge extension after login / successful requests and
 * imports it back on the next process start, before any Poncle page loads —
 * up to Poncle's own server-side session timeout, which no client trick can
 * extend.
 *
 * Stored shape: a JSON array (see GeckoCookies) under {@link #K_GECKO}. The old
 * WebView-era entries ("cookie" = "a=1; b=2" header string, "url") cannot be
 * used by Gecko; they are deleted on first read (the user logs in once more).
 *
 * Same AES-256 EncryptedSharedPreferences pattern as CredStore: the opened store
 * is cached for the process, and it self-heals (drop + recreate) only on a
 * DEFINITIVE decrypt failure (KeyStore reset, tag mismatch, corrupt keyset — see
 * CredStore.isDefinitiveDecryptFailure); a transient error is rethrown and the
 * persisted session is kept.
 */
public final class CookieStore {
    private static final String FILE = "poncle_cookie";
    private static final String K_GECKO = "gecko_cookies";
    /** WebView-era keys (<= v1.2.16): ignored and removed. */
    private static final String K_LEGACY_COOKIE = "cookie";
    private static final String K_LEGACY_URL = "url";

    private static final Object LOCK = new Object();
    private static volatile SharedPreferences cached;

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
        SharedPreferences p = cached;
        if (p != null) return p;
        synchronized (LOCK) {
            if (cached != null) return cached;
            Context app = CredStore.appContext(ctx);
            try {
                cached = build(app);
            } catch (Exception first) {
                if (!CredStore.isDefinitiveDecryptFailure(first)) throw first; // transient: keep it
                deleteStoreLocked(app);
                cached = build(app);
            }
            return cached;
        }
    }

    /** Read the stored array string; a definitive decrypt failure wipes the store
     *  and reads as "". Drops WebView-era entries on the way. */
    private static String readRaw(Context ctx) throws Exception {
        try {
            SharedPreferences p = prefs(ctx);
            if (p.contains(K_LEGACY_COOKIE) || p.contains(K_LEGACY_URL)) {
                p.edit().remove(K_LEGACY_COOKIE).remove(K_LEGACY_URL).apply();
            }
            String v = p.getString(K_GECKO, "");
            return v == null ? "" : v;
        } catch (Exception e) {
            if (!CredStore.isDefinitiveReadFailure(e)) throw e;
            deleteStore(ctx);
            return "";
        }
    }

    private static void deleteStore(Context ctx) {
        synchronized (LOCK) {
            deleteStoreLocked(CredStore.appContext(ctx));
        }
    }

    private static void deleteStoreLocked(Context app) {
        cached = null;
        CredStore.wipePrefsFile(app, FILE);
    }

    /** Persist the (sanitized) Gecko cookie array. An empty array is not stored:
     *  use {@link #clear} to forget the session. */
    public static void saveCookies(Context ctx, JSONArray cookies) throws Exception {
        String json = GeckoCookies.serialize(cookies);
        if ("[]".equals(json)) return;
        prefs(ctx).edit().putString(K_GECKO, json).remove(K_LEGACY_COOKIE).remove(K_LEGACY_URL).apply();
    }

    /** The stored cookie array (sanitized); empty when none / unreadable-for-good. */
    public static JSONArray getCookies(Context ctx) throws Exception {
        return GeckoCookies.parse(readRaw(ctx));
    }

    /** True when a Gecko cookie set is persisted (not necessarily still valid). */
    public static boolean hasCookies(Context ctx) throws Exception {
        return getCookies(ctx).length() > 0;
    }

    public static void clear(Context ctx) {
        try {
            prefs(ctx).edit().clear().apply();
        } catch (Exception e) {
            deleteStore(ctx);
        }
    }
}
