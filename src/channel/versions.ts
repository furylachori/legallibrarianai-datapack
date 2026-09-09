/** Guard for the AUTHORITATIVE version field: non-negative safe integer. */
export function isValidCorpusVersion(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isSafeInteger(v) && (v as number) >= 0
  );
}

/**
 * AUTHORITATIVE channel comparison (numeric only; releaseTag never orders).
 * Negative when a < b, zero when equal, positive when a > b.
 */
export function compareChannelVersions(a: number, b: number): number {
  if (!isValidCorpusVersion(a) || !isValidCorpusVersion(b)) {
    throw new TypeError("compareChannelVersions: invalid corpusVersion");
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tag check: exact string equality with the discovered GitHub release tag. */
export function isReleaseTagMatch(actual: string, expectedTag: string): boolean {
  return actual === expectedTag;
}
