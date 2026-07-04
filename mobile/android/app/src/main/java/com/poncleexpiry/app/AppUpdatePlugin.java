package com.poncleexpiry.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * App self-update helpers for the sideloaded (non-Play) build. getVersion lets
 * JS compare the installed versionName against the latest GitHub release; openUrl
 * hands a URL to the system browser / download manager so the user can fetch and
 * install the new APK (an in-place update works because every release we ship is
 * signed with the same key).
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    @PluginMethod
    public void getVersion(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageInfo info = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            r.put("version", info.versionName == null ? "" : info.versionName);
        } catch (Exception e) {
            r.put("version", "");
        }
        call.resolve(r);
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("failed to open url: " + e.getMessage());
        }
    }
}
