package com.poncleexpiry.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Durable key/value store for data that must survive the process dying right
 * after it was written — the send history ("sent_log", audit L43 / contract K1).
 * Capacitor Preferences writes with SharedPreferences.apply() (asynchronous: a
 * kill right after a send's 토스트 can lose the record and the customer gets
 * texted again on the next scan). Here every set() uses commit(), which returns
 * only after the file was written, and resolves {ok:true} only then.
 *
 * Plugin methods run on Capacitor's plugin thread (never the UI thread), so the
 * synchronous commit() does not block the screen. Same file policy as
 * CapacitorStorage.xml: excluded from cloud backup, moved by Android 12+
 * device-to-device transfer (see AndroidManifest.xml), so already-texted
 * customers are not texted again on a new phone. Never logs keys' values.
 *
 * TS side: src/native/adapters.ts durableKV() — migrates an existing
 * Preferences value on first read (read-through, the old copy is kept).
 */
@CapacitorPlugin(name = "DurableKV")
public class DurableKVPlugin extends Plugin {

    static final String PREFS = "poncle_durable_kv";

    /** Serializes writes (commit() itself is thread-safe; this keeps ordering). */
    private static final Object LOCK = new Object();

    private SharedPreferences prefs() {
        return getContext().getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (!validKey(key)) {
            call.reject("key is required");
            return;
        }
        try {
            String value = prefs().getString(key, null);
            JSObject r = new JSObject();
            // JSObject drops a null put; JS reads a missing value as null.
            r.put("value", value == null ? JSObject.NULL : value);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("저장된 이력을 읽지 못했습니다");
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (!validKey(key) || value == null) {
            call.reject("key and value are required");
            return;
        }
        boolean ok;
        try {
            synchronized (LOCK) {
                ok = prefs().edit().putString(key, value).commit();
            }
        } catch (Exception e) {
            ok = false;
        }
        if (!ok) {
            call.reject("이력을 저장하지 못했습니다 (저장 공간을 확인하세요)");
            return;
        }
        JSObject r = new JSObject();
        r.put("ok", true);
        call.resolve(r);
    }

    /** Non-empty key of sane length (the app only uses a few fixed names). */
    static boolean validKey(String key) {
        return key != null && !key.isEmpty() && key.length() <= 128;
    }
}
