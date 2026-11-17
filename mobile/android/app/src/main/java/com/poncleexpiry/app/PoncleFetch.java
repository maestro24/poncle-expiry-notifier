package com.poncleexpiry.app;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * One authenticated Poncle list GET, as answered by the Gecko worker page's
 * content script (GeckoHost.fetchJson), and the pure rules that classify it.
 * Mirrors the PC backend's _looks_like_data (session.py): real data == HTTP 200 +
 * a JSON object carrying a "list". Everything here is side-effect free so it is
 * JVM unit-testable.
 */
final class PoncleFetch {

    static final String LIST_OPEN = "/open/listOpen";
    static final String LIST_OPEN_REFERER = "/open/mobile";
    static final String LIST_PENDING = "/pending/listPending";
    static final String LIST_PENDING_REFERER = "/pending/pending";

    private PoncleFetch() {}

    /** Outcome of one authenticated GET that DID receive a response. */
    static final class Fetch {
        /** HTTP status the server answered with. */
        final int status;
        /** The parsed JSON when it is real data (200 + object with "list"), else null. */
        final JSONObject data;
        /** The response's HTTP Date header (epoch ms), or 0 when absent. */
        final long serverDateMs;

        Fetch(int status, JSONObject data, long serverDateMs) {
            this.status = status;
            this.data = data;
            this.serverDateMs = serverDateMs;
        }

        /** No data AND the status says "try again later" — a retryable network
         *  error, NOT a session expiry (audit 1-18). */
        boolean isTransientFailure() {
            return data == null && isTransientStatus(status);
        }
    }

    /** 5xx (server error / maintenance), 408 (request timeout), 429 (rate limited). */
    static boolean isTransientStatus(int code) {
        return code >= 500 || code == 408 || code == 429;
    }

    /**
     * Classify a response. data != null only for HTTP 200 + a JSON object with a
     * "list". Anything else leaves data null and the caller tells a transient
     * status (5xx/408/429 -> retryable) apart from a session expiry (401/403, a
     * 200 login / WAF HTML page, malformed JSON, JSON without "list").
     */
    static Fetch classify(int status, String body, long serverDateMs) {
        if (status != 200) return new Fetch(status, null, serverDateMs);
        String trimmed = body == null ? "" : body.trim();
        if (!trimmed.startsWith("{")) return new Fetch(status, null, serverDateMs); // login page / WAF HTML
        JSONObject data;
        try {
            data = new JSONObject(trimmed);
        } catch (JSONException e) {
            return new Fetch(status, null, serverDateMs); // malformed JSON == not data
        }
        return new Fetch(status, data.has("list") ? data : null, serverDateMs);
    }

    /**
     * Turn the content script's reply ({ok, status, date, body}) into a Fetch.
     * THROWS IOException when no response was received at all (offline / DNS /
     * aborted: ok=false) or the reply is unusable — that is a network error, never
     * a session expiry. A null reply is the same.
     */
    static Fetch fromReply(JSONObject reply) throws IOException {
        if (reply == null || !reply.optBoolean("ok", false)) throw new IOException("no response");
        int status = reply.optInt("status", 0);
        if (status <= 0) throw new IOException("no status"); // opaque / aborted response
        long date = parseHttpDate(reply.optString("date", ""));
        return classify(status, reply.optString("body", ""), date);
    }

    /** RFC 1123 HTTP date ("Mon, 16 Nov 2026 03:00:00 GMT") -> epoch ms; 0 when
     *  absent or unparseable (the clock-skew check then simply has no sample). */
    static long parseHttpDate(String raw) {
        if (raw == null) return 0L;
        String s = raw.trim();
        if (s.isEmpty()) return 0L;
        SimpleDateFormat f = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("GMT"));
        f.setLenient(false);
        ParsePosition pos = new ParsePosition(0);
        Date d = f.parse(s, pos);
        if (d == null || pos.getIndex() != s.length()) return 0L;
        long ms = d.getTime();
        return ms > 0 ? ms : 0L;
    }

    /** Epoch millis -> "yyyy-MM-dd'T'HH:mm:ss'Z'" (UTC), or null when {@code ms <= 0}. */
    static String toIsoUtc(long ms) {
        if (ms <= 0) return null;
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    /** "/open/listOpen" + params -> "/open/listOpen?k=v&..." (form-encoded, order kept). */
    static String pathWithQuery(String path, Map<String, String> params) {
        StringBuilder qs = new StringBuilder();
        if (params != null) {
            for (Map.Entry<String, String> e : params.entrySet()) {
                if (e.getKey() == null) continue;
                if (qs.length() > 0) qs.append('&');
                qs.append(enc(e.getKey())).append('=').append(enc(e.getValue() == null ? "" : e.getValue()));
            }
        }
        return qs.length() == 0 ? path : path + "?" + qs;
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e); // UTF-8 always exists
        }
    }

    /** Params for a 1-row listOpen request: the cheapest authenticated probe. */
    static Map<String, String> probeParams() {
        Map<String, String> p = new LinkedHashMap<>();
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
        p.put("s", "all"); // Poncle retired "customer-openphone"; q is empty here anyway
        p.put("q", "");
        p.put("scale", "1");
        return p;
    }
}
