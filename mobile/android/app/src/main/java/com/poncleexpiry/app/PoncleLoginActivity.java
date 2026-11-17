package com.poncleexpiry.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Toast;

import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts a real Poncle login in a GeckoView (Approach A: reuse a manual login).
 * Android System WebView is rejected by Poncle's reCAPTCHA v3 (procLogin result 8)
 * while Gecko passes. The session runs on the process-wide runtime of
 * {@link GeckoHost}, so the login cookies are shared with the hidden worker page
 * that PonclePlugin uses for authenticated requests; on a verified login they are
 * exported and persisted (CookieStore) before RESULT_OK.
 *
 * The bridge extension's content script (assets/poncle-ext/content.js) does the
 * page work on the login page: it fills the saved id/password sent over the port
 * (never via the URL), reports the typed id/password ONLY on a real login submit,
 * and reports Poncle's procLogin JSON result (1 = ok, 0 = wrong id/pw, 8 =
 * reCAPTCHA/anti-automation rejection) observed by a read-only page hook. Typed
 * credentials are saved only after an authenticated probe confirms the session
 * (audit 1-20), so next time they are auto-filled.
 */
public class PoncleLoginActivity extends Activity {

    /** Outcomes of the authenticated session probe (see {@link #probeSession}). */
    private static final int PROBE_VALID = 0;
    private static final int PROBE_EXPIRED = 1;
    private static final int PROBE_NET_ERROR = 2;

    /** procLogin result codes (Poncle's login page script). */
    private static final int LOGIN_WRONG_CREDS = 0;
    private static final int LOGIN_OK = 1;
    private static final int LOGIN_CAPTCHA_REJECTED = 8;

    /** Largest procLogin response body we bother to parse (it is a tiny JSON). */
    private static final int MAX_RESULT_BODY = 16 * 1024;

    private static final String CAPTCHA_REJECTED_MSG =
        "폰클 보안 확인(reCAPTCHA)에 실패해 로그인이 거절되었습니다. 비밀번호 문제가 아니라 "
            + "폰클 측 보안 확인 문제입니다. 잠시 후 다시 시도하거나 폰클 고객센터에 문의하세요.";

    /** First probe could not reach Poncle (audit L12): never leave the user on
     *  the empty mobile shell — open the login form with this guidance. */
    private static final String NET_ERROR_OPEN_LOGIN_MSG =
        "네트워크 문제로 로그인 상태를 확인하지 못해 로그인 화면을 엽니다. 이미 로그인되어 있다면 "
            + "위의 '로그인 완료'를 눌러 주세요.";

    /** The login page's content process crashed / was killed (audit L38). */
    private static final String SESSION_CRASHED_MSG = "로그인 화면이 비정상 종료되어 다시 엽니다.";
    private static final String SESSION_CRASHED_GIVE_UP_MSG =
        "로그인 화면이 계속 종료됩니다. 앱을 다시 실행한 뒤 시도해 주세요.";
    /** Reopen the crashed login session at most this many times per activity. */
    private static final int MAX_SESSION_REOPENS = 3;

    private static final String LOGIN_STALLED_MSG =
        "로그인 결과를 확인하지 못했습니다. 폰클 안내 메시지가 있었다면 확인하고, 보안 확인(reCAPTCHA) "
            + "문제일 수 있으니 잠시 후 다시 시도해 주세요. 계속되면 폰클 고객센터에 문의하세요.";

