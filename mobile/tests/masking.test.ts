import { describe, expect, it } from "vitest";
import { maskName, maskPhone } from "../src/domain/masking";
import { htmlUnescape } from "../src/domain/html-entities";
import { renderMessage } from "../src/domain/notifier";

describe("maskName", () => {
  it("empty -> dash", () => expect(maskName("")).toBe("-"));
  it("single char kept", () => expect(maskName("김")).toBe("김"));
  it("two chars: keep first, star rest", () => expect(maskName("이수")).toBe("이*"));
  it("korean: first & last kept, middle starred", () => {
    expect(maskName("김수현")).toBe("김*현");
    expect(maskName("배옥자")).toBe("배*자");
  });
  it("roman two tokens: initials", () => {
    expect(maskName("LI CHANGJI")).toBe("L* C*");
  });
});

describe("maskPhone", () => {
  it("11-digit -> 010-34**-**80", () => {
    expect(maskPhone("010-3479-7780")).toBe("010-34**-**80");
  });
  it("normalizes non-digits before masking", () => {
    expect(maskPhone("01031236986")).toBe("010-31**-**86");
  });
  it("too short returns original", () => {
    expect(maskPhone("12345")).toBe("12345");
  });
  it("empty -> dash", () => expect(maskPhone("")).toBe("-"));
});

describe("htmlUnescape", () => {
  it("named entity &amp;", () => expect(htmlUnescape("PS&amp;M")).toBe("PS&M"));
  it("multiple named entities", () => {
    expect(htmlUnescape("a &lt;b&gt; &quot;c&quot;")).toBe('a <b> "c"');
  });
  it("decimal numeric &#39;", () => expect(htmlUnescape("it&#39;s")).toBe("it's"));
  it("hex numeric", () => expect(htmlUnescape("&#x41;&#x42;")).toBe("AB"));
  it("no entities returns input unchanged", () => expect(htmlUnescape("plain")).toBe("plain"));
});

describe("renderMessage", () => {
  it("fills known placeholders, missing -> empty", () => {
    const out = renderMessage("{customer}/{telecom}/{model}/{expiry}/{when}", {
      customer: "홍길동",
      telecom: "SK텔레콤",
      model: "Galaxy",
      expiry_date: "2026-07-03",
    }, "오늘 2026-07-03");
    expect(out).toBe("홍길동/SK텔레콤/Galaxy/2026-07-03/오늘 2026-07-03");
  });
  it("unknown placeholder degrades to empty", () => {
    expect(renderMessage("hi {nope}!", {}, "")).toBe("hi !");
  });
});
