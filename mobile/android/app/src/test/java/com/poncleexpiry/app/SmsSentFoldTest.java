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

/** JVM tests for SmsSentReceiver.fold — the per-part result state machine
 *  (audit L26: a multipart message with only some parts failed). */
public class SmsSentFoldTest {

    private static final int OK = Activity.RESULT_OK;
    private static final int FAIL = SmsManager.RESULT_ERROR_GENERIC_FAILURE;

    @Test
    public void singlePartOkIsFinalOk() throws Exception {
        JSONObject e = SmsSentReceiver.fold(null, 0, 1, OK, 1000L);
        assertEquals(SmsSentReceiver.STATUS_OK, e.getString("status"));
        assertFalse(e.has("reason"));
    }

    @Test
    public void allPartsOkIsOk() throws Exception {
        JSONObject e = SmsSentReceiver.fold(null, 0, 3, OK, 1L);
        assertEquals(SmsSentReceiver.STATUS_PENDING, e.getString("status"));
        e = SmsSentReceiver.fold(e, 2, 3, OK, 2L);
        assertEquals(SmsSentReceiver.STATUS_PENDING, e.getString("status"));
        e = SmsSentReceiver.fold(e, 1, 3, OK, 3L);
        assertEquals(SmsSentReceiver.STATUS_OK, e.getString("status"));
    }

    @Test
    public void failureWithNoPartSentKeepsThePlainReason() throws Exception {
        JSONObject e = SmsSentReceiver.fold(null, 0, 2, FAIL, 1L);
        assertEquals(SmsSentReceiver.STATUS_FAIL, e.getString("status"));
        assertEquals(SmsSentReceiver.reasonFor(FAIL), e.getString("reason"));
        assertEquals(0, e.optInt("okPartCount", -1));
    }

    @Test
    public void failureAfterSomePartsWentOutSaysPartial() throws Exception {
        JSONObject e = SmsSentReceiver.fold(null, 0, 3, OK, 1L);
        e = SmsSentReceiver.fold(e, 1, 3, FAIL, 2L);
        assertEquals(SmsSentReceiver.STATUS_FAIL, e.getString("status"));
        String reason = e.getString("reason");
        assertTrue(reason, reason.startsWith("일부만 전송되었을 수 있습니다"));
        assertTrue(reason, reason.contains(SmsSentReceiver.reasonFor(FAIL)));
        assertEquals(1, e.getInt("okPartCount"));
        assertEquals(3, e.getInt("count"));
    }

    @Test
    public void lateOkPartAfterAFailureTurnsItIntoPartial() throws Exception {
        JSONObject e = SmsSentReceiver.fold(null, 1, 2, FAIL, 1L);
        assertFalse(e.getString("reason").startsWith("일부만"));
        JSONObject late = SmsSentReceiver.fold(e, 0, 2, OK, 2L);
        assertNotNull(late);
        assertEquals(SmsSentReceiver.STATUS_FAIL, late.getString("status"));
        assertTrue(late.getString("reason").startsWith("일부만 전송되었을 수 있습니다"));
        assertEquals(1, late.getInt("okPartCount"));
    }

    @Test
    public void secondFailureChangesNothing() throws Exception {
        JSONObject e = SmsSentReceiver.fold(null, 0, 2, FAIL, 1L);
        assertNull(SmsSentReceiver.fold(e, 1, 2, SmsManager.RESULT_ERROR_NO_SERVICE, 2L));
    }

    @Test
    public void ackedAndOkEntriesIgnoreLateParts() throws Exception {
        JSONObject acked = new JSONObject().put("status", SmsSentReceiver.STATUS_ACKED).put("t", 1L);
        assertNull(SmsSentReceiver.fold(acked, 0, 2, OK, 2L));
        assertNull(SmsSentReceiver.fold(acked, 0, 2, FAIL, 2L));
        JSONObject ok = SmsSentReceiver.fold(null, 0, 1, OK, 1L);
        assertNull(SmsSentReceiver.fold(ok, 0, 1, FAIL, 2L));
    }

    @Test
    public void duplicateOkPartIsCountedOnce() throws Exception {
        JSONObject e = SmsSentReceiver.fold(null, 0, 2, OK, 1L);
        e = SmsSentReceiver.fold(e, 0, 2, OK, 2L);
        assertEquals(SmsSentReceiver.STATUS_PENDING, e.getString("status"));
        e = SmsSentReceiver.fold(e, 1, 2, FAIL, 3L);
        assertEquals(1, e.getInt("okPartCount"));
    }
}
