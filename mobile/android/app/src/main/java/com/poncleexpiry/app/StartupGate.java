package com.poncleexpiry.app;

/**
 * GeckoHost startup ordering as a pure state machine (audit 2026-11-17 I7), so
 * the ordering rules can be JVM-tested without a GeckoRuntime:
 *
 *  - the saved-cookie restore starts at most once, when the extension's "bg"
 *    port first connects;
 *  - "ready" (the worker may load Poncle, the login screen may open) fires
 *    exactly once: when the restore finishes, or when the bridge failed to
 *    install, or when the give-up timer runs while NO restore has started;
 *  - the give-up timer never declares ready while a restore is in progress
 *    (Poncle would issue an anonymous session cookie over the one being
 *    imported) — that restore is bounded by its own timeout;
 *  - a restore that finishes AFTER ready (slow first start) reloads the worker,
 *    and when it actually imported cookies an open login screen re-probes
 *    (audit L37);
 *  - saved cookies are imported only when there are some and no login happened
 *    in this process (the live session is newer than the saved copy).
 *
 * Not thread-safe: GeckoHost calls it on the UI thread only.
 */
final class StartupGate {

    /** What GeckoHost must do when a restore finishes. */
    enum AfterRestore {
        /** Declare ready now (loads the worker). */
        FIRE_READY,
        /** Ready already fired: reload the worker with the restored cookies. */
        RELOAD_WORKER,
        /** As RELOAD_WORKER, and tell an open login screen to probe again. */
        RELOAD_WORKER_AND_REPROBE,
    }

    private boolean restoreStarted = false;
    private boolean readyFired = false;

    /** The "bg" port connected: true when the restore should start now (first time only). */
    boolean beginRestore() {
        if (restoreStarted) return false;
        restoreStarted = true;
        return true;
    }

    /** The give-up timer ran: true when ready should fire (no restore was ever started). */
    boolean giveUpFiresReady() {
        return !restoreStarted && !readyFired;
    }

    /** Marks ready; true only the first time (the caller then loads the worker
     *  and runs the queued whenReady callbacks). */
    boolean markReady() {
        if (readyFired) return false;
        readyFired = true;
        return true;
    }

    boolean isReady() {
        return readyFired;
    }

    /** The restore finished (or failed); {@code imported} = cookies were imported. */
    AfterRestore afterRestore(boolean imported) {
        if (!readyFired) return AfterRestore.FIRE_READY;
        return imported ? AfterRestore.RELOAD_WORKER_AND_REPROBE : AfterRestore.RELOAD_WORKER;
    }

    /** Import the saved copy only when there is one and no login happened since start. */
    static boolean shouldImport(int savedCount, boolean freshLogin) {
        return savedCount > 0 && !freshLogin;
    }
}
