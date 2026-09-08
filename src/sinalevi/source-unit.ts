/**
 * Positional SINALEVI source-unit reconciliation (production module).
 *
 * The reviewed source-route contract binds every emitted article /
 * standalone transitory / known-gap unit to the EXACT Ficha anchor
 * terminator consumed by segmentation — never a global caption map,
 * never a printed-number map (base and suffixed units reuse the same
 * printed number; transitorio captions reuse base integers; exact
 * caption collisions occur).
 *
 * The real SINALEVI handler grammar, verified against every anchor of
 * the 20 reviewed authorities, is:
 *
 *   handleArticuloClick(<baseNumberHint>, <ficha>, <version>, <idArticulo>)
 *
 * with four plain ASCII integer literals. The FIRST argument is only a
 * base-number hint (not an identity); the SECOND is the authority
 * ficha — which is `0` on 18 of the 20 reviewed authorities (a reviewed
 * template-context fact, never a treaty special case); the THIRD is the
 * captured version; the FOURTH is the addressable source-unit id used
 * as `param4` of the captured-unit route.
 *
 * Hard rules (each enforced by tests):
 *   - mandatory trusted `CaptureContext` — no anonymous extraction;
 *   - parse ONLY the complete onclick attribute of the exact Ficha
 *     anchor; never execute JavaScript; never regex script/body text;
 *   - handler version must equal the context version; a nonzero
 *     handler ficha must equal the context authority; ficha `0` is
 *     accepted only under a reviewed template contract that allows it;
 *   - safe-integer domains; `sourceUnitId` positive;
 *   - DOM order is preserved verbatim; one sourceUnitId maps to at
 *     most one classified unit;
 *   - every handler event is accounted for exactly once as emitted
 *     article, emitted standalone transitory, typed known gap, or
 *     reviewed exclusion with a stable reason.
 */
import type { HierarchyKind } from "./types.js";

export interface CaptureContext {
  readonly authorityId: number;
  readonly versionId: number;
  readonly templateId: string;
  readonly templateFingerprint: string;
}

/**
 * Template contract. Reviewed templates declare whether handler ficha
 * `0` is allowed; the zero-ficha form is a template/context fact shared
 * by domestic instruments and conventions alike.
 */
export interface TemplateContract {
  readonly templateId: string;
  readonly templateFingerprint: string;
  readonly allowsZeroFicha: boolean;
}

/**
 * The pure Ficha-anchor `onclick` grammar: exactly four plain ASCII
 * integer literals in the reviewed order. Any other shape — a fifth
 * argument, a wrapper rename, a signed/scientific/Unicode literal, a
 * trailing `return false` glued into the attribute, or anything that
 * does not constitute the ENTIRE attribute value — rejects to `null`.
 */
const HANDLE_REGEX =
  /^handleArticuloClick\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*;?\s*$/;

/**
 * S-INI — reserved extraction-only anchor provenance marker.
 *
 * The reserved character `\x1F` (ASCII Unit Separator) is illegal in
 * reviewed SINALEVI payloads and is never emitted by the source; the
 * extractor scans every parsed text node and attribute for it BEFORE
 * injecting any marker of its own, so a payload that already carries
 * the byte is a spoof and the candidate rejects. The marker is
 * deterministic and identifies the EXACT DOM anchor (not the caption
 * sequence and not the printed number), which is what lets two
 * handlers carrying the same caption bind to different tokens.
 */
export const ANCHOR_TOKEN_RESERVED_CHAR = "\x1F";
export const ANCHOR_TOKEN_PREFIX = "\x1FSINALEVI-ANCHOR-TOKEN:";
export const ANCHOR_TOKEN_SUFFIX = "\x1F";
/**
 * Canonical marker span: the reserved prefix, a positive canonical ASCII
 * integer payload (first digit 1-9, no leading zero, no sign/decimal/
 * exponent/Unicode digit), and the reserved suffix. This exact span is the
 * ONLY thing `stripAnchorMarkersFromLine` removes. Any other appearance of
 * the reserved character is malformed framing and rejects fail-closed.
 */