    private GeckoHost host;
    private GeckoView geckoView;
    private GeckoSession session;
    private LoginPrompts prompts;
    // Always GeckoHost.BASE (https://m.poncle.co.kr): the login screen does not
    // follow the JS base URL and never loads plain http (audit L36).
    private final String baseUrl = GeckoHost.BASE;
    private boolean sawLogin = false;
    private boolean finished = false;
    // The one-time silent probe for "Gecko already had a valid session and landed
    // on Poncle's main page" (UI thread only).
    private boolean initialProbeDone = false;
    // The in-flight probe is that initial one (UI thread only).
    private boolean probeIsInitial = false;
    // The in-flight probe is the re-check after a late cookie restore (L37): only
    // a VALID answer matters, anything else leaves the screen as it is.
    private boolean probeIsQuiet = false;
    // How many times a crashed/killed login session was reopened (UI thread).
    private int sessionReopens = 0;
    // procLogin answered result=1 during this activity (UI thread only): a probe
    // that races the post-login navigation must not throw the typed creds away.
    private boolean loginAccepted = false;
    // Top-frame URL of the current document (UI thread writes, probe thread reads).
    private volatile String topUrl;
    // A session probe is in flight (UI thread only) — debounces the auto-detect
    // and the manual button so they never race each other into a double finish.
    private boolean verifying = false;
    // A page load / tap arrived while a probe was in flight (UI thread only).
    private boolean recheckAfterProbe = false;
    private boolean recheckManual = false;
    // Off-UI-thread executor for the authenticated probe and the CredStore reads.
    private final ExecutorService probeIo = Executors.newSingleThreadExecutor();
    // The app's own notice (e.g. reCAPTCHA rejection), dismissed in onDestroy.
    private AlertDialog noticeDialog;
    // Credentials typed into the login form, held until login SUCCEEDS (so a
    // wrong-password attempt is never saved), then committed to CredStore.
    // Written on the UI thread (port messages), read on the probe thread -> volatile.
    private volatile String pendingId;
    private volatile String pendingPw;

    // --- Stale-autofill-password guard (session-scoped; not persisted) ---
    // The password value we last autofilled from CredStore (null once autofill is
    // disabled). Used to tell "submitted the autofilled password unchanged" apart
    // from "user typed their own password".
    private volatile String autofillPw;
    // True between a submit of the UNCHANGED autofilled password and Poncle's
    // procLogin answer. Only result 0 (wrong id/pw) counts against autofill; a
    // reCAPTCHA rejection (8), a token/captcha expiry or a page reload does not.
    private volatile boolean awaitingAutofillResult = false;
    // Once true, autofill stops filling the password field (id is still fine).
    private boolean autofillPwDisabled = false;
    // Ensures the "stored password may be wrong" notice is shown only once.
    private boolean warnedStalePw = false;

    /** Port to this session's content script (top frame, Poncle pages only). */
    private final PortChannel page = new PortChannel(new PortChannel.Listener() {
        @Override
        public void onMessage(JSONObject msg) {
            onPageMessage(msg);
        }
    });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        Button done = new Button(this);
        done.setText("로그인 완료 (자동 감지 안 될 때)");
        done.setAllCaps(false);
        done.setBackgroundColor(Color.parseColor("#2563EB"));
        done.setTextColor(Color.WHITE);
        // Even the manual fallback verifies the session first, so a tap before the
        // login actually went through can't report success (audit 1-20).
        done.setOnClickListener(v -> verifyThenFinish(true));
        root.addView(done, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        geckoView = new GeckoView(this);
        root.addView(geckoView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        setContentView(root);

        prompts = new LoginPrompts(this,
            () -> !finished && !isFinishing() && !isDestroyed() && PoncleHosts.isPoncleHost(topUrl));

        host = GeckoHost.get(this);
        // A saved session restored only AFTER this screen started (slow first
        // start: the restore give-up timer fired first) -> probe again (L37).
        host.setLateRestoreListener(this::reprobeAfterLateRestore);
        // Wait until the persisted session was restored into Gecko, so an
        // already-valid login is recognised instead of showing the login form.
        host.whenReady(this::startSession);
    }

    /** UI thread: the saved session arrived late. If no login happened here in
     *  the meantime, re-probe quietly and close when the restored session is
     *  valid; otherwise (the user is logging in) leave everything alone. */
    private void reprobeAfterLateRestore() {
        if (finished || isFinishing() || isDestroyed() || loginAccepted) return;
        verifyThenFinish(false, false, true);
    }

    /** UI thread, once GeckoHost is ready. */
    private void startSession() {
        if (finished || isFinishing() || isDestroyed() || session != null) return;
        GeckoRuntime runtime = host.runtime();
        if (runtime == null) {
            toast("로그인 화면을 준비하지 못했습니다. 앱을 다시 실행해 주세요.", Toast.LENGTH_LONG);
            setResult(Activity.RESULT_CANCELED);
            finish();
            return;
        }
        GeckoSession s = new GeckoSession();
        s.setNavigationDelegate(navigation);
        s.setProgressDelegate(progress);
        s.setPromptDelegate(prompts);
        s.setContentDelegate(content);
        WebExtension ext = host.extension();
        if (ext != null) s.getWebExtensionController().setMessageDelegate(ext, page.messageDelegate, "browser");
        s.open(runtime);
        geckoView.setSession(s);
        session = s;
        s.loadUri(baseUrl + PoncleFetch.LIST_OPEN_REFERER);
    }

    private final GeckoSession.NavigationDelegate navigation = new GeckoSession.NavigationDelegate() {
        @Override
        public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession s, LoadRequest request) {
            // Pin the top frame to Poncle (onLoadRequest is top-level only; the
            // reCAPTCHA / analytics SUBFRAMES go through onSubframeLoadRequest and
            // stay allowed). A top-level navigation anywhere else is refused, so no
            // other site ever receives the autofilled password. A Poncle link that
            // wants a new window opens here instead.
            // https only (L36): the page holds the autofilled password.
            if (!PoncleHosts.isPoncleHttpsUrl(request.uri)) return GeckoResult.fromValue(AllowOrDeny.DENY);
            if (request.target == TARGET_WINDOW_NEW) {
                s.loadUri(request.uri);
                return GeckoResult.fromValue(AllowOrDeny.DENY);
            }
            return GeckoResult.fromValue(AllowOrDeny.ALLOW);
        }

        @Override
        public GeckoResult<GeckoSession> onNewSession(GeckoSession s, String uri) {
            return null; // no popups
        }

        @Override
        public void onLocationChange(GeckoSession s, String url,
                                     List<GeckoSession.PermissionDelegate.ContentPermission> perms,
                                     Boolean hasUserGesture) {
            topUrl = url;
        }
    };

