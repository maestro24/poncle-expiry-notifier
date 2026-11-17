package com.poncleexpiry.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/**
 * Pure helpers for the Poncle cookie set exported from / imported into Gecko
 * (background.js) and persisted encrypted by CookieStore. The array shape is
 * [{name, value, domain, hostOnly, path, secure, httpOnly, sameSite?, session,
 * expirationDate?}]. Only cookies that belong to m.poncle.co.kr (host-only) or to
 * m.poncle.co.kr / poncle.co.kr (domain cookies) survive; every other field is
 * dropped. Cookie names/values are never logged. JVM unit-testable.
 */
final class GeckoCookies {

    static final String HOST = "m.poncle.co.kr";
    static final String PARENT = "poncle.co.kr";
    static final int MAX_COOKIES = 64;
    static final int MAX_NAME = 256;
    static final int MAX_VALUE = 4096;

    private GeckoCookies() {}

    static String stripDot(String domain) {
        if (domain == null) return "";
        String d = domain.trim().toLowerCase(Locale.ROOT);
        return d.startsWith(".") ? d.substring(1) : d;
    }

    /** Domain rule shared with background.js#allowed. */
    static boolean isAllowedDomain(String domain, boolean hostOnly) {
        String d = stripDot(domain);
        if (hostOnly) return d.equals(HOST);
        return d.equals(HOST) || d.equals(PARENT);
    }

    /** A clean copy of one cookie, or null when it is not a usable Poncle cookie. */
    static JSONObject sanitizeOne(Object raw) {
        if (!(raw instanceof JSONObject)) return null;
        JSONObject c = (JSONObject) raw;
        Object name = c.opt("name");
        Object value = c.opt("value");
        Object domain = c.opt("domain");
        if (!(name instanceof String) || ((String) name).isEmpty() || ((String) name).length() > MAX_NAME) return null;
        if (value != null && value != JSONObject.NULL && !(value instanceof String)) return null;
        String v = value instanceof String ? (String) value : "";
        if (v.length() > MAX_VALUE) return null;
        if (!(domain instanceof String)) return null;
        boolean hostOnly = c.optBoolean("hostOnly", false);
        if (!isAllowedDomain((String) domain, hostOnly)) return null;
        String path = c.optString("path", "/");
        if (!path.startsWith("/")) path = "/";
        try {
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("value", v);
            o.put("domain", domain);
            o.put("hostOnly", hostOnly);
            o.put("path", path);
            o.put("secure", c.optBoolean("secure", false));
            o.put("httpOnly", c.optBoolean("httpOnly", false));
            String sameSite = c.optString("sameSite", "");
            if (sameSite.equals("lax") || sameSite.equals("strict") || sameSite.equals("no_restriction")) {
                o.put("sameSite", sameSite);
            }
            boolean session = c.optBoolean("session", !c.has("expirationDate"));
            o.put("session", session);
            Object exp = c.opt("expirationDate");
            if (!session && exp instanceof Number) {
                double e = ((Number) exp).doubleValue();
                if (!Double.isNaN(e) && !Double.isInfinite(e) && e > 0) o.put("expirationDate", e);
            }
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** Keep only usable Poncle cookies (at most {@link #MAX_COOKIES}); never null. */
    static JSONArray sanitize(JSONArray in) {
        JSONArray out = new JSONArray();
        if (in == null) return out;
        for (int i = 0; i < in.length() && out.length() < MAX_COOKIES; i++) {
            JSONObject c = sanitizeOne(in.opt(i));
            if (c != null) out.put(c);
        }
        return out;
    }

    /** Parse a stored array string; blank / corrupt / not-an-array -> empty. */
    static JSONArray parse(String stored) {
        if (stored == null || stored.trim().isEmpty()) return new JSONArray();
        try {
            return sanitize(new JSONArray(stored));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static String serialize(JSONArray cookies) {
        return sanitize(cookies).toString();
    }

    /** True only for a bridge reply that confirms the clear: kind "cleared" and
     *  no Poncle cookie left behind ({@code left}, reported by background.js
     *  1.0.4+; absent in older replies = 0). A null / "error" / timeout-less
     *  unknown reply is a failure. */
    static boolean clearReplyOk(JSONObject reply) {
        if (reply == null) return false;
        if (!"cleared".equals(reply.optString("kind"))) return false;
        return reply.optInt("left", 0) == 0;
    }

    /** Logout succeeded when at least one Gecko-side clear is confirmed: the
     *  bridge clear (cookies API) or the runtime StorageController clear of the
     *  poncle.co.kr base domain (covers m.poncle.co.kr). Neither confirmed means
     *  the Gecko session may still be alive, so the logout must be reported as
     *  failed. */
    static boolean logoutConfirmed(boolean bridgeCleared, boolean storageCleared) {
        return bridgeCleared || storageCleared;
    }

    /** Throttle for re-persisting after successful requests: due when forced,
     *  never saved yet, at least {@code intervalMs} passed, or the clock went back. */
    static boolean persistDue(long nowMs, long lastMs, long intervalMs, boolean force) {
        if (force || lastMs <= 0) return true;
        long age = nowMs - lastMs;
        return age < 0 || age >= intervalMs;
    }
}