const ANCHOR_TOKEN_STRIP_REGEX =
  /\x1FSINALEVI-ANCHOR-TOKEN:[1-9][0-9]*\x1F/g;

/** Build a marker for one source unit. Deterministic, globally unique. */
export function anchorTokenForSourceUnit(sourceUnitId: number): string {
  return `${ANCHOR_TOKEN_PREFIX}${sourceUnitId}${ANCHOR_TOKEN_SUFFIX}`;
}

/** Strict token shape check (the whole string IS one marker). */
const ANCHOR_TOKEN_EXACT_REGEX = /^\x1FSINALEVI-ANCHOR-TOKEN:(\d+)\x1F$/;
export function sourceUnitIdForAnchorToken(token: string): number | null {
  const m = ANCHOR_TOKEN_EXACT_REGEX.exec(token);
  if (m === null) return null;
  const n = Number(m[1]);
  if (!isPositiveSafeInteger(n)) return null;
  return n;
}

/**
 * Extract every marker occurrence from a cleaned-text line. Returns the
 * list of source-unit ids (in left-to-right order) AND how many markers
 * were seen, so the extractor can reject one line carrying more than one.
 *
 * Fail-closed grammar: the reserved character is illegal in reviewed
 * source text and never survives the extractor's pre-injection scrub, so
 * EVERY reserved-character occurrence here must belong to a canonical
 * marker (`ANCHOR_TOKEN_PREFIX` + positive canonical ASCII integer +
 * `ANCHOR_TOKEN_SUFFIX`). A negative, signed, decimal, exponent, Unicode,
 * alphabetic, empty, leading-zero, or overflow payload, a missing prefix
 * or suffix, an extra reserved delimiter, or any other malformed framing
 * throws immediately — it is never silently skipped (which would erase a
 * spoof) nor miscounted as a clean line.
 */
export function extractAnchorTokensFromLine(
  line: string,
): { readonly sourceUnitIds: readonly number[]; readonly markerCount: number } {
  if (typeof line !== "string") {
    throw new Error("extract: malformed anchor marker — line is not a string");
  }
  // No reserved character at all: zero markers, nothing to fail on.
  if (!line.includes(ANCHOR_TOKEN_RESERVED_CHAR)) {
    return { sourceUnitIds: [], markerCount: 0 };
  }
  const sourceUnitIds: number[] = [];
  const length = line.length;
  let cursor = 0;
  while (cursor < length) {
    const at = line.indexOf(ANCHOR_TOKEN_RESERVED_CHAR, cursor);
    if (at === -1) break;
    // Every reserved character must OPEN a marker: a missing/garbled
    // prefix is malformed framing (also catches a bare reserved byte,
    // an extra leading delimiter, or a truncated prefix).
    if (!line.startsWith(ANCHOR_TOKEN_PREFIX, at)) {
      throw new Error(
        `extract: malformed anchor marker — reserved character at index ${at} does not begin a valid marker prefix`,
      );
    }
    let scan = at + ANCHOR_TOKEN_PREFIX.length;
    const digitsStart = scan;
    while (
      scan < length &&
      line.charCodeAt(scan) >= 48 /* '0' */ &&
      line.charCodeAt(scan) <= 57 /* '9' */
    ) {
      scan += 1;
    }
    const digits = line.slice(digitsStart, scan);
    // Empty or non-ASCII-digit payload catches alphabetic, signed
    // ('+5'/'-5'), decimal point, exponent, and Unicode digit bait.
    if (digits.length === 0) {
      throw new Error(
        `extract: malformed anchor marker — empty or non-ASCII-digit payload at index ${at}`,
      );
    }
    // Non-canonical payload (leading zero) is rejected so the token
    // maps back to exactly one sourceUnitId spelling.
    if (digits.length > 1 && digits.charCodeAt(0) === 48 /* '0' */) {
      throw new Error(
        `extract: malformed anchor marker — leading-zero payload "${digits}" at index ${at}`,
      );
    }
    // The digit run must be closed by the reserved suffix; anything else
    // (trailing text, another delimiter, end-of-line) is malformed.
    if (scan >= length || line[scan] !== ANCHOR_TOKEN_SUFFIX) {
      throw new Error(
        `extract: malformed anchor marker — payload "${digits}" is not terminated by the reserved suffix at index ${at}`,
      );
    }
    const whole = line.slice(at, scan + 1);
    const sourceUnitId = Number(digits);
    if (!isPositiveSafeInteger(sourceUnitId)) {
      throw new Error(
        `extract: malformed anchor marker "${whole}" (non-positive or unsafe integer)`,
      );
    }
    sourceUnitIds.push(sourceUnitId);
    cursor = scan + 1;
  }
  return { sourceUnitIds, markerCount: sourceUnitIds.length };
}

