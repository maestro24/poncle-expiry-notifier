package com.poncleexpiry.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.telephony.SmsManager;

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
 * send() resolves as soon as the telephony framework ACCEPTS the message
 * (SmsManager returned without throwing). It deliberately does NOT wait for the
 * carrier's sent-result broadcast: that wait can take tens of seconds, and if the
 * app is backgrounded or killed meanwhile the message still goes out but the JS
 * side never gets to record it in the send history (customer texted, no record,
 * duplicate risk on the next scan). Resolving at hand-off shrinks that window to
 * milliseconds. Immediate failures (bad number, no SmsManager, SecurityException)
 * still reject with a real reason.
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
            call.reject("전화번호가 올바르지 않습니다");
            return;
        }
        SmsManager sms = getSmsManager();
        if (sms == null) {
            call.reject("문자를 보낼 수 없습니다 (유심/통신 확인)");
            return;
        }

        try {
            ArrayList<String> parts = sms.divideMessage(text);
            if (parts.size() > 1) {
                sms.sendMultipartTextMessage(digits, null, parts, null, null);
            } else {
                sms.sendTextMessage(digits, null, text, null, null);
            }
        } catch (Exception e) {
            call.reject("문자 전송 실패: " + e.getMessage());
            return;
        }
        call.resolve();
    }

    /** digits (keep a single leading +); null if it can't be a dialable number. */
    private String normalizeNumber(String phone) {
        if (phone == null) return null;
        String plus = phone.trim().startsWith("+") ? "+" : "";
        String digits = phone.replaceAll("[^0-9]", "");
        if (digits.length() < 8) return null; // not a plausible MSISDN
        return plus + digits;
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
