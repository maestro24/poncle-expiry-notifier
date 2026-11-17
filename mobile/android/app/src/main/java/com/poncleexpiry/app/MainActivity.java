package com.poncleexpiry.app;

import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {
    /** Asks the web app to handle back (close its in-app dialog / send sheet, or go
     *  to the parent screen); "true" = handled, anything else = run the default. */
    private static final String BACK_JS =
        "(function(){try{return !!(window.__poncleHandleBack&&window.__poncleHandleBack());}"
            + "catch(e){return false;}})()";

    /** If the page doesn't answer (renderer busy / hung), fall back to the default
     *  back after this long instead of leaving the button dead. */
    private static final long BACK_JS_TIMEOUT_MS = 1500;

    private final Handler main = new Handler(Looper.getMainLooper());

    /** True while one back press is waiting for the web app's answer (UI thread
     *  only). Further presses are ignored until it settles, so a quick double
     *  press can't run two defaults or race two JS answers. */
    private boolean backPending = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the app's native plugins before the bridge initializes.
        registerPlugin(SmsPlugin.class);
        registerPlugin(PonclePlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(DurableKVPlugin.class);
        super.onCreate(savedInstanceState);
        installBackHandler();
        installImeInsets();
    }

    /**
     * #47: keep the WebView above the soft keyboard. targetSdk 35 makes the app
     * edge-to-edge on Android 15+, where adjustResize no longer shrinks the window
     * (and Capacitor's own edge-to-edge margins are off), so the keyboard would
     * cover the bottom of the page — e.g. the send sheet's 보내기/취소 buttons.
     * Shrink the WebView by the IME inset instead (only the IME: system-bar
     * handling is unchanged). Older Android keeps resizing the window itself
     * (windowSoftInputMode=adjustResize), so this is a no-op there.
     */
    private void installImeInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return;
        TypedValue optOut = new TypedValue();
        boolean found = getTheme().resolveAttribute(android.R.attr.windowOptOutEdgeToEdgeEnforcement, optOut, true);
        if (found && optOut.data != 0) return; // not edge-to-edge: the system resizes
        final WebView wv = bridge != null ? bridge.getWebView() : null;
        if (wv == null) return;
        ViewCompat.setOnApplyWindowInsetsListener(wv, (v, insets) -> {
            int ime = insets.isVisible(WindowInsetsCompat.Type.ime())
                ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
            ViewGroup.LayoutParams lp = v.getLayoutParams();
            if (lp instanceof ViewGroup.MarginLayoutParams) {
                ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) lp;
                if (mlp.bottomMargin != ime) {
                    mlp.bottomMargin = ime;
                    v.setLayoutParams(mlp);
                }
            }
            // The WebView itself sees no IME inset any more (already applied above),
            // so it never adjusts for the keyboard a second time.
            WindowInsetsCompat rest = new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
            return ViewCompat.onApplyWindowInsets(v, rest);
        });
        ViewCompat.requestApplyInsets(wv);
    }

    /**
     * Hardware back: give the web app the first chance — it closes an open in-app
     * dialog / the send sheet, or navigates to the parent screen. Only when it has
     * nothing to do (home screen) does the platform default run (background the
     * app). Exactly one outcome per press: the JS answer and the timeout race
     * through a per-press AtomicBoolean, and a press that arrives while one is
     * pending is dropped.
     */
    private void installBackHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (backPending) return; // previous press still being answered
                WebView wv = bridge != null ? bridge.getWebView() : null;
                if (wv == null) {
                    runDefaultBack(this);
                    return;
                }
                final OnBackPressedCallback cb = this;
                final AtomicBoolean settled = new AtomicBoolean(false);
                backPending = true;
                final Runnable timeout = () -> {
                    if (!settled.compareAndSet(false, true)) return;
                    backPending = false;
                    if (!isFinishing() && !isDestroyed()) runDefaultBack(cb);
                };
                main.postDelayed(timeout, BACK_JS_TIMEOUT_MS);
                try {
                    wv.evaluateJavascript(BACK_JS, value -> {
                        if (!settled.compareAndSet(false, true)) return; // timeout already ran
                        main.removeCallbacks(timeout);
                        backPending = false;
                        if ("true".equals(value)) return; // the web app handled it
                        if (!isFinishing() && !isDestroyed()) runDefaultBack(cb);
                    });
                } catch (Exception e) {
                    if (settled.compareAndSet(false, true)) {
                        main.removeCallbacks(timeout);
                        backPending = false;
                        runDefaultBack(cb);
                    }
                }
            }
        });
    }

    private void runDefaultBack(OnBackPressedCallback cb) {
        cb.setEnabled(false);
        try {
            getOnBackPressedDispatcher().onBackPressed();
        } finally {
            cb.setEnabled(true);
        }
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
