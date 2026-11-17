package com.poncleexpiry.app;

import java.net.URI;
import java.util.Locale;

/** URL rules for pinning the Gecko sessions to Poncle. Pure (java.net.URI) so
 *  they are JVM unit-testable. */
final class PoncleHosts {

    private PoncleHosts() {}

    private static URI parse(String url) {
        if (url == null) return null;
        try {
            return new URI(url.trim());
        } catch (Exception e) {
            return null;
        }
    }

    /** True if the URL's host is poncle.co.kr or a subdomain of it. */
    static boolean isPoncleHost(String url) {
        URI u = parse(url);
        String host = u == null ? null : u.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        return host.equals("poncle.co.kr") || host.endsWith(".poncle.co.kr");
    }

    /** A Poncle page that may be shown top-level: http(s) + a Poncle host
     *  (no data:, javascript:, file:, intent: …). */
    static boolean isPoncleWebUrl(String url) {
        URI u = parse(url);
        if (u == null || u.getScheme() == null) return false;
        String scheme = u.getScheme().toLowerCase(Locale.ROOT);
        return (scheme.equals("https") || scheme.equals("http")) && isPoncleHost(url);
    }

    /** {@link #isPoncleWebUrl} restricted to https: the login screen (which
     *  autofills the password) never follows a plain-http page (audit L36). */
    static boolean isPoncleHttpsUrl(String url) {
        URI u = parse(url);
        if (u == null || u.getScheme() == null) return false;
        return u.getScheme().toLowerCase(Locale.ROOT).equals("https") && isPoncleHost(url);
    }

    /** True only for the real Poncle login page (Poncle host, path /member/login). */
    static boolean isLoginUrl(String url) {
        URI u = parse(url);
        String path = u == null ? null : u.getPath();
        return isPoncleWebUrl(url) && path != null && path.contains("/member/login");
    }

    /**
     * Top-level loads the hidden WORKER session may follow: its own page
     * ({@link PoncleFetch#LIST_OPEN_REFERER}), the login page (where an expired
     * session may be sent) and the site root. Everything else is refused — above
     * all {@code /member/logout}, so a page idle/session timer can never log the
     * shared Gecko session out behind the user's back. A refused navigation keeps
     * the current worker document (and its content port) in place.
     */
    static boolean isWorkerUrl(String url) {
        if (!isPoncleWebUrl(url)) return false;
        URI u = parse(url);
        String path = u == null ? null : u.normalize().getPath();
        if (path == null) return false;
        String p = path.toLowerCase(Locale.ROOT);
        if (p.contains("logout") || p.contains("logoff")) return false;
        if (p.length() > 1 && p.endsWith("/")) p = p.substring(0, p.length() - 1);
        return p.isEmpty() || p.equals("/")
            || p.equals(PoncleFetch.LIST_OPEN_REFERER.toLowerCase(Locale.ROOT))
            || p.equals("/member/login");
    }

    /** Same test on a bare path reported by the content script. */
    static boolean isLoginPath(String path) {
        return path != null && path.contains("/member/login");
    }
}
