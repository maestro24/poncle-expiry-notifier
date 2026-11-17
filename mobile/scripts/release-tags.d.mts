/** Types for release-tags.mjs (pure helpers of verify-release.mjs). */
export declare const TAG_RE: RegExp;
export declare function semverCmp(a: number[], b: number[]): number;
export declare function parseRemoteTags(out: string | null | undefined): Map<string, string>;
export declare function latestReleaseTag(
  tags: Map<string, string>,
  exclude?: string,
): { tag: string; sha: string; v: number[] } | null;
