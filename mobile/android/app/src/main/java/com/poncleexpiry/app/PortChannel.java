package com.poncleexpiry.app;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;
import org.mozilla.geckoview.WebExtension;

import java.io.IOException;

/**
 * One named native-messaging channel to the bridge extension (a content port of
 * one GeckoSession, or the runtime-wide background port). Holds the CURRENT port
 * (a page load replaces it), matches replies to requests by id
 * ({@link PendingRequests}) and hands every other message to a {@link Listener}.
 *
 * Threading: GeckoView calls the delegates and requires postMessage on the UI
 * thread; {@link #request} blocks the calling BACKGROUND thread (never the UI
 * thread) until the matching reply, the port closing, or the timeout.
 */
final class PortChannel {

    /** Unsolicited messages / lifecycle, always on the UI thread. */
    interface Listener {
        default void onConnected() {}
        default void onMessage(JSONObject msg) {}
        default void onDisconnected() {}
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final PendingRequests<JSONObject> pending = new PendingRequests<>();
    private final Object connLock = new Object();
    private final Listener listener;
    private volatile WebExtension.Port port;

    PortChannel(Listener listener) {
        this.listener = listener == null ? new Listener() {} : listener;
    }

    private final WebExtension.PortDelegate portDelegate = new WebExtension.PortDelegate() {
        @Override
        public void onPortMessage(Object message, WebExtension.Port from) {
            if (from != port || !(message instanceof JSONObject)) return; // stale port / junk
            JSONObject msg = (JSONObject) message;
            Long id = PendingRequests.idOf(msg.opt("id"));
            if (id != null && pending.complete(id, msg)) return;
            if (id != null) return; // late reply to a request that already gave up
            listener.onMessage(msg);
        }

        @Override
        public void onDisconnect(WebExtension.Port from) {
            pending.failTagged(from, PendingRequests.portClosed());
            if (from != port) return;
            synchronized (connLock) {
                port = null;
            }
            listener.onDisconnected();
        }
    };

    /** Register with setMessageDelegate(..., nativeApp). */
    final WebExtension.MessageDelegate messageDelegate = new WebExtension.MessageDelegate() {
        @Override
        public void onConnect(WebExtension.Port p) {
            WebExtension.Port old = port;
            synchronized (connLock) {
                port = p;
                connLock.notifyAll();
            }
            p.setDelegate(portDelegate);
            if (old != null && old != p) pending.failTagged(old, PendingRequests.portClosed());
            listener.onConnected();
        }
    };

    boolean isConnected() {
        return port != null;
    }

    /** Wait (background thread) until a port is connected. */
    boolean awaitConnected(long timeoutMs) throws InterruptedException {
        long end = System.currentTimeMillis() + Math.max(0L, timeoutMs);
        synchronized (connLock) {
            while (port == null) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) return false;
                connLock.wait(left);
            }
            return true;
        }
    }

    /** Fire-and-forget message to the current port (any thread). */
    void post(JSONObject msg) {
        ui.post(() -> {
            WebExtension.Port p = port;
            if (p == null) return;
            try {
                p.postMessage(msg);
            } catch (Exception ignored) {
                // port went away between the check and the post
            }
        });
    }

    /** Send {@code cmd} with a fresh id and wait for the reply carrying that id.
     *  Throws IOException when there is no port / it closes, TimeoutException
     *  when nothing arrives in time. MUST NOT run on the UI thread. */
    JSONObject request(JSONObject cmd, long timeoutMs) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new IllegalStateException("PortChannel.request on the UI thread");
        }
        final long id = pending.nextId();
        cmd.put("id", id);
        PendingRequests.Reply<JSONObject> reply = pending.register(id);
        ui.post(() -> {
            WebExtension.Port p = port;
            if (p == null || !pending.tag(id, p)) {
                pending.fail(id, new IOException("no port"));
                return;
            }
            try {
                p.postMessage(cmd);
            } catch (Exception e) {
                pending.fail(id, new IOException("post failed"));
            }
        });
        try {
            return reply.await(timeoutMs);
        } finally {
            pending.remove(id);
        }
    }

    /** Forget the port (its session is being closed); pending requests fail. */
    void reset() {
        WebExtension.Port p;
        synchronized (connLock) {
            p = port;
            port = null;
        }
        if (p != null) pending.failTagged(p, PendingRequests.portClosed());
    }
}
