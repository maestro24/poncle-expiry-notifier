/**
 * Sideloaded-APK update check. The repo hosts both the PC app (tags `v*`) and
 * this Android app (tags `android-v*`), so we list releases and pick the newest
 * `android-v*` one rather than using /releases/latest. GitHub's API sends
 * permissive CORS headers, so this fetch works from the WebView.
 */
const DEFAULT_REPO = "maestro24/poncle-expiry-notifier";
const TAG_PREFIX = "android-v";

export interface UpdateInfo {
  available: boolean;
  version: string;
  url: string;
  notes: string;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
}
export interface GhRelease {
  tag_name: string;
  name?: string;
  body?: string;
  draft?: boolean;
  assets?: GhAsset[];
}

/** Parse "android-v1.2.3" (or "1.2.3") into [1,2,3]; null if not numeric. */
export function parseVersion(tag: string): number[] | null {
  const s = tag.replace(TAG_PREFIX, "").replace(/^v/, "").trim();
  if (!s) return null;
  const parts = s.split(".").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/** -1 if a<b, 0 if equal, 1 if a>b (component-wise, missing == 0). */
export function cmpVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The APK download must come from GitHub's own release hosts — guards against a
 *  manipulated release JSON pointing the installer at an arbitrary URL. */
export function isTrustedApkUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "github.com" || h === "objects.githubusercontent.com" || h.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

/** Choose the newest android-v* release and decide whether it beats `current`. */
export function pickAndroidUpdate(releases: GhRelease[], current: string): UpdateInfo {
  const cur = parseVersion(current) ?? [0];
  let best: { v: number[]; rel: GhRelease } | null = null;
  for (const r of releases) {
    if (r.draft) continue;
    if (!r.tag_name || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    const v = parseVersion(r.tag_name);
    if (!v) continue;
    if (!best || cmpVersions(v, best.v) > 0) best = { v, rel: r };
  }
  if (!best) return { available: false, version: "", url: "", notes: "" };
  const version = best.rel.tag_name.replace(TAG_PREFIX, "");
  if (cmpVersions(best.v, cur) <= 0) {
    return { available: false, version, url: "", notes: "" };
  }
  const assets = best.rel.assets ?? [];
  // Only a real .apk asset served from a trusted GitHub host — no fallback to a
  // random first asset, no arbitrary URL. If none qualifies, don't offer a broken
  // (un-installable) update.
  const apk = assets.find(
    (a) => typeof a.name === "string" && a.name.toLowerCase().endsWith(".apk") && isTrustedApkUrl(a.browser_download_url),
  );
  if (!apk) return { available: false, version, url: "", notes: "" };
  return {
    available: true,
    version,
    url: apk.browser_download_url,
    notes: (best.rel.body || best.rel.name || "").trim(),
  };
}

/** Fetch releases and return update info. Never throws (network-safe). */
export async function checkForUpdate(current: string, repo = DEFAULT_REPO): Promise<UpdateInfo> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { available: false, version: "", url: "", notes: "" };
    const data = await res.json();
    return pickAndroidUpdate(Array.isArray(data) ? data : [], current);
  } catch {
    return { available: false, version: "", url: "", notes: "" };
  }
}
