/**
 * Deterministic identity for the accepted text of one corpus authority.
 *
 * The identity intentionally matches the existing `norma.content_hash`
 * contract: article number + verbatim body, in document order, separated by
 * unambiguous control delimiters.  Keeping the algorithm here gives the
 * builder, manifest verifier, app adoption path, and pin migration one
 * portable implementation instead of four look-alike hashes.
 */

export const CORPUS_CONTENT_IDENTITY_RE = /^[0-9a-f]{16}$/;

export interface ContentIdentityArticle {
  readonly number: string;
  readonly body: string;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

function updateFnv1a64(hash: bigint, value: string): bigint {
  let next = hash;
  // Hash UTF-16 code units deliberately. This is the historical
  // `norma.content_hash` representation and is stable in Node + browsers.
  for (let index = 0; index < value.length; index += 1) {
    next = (next ^ BigInt(value.charCodeAt(index))) & FNV_MASK;
    next = (next * FNV_PRIME) & FNV_MASK;
  }
  return next;
}

/** Compute one authority identity without concatenating its full text. */
export function computeCorpusContentIdentity(
  articles: Iterable<ContentIdentityArticle>,
): string {
  let hash = FNV_OFFSET;
  let first = true;
  for (const article of articles) {
    if (!first) hash = updateFnv1a64(hash, "\u0002");
    first = false;
    hash = updateFnv1a64(hash, article.number);
    hash = updateFnv1a64(hash, "\u0001");
    hash = updateFnv1a64(hash, article.body);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Hash an arbitrary text blob with the same stable FNV-1a family. */
export function computeCorpusTextHash(text: string): string {
  return updateFnv1a64(FNV_OFFSET, text).toString(16).padStart(16, "0");
}

export type CorpusIdentityValue = string | number | null;

/**
 * Hash a typed field stream with length framing. Null, number, empty string,
 * row boundaries, and embedded delimiter characters remain distinct. This is
 * the authority-wide release identity used by manifests/adoption; callers
 * provide fields in their pinned semantic order.
 */
export function computeStructuredCorpusIdentity(
  values: Iterable<CorpusIdentityValue>,
): string {
  let hash = updateFnv1a64(FNV_OFFSET, "corpus-authority-v1;");
  for (const value of values) {
    if (value === null) {
      hash = updateFnv1a64(hash, "n;");
    } else if (typeof value === "number") {
      hash = updateFnv1a64(hash, `i${value};`);
    } else {
      hash = updateFnv1a64(hash, `s${value.length}:`);
      hash = updateFnv1a64(hash, value);
      hash = updateFnv1a64(hash, ";");
    }
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Domain-framed variant of {@link computeStructuredCorpusIdentity}: the
 * SAME length-framed field encoding, but an explicit algorithm domain
 * string, so `corpus-authority-v1`, `corpus-authority-v2`, and
 * `corpus-release-evidence-v2` streams can never collide even if their
 * fields ever line up.
 */
function computeDomainIdentity(domain: string, values: Iterable<CorpusIdentityValue>): string {
  let hash = updateFnv1a64(FNV_OFFSET, `${domain};`);
  for (const value of values) {
    if (value === null) {
      hash = updateFnv1a64(hash, "n;");
    } else if (typeof value === "number") {
      hash = updateFnv1a64(hash, `i${value};`);
    } else {
      hash = updateFnv1a64(hash, `s${value.length}:`);
      hash = updateFnv1a64(hash, value);
      hash = updateFnv1a64(hash, ";");
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export const CORPUS_ADOPTED_IDENTITY_ALGORITHM_V1 = "corpus-authority-v1";
export const CORPUS_ADOPTED_IDENTITY_ALGORITHM_V2 = "corpus-authority-v2";
export const CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2 =
  "corpus-release-evidence-v2";

/** `corpus-authority-v2` domain hash over the adopted field stream. */
export function computeAdoptedIdentityV2(
  values: Iterable<CorpusIdentityValue>,
): string {
  return computeDomainIdentity(CORPUS_ADOPTED_IDENTITY_ALGORITHM_V2, values);
}

/**
 * `corpus-release-evidence-v2` domain hash. Release evidence covers the
 * reviewed catalog digest, the complete handler reconciliation ledger,
 * the capture sidecar digests, and the generated-manifest agreement —
 * NEVER compared to a user-library pin, and never recomputable from the
 * library DB alone.
 */
export function computeReleaseEvidenceIdentityV2(
  values: Iterable<CorpusIdentityValue>,
): string {
  return computeDomainIdentity(
    CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2,
    values,
  );
}
