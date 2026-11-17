package com.poncleexpiry.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.telephony.SmsManager;

import org.json.JSONObject;
import org.junit.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * JVM tests for SmsSentReceiver's whole entry lifecycle (audit 2026-11-17 I7):
 * fold (pending / ok / fail) -> reported to JS (toResult) -> acked (tombstone)
 * -> late parts ignored -> pruned. The prefs file is modelled as a Map of the
 * stored JSON strings, exactly what SharedPreferences holds.
 */
public class SmsSentLifecycleTest {

    private static final int OK = Activity.RESULT_OK;
    private static final long DAY = 24L * 60 * 60 * 1000;

    /** One part's broadcast applied to the in-memory store (what recordPart does). */
    private static void part(Map<String, Object> store, String id, int part, int count, int code, long now)
        throws Exception {
        Object raw = store.get(id);
        JSONObject prev = raw == null ? null : new JSONObject((String) raw);
        JSONObject next = SmsSentReceiver.fold(prev, part, count, code, now);
        if (next != null) store.put(id, next.toString());
    }

    private static JSONObject entry(Map<String, Object> store, String id) throws Exception {
        return new JSONObject((String) store.get(id));
    }

    @Test
    public void pendingIsNeverReportedOkIsReportedOnce() throws Exception {
        Map<String, Object> store = new HashMap<>();
        part(store, "a", 0, 2, OK, 1000L);
        assertNull("pending must not reach JS", SmsSentReceiver.toResult("a", entry(store, "a")));
        part(store, "a", 1, 2, OK, 2000L);
        JSONObject r = SmsSentReceiver.toResult("a", entry(store, "a"));
        assertNotNull(r);
        assertEquals("a", r.getString("id"));
        assertEquals("ok", r.getString("status"));
        assertFalse(r.has("reason"));
        assertEquals(2000L, r.getLong("t"));
    }

    @Test
    public void failIsReportedWithReasonAndPartialCounts() throws Exception {
        Map<String, Object> store = new HashMap<>();
        part(store, "b", 0, 3, OK, 1L);
        part(store, "b", 1, 3, SmsManager.RESULT_ERROR_NO_SERVICE, 2L);
        JSONObject r = SmsSentReceiver.toResult("b", entry(store, "b"));
        assertEquals("fail", r.getString("status"));
        assertTrue(r.getString("reason").startsWith("일부만 전송되었을 수 있습니다"));
        assertTrue(r.getBoolean("partial"));
        assertEquals(1, r.getInt("okParts"));
        assertEquals(3, r.getInt("count"));
    }

    @Test
    public void ackedEntryIsATombstoneThatLatePartsCannotResurrect() throws Exception {
        Map<String, Object> store = new HashMap<>();
        part(store, "c", 0, 2, SmsManager.RESULT_ERROR_GENERIC_FAILURE, 500L);
        JSONObject tomb = SmsSentReceiver.tombstone(entry(store, "c"), 9_999L);
        assertEquals(SmsSentReceiver.STATUS_ACKED, tomb.getString("status"));
        assertEquals("keeps the entry's own time for pruning", 500L, tomb.getLong("t"));
        assertFalse("no reason / parts left behind", tomb.has("reason"));
        store.put("c", tomb.toString());
        assertNull(SmsSentReceiver.toResult("c", entry(store, "c")));
        part(store, "c", 1, 2, OK, 600L); // late part after the ack
        assertEquals(SmsSentReceiver.STATUS_ACKED, entry(store, "c").getString("status"));
        assertNull(SmsSentReceiver.toResult("c", entry(store, "c")));
    }

    @Test
    public void tombstoneWithoutATimeUsesNow() throws Exception {
        JSONObject tomb = SmsSentReceiver.tombstone(new JSONObject().put("status", "ok"), 42L);
        assertEquals(42L, tomb.getLong("t"));
    }

    @Test
    public void malformedAndUnknownEntriesAreNotReported() throws Exception {
        assertNull(SmsSentReceiver.toResult("x", new JSONObject().put("status", "weird")));
        assertNull(SmsSentReceiver.toResult("x", new JSONObject()));
    }

    @Test
    public void pruneDropsOldAndMalformedEntriesButNeverTheOneBeingWritten() throws Exception {
        long now = 100 * DAY;
        Map<String, Object> store = new HashMap<>();
        store.put("old", new JSONObject().put("status", "acked").put("t", now - 31 * DAY).toString());
        store.put("fresh", new JSONObject().put("status", "ok").put("t", now - DAY).toString());
        store.put("bad", "{not json");
        store.put("num", 5);
        store.put("keep", new JSONObject().put("status", "pending").put("t", now - 40 * DAY).toString());
        List<String> drop = SmsSentReceiver.keysToPrune(store, now, "keep", 500);
        assertTrue(drop.contains("old"));
        assertTrue(drop.contains("bad"));
        assertTrue(drop.contains("num"));
        assertFalse(drop.contains("fresh"));
        assertFalse(drop.contains("keep"));
    }

    @Test
    public void pruneCapsTheEntryCountOldestFirst() throws Exception {
        long now = 10 * DAY;
        Map<String, Object> store = new HashMap<>();
        for (int i = 0; i < 5; i++) {
            store.put("e" + i, new JSONObject().put("status", "acked").put("t", now - (5 - i) * 1000L).toString());
        }
        // max 3 entries including the one being written -> 2 of the 5 survive
        List<String> drop = SmsSentReceiver.keysToPrune(store, now, "new", 3);
        assertEquals(3, drop.size());
        assertTrue(drop.contains("e0"));
        assertTrue(drop.contains("e1"));
        assertTrue(drop.contains("e2"));
    }

    @Test
    public void limitExceededExplainsTheAndroidThirtyInThirtyMinutesPrompt() {
        String r = SmsSentReceiver.reasonFor(SmsManager.RESULT_ERROR_LIMIT_EXCEEDED);
        assertTrue(r, r.contains("30분"));
        assertTrue(r, r.contains("허용"));
        assertFalse(r, r.contains("잠시 후 다시 시도하세요"));
    }
}
