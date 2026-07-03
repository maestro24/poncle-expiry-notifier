/**
 * DOM-free HTML entity decoder. Poncle returns agency names HTML-escaped
 * (e.g. "PS&amp;M"), and this code runs both in the WebView and in Node (tests),
 * so we cannot rely on a textarea/DOMParser. Covers the common named entities
 * plus decimal (&#123;) and hex (&#x1F;) numeric references, which is what
 * Poncle emits. Mirrors the subset of Python's html.unescape that we need.
 */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function htmlUnescape(input: string): string {
  const s = String(input ?? "");
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}
