/**
 * Fail-closed admission gate for SINALEVI corpus-extraction diagnostics.
 *
 * The shipped `extract()` never silently drops content: an empty `dropped`
 * is the audit-promised invariant, and the only `warnings` it emits are a
 * small, well-known set of systemic messages (article-occurrence ratios,
 * non-lossy folded cross-references, and the single reviewed header-suffix
 * adoption). A candidate corpus build that surfaces an UNKNOWN warning
 * string, a NEAR-MATCH (sub-string, prefix, regex, or normalization-varied)
 * string, or an EXTRA DUPLICATE beyond an authority's reviewed budget is
 * off-contract and MUST NOT ship. Likewise, ANY non-empty `dropped` is a
 * hard failure — there is no reviewed template for which the extractor
 * admits a dropped segment.
 *
 * This gate is intentionally scoped:
 *  - It is the WARNING / DROP admission slice. It does NOT validate
 *    `sourceGaps`: typed gaps are STRUCTURED records with their own
 *    ledger-validated lifecycle (see `bindSourceUnits`). A warning that
 *    looks similar to a gap (e.g. "Texto no disponible" reasoning) is
 *    still a warning and still needs explicit approval — gap equivalence
 *    is a separate, downstream concern.
 *  - Approvals are UPPER BOUNDS, not expected candidate outputs. Missing
 *    approved values are allowed in this allowlist slice; the goal is to
 *    reject any UNAPPROVED diagnostic, not to assert a specific emitted
 *    set. Approval drift is still surfaced as unapproved warnings so
 *    reviewers see every change.
 *  - String comparison is EXACT JavaScript string/code-point equality.
 *    No regex, no prefix, no substring, no normalization, no
 *    deduplication, no global approvals. The audit's 35 distinct strings
 *    are the only basis for matching; a single typo or whitespace drift
 *    on either side fails closed.
 *
 * The gate is pure and side-effect free: it never mutates its inputs and
 * never touches the filesystem. Callers fail the build by surfacing the
 * thrown `Error`, which lists the authority slug, fixture, counts, and
 * exact JSON-quoted details for every unapproved warning and every
 * dropped segment.
 */
import type {
  DroppedSegment,
  ExtractedNorma,
  SourceGap,
  SourceLedgerEntry,
} from "./types.js";

/**
 * Read-only projection of an extracted corpus candidate that this gate
 * actually inspects. The shape matches `ExtractedNorma`'s own field
 * types; using a `Pick` keeps the public contract narrow and prevents
 * callers from accidentally widening what the gate sees.
 */
export type ExtractedDiagnostics = Readonly<
  Pick<ExtractedNorma, "warnings" | "dropped" | "sourceGaps">
>;

/** Identifier for the authority + fixture pair the gate is judging. */
export interface GateSource {
  readonly slug: string;
  readonly fixture: string;
}

/**
 * Fail-closed admission check for a corpus-extraction result.
 *
 * Behavior:
 *  - Compares each warning value with `approvedWarnings` using exact
 *    JavaScript string/code-point equality (no normalization).
 *  - Counts multiplicities: a warning that appears MORE often in
 *    `extracted.warnings` than its approved budget fails with the
 *    surplus reported as additional duplicates. The first occurrence
 *    that matches consumes one approval slot, so order is irrelevant
 *    and a near-match in either list is fatal.
 *  - Rejects when `extracted.dropped` is non-empty: any dropped segment
 *    is unpublishable, irrespective of approvals.
 *  - Collects BOTH unapproved-warning and dropped categories before
 *    throwing, so a single failure reports both.
 *  - Throws an `Error` whose message starts with the stable phrase
 *    `corpus extraction rejected` and contains the exact authority slug,
 *    the fixture name, both counts, every unapproved warning JSON-quoted,
 *    and every dropped segment's array index, `numberGuess` (or the
 *    literal `<unknown>`), exact reason, and exact snippet, all safely
 *    JSON-quoted so newlines, quotes, and other hostile bytes survive
 *    round-tripping into a build log.
 *  - Does NOT mutate `extracted`, `approvedWarnings`, or `source`.
 *  - Typed `sourceGaps` are deliberately outside this gate: a similar-
 *    looking warning still needs explicit approval, but a typed gap is
 *    a separate structured record consumed by the source ledger. Passing
 *    a non-empty `sourceGaps` is therefore valid in isolation; only
 *    warnings and drops fail.
 */
