package com.poncleexpiry.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** JVM unit tests for PoncleLoginActivity.parseLoginResult (stage-3 review L8). */
public class ParseLoginResultTest {

    @Test
    public void numericResultCodes() {
        assertEquals(1, PoncleLoginActivity.parseLoginResult("{\"result\":1,\"msg\":\"\"}"));
        assertEquals(0, PoncleLoginActivity.parseLoginResult("{\"result\":0,\"msg\":\"아이디 또는 비밀번호\"}"));
        assertEquals(8, PoncleLoginActivity.parseLoginResult("{\"result\":8}"));
    }

    @Test
    public void numericStringResultCodes() {
        assertEquals(8, PoncleLoginActivity.parseLoginResult("{\"result\":\"8\"}"));
        assertEquals(0, PoncleLoginActivity.parseLoginResult("{\"result\":\" 0 \"}"));
    }

    @Test
    public void toleratesBomXssiPrefixAndWrapper() {
        assertEquals(1, PoncleLoginActivity.parseLoginResult("﻿{\"result\":1}"));
        assertEquals(1, PoncleLoginActivity.parseLoginResult(")]}',\n{\"result\":1}"));
        assertEquals(8, PoncleLoginActivity.parseLoginResult("  \n{\"result\":\"8\",\"msg\":\"x\"}\n"));
    }

    @Test
    public void unreadableBodiesReturnMinusOne() {
        assertEquals(-1, PoncleLoginActivity.parseLoginResult(null));
        assertEquals(-1, PoncleLoginActivity.parseLoginResult(""));
        assertEquals(-1, PoncleLoginActivity.parseLoginResult("<html><body>login</body></html>"));
        assertEquals(-1, PoncleLoginActivity.parseLoginResult("}{"));
        assertEquals(-1, PoncleLoginActivity.parseLoginResult("{not json}"));
    }

    @Test
    public void missingNullOrNonNumericResultReturnsMinusOne() {
        assertEquals(-1, PoncleLoginActivity.parseLoginResult("{\"msg\":\"x\"}"));
        assertEquals(-1, PoncleLoginActivity.parseLoginResult("{\"result\":null}"));
        assertEquals(-1, PoncleLoginActivity.parseLoginResult("{\"result\":\"ok\"}"));
    }

    @Test
    public void oversizedBodyIsNotParsed() {
        StringBuilder sb = new StringBuilder("{\"result\":1,\"pad\":\"");
        while (sb.length() < 17 * 1024) sb.append('x');
        sb.append("\"}");
        assertEquals(-1, PoncleLoginActivity.parseLoginResult(sb.toString()));
    }
}
