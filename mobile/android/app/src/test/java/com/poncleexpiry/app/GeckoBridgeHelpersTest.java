package com.poncleexpiry.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeoutException;

/** JVM unit tests for the pure helpers behind the GeckoView bridge (stage G). */
public class GeckoBridgeHelpersTest {

    // -- PendingRequests: request-id matching -------------------------------

    @Test
    public void replyWithMatchingIdCompletesTheRequest() throws Exception {
        PendingRequests<String> p = new PendingRequests<>();
        long id = p.nextId();
        PendingRequests.Reply<String> r = p.register(id);
        assertTrue(p.complete(id, "ok"));
        assertEquals("ok", r.await(10));
        assertEquals(0, p.size());
    }

    @Test
    public void unknownOrRepeatedIdsAreIgnored() {
        PendingRequests<String> p = new PendingRequests<>();
        long id = p.nextId();
        p.register(id);
        assertFalse(p.complete(id + 1, "other"));
        assertTrue(p.complete(id, "first"));
        assertFalse(p.complete(id, "second"));   // already settled
        assertFalse(p.fail(id, new IOException()));
    }

    @Test
    public void idsAreUniqueAndPositive() {
        PendingRequests<String> p = new PendingRequests<>();
        long a = p.nextId();
        long b = p.nextId();
        assertTrue(a > 0);
        assertTrue(b > a);
    }

    @Test
    public void waitingWithoutReplyTimesOut() throws Exception {
        PendingRequests<String> p = new PendingRequests<>();
        PendingRequests.Reply<String> r = p.register(p.nextId());
        try {
            r.await(20);
            fail("expected timeout");
        } catch (TimeoutException expected) {
            // transient failure for the caller
        }
    }

    @Test
    public void closingAPortFailsOnlyItsOwnRequests() throws Exception {
        PendingRequests<String> p = new PendingRequests<>();
        Object oldPort = new Object();
        Object newPort = new Object();
        long a = p.nextId();
        long b = p.nextId();
        long c = p.nextId();
        PendingRequests.Reply<String> ra = p.register(a);
        PendingRequests.Reply<String> rb = p.register(b);
        p.register(c); // not posted yet: no tag
        assertTrue(p.tag(a, oldPort));
        assertTrue(p.tag(b, newPort));
        assertEquals(1, p.failTagged(oldPort, PendingRequests.portClosed()));
        try {
            ra.await(10);
            fail("expected failure");
        } catch (IOException expected) {
            // port closed -> network error
        }
        assertFalse(rb.isDone());
        assertEquals(2, p.size());
        assertFalse(p.tag(a, newPort)); // settled requests can't be re-tagged
    }

    @Test
    public void onlyIntegralPositiveNumbersAreRequestIds() {
        assertEquals(Long.valueOf(7), PendingRequests.idOf(7));
        assertEquals(Long.valueOf(7), PendingRequests.idOf(7L));
        assertEquals(Long.valueOf(7), PendingRequests.idOf(7.0));
        assertNull(PendingRequests.idOf("7"));     // a page-typed id like "12345" never matches
        assertNull(PendingRequests.idOf(null));
        assertNull(PendingRequests.idOf(0));
        assertNull(PendingRequests.idOf(-3));
        assertNull(PendingRequests.idOf(1.5));
        assertNull(PendingRequests.idOf(Double.NaN));
    }

    // -- PoncleFetch: response classification --------------------------------

    @Test
    public void dataNeeds200AndAJsonObjectWithList() {
        PoncleFetch.Fetch f = PoncleFetch.classify(200, " {\"total\":\"3\",\"list\":[]} ", 5L);
        assertNotNull(f.data);
        assertEquals(5L, f.serverDateMs);
        assertFalse(f.isTransientFailure());
    }

    @Test
    public void loginHtmlMalformedOrListlessJsonIsAnExpiry() {
        for (String body : new String[] {"<html>login</html>", "{bad", "{\"result\":0}", "", null}) {
            PoncleFetch.Fetch f = PoncleFetch.classify(200, body, 0L);
            assertNull(f.data);
            assertFalse(f.isTransientFailure());
        }
        assertFalse(PoncleFetch.classify(401, "", 0L).isTransientFailure());
        assertFalse(PoncleFetch.classify(403, "", 0L).isTransientFailure());
    }

    @Test
    public void serverTroubleIsTransient() {
        assertTrue(PoncleFetch.classify(503, "", 0L).isTransientFailure());
        assertTrue(PoncleFetch.classify(408, "", 0L).isTransientFailure());
        assertTrue(PoncleFetch.classify(429, "", 0L).isTransientFailure());
        // even a "list" body is not data unless the status is 200
        assertNull(PoncleFetch.classify(500, "{\"list\":[]}", 0L).data);
    }

