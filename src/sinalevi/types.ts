export type HierarchyKind = "libro" | "titulo" | "capitulo" | "seccion";

export interface HierarchyNode {
  kind: HierarchyKind;
  label: string;
  /** Optional descriptive label that followed the marker word, if any. */
  displayLabel?: string;
  /**
   * M-LAW-11 — GLOBAL extraction-order coordinate: the line index of this
   * marker in the cleaned text. One coordinate space is shared by
   * hierarchy nodes, articles and transitory provisions, so a branch that
   * holds BOTH sub-sections and articles can be ordered by a single value
   * instead of two per-array `doc_order`s that restart at zero. Absent on
   * hand-built inputs — the DB stores NULL and the tree falls back to the
   * per-array order (see `getIndexTree`).
   */
  extractOrder?: number;
}

export interface Article {
  number: string;
  /**
   * S-INI — exact SINALEVI source-unit id (`idArticulo`, the handler's
   * fourth literal) bound POSITIONALLY to the Ficha terminator this
   * article consumed. Absent on hand-built inputs; the vNext schema
   * persists it and the source-action boundary derives the captured
   * unit route from it. Never reconstructed from a caption or number.
   */
  sourceUnitId?: number;
  ordinalRaw: string;
  body: string;
  fichaRef?: string;
  path: string[];
  /**
   * Index into `ExtractedNorma.hierarchy[]` of the deepest hierarchy node
   * in force when this article was emitted (the live heading stack's bottom
   * entry). Set by the extractor; null if no headings were active.
   * This is the unambiguous linkage the DB layer uses to file the article
   * in the Super Index — label-matching is ambiguous because "CAPITULO
   * PRIMERO" recurs under every título.
   */
  hierarchyIndex?: number | null;
  /**
   * M-LAW-11 — GLOBAL extraction-order coordinate: the line index of this
   * article's header in the cleaned text. Same coordinate space as
   * `HierarchyNode.extractOrder`, which is what lets a Super-Index branch
   * interleave its sub-sections and its articles in document order.
   */
  extractOrder?: number;
}

/**
 * M-LAW-10 — one STANDALONE transitory provision ("TRANSITORIO I.- …",
 * "Transitorio al artículo 148. …", "DISPOSICIÓN TRANSITORIA 2.- …").
 *
 * A transitorio is not an `Article`: its header carries no
 * `ARTICULO N` token, so it never reaches `articles[]` and (before this
 * record existed) its text was silently lost whenever it sat OUTSIDE an
 * article's body span — between two articles, or after the last Ficha.
 * This is an ADDRESSABLE record: `number` + `attachesTo` name it, and the
 * DB stores it in its own table so a citation like "Transitorio I" can be
 * resolved instead of dropped.
 */
export interface TransitoryProvision {
  /** Printed token after the marker word: "I", "2", "148". Never an int. */
  number: string;
  /**
   * S-INI — source-unit id bound to the exact "Ficha Artículo N
   * Transitorio" terminator consumed by this standalone provision.
   */
  sourceUnitId?: number;
  /** The ordinal as printed ("1º"), or "" for a suffixed/roman form. */
  ordinalRaw: string;
  /**
   * The article a "Transitorio al artículo 148" form attaches to. Empty
   * string (never null) when the header carries no such reference, so the
   * DB identity column stays total.
   */
  attachesTo: string;
  /** VERBATIM provision text, header removed. */
  body: string;
  /** Verbatim header line, for display and triage. */
  label: string;
  path: string[];
  hierarchyIndex?: number | null;
  /** M-LAW-11 — see `Article.extractOrder`. */
  extractOrder?: number;
}

/** A segment that looked like an article but could not be resolved cleanly. */
export interface DroppedSegment {
  reason: string;
  /** Best guess at the article number, if the header was parseable. */
  numberGuess?: string;
  /** First ~120 chars of the surrounding text for triage. */
  snippet: string;
}

/** A typed known source gap: a handler anchor whose unit the capture
 *  never emitted as standalone text (truncated source, "Texto no
 *  disponible", or a transitorio folded inside another unit's body).
 *  Persisted in the strict `source_gap` table and copied through
 *  merge/adoption — app behavior must never depend on repository
 *  source constants. */
export interface SourceGap {
  readonly sourceUnitId: number;
  readonly reason: string;
  /** Document-order position of the consumed terminator line. */
  readonly docOrder: number;
  readonly caption: string;
}

/** Complete one-to-one reconciliation ledger (plan §5.3). */
export interface SourceLedgerEntry {
  readonly kind: "emitted-article" | "emitted-transitory" | "known-gap" | "reviewed-exclusion";
  readonly sourceUnitId: number;
  readonly domOrder: number;
  readonly caption: string;
  readonly reason?: string;
  readonly unitLabel?: string;
}

export interface ExtractedNorma {
  hierarchy: HierarchyNode[];
  articles: Article[];
  /**
   * M-LAW-10 — STANDALONE transitory provisions, in document order. The
   * extractor always emits the key (empty array when the payload carries
   * none); it is optional so hand-built fixtures and pre-M-LAW-10 callers
   * keep typechecking. Transitorios that sit INSIDE an article's body span
   * stay folded into that body — this list holds only the ones that would
   * otherwise be lost.
   */
  transitories?: TransitoryProvision[];
  frontMatter?: string;
  /** S-INI — persisted typed gaps for unconsumed source handlers. */
  sourceGaps?: SourceGap[];
  /** S-INI — complete handler reconciliation ledger for the build. */
  sourceLedger?: SourceLedgerEntry[];
  /** Human-readable notes about extraction anomalies. */
  warnings: string[];
  /** Segments that could not be resolved into a clean article. */
  dropped: DroppedSegment[];
}