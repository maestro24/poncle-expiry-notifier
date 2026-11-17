package com.poncleexpiry.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStoreException;
import java.time.Instant;

import javax.crypto.AEADBadTagException;
import javax.crypto.BadPaddingException;

import org.junit.Test;

/** JVM unit tests for the pure native helpers added in stage 4a (#58, #62). */
public class NativeHelpersTest {

    // -- PonclePlugin.toIsoUtc (server Date -> ISO, improvement 3-16) ---------

    @Test
    public void toIsoUtcFormatsEpochMillisInUtc() {
        long ms = Instant.parse("2026-11-16T03:00:00Z").toEpochMilli();
        assertEquals("2026-11-16T03:00:00Z", PonclePlugin.toIsoUtc(ms));
        assertEquals("2026-11-16T03:00:00Z", PonclePlugin.toIsoUtc(ms + 999)); // header has 1s resolution
    }

    @Test
    public void toIsoUtcIsNullWhenTheHeaderWasAbsent() {
        assertNull(PonclePlugin.toIsoUtc(0L));   // HttpURLConnection.getDate(): 0 = no header
        assertNull(PonclePlugin.toIsoUtc(-1L));
    }

    @Test
    public void transientStatusesAreRetryable() {
        assertTrue(PonclePlugin.isTransientStatus(500));
        assertTrue(PonclePlugin.isTransientStatus(503));
        assertTrue(PonclePlugin.isTransientStatus(408));
        assertTrue(PonclePlugin.isTransientStatus(429));
        assertFalse(PonclePlugin.isTransientStatus(200));
        assertFalse(PonclePlugin.isTransientStatus(401));
        assertFalse(PonclePlugin.isTransientStatus(403));
    }

    // -- CredStore.isDefinitiveDecryptFailure (improvement 3-17) -------------

    /** Stand-in for Tink's shaded protobuf parse error (matched by simple name). */
    static final class InvalidProtocolBufferException extends IOException {
        InvalidProtocolBufferException() { super("Protocol message contained an invalid tag (zero)."); }
    }

    @Test
    public void tagAndPaddingMismatchesAreDefinitive() {
        assertTrue(CredStore.isDefinitiveDecryptFailure(new AEADBadTagException()));
        assertTrue(CredStore.isDefinitiveDecryptFailure(new BadPaddingException()));
    }

    @Test
    public void definitiveCausesAreFoundThroughWrappers() {
        Throwable wrapped = new SecurityException("Could not decrypt value",
            new GeneralSecurityException(new AEADBadTagException("Signature/MAC verification failed")));
        assertTrue(CredStore.isDefinitiveDecryptFailure(wrapped));
        assertTrue(CredStore.isDefinitiveDecryptFailure(
            new GeneralSecurityException(new InvalidProtocolBufferException())));
    }

    @Test
    public void transientErrorsDoNotWipeTheStore() {
        assertFalse(CredStore.isDefinitiveDecryptFailure(null));
        assertFalse(CredStore.isDefinitiveDecryptFailure(new IOException("disk busy")));
        assertFalse(CredStore.isDefinitiveDecryptFailure(new KeyStoreException("keystore busy")));
        assertFalse(CredStore.isDefinitiveDecryptFailure(
            new GeneralSecurityException("transient", new IOException("io"))));
        assertFalse(CredStore.isDefinitiveDecryptFailure(new RuntimeException("x")));
    }

    // -- CredStore.isDefinitiveReadFailure (value read path) ------------------

    @Test
    public void tinkCauselessDecryptionFailedIsDefinitiveOnRead() {
        // What EncryptedSharedPreferences really throws: Tink's AEAD wrapper swallows the
        // per-key AEADBadTagException and throws a cause-less "decryption failed".
        Throwable real = new SecurityException("Could not decrypt value. decryption failed",
            new GeneralSecurityException("decryption failed"));
        assertTrue(CredStore.isDefinitiveReadFailure(real));
        assertTrue(CredStore.isDefinitiveReadFailure(new GeneralSecurityException("decryption failed")));
        // Everything isDefinitiveDecryptFailure accepts still counts.
        assertTrue(CredStore.isDefinitiveReadFailure(new AEADBadTagException()));
    }

    @Test
    public void transientReadErrorsAreNotDefinitive() {
        assertFalse(CredStore.isDefinitiveReadFailure(null));
        assertFalse(CredStore.isDefinitiveReadFailure(new IOException("could not decrypt: disk busy")));
        assertFalse(CredStore.isDefinitiveReadFailure(new KeyStoreException("keystore busy")));
        assertFalse(CredStore.isDefinitiveReadFailure(
            new SecurityException("Could not encrypt key. keystore busy", new KeyStoreException("busy"))));
        assertFalse(CredStore.isDefinitiveReadFailure(new RuntimeException("decrypt")));
    }
}
