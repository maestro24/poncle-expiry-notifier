package com.poncleexpiry.app;

import android.app.Activity;
import android.content.Intent;
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

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native Poncle data access. Mirrors backend/session.py + poncle_client.py: it
 * reuses the WebView login cookies (CookieManager) for authenticated GETs to
 * /open/listOpen. Native requests bypass the WebView's CORS wall, and the JSON is
 * handed back to TS where all paging/expiry logic lives (poncle-client.ts).
 */
@CapacitorPlugin(name = "Poncle")
public class PonclePlugin extends Plugin {

    private static final String DEFAULT_BASE = "https://m.poncle.co.kr";
    private static final String UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    /** One-shot per process: restore the persisted cookie the first time we need
     *  a session, so it survives the OS recreating the app (see CookieStore). */
    private volatile boolean restoreAttempted = false;
    /** Last cookie value we wrote to CookieStore, so a multi-page scan doesn't
     *  re-encrypt+write the identical string on every page. */
    private volatile String lastSavedCookie = null;

    private String base(PluginCall call) {
        String b = call.getString("baseUrl", DEFAULT_BASE);
        if (b == null || b.isEmpty()) b = DEFAULT_BASE;
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        return b;
    }

    // -- login --------------------------------------------------------------
    @PluginMethod
    public void login(PluginCall call) {
        Intent intent = new Intent(getContext(), PoncleLoginActivity.class);
        intent.putExtra(PoncleLoginActivity.EXTRA_BASE_URL, base(call));
        startActivityForResult(call, intent, "loginResult");
    }

    @ActivityCallback
    private void loginResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        boolean ok = result != null && result.getResultCode() == Activity.RESULT_OK;
        // A fresh login just populated CookieManager — persist it so the session
        // survives the next process death (the core of the "keep me logged in" fix).
        if (ok) {
            final String b = base(call);
            io.execute(() -> saveSessionCookie(b));
        }
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void logout(PluginCall call) {
        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        // Also drop the persisted copy, else the next launch would restore it.
        CookieStore.clear(getContext());
        lastSavedCookie = null;
        restoreAttempted = true; // nothing to restore after an explicit logout
        call.resolve();
    }

    @PluginMethod
    public void hasSession(PluginCall call) {
        final String baseUrl = base(call);
        io.execute(() -> {
            restoreSessionCookieIfNeeded(baseUrl);
            String cookie = CookieManager.getInstance().getCookie(baseUrl);
            JSObject ret = new JSObject();
            ret.put("value", cookie != null && !cookie.trim().isEmpty());
            call.resolve(ret);
        });
    }

    // -- session cookie persistence -----------------------------------------
    /** Persist the current live cookie (encrypted) so it outlives the process.
     *  No-op when there's no cookie or it hasn't changed since the last save. */
    private void saveSessionCookie(String base) {
        try {
            String cookie = CookieManager.getInstance().getCookie(base);
            if (cookie == null || cookie.trim().isEmpty()) return;
            if (cookie.equals(lastSavedCookie)) return;
            CookieStore.save(getContext(), base, cookie);
            lastSavedCookie = cookie;
        } catch (Exception ignored) {
            // best-effort; a storage failure must never break a scan/login
        }
    }

