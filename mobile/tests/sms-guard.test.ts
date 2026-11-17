// @vitest-environment happy-dom
/**
 * #40: the SMS bridge refuses a number that isn't a Korean mobile BEFORE handing
 * it to the native plugin (a landline / two numbers run together used to pass).
 * L7: the TS refusal reads exactly like the native one (SmsPlugin.INVALID_MOBILE_MESSAGE).
 */
import { describe, expect, it, vi } from "vitest";

const nativeSend = vi.hoisted(() => vi.fn(async () => ({ id: "n-1" })));
vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({ send: nativeSend }),
}));

import { INVALID_NUMBER_MESSAGE, INVALID_NUMBER_TEXT, sendSmsTracked } from "../src/native/sms";
import { INVALID_MOBILE_MESSAGE } from "../src/domain/sender";

describe("sendSmsTracked number guard (#40)", () => {
  it("rejects a landline / over-long number without calling the native plugin", async () => {
    await expect(sendSmsTracked("02-123-4567", "x")).rejects.toThrow(INVALID_NUMBER_MESSAGE);
    await expect(sendSmsTracked("0101234567812345678901", "x")).rejects.toThrow(INVALID_NUMBER_MESSAGE);
    expect(nativeSend).not.toHaveBeenCalled();
  });

  it("passes a Korean mobile (hyphenated or +82) through to the native send", async () => {
    await expect(sendSmsTracked("010-1234-5678", "안내")).resolves.toBe("n-1");
    await expect(sendSmsTracked("+82 10-1234-5678", "안내")).resolves.toBe("n-1");
    expect(nativeSend).toHaveBeenCalledTimes(2);
  });
});

describe("invalid-number wording is the native one (L7)", () => {
  it("uses SmsPlugin.java's text (= sender.ts INVALID_MOBILE_MESSAGE), with the format hint", () => {
    // Must stay identical to SmsPlugin.INVALID_MOBILE_MESSAGE (SmsNormalizeNumberTest).
    const NATIVE = "휴대폰 번호 형식이 올바르지 않습니다 (010으로 시작하는 10~11자리)";
    expect(INVALID_NUMBER_MESSAGE).toBe(NATIVE);
    expect(INVALID_NUMBER_MESSAGE).toBe(INVALID_MOBILE_MESSAGE);
    expect(INVALID_NUMBER_TEXT).toBe("휴대폰 번호 형식이 올바르지 않습니다");
    expect(INVALID_NUMBER_MESSAGE.startsWith(INVALID_NUMBER_TEXT)).toBe(true);
  });
});
