package com.poncleexpiry.app;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.telephony.SmsManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Native SMS sending. The employee's phone IS the sending device, so one tap
 * sends the customer message directly.
 *
 * Delivery confirmation: send() resolves ONLY after the telephony framework
 * reports RESULT_OK for every SMS part (via a sent PendingIntent). If the message
 * cannot leave the phone (no SIM, no signal, radio off, carrier reject) it rejects
 * with the real reason, so the app never records an undelivered message as "sent".
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

    private int sendSeq = 0;
    private static final long CONFIRM_TIMEOUT_MS = 45_000;

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

    private void doSend(PluginCall call, String phone, String text) {
        String digits = normalizeNumber(phone);
        if (digits == null) {
            call.reject("전화번호가 올바르지 않습니다");
            return;
        }
        SmsManager sms = getSmsManager();
        if (sms == null) {
            call.reject("문자를 보낼 수 없습니다 (유심/통신 확인)");
            return;
        }

        final ArrayList<String> parts;
        try {
            parts = sms.divideMessage(text);
        } catch (Exception e) {
            call.reject("문자 분할 실패: " + e.getMessage());
            return;
        }
        final int n = Math.max(1, parts.size());
        final Context ctx = getContext();
        final String action = ctx.getPackageName() + ".SMS_SENT." + (sendSeq++);

        // Track each part's sent result; resolve/reject once, when all report or on timeout.
        final int[] remaining = { n };
        final boolean[] done = { false };
        final String[] failReason = { null };
        final Handler main = new Handler(Looper.getMainLooper());

        final BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                int rc = getResultCode();
                if (rc != Activity.RESULT_OK && failReason[0] == null) {
                    failReason[0] = reasonFor(rc);
                }
                remaining[0]--;
                if (remaining[0] <= 0) finish();
            }

            private void finish() {
                if (done[0]) return;
                done[0] = true;
                try { ctx.unregisterReceiver(this); } catch (Exception ignored) {}
                if (failReason[0] != null) call.reject("문자 전송 실패: " + failReason[0]);
                else call.resolve();
            }
        };

        ContextCompat.registerReceiver(
            ctx, receiver, new IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED);

        // Timeout so a never-arriving broadcast rejects rather than hangs forever.
        main.postDelayed(() -> {
            if (done[0]) return;
            done[0] = true;
            try { ctx.unregisterReceiver(receiver); } catch (Exception ignored) {}
            call.reject("문자 전송 확인 시간 초과");
        }, CONFIRM_TIMEOUT_MS);

        try {
            ArrayList<PendingIntent> sentIntents = new ArrayList<>();
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
            for (int i = 0; i < n; i++) {
                sentIntents.add(PendingIntent.getBroadcast(ctx, i, new Intent(action), flags));
            }
            if (n > 1) {
                sms.sendMultipartTextMessage(digits, null, parts, sentIntents, null);
            } else {
                sms.sendTextMessage(digits, null, text, sentIntents.get(0), null);
            }
        } catch (Exception e) {
            if (!done[0]) {
                done[0] = true;
                try { ctx.unregisterReceiver(receiver); } catch (Exception ignored) {}
                call.reject("문자 전송 실패: " + e.getMessage());
            }
        }
    }

    /** digits (keep a single leading +); null if it can't be a dialable number. */
    private String normalizeNumber(String phone) {
        if (phone == null) return null;
        String plus = phone.trim().startsWith("+") ? "+" : "";
        String digits = phone.replaceAll("[^0-9]", "");
        if (digits.length() < 8) return null; // not a plausible MSISDN
        return plus + digits;
    }

    private String reasonFor(int resultCode) {
        switch (resultCode) {
            case SmsManager.RESULT_ERROR_NO_SERVICE: return "통신 서비스 없음";
            case SmsManager.RESULT_ERROR_RADIO_OFF: return "무선통신 꺼짐(비행기모드)";
            case SmsManager.RESULT_ERROR_NULL_PDU: return "메시지 생성 오류";
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE: return "일반 오류(신호/통신사 거부)";
            default: return "오류 코드 " + resultCode;
        }
    }

    @SuppressWarnings("deprecation")
    private SmsManager getSmsManager() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                return getContext().getSystemService(SmsManager.class);
            }
            return SmsManager.getDefault();
        } catch (Exception e) {
            return null;
        }
    }
}
