package com.poncleexpiry.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** JVM unit tests for SmsPlugin.normalizeNumber (stage-3 review L8). */
public class SmsNormalizeNumberTest {

    @Test
    public void domesticMobileFormsNormalizeToDigits() {
        assertEquals("01012345678", SmsPlugin.normalizeNumber("010-1234-5678"));
        assertEquals("01012345678", SmsPlugin.normalizeNumber("01012345678"));
        assertEquals("01012345678", SmsPlugin.normalizeNumber(" 010 1234 5678 "));
        assertEquals("01012345678", SmsPlugin.normalizeNumber("(010)1234.5678"));
        assertEquals("0111234567", SmsPlugin.normalizeNumber("011-123-4567"));
        assertEquals("0191234567", SmsPlugin.normalizeNumber("019-123-4567"));
    }

    @Test
    public void internationalKoreanFormsConvertToDomestic() {
        assertEquals("01012345678", SmsPlugin.normalizeNumber("+82 10-1234-5678"));
        assertEquals("01012345678", SmsPlugin.normalizeNumber("+82 010-1234-5678"));
        assertEquals("01012345678", SmsPlugin.normalizeNumber("+821012345678"));
        assertEquals("01012345678", SmsPlugin.normalizeNumber("821012345678"));
    }

    /** K3 / audit L17-L18: the one shared rule (sender.ts normalizeKrMobile,
     *  poncle-client.ts searchFieldFor): "+82" then "1" -> "01", "+82" then "0"
     *  keeps the 0; '+' followed by anything but 82 is invalid. */
    @Test
    public void sharedRuleWithTheTsNormalizer() {
        assertEquals("01012345678", SmsPlugin.normalizeNumber("+82 010 1234 5678"));
        assertEquals("01012345678", SmsPlugin.normalizeNumber("+82-10-1234-5678"));
        assertEquals("01012345678", SmsPlugin.normalizeNumber("+8201012345678"));
        assertEquals("01012345678", SmsPlugin.normalizeNumber("8201012345678"));
        assertNull(SmsPlugin.normalizeNumber("+01012345678")); // '+' but not 82
        assertNull(SmsPlugin.normalizeNumber("+1 010-1234-5678"));
        assertNull(SmsPlugin.normalizeNumber("+8202-123-4567"));  // +82 landline
    }

    @Test
    public void foreignNumbersAreRejected() {
        assertNull(SmsPlugin.normalizeNumber("+1 202 555 0100"));
        assertNull(SmsPlugin.normalizeNumber("+81 90-1234-5678"));
    }

    @Test
    public void landlinesShortCodesAndNonMobilePrefixesAreRejected() {
        assertNull(SmsPlugin.normalizeNumber("02-123-4567"));
        assertNull(SmsPlugin.normalizeNumber("031-123-4567"));
        assertNull(SmsPlugin.normalizeNumber("1588-1234"));
        assertNull(SmsPlugin.normalizeNumber("015-1234-5678"));
        assertNull(SmsPlugin.normalizeNumber("070-1234-5678"));
    }

    @Test
    public void wrongLengthsAreRejected() {
        assertNull(SmsPlugin.normalizeNumber("010-123-456"));         // too short
        assertNull(SmsPlugin.normalizeNumber("010-1234-56789"));      // 12 digits
        assertNull(SmsPlugin.normalizeNumber("0101234567801012345678")); // two numbers run together (22 digits)
    }

    @Test
    public void emptyAndNullAreRejected() {
        assertNull(SmsPlugin.normalizeNumber(null));
        assertNull(SmsPlugin.normalizeNumber(""));
        assertNull(SmsPlugin.normalizeNumber("   "));
        assertNull(SmsPlugin.normalizeNumber("abc"));
    }

    @Test
    public void invalidNumberMessageMatchesTheTsGuard() {
        // Must stay identical to src/domain/sender.ts INVALID_MOBILE_MESSAGE (L7).
        assertEquals("휴대폰 번호 형식이 올바르지 않습니다 (010으로 시작하는 10~11자리)",
            SmsPlugin.INVALID_MOBILE_MESSAGE);
    }
}
