package com.poncleexpiry.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.StorageController;
import org.mozilla.geckoview.WebExtension;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Process-wide GeckoView host for everything Poncle (Android System WebView fails
 * Poncle's reCAPTCHA v3; an embedded Gecko passes, see the 2026-11 spike).
 *
 *  - ONE GeckoRuntime per process (GeckoRuntime.create exactly once). The login
 *    screen (PoncleLoginActivity) opens its session on the same runtime, so the
 *    login cookies are shared with the worker below.
 *  - The built-in bridge extension (assets/poncle-ext) — background script for
 *    cookie export / import / clear (port "bg"), content script for same-origin
 *    authenticated GETs and the login-page hooks (port "browser").
 *  - A hidden WORKER GeckoSession (no GeckoView attached, explicitly setActive)
 *    parked on {@link #WORKER_URL}; {@link #fetchJson} runs listOpen / listPending
 *    inside that real Poncle page with the page's own session. Its top-level
 *    navigation is pinned to {@link PoncleHosts#isWorkerUrl} (never
 *    /member/logout). Headless operation is NOT yet verified on a device (the
 *    spike used an attached view): smoke-test §10 "헤드리스 워커" checks it, and
 *    RELEASING.md "Headless worker" describes the 1x1 GeckoView fallback.
 *  - Session persistence: on start the encrypted cookie copy (CookieStore) is
 *    imported BEFORE the worker page loads; after successful authenticated
 *    responses / a login it is re-exported and persisted (throttled).
 *
 * Threading: all GeckoView calls happen on the UI thread; {@link #fetchJson} and
 * the cookie operations block a BACKGROUND thread and must never run on the UI
 * thread. No cookies, ids, passwords or response bodies are ever logged.
 */
public final class GeckoHost {

    static final String BASE = "https://" + GeckoCookies.HOST;
    static final String WORKER_URL = BASE + PoncleFetch.LIST_OPEN_REFERER;
    private static final String EXT_ID = "poncle-bridge@poncleexpiry";
    private static final String EXT_URI = "resource://android/assets/poncle-ext/";

    static final long FETCH_TIMEOUT_MS = 25_000;
    private static final long READY_TIMEOUT_MS = 20_000;
    private static final long WORKER_PORT_TIMEOUT_MS = 20_000;
    private static final long COOKIE_TIMEOUT_MS = 8_000;
    private static final long RESTORE_GIVE_UP_MS = 10_000;
    private static final long PERSIST_INTERVAL_MS = 30_000;
    private static final long RELOAD_MIN_GAP_MS = 3_000;
    /** Consecutive fetch timeouts on a CONNECTED worker port after which the
     *  worker session is closed and reopened (audit L13): a hung content
     *  process keeps its port "connected" but never answers, so every request
     *  would wait the full FETCH_TIMEOUT_MS and fail. */
    static final int WORKER_TIMEOUT_RECYCLE_AFTER = 2;

    private static volatile GeckoHost instance;

    private final Context app;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService storeIo = Executors.newSingleThreadExecutor();
    private final CountDownLatch ready = new CountDownLatch(1);
    private final Object persistLock = new Object();

    // UI-thread state
    private GeckoRuntime runtime;
    private WebExtension extension;
    private GeckoSession worker;
    private boolean workerLoading = false;
    private long lastWorkerLoadMs = 0L;
    /** Startup ordering (restore once, ready once, give-up rules): StartupGate. */
    private final StartupGate gate = new StartupGate();
    private final List<Runnable> whenReady = new ArrayList<>();
    /** Called (UI thread) when a restore that finished AFTER ready imported the
     *  saved session, so an open login screen re-probes (audit L37). */
    private Runnable lateRestoreListener;

    /** Consecutive fetchJson timeouts (no reply on a connected port). */
    private final AtomicInteger fetchTimeoutStreak = new AtomicInteger(0);
    /** A login was accepted / verified in this process. A restore that only
     *  starts or finishes later must NOT import the older saved cookies over
     *  the fresh login session (audit L37). */
    private volatile boolean freshLogin = false;

    // persist throttle (persistLock)
    private long lastPersistMs = 0L;
    private String lastPersisted = null;
    /** Bumped at the start AND end of every logout: a persist whose export began
     *  before / during the clear must not write the old cookies back. */
    private long clearGeneration = 0L;

    private final PortChannel bg = new PortChannel(new PortChannel.Listener() {
        @Override
        public void onConnected() {
            startRestore();
        }
    });

    private final PortChannel content = new PortChannel(null);

    private GeckoHost(Context ctx) {
        this.app = ctx.getApplicationContext();
    }

    /** The process singleton; starts the runtime on first use (any thread). */
    public static GeckoHost get(Context ctx) {
        GeckoHost h = instance;
        if (h == null) {
            synchronized (GeckoHost.class) {
                h = instance;
                if (h == null) {
                    h = new GeckoHost(ctx);
                    instance = h;
                    final GeckoHost started = h;
                    started.onUi(started::start);
                }
            }
        }
        return h;
    }

    private void onUi(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else ui.post(r);
    }

    // -- startup (UI thread) -----------------------------------------------
    private void start() {
        GeckoRuntimeSettings settings = new GeckoRuntimeSettings.Builder()
            .consoleOutput(false)        // page console must not reach logcat
            .debugLogging(false)
            .remoteDebuggingEnabled(false)
            .aboutConfigEnabled(false)
            .loginAutofillEnabled(false) // the app's own CredStore handles autofill
            .javaScriptEnabled(true)
            .build();
        runtime = GeckoRuntime.create(app, settings);
        // Gecko starts extension background scripts only once a session exists, so
        // the "bg" port (cookie restore) never connects while we wait for it with no
        // session open. Open the worker now on about:blank — NO Poncle page yet: a
        // Poncle load before the restore would be redirected to /member/login, which
        // issues a fresh anonymous session cookie over the one being restored.
        openWorker(false);
        runtime.getWebExtensionController()
            .ensureBuiltIn(EXT_URI, EXT_ID)
            .accept(ext -> {
                extension = ext;
                if (ext == null) return;
                ext.setMessageDelegate(bg.messageDelegate, "bg");
                if (worker != null) {
                    // Attach the content bridge to the already-open worker. Never
                    // load Poncle from here: the "bg" restore (which starts once the
                    // background connects) reloads the worker AFTER the import.
                    worker.getWebExtensionController().setMessageDelegate(ext, content.messageDelegate, "browser");
                }
            }, err -> {
                // Without the bridge nothing authenticated works; still let the
                // login screen open (it reports a network error on verify).
                fireReady();
            });
        // If the background port never shows up, don't block forever: continue
        // without a restored session (the user can log in again).
        // A restore already in progress is bounded by COOKIE_TIMEOUT_MS and fires
        // ready itself — the timer must not open Poncle mid-import.
        ui.postDelayed(() -> {
            if (gate.giveUpFiresReady()) fireReady();
        }, RESTORE_GIVE_UP_MS);
    }

    /** Background port connected: import the persisted cookies, THEN open the worker. */
    private void startRestore() {
        if (!gate.beginRestore()) return;
        storeIo.execute(() -> {
            boolean imported = false;
            try {
                JSONArray saved = CookieStore.getCookies(app);
                // A login already happened (the give-up timer let the login
                // screen run first): the live cookies are newer than the saved
                // copy, so never import over them.
                if (StartupGate.shouldImport(saved.length(), freshLogin)) {
                    JSONObject cmd = new JSONObject();
                    cmd.put("cmd", "import");
                    cmd.put("cookies", saved);
                    bg.request(cmd, COOKIE_TIMEOUT_MS);
                    imported = true;
                    synchronized (persistLock) {
                        lastPersisted = saved.toString();
                    }
                }
            } catch (Exception ignored) {
                // best-effort: a failed restore just means logging in again
            } finally {
                final boolean didImport = imported;
                ui.post(() -> afterRestore(didImport));
            }
        });
    }

    /** The restore finished (or failed). If the give-up timer already declared
     *  ready (slow first install), the worker may sit on Poncle's login page with
     *  an anonymous cookie — reload it now that the session cookies are in, and
     *  tell an open login screen to probe again: its first probe ran with the
     *  anonymous cookie and may have shown the login form for nothing (L37). */
    private void afterRestore(boolean imported) {
        StartupGate.AfterRestore next = gate.afterRestore(imported);
        if (next == StartupGate.AfterRestore.FIRE_READY) {
            fireReady();
            return;
        }
        loadWorker();
        if (next == StartupGate.AfterRestore.RELOAD_WORKER_AND_REPROBE && lateRestoreListener != null) {
            try {
                lateRestoreListener.run();
            } catch (Exception ignored) {
                // the login screen is going away
            }
        }
    }

    /** UI thread: the open login screen's re-probe hook (null to clear). */
    void setLateRestoreListener(Runnable r) {
        lateRestoreListener = r;
    }

    /** A login was accepted (procLogin result 1) or verified: from now on a late
     *  cookie restore must not overwrite the live session (audit L37). Any thread. */
    void noteFreshLogin() {
        freshLogin = true;
    }

    private void fireReady() {
        if (!gate.markReady()) return;
        if (worker == null) openWorker(true);
        else loadWorker();
        ready.countDown();
        List<Runnable> run = new ArrayList<>(whenReady);
        whenReady.clear();
        for (Runnable r : run) r.run();
    }

    /** Run {@code r} on the UI thread once the runtime is up and the saved session
     *  was restored (or the restore gave up). Used by the login screen. */
    void whenReady(Runnable r) {
        onUi(() -> {
            if (gate.isReady()) r.run();
            else whenReady.add(r);
        });
    }

    /** UI thread, after whenReady. */
    GeckoRuntime runtime() {
        return runtime;
    }

    /** UI thread, after whenReady; null when the bridge failed to install. */
    WebExtension extension() {
        return extension;
    }

    // -- worker session (UI thread) ------------------------------------------
    private void openWorker(boolean load) {
        if (worker != null || runtime == null) return;
        GeckoSession s = new GeckoSession();
        s.setNavigationDelegate(new GeckoSession.NavigationDelegate() {
            @Override
            public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession session, LoadRequest request) {
                // The worker only ever shows its own page (or the login redirect /
                // site root); any other top-level load — another site, another
                // Poncle page, above all /member/logout fired by a page timer —
                // is refused and the current document stays.
                boolean ok = request.target != TARGET_WINDOW_NEW && PoncleHosts.isWorkerUrl(request.uri);
                return GeckoResult.fromValue(ok ? AllowOrDeny.ALLOW : AllowOrDeny.DENY);
            }

            @Override
            public GeckoResult<GeckoSession> onNewSession(GeckoSession session, String uri) {
                return null; // no popups
            }
        });
        s.setProgressDelegate(new GeckoSession.ProgressDelegate() {
            @Override
            public void onPageStart(GeckoSession session, String url) {
                workerLoading = true;
            }

            @Override
            public void onPageStop(GeckoSession session, boolean success) {
                workerLoading = false;
            }
        });
        s.setContentDelegate(new GeckoSession.ContentDelegate() {
            @Override
            public void onCrash(GeckoSession session) {
                recycleWorker(session);
            }

            @Override
            public void onKill(GeckoSession session) {
                recycleWorker(session);
            }
        });
        if (extension != null) {
            s.getWebExtensionController().setMessageDelegate(extension, content.messageDelegate, "browser");
        }
        s.open(runtime);
        // No GeckoView is ever attached to the worker, and GeckoView marks a
        // session active only when a visible view shows it. An inactive session is
        // a background tab to Gecko (throttled timers / idle callbacks, so the
        // content script (document_end since bridge 1.0.4) may be deferred and the
        // content port never connect). Mark it active explicitly; it has no surface, so nothing is
        // painted. See RELEASING.md "Headless worker" for the on-device check and
        // the fallback (an off-screen 1x1 GeckoView owned by MainActivity).
        s.setActive(true);
        worker = s;
        if (load) loadWorker();
    }

    private void loadWorker() {
        if (worker == null) return;
        workerLoading = true;
        lastWorkerLoadMs = System.currentTimeMillis();
        worker.loadUri(WORKER_URL);
    }

    /** The content process died: drop the session; the next fetch reopens it. */
    private void recycleWorker(GeckoSession dead) {
        if (dead != worker) return;
        content.reset();
        try {
            dead.close();
        } catch (Exception ignored) {
            // already gone
        }
        worker = null;
        workerLoading = false;
    }

    /** Timeout streak after one fetch: +1 on a timeout, 0 on any answer. */
    static int nextTimeoutStreak(int streak, boolean timedOut) {
        return timedOut ? streak + 1 : 0;
    }

    /** True once the worker should be recycled although its port looks connected. */
    static boolean shouldRecycleWorker(int streak) {
        return streak >= WORKER_TIMEOUT_RECYCLE_AFTER;
    }

    /** The worker port is connected but stopped answering (L13): close the
     *  session and open a fresh one (the cookies live in the runtime, not the
     *  session, so the login survives). Rate-limited like a reload. */
    private void forceRecycleWorker() {
        if (!gate.isReady()) return;
        long now = System.currentTimeMillis();
        if (now - lastWorkerLoadMs < RELOAD_MIN_GAP_MS) return;
        fetchTimeoutStreak.set(0);
        if (worker != null) recycleWorker(worker);
        openWorker(true);
    }

    /** No content port: (re)open / reload the worker unless a load is in flight. */
    private void reviveWorker() {
        if (!gate.isReady() || content.isConnected()) return;
        if (worker == null) {
            openWorker(true);
            return;
        }
        long now = System.currentTimeMillis();
        if (workerLoading && now - lastWorkerLoadMs < FETCH_TIMEOUT_MS) return;
        if (now - lastWorkerLoadMs < RELOAD_MIN_GAP_MS) return;
        loadWorker();
    }

    // -- public API (background threads) ----------------------------------------
    private void awaitReady() throws Exception {
        if (!ready.await(READY_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw new IOException("gecko not ready");
    }

    /**
     * One authenticated same-origin GET of a Poncle list endpoint inside the
     * worker page. Returns the classified response; THROWS (IOException /
     * TimeoutException) when no response was received — a transient network
     * failure, never a session expiry. Background thread only.
     */
    PoncleFetch.Fetch fetchJson(String path, Map<String, String> params, String referer) throws Exception {
        awaitReady();
        if (!content.isConnected()) {
            ui.post(this::reviveWorker);
            if (!content.awaitConnected(WORKER_PORT_TIMEOUT_MS)) throw new IOException("worker page unavailable");
        }
        JSONObject cmd = new JSONObject();
        cmd.put("cmd", "fetch");
        cmd.put("path", PoncleFetch.pathWithQuery(path, params));
        cmd.put("referer", referer);
        try {
            PoncleFetch.Fetch f = PoncleFetch.fromReply(content.request(cmd, FETCH_TIMEOUT_MS));
            fetchTimeoutStreak.set(0);
            return f;
        } catch (Exception e) {
            boolean timedOut = e instanceof TimeoutException;
            int streak = fetchTimeoutStreak.updateAndGet(n -> nextTimeoutStreak(n, timedOut));
            if (timedOut && shouldRecycleWorker(streak)) {
                ui.post(this::forceRecycleWorker); // hung page behind a live port
            } else {
                ui.post(this::reviveWorker); // the page may be gone; have one ready next time
            }
            throw e;
        }
    }

    /** The live Poncle cookie set (sanitized). Background thread only. */
    JSONArray exportCookies() throws Exception {
        awaitReady();
        if (!bg.awaitConnected(COOKIE_TIMEOUT_MS)) throw new IOException("bridge unavailable");
        JSONObject cmd = new JSONObject();
        cmd.put("cmd", "export");
        JSONObject r = bg.request(cmd, COOKIE_TIMEOUT_MS);
        if (!"export".equals(r.optString("kind"))) throw new IOException("export failed");
        return GeckoCookies.sanitize(r.optJSONArray("cookies"));
    }

    /**
     * Export the live cookies and persist them encrypted when they changed.
     * Not forced: at most once per {@link #PERSIST_INTERVAL_MS}. Best-effort, never
     * throws. Background thread only.
     */
    void persistCookies(boolean force) {
        final long gen;
        synchronized (persistLock) {
            if (!GeckoCookies.persistDue(System.currentTimeMillis(), lastPersistMs, PERSIST_INTERVAL_MS, force)) return;
            lastPersistMs = System.currentTimeMillis();
            gen = clearGeneration;
        }
        try {
            JSONArray live = exportCookies();
            if (live.length() == 0) return; // never overwrite a saved session with nothing
            String json = live.toString();
            synchronized (persistLock) {
                // A logout started after this export began: drop the stale copy.
                if (gen != clearGeneration) return;
                if (json.equals(lastPersisted)) return;
                CookieStore.saveCookies(app, live);
                lastPersisted = json;
            }
        } catch (Exception ignored) {
            // best-effort; a storage / bridge failure must never break a scan or login
        }
    }

    /**
     * Logout: remove every Poncle cookie from Gecko and the persisted copy.
     * Background thread only. The persisted copy is ALWAYS cleared; the Gecko
     * side is cleared twice (the bridge's cookies API, whose reply must be
     * {@code kind:"cleared"} with nothing left, and the runtime StorageController
     * for the poncle.co.kr base domain). THROWS when neither Gecko clear is
     * confirmed — the live session may still work, so the UI must not say
     * "로그아웃됨" (and a later scan would re-persist it).
     */
    void clearSession() throws Exception {
        synchronized (persistLock) {
            clearGeneration++;
        }
        boolean bridgeCleared = false;
        try {
            awaitReady();
            if (bg.awaitConnected(COOKIE_TIMEOUT_MS)) {
                JSONObject cmd = new JSONObject();
                cmd.put("cmd", "clear");
                bridgeCleared = GeckoCookies.clearReplyOk(bg.request(cmd, COOKIE_TIMEOUT_MS));
            }
        } catch (Exception ignored) {
            // fall through to the StorageController clear and the stored copy
        }
        boolean storageCleared = clearGeckoCookieStorage();
        synchronized (persistLock) {
            CookieStore.clear(app);
            lastPersisted = null;
            lastPersistMs = 0L;
            clearGeneration++;
        }
        if (!GeckoCookies.logoutConfirmed(bridgeCleared, storageCleared)) {
            throw new IOException("gecko cookies not cleared");
        }
    }

    /** Runtime-level cookie clear for poncle.co.kr (and its subdomains). Blocks
     *  the calling background thread up to {@link #COOKIE_TIMEOUT_MS}; true only
     *  when Gecko confirmed it. */
    private boolean clearGeckoCookieStorage() {
        final CountDownLatch done = new CountDownLatch(1);
        final AtomicBoolean ok = new AtomicBoolean(false);
        onUi(() -> {
            if (runtime == null) {
                done.countDown();
                return;
            }
            try {
                runtime.getStorageController()
                    .clearDataFromBaseDomain(GeckoCookies.PARENT, StorageController.ClearFlags.COOKIES)
                    .accept(v -> {
                        ok.set(true);
                        done.countDown();
                    }, err -> done.countDown());
            } catch (Exception e) {
                done.countDown();
            }
        });
        try {
            if (!done.await(COOKIE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        return ok.get();
    }
}
