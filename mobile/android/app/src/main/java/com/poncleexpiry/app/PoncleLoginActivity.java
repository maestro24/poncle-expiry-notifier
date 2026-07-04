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

import org.json.JSONObject;

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
                tryAutofill(url);
            }
        });

        webView.loadUrl(baseUrl + "/open/mobile");
    }

    /**
     * On Poncle's login page, fill the id/password fields from the encrypted
     * store. The user still solves reCAPTCHA and taps 로그인 (we never auto-submit,
     * and never touch the captcha). Values are escaped via JSONObject.quote so
     * arbitrary passwords can't break out of the injected JS string.
     */
    private void tryAutofill(String url) {
        if (url == null || !url.contains("/member/login")) return;
        try {
            String id = CredStore.getId(this);
            String pw = CredStore.getPw(this);
            if ((id == null || id.isEmpty()) && (pw == null || pw.isEmpty())) return;
            String js =
                "(function(){"
                + "var u=document.querySelector('input[name=\"userid\"]');"
                + "var p=document.querySelector('input[name=\"userpw\"]');"
                + "if(u){u.value=" + JSONObject.quote(id == null ? "" : id)
                + ";u.dispatchEvent(new Event('input',{bubbles:true}));}"
                + "if(p){p.value=" + JSONObject.quote(pw == null ? "" : pw)
                + ";p.dispatchEvent(new Event('input',{bubbles:true}));}"
                + "})();";
            if (webView != null) webView.evaluateJavascript(js, null);
        } catch (Exception e) {
            // autofill is best-effort; ignore failures
        }
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
