/**
 * Wording for the B15 'this phone can't install the new version' notice. The
 * phone's own Android version and the release's minimum come from the API levels
 * (device Build.VERSION.SDK_INT, release notes 'minSdk: N'), so the text stays
 * right whenever a later release raises the minimum — never a fixed 'Android 7'.
 */

/** API level -> Android release name (the ones this app can meet). */
const ANDROID_RELEASE_NAMES: Readonly<Record<number, string>> = {
  21: "5.0", 22: "5.1", 23: "6.0", 24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1",
  28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16",
};

/** 'Android X' name of an API level, or null when unknown / not a known level. */
export function androidVersionName(sdk: number | null | undefined): string | null {
  if (typeof sdk !== "number" || !Number.isInteger(sdk)) return null;
  return ANDROID_RELEASE_NAMES[sdk] ?? null;
}

export interface UnsupportedUpdateInput {
  deviceSdk: number | null | undefined;
  minSdk: number | null | undefined;
  version: string;
}

export interface UnsupportedUpdateNotice {
  /** One line: the toast (manual check) and the first sentence of the dialog. */
  short: string;
  /** The rest of the one-time dialog. */
  detail: string;
}

export function unsupportedUpdateNotice({ deviceSdk, minSdk, version }: UnsupportedUpdateInput): UnsupportedUpdateNotice {
  const device = androidVersionName(deviceSdk);
  const need = androidVersionName(minSdk);
  const short = device
    ? `이 휴대폰(Android ${device})은 새 버전을 설치할 수 없습니다`
    : "이 휴대폰은 새 버전을 설치할 수 없습니다";
  const label = version ? `새 버전(v${version})은` : "새 버전은";
  const detail = need
    ? `${label} Android ${need} 이상에서만 설치됩니다. 지금 버전을 계속 쓰시면 됩니다.`
    : `${label} 이 휴대폰보다 높은 Android 버전에서만 설치됩니다. 지금 버전을 계속 쓰시면 됩니다.`;
  return { short, detail };
}

/** The release-notes line read by parseMinSdk (domain/updater) — same pattern. */
const MIN_SDK_LINE = /^[\s*\-•>]*minSdk\s*[:=]\s*\d{1,3}\s*$/i;

/** Release notes as shown in the 업데이트 popup: the machine-read 'minSdk: N'
 *  marker line (RELEASING.md template) is dropped; everything else is kept. */
export function releaseNotesForDisplay(notes: string): string {
  if (!notes) return "";
  return notes
    .split(/\r?\n/)
    .filter((line) => !MIN_SDK_LINE.test(line))
    .join("\n");
}