    /** The login page's content process crashed or was killed (L38): without
     *  this the screen stays a frozen white page. */
    private final GeckoSession.ContentDelegate content = new GeckoSession.ContentDelegate() {
        @Override
        public void onCrash(GeckoSession s) {
            reopenAfterCrash(s);
        }

        @Override
        public void onKill(GeckoSession s) {
            reopenAfterCrash(s);
        }
    };

    /** UI thread: drop the dead session and open a fresh one on the login flow
     *  (the cookies live in the runtime, so a valid session is still found). */
    private void reopenAfterCrash(GeckoSession dead) {
        if (dead != session || finished || isFinishing() || isDestroyed()) return;
        page.reset(); // fails a probe waiting on the dead page (it falls back to the worker)
        try { geckoView.releaseSession(); } catch (Exception ignored) { }
        try { dead.close(); } catch (Exception ignored) { }
        session = null;
        if (prompts != null) prompts.dismissAll();
        awaitingAutofillResult = false;
        topUrl = null;
        if (sessionReopens >= MAX_SESSION_REOPENS) {
            toast(SESSION_CRASHED_GIVE_UP_MSG, Toast.LENGTH_LONG);
            setResult(Activity.RESULT_CANCELED);
            finished = true;
            finish();
            return;
        }
        sessionReopens++;
        toast(SESSION_CRASHED_MSG, Toast.LENGTH_SHORT);
        // Start over like a fresh screen: a silent probe on the restored session,
        // the login form if it is not valid.
        sawLogin = false;
        initialProbeDone = false;
        startSession();
    }

    private final GeckoSession.ProgressDelegate progress = new GeckoSession.ProgressDelegate() {
        @Override
        public void onPageStart(GeckoSession s, String url) {
            topUrl = url;
            // A new top-level navigation ends the old document (and any login XHR
            // in it): its submit can no longer be judged, so never count it.
            awaitingAutofillResult = false;
        }

        @Override
        public void onPageStop(GeckoSession s, boolean success) {
            maybeAutoComplete(topUrl);
        }
    };

    /** Messages from this session's content script (UI thread). The port belongs
     *  to this session's top-level Poncle document only. */
    private void onPageMessage(JSONObject msg) {
        if (finished || isFinishing() || isDestroyed()) return;
        String kind = msg.optString("kind", "");
        boolean onLogin = PoncleHosts.isLoginUrl(topUrl);
        switch (kind) {
            case "hello":
                if (onLogin && PoncleHosts.isLoginPath(msg.optString("path", ""))) armLoginPage();
                break;
            case "capture":
                if (onLogin) onCapture(msg.optString("uid", ""), msg.optString("pw", ""));
                break;
            case "procLogin":
                if (onLogin) onProcLoginResult(resultCode(msg.opt("result")));
                break;
            case "loginStalled":
                // Password cleared after a submit, no procLogin answer observed.
                // Says nothing about the password: the autofill guard and the
                // pending creds stay as they are (a verified session decides).
                if (onLogin) showNotice("로그인 확인 필요", LOGIN_STALLED_MSG);
                break;
            default:
                break; // unknown: ignore
        }
    }

