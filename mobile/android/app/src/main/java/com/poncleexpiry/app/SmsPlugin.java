package com.poncleexpiry.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.telephony.SmsManager;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Native SMS sending. The employee's phone IS the sending device, so one tap
 * sends the customer message directly.
 *
 * send() resolves as soon as the telephony framework ACCEPTS the message
 * (SmsManager returned without throwing). It deliberately does NOT wait for the
 * carrier's sent-result broadcast: that wait can take tens of seconds, and if the
 * app is backgrounded or killed meanwhile the message still goes out but the JS
 * side never gets to record it in the send history (customer texted, no record,
 * duplicate risk on the next scan). Resolving at hand-off shrinks that window to
 * milliseconds. Immediate failures (bad number, no SmsManager, SecurityException)
 * still reject with a real reason.
 *
 * Because the hand-off is not the outcome, send() first runs a preflight that
 * rejects the cases the framework would only report asynchronously: airplane mode,
 * no usable SIM, and dual-SIM with no default SMS SIM ("always ask", where the
 * picker could be cancelled). It then resolves with a unique send id and attaches
 * sent PendingIntents (one per part) aimed at {@link SmsSentReceiver}, which
 * records the carrier's per-id outcome in SharedPreferences even if the app was
 * killed. JS reads those with getSendResults() and calls ackSendResults() only
 * after it has persisted them (two-phase, so nothing is lost on a crash).
 *
 * Never logs the phone number or the message text.
 *
 * SEND_SMS is Play-restricted, so this app is a sideloaded internal tool.
 */