export function assertCorpusExtractionPublishable(
  source: GateSource,
  extracted: ExtractedDiagnostics,
  approvedWarnings: readonly string[],
): void {
  // Defensive copies of the inputs: the gate must never mutate its
  // arguments, and a `readonly` typed array still allows in-place
  // mutation through captured references. Frozen snapshots make the
  // contract explicit and let the test prove non-mutation by comparing
  // reference identity and per-element equality on the originals.
  const sourceSnapshot: GateSource = Object.freeze({ slug: source.slug, fixture: source.fixture });
  const extractedWarnings: readonly string[] = Object.freeze([...extracted.warnings]) as readonly string[];
  const extractedDropped: readonly DroppedSegment[] = Object.freeze([
    ...extracted.dropped,
  ]) as readonly DroppedSegment[];
  const approvedSnapshot: readonly string[] = Object.freeze([...approvedWarnings]) as readonly string[];

  // Per-string approved multiplicities. A `Map` is keyed by exact
  // JavaScript string identity; any normalization step here would
  // weaken the fail-closed contract (a typo would silently match).
  const approvedRemaining = new Map<string, number>();
  for (const w of approvedSnapshot) {
    approvedRemaining.set(w, (approvedRemaining.get(w) ?? 0) + 1);
  }

  const unapprovedWarnings: string[] = [];
  for (const w of extractedWarnings) {
    const remaining = approvedRemaining.get(w) ?? 0;
    if (remaining > 0) {
      approvedRemaining.set(w, remaining - 1);
    } else {
      // No approval budget left for this exact string: the warning is
      // either unknown, a near-match that the strict-equality gate
      // refused to align, or an additional duplicate beyond the
      // reviewed count. All three are unapproved in this slice.
      unapprovedWarnings.push(w);
    }
  }

  const droppedCount = extractedDropped.length;
  const unapprovedCount = unapprovedWarnings.length;
  if (unapprovedCount === 0 && droppedCount === 0) return;

  const lines: string[] = [];
  lines.push("corpus extraction rejected");
  lines.push(`authority: ${sourceSnapshot.slug}`);
  lines.push(`fixture: ${sourceSnapshot.fixture}`);
  lines.push(`unapprovedWarnings: ${unapprovedCount}`);
  lines.push(`droppedSegments: ${droppedCount}`);
  lines.push("unapproved warnings:");
  if (unapprovedCount === 0) {
    lines.push("  - (none)");
  } else {
    for (const w of unapprovedWarnings) {
      lines.push(`  - ${JSON.stringify(w)}`);
    }
  }
  lines.push("dropped segments:");
  if (droppedCount === 0) {
    lines.push("  - (none)");
  } else {
    for (let i = 0; i < extractedDropped.length; i += 1) {
      const d = extractedDropped[i]!;
      const numberGuess =
        d.numberGuess === undefined ? "<unknown>" : JSON.stringify(d.numberGuess);
      lines.push(
        `  - [${i}] numberGuess: ${numberGuess} reason: ${JSON.stringify(d.reason)} snippet: ${JSON.stringify(d.snippet)}`,
      );
    }
  }
  throw new Error(lines.join("\n"));
}

/**
 * S-INI — builder admission for the persisted-gap/ledger identity
 * slice. SEPARATE from the warning/drop slice above: this gate never
 * looks at `warnings` or `dropped`; it proves that the persistable
 * `sourceGaps` rows and the ledger's `known-gap` entries are the SAME
 * exact records, and that the reviewed-exclusion classification stayed
 * ledger-only.
 *
 * Contract (all comparisons are exact JavaScript string/code-point and
 * number equality — no normalization, no substring, no reordering):
 *
 *  1. FULL LEDGER IDENTITY — every ledger entry carries a positive
 *     JS-safe-integer `sourceUnitId` and every id is unique across the
 *     WHOLE ledger (emitted articles, emitted transitorias, known
 *     gaps, reviewed exclusions share one namespace).
 *  2. GAP IDENTITY — every persisted `sourceGaps` row carries a
 *     positive JS-safe-integer id, no id repeats inside `sourceGaps`,
 *     and NO reviewed-exclusion id (from
 *     `reviewedExclusionSourceUnitIds`) appears in `sourceGaps` at
 *     all — exclusions are ledger-only classifications and any leak
 *     into the persisted gap table is fatal regardless of reason.
 *  3. EQUAL CARDINALITY — `sourceGaps.length` equals the number of
 *     `known-gap` ledger entries. A missing ledger entry (extra gap
 *     row) or a missing gap row (extra ledger entry) fails here.
 *  4. EXACT ORDERED FIELD IDENTITY — in deterministic order (ledger
 *     event order and persisted row order are both document order),
 *     position `i` of `sourceGaps` must agree with position `i` of the
 *     `known-gap` ledger entries on ALL FOUR fields: `sourceUnitId`,
 *     `reason`, normalized `caption`, and `docOrder` (vs. the entry's
 *     `domOrder`). Reordered, duplicated, or field-drifted rows fail
 *     at the first mismatching position even when the cardinality and
 *     the id SETS still match.
 *
 * The gate is pure: it never mutates its inputs and never touches the
 * filesystem. Every failure throws an `Error` naming the authority
 * slug, the fixture, the position, and the exact JSON-quoted
 * drifted values.
 */