    /**
     * On Poncle's login page: read the saved id/password (off the UI thread), then
     * have the content script fill them and arm the submit capture + procLogin
     * observer. The user still solves reCAPTCHA and taps 로그인 (never auto-submit,
     * never touch the captcha). Values travel over the extension port only.
     */
    private void armLoginPage() {
        sawLogin = true;
        final boolean pwDisabled = autofillPwDisabled;
        try {
            probeIo.execute(() -> {
                String id = "";
                String pw = null;
                try {
                    id = CredStore.getId(this);
                    // Once a stored password has been observed to fail once, stop
                    // auto-filling it (the id is still harmless to fill) so we don't
                    // keep re-submitting a stale password and risk an account lock.
                    if (!pwDisabled) pw = CredStore.getPw(this);
                } catch (Exception e) {
                    // autofill is best-effort; still arm the capture hooks
                }
                final String fid = id == null ? "" : id;
                final String fpw = pw;
                runOnUiThread(() -> sendLoginArm(fid, fpw));
            });
        } catch (Exception e) {
            // executor already shut down (activity going away)
        }
    }

    private void sendLoginArm(String id, String pw) {
        if (finished || isDestroyed()) return;
        String fillPw = autofillPwDisabled ? null : pw;
        try {
            JSONObject m = new JSONObject();
            m.put("cmd", "login");
            if (!id.isEmpty()) m.put("uid", id);
            if (fillPw != null && !fillPw.isEmpty()) m.put("pw", fillPw);
            // Track what we filled into the password field so a capture can tell
            // "submitted our autofill unchanged" from "user typed their own".
            autofillPw = fillPw != null && !fillPw.isEmpty() ? fillPw : null;
            page.post(m);
        } catch (Exception ignored) {
            // best-effort
        }
    }

    /** The content script saw a real login submit with these values. */
    private void onCapture(String id, String pw) {
        if (pw == null || pw.isEmpty()) return;
        pendingId = id == null ? "" : id;
        pendingPw = pw;
        // If the submitted password is exactly what we autofilled (user didn't
        // retype anything), arm the failure check for Poncle's procLogin answer.
        // If the user changed it, this is a fresh manual attempt and must not
        // count against the autofill guard.
        awaitingAutofillResult = autofillPw != null && autofillPw.equals(pw);
    }

    /**
     * Auto-detect a successful login so the user doesn't have to tap 로그인 완료:
     * once we've been on the /member/login page and then land back on a non-login
     * Poncle page, VERIFY the session with a real authenticated probe before
     * closing ("has a cookie" alone is always true — SCALE is a 2-year cookie —
     * audit 1-20). The manual button stays as a fallback and verifies the same way.
     *
     * If the session opens straight onto a non-login Poncle page (a restored
     * session), there is no login to wait for: probe ONCE silently and close when
     * the session is valid. If it is not, Poncle's mobile shell does not redirect
     * by itself, so open the login page for the user.
     */
    private void maybeAutoComplete(String url) {
        if (finished || url == null || !url.startsWith("http")) return;
        if (PoncleHosts.isLoginUrl(url)) {
            sawLogin = true; // on the login page; wait for the user to log in
            return;
        }
        if (!PoncleHosts.isPoncleHost(url)) return;
        if (!sawLogin) {
            if (initialProbeDone) return;
            initialProbeDone = true;
            verifyThenFinish(false, true);
            return;
        }
        verifyThenFinish(false);
    }

    /**
     * Probe the session on a background thread and finish only when it is really
     * authenticated. Saved credentials are committed ONLY on a verified session.
     * Auto path: an unverified page change is ignored (the user is still on the
     * flow). Manual path: tell the user why nothing happened; on a network error
     * the user's explicit tap still closes (the app's own probe then reports the
     * network state), but unverified credentials are never saved.
     */
    private void verifyThenFinish(boolean manual) {
        verifyThenFinish(manual, false, false);
    }