@CapacitorPlugin(
    name = "Sms",
    permissions = {
        @Permission(strings = { Manifest.permission.SEND_SMS }, alias = "sms")
    }
)
public class SmsPlugin extends Plugin {

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("sms") == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("sms", call, "reqPermCallback");
    }

    @PermissionCallback
    private void reqPermCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("sms") == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void send(PluginCall call) {
        String phone = call.getString("phone");
        String text = call.getString("text");
        if (phone == null || text == null || phone.isEmpty()) {
            call.reject("phone and text are required");
            return;
        }
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermCallback");
            return;
        }
        doSend(call, phone, text);
    }

    @PermissionCallback
    private void smsPermCallback(PluginCall call) {
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            doSend(call, call.getString("phone"), call.getString("text"));
        } else {
            call.reject("SMS 권한이 거부되었습니다");
        }
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("앱 설정 화면을 열 수 없습니다: " + e.getMessage());
        }
    }

    private void doSend(PluginCall call, String phone, String text) {
        String digits = normalizeNumber(phone);
        if (digits == null) {
            call.reject(INVALID_MOBILE_MESSAGE);
            return;
        }
        String blocked = preflightReason();
        if (blocked != null) {
            call.reject(blocked);
            return;
        }
        SmsManager sms = getSmsManager(defaultSmsSubscriptionId());
        if (sms == null) {
            call.reject("문자를 보낼 수 없습니다 (유심/통신 확인)");
            return;
        }

        String id = UUID.randomUUID().toString();
        try {
            ArrayList<String> parts = sms.divideMessage(text);
            int count = Math.max(parts.size(), 1);
            ArrayList<PendingIntent> sentIntents = new ArrayList<>(count);
            for (int i = 0; i < count; i++) {
                sentIntents.add(sentIntent(id, i, count));
            }
            if (parts.size() > 1) {
                sms.sendMultipartTextMessage(digits, null, parts, sentIntents, null);
            } else {
                sms.sendTextMessage(digits, null, text, sentIntents.get(0), null);
            }
        } catch (Exception e) {
            call.reject("문자 전송 실패: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("id", id);
        call.resolve(r);
    }

    /** All carrier outcomes recorded by SmsSentReceiver and not yet acknowledged:
     *  { results: [{ id, status: 'ok'|'fail', reason?, at }] } (oldest first). */
    @PluginMethod
    public void getSendResults(PluginCall call) {
        try {
            JSArray results = new JSArray();
            for (JSONObject o : SmsSentReceiver.finalResults(getContext())) {
                results.put(o);
            }
            JSObject r = new JSObject();
            r.put("results", results);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("발송 결과를 읽을 수 없습니다: " + e.getMessage());
        }
    }

    /** Drops the given ids from getSendResults(). Call only after JS persisted them. */
    @PluginMethod
    public void ackSendResults(PluginCall call) {
        JSArray ids = call.getArray("ids");
        if (ids == null) {
            call.reject("ids is required");
            return;
        }
        try {
            List<String> list = new ArrayList<>();
            for (int i = 0; i < ids.length(); i++) {
                Object v = ids.opt(i);
                if (v instanceof String && !((String) v).isEmpty()) list.add((String) v);
            }
            SmsSentReceiver.ack(getContext(), list);
            call.resolve();
        } catch (Exception e) {
            call.reject("발송 결과 확인 처리 실패: " + e.getMessage());
        }
    }

    /** Explicit, immutable PendingIntent to SmsSentReceiver for one part. The data
     *  URI makes each (id, part) distinct so extras are never merged or reused. */
    private PendingIntent sentIntent(String id, int part, int count) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, SmsSentReceiver.class);
        intent.setAction(SmsSentReceiver.ACTION_SENT);
        intent.setData(Uri.parse("poncle-sms://sent/" + id + "/" + part));
        intent.putExtra(SmsSentReceiver.EXTRA_ID, id);
        intent.putExtra(SmsSentReceiver.EXTRA_PART, part);
        intent.putExtra(SmsSentReceiver.EXTRA_COUNT, count);
        int requestCode = (id.hashCode() * 31) + part;
        return PendingIntent.getBroadcast(ctx, requestCode, intent, PendingIntent.FLAG_IMMUTABLE);
    }

    /** Same text as the TS guard (sender.ts INVALID_MOBILE_MESSAGE) so the user sees
     *  one message whichever layer rejects the number (stage-3 review L7). */
    static final String INVALID_MOBILE_MESSAGE = "휴대폰 번호 형식이 올바르지 않습니다 (010으로 시작하는 10~11자리)";

    /** Korean mobile number after digit normalization: 01[016789] + 7-8 digits. */
    private static final Pattern KR_MOBILE = Pattern.compile("^01[016789]\\d{7,8}$");

    /**
     * Normalize to a Korean mobile number in domestic form (e.g. "01012345678") or
     * return null. Customers are only ever texted on a 휴대폰 number, so landlines,
     * short codes and run-together / overlong digit strings (22 digits used to pass)
     * are rejected instead of being reported as 발송됨. The international form
     * "+82 10-1234-5678" / "+82 010…" / "8210…" is converted to "010…". Package-
     * private + static so it stays a pure function.
     */
    static String normalizeNumber(String phone) {
        if (phone == null) return null;
        String trimmed = phone.trim();
        String digits = trimmed.replaceAll("[^0-9]", "");
        boolean intl = trimmed.startsWith("+");
        if (intl && !digits.startsWith("82")) return null; // foreign number
        // Same rule as the TS guard (sender.ts normalizeKrMobile): a leading 82 is
        // the country code (no domestic number starts with 82), with or without '+'.
        if (digits.startsWith("82")) {
            String rest = digits.substring(2);
            digits = rest.startsWith("0") ? rest : "0" + rest;
        }
        return KR_MOBILE.matcher(digits).matches() ? digits : null;
    }

    /**
     * Rejection reason when this device cannot send right now, else null. Uses only
     * APIs that need no extra permission (no READ_PHONE_STATE). If the SIM state
     * cannot be read at all it does not block: the sent-result receiver still
     * reports a real failure afterwards.
     */
    private String preflightReason() {
        Context ctx = getContext();
        try {
            if (Settings.Global.getInt(ctx.getContentResolver(), Settings.Global.AIRPLANE_MODE_ON, 0) != 0) {
                return "비행기 모드가 켜져 있어 문자를 보낼 수 없습니다";
            }
        } catch (Exception ignored) {
            // unreadable setting: fall through to the SIM checks
        }

        int readySims;
        try {
            readySims = countReadySims(ctx);
        } catch (Exception e) {
            return null; // unknown state: don't block, rely on the sent result
        }
        if (readySims == 0) {
            return "유심이 없거나 사용할 수 없어 문자를 보낼 수 없습니다";
        }
        if (readySims > 1 && !isValidSubId(defaultSmsSubscriptionId())) {
            return "기본 문자 발송 유심이 지정되지 않았습니다. 휴대폰 설정에서 기본 SIM을 지정하세요";
        }
        return null;
    }

    /** Number of SIM slots whose state is READY (0 when there is no telephony). */
    @SuppressWarnings("deprecation")
    private int countReadySims(Context ctx) {
        TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
        if (tm == null) return 0;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Per-slot state needs API 26; the default slot is all we can see.
            return tm.getSimState() == TelephonyManager.SIM_STATE_READY ? 1 : 0;
        }
        int slots = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? tm.getActiveModemCount()
            : tm.getPhoneCount();
        int ready = 0;
        for (int i = 0; i < slots; i++) {
            if (tm.getSimState(i) == TelephonyManager.SIM_STATE_READY) ready++;
        }
        return ready;
    }

    /** The user's default SMS subscription, or INVALID_SUBSCRIPTION_ID if none. */
    private int defaultSmsSubscriptionId() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                return SubscriptionManager.getDefaultSmsSubscriptionId();
            }
            return SmsManager.getDefaultSmsSubscriptionId();
        } catch (Exception e) {
            return SubscriptionManager.INVALID_SUBSCRIPTION_ID;
        }
    }

    /** Same rule as SubscriptionManager.isValidSubscriptionId (API 29+, minSdk is 23). */
    private static boolean isValidSubId(int subId) {
        return subId > SubscriptionManager.INVALID_SUBSCRIPTION_ID
            && subId != Integer.MAX_VALUE; // hidden DEFAULT_SUBSCRIPTION_ID placeholder
    }

    /** SmsManager bound to {@code subId} when it is valid, else the default one. */
    @SuppressWarnings("deprecation")
    private SmsManager getSmsManager(int subId) {
        try {
            boolean bound = isValidSubId(subId);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                SmsManager base = getContext().getSystemService(SmsManager.class);
                if (base == null) return null;
                return bound ? base.createForSubscriptionId(subId) : base;
            }
            return bound ? SmsManager.getSmsManagerForSubscriptionId(subId) : SmsManager.getDefault();
        } catch (Exception e) {
            return null;
        }
    }
}
