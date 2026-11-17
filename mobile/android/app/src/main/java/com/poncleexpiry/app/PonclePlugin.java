package com.poncleexpiry.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native Poncle data access. Authenticated GETs to /open/listOpen and
 * /pending/listPending run INSIDE a hidden GeckoView page on m.poncle.co.kr
 * (GeckoHost.fetchJson) with the session of the in-app Gecko login, so Poncle
 * sees requests from its own page (Android System WebView logins are rejected by
 * Poncle's reCAPTCHA v3). The JSON is handed back to TS where all paging/expiry
 * logic lives (poncle-client.ts). Mirrors backend/session.py + poncle_client.py.
 * The Gecko session is pinned to m.poncle.co.kr (https, GeckoHost.BASE); the JS
 * `baseUrl` option is accepted for contract compatibility only and ignored —
 * the login screen too (audit L36).
 */
@CapacitorPlugin(name = "Poncle")
public class PonclePlugin extends Plugin {

    /** One-time migration flags (plain prefs, no secrets). */
    private static final String MIGRATION_PREFS = "poncle_migrations";
    private static final String K_LEGACY_WEBVIEW_COOKIES_CLEARED = "legacy_webview_cookies_cleared";

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        // Warm the Gecko engine (and restore the persisted session) while the app
        // boots, so the first session probe / scan doesn't pay the start-up cost.
        GeckoHost.get(getContext());
        clearLegacyWebViewCookiesOnce();
    }

    private GeckoHost host() {
        return GeckoHost.get(getContext());
    }

    /**
     * Up to v1.2.16 the Poncle login ran in the Android System WebView, whose
     * cookie jar (app_webview/) still holds that login's long-lived cookies (e.g.
     * the 2-year SCALE cookie). Nothing reads them any more (Gecko has its own
     * jar), so delete them once (audit L44). The app's own UI WebView
     * (https://localhost) keeps its state in Capacitor Preferences, never in
     * cookies, so removeAllCookies loses nothing. The flag is committed only after
     * WebView confirmed the removal, so a failure retries on the next launch.
     */
    private void clearLegacyWebViewCookiesOnce() {
        final Context app = getContext().getApplicationContext();
        final SharedPreferences flags = app.getSharedPreferences(MIGRATION_PREFS, Context.MODE_PRIVATE);
        if (flags.getBoolean(K_LEGACY_WEBVIEW_COOKIES_CLEARED, false)) return;
        removeAllWebViewCookies(ok -> {
            if (ok) flags.edit().putBoolean(K_LEGACY_WEBVIEW_COOKIES_CLEARED, true).apply();
        });
    }

    /** Result of a WebView cookie removal (UI thread). */
    private interface Done {
        void run(boolean ok);
    }

    /** CookieManager.removeAllCookies + flush, on the UI thread (its callback
     *  needs a Looper). Best-effort: a failure reports false. */
    private static void removeAllWebViewCookies(Done done) {
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                CookieManager cm = CookieManager.getInstance();
                cm.removeSessionCookies(null);
                cm.removeAllCookies(removed -> {
                    try {
                        cm.flush();
                    } catch (Exception ignored) {
                        // flush is best-effort
                    }
                    done.run(true);
                });
            } catch (Exception e) {
                // no WebView provider (updating / disabled): retry next launch
                done.run(false);
            }
        });
    }

    // -- login --------------------------------------------------------------
    @PluginMethod
    public void login(PluginCall call) {
        // No base URL is passed: the login screen always uses GeckoHost.BASE (L36).
        Intent intent = new Intent(getContext(), PoncleLoginActivity.class);
        startActivityForResult(call, intent, "loginResult");
    }

    @ActivityCallback
    private void loginResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        boolean ok = result != null && result.getResultCode() == Activity.RESULT_OK;
        // A verified login already persisted its cookies before finishing; this
        // also covers the manual "로그인 완료" path that could not verify.
        if (ok) io.execute(() -> host().persistCookies(true));
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void logout(PluginCall call) {
        // Drops the Gecko cookies AND the persisted copy (else the next launch
        // would restore it). Rejects when the Gecko cookies could not be confirmed
        // cleared, so the UI shows the retry message instead of "로그아웃됨".
        // Also drop any WebView-era Poncle cookies (audit L44), best-effort.
        removeAllWebViewCookies(ok -> { });
        io.execute(() -> {
            try {
                host().clearSession();
                call.resolve();
            } catch (Exception e) {
                call.reject("logout failed");
            }
        });
    }

    /** True when a Gecko cookie set is persisted (not necessarily still valid). */
    @PluginMethod
    public void hasSession(PluginCall call) {
        io.execute(() -> {
            boolean has;
            try {
                has = CookieStore.hasCookies(getContext());
            } catch (Exception e) {
                has = false;
            }
            JSObject ret = new JSObject();
            ret.put("value", has);
            call.resolve(ret);
        });
    }

    // -- saved credentials (autofill) ---------------------------------------
    @PluginMethod
    public void saveCredentials(PluginCall call) {
        String id = call.getString("id", "");
        String pw = call.getString("pw", "");
        try {
            CredStore.save(getContext(), id, pw);
            JSObject r = new JSObject();
            r.put("ok", true);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("failed to save credentials");
        }
    }

    /** Returns whether creds are stored and the id (never the password). */
    @PluginMethod
    public void getCredentialsMeta(PluginCall call) {
        JSObject r = new JSObject();
        try {
            r.put("hasCreds", CredStore.has(getContext()));
            r.put("id", CredStore.getId(getContext()));
        } catch (Exception e) {
            r.put("hasCreds", false);
            r.put("id", "");
        }
        call.resolve(r);
    }

    @PluginMethod
    public void clearCredentials(PluginCall call) {
        try {
            CredStore.clear(getContext());
        } catch (Exception e) {
            // best-effort clear
        }
        call.resolve();
    }

    // -- data ---------------------------------------------------------------
    @PluginMethod
    public void check(PluginCall call) {
        io.execute(() -> {
            try {
                PoncleFetch.Fetch f = host().fetchJson(
                    PoncleFetch.LIST_OPEN, PoncleFetch.probeParams(), PoncleFetch.LIST_OPEN_REFERER);
                boolean valid = f.data != null;
                if (valid) host().persistCookies(false); // refresh the persisted copy
                JSObject ret = new JSObject();
                ret.put("value", valid);
                // 5xx/408/429: the server is struggling, the session is not known to
                // be expired -> same 'unknown' treatment as a transport failure.
                ret.put("netError", f.isTransientFailure());
                ret.put("status", f.status);
                putServerDate(ret, f);
                call.resolve(ret);
            } catch (Exception e) {
                // fetchJson throws only when no response arrived (timeout / offline /
                // worker page unavailable): a network problem, not an expired
                // session. Flag it so the JS probe leaves the session 'unknown'.
                JSObject ret = new JSObject();
                ret.put("value", false);
                ret.put("netError", true);
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void listOpen(PluginCall call) {
        runList(call, PoncleFetch.LIST_OPEN, PoncleFetch.LIST_OPEN_REFERER);
    }

    @PluginMethod
    public void listPending(PluginCall call) {
        runList(call, PoncleFetch.LIST_PENDING, PoncleFetch.LIST_PENDING_REFERER);
    }

    /** Shared authenticated list GET: extract params, fetch off the UI thread,
     *  map the response to {ok, netError, status, serverDate, total, list}. */
    private void runList(PluginCall call, String path, String referer) {
        JSObject paramsObj = call.getObject("params", new JSObject());
        final Map<String, String> params = new LinkedHashMap<>();
        Iterator<String> keys = paramsObj.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            params.put(k, String.valueOf(paramsObj.opt(k)));
        }
        io.execute(() -> {
            JSObject ret = new JSObject();
            try {
                PoncleFetch.Fetch f = host().fetchJson(path, params, referer);
                ret.put("status", f.status);
                putServerDate(ret, f);
                if (f.data == null) {
                    // A response arrived but it is not data. A transient server status
                    // (5xx/408/429) is retryable (netError=true -> TS retries, then a
                    // network error / degraded 미결 fetch). Anything else (401/403,
                    // login HTML, JSON without "list") is a session expiry.
                    ret.put("ok", false);
                    ret.put("netError", f.isTransientFailure());
                    ret.put("total", 0);
                    ret.put("list", new JSArray());
                    call.resolve(ret);
                    return;
                }
                host().persistCookies(false); // keep the persisted copy fresh (throttled)
                ret.put("ok", true);
                ret.put("netError", false);
                ret.put("total", parseTotal(f.data.opt("total")));
                ret.put("list", toJSArray(f.data.optJSONArray("list")));
                call.resolve(ret);
            } catch (Exception e) {
                // Transport failure (timeout / offline, no response at all): retryable,
                // NOT a logout. Signal netError so the TS layer can retry / show a
                // network banner instead of forcing a pointless re-login.
                ret.put("ok", false);
                ret.put("netError", true);
                ret.put("total", 0);
                ret.put("list", new JSArray());
                call.resolve(ret);
            }
        });
    }

    /** Adds {@code serverDate} (the response's HTTP Date header, ISO-8601 UTC) when
     *  the server sent one, so JS can detect a wrong device clock (improvement 3-16). */
    private static void putServerDate(JSObject ret, PoncleFetch.Fetch f) {
        String iso = toIsoUtc(f.serverDateMs);
        if (iso != null) ret.put("serverDate", iso);
    }

    /** Epoch millis -> ISO-8601 UTC, or null when {@code ms <= 0}. */
    static String toIsoUtc(long ms) {
        return PoncleFetch.toIsoUtc(ms);
    }

    /** 5xx (server error / maintenance), 408 (request timeout), 429 (rate limited). */
    static boolean isTransientStatus(int code) {
        return PoncleFetch.isTransientStatus(code);
    }

    private long parseTotal(Object raw) {
        if (raw == null) return 0;
        try {
            return Long.parseLong(String.valueOf(raw).replace(",", "").trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private JSArray toJSArray(JSONArray arr) {
        JSArray out = new JSArray();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null) out.put(o);
        }
        return out;
    }
}
