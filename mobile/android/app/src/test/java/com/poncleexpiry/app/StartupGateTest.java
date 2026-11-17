package com.poncleexpiry.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** JVM tests for GeckoHost's startup ordering (StartupGate, audit 2026-11-17 I7). */
public class StartupGateTest {

    @Test
    public void normalStartRestoreThenReady() {
        StartupGate g = new StartupGate();
        assertTrue(g.beginRestore());
        assertEquals(StartupGate.AfterRestore.FIRE_READY, g.afterRestore(true));
        assertTrue(g.markReady());
        assertTrue(g.isReady());
    }

    @Test
    public void restoreStartsOnlyOnceAcrossReconnects() {
        StartupGate g = new StartupGate();
        assertTrue(g.beginRestore());
        assertFalse(g.beginRestore());
        assertFalse(g.beginRestore());
    }

    @Test
    public void giveUpTimerFiresReadyWhenNoRestoreStarted() {
        StartupGate g = new StartupGate();
        assertTrue(g.giveUpFiresReady());
        assertTrue(g.markReady());
        // a second timer run (or any later caller) does nothing
        assertFalse(g.giveUpFiresReady());
        assertFalse(g.markReady());
    }

    @Test
    public void giveUpTimerNeverInterruptsARestoreInProgress() {
        StartupGate g = new StartupGate();
        g.beginRestore();
        assertFalse(g.giveUpFiresReady());
        assertFalse(g.isReady());
        // the restore itself fires ready when it finishes
        assertEquals(StartupGate.AfterRestore.FIRE_READY, g.afterRestore(false));
    }

    @Test
    public void lateRestoreAfterGiveUpReloadsAndReprobesOnlyWhenItImported() {
        StartupGate g = new StartupGate();
        assertTrue(g.giveUpFiresReady());
        g.markReady();
        assertTrue(g.beginRestore()); // the bg port showed up after the timer
        assertEquals(StartupGate.AfterRestore.RELOAD_WORKER_AND_REPROBE, g.afterRestore(true));
        assertEquals(StartupGate.AfterRestore.RELOAD_WORKER, g.afterRestore(false));
    }

    @Test
    public void readyFiresExactlyOnceEvenWhenTheBridgeFailsAndTheTimerRuns() {
        StartupGate g = new StartupGate();
        assertTrue(g.markReady()); // ensureBuiltIn failed
        assertFalse(g.giveUpFiresReady());
        assertFalse(g.markReady());
    }

    @Test
    public void importOnlySavedCookiesAndNeverOverAFreshLogin() {
        assertTrue(StartupGate.shouldImport(3, false));
        assertFalse(StartupGate.shouldImport(0, false));
        assertFalse(StartupGate.shouldImport(3, true));
    }
}