/**
 * Strip every anchor marker from a single cleaned-text line. Validates
 * the whole line first, so malformed reserved framing throws instead of
 * being silently erased or left behind; only canonical markers are then
 * removed, and a final guard proves no reserved byte survived.
 */
export function stripAnchorMarkersFromLine(line: string): string {
  extractAnchorTokensFromLine(line);
  const stripped = line.replace(ANCHOR_TOKEN_STRIP_REGEX, "");
  if (stripped.includes(ANCHOR_TOKEN_RESERVED_CHAR)) {
    // Defensive: `extractAnchorTokensFromLine` already rejects any
    // stray reserved byte, so this can only fire on a grammar drift.
    throw new Error(
      "extract: malformed anchor marker — reserved character survived stripping",
    );
  }
  return stripped;
}

/** One captured Ficha-anchor event from the DOM pre-strip pass. */
export interface FichaSourceEvent {
  /** Document order index — never shuffled, never sorted. */
  readonly domOrder: number;
  /**
   * Deterministic extraction-only anchor provenance token. Derived
   * from `sourceUnitId`, globally unique across split fragments, and
   * identifies the EXACT DOM anchor — not the caption sequence and
   * not the printed number. The extractor injects the marker into the
   * cleaned text at the exact line of the DOM anchor and strips it
   * before producing legal text; the reconciler binds each terminator
   * line to its event through this token.
   */
  readonly anchorToken: string;
  /** Normalized caption text (whitespace-collapsed, trimmed). */
  readonly caption: string;
  /** First argument: base-number hint only, never a join key. */
  readonly baseNumber: number;
  /** Second argument: handler ficha (`0` under reviewed templates). */
  readonly handlerFicha: number;
  /** Third argument: captured version — must equal context. */
  readonly handlerVersion: number;
  /** Fourth argument: the addressable SINALEVI article/unit id. */
  readonly sourceUnitId: number;
  /**
   * Distinguishes an article-kind Ficha ("Ficha Artículo N") from a
   * standalone transitorio Ficha ("Ficha Artículo N Transitorio").
   * Consumed by segmentation so an emitted article must bind an
   * article-kind terminator and an emitted standalone transitorio
   * must bind a transitorio-kind terminator — never the first
   * arbitrary later handled terminator.
   */
  readonly unitKind: "article" | "transitorio";
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isSafeInteger(value) && value > 0;
}