    private void verifyThenFinish(boolean manual, boolean initial) {
        verifyThenFinish(manual, initial, false);
    }

    private void verifyThenFinish(boolean manual, boolean initial, boolean quiet) {
        if (finished) return;
        if (verifying) {
            // Another page finished (or the button was tapped) mid-probe: the
            // in-flight probe may predate the session, so re-probe once it ends.
            recheckAfterProbe = true;
            recheckManual |= manual;
            return;
        }
        verifying = true;
        probeIsInitial = initial;
        probeIsQuiet = quiet;
        recheckAfterProbe = false;
        recheckManual = false;
        if (manual) toast("로그인 상태를 확인하는 중입니다…", Toast.LENGTH_SHORT);
        try {
            probeIo.execute(() -> {
                final int outcome = probeSession();
                if (outcome == PROBE_VALID) {
                    // A late cookie restore must not overwrite this session (L37).
                    host.noteFreshLogin();
                    // Persist the verified session BEFORE reporting success, so it
                    // survives the app process dying right after the login.
                    host.persistCookies(true);
                    // Save the typed credentials HERE, off the UI thread (L39):
                    // the CredStore compare + encrypted write can take a while.
                    // Not on the late-restore re-check: the RESTORED session is
                    // valid, which says nothing about what was typed meanwhile.
                    if (!quiet) commitPendingCreds();
                }
                runOnUiThread(() -> onProbeResult(outcome, manual));
            });
        } catch (Exception e) {
            // executor already shut down (activity going away)
            verifying = false;
        }
    }

    private void onProbeResult(int outcome, boolean manual) {
        verifying = false;
        final boolean initial = probeIsInitial;
        final boolean quiet = probeIsQuiet;
        probeIsInitial = false;
        probeIsQuiet = false;
        if (finished || isFinishing() || isDestroyed()) return;
        if (outcome == PROBE_VALID) {
            finished = true; // credentials were already committed on probeIo
            finishOk();
            return;
        }
        if (recheckAfterProbe) {
            boolean nextManual = manual || recheckManual;
            recheckAfterProbe = false;
            recheckManual = false;
            verifyThenFinish(nextManual);
            return;
        }
        // Re-check after a late restore (L37): the restored session was not
        // valid (or unknown) — the screen stays exactly as the user has it.
        if (quiet && !manual) return;
        if (outcome == PROBE_EXPIRED) {
            // Not logged in: whatever was captured belongs to a failed attempt —
            // unless procLogin just said OK and this probe raced the post-login
            // navigation (that navigation re-verifies; commit still needs VALID).
            if (!loginAccepted) discardPendingCreds();
            if (manual) {
                toast("아직 로그인되지 않았습니다. 아이디·비밀번호를 입력하고 로그인한 뒤 다시 눌러 주세요.",
                    Toast.LENGTH_LONG);
                // Tapped on Poncle's empty shell: there is no form to fill there (L12).
                openLoginForm();
            } else if (!sawLogin) {
                // Opened on Poncle's shell with an expired session: it shows an
                // empty page instead of redirecting, so bring up the login form.
                openLoginForm();
            }
            return;
        }
        // PROBE_NET_ERROR: can't tell. Never save unverified credentials.
        if (!manual && !sawLogin) {
            // First probe failed on the network (L12): the shell would just stay
            // empty, so open the login form and say why.
            toast(NET_ERROR_OPEN_LOGIN_MSG, Toast.LENGTH_LONG);
            openLoginForm();
            return;
        }
        if (initial && !manual) return; // already on the login form: the user just sees it
        if (manual) {
            finished = true;
            discardPendingCreds();
            toast("네트워크 오류로 로그인 상태를 확인하지 못했습니다. 연결 후 다시 확인해 주세요.",
                Toast.LENGTH_LONG);
            finishOk();
        } else {
            toast("네트워크 오류로 로그인 확인이 지연되고 있습니다. 잠시 후 위의 '로그인 완료'를 눌러 주세요.",
                Toast.LENGTH_LONG);
        }
    }

    /** Load Poncle's login page unless it is already showing (UI thread). */
    private void openLoginForm() {
        if (session == null || finished || PoncleHosts.isLoginUrl(topUrl)) return;
        session.loadUri(baseUrl + "/member/login");
    }

