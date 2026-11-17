/**
 * D4: Android 13 (API 33)+ shows its own "복사됨" notice for every clipboard write,
 * so the app's toast would stack a second one. Skip ours there; keep it on older
 * phones. The native SDK level (AppUpdate.getVersion().sdkInt) is authoritative;
 * the WebView user agent is the fallback (it can be version-reduced, so unknown
 * means "show our toast").
 */
const ANDROID_13_SDK = 33;

/** Android major version from a user agent ("Android 13;" -> 13), null if absent. */
export function androidMajorFromUa(ua: string): number | null {
  const m = /Android\s+(\d+)/i.exec(String(ua ?? ""));
  return m ? Number(m[1]) : null;
}

/** True when the OS itself announces a clipboard copy (skip the app toast). */
export function systemShowsCopyToast(sdkInt: number | null | undefined, ua: string): boolean {
  if (typeof sdkInt === "number" && Number.isFinite(sdkInt) && sdkInt > 0) return sdkInt >= ANDROID_13_SDK;
  const major = androidMajorFromUa(ua);
  return major !== null && major >= 13;
}