export function assertSourceGapLedgerIdentity(
  source: GateSource,
  sourceGaps: readonly SourceGap[],
  ledger: readonly SourceLedgerEntry[],
  reviewedExclusionSourceUnitIds: ReadonlySet<number>,
): void {
  const label = `${source.slug} (${source.fixture})`;

  // (1) Full-ledger identity: positive safe ids, unique across every kind.
  const ledgerIds = new Set<number>();
  for (let i = 0; i < ledger.length; i += 1) {
    const entry = ledger[i]!;
    if (!Number.isSafeInteger(entry.sourceUnitId) || entry.sourceUnitId <= 0) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: ledger entry ${i} (${entry.kind}) carries non-positive or unsafe sourceUnitId ${String(entry.sourceUnitId)}`,
      );
    }
    if (ledgerIds.has(entry.sourceUnitId)) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: sourceUnitId ${entry.sourceUnitId} repeats across the full ledger`,
      );
    }
    ledgerIds.add(entry.sourceUnitId);
  }

  // (2) Gap identity: positive safe ids, unique inside `sourceGaps`,
  // and no reviewed-exclusion id ever persists as a gap row.
  const gapIds = new Set<number>();
  for (let i = 0; i < sourceGaps.length; i += 1) {
    const gap = sourceGaps[i]!;
    if (!Number.isSafeInteger(gap.sourceUnitId) || gap.sourceUnitId <= 0) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: sourceGaps row ${i} carries non-positive or unsafe sourceUnitId ${String(gap.sourceUnitId)}`,
      );
    }
    if (gapIds.has(gap.sourceUnitId)) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: sourceUnitId ${gap.sourceUnitId} repeats inside sourceGaps`,
      );
    }
    gapIds.add(gap.sourceUnitId);
    if (reviewedExclusionSourceUnitIds.has(gap.sourceUnitId)) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: reviewed-exclusion sourceUnitId ${gap.sourceUnitId} leaked into sourceGaps (exclusions are ledger-only, never persisted gap rows)`,
      );
    }
  }
  for (const exclusionId of reviewedExclusionSourceUnitIds) {
    if (gapIds.has(exclusionId)) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: reviewed-exclusion sourceUnitId ${exclusionId} present in sourceGaps`,
      );
    }
  }

  // (3) Equal cardinality between persisted rows and ledger known-gaps.
  const knownGapEntries = ledger.filter((entry) => entry.kind === "known-gap");
  if (sourceGaps.length !== knownGapEntries.length) {
    throw new Error(
      `source-gap ledger identity rejected for ${label}: sourceGaps carries ${sourceGaps.length} rows but the ledger carries ${knownGapEntries.length} known-gap entries (missing, extra, or unaccounted persisted gap)`,
    );
  }

  // (4) Exact ordered field identity: sourceUnitId, reason, normalized
  // caption, and docOrder vs. domOrder at every position.
  for (let i = 0; i < knownGapEntries.length; i += 1) {
    const entry = knownGapEntries[i]!;
    const gap = sourceGaps[i]!;
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: known-gap ledger entry ${i} (sourceUnitId ${entry.sourceUnitId}) carries no reason`,
      );
    }
    if (gap.sourceUnitId !== entry.sourceUnitId) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: sourceGaps[${i}] sourceUnitId ${gap.sourceUnitId} does not match the known-gap ledger entry sourceUnitId ${entry.sourceUnitId} (reordered, duplicated, or substituted row)`,
      );
    }
    if (gap.reason !== entry.reason) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: sourceGaps[${i}] (sourceUnitId ${gap.sourceUnitId}) reason ${JSON.stringify(gap.reason)} drifts from the ledger reason ${JSON.stringify(entry.reason)}`,
      );
    }
    if (gap.caption !== entry.caption) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: sourceGaps[${i}] (sourceUnitId ${gap.sourceUnitId}) caption ${JSON.stringify(gap.caption)} drifts from the ledger normalized caption ${JSON.stringify(entry.caption)}`,
      );
    }
    if (gap.docOrder !== entry.domOrder) {
      throw new Error(
        `source-gap ledger identity rejected for ${label}: sourceGaps[${i}] (sourceUnitId ${gap.sourceUnitId}) docOrder ${gap.docOrder} drifts from the ledger domOrder ${entry.domOrder}`,
      );
    }
  }
}
