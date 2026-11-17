/**
 * 고객 조회 cut-off notice (3-12, L19). Only Poncle's first page is fetched, so the
 * screen says when there are more matches. The client's `total` is clamped to at
 * least the rows returned, which can't tell "the server said exactly 100" from
 * "the server sent no total" — so the unclamped server total (`serverTotal`, 0 when
 * missing/unparseable) decides when the domain provides it.
 */
export interface LookupTrunc {
  shown: number;
  /** The server's match count, or null when unknown (a full page came back). */
  total: number | null;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function lookupTruncation(shown: number, total: unknown, pageSize: number, serverTotal?: unknown): LookupTrunc | null {
  const fullPage = shown >= pageSize;
  if (serverTotal !== undefined) {
    const st = finite(serverTotal) ?? 0;
    if (st > shown) return { shown, total: st };
    if (st > 0 && st === shown) return null; // the server says this is everything
    return fullPage ? { shown, total: null } : null; // no usable total: a full page may have more
  }
  // Older domain without the unclamped total: the clamped one.
  const t = finite(total) ?? 0;
  if (t > shown) return { shown, total: t };
  return fullPage ? { shown, total: null } : null;
}