    @Test
    public void replyWithoutResponseThrowsAsNetworkError() throws Exception {
        for (JSONObject r : new JSONObject[] {
            null,
            new JSONObject().put("ok", false),
            new JSONObject().put("ok", true),                 // no status
            new JSONObject().put("ok", true).put("status", 0), // opaque
        }) {
            try {
                PoncleFetch.fromReply(r);
                fail("expected IOException");
            } catch (IOException expected) {
                // retryable, never an expiry
            }
        }
    }

    @Test
    public void replyIsClassifiedWithItsDateHeader() throws Exception {
        JSONObject r = new JSONObject()
            .put("ok", true).put("status", 200)
            .put("date", "Mon, 16 Nov 2026 03:00:00 GMT")
            .put("body", "{\"list\":[{\"a\":1}],\"total\":1}");
        PoncleFetch.Fetch f = PoncleFetch.fromReply(r);
        assertNotNull(f.data);
        assertEquals(Instant.parse("2026-11-16T03:00:00Z").toEpochMilli(), f.serverDateMs);
        assertEquals("2026-11-16T03:00:00Z", PoncleFetch.toIsoUtc(f.serverDateMs));
    }

    @Test
    public void badOrMissingDateHeaderIsZero() {
        assertEquals(0L, PoncleFetch.parseHttpDate(null));
        assertEquals(0L, PoncleFetch.parseHttpDate(""));
        assertEquals(0L, PoncleFetch.parseHttpDate("yesterday"));
        assertEquals(0L, PoncleFetch.parseHttpDate("Mon, 16 Nov 2026 03:00:00 GMT trailing"));
    }

    @Test
    public void queryIsFormEncodedInOrder() {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("s", "customer-openphone");
        p.put("q", "홍 길동&x");
        p.put("start", null);
        assertEquals("/open/listOpen?s=customer-openphone&q=%ED%99%8D+%EA%B8%B8%EB%8F%99%26x&start=",
            PoncleFetch.pathWithQuery("/open/listOpen", p));
        assertEquals("/open/listOpen", PoncleFetch.pathWithQuery("/open/listOpen", new LinkedHashMap<>()));
        assertTrue(PoncleFetch.pathWithQuery("/open/listOpen", PoncleFetch.probeParams()).endsWith("&scale=1"));
    }

    // -- GeckoCookies: (de)serialization of the persisted cookie set ------------

    private static JSONObject cookie(String name, String domain, boolean hostOnly) throws Exception {
        return new JSONObject().put("name", name).put("value", "v-" + name)
            .put("domain", domain).put("hostOnly", hostOnly).put("path", "/")
            .put("secure", true).put("httpOnly", true).put("session", true);
    }

    @Test
    public void onlyPoncleCookiesSurvive() throws Exception {
        JSONArray in = new JSONArray()
            .put(cookie("MXSID", "m.poncle.co.kr", true))
            .put(cookie("SCALES", ".poncle.co.kr", false))
            .put(cookie("A", "poncle.co.kr", true))        // host-only on the parent: not ours
            .put(cookie("B", ".evil.example", false))
            .put(cookie("C", "m.poncle.co.kr.evil.example", true))
            .put("not an object")
            .put(new JSONObject().put("name", "").put("domain", "m.poncle.co.kr"));
        JSONArray out = GeckoCookies.sanitize(in);
        assertEquals(2, out.length());
        assertEquals("MXSID", out.getJSONObject(0).getString("name"));
        assertEquals("SCALES", out.getJSONObject(1).getString("name"));
    }

    @Test
    public void sanitizeKeepsOnlyKnownFields() throws Exception {
        JSONObject c = cookie("SCALES", ".poncle.co.kr", false)
            .put("session", false).put("expirationDate", 1.9e9)
            .put("sameSite", "lax").put("storeId", "x").put("evil", "<script>");
        JSONObject o = GeckoCookies.sanitize(new JSONArray().put(c)).getJSONObject(0);
        assertFalse(o.has("storeId"));
        assertFalse(o.has("evil"));
        assertEquals("lax", o.getString("sameSite"));
        assertEquals(1.9e9, o.getDouble("expirationDate"), 0.0);
        assertTrue(o.getBoolean("httpOnly"));
        assertFalse(o.getBoolean("session"));
    }

