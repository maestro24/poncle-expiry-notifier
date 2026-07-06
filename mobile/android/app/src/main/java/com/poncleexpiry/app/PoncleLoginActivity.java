package com.poncleexpiry.app;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * Hosts a real Poncle login in a WebView (Approach A: reuse a manual login). The
 * employee logs in normally (reCAPTCHA solved by the real page), the resulting
 * session cookies land in the app's CookieManager, and PonclePlugin reuses them
 * for native authenticated requests. If the user typed their id/password (rather
 * than using autofill), we capture them on submit and save them ONLY after the
 * login succeeds, so next time they are auto-filled.
 */
public class PoncleLoginActivity extends Activity {

    public static final String EXTRA_BASE_URL = "base_url";

    private WebView webView;
    private String baseUrl;
    private boolean sawLogin = false;
    private boolean finished = false;
    // Credentials typed into the login form, held until login SUCCEEDS (so a
    // wrong-password attempt is never saved), then committed to CredStore.
    private String pendingId;
    private String pendingPw;

    // --- Stale-autofill-password guard (session-scoped; not persisted) ---
    // The password value we last autofilled from CredStore (null once the user
    // edits the field or autofill is disabled). Used to tell "submitted the
    // autofilled password unchanged" apart from "user typed their own password".
    private String autofillPw;
    // True once we've reached the login page while an autofilled password was
    // submitted on the previous load without succeeding (i.e. still on /member/login).
    private boolean awaitingAutofillResult = false;
    // Count of submits of the (unchanged) autofilled password that did not lead
    // away from the login page.
    private int autofillFailCount = 0;
    // Once true, tryAutofill stops filling the password field (id is still fine).
    private boolean autofillPwDisabled = false;
    // Ensures the "stored password may be wrong" notice is shown only once.
    private boolean warnedStalePw = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        baseUrl = getIntent().getStringExtra(EXTRA_BASE_URL);
        if (baseUrl == null || baseUrl.isEmpty()) {
            baseUrl = "https://m.poncle.co.kr";
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        Button done = new Button(this);
        done.setText("로그인 완료 (자동 감지 안 될 때)");
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

        webView.addJavascriptInterface(new CredBridge(), "AndroidCreds");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Pin the top frame to Poncle. reCAPTCHA/analytics load as SUBFRAMES
                // (isForMainFrame() == false) and are allowed; a top-frame navigation
                // to any non-Poncle origin is blocked, so no other site ever receives
                // the autofilled password or can drive the AndroidCreds bridge.
                if (request.isForMainFrame() && !isPoncleHost(request.getUrl())) {
                    return true; // cancel
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                checkAutofillSubmitResult(url);
                tryAutofill(url);
                injectCaptureHook(url);
                maybeAutoComplete(url);
            }
        });

        webView.loadUrl(baseUrl + "/open/mobile");
    }

    /** True if the URL's host is poncle.co.kr or a subdomain of it. */
    private boolean isPoncleHost(Uri uri) {
        String host = uri == null ? null : uri.getHost();
        return host != null && (host.equals("poncle.co.kr") || host.endsWith(".poncle.co.kr"));
    }

    private boolean isPoncleHost(String url) {
        try { return isPoncleHost(Uri.parse(url)); } catch (Exception e) { return false; }
    }

    /** True only for the real Poncle login page (host-checked, path /member/login). */
    private boolean isLoginUrl(String url) {
        try {
            Uri u = Uri.parse(url);
            String path = u.getPath();
            return isPoncleHost(u) && path != null && path.contains("/member/login");
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Auto-detect a successful login so the user doesn't have to tap 로그인 완료:
     * once we've been on the /member/login page and then land back on a non-login
     * Poncle page with session cookies, capture and close. The manual button stays
     * as a fallback for any flow this heuristic misses.
     */
    private void maybeAutoComplete(String url) {
        if (finished || url == null || !url.startsWith("http")) return;
        if (isLoginUrl(url)) {
            sawLogin = true; // on the login page; wait for the user to log in
            return;
        }
        if (!sawLogin) return;              // only after a real login attempt
        if (!isPoncleHost(url)) return;     // stay within Poncle (ignore captcha frames)
        String cookie = CookieManager.getInstance().getCookie(baseUrl);
        if (cookie != null && !cookie.trim().isEmpty()) {
            finished = true;
            commitPendingCreds();
            finishOk();
        }
    }

    /**
     * Called on every page load, BEFORE tryAutofill/maybeAutoComplete run for
     * this load. If the previous load had submitted the autofilled password
     * unchanged (see CredBridge.capture) and we're back on the login page
     * (i.e. login did not succeed), count it as a failed autofill attempt. On
     * the first such failure, stop auto-filling the password from now on and
     * show a one-time Korean notice. This never fires for credentials the user
     * typed themselves, and never touches maybeAutoComplete/cookie logic.
     */
    private void checkAutofillSubmitResult(String url) {
        if (!awaitingAutofillResult) return;
        awaitingAutofillResult = false;
        if (!isLoginUrl(url)) return; // navigated away -> login likely succeeded
        autofillFailCount++;
        if (autofillFailCount >= 1 && !autofillPwDisabled) {
            autofillPwDisabled = true;
            autofillPw = null;
            if (!warnedStalePw) {
                warnedStalePw = true;
                runOnUiThread(() -> Toast.makeText(this,
                    "저장된 비밀번호가 맞지 않을 수 있습니다. 직접 입력하거나 설정에서 자격증명을 갱신하세요.",
                    Toast.LENGTH_LONG).show());
            }
        }
    }

    /** Save the id/password typed during THIS (successful) login so it can be
     *  auto-filled next time. No-op if nothing was captured (e.g. autofill only). */
    private void commitPendingCreds() {
        if (pendingPw == null || pendingPw.isEmpty()) return;
        final String id = pendingId == null ? "" : pendingId;
        final String pw = pendingPw;
        pendingId = null;
        pendingPw = null;
        try {
            CredStore.save(this, id, pw);
            runOnUiThread(() -> Toast.makeText(
                this, "로그인 정보를 저장했습니다 (설정에서 지울 수 있어요)", Toast.LENGTH_SHORT).show());
        } catch (Exception e) {
            // best-effort; don't block login on a storage failure
        }
    }

    /** Inject a hook on the login page that reports the typed id/password to the
     *  native side when the form is submitted. Values are only committed later,
     *  after login succeeds (see commitPendingCreds). */
    private void injectCaptureHook(String url) {
        if (webView == null || !isLoginUrl(url)) return;
        String js =
            "(function(){if(window.__credHook)return;window.__credHook=1;"
            + "function g(){"
            + "var u=document.querySelector('input[name=\"userid\"]');"
            + "var p=document.querySelector('input[name=\"userpw\"]');"
            + "if(p&&p.value){try{AndroidCreds.capture(u?u.value:'',p.value);}catch(e){}}}"
            + "document.addEventListener('submit',g,true);"
            + "document.addEventListener('click',function(){g();},true);"
            + "var pw=document.querySelector('input[name=\"userpw\"]');"
            + "if(pw){pw.addEventListener('keydown',function(e){if(e.key==='Enter')g();});}"
            + "})();";
        webView.evaluateJavascript(js, null);
    }

    /** Bridge exposed to the login page's JS to report typed credentials. */
    private final class CredBridge {
        @JavascriptInterface
        public void capture(String id, String pw) {
            if (pw != null && !pw.isEmpty()) {
                pendingId = id == null ? "" : id;
                pendingPw = pw;
                // If the submitted password is exactly what we autofilled (user
                // didn't retype anything), arm the failure check for the next
                // page load. If the user changed it, this is a fresh manual
                // attempt and must not count against the autofill guard.
                awaitingAutofillResult = autofillPw != null && autofillPw.equals(pw);
            }
        }
    }

    /**
     * On Poncle's login page, fill the id/password fields from the encrypted
     * store. The user still solves reCAPTCHA and taps 로그인 (we never auto-submit,
     * and never touch the captcha). Values are escaped via JSONObject.quote so
     * arbitrary passwords can't break out of the injected JS string.
     */
    private void tryAutofill(String url) {
        if (!isLoginUrl(url)) return;
        try {
            String id = CredStore.getId(this);
            // Once a stored password has been observed to fail once, stop
            // auto-filling it (the id is still harmless to fill) so we don't
            // keep re-submitting a stale password and risk an account lock.
            String pw = autofillPwDisabled ? null : CredStore.getPw(this);
            if ((id == null || id.isEmpty()) && (pw == null || pw.isEmpty())) return;
            String js =
                "(function(){"
                + "var u=document.querySelector('input[name=\"userid\"]');"
                + "var p=document.querySelector('input[name=\"userpw\"]');"
                + "if(u){u.value=" + JSONObject.quote(id == null ? "" : id)
                + ";u.dispatchEvent(new Event('input',{bubbles:true}));}"
                + (pw != null
                    ? "if(p){p.value=" + JSONObject.quote(pw)
                        + ";p.dispatchEvent(new Event('input',{bubbles:true}));}"
                    : "")
                + "})();";
            // Track what we (may have) filled into the password field so the
            // capture bridge can tell "submitted our autofill unchanged" apart
            // from "user typed their own password".
            autofillPw = pw != null && !pw.isEmpty() ? pw : null;
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