/** Whitespace normalization shared by DOM captions and text lines. */
export function normalizeFichaCaption(caption: string): string {
  return caption.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Pure parser for one Ficha anchor `onclick` attribute. The caller must
 * pass the ENTIRE attribute value; the parser never searches inside a
 * larger string, so JavaScript execution and script/body-text regex
 * bait cannot produce events. Returns `null` on any malformed input.
 */
export function parseFichaHandler(
  domOrder: number,
  caption: string,
  onclick: string,
): FichaSourceEvent | null {
  if (typeof onclick !== "string" || typeof caption !== "string") return null;
  const match = HANDLE_REGEX.exec(onclick);
  if (match === null) return null;
  const baseNumber = Number(match[1]);
  const ficha = Number(match[2]);
  const version = Number(match[3]);
  const sourceUnitId = Number(match[4]);
  if (!isNonNegativeSafeInteger(baseNumber)) return null;
  if (!isNonNegativeSafeInteger(ficha)) return null;
  if (!isPositiveSafeInteger(version)) return null;
  if (!isPositiveSafeInteger(sourceUnitId)) return null;
  const normalized = normalizeFichaCaption(caption);
  if (normalized.length === 0) return null;
  return {
    domOrder,
    anchorToken: anchorTokenForSourceUnit(sourceUnitId),
    caption: normalized,
    baseNumber,
    handlerFicha: ficha,
    handlerVersion: version,
    sourceUnitId,
    unitKind: /TRANSITORIO$/i.test(normalized) ? "transitorio" : "article",
  };
}

/**
 * Context validation of one parsed event (plan §5.1): handler version
 * must equal the context version; ficha `0` is valid only when the
 * reviewed template contract allows it; a nonzero ficha must equal the
 * context authority id. Returns a stable reason or `null` when valid.
 */
export function validateEventContext(
  event: FichaSourceEvent,
  context: CaptureContext,
  template: TemplateContract,
): string | null {
  if (event.handlerVersion !== context.versionId) {
    return "handler-version-mismatch";
  }
  if (event.handlerFicha === 0) {
    if (!template.allowsZeroFicha) return "handler-ficha-zero-not-allowed";
    return null;
  }
  if (event.handlerFicha !== context.authorityId) {
    return "handler-ficha-authority-mismatch";
  }
  return null;
}

/** One classification entry of the complete one-to-one ledger. */
export type Reconciliation =
  | {
      readonly kind: "emitted-article";
      readonly event: FichaSourceEvent;
      readonly unitLabel: string;
    }
  | {
      readonly kind: "emitted-transitory";
      readonly event: FichaSourceEvent;
      readonly unitLabel: string;
    }
  | {
      readonly kind: "known-gap";
      readonly event: FichaSourceEvent;
      readonly reason: string;
    }
  | {
      readonly kind: "reviewed-exclusion";
      readonly event: FichaSourceEvent;
      readonly reason: string;
    };

/** Emitted unit offered to the reconciler for binding. */
export interface EmittedUnitBinding {
  readonly event: FichaSourceEvent;
  readonly kind: "emitted-article" | "emitted-transitory";
  readonly unitLabel: string;
}

/**
 * Reviewed template ids; the extractor accepts only these. Zero-ficha
 * templates are reviewed domestic AND treaty contexts alike (18 of the
 * 20 shipped authorities print handler ficha `0`).
 */
export const REVIEWED_TEMPLATES: ReadonlySet<string> = new Set([
  "sinalevi-word-export",
  "sinalevi-treaty-export",
]);

/** The CLOSED classification values the `classify` callback may ever
 *  return. A `known-gap` carries exactly `source-text-unavailable`; a
 *  `reviewed-exclusion` carries exactly one of the two audited notice
 *  reasons. Any other pair — even one with a nonempty, plausible
 *  reason string — fails the callback-shape gate immediately, so a
 *  bug in a caller-supplied classifier can never silently invent a
 *  new ledger reason. */
export const CLASSIFY_APPROVED_PAIRS: ReadonlySet<string> = new Set<string>([
  "known-gap\u0000source-text-unavailable",
  "reviewed-exclusion\u0000source-elimination-notice",
  "reviewed-exclusion\u0000source-renumber-redirect-notice",
]);

function classifyPairKey(kind: string, reason: string): string {
  return `${kind}\u0000${reason}`;
}

/** Optional post-prevalidation callback that classifies an unbound
 *  event into `known-gap` / `reviewed-exclusion` with a stable reason,
 *  or returns `null` to fall back to the existing `gapReason`
 *  behavior. The callback runs ONLY for unbound events, ONLY AFTER
 *  complete event-array prevalidation and binding integrity, and
 *  receives the event plus the positionally-built source-line array
 *  the caller closes over (the reconciler never inspects the array —
 *  pure content is opaque to it). The returned classification is
 *  closed: only the exact (kind, reason) pairs in
 *  {@link CLASSIFY_APPROVED_PAIRS} are accepted — an unknown kind, an
 *  empty/non-string reason, or any other pairing of an otherwise
 *  valid reason with an otherwise valid kind fails the callback-shape
 *  gate immediately, even when the reason is nonempty. The legacy
 *  `gapReason` fallback stays open (generic reconciliations keep
 *  their existing reason taxonomy). */
export type ClassifyUnboundEvent = (
  event: FichaSourceEvent,
  sourceLines: readonly string[],
) => { readonly kind: "known-gap" | "reviewed-exclusion"; readonly reason: string } | null;

/**
 * Reconcile a complete ordered event sequence into a one-to-one
 * ledger. The caller (extractor) supplies:
 *   - `events`: every parsed Ficha event in DOM order;
 *   - `bindings`: every event that segmentation CONSUMED as the exact
 *     terminator of an emitted article or standalone transitorio;
 *   - `sourceLinesFor`: a pure accessor that returns the positionally
 *     built source-line array for one event (the reconciler calls it
 *     once per unbound event that reaches the classifier; the array
 *     is opaque to the reconciler and forwarded verbatim);
 *   - `gapReason` (optional): existing fallback reason callback for
 *     unbound events the classifier did NOT cover;
 *   - `classify` (optional): post-prevalidation classifier that may
 *     return ONLY a closed classification: `known-gap` with reason
 *     `source-text-unavailable`, `reviewed-exclusion` with reason
 *     `source-elimination-notice` or `source-renumber-redirect-notice`,
 *     or `null` to fall back to `gapReason`. Any other kind/reason
 *     pairing — even a nonempty one — throws at the callback-shape
 *     gate.
 *
 * Every event must appear in `bindings` at most once (positional
 * consumption already guarantees this; the reconciler re-proves it) and
 * unbound events become typed known gaps when the event passed the
 * context gate. Any context-invalid event, duplicate use, dropped
 * event, ID swap (same event object bound twice or two bindings for
 * one event), or inverse collision (a bound event absent from the
 * sequence) throws a content-free contract error; candidates with an
 * incomplete ledger never reach DB publication.
 */
export function reconcileSourceUnits(input: {
  context: CaptureContext;
  template: TemplateContract;
  events: readonly FichaSourceEvent[];
  bindings: readonly EmittedUnitBinding[];
  sourceLinesFor?: (event: FichaSourceEvent) => readonly string[];
  gapReason?: (event: FichaSourceEvent) => string;
  classify?: ClassifyUnboundEvent;
}): readonly Reconciliation[] {
  const { context, template } = input;
  if (!REVIEWED_TEMPLATES.has(template.templateId)) {
    throw new Error("reconcileSourceUnits: unreviewed template");
  }
  if (template.templateFingerprint.length === 0) {
    throw new Error("reconcileSourceUnits: empty template fingerprint");
  }
  if (context.templateId !== template.templateId) {
    throw new Error("reconcileSourceUnits: context/template mismatch");
  }
  if (context.templateFingerprint !== template.templateFingerprint) {
    throw new Error("reconcileSourceUnits: template fingerprint mismatch");
  }
  if (
    !isPositiveSafeInteger(context.authorityId) ||
    !isPositiveSafeInteger(context.versionId)
  ) {
    throw new Error("reconcileSourceUnits: invalid capture context ids");
  }
  // S-INI — complete prevalidation. Before ANY binding classification
  // or `gapReason` callback fires, the ENTIRE event array is validated:
  //   1. domOrder is contiguous and equals the array index (0..N-1);
  //   2. every sourceUnitId is a positive safe integer and is unique;
  //   3. every anchorToken corresponds EXACTLY to its sourceUnitId;
  //   4. every event has a valid unitKind / non-empty caption, and
  //   5. every event passes the trusted CaptureContext/template gate.
  // Any later duplicate id, displaced token, or context failure must
  // therefore throw here rather than let an EARLIER unbound event run
  // caller-supplied `gapReason` code on a partially-validated ledger.
  const byDomOrder = new Map<number, FichaSourceEvent>();
  const seenSourceUnitIds = new Set<number>();
  for (let i = 0; i < input.events.length; i += 1) {
    const ev = input.events[i]!;
    if (ev.domOrder !== i) {
      throw new Error(
        `reconcileSourceUnits: non-contiguous or reordered domOrder at array index ${i} (got ${ev.domOrder})`,
      );
    }
    if (byDomOrder.has(ev.domOrder)) {
      throw new Error("reconcileSourceUnits: duplicate dom order");
    }
    byDomOrder.set(ev.domOrder, ev);
    if (!isPositiveSafeInteger(ev.sourceUnitId)) {
      throw new Error(
        `reconcileSourceUnits: non-positive or unsafe sourceUnitId at domOrder ${ev.domOrder}`,
      );
    }
    if (seenSourceUnitIds.has(ev.sourceUnitId)) {
      throw new Error("reconcileSourceUnits: sourceUnitId reuse");
    }
    seenSourceUnitIds.add(ev.sourceUnitId);
    if (ev.anchorToken !== anchorTokenForSourceUnit(ev.sourceUnitId)) {
      throw new Error(
        `reconcileSourceUnits: anchor token does not correspond to sourceUnitId at domOrder ${ev.domOrder}`,
      );
    }
    if (ev.unitKind !== "article" && ev.unitKind !== "transitorio") {
      throw new Error(
        `reconcileSourceUnits: invalid unitKind at domOrder ${ev.domOrder}`,
      );
    }
    if (
      typeof ev.caption !== "string" ||
      normalizeFichaCaption(ev.caption).length === 0
    ) {
      throw new Error(
        `reconcileSourceUnits: invalid caption at domOrder ${ev.domOrder}`,
      );
    }
    const contextFailure = validateEventContext(ev, context, template);
    if (contextFailure !== null) {
      throw new Error(`reconcileSourceUnits: ${contextFailure}`);
    }
  }
  // Binding integrity — preserved AFTER prevalidation: foreign injection
  // (a bound event absent from the sequence) and duplicate use of one
  // event still reject fail-closed before any classification.
  const boundByDomOrder = new Map<number, EmittedUnitBinding>();
  for (const binding of input.bindings) {
    const ev = byDomOrder.get(binding.event.domOrder);
    if (ev === undefined || ev !== binding.event) {
      // Inverse collision: a bound event that is not part of the
      // emitted sequence (swap or foreign injection).
      throw new Error("reconcileSourceUnits: bound event not in sequence");
    }
    if (boundByDomOrder.has(ev.domOrder)) {
      throw new Error("reconcileSourceUnits: duplicate event use");
    }
    boundByDomOrder.set(ev.domOrder, binding);
  }
  // Classification — every event is fully validated and accounted for
  // exactly once; only here may the caller `classify` / `gapReason`
  // callbacks run (complete event-array prevalidation AND binding
  // integrity are already proven above, so neither callback can fire
  // on a partially-validated ledger). The post-prevalidation
  // classifier (when supplied) runs first; a `null` return falls back
  // to `gapReason` exactly as before, preserving unaffected authority
  // behavior. The callback shape is fail-closed and CLOSED-VALUED: a
  // non-`known-gap`/`reviewed-exclusion` kind, an empty/non-string
  // reason, or any (kind, reason) pairing outside
  // {@link CLASSIFY_APPROVED_PAIRS} throws before the ledger is
  // finalized — even when the reason is nonempty.
  const out: Reconciliation[] = [];
  for (const ev of input.events) {
    const binding = boundByDomOrder.get(ev.domOrder);
    if (binding !== undefined) {
      out.push({
        kind: binding.kind,
        event: ev,
        unitLabel: binding.unitLabel,
      });
      continue;
    }
    let resolved:
      | { readonly kind: "known-gap" | "reviewed-exclusion"; readonly reason: string }
      | null = null;
    if (input.classify) {
      const lines = input.sourceLinesFor
        ? input.sourceLinesFor(ev)
        : [];
      const result = input.classify(ev, lines);
      if (result !== null) {
        if (
          result.kind !== "known-gap" &&
          result.kind !== "reviewed-exclusion"
        ) {
          throw new Error(
            `reconcileSourceUnits: classify returned unknown kind ${String(result.kind)} for sourceUnitId ${ev.sourceUnitId}`,
          );
        }
        if (typeof result.reason !== "string" || result.reason.length === 0) {
          throw new Error(
            `reconcileSourceUnits: classify returned empty/unknown reason for sourceUnitId ${ev.sourceUnitId}`,
          );
        }
        if (!CLASSIFY_APPROVED_PAIRS.has(classifyPairKey(result.kind, result.reason))) {
          throw new Error(
            `reconcileSourceUnits: classify returned unapproved kind/reason pair ${result.kind} + ${result.reason} for sourceUnitId ${ev.sourceUnitId}`,
          );
        }
        resolved = result;
      }
    }
    if (resolved !== null) {
      out.push({ kind: resolved.kind, event: ev, reason: resolved.reason });
      continue;
    }
    out.push({
      kind: "known-gap",
      event: ev,
      reason: input.gapReason
        ? input.gapReason(ev)
        : "terminator-not-consumed-by-any-emitted-unit",
    });
  }
  return out;
}

/**
 * Completeness assertion: the ledger covers every event exactly once,
 * emitted-article sourceUnitIds are unique, and no emitted unit lacks
 * a bound event. Returns `null` on success or a stable failure reason.
 */
export function assertReconciliationComplete(
  events: readonly FichaSourceEvent[],
  ledger: readonly Reconciliation[],
): string | null {
  if (events.length !== ledger.length) {
    return "ledger length mismatch";
  }
  const seen = new Set<number>();
  for (const entry of ledger) {
    if (seen.has(entry.event.domOrder)) {
      return "event used more than once";
    }
    seen.add(entry.event.domOrder);
  }
  for (let index = 0; index < events.length; index += 1) {
    if (ledger[index]!.event !== events[index]) {
      return "ledger order mismatch";
    }
  }
  const emittedIds = new Set<number>();
  for (const entry of ledger) {
    if (entry.kind === "emitted-article" || entry.kind === "emitted-transitory") {
      if (emittedIds.has(entry.event.sourceUnitId)) {
        return "duplicate sourceUnitId in emitted units";
      }
      emittedIds.add(entry.event.sourceUnitId);
    }
  }
  return null;
}

/**
 * Strict integer parsing used by source-action URL builders. Returns
 * `null` on any non-positive-safe-integer input. The renderer must
 * reject signed, scientific, Unicode, or overflow numbers here.
 */
export function asSourceUnitId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!isPositiveSafeInteger(n)) return null;
  return n;
}