    @Test
    public void sessionCookiesDropExpiryAndBadPathsAreRooted() throws Exception {
        JSONObject c = cookie("MXSID", "m.poncle.co.kr", true)
            .put("expirationDate", 1.9e9).put("path", "open").put("sameSite", "weird");
        JSONObject o = GeckoCookies.sanitize(new JSONArray().put(c)).getJSONObject(0);
        assertTrue(o.getBoolean("session"));
        assertFalse(o.has("expirationDate"));
        assertFalse(o.has("sameSite"));
        assertEquals("/", o.getString("path"));
    }

    @Test
    public void oversizedValuesAndTooManyCookiesAreCapped() throws Exception {
        StringBuilder big = new StringBuilder();
        while (big.length() <= GeckoCookies.MAX_VALUE) big.append('x');
        JSONArray in = new JSONArray().put(cookie("BIG", "m.poncle.co.kr", true).put("value", big.toString()));
        assertEquals(0, GeckoCookies.sanitize(in).length());
        JSONArray many = new JSONArray();
        for (int i = 0; i < GeckoCookies.MAX_COOKIES + 10; i++) many.put(cookie("c" + i, "m.poncle.co.kr", true));
        assertEquals(GeckoCookies.MAX_COOKIES, GeckoCookies.sanitize(many).length());
    }

    @Test
    public void storedStringRoundTripsAndCorruptDataReadsEmpty() throws Exception {
        JSONArray in = new JSONArray().put(cookie("MXSID", "m.poncle.co.kr", true));
        String stored = GeckoCookies.serialize(in);
        JSONArray back = GeckoCookies.parse(stored);
        assertEquals(1, back.length());
        assertEquals("v-MXSID", back.getJSONObject(0).getString("value"));
        assertEquals(0, GeckoCookies.parse(null).length());
        assertEquals(0, GeckoCookies.parse("").length());
        assertEquals(0, GeckoCookies.parse("{not an array").length());
        // the WebView-era header string is not a Gecko cookie set
        assertEquals(0, GeckoCookies.parse("MXSID=abc; SCALES=1").length());
        assertEquals("[]", GeckoCookies.serialize(null));
    }

    @Test
    public void persistThrottle() {
        assertTrue(GeckoCookies.persistDue(1_000, 0, 30_000, false));       // never saved
        assertFalse(GeckoCookies.persistDue(10_000, 1_000, 30_000, false));
        assertTrue(GeckoCookies.persistDue(31_000, 1_000, 30_000, false));
        assertTrue(GeckoCookies.persistDue(10_000, 1_000, 30_000, true));   // forced (login)
        assertTrue(GeckoCookies.persistDue(500, 1_000, 30_000, false));     // clock went back
    }

    // -- PoncleHosts: top-frame pinning --------------------------------------

    @Test
    public void onlyPonclePagesMayLoadTopLevel() {
        assertTrue(PoncleHosts.isPoncleWebUrl("https://m.poncle.co.kr/open/mobile"));
        assertTrue(PoncleHosts.isPoncleWebUrl("https://poncle.co.kr/"));
        assertFalse(PoncleHosts.isPoncleWebUrl("https://m.poncle.co.kr.evil.example/"));
        assertFalse(PoncleHosts.isPoncleWebUrl("https://evilponcle.co.kr/"));
        assertFalse(PoncleHosts.isPoncleWebUrl("https://www.google.com/recaptcha/api2/anchor"));
        assertFalse(PoncleHosts.isPoncleWebUrl("javascript:alert(1)"));
        assertFalse(PoncleHosts.isPoncleWebUrl("data:text/html,x"));
        assertFalse(PoncleHosts.isPoncleWebUrl(null));
        assertFalse(PoncleHosts.isPoncleWebUrl("not a url"));
    }

    @Test
    public void loginScreenIsHttpsOnly() {
        // audit L36: the login screen (autofilled password) never follows plain http.
        assertTrue(PoncleHosts.isPoncleHttpsUrl("https://m.poncle.co.kr/member/login"));
        assertTrue(PoncleHosts.isPoncleHttpsUrl("HTTPS://m.poncle.co.kr/open/mobile"));
        assertFalse(PoncleHosts.isPoncleHttpsUrl("http://m.poncle.co.kr/member/login"));
        assertFalse(PoncleHosts.isPoncleHttpsUrl("https://evil.example/member/login"));
        assertFalse(PoncleHosts.isPoncleHttpsUrl("javascript:alert(1)"));
        assertFalse(PoncleHosts.isPoncleHttpsUrl(null));
        assertTrue(GeckoHost.BASE.startsWith("https://"));
        assertTrue(PoncleHosts.isPoncleHttpsUrl(GeckoHost.BASE + PoncleFetch.LIST_OPEN_REFERER));
    }

