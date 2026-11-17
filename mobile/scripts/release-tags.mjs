/**
 * Pure helpers for verify-release.mjs (audit B14): the PUBLISHED android-v*
 * tags come from `git ls-remote --tags origin`, never from local tags (a stale
 * clone without `git fetch --tags` would otherwise pass an already-published
 * version). No I/O here.
 */

export const TAG_RE = /^android-v(\d+)\.(\d+)\.(\d+)$/;

export function semverCmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * `git ls-remote --tags` output -> Map(tagName -> commit sha). For an annotated
 * tag the peeled `^{}` line (the commit) wins over the tag-object line.
 */
export function parseRemoteTags(out) {
  const tags = new Map();
  const peeled = new Map();
  for (const raw of String(out || "").split(/\r?\n/)) {
    const m = raw.trim().match(/^([0-9a-f]{7,64})\s+refs\/tags\/(.+)$/i);
    if (!m) continue;
    const [, sha, ref] = m;
    if (ref.endsWith("^{}")) peeled.set(ref.slice(0, -3), sha);
    else tags.set(ref, sha);
  }
  for (const [name, sha] of peeled) tags.set(name, sha);
  return tags;
}

/** Highest android-vX.Y.Z tag in `tags` (Map name -> sha), excluding `exclude`;
 *  null when there is none. */
export function latestReleaseTag(tags, exclude = "") {
  let best = null;
  for (const [tag, sha] of tags) {
    if (tag === exclude) continue;
    const m = tag.match(TAG_RE);
    if (!m) continue;
    const v = m.slice(1, 4).map(Number);
    if (!best || semverCmp(v, best.v) > 0) best = { tag, sha, v };
  }
  return best;
}
