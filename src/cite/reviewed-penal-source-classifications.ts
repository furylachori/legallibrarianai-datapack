/**
 * Reviewed Penal source-unit classifications — the small portable policy
 * that pins the exact audited classification of every unbound handler in the
 * reviewed SINALEVI Word capture of the Código Penal (authority 5027 /
 * version 151473 / template `sinalevi-word-export`).
 *
 * Pure by design: no Node, fs, or network imports. The module exports
 * the reviewed context + ordered entries, the lookup factory, and the
 * separate nonpublic persisted-gap approval used by the MCP startup
 * boundary. Every entry is hand-authored from the audited capture —
 * swapped ids, captions, source-line arrays, or DOM orders fail closed
 * when the classifier is consulted.
 *
 * Total = 18 entries:
 *   1  known-gap                       (215675, source-text-unavailable)
 *   13 reviewed-exclusion / elimination notice   (24190..24202)
 *   4  reviewed-exclusion / renumber-redirect   (24203..24206)
 *
 * The exact Word-template fingerprint is pinned as a literal product
 * evidence value below. The fingerprint itself is computed by the
 * builder's existing canonical rules serialization
 * (`templateFingerprintFor(sinaleviWordRules)` in
 * `scripts/build-corpus-artifact.ts`); the policy does NOT derive the
 * literal at runtime from the rules being validated — a rule edit moves
 * the computed fingerprint and breaks this constant, which is the
 * reviewed contract this module pins.
 *
 * Source-line arrays are positionally the cleaned lines strictly between
 * the previous terminator's line and the entry's own terminator line.
 * They are an array (never a single string), are NFC-normalized via the
 * extractor's `collapseWhitespace`+`stripAnchorMarkersFromLine` pipeline,
 * and carry NBSP and punctation variants verbatim. Captions carry the
 * normalized shape the reconciler uses after `normalizeFichaCaption`.
 */
import type {
  CaptureContext,
  FichaSourceEvent,
} from "../sinalevi/source-unit.js";

/**
 * The closed discriminator set the policy ever returns.
 * `known-gap` and `reviewed-exclusion` are the only two valid kinds;
 * anything else fails the callback-shape gate.
 */
export type ReviewedSourceKind = "known-gap" | "reviewed-exclusion";

/**
 * The closed discriminator set the policy ever emits as a reason.
 * Reasons are pinned, lowercase, hyphen-separated, content-free of the
 * actual handler/source content — they identify the reviewed
 * classification rule, not the captured text.
 */
export type ReviewedSourceReason =
  | "source-text-unavailable"
  | "source-elimination-notice"
  | "source-renumber-redirect-notice";

/** Single audited entry: every value is hand-authored from the
 *  reviewed capture and frozen as part of the module contract. */
export interface ReviewedSourceEntry {
  /** Exact SINALEVI `idArticulo` of the handler (param4). */
  readonly sourceUnitId: number;
  /** Normalized Ficha caption (post `normalizeFichaCaption`). */
  readonly normalizedCaption: string;
  /** First handler argument (`baseNumberHint`); never a join key. */
  readonly baseNumberHint: number;
  /** Second handler argument (handlerFicha); 0 under Word templates. */
  readonly handlerFicha: number;
  /** Document order index — never shuffled, never sorted. */
  readonly domOrder: number;
  /** Cleaned source lines strictly between the previous terminator
   *  line and THIS terminator line, in original order. The marker
   *  byte has already been stripped; NBSP and punctuation variants
   *  survive verbatim. */
  readonly sourceLines: readonly string[];
  /** Classification decision pinned by the audited reviewer. */
  readonly classification: {
    readonly kind: ReviewedSourceKind;
    readonly reason: ReviewedSourceReason;
  };
}

/** Context fingerprint expected by every entry. The fingerprint is
 *  pinned as a literal product evidence value (computed offline by
 *  `templateFingerprintFor(sinaleviWordRules)`), not derived at
 *  runtime from the rules being validated. A rules drift that moves
 *  the computed fingerprint must also move this literal. */
export interface ReviewedSourceContext {
  readonly authorityId: 5027;
  readonly versionId: 151473;
  readonly templateId: "sinalevi-word-export";
  readonly templateFingerprint: string;
}

/** The reviewed Penal context: authority 5027, version 151473, the
 *  Word template, and the exact current fingerprint. */
