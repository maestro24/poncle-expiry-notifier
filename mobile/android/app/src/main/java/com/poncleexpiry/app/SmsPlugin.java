package com.poncleexpiry.app;

import android.Manifest;
import android.os.Build;
import android.telephony.SmsManager;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Native SMS sending. The whole point of the Android app: the employee's phone
 * IS the sending device, so one tap sends the customer message directly with no
 * PC bridge and no messaging-app round trip.
 *
 * SEND_SMS is a "dangerous" permission and Play Store restricts it, so this app
 * is distributed as a sideloaded APK (internal store tool), not via Play.
 */
@CapacitorPlugin(
    name = "Sms",
    permissions = {
        @Permission(strings = { Manifest.permission.SEND_SMS }, alias = "sms")
    }
)
public class SmsPlugin extends Plugin {

    @PluginMethod
    public void send(PluginCall call) {
        String phone = call.getString("phone");
        String text = call.getString("text");
        if (phone == null || text == null || phone.isEmpty()) {
            call.reject("phone and text are required");
            return;
        }
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            // Capacitor persists the call so we can resume after the prompt.
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
            call.reject("SMS permission denied");
        }
    }

    private void doSend(PluginCall call, String phone, String text) {
        String digits = phone == null ? "" : phone.replaceAll("[^0-9+]", "");
        if (digits.isEmpty()) {
            call.reject("invalid phone number");
            return;
        }
        try {
            SmsManager sms = getSmsManager();
            ArrayList<String> parts = sms.divideMessage(text);
            if (parts.size() > 1) {
                sms.sendMultipartTextMessage(digits, null, parts, null, null);
            } else {
                sms.sendTextMessage(digits, null, text, null, null);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("SMS send failed: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private SmsManager getSmsManager() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return getContext().getSystemService(SmsManager.class);
        }
        return SmsManager.getDefault();
    }
}