    /**
     * One authenticated listOpen probe (same request as PonclePlugin.check), run
     * by fetch() inside THIS session's Poncle page. If this page has no port (not
     * a Poncle page yet) or it goes away mid-request (the post-login navigation),
     * the same probe runs in GeckoHost's worker page, which shares the cookies.
     * Runs on probeIo — never the UI thread.
     */
    private int probeSession() {
        PoncleFetch.Fetch f = null;
        if (page.isConnected()) {
            try {
                JSONObject cmd = new JSONObject();
                cmd.put("cmd", "fetch");
                cmd.put("path", PoncleFetch.pathWithQuery(PoncleFetch.LIST_OPEN, PoncleFetch.probeParams()));
                cmd.put("referer", PoncleFetch.LIST_OPEN_REFERER);
                f = PoncleFetch.fromReply(page.request(cmd, GeckoHost.FETCH_TIMEOUT_MS));
            } catch (Exception e) {
                f = null; // no answer from this page: ask the worker instead
            }
        }
        if (f == null) {
            try {
                f = host.fetchJson(PoncleFetch.LIST_OPEN, PoncleFetch.probeParams(), PoncleFetch.LIST_OPEN_REFERER);
            } catch (Exception e) {
                return PROBE_NET_ERROR; // no response at all (timeout / offline)
            }
        }
        if (f.data != null) return PROBE_VALID;
        return f.isTransientFailure() ? PROBE_NET_ERROR : PROBE_EXPIRED;
    }

    private void discardPendingCreds() {
        pendingId = null;
        pendingPw = null;
    }

    private void toast(String msg, int length) {
        // Application context: the toast must survive this activity finishing.
        runOnUiThread(() -> Toast.makeText(getApplicationContext(), msg, length).show());
    }

    /**
     * Poncle rejected the UNCHANGED autofilled password with procLogin result 0
     * (wrong id/pw). Stop auto-filling the password for the rest of this login
     * (so a stale stored password isn't re-submitted into an account lock) and
     * show a one-time notice. Never called for credentials the user typed, nor
     * for a reCAPTCHA rejection or a reload of the login page.
     */
    private void onAutofillPasswordRejected() {
        if (autofillPwDisabled) return;
        autofillPwDisabled = true;
        autofillPw = null;
        if (!warnedStalePw) {
            warnedStalePw = true;
            Toast.makeText(this,
                "저장된 비밀번호가 맞지 않을 수 있습니다. 직접 입력하거나 설정에서 자격증명을 갱신하세요.",
                Toast.LENGTH_LONG).show();
        }
    }

    /**
     * Poncle's procLogin answer (UI thread). 1 = accepted -> verify the session
     * now (pending creds are committed only on a verified session). 0 = wrong
     * id/pw -> the stale-autofill guard. 8 = reCAPTCHA/anti-automation rejection
     * -> explain it in an app dialog; it says nothing about the password, so it
     * never counts against autofill.
     */
    private void onProcLoginResult(int code) {
        if (finished || isFinishing() || isDestroyed()) return;
        // Unreadable body (-1): we learned nothing about the attempt. Leave the
        // pending creds and the autofill guard alone so the normal verified-finish
        // path decides (a successful login with an odd body must still be saved).
        if (code < 0) return;
        final boolean autofillSubmitted = awaitingAutofillResult;
        awaitingAutofillResult = false;
        if (code == LOGIN_OK) {
            loginAccepted = true;
            // From here on a late cookie restore must not import the older saved
            // session over this login (L37).
            if (host != null) host.noteFreshLogin();
            verifyThenFinish(false);
            return;
        }
        // Poncle explicitly answered "not OK" (0, 8 or another non-1 code): a
        // failed attempt, so never save what was typed.
        discardPendingCreds();
        if (code == LOGIN_CAPTCHA_REJECTED) {
            showNotice("폰클 보안 확인 실패", CAPTCHA_REJECTED_MSG);
        } else if (code == LOGIN_WRONG_CREDS && autofillSubmitted) {
            onAutofillPasswordRejected();
        }
    }