export const PENAL_REVIEWED_CONTEXT: ReviewedSourceContext = Object.freeze({
  authorityId: 5027,
  versionId: 151473,
  templateId: "sinalevi-word-export",
  templateFingerprint:
    "sha256:7927e2d9a9e5771fc844f815e406c7dee4ca52e33ad8466ea8b7f03d5077275c",
});

/** Ordered audited entries — DOM-order monotonic, exactly 18 rows,
 *  category counts 1 known-gap / 13 source-elimination-notice /
 *  4 source-renumber-redirect-notice. Captions match the
 *  `normalizeFichaCaption` shape; source-lines are NFC-normalized
 *  cleaned text; base-number hints and handler fichas match the
 *  canonical Ficha handler grammar. */
const PENAL_REVIEWED_ENTRIES: readonly ReviewedSourceEntry[] = Object.freeze([
  Object.freeze({
    sourceUnitId: 215675,
    normalizedCaption: "Ficha Artículo 381 BIS",
    baseNumberHint: 381,
    handlerFicha: 0,
    domOrder: 447,
    sourceLines: Object.freeze(["Texto de articulo no encontrado"]),
    classification: Object.freeze({
      kind: "known-gap" as const,
      reason: "source-text-unavailable" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24190,
    normalizedCaption: "Ficha Artículo 414",
    baseNumberHint: 414,
    handlerFicha: 0,
    domOrder: 486,
    sourceLines: Object.freeze([
      "( NOTA: Este articulo quedo eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24191,
    normalizedCaption: "Ficha Artículo 415",
    baseNumberHint: 415,
    handlerFicha: 0,
    domOrder: 487,
    sourceLines: Object.freeze([
      "( NOTA: Este articulo quedo eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24192,
    normalizedCaption: "Ficha Artículo 416",
    baseNumberHint: 416,
    handlerFicha: 0,
    domOrder: 488,
    sourceLines: Object.freeze([
      "( NOTA: Este articulo quedo eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24193,
    normalizedCaption: "Ficha Artículo 417",
    baseNumberHint: 417,
    handlerFicha: 0,
    domOrder: 489,
    // The cleaner's `[ \t\f\v]+` whitespace-collapse regex does NOT
    // cover U+00A0 (NBSP), so the two NBSPs between `NOTA:` and `Este`
    // survive verbatim — they are part of the audited source text.
    sourceLines: Object.freeze([
      "( NOTA:   Este articulo quedo eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24194,
    normalizedCaption: "Ficha Artículo 418",
    baseNumberHint: 418,
    handlerFicha: 0,
    domOrder: 490,
    sourceLines: Object.freeze([
      "(NOTA : Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24195,
    normalizedCaption: "Ficha Artículo 419",
    baseNumberHint: 419,
    handlerFicha: 0,
    domOrder: 491,
    sourceLines: Object.freeze([
      "(NOTA : Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24196,
    normalizedCaption: "Ficha Artículo 420",
    baseNumberHint: 420,
    handlerFicha: 0,
    domOrder: 492,
    sourceLines: Object.freeze([
      "(NOTA : Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24197,
    normalizedCaption: "Ficha Artículo 421",
    baseNumberHint: 421,
    handlerFicha: 0,
    domOrder: 493,
    sourceLines: Object.freeze([
      "(NOTA : Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24198,
    normalizedCaption: "Ficha Artículo 422",
    baseNumberHint: 422,
    handlerFicha: 0,
    domOrder: 494,
    sourceLines: Object.freeze([
      "(NOTA : Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24199,
    normalizedCaption: "Ficha Artículo 423",
    baseNumberHint: 423,
    handlerFicha: 0,
    domOrder: 495,
    sourceLines: Object.freeze([
      "(NOTA : Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, la cual reformo integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24200,
    normalizedCaption: "Ficha Artículo 424",
    baseNumberHint: 424,
    handlerFicha: 0,
    domOrder: 496,
    sourceLines: Object.freeze([
      "(NOTA: Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, al reformar integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24201,
    normalizedCaption: "Ficha Artículo 425",
    baseNumberHint: 425,
    handlerFicha: 0,
    domOrder: 497,
    sourceLines: Object.freeze([
      "( NOTA : Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, al reformar integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24202,
    normalizedCaption: "Ficha Artículo 426",
    baseNumberHint: 426,
    handlerFicha: 0,
    domOrder: 498,
    sourceLines: Object.freeze([
      "( NOTA : Este articulo fue eliminado por la Ley N° 8250 de 2 de mayo de 2002, al reformar integralmente el Libro Tercero de las Contravenciones).",
    ]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-elimination-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24203,
    normalizedCaption: "Ficha Artículo 427",
    baseNumberHint: 427,
    handlerFicha: 0,
    domOrder: 499,
    // NBSP between `NOTA:` and `Ver` survives the cleaner's
    // `[ \t\f\v]+` whitespace-collapse regex (U+00A0 is outside the
    // class). The `LIBRO CUARTO` heading line precedes the SINALEVI
    // note in the source.
    sourceLines: Object.freeze(["LIBRO CUARTO", "NOTA:   Ver actual articulo 403."]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-renumber-redirect-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24204,
    normalizedCaption: "Ficha Artículo 428",
    baseNumberHint: 428,
    handlerFicha: 0,
    domOrder: 500,
    sourceLines: Object.freeze(["NOTA:   Ver articulo 404 actual."]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-renumber-redirect-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24205,
    normalizedCaption: "Ficha Artículo 429",
    baseNumberHint: 429,
    handlerFicha: 0,
    domOrder: 501,
    sourceLines: Object.freeze(["Ver articulo 405 actual."]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-renumber-redirect-notice" as const,
    }),
  }),
  Object.freeze({
    sourceUnitId: 24206,
    normalizedCaption: "Ficha Artículo 430",
    baseNumberHint: 430,
    handlerFicha: 0,
    domOrder: 502,
    sourceLines: Object.freeze(["Ver articulo 406 actual."]),
    classification: Object.freeze({
      kind: "reviewed-exclusion" as const,
      reason: "source-renumber-redirect-notice" as const,
    }),
  }),
]);

/** The committed reviewed policy: context + ordered entries, fully
 *  frozen. Exported for the test lane (it pins the EXACT reviewed
 *  contract); production callers should use
 *  `createReviewedSourceClassifier(context)`. */
export const PENAL_REVIEWED_SOURCE_POLICY: Readonly<{
  readonly context: ReviewedSourceContext;
  readonly entries: readonly ReviewedSourceEntry[];
}> = Object.freeze({
  context: PENAL_REVIEWED_CONTEXT,
  entries: PENAL_REVIEWED_ENTRIES,
});

/** Pinned DOM-order sequence and category counts — module-construction
 *  self-check, independent of the entry list and the lookup. The
 *  invariant is total: 18 rows, exactly 1 known-gap / 13
 *  source-elimination-notice / 4 source-renumber-redirect-notice,
 *  DOM orders exactly `[447, 486..498, 499..502]`. A drift (extra row,
 *  reorder, swapped kind, wrong reason) fails the module load BEFORE
 *  any caller reads the policy. */
const EXPECTED_DOM_ORDERS: readonly number[] = Object.freeze([
  447,
  486, 487, 488, 489, 490, 491, 492, 493, 494, 495, 496, 497, 498,
  499, 500, 501, 502,
]);
const EXPECTED_CATEGORY_COUNTS: Readonly<{
  readonly "known-gap": 1;
  readonly "source-elimination-notice": 13;
  readonly "source-renumber-redirect-notice": 4;
}> = Object.freeze({
  "known-gap": 1,
  "source-elimination-notice": 13,
  "source-renumber-redirect-notice": 4,
} as const);

(function assertReviewedPolicyShape(): void {
  if (PENAL_REVIEWED_ENTRIES.length !== 18) {
    throw new Error(
      `PENAL_REVIEWED_SOURCE_POLICY carries ${PENAL_REVIEWED_ENTRIES.length} entries, expected 18`,
    );
  }
  if (EXPECTED_DOM_ORDERS.length !== 18) {
    throw new Error(
      `PENAL_REVIEWED_SOURCE_POLICY expected-dom-order list carries ${EXPECTED_DOM_ORDERS.length} positions, expected 18`,
    );
  }
  let knownGapCount = 0;
  let eliminationCount = 0;
  let redirectCount = 0;
  let prevDom = -1;
  const seenIds = new Set<number>();
  for (let i = 0; i < PENAL_REVIEWED_ENTRIES.length; i += 1) {
    const entry = PENAL_REVIEWED_ENTRIES[i]!;
    if (seenIds.has(entry.sourceUnitId)) {
      throw new Error(
        `PENAL_REVIEWED_SOURCE_POLICY duplicates sourceUnitId ${entry.sourceUnitId}`,
      );
    }
    seenIds.add(entry.sourceUnitId);
    if (entry.domOrder !== EXPECTED_DOM_ORDERS[i]) {
      throw new Error(
        `PENAL_REVIEWED_SOURCE_POLICY entry ${i} domOrder ${entry.domOrder} drifts from expected ${EXPECTED_DOM_ORDERS[i]}`,
      );
    }
    if (entry.domOrder <= prevDom) {
      throw new Error(
        `PENAL_REVIEWED_SOURCE_POLICY entry ${i} domOrder ${entry.domOrder} is not strictly greater than ${prevDom}`,
      );
    }
    prevDom = entry.domOrder;
    if (
      entry.classification.kind !== "known-gap" &&
      entry.classification.kind !== "reviewed-exclusion"
    ) {
      throw new Error(
        `PENAL_REVIEWED_SOURCE_POLICY entry ${entry.sourceUnitId} carries unknown kind ${String(entry.classification.kind)}`,
      );
    }
    if (
      entry.classification.reason !== "source-text-unavailable" &&
      entry.classification.reason !== "source-elimination-notice" &&
      entry.classification.reason !== "source-renumber-redirect-notice"
    ) {
      throw new Error(
        `PENAL_REVIEWED_SOURCE_POLICY entry ${entry.sourceUnitId} carries unknown reason ${entry.classification.reason}`,
      );
    }
    if (entry.classification.kind === "known-gap") {
      knownGapCount += 1;
    } else if (entry.classification.reason === "source-elimination-notice") {
      eliminationCount += 1;
    } else if (entry.classification.reason === "source-renumber-redirect-notice") {
      redirectCount += 1;
    }
  }
  if (knownGapCount !== EXPECTED_CATEGORY_COUNTS["known-gap"]) {
    throw new Error(
      `PENAL_REVIEWED_SOURCE_POLICY known-gap count ${knownGapCount} drifts from expected ${EXPECTED_CATEGORY_COUNTS["known-gap"]}`,
    );
  }
  if (eliminationCount !== EXPECTED_CATEGORY_COUNTS["source-elimination-notice"]) {
    throw new Error(
      `PENAL_REVIEWED_SOURCE_POLICY source-elimination-notice count ${eliminationCount} drifts from expected ${EXPECTED_CATEGORY_COUNTS["source-elimination-notice"]}`,
    );
  }
  if (redirectCount !== EXPECTED_CATEGORY_COUNTS["source-renumber-redirect-notice"]) {
    throw new Error(
      `PENAL_REVIEWED_SOURCE_POLICY source-renumber-redirect-notice count ${redirectCount} drifts from expected ${EXPECTED_CATEGORY_COUNTS["source-renumber-redirect-notice"]}`,
    );
  }
})();

/** Classification result the classifier ever returns: never undefined,
 *  never any kind beyond the two pinned. */
export interface ReviewedSourceClassification {
  readonly kind: ReviewedSourceKind;
  readonly reason: ReviewedSourceReason;
}

/** Stateful classifier produced by `createReviewedSourceClassifier`.
 *  Each invocation consumes the next-expected entry in DOM order and
 *  returns the pinned classification; misses (id, caption, base, ficha,
 *  DOM order, source lines) fail closed with a content-stable reason. */
export interface ReviewedSourceClassifier {
  /** Lookup one unbound event against the policy. Returns the pinned
   *  classification when the event matches the next-expected entry;
   *  returns `null` ONLY for a genuinely unrelated event under a
   *  non-reviewed context (so callers can fall through to the
   *  existing `gapReason` behavior). Throws when the next event in
   *  DOM order fails to match the next-expected entry, when an extra
   *  event arrives after the last entry has already been consumed,
   *  or when a reviewed target id appears under a drifted context
   *  (wrong authority, version, template id, or fingerprint). */
  (event: FichaSourceEvent, sourceLines: readonly string[]): ReviewedSourceClassification | null;
  /** Validate that exactly the 18 entries were consumed. Throws when
   *  fewer events were seen than expected (a missing-emitted expected
   *  row in the captured Penal context). Called by the extractor
   *  after reconciliation completes. */
  validateFinalState(): void;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Every audited policy target id — the known-gap id plus the 17
 *  reviewed-exclusion ids. A reviewed target id is evidence that the
 *  audited Penal capture is being processed; seeing one under a
 *  context that is NOT the reviewed Penal context is evidence/context
 *  drift, never a license to fall through silently. */
const PENAL_REVIEWED_TARGET_SOURCE_UNIT_IDS: ReadonlySet<number> =
  new Set<number>(PENAL_REVIEWED_ENTRIES.map((entry) => entry.sourceUnitId));

function contextDriftError(
  event: FichaSourceEvent,
  context: CaptureContext,
): Error {
  return new Error(
    `reviewed Penal source-classification: reviewed target sourceUnitId ${event.sourceUnitId} appeared under a NON-reviewed context (authority ${context.authorityId} / version ${context.versionId} / template ${context.templateId} / fingerprint ${context.templateFingerprint}) — evidence/context drift, not an unrelated event`,
  );
}

/** Pure factory: returns a stateful classifier that admits one event
 *  per invocation and validates the entire 18-entry sequence.
 *
 *  Context admission:
 *  - The exact reviewed Penal context runs the sequential lookup; ANY
 *    unbound event that drifts from the next-expected audited entry
 *    (id, DOM order, caption, base hint, ficha, source lines) throws
 *    fail-closed — including a policy caption paired with a foreign
 *    id. Emitted bindings never reach the classifier (the reconciler
 *    only consults it for unbound events), so the legitimate emitted
 *    `215685` duplicate caption is never judged against the policy.
 *  - A non-reviewed context returns `null` ONLY for genuinely
 *    unrelated events (so the existing `gapReason` fallback runs
 *    unchanged for every unaffected authority). If a reviewed target
 *    id appears under a wrong authority, version, template id, or
 *    template fingerprint, that is evidence/context drift and the
 *    classifier THROWS — a universal `null` passthrough would let a
 *    reviewed target silently reclassify under an unreviewed context.
 *  - `validateFinalState` on a non-reviewed context is a no-op: the
 *    policy sequence is only owed to the reviewed capture. */
export function createReviewedSourceClassifier(
  context: CaptureContext,
): ReviewedSourceClassifier {
  const matchesContext =
    context.authorityId === PENAL_REVIEWED_CONTEXT.authorityId &&
    context.versionId === PENAL_REVIEWED_CONTEXT.versionId &&
    context.templateId === PENAL_REVIEWED_CONTEXT.templateId &&
    context.templateFingerprint === PENAL_REVIEWED_CONTEXT.templateFingerprint;
  if (!matchesContext) {
    const passthrough = ((event: FichaSourceEvent): ReviewedSourceClassification | null => {
      if (PENAL_REVIEWED_TARGET_SOURCE_UNIT_IDS.has(event.sourceUnitId)) {
        throw contextDriftError(event, context);
      }
      return null;
    }) as unknown as ReviewedSourceClassifier;
    (passthrough as { validateFinalState(): void }).validateFinalState = (): void => undefined;
    return Object.freeze(passthrough);
  }
  let index = 0;
  const classify: ReviewedSourceClassifier = ((
    event: FichaSourceEvent,
    sourceLines: readonly string[],
  ): ReviewedSourceClassification | null => {
    if (index >= PENAL_REVIEWED_ENTRIES.length) {
      throw new Error(
        `reviewed Penal source-classification: extra unbound event sourceUnitId ${event.sourceUnitId} at domOrder ${event.domOrder} after the 18th audited entry was consumed`,
      );
    }
    const entry = PENAL_REVIEWED_ENTRIES[index]!;
    if (event.sourceUnitId !== entry.sourceUnitId) {
      throw new Error(
        `reviewed Penal source-classification: unbound event sourceUnitId ${event.sourceUnitId} at domOrder ${event.domOrder} does not match the next-expected entry sourceUnitId ${entry.sourceUnitId} (domOrder ${entry.domOrder})`,
      );
    }
    if (event.domOrder !== entry.domOrder) {
      throw new Error(
        `reviewed Penal source-classification: unbound event sourceUnitId ${entry.sourceUnitId} domOrder ${event.domOrder} drifts from expected ${entry.domOrder}`,
      );
    }
    if (event.caption !== entry.normalizedCaption) {
      throw new Error(
        `reviewed Penal source-classification: unbound event sourceUnitId ${entry.sourceUnitId} caption "${event.caption}" drifts from the audited policy caption "${entry.normalizedCaption}"`,
      );
    }
    if (event.baseNumber !== entry.baseNumberHint) {
      throw new Error(
        `reviewed Penal source-classification: unbound event sourceUnitId ${entry.sourceUnitId} base-number hint ${event.baseNumber} drifts from the audited policy hint ${entry.baseNumberHint}`,
      );
    }
    if (event.handlerFicha !== entry.handlerFicha) {
      throw new Error(
        `reviewed Penal source-classification: unbound event sourceUnitId ${entry.sourceUnitId} handlerFicha ${event.handlerFicha} drifts from the audited policy ficha ${entry.handlerFicha}`,
      );
    }
    if (!arraysEqual(sourceLines, entry.sourceLines)) {
      throw new Error(
        `reviewed Penal source-classification: unbound event sourceUnitId ${entry.sourceUnitId} source-lines array does not match the audited policy (got ${JSON.stringify(sourceLines)} expected ${JSON.stringify(entry.sourceLines)})`,
      );
    }
    index += 1;
    return Object.freeze({
      kind: entry.classification.kind,
      reason: entry.classification.reason,
    });
  }) as ReviewedSourceClassifier;
  (classify as { validateFinalState(): void }).validateFinalState = (): void => {
    if (index !== PENAL_REVIEWED_ENTRIES.length) {
      throw new Error(
        `reviewed Penal source-classification: only ${index} of ${PENAL_REVIEWED_ENTRIES.length} audited entries were consumed (${PENAL_REVIEWED_ENTRIES.length - index} missing)`,
      );
    }
  };
  return Object.freeze(classify);
}

/** True iff `context` matches every field of `PENAL_REVIEWED_CONTEXT`.
 *  Pure equality check; no coercion, no fallback, no defaulting. */
export function isPenalReviewedContext(context: CaptureContext): boolean {
  return (
    context.authorityId === PENAL_REVIEWED_CONTEXT.authorityId &&
    context.versionId === PENAL_REVIEWED_CONTEXT.versionId &&
    context.templateId === PENAL_REVIEWED_CONTEXT.templateId &&
    context.templateFingerprint === PENAL_REVIEWED_CONTEXT.templateFingerprint
  );
}

/**
 * The exact nonpublic persisted-gap approval for the reviewed Penal
 * context — a coordinate-less fingerprint the MCP startup boundary
 * uses to admit the one new persisted gap without exposing any
 * article number, artId, or public gap code. The approval pins the
 * audited `source_unit_id` (an internal id, NOT a coordinate), the
 * audited `caption` (the normalized Ficha caption with its accented
 * `í`, persisted byte-for-byte in the generated DB, never parsed for
 * a coordinate), the audited `doc_order` (the reconciled DOM-order
 * position of the 215675 handler — 447, an internal ledger position,
 * never a coordinate), and the `(authority, version, classification,
 * reason)` tuple. There is deliberately NO articleNumber, artId, gap
 * code, or public code field: the projection stays CADH-53 only.
 * Any drift on any of these fields rejects fail-closed.
 *
 * Every value is the real audited evidence from the generated
 * v3/schema-v2 database (`codigo_penal_raw.json` capture through the
 * reviewed classification policy):
 *   authority 5027 / version 151473 / sourceUnitId 215675 /
 *   caption "Ficha Artículo 381 BIS" / docOrder 447 /
 *   reason "source-text-unavailable".
 */
export interface NonpublicPenalPersistedGapApproval {
  readonly authorityId: 5027;
  readonly versionId: 151473;
  readonly classification: "known-gap";
  readonly reason: "source-text-unavailable";
  readonly auditedSourceUnitId: 215675;
  readonly auditedCaption: "Ficha Artículo 381 BIS";
  readonly auditedDocOrder: 447;
}

export const NONPUBLIC_PENAL_PERSISTED_GAP_APPROVAL: NonpublicPenalPersistedGapApproval =
  Object.freeze({
    authorityId: 5027,
    versionId: 151473,
    classification: "known-gap",
    reason: "source-text-unavailable",
    auditedSourceUnitId: 215675,
    // The exact normalized Ficha caption persisted in the generated DB
    // — accented `í` (U+00ED), byte-for-byte.
    auditedCaption: "Ficha Artículo 381 BIS",
    // The audited DOM order of the unbound 215675 handler in the
    // reviewed capture — the persisted `doc_order`, not an article
    // position and never derived from the caption.
    auditedDocOrder: 447,
  });

/** Exact exclusion-identity set the MCP startup boundary uses to
 *  reject accidental persistence of any reviewed-exclusion id under
 *  the Penal context. Frozen identity-only set; no article number,
 *  no artId, no public gap code. */
export const PENAL_REVIEWED_EXCLUSION_SOURCE_UNIT_IDS: ReadonlySet<number> =
  new Set<number>(
    PENAL_REVIEWED_ENTRIES.filter(
      (entry) => entry.classification.kind === "reviewed-exclusion",
    ).map((entry) => entry.sourceUnitId),
  );