/** Ledger summary for a whole authority — consumed by the builder. */
export interface SourceLedgerSummary {
  readonly totalEvents: number;
  readonly emittedArticles: number;
  readonly emittedTransitories: number;
  readonly knownGaps: number;
  readonly reviewedExclusions: number;
}

export function summarizeLedger(
  ledger: readonly Reconciliation[],
): SourceLedgerSummary {
  const summary = {
    totalEvents: ledger.length,
    emittedArticles: 0,
    emittedTransitories: 0,
    knownGaps: 0,
    reviewedExclusions: 0,
  };
  for (const entry of ledger) {
    if (entry.kind === "emitted-article") summary.emittedArticles += 1;
    else if (entry.kind === "emitted-transitory") summary.emittedTransitories += 1;
    else if (entry.kind === "known-gap") summary.knownGaps += 1;
    else summary.reviewedExclusions += 1;
  }
  return Object.freeze(summary);
}

export type { HierarchyKind };

/**
 * Reviewed-catalog cross-check (plan §5.3): the generated manifest may
 * never attest its own completeness, so the builder compares the
 * measured ledger against the independently reviewed expectation. The
 * expectation is an ordered list of (sourceUnitId, kind) — swapped ids,
 * dropped handlers, added handlers, reordered units, or reclassified
 * kinds all fail, even if every per-unit count still matches.
 */
export interface ExpectedLedgerEntry {
  readonly sourceUnitId: number;
  readonly kind: Reconciliation["kind"];
}

export function assertLedgerMatchesExpected(
  ledger: readonly Reconciliation[],
  expected: readonly ExpectedLedgerEntry[],
): string | null {
  if (ledger.length !== expected.length) {
    return "expected-ledger length mismatch";
  }
  for (let i = 0; i < ledger.length; i++) {
    const entry = ledger[i]!;
    const want = expected[i]!;
    if (entry.event.sourceUnitId !== want.sourceUnitId) {
      return `expected-ledger id swap or drift at ordinal ${i}`;
    }
    if (entry.kind !== want.kind) {
      return `expected-ledger classification drift at ordinal ${i}`;
    }
  }
  return null;
}