    /** First time this process needs a session, re-inject the persisted cookie.
     *  Runs at most once per process — but only marks itself consumed after a
     *  *successful* attempt, so a transient KeyStore/store read failure lets a
     *  later same-process call retry rather than permanently losing the session.
     *
     *  We must NOT skip merely because CookieManager has *some* cookie: Android
     *  reloads persistent cookies (Poncle sets SCALE with a 2-year Expires) across
     *  process death while dropping the memory-only session cookie (PHPSESSID). So
     *  we restore unless *every* saved cookie name is already live — i.e. the full
     *  saved session is intact. Cookies are set one pair at a time (setCookie is
     *  unreliable with a semicolon-joined string). Runs on the single io thread,
     *  so no locking is needed around the flag. */
    private void restoreSessionCookieIfNeeded(String base) {
        if (restoreAttempted) return;
        try {
            String saved = CookieStore.getCookie(getContext());
            if (saved == null || saved.trim().isEmpty()) { restoreAttempted = true; return; } // nothing persisted
            CookieManager cm = CookieManager.getInstance();
            String live = cm.getCookie(base);
            if (allSavedNamesLive(live, saved)) { restoreAttempted = true; return; } // full session already present
            String savedUrl = CookieStore.getUrl(getContext());
            String url = (savedUrl == null || savedUrl.isEmpty()) ? base : savedUrl;
            cm.setAcceptCookie(true);
            for (String pair : saved.split(";")) {
                String p = pair.trim();
                if (!p.isEmpty()) cm.setCookie(url, p);
            }
            cm.flush();
            // setCookie is applied ASYNCHRONOUSLY by the WebView cookie thread. On a
            // cold start the very next native request (getJson) would otherwise read
            // getCookie() BEFORE PHPSESSID lands and go out with only the persistent
            // SCALE cookie -> the server returns the login page -> a FALSE "세션 만료"
            // even though the login is valid (the WebView, opened moments later, is
            // fine). Block (we're on the io thread) until the restored session cookie
            // names are actually visible via getCookie, bounded to ~1s.
            for (int i = 0; i < 40 && !allSavedNamesLive(cm.getCookie(base), saved); i++) {
                try { Thread.sleep(25); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
            lastSavedCookie = saved;   // don't immediately re-write the same value
            restoreAttempted = true;   // success — consume the one-shot
        } catch (Exception ignored) {
            // best-effort; leave restoreAttempted=false so a later call retries
        }
    }

    /** True when every cookie name in `saved` is also present in `live` — i.e. the
     *  persisted session is fully intact and needs no restore. Name-agnostic, so it
     *  stays correct even if Poncle's session cookie name (PHPSESSID) ever changes. */
    private static boolean allSavedNamesLive(String live, String saved) {
        java.util.Set<String> liveNames = cookieNames(live);
        for (String pair : saved.split(";")) {
            String name = cookieName(pair);
            if (name != null && !liveNames.contains(name)) return false;
        }
        return true;
    }

    /** Extract the name from a "name=value" cookie pair, or null if malformed. */
    private static String cookieName(String pair) {
        if (pair == null) return null;
        String p = pair.trim();
        int eq = p.indexOf('=');
        if (eq <= 0) return null;
        return p.substring(0, eq).trim();
    }

    /** The set of cookie names in a "a=1; b=2" header string. */
    private static java.util.Set<String> cookieNames(String header) {
        java.util.Set<String> names = new java.util.HashSet<>();
        if (header == null) return names;
        for (String pair : header.split(";")) {
            String n = cookieName(pair);
            if (n != null) names.add(n);
        }
        return names;
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
        final String baseUrl = base(call);
        io.execute(() -> {
            try {
                restoreSessionCookieIfNeeded(baseUrl);
                JSONObject data = getJson(baseUrl, "/open/listOpen", "/open/mobile", probeParams());
                boolean valid = data != null && data.has("list");
                if (valid) saveSessionCookie(baseUrl); // refresh the persisted copy
                JSObject ret = new JSObject();
                ret.put("value", valid);
                call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("value", false);
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void listOpen(PluginCall call) {
        runList(call, "/open/listOpen", "/open/mobile");
    }

    @PluginMethod
    public void listPending(PluginCall call) {
        runList(call, "/pending/listPending", "/pending/pending");
    }

    /** Shared authenticated list GET: extract params, fetch off the UI thread,
     *  map the response to {ok, netError, total, list} (same shape for both endpoints). */
    private void runList(PluginCall call, String path, String referer) {
        final String baseUrl = base(call);
        JSObject paramsObj = call.getObject("params", new JSObject());
        final java.util.Map<String, String> params = new java.util.LinkedHashMap<>();
        Iterator<String> keys = paramsObj.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            params.put(k, String.valueOf(paramsObj.opt(k)));
        }
        io.execute(() -> {
            JSObject ret = new JSObject();
            try {
                restoreSessionCookieIfNeeded(baseUrl);
                JSONObject data = getJson(baseUrl, path, referer, params);
                if (data == null || !data.has("list")) {
                    // getJson returns null only for the actual login page == session
                    // expired (other non-data responses throw -> the catch below).
                    ret.put("ok", false);
                    ret.put("netError", false);
                    ret.put("total", 0);
                    ret.put("list", new JSArray());
                    call.resolve(ret);
                    return;
                }
                saveSessionCookie(baseUrl); // keep the persisted copy fresh
                ret.put("ok", true);
                ret.put("netError", false);
                ret.put("total", parseTotal(data.opt("total")));
                ret.put("list", toJSArray(data.optJSONArray("list")));
                call.resolve(ret);
            } catch (Exception e) {
                // Transport failure (timeout / IO / non-200): retryable, NOT a
                // logout. Signal netError so the TS layer can retry / show a
                // network banner instead of forcing a pointless re-login.
                ret.put("ok", false);
                ret.put("netError", true);
                ret.put("total", 0);
                ret.put("list", new JSArray());
                call.resolve(ret);
            }
        });
    }

    // -- http ---------------------------------------------------------------
    /** Authenticated GET of a Poncle list endpoint. Returns the parsed JSON when it
     *  is data (a JSON object with a "list"); returns null ONLY when the response is
     *  the login page (a real session expiry); THROWS for anything else (non-200,
     *  or an ambiguous non-data 200) so the caller treats it as a retryable error
     *  rather than a false logout. `path` e.g. "/open/listOpen"; `referer` e.g. "/open/mobile". */
    private JSONObject getJson(String baseUrl, String path, String referer, Map<String, String> params) throws Exception {
        StringBuilder qs = new StringBuilder();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (qs.length() > 0) qs.append('&');
            qs.append(URLEncoder.encode(e.getKey(), "UTF-8"))
              .append('=')
              .append(URLEncoder.encode(e.getValue() == null ? "" : e.getValue(), "UTF-8"));
        }
        URL url = new URL(baseUrl + path + "?" + qs);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("User-Agent", UA);
        conn.setRequestProperty("Accept", "application/json, text/javascript, */*; q=0.01");
        conn.setRequestProperty("X-Requested-With", "XMLHttpRequest");
        conn.setRequestProperty("Referer", baseUrl + referer);
        conn.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.8");
        String cookie = CookieManager.getInstance().getCookie(baseUrl);
        if (cookie != null && !cookie.isEmpty()) {
            conn.setRequestProperty("Cookie", cookie);
        }
        try {
            int code = conn.getResponseCode();
            if (code != 200) throw new java.io.IOException("HTTP " + code); // transport error
            String finalUrl = conn.getURL() != null ? conn.getURL().toString() : "";
            String body = readBody(conn);
            String trimmed = body.trim();
            if (trimmed.startsWith("{")) {
                JSONObject data = new JSONObject(trimmed);
                if (data.has("list")) return data; // real data
                // JSON without "list" is abnormal but NOT a clear logout -> retryable.
                throw new java.io.IOException("unexpected JSON (no list)");
            }
            // Non-JSON: only a genuine login page means the session actually expired.
            // Any OTHER html (rate-limit/WAF block, error, maintenance) must NOT be
            // reported as a logout — doing so produced a false "세션 만료" while the
            // WebView (same cookies) was still logged in. Treat it as retryable.
            if (isLoginPage(finalUrl, trimmed)) return null; // -> session expired
            throw new java.io.IOException("non-data response (not login page)");
        } finally {
            conn.disconnect();
        }
    }

    /** Heuristic: is this response Poncle's login page (i.e. a real session expiry)?
     *  Checks the post-redirect final URL and the login form's field names (the same
     *  markers the WebView autofill keys on). Robust to both the 302-to-login and the
     *  inline-login-html expiry behaviours. */
    private static boolean isLoginPage(String finalUrl, String body) {
        String u = finalUrl == null ? "" : finalUrl.toLowerCase();
        if (u.contains("/member/login") || u.contains("/login")) return true;
        if (body == null) return false;
        return body.contains("name=\"userpw\"") || body.contains("name='userpw'")
            || body.contains("name=\"userid\"") || body.contains("name='userid'");
    }

    private String readBody(HttpURLConnection conn) throws Exception {
        InputStream is;
        try {
            is = conn.getInputStream();
        } catch (Exception e) {
            is = conn.getErrorStream();
            if (is == null) throw e;
        }
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = br.read(buf)) != -1) sb.append(buf, 0, n);
        }
        return sb.toString();
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

    private Map<String, String> probeParams() {
        Map<String, String> p = new java.util.LinkedHashMap<>();
        p.put("start", "");
        p.put("sort", "opendate");
        p.put("by", "desc");
        p.put("viewsum", "0");
        p.put("sdate", "");
        p.put("edate", "");
        p.put("openhow", "");
        p.put("cond", "");
        p.put("agency", "");
        p.put("member", "");
        p.put("mgubun", "");
        p.put("mmodel", "");
        p.put("s", "customer-openphone");
        p.put("q", "");
        p.put("scale", "1");
        return p;
    }
}
