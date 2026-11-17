package com.poncleexpiry.app;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.telephony.SmsManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * Receives the carrier's per-part "sent" result for messages handed off by
 * {@link SmsPlugin#send}. Manifest-registered (not exported), so it runs even when
 * the app process was killed after the hand-off.
 *
 * Each send id gets one entry in SharedPreferences "poncle_sms_results"
 * (key = id, value = JSON). Internal states:
 *   pending — some parts reported OK, not all yet (never exposed to JS)
 *   ok      — every part reported RESULT_OK
 *   fail    — at least one part failed (first failure's reason wins). The parts
 *             that DID go out are kept (okParts / okPartCount); when there are
 *             any, the reason starts with "일부만 전송되었을 수 있습니다" (audit
 *             L26), and a late OK part still updates that count until acked
 *   acked   — JS persisted the outcome; kept only as a tombstone so a late part
 *             cannot resurrect the entry (never exposed to JS)
 * Entries older than 30 days are pruned, and at most MAX_ENTRIES are kept.
 *
 * Never stores or logs the phone number or the message text.
 */
public class SmsSentReceiver extends BroadcastReceiver {

    public static final String ACTION_SENT = "com.poncleexpiry.app.SMS_SENT";
    public static final String EXTRA_ID = "poncle_sms_id";
    public static final String EXTRA_PART = "poncle_sms_part";
    public static final String EXTRA_COUNT = "poncle_sms_count";

    static final String PREFS = "poncle_sms_results";

    static final String STATUS_PENDING = "pending";
    static final String STATUS_OK = "ok";
    static final String STATUS_FAIL = "fail";
    static final String STATUS_ACKED = "acked";

    private static final long MAX_AGE_MS = 30L * 24 * 60 * 60 * 1000;
    private static final int MAX_ENTRIES = 500;

    /** Guards every read-modify-write of the prefs file (receiver = main thread,
     *  plugin methods = Capacitor's plugin thread). */
    private static final Object LOCK = new Object();

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_SENT.equals(intent.getAction())) return;
        String id = intent.getStringExtra(EXTRA_ID);
        int part = intent.getIntExtra(EXTRA_PART, -1);
        int count = intent.getIntExtra(EXTRA_COUNT, 0);
        if (id == null || id.isEmpty() || part < 0 || count <= 0 || part >= count) return;
        recordPart(context, id, part, count, getResultCode());
    }

    /** Folds one part's result into the stored entry for {@code id}. */
    static void recordPart(Context context, String id, int part, int count, int resultCode) {
        synchronized (LOCK) {
            SharedPreferences prefs = prefs(context);
            JSONObject entry;
            long now = System.currentTimeMillis();
            try {
                entry = fold(parse(prefs.getString(id, null)), part, count, resultCode, now);
            } catch (JSONException e) {
                return;
            }
            if (entry == null) return; // nothing changes (final / acked / repeat failure)
            SharedPreferences.Editor ed = prefs.edit();
            ed.putString(id, entry.toString());
            prune(prefs, ed, now, id);
            // commit (not apply): the process may die right after onReceive returns.
            ed.commit();
        }
    }

    /**
     * Pure state transition for one part's result: the new entry to store, or
     * null when nothing changes. Pending -> ok once every part reported OK;
     * pending -> fail on the first failed part. A failed entry keeps the parts
     * that DID go out (okParts) and, when there is at least one, says so with a
     * distinct reason ("일부만 전송되었을 수 있습니다", audit L26) — the customer may
     * already have part of the text. An OK part arriving after the failure (the
     * carrier reports parts in any order) still updates that count until JS acks.
     * ok / acked entries never change.
     */
    static JSONObject fold(JSONObject prev, int part, int count, int resultCode, long now) throws JSONException {
        JSONObject entry = prev == null ? null : new JSONObject(prev.toString());
        if (entry == null) {
            entry = new JSONObject();
            entry.put("status", STATUS_PENDING);
            entry.put("count", count);
            entry.put("okParts", new JSONArray());
        }
        String status = entry.optString("status", STATUS_PENDING);
        int total = entry.optInt("count", count);
        JSONArray okParts = entry.optJSONArray("okParts");
        if (okParts == null) okParts = new JSONArray();
        boolean ok = resultCode == Activity.RESULT_OK;
        if (STATUS_FAIL.equals(status)) {
            // Only a late OK part matters (the first failure's reason stays).
            if (!ok || containsInt(okParts, part) || !entry.has("failCode")) return null;
            okParts.put(part);
            entry.put("okParts", okParts);
            entry.put("okPartCount", okParts.length());
            entry.put("reason", failReason(entry.optInt("failCode"), okParts.length(), total));
            return entry;
        }
        if (!STATUS_PENDING.equals(status)) return null; // ok / acked: final
        if (ok) {
            if (!containsInt(okParts, part)) okParts.put(part);
            entry.put("okParts", okParts);
            if (okParts.length() >= total) {
                entry.put("status", STATUS_OK);
                entry.remove("okParts");
            }
        } else {
            entry.put("status", STATUS_FAIL);
            entry.put("failCode", resultCode);
            entry.put("okParts", okParts);
            entry.put("okPartCount", okParts.length());
            entry.put("reason", failReason(resultCode, okParts.length(), total));
        }
        entry.put("t", now);
        entry.put("at", iso(now));
        return entry;
    }

    /** Failure reason: the plain carrier reason, or — when some parts of a long
     *  message were already sent — a distinct "partly sent" reason (audit L26). */
    static String failReason(int code, int okPartCount, int count) {
        String base = reasonFor(code);
        if (okPartCount <= 0) return base;
        return "일부만 전송되었을 수 있습니다 (긴 문자 " + count + "개 중 " + okPartCount
            + "개 전송됨, 고객에게 확인하세요): " + base;
    }

    /** Final (ok/fail) results not yet acknowledged, oldest first. */
    static List<JSONObject> finalResults(Context context) {
        synchronized (LOCK) {
            List<JSONObject> out = new ArrayList<>();
            for (Map.Entry<String, ?> kv : prefs(context).getAll().entrySet()) {
                if (!(kv.getValue() instanceof String)) continue;
                JSONObject entry = parse((String) kv.getValue());
                if (entry == null) continue;
                JSONObject r = toResult(kv.getKey(), entry);
                if (r != null) out.add(r);
            }
            Collections.sort(out, (a, b) -> Long.compare(a.optLong("t"), b.optLong("t")));
            for (JSONObject r : out) r.remove("t");
            return out;
        }
    }

    /**
     * Pure: the JS-facing result for a stored entry, or null when it is not
     * final (pending / acked / unknown / malformed). Includes "t" (sort key,
     * removed before it reaches JS).
     */
    static JSONObject toResult(String id, JSONObject entry) {
        String status = entry.optString("status", "");
        if (!STATUS_OK.equals(status) && !STATUS_FAIL.equals(status)) return null;
        try {
            JSONObject r = new JSONObject();
            r.put("id", id);
            r.put("status", status);
            if (STATUS_FAIL.equals(status)) {
                r.put("reason", entry.optString("reason", "문자 전송 실패"));
                // Additive (TS ignores unknown fields): parts that DID go out.
                int okCount = entry.optInt("okPartCount", 0);
                if (okCount > 0) {
                    r.put("partial", true);
                    r.put("okParts", okCount);
                    r.put("count", entry.optInt("count", 0));
                }
            }
            r.put("at", entry.optString("at", ""));
            r.put("t", entry.optLong("t", 0));
            return r;
        } catch (JSONException e) {
            return null; // skip a malformed entry
        }
    }

    /** Pure: the acked tombstone for an entry (keeps only its time, for pruning). */
    static JSONObject tombstone(JSONObject entry, long now) throws JSONException {
        JSONObject tomb = new JSONObject();
        tomb.put("status", STATUS_ACKED);
        tomb.put("t", entry.optLong("t", now));
        return tomb;
    }

    /** Marks the given ids as handled by JS (tombstoned, no longer reported). */
    static void ack(Context context, Collection<String> ids) {
        synchronized (LOCK) {
            SharedPreferences prefs = prefs(context);
            SharedPreferences.Editor ed = prefs.edit();
            long now = System.currentTimeMillis();
            for (String id : ids) {
                if (id == null || id.isEmpty()) continue;
                JSONObject entry = parse(prefs.getString(id, null));
                if (entry == null) continue; // unknown id: nothing to ack
                try {
                    ed.putString(id, tombstone(entry, now).toString());
                } catch (JSONException ignored) {
                    ed.remove(id);
                }
            }
            ed.commit();
        }
    }

    // ---- helpers ----

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject parse(String raw) {
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    private static boolean containsInt(JSONArray arr, int v) {
        for (int i = 0; i < arr.length(); i++) {
            if (arr.optInt(i, -1) == v) return true;
        }
        return false;
    }

    /** Drops entries older than 30 days, then the oldest beyond MAX_ENTRIES. */
    private static void prune(SharedPreferences prefs, SharedPreferences.Editor ed, long now, String keep) {
        for (String key : keysToPrune(prefs.getAll(), now, keep, MAX_ENTRIES)) ed.remove(key);
    }

    /**
     * Pure: the keys to remove from {@code all} (the prefs map) — malformed
     * entries and those older than 30 days, then the oldest beyond
     * {@code maxEntries} counting the entry {@code keep} being written (never
     * removed itself).
     */
    static List<String> keysToPrune(Map<String, ?> all, long now, String keep, int maxEntries) {
        List<String> drop = new ArrayList<>();
        List<Object[]> live = new ArrayList<>(); // {key, t}
        for (Map.Entry<String, ?> kv : all.entrySet()) {
            String key = kv.getKey();
            if (key.equals(keep)) continue;
            JSONObject entry = kv.getValue() instanceof String ? parse((String) kv.getValue()) : null;
            long t = entry == null ? 0 : entry.optLong("t", 0);
            if (entry == null || now - t > MAX_AGE_MS) {
                drop.add(key);
            } else {
                live.add(new Object[] { key, t });
            }
        }
        int excess = live.size() + 1 - maxEntries; // +1 for the entry being written
        if (excess <= 0) return drop;
        Collections.sort(live, (a, b) -> Long.compare((Long) a[1], (Long) b[1]));
        for (int i = 0; i < excess && i < live.size(); i++) {
            drop.add((String) live.get(i)[0]);
        }
        return drop;
    }

    private static String iso(long millis) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(millis));
    }

    /** Korean, user-facing reason for a non-OK sent result code. */
    static String reasonFor(int code) {
        switch (code) {
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "휴대폰 무선 신호가 꺼져 있어 문자가 전송되지 않았습니다 (비행기 모드 확인)";
            case SmsManager.RESULT_ERROR_NO_SERVICE:
            case SmsManager.RESULT_RADIO_NOT_AVAILABLE:
                return "통신 서비스를 사용할 수 없어 문자가 전송되지 않았습니다 (신호·유심 확인)";
            case SmsManager.RESULT_ERROR_NULL_PDU:
            case SmsManager.RESULT_ENCODING_ERROR:
            case SmsManager.RESULT_INVALID_SMS_FORMAT:
                return "문자 내용을 만들지 못해 전송되지 않았습니다";
            case SmsManager.RESULT_ERROR_LIMIT_EXCEEDED:
                // Android's own anti-spam guard (SmsUsageMonitor): past ~30 texts
                // in 30 minutes from one app it shows a system prompt; 허용하지
                // 않음 (or the prompt being dismissed / timing out) ends here.
                // Not a carrier quota, so "wait a bit" alone is misleading
                // (audit 2026-11-17 I2).
                return "안드로이드 문자 발송 제한(30분에 30건 초과)에 걸려 전송되지 않았습니다. "
                    + "'많은 양의 SMS를 보내고 있습니다' 확인 창에서 '허용'을 누르지 않았거나 창이 닫혔습니다. "
                    + "다시 보낼 때 창이 뜨면 '허용'을 눌러 주세요";
            case SmsManager.RESULT_ERROR_FDN_CHECK_FAILURE:
                return "발신 제한 번호(FDN) 설정 때문에 전송되지 않았습니다";
            case SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED:
            case SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED:
                return "이 번호로는 문자를 보낼 수 없습니다";
            case SmsManager.RESULT_NETWORK_REJECT:
            case SmsManager.RESULT_NETWORK_ERROR:
                return "통신사 네트워크가 문자를 거부했습니다";
            case SmsManager.RESULT_NO_DEFAULT_SMS_APP:
                // The platform needs a default SMS app to send (e.g. it was removed or
                // disabled) — not a SIM-picker cancel (audit L3).
                return "기본 문자 앱이 설정되어 있지 않아 문자가 전송되지 않았습니다 (설정에서 기본 문자 앱을 지정하세요)";
            case SmsManager.RESULT_CANCELLED:
                return "문자 전송이 취소되었습니다 (발송 유심 선택 창을 닫았는지 확인하세요)";
            case SmsManager.RESULT_RIL_SIM_ABSENT:
                return "유심이 없거나 인식되지 않아 문자가 전송되지 않았습니다 (유심 확인)";
            case SmsManager.RESULT_SMS_BLOCKED_DURING_EMERGENCY:
                return "긴급 통화 중에는 문자를 보낼 수 없어 전송되지 않았습니다";
            case SmsManager.RESULT_SMS_SEND_RETRY_FAILED:
                return "통신사 재전송에 실패해 문자가 전송되지 않았습니다. 신호를 확인한 뒤 다시 시도하세요";
            case SmsManager.RESULT_INVALID_SMSC_ADDRESS:
                return "문자 센터(SMSC) 설정 오류로 전송되지 않았습니다";
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE:
                return "문자 전송에 실패했습니다 (통신사 오류)";
            default:
                return "문자 전송에 실패했습니다 (오류 코드 " + code + ")";
        }
    }
}