    @Test
    public void workerIsRecycledAfterConsecutiveTimeoutsOnly() {
        // audit L13: a connected but unresponsive worker port is force-reloaded.
        int streak = 0;
        streak = GeckoHost.nextTimeoutStreak(streak, true);
        assertFalse(GeckoHost.shouldRecycleWorker(streak));
        streak = GeckoHost.nextTimeoutStreak(streak, false); // an answer resets it
        assertEquals(0, streak);
        streak = GeckoHost.nextTimeoutStreak(streak, true);
        streak = GeckoHost.nextTimeoutStreak(streak, true);
        assertTrue(GeckoHost.shouldRecycleWorker(streak));
    }

    @Test
    public void workerMayOnlyNavigateToItsPageOrTheLoginRedirect() {
        assertTrue(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/open/mobile"));
        assertTrue(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/open/mobile?x=1"));
        assertTrue(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/member/login"));
        assertTrue(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/member/login?ret=/open/mobile"));
        assertTrue(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/"));
        assertTrue(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr"));
        // a page idle/session timer must never log the shared session out
        assertFalse(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/member/logout"));
        assertFalse(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/member/logout?ret=/member/login"));
        assertFalse(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/member/loginout"));
        assertFalse(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/open/mobile/../../member/logout"));
        assertFalse(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/pending/pending"));
        assertFalse(PoncleHosts.isWorkerUrl("https://m.poncle.co.kr/open/mobileX"));
        assertFalse(PoncleHosts.isWorkerUrl("https://evil.example/open/mobile"));
        assertFalse(PoncleHosts.isWorkerUrl("javascript:location='/member/logout'"));
        assertFalse(PoncleHosts.isWorkerUrl(null));
    }

    @Test
    public void loginPageDetection() {
        assertTrue(PoncleHosts.isLoginUrl("https://m.poncle.co.kr/member/login"));
        assertTrue(PoncleHosts.isLoginUrl("https://m.poncle.co.kr/member/login?ret=/open"));
        assertFalse(PoncleHosts.isLoginUrl("https://m.poncle.co.kr/open/mobile"));
        assertFalse(PoncleHosts.isLoginUrl("https://evil.example/member/login"));
        assertTrue(PoncleHosts.isLoginPath("/member/login"));
        assertFalse(PoncleHosts.isLoginPath(null));
    }

    // -- procLogin result code from the page observer -------------------------

    @Test
    public void observerResultCodes() {
        assertEquals(1, PoncleLoginActivity.resultCode(1));
        assertEquals(8, PoncleLoginActivity.resultCode(8.0));
        assertEquals(0, PoncleLoginActivity.resultCode(" 0 "));
        assertEquals(-1, PoncleLoginActivity.resultCode(null));
        assertEquals(-1, PoncleLoginActivity.resultCode(JSONObject.NULL));
        assertEquals(-1, PoncleLoginActivity.resultCode("ok"));
        assertEquals(-1, PoncleLoginActivity.resultCode(1.5));
        assertEquals(-1, PoncleLoginActivity.resultCode(new JSONObject()));
        assertSame(JSONObject.NULL, JSONObject.NULL); // sanity: real org.json on the test classpath
    }

    // -- logout: clear reply verification (audit B13) -----------------------

    @Test
    public void clearReplyOkOnlyForConfirmedClear() throws Exception {
        assertTrue(GeckoCookies.clearReplyOk(new JSONObject("{\"id\":1,\"kind\":\"cleared\",\"n\":3,\"left\":0}")));
        // bridge 1.0.3 replies carry no "left": still a confirmed clear
        assertTrue(GeckoCookies.clearReplyOk(new JSONObject("{\"id\":1,\"kind\":\"cleared\",\"n\":0}")));
        assertFalse(GeckoCookies.clearReplyOk(new JSONObject("{\"id\":1,\"kind\":\"cleared\",\"n\":2,\"left\":1}")));
        assertFalse(GeckoCookies.clearReplyOk(new JSONObject("{\"id\":1,\"kind\":\"error\"}")));
        assertFalse(GeckoCookies.clearReplyOk(new JSONObject("{\"id\":1}")));
        assertFalse(GeckoCookies.clearReplyOk(null));
    }

    @Test
    public void logoutNeedsAtLeastOneConfirmedGeckoClear() {
        assertTrue(GeckoCookies.logoutConfirmed(true, true));
        assertTrue(GeckoCookies.logoutConfirmed(true, false));
        assertTrue(GeckoCookies.logoutConfirmed(false, true));
        assertFalse(GeckoCookies.logoutConfirmed(false, false));
    }
}
