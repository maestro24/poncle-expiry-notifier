package com.poncleexpiry.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;

/**
 * Hosts a real Poncle login in a WebView (Approach A: reuse a manual login). The
 * employee logs in normally (reCAPTCHA solved by the real page), the resulting
 * session cookies land in the app's CookieManager, and PonclePlugin later reuses
 * them for native authenticated requests. No password is ever read or stored by
 * us. The user taps "로그인 완료" when done.
 */
public class PoncleLoginActivity extends Activity {

    public static final String EXTRA_BASE_URL = "base_url";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String baseUrl = getIntent().getStringExtra(EXTRA_BASE_URL);
        if (baseUrl == null || baseUrl.isEmpty()) {
            baseUrl = "https://m.poncle.co.kr";
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        Button done = new Button(this);
        done.setText("로그인 완료");
        done.setAllCaps(false);
        done.setBackgroundColor(Color.parseColor("#2563EB"));
        done.setTextColor(Color.WHITE);
        done.setOnClickListener(v -> finishOk());
        root.addView(done, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = new WebView(this);
        LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        root.addView(webView, wlp);
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        setContentView(root);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
            }
        });

        webView.loadUrl(baseUrl + "/open/mobile");
    }

    private void finishOk() {
        CookieManager.getInstance().flush();
        setResult(Activity.RESULT_OK);
        finish();
    }

    @Override
    public void onBackPressed() {
        // Back = cancel the login.
        setResult(Activity.RESULT_CANCELED);
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
