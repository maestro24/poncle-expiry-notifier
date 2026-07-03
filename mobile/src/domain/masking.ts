/**
 * Mask customer PII for on-screen display (김*수 / 010-34**-**80). Port of
 * backend/masking.py. Display-only: full values still drive the actual SMS.
 */

export function maskName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "-";
  // Roman names (e.g. "LI CHANGJI"): keep first token initial + last token initial.
  if (/[A-Za-z]/.test(n)) {
    const parts = n.split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0][0]}* ${parts[parts.length - 1][0]}*`.toUpperCase();
    }
    if (n.length <= 2) return n[0] + "*";
    return n[0] + "*".repeat(n.length - 2) + n[n.length - 1];
  }
  // Korean names: keep first & last char, star the middle.
  if (n.length === 1) return n;
  if (n.length === 2) return n[0] + "*";
  return n[0] + "*".repeat(n.length - 2) + n[n.length - 1];
}

/** 010-3479-7780 -> 010-34**-**80 (matches the mock design pattern). */
export function maskPhone(phone: string | null | undefined): string {
  const p = (phone ?? "").trim();
  const digits = p.replace(/\D/g, "");
  if (digits.length < 10) return p || "-";
  if (digits.length === 11) {
    const a = digits.slice(0, 3);
    const b = digits.slice(3, 7);
    const c = digits.slice(7);
    return `${a}-${b.slice(0, 2)}**-**${c.slice(2)}`;
  }
  // 10-digit fallback (010 XXX YYYY)
  const a = digits.slice(0, 3);
  const b = digits.slice(3, 6);
  const c = digits.slice(6);
  return `${a}-${b.slice(0, 1)}**-**${c.slice(2)}`;
}
