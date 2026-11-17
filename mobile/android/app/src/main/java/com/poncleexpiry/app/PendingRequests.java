package com.poncleexpiry.app;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Request/reply matching for a message port (see {@link PortChannel}): every
 * request gets a fresh numeric id, the reply carrying the same id completes it,
 * and a reply with an unknown / already-settled id is ignored. Requests can be
 * tagged with the port they were posted to, so a port that closes fails exactly
 * its own outstanding requests (a newer port's requests are untouched).
 *
 * Pure Java (no Android / GeckoView types) so it is JVM unit-testable. Thread-safe.
 */
final class PendingRequests<T> {

    /** One-shot result holder a waiting (non-UI) thread blocks on. */
    static final class Reply<T> {
        private final CountDownLatch done = new CountDownLatch(1);
        private volatile T value;
        private volatile Exception error;

        boolean isDone() {
            return done.getCount() == 0;
        }

        private synchronized boolean settle(T v, Exception e) {
            if (isDone()) return false;
            value = v;
            error = e;
            done.countDown();
            return true;
        }

        /** Block up to {@code timeoutMs}; returns the value, rethrows the failure,
         *  or throws {@link TimeoutException} when nothing arrived in time. */
        T await(long timeoutMs) throws Exception {
            if (!done.await(Math.max(0L, timeoutMs), TimeUnit.MILLISECONDS)) {
                throw new TimeoutException("no reply");
            }
            if (error != null) throw error;
            return value;
        }
    }

    private static final class Entry<T> {
        final Reply<T> reply = new Reply<>();
        Object tag;
    }

    private final AtomicLong ids = new AtomicLong(0);
    private final Map<Long, Entry<T>> pending = new HashMap<>();

    /** A new, never-reused request id (positive). */
    long nextId() {
        return ids.incrementAndGet();
    }

    synchronized Reply<T> register(long id) {
        Entry<T> e = new Entry<>();
        pending.put(id, e);
        return e.reply;
    }

    /** Record which port the request was actually posted to. False when the
     *  request is no longer pending (already settled / removed). */
    synchronized boolean tag(long id, Object tag) {
        Entry<T> e = pending.get(id);
        if (e == null) return false;
        e.tag = tag;
        return true;
    }

    /** Settle the request with this id. False for an unknown or settled id. */
    boolean complete(long id, T value) {
        Entry<T> e;
        synchronized (this) {
            e = pending.remove(id);
        }
        return e != null && e.reply.settle(value, null);
    }

    boolean fail(long id, Exception error) {
        Entry<T> e;
        synchronized (this) {
            e = pending.remove(id);
        }
        return e != null && e.reply.settle(null, error);
    }

    /** Fail every pending request posted to {@code tag} (its port closed). */
    int failTagged(Object tag, Exception error) {
        List<Entry<T>> hit = new ArrayList<>();
        synchronized (this) {
            java.util.Iterator<Map.Entry<Long, Entry<T>>> it = pending.entrySet().iterator();
            while (it.hasNext()) {
                Entry<T> e = it.next().getValue();
                if (e.tag != null && e.tag == tag) {
                    hit.add(e);
                    it.remove();
                }
            }
        }
        for (Entry<T> e : hit) e.reply.settle(null, error);
        return hit.size();
    }

    /** Forget a request (the waiter gave up). */
    synchronized void remove(long id) {
        pending.remove(id);
    }

    synchronized int size() {
        return pending.size();
    }

    /** The request id carried by a reply ({@code msg.id}): a positive integral
     *  number, or null when absent / not a request id. Strings are NOT accepted,
     *  so page-controlled text can never be mistaken for a reply. */
    static Long idOf(Object raw) {
        if (!(raw instanceof Number)) return null;
        Number n = (Number) raw;
        double d = n.doubleValue();
        if (Double.isNaN(d) || d <= 0 || d != Math.rint(d) || d > 9.007199254740991E15) return null;
        return n.longValue();
    }

    /** Failure used when a port closes or is missing: a transient network error. */
    static IOException portClosed() {
        return new IOException("port closed");
    }
}