    /** One app-styled notice dialog (same look as the page alert dialogs). */
    private void showNotice(String title, String message) {
        if (finished || isFinishing() || isDestroyed()) return;
        if (noticeDialog != null && noticeDialog.isShowing()) return; // no stacking on retries
        try {
            AlertDialog dialog = new AlertDialog.Builder(this, R.style.PoncleDialog)
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton("확인", null)
                .setOnDismissListener(d -> { if (noticeDialog == d) noticeDialog = null; })
                .create();
            noticeDialog = dialog;
            dialog.show();
        } catch (Exception e) {
            noticeDialog = null;
            toast(message, Toast.LENGTH_LONG); // window going away: still tell the user
        }
    }

    /** procLogin {@code result} as reported by the page observer -> code, or -1.
     *  Accepts an integral number or a numeric string (Poncle sends either). */
    static int resultCode(Object r) {
        if (r == null || r == JSONObject.NULL) return -1;
        if (r instanceof Number) {
            double d = ((Number) r).doubleValue();
            if (Double.isNaN(d) || d != Math.rint(d) || Math.abs(d) > Integer.MAX_VALUE) return -1;
            return (int) d;
        }
        if (r instanceof String) {
            try {
                return Integer.parseInt(((String) r).trim());
            } catch (NumberFormatException e) {
                return -1;
            }
        }
        return -1;
    }

    /** Parse Poncle's procLogin JSON body -> result code, or -1 if unreadable.
     *  `result` may arrive as a number or a numeric string. Tolerates a UTF-8
     *  BOM, an XSSI prefix or a thin wrapper around the object (the JSON object
     *  is taken from the first '{' to the last '}'). Never logged. Mirrors the
     *  page observer in content.js. */
    static int parseLoginResult(String body) {
        if (body == null || body.length() > MAX_RESULT_BODY) return -1;
        int start = body.indexOf('{');
        int end = body.lastIndexOf('}');
        if (start < 0 || end <= start) return -1;
        try {
            return resultCode(new JSONObject(body.substring(start, end + 1)).opt("result"));
        } catch (Exception e) {
            return -1;
        }
    }

    /** True when the stored credentials already equal what would be saved. */
    private boolean sameAsStored(String id, String pw) {
        try {
            String sid = CredStore.getId(this);
            String spw = CredStore.getPw(this);
            return pw.equals(spw) && id.equals(sid == null ? "" : sid);
        } catch (Exception e) {
            return false; // unreadable store: saving again is the safe choice
        }
    }

    /** Save the id/password typed during THIS (successful) login so it can be
     *  auto-filled next time. No-op if nothing was captured (e.g. autofill only).
     *  Runs on probeIo right after a VALID probe — never the UI thread (L39). */
    private void commitPendingCreds() {
        if (pendingPw == null || pendingPw.isEmpty()) return;
        final String id = pendingId == null ? "" : pendingId;
        final String pw = pendingPw;
        pendingId = null;
        pendingPw = null;
        // Autofilled values submitted unchanged are already stored: don't rewrite
        // the store and re-toast on every login.
        if (sameAsStored(id, pw)) return;
        try {
            CredStore.save(this, id, pw);
            toast("로그인 정보를 저장했습니다 (설정에서 지울 수 있어요)", Toast.LENGTH_SHORT);
        } catch (Exception e) {
            // best-effort; don't block login on a storage failure
        }
    }

    private void finishOk() {
        setResult(Activity.RESULT_OK);
        finish();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // configChanges keeps this activity (typed id/password, solved reCAPTCHA,
        // the autofill guard) across rotation / dark mode; tell Gecko about it.
        GeckoRuntime rt = host == null ? null : host.runtime();
        if (rt != null) rt.configurationChanged(newConfig);
    }

    @Override
    public void onBackPressed() {
        // Back = cancel the login.
        setResult(Activity.RESULT_CANCELED);
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (host != null) host.setLateRestoreListener(null);
        // Dismissing answers a still-open alert/confirm (see LoginPrompts).
        if (prompts != null) prompts.dismissAll();
        if (noticeDialog != null) {
            try { noticeDialog.dismiss(); } catch (Exception ignored) { }
            noticeDialog = null;
        }
        probeIo.shutdownNow();
        page.reset();
        if (geckoView != null) {
            try { geckoView.releaseSession(); } catch (Exception ignored) { }
        }
        if (session != null) {
            try { session.close(); } catch (Exception ignored) { }
            session = null;
        }
        super.onDestroy();
    }
}
