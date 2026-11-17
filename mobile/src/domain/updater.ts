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
  /** Set only when the check itself failed (HTTP error / offline / bad body);
   *  absent on a clean result. Korean, user-facing. */
  error?: string;
  /** "unsupported": a newer release exists but needs a newer Android than this
   *  device (its notes carry 'minSdk: N' > the device's SDK) — show a one-time
   *  notice, never the install popup (audit B15). Absent otherwise. */
  reason?: "unsupported";
  /** The release's minSdk marker, when it has one. */
  minSdk?: number;
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
  /** A GitHub pre-release: never offered as an update (audit L34). */
  prerelease?: boolean;
  assets?: GhAsset[];
}

/** How long a release check may take before it reports a failure (audit L32). */
export const UPDATE_CHECK_TIMEOUT_MS = 15000;
const TIMEOUT_MESSAGE = "응답 시간 초과 (인터넷 연결 확인)";

const failed = (error: string): UpdateInfo => ({ available: false, version: "", url: "", notes: "", error });

/** Parse "android-v1.2.3" (or "1.2.3") into [1,2,3]; null unless every dot part is
 *  plain digits ("1.2.17-gecko", "1..2" -> null — audit L33). */
export function parseVersion(tag: string): number[] | null {
  const s = String(tag ?? "").replace(TAG_PREFIX, "").replace(/^v/, "").trim();
  if (!s) return null;
  const parts = s.split(".");
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.map((p) => Number(p));
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

/** The APK download must be THIS repo's release download on github.com over https
 *  (`https://github.com/<repo>/releases/download/…`) — guards against a manipulated
 *  release JSON pointing the installer at another repo or host (audit L34). GitHub
 *  redirects that URL to its CDN itself; the CDN URL is never accepted directly. */
export function isTrustedApkUrl(url: unknown, repo: string = DEFAULT_REPO): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "github.com") return false;
    if (u.port || u.username || u.password) return false;
    // GitHub treats owner/repo case-insensitively.
    return u.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/download/`);
  } catch {
    return false;
  }
}

/** The 'minSdk: N' line of a release's notes (e.g. "minSdk: 26"), or null. */
export function parseMinSdk(notes: unknown): number | null {
  if (typeof notes !== "string") return null;
  const m = /^[\s*\-•>]*minSdk\s*[:=]\s*(\d{1,3})\s*$/im.exec(notes);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The device's Android SDK level when it is a usable number, else null (unknown). */
function validSdk(sdkInt: unknown): number | null {
  return typeof sdkInt === "number" && Number.isInteger(sdkInt) && sdkInt > 0 ? sdkInt : null;
}

/** Choose the newest android-v* release and decide whether it beats `current`.
 *  With the device's `sdkInt`, a release whose notes say 'minSdk: N' with N above
 *  it is reported unsupported instead of available (audit B15); an unknown sdkInt
 *  (older native layer) keeps the previous behavior. Drafts and pre-releases are
 *  skipped, and an installed version that doesn't parse ("1.2.17-gecko") is never
 *  offered an update — it used to count as 0 and see every release as newer (L33). */
export function pickAndroidUpdate(
  releases: GhRelease[],
  current: string,
  sdkInt?: number | null,
  repo: string = DEFAULT_REPO,
): UpdateInfo {
  const cur = parseVersion(current);
  if (!cur) return failed("현재 앱 버전을 확인하지 못했습니다");
  let best: { v: number[]; rel: GhRelease } | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
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
    (a) => typeof a.name === "string" && a.name.toLowerCase().endsWith(".apk") && isTrustedApkUrl(a.browser_download_url, repo),
  );
  if (!apk) return { available: false, version, url: "", notes: "" };
  const notes = (best.rel.body || best.rel.name || "").trim();
  const minSdk = parseMinSdk(best.rel.body ?? "");
  const sdk = validSdk(sdkInt);
  if (minSdk !== null && sdk !== null && minSdk > sdk) {
    return { available: false, version, url: "", notes, reason: "unsupported", minSdk };
  }
  const info: UpdateInfo = { available: true, version, url: apk.browser_download_url, notes };
  return minSdk !== null ? { ...info, minSdk } : info;
}

/** Thrown inside checkForUpdate when UPDATE_CHECK_TIMEOUT_MS passes. */
class UpdateCheckTimeout extends Error {}

/** `p`, or a rejection with UpdateCheckTimeout once `signal` aborts (a fetch that
 *  ignores the signal still can't hang the check). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new UpdateCheckTimeout());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Fetch releases and return update info. Never throws (network-safe). A check that
 * could not be completed (HTTP error, offline, unreadable body) returns
 * `{available:false, error}` — distinct from a clean 'no update' (no `error`), so a
 * manual check never claims '최신 버전' when it actually failed (audit 1-28).
 * `sdkInt` (AppUpdate.getVersion().sdkInt) gates releases that need a newer
 * Android (see pickAndroidUpdate); omit it when unknown.
 */
export async function checkForUpdate(current: string, sdkInt?: number | null, repo = DEFAULT_REPO): Promise<UpdateInfo> {
  // The whole check (request + body) is bounded (audit L32): a stalled connection
  // used to leave the manual check on '확인 중…' forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await untilAborted(
        fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
          headers: { Accept: "application/vnd.github+json" },
          signal: ctrl.signal,
        }),
        ctrl.signal,
      );
    } catch {
      return failed(ctrl.signal.aborted ? TIMEOUT_MESSAGE : "네트워크 오류 (인터넷 연결 확인)");
    }
    if (!res.ok) return failed(`서버 응답 오류 (HTTP ${res.status})`);
    let data: unknown;
    try {
      data = await untilAborted(res.json(), ctrl.signal);
    } catch {
      return failed(ctrl.signal.aborted ? TIMEOUT_MESSAGE : "응답 형식 오류");
    }
    if (!Array.isArray(data)) return failed("응답 형식 오류");
    return pickAndroidUpdate(data as GhRelease[], current, sdkInt, repo);
  } finally {
    clearTimeout(timer);
  }
}
