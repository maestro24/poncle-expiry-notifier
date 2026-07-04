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
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void logout(PluginCall call) {
        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        call.resolve();
    }

    @PluginMethod
    public void hasSession(PluginCall call) {
        String cookie = CookieManager.getInstance().getCookie(base(call));
        JSObject ret = new JSObject();
        ret.put("value", cookie != null && !cookie.trim().isEmpty());
        call.resolve(ret);
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
                JSONObject data = getListOpen(baseUrl, probeParams());
                JSObject ret = new JSObject();
                ret.put("value", data != null && data.has("list"));
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
        final String baseUrl = base(call);
        JSObject paramsObj = call.getObject("params", new JSObject());
        final java.util.Map<String, String> params = new java.util.LinkedHashMap<>();
        Iterator<String> keys = paramsObj.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            params.put(k, String.valueOf(paramsObj.opt(k)));
        }
        io.execute(() -> {
            try {
                JSONObject data = getListOpen(baseUrl, params);
                JSObject ret = new JSObject();
                if (data == null || !data.has("list")) {
                    ret.put("ok", false);
                    ret.put("total", 0);
                    ret.put("list", new JSArray());
                    call.resolve(ret);
                    return;
                }
                ret.put("ok", true);
                ret.put("total", parseTotal(data.opt("total")));
                ret.put("list", toJSArray(data.optJSONArray("list")));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("listOpen failed: " + e.getMessage());
            }
        });
    }

    // -- http ---------------------------------------------------------------
    /** GET /open/listOpen; return the parsed JSON object if it looks like data
     *  (a JSON object with a "list"), else null (login page / session expired). */
    private JSONObject getListOpen(String baseUrl, Map<String, String> params) throws Exception {
        StringBuilder qs = new StringBuilder();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (qs.length() > 0) qs.append('&');
            qs.append(URLEncoder.encode(e.getKey(), "UTF-8"))
              .append('=')
              .append(URLEncoder.encode(e.getValue() == null ? "" : e.getValue(), "UTF-8"));
        }
        URL url = new URL(baseUrl + "/open/listOpen?" + qs);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("User-Agent", UA);
        conn.setRequestProperty("Accept", "application/json, text/javascript, */*; q=0.01");
        conn.setRequestProperty("X-Requested-With", "XMLHttpRequest");
        conn.setRequestProperty("Referer", baseUrl + "/open/mobile");
        conn.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.8");
        String cookie = CookieManager.getInstance().getCookie(baseUrl);
        if (cookie != null && !cookie.isEmpty()) {
            conn.setRequestProperty("Cookie", cookie);
        }
        try {
            int code = conn.getResponseCode();
            if (code != 200) return null;
            String body = readBody(conn);
            String trimmed = body.trim();
            if (!trimmed.startsWith("{")) return null; // login page is HTML
            JSONObject data = new JSONObject(trimmed);
            return data.has("list") ? data : null;
        } finally {
            conn.disconnect();
        }
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
