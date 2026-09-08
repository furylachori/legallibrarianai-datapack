import { getDOMParser } from "./dom-shim.js";
import { sinaleviWordRules, type Rules, type StripRule } from "./rules.js";
import {
  ANCHOR_TOKEN_RESERVED_CHAR,
  extractAnchorTokensFromLine,
  normalizeFichaCaption,
  parseFichaHandler,
  reconcileSourceUnits,
  assertReconciliationComplete,
  stripAnchorMarkersFromLine,
  type CaptureContext,
  type EmittedUnitBinding,
  type FichaSourceEvent,
  type TemplateContract,
} from "./source-unit.js";
import {
  createReviewedSourceClassifier,
  type ReviewedSourceClassifier,
} from "../cite/reviewed-penal-source-classifications.js";
import type {
  Article,
  DroppedSegment,
  ExtractedNorma,
  SourceGap,
  SourceLedgerEntry,
  HierarchyKind,
  HierarchyNode,
  TransitoryProvision,
} from "./types.js";

/**
 * S-INI — the extended Ficha-caption grammar. The strict
 * `rules.fichaTerminator` remains the ONLY segmentation boundary (the
 * shipped article spans must not move); this extended form additionally
 * recognizes the "Ficha Artículo N Transitorio" terminators that bind
 * standalone and folded transitorio units in the source ledger. The
 * suffix slot keeps the CLOSED `BIS|TER|QUÁTER` adoption grammar — no
 * QUINQUIES caption was ever observed (the audited CT 376 quinquies
 * Ficha is the base-only `Ficha Artículo 376`).
 */
const EXTENDED_FICHA_LINE =
  /^[ \t]*Ficha[ \t]+Art[IÍií]culo[ \t]+(\d+)(?:[ \t]+(BIS|TER|QU[AÁ]TER))?(?:[ \t]+TRANSITORIO)?[ \t]*$/i;

/** Reviewed template families. BOTH reviewed families legitimately use
 *  handler ficha `0` in the real corpus (18 of the 20 shipped
 *  authorities), so zero is a reviewed template-context fact, never a
 *  treaty special case. The fingerprint itself always comes from the
 *  trusted context — this table never supplies one. */
const REVIEWED_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  "sinalevi-word-export",
  "sinalevi-treaty-export",
]);

/**
 * Immutable narrow capture-context subset consumed by the bounded
 * `quinquies` header-admission gate in `segmentWithSpans`. It is built
 * from the ALREADY-VALIDATED `CaptureContext` in `extract()` (missing or
 * malformed contexts fail the mandatory validation there before this
 * subset is ever constructed).
 */
interface HeaderAdmissionContext {
  readonly authorityId: number;
  readonly versionId: number;
  readonly templateId: string;
}

/**
 * The ONLY capture context in which a `quinquies` article-header event is
 * admitted: the already-trusted exact SINALEVI Word capture of the
 * Código de Trabajo (authority 8045 / version 150791 / template
 * `sinalevi-word-export`) that carries the audited `Artículo 376
 * quinquies-` header (source unit 205531). The header grammar RECOGNIZES
 * the suffix globally so canonical normalization stays uniform, but
 * EMISSION is bounded to this context: in every other capture — Penal
 * 5027/151473 included — the line remains ordinary source text and its
 * Ficha remains an accounted generic gap. Penal header recovery for
 * `quinquies` (and `sexies`/`septies`) is admitted through the separate
 * Penal provisional seam below, gated by the trusted Penal context
 * (5027/151473/`sinalevi-word-export`).
 */
const CT_QUINQUIES_ADMISSION: HeaderAdmissionContext = Object.freeze({
  authorityId: 8045,
  versionId: 150791,
  templateId: "sinalevi-word-export",
});

/** The ONLY capture context in which the Penal provisional recovery
 *  seam admits a `quinquies|sexies|septies` article-header event: the
 *  already-trusted exact SINALEVI Word capture of the Código Penal
 *  (authority 5027 / version 151473 / template `sinalevi-word-export`).
 *  The seam recognizes two Penal-only candidate shapes (the standard
 *  legal separators for spaced `quinquies|sexies|septies` headers, and
 *  exceptional `: ` / punctuation-free whitespace headers carrying any
 *  canonical base/suffix token) and gates each candidate on a
 *  structural-ownership proof against the first subsequent handled
 *  article-kind Ficha. Outside this context the seam is dead — every
 *  candidate line stays ordinary source text and its Ficha stays an
 *  accounted generic gap. The gate reads ONLY the validated capture
 *  context — never source-unit ids, never body text. */
const PENAL_PROVISIONAL_ADMISSION: HeaderAdmissionContext = Object.freeze({
  authorityId: 5027,
  versionId: 151473,
  templateId: "sinalevi-word-export",
});

/** Normalized article-number shape that carries the `quinquies` suffix.
 *  `normalizeNumber` canonicalizes the accepted suffix token to
 *  `{base} {suffix}`, so any admitted `quinquies` header ends in this
 *  exact suffix slot. */
const QUINQUIES_NUMBER_RE = /[ \t]quinquies$/i;

/** Normalized article-number shape that carries the audited Penal-only
 *  `sexies` suffix. The same single-suffix normalization shape that
 *  `quinquies` uses — `{base} sexies` ends in `[ \t]sexies`. */
const SEXIES_NUMBER_RE = /[ \t]sexies$/i;

/** Normalized article-number shape that carries the audited Penal-only
 *  `septies` suffix. The same single-suffix normalization shape that
 *  `quinquies` uses — `{base} septies` ends in `[ \t]septies`. */
const SEPTIES_NUMBER_RE = /[ \t]septies$/i;

/** Penal-seam suffix fragment for the canonical `quater` family.
 *  Recognizes plain `quater`, composed `qu\u00E1ter` (U+00E1), and
 *  decomposed `qua\u0301ter` (U+0061 + U+0301) under the existing
 *  case-insensitive Unicode discipline. Private to the Penal recovery
 *  seam — the global Word and treaty `articleHeader` grammars are
 *  deliberately NOT widened to admit the decomposed form (decomposed
 *  input hits the seam first, where the bail-out rejects the glued
 *  malformed case and the canonical composed form is what gets
 *  normalized). Composed at construction time into `new RegExp()`
 *  sources so the engine treats the alternation as one atomic
 *  suffix alternative; not exported. */
const PENAL_QUATER_ALT = "qu(?:a\\u0301|\\u00E1|a)ter";

/** Penal-only shape 1 — line-start `Articulo <base> <quinquies|sexies|septies>`
 *  followed by the standard legal separator (`.-`, `-`, `.—`, `—`,
 *  `. `, or the historical period-immediate-letter variant). The suffix
 *  list is CLOSED: `bis`/`ter`/`quáter` are already covered by the global
 *  `articleHeader` grammar, so the recovery seam only needs to add the
 *  three audited Penal suffixes. The marker word accepts the same
 *  accent/case permutations and zero-or-more internal whitespace as the
 *  global grammar. Captures group 1 = the full number token including
 *  zero-or-more internal whitespace between base and suffix (the
 *  canonical `normalizeNumber` collapses it to `{base} {suffix}`).
 *  Gated only by `PENAL_PROVISIONAL_ADMISSION` in `segmentWithSpans`. */
const PENAL_RECOVERY_SHAPE_1_RE = new RegExp(
  "^[ \\t]*A[ \\t]*R[ \\t]*T[IÍií]CULOS?" +
    "(?:[ \\t]+|(?:\\.[ \\t]*)?)" +
    "(\\d+(?:[ \\t]+(?:quinquies|sexies|septies)))" +
    "(?:[ \\t]*\\.?[ \\t]*[-—][ \\t]*|[ \\t]*\\.[ \\t]+|[ \\t]*\\.(?=[0-9A-Za-z\\xC0-\\xD6\\xD8-\\xF6\\xF8-\\xFF]))",
  "i",
);

/** Penal-only shape 2 — line-start `Articulo <base> [<suffix>]`
 *  followed by a separator — either punctuation-free horizontal
 *  whitespace `[ \t\u00A0]+` OR the colon form `[ \t\u00A0]*:[ \t\u00A0]*`
 *  (any leading/trailing whitespace around `:`) — and then a nonempty
 *  body tail whose FIRST code point is a true Unicode letter (any case)
 *  or a decimal digit. The suffix slot accepts the closed canonical set
 *  `bis|ter|quáter|quinquies|sexies|septies` OR an absent suffix (a
 *  bare decimal base like `339`). Captures group 1 = the full number
 *  token (canonical `normalizeNumber` collapses it to either `base` or
 *  `base suffix`). The body-tail lookahead (`(?=\p{L}|\p{N})`) is the
 *  prose guard: a separator that is followed by punctuation or end of
 *  line does NOT match — `Articulo 339.` with no body or `Articulo 339`
 *  with no body both reject because neither letter nor digit follows.
 *  The separator alternation is EXACT:
 *    - colon branch `[ \t\u00A0]*:[ \t\u00A0]*` requires the literal
 *      `:` and absorbs any surrounding whitespace (SINALEVI inserts
 *      one space between `ter` and `:` because of the inline-span
 *      glue in the source — the cleaned line is `Articulo 257 ter :
 *      Se impondra` and the engine must consume the space+colon+space
 *      as one separator, NOT split it as suffix-separator then body);
 *    - whitespace branch `[ \t\u00A0]+` matches pure whitespace
 *      between the canonical token and the body;
 *    - the colon branch is POSITIONED FIRST in the alternation so the
 *      engine prefers it whenever a `:` is present — backtracking out
 *      of the suffix group and re-attaching its `[ \t]+` to the
 *      separator would leave `ter :` or `bis ` in the body tail and
 *      is exactly the failure mode the colon-first alternation
 *      prevents.
 *  The `quater` family of the suffix slot uses the shared `PENAL_QUATER_ALT`
 *  fragment so plain `quater`, composed `qu\u00E1ter`, and decomposed
 *  `qua\u0301ter` are all captured as one atomic alternative and the
 *  canonical-composed normalization runs uniformly downstream.
 *  Gated only by `PENAL_PROVISIONAL_ADMISSION`. */
const PENAL_RECOVERY_SHAPE_2_RE = new RegExp(
  "^[ \\t]*A[ \\t]*R[ \\t]*T[IÍií]CULOS?" +
    "(?:[ \\t]+|(?:\\.[ \\t]*)?)" +
    "(\\d+(?:[ \\t]+(?:bis|ter|" + PENAL_QUATER_ALT + "|quinquies|sexies|septies))?)" +
    "(?:[ \\t\\u00A0]*:[ \\t\\u00A0]*|[ \\t\\u00A0]+)" +
    "(?=\\p{L}|\\p{N})",
  "iu",
);

function admitsQuinquiesHeader(context: HeaderAdmissionContext): boolean {
  return (
    context.authorityId === CT_QUINQUIES_ADMISSION.authorityId &&
    context.versionId === CT_QUINQUIES_ADMISSION.versionId &&
    context.templateId === CT_QUINQUIES_ADMISSION.templateId
  );
}

function admitsPenalProvisionalHeader(context: HeaderAdmissionContext): boolean {
  return (
    context.authorityId === PENAL_PROVISIONAL_ADMISSION.authorityId &&
    context.versionId === PENAL_PROVISIONAL_ADMISSION.versionId &&
    context.templateId === PENAL_PROVISIONAL_ADMISSION.templateId
  );
}

/**
 * An extracted article plus its REVIEWED SOURCE URL (M-LAW-07).
 *
 * `fichaRef` is a LABEL ("Ficha Artículo 85 BIS") — SINALEVI's own caption
 * for the amendment/ficha block that terminates an article. A label is not
 * something a reader can open, so the two are kept as SEPARATE fields:
 * `sourceUrl` is the usable absolute http(s) URL taken from the payload's
 * own ficha link, and is absent whenever the payload carries none (its
 * links are `javascript:void(0)` handlers in the shipped corpus). The
 * extractor never invents a URL — absence is the honest answer.
 */
export interface ExtractedArticle extends Article {
  sourceUrl?: string;
}

/** `ExtractedNorma` whose articles may carry a reviewed source URL. */
export type ExtractedNormaWithSources = Omit<ExtractedNorma, "articles"> & {
  articles: ExtractedArticle[];
};

/**
 * Pure structural extractor for SINALEVI's MS-Word-export HTML payload.
 *
 * 1. Normalize the raw HTML through DOMParser to remove MS-Word bloat
 *    (style blocks, head, o:* / zz / st* / U* namespace junk), collecting
 *    the reviewed URL of every Ficha link the payload actually exposes.
 * 2. Walk the cleaned stream line-by-line, tracking current TÍTULO and
 *    CAPÍTULO. On an article header, capture body up to the next
 *    "Ficha Artículo N" terminator (kept as a separate field).
 * 3. Anything before the first article header is `frontMatter`.
 * 4. M-LAW-10: a transitorio header OUTSIDE every article's body span
 *    becomes an addressable `transitories[]` record instead of being lost.
 *    M-LAW-11: every emitted hierarchy node, article and transitorio
 *    carries `extractOrder`, the line it was found on — one coordinate
 *    space the persistence layer sorts mixed children by.
 *
 * The extractor has no network, fs, or global side-effects. It is
 * portable across browser/Tauri webview (native DOMParser) and Node
 * (linkedom polyfill, see dom-shim.ts).
 */
export function extract(
  rawHtml: string,
  rules: Rules = sinaleviWordRules,
  context: CaptureContext = EXTRACT_NO_CONTEXT,
): ExtractedNormaWithSources {
  if (
    context === null ||
    typeof context !== "object" ||
    !Number.isSafeInteger(context.authorityId) ||
    context.authorityId <= 0 ||
    !Number.isSafeInteger(context.versionId) ||
    context.versionId <= 0 ||
    typeof context.templateId !== "string" ||
    typeof context.templateFingerprint !== "string" ||
    context.templateFingerprint.length === 0
  ) {
    throw new Error(
      "extract: a trusted, fully validated CaptureContext is mandatory (authority/version ids, reviewed template id, and non-empty template fingerprint)",
    );
  }
  if (!REVIEWED_TEMPLATE_IDS.has(context.templateId)) {
    throw new Error("extract: unreviewed capture template");
  }
  // S-INI — the reserved anchor marker is only ever produced by the
  // extractor itself (injected into a Ficha anchor's text content as
  // the FIRST child, after the parsed-DOM reserved-character scan
  // below has cleared the document). The REAL invariant the extractor
  // MUST defend is therefore: no source TEXT NODE that can reach
  // cleaned marker resolution may already carry the reserved byte
  // (literal or entity-decoded) before injection. The scan that
  // enforces this is the parsed-DOM text-node check in
  // `assertNoReservedMarkerCharsInText`, called from `cleanFragment`
  // BEFORE the strip pass and BEFORE any marker is injected.
  //
  // We deliberately do NOT scan the entire raw payload or every DOM
  // attribute value: the reserved byte is INERT in arbitrary DOM
  // attributes (e.g. legacy Word `st1:PersonName ProductID`,
  // `xmlns:*`, `class`, `style`, …) because those attributes never
  // reach `domToText` and therefore never reach marker resolution.
  // Real SINALEVI captures routinely carry such inert attributes
  // (the LJC capture, e.g., has two `&#31;` values inside one
  // ~119 KB legacy Word `st1:PersonName ProductID` attribute) and a
  // global scan would reject legitimate captures as spoofs.
  const template: TemplateContract = {
    templateId: context.templateId,
    templateFingerprint: context.templateFingerprint,
    allowsZeroFicha: true,
  };
  // The mandatory validation above guarantees a trusted context; this
  // frozen narrow subset is all the bounded quinquies header-admission
  // gate in `segmentWithSpans` is allowed to see.
  const headerAdmission: HeaderAdmissionContext = Object.freeze({
    authorityId: context.authorityId,
    versionId: context.versionId,
    templateId: context.templateId,
  });
  const { lines, sourceUrls, sourceEvents, lineToEvent } = normalize(rawHtml, rules);
  const segmented = segmentWithSpans(lines, rules, sourceUrls, lineToEvent, headerAdmission);
  return bindSourceUnits(segmented, sourceEvents, {
    ...context,
    template,
  });
}

/** Sentinel only so a zero-arg TS escape fails at runtime; the real
 *  requirement is enforced by the guard above. */
const EXTRACT_NO_CONTEXT: CaptureContext = {
  authorityId: 0,
  versionId: 0,
  templateId: "",
  templateFingerprint: "",
};

/**
 * Strip the HTML document-structure tags (`<html>`, `<head>`, `<body>` and
 * their closes) from a piece of raw input. We do this BEFORE re-wrapping
 * the piece in our own `<html><body>` for parsing.
 *
 * Why: SINALEVI's payload is malformed at the seams — a fragment's body
 * ends with `</body></html>` and is immediately followed by the next
 * fragment's `<div class="...enlaceFicha">...Ficha Artículo N...</div>`.
 * linkedom's parser stops at `</html>`, so the trailing Ficha div is
 * silently dropped. Stripping structure tags up front prevents that.
 */
function stripHtmlStructure(s: string): string {
  return s
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, "");
}

/**
 * Split the raw SINALEVI payload into a sequence of processable pieces.
 *
 * The payload is a sequence of mini `<html>…</html>` documents concatenated
 * together. There is also (a) a leading "preamble" carrying the body of the
 * first article when the prior fragment was truncated, and (b) "gap" text
 * between fragments that carries the `Ficha Artículo N` divs and other
 * metadata blocks. We keep ALL of these — preamble, gaps, and fragments —
 * so the relationship between article body and its Ficha terminator is
 * preserved in the concatenated cleaned stream.
 */
function splitFragments(raw: string, rules: Rules): string[] {
  const matches = Array.from(raw.matchAll(rules.fragmentBoundary));
  if (matches.length === 0) return [stripHtmlStructure(raw)];

  const pieces: string[] = [];
  let cursor = 0;
  for (const m of matches) {
    const gap = raw.slice(cursor, m.index);
    if (gap.replace(/\s+/g, "").length > 0) {
      pieces.push(stripHtmlStructure(gap));
    }
    pieces.push(stripHtmlStructure(m[0]));
    cursor = m.index! + m[0].length;
  }
  const tail = raw.slice(cursor);
  if (tail.replace(/\s+/g, "").length > 0) {
    pieces.push(stripHtmlStructure(tail));
  }
  return pieces;
}

function cleanFragment(
  fragment: string,
  rules: Rules,
): { text: string; sourceUrls: Map<string, string>; fichaEvents: FichaSourceEvent[] } {
  const wrapped = /<html[\s>]/i.test(fragment)
    ? fragment
    : `<!doctype html><html><head></head><body>${fragment}</body></html>`;

  const doc = new (getDOMParser())().parseFromString(wrapped, "text/html");

  // S-INI — reserved-marker spoof check: scan every parsed-DOM text
  // node for the reserved character BEFORE the extractor ever injects
  // its own marker. Real SINALEVI payloads never emit the byte in any
  // source text capable of reaching cleaned marker resolution; a
  // candidate that already carries it is either malicious or
  // off-template and must reject to neutralise marker spoofing.
  //
  // We intentionally do NOT scan attribute values: arbitrary DOM
  // attributes (e.g. legacy Word `st1:PersonName ProductID`, `xmlns`,
  // `class`, `style`, `onclick` payload outside the Ficha
  // terminators, …) never reach `domToText` and therefore never reach
  // marker resolution. Scanning them would produce false-positive
  // rejections on legitimate captures (the LJC capture, e.g., carries
  // two `&#31;` entity-decoded bytes inside one inert legacy Word
  // `ProductID` attribute). The handler grammar for Ficha `onclick`
  // is itself a strict whole-value ASCII-integer regex (see
  // `parseFichaHandler`), so an entity-decoded reserved byte inside a
  // candidate handler fails closed there as an unparseable handler —
  // no separate attribute scan is needed.
  assertNoReservedMarkerCharsInText(doc);

  const sourceUrls = collectFichaSourceUrls(doc, rules);
  // S-INI — DOM pre-strip pass: collect the ordered Ficha source events
  // BEFORE any strip rule can remove them. Only the ENTIRE `onclick`
  // attribute of anchors whose normalized caption is an exact Ficha
  // caption is ever parsed; no JavaScript executes and no script or
  // body text is ever searched. After parsing each handler, the
  // extractor's reserved anchor marker is injected into the anchor's
  // text content so the cleaned line that carries the anchor also
  // carries its anchorToken (resolution happens once the cleaned
  // text has been joined and collapsed).
  const fichaEvents = collectFichaSourceEvents(doc, rules);

  for (const rule of rules.strip) {
    if (typeof rule.match === "string") {
      doc.querySelectorAll(rule.match).forEach((el) => el.remove());
    }
  }

  const body = doc.body ?? doc.documentElement;
  stripByTagName(body, rules.strip);

  return { text: domToText(body), sourceUrls, fichaEvents };
}

/**
 * S-INI — reserved-character spoof guard. Walks every parsed-DOM
 * text node (the only channel that can reach `domToText` and therefore
 * cleaned marker resolution) and rejects the candidate if any reserved
 * character is already present. The extractor NEVER inserts markers
 * without having cleared this check on the document it is about to
 * mutate.
 *
 * Attribute values are NOT scanned here: arbitrary DOM attributes
 * never reach marker resolution, and the handler-grammar parser
 * (`parseFichaHandler`) is itself a strict whole-value ASCII-integer
 * regex that fails closed on any non-conforming payload — including a
 * Ficha `onclick` whose value contains an entity-decoded reserved
 * byte. Scanning attributes would only reject legitimate captures
 * whose inert legacy Word / root attributes carry entity-decoded
 * bytes that the parser never reaches for marker interpretation.
 */
function assertNoReservedMarkerCharsInText(doc: Document): void {
  const reserved = ANCHOR_TOKEN_RESERVED_CHAR;
  const walker = doc.createTreeWalker(doc, 4 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node) {
    if ((node.nodeValue ?? "").includes(reserved)) {
      throw new Error(
        "extract: source contains reserved anchor marker characters in text (spoofing rejected)",
      );
    }
    node = walker.nextNode();
  }
}

/**
 * S-INI — ordered Ficha-anchor events for one fragment. An anchor with
 * a Ficha caption but an unparseable/absent onclick handler is a hard
 * contract failure (a renamed wrapper, a fifth argument, or a stripped
 * attribute must reject the candidate, never be skipped). An anchor
 * whose caption is not a Ficha caption is ordinary markup and ignored.
 *
 * After parsing a handler, the extractor's reserved anchor marker
 * (`anchorToken` on the parsed event) is injected into the anchor's
 * text content as the FIRST child, so the cleaned line that carries
 * the anchor also carries its anchorToken. Resolution happens once the
 * cleaned text has been joined across fragments and whitespace-
 * collapsed; the marker is stripped before any legal text is exposed
 * (no leakage into frontMatter, body, warning, gap caption, ledger
 * label, DB-facing type, or output text).
 */
function collectFichaSourceEvents(
  doc: Document,
  rules: Rules,
): FichaSourceEvent[] {
  const out: FichaSourceEvent[] = [];
  doc.querySelectorAll("a").forEach((el) => {
    const caption = normalizeFichaCaption(el.textContent ?? "");
    if (caption.length === 0 || !EXTENDED_FICHA_LINE.test(caption)) return;
    const rawOnclick = el.getAttribute("onclick");
    const href = (el.getAttribute("href") ?? "").trim();
    if (rawOnclick === null || rawOnclick.trim().length === 0) {
      // A Ficha anchor WITHOUT a handler is a legacy absolute source
      // link (reviewed http(s) href, no SINALEVI unit id). It is not a
      // source-unit event: it survives only as the reviewed URL in the
      // sourceUrls map and is never persisted as a canonical route.
      if (/^https:\/\//i.test(href)) return;
      throw new Error(
        "extract: Ficha anchor carries no handler and no reviewed source URL",
      );
    }
    const parsed = parseFichaHandler(out.length, caption, rawOnclick.trim());
    if (parsed === null) {
      throw new Error(
        "extract: Ficha anchor carries an unparseable handler (malformed onclick grammar)",
      );
    }
    out.push(parsed);
    // S-INI — inject the reserved anchor marker into the anchor's
    // text content. Prepending it as the very first child guarantees
    // the cleaned-text line that emits this anchor also emits the
    // marker, so the (line, event) bijection is exact.
    injectAnchorMarker(el, parsed.anchorToken, doc);
    // S-INI — isolate the anchor's block so its caption can never be
    // glued to source-error text on the same cleaned line (real case:
    // "Texto de articulo no encontrado" printed immediately before an
    // enlaceFicha div). A <br> before the anchor's containing block
    // emits a hard line boundary in domToText; empty lines produced
    // around the separator are filtered by collapseWhitespace, so the
    // only structural effect is that terminator captions always own
    // their line.
    const anchorBlock =
      (typeof el.closest === "function" ? el.closest("div") : null) ?? el;
    const parent = anchorBlock.parentNode;
    if (parent !== null && parent !== undefined) {
      const separator = doc.createElement("br");
      parent.insertBefore(separator, anchorBlock);
    }
  });
  return out;
}

/** Insert the reserved anchor marker as the first text child of an anchor. */
function injectAnchorMarker(
  anchor: Element,
  token: string,
  doc: Document,
): void {
  const markerNode = doc.createTextNode(token);
  anchor.insertBefore(markerNode, anchor.firstChild);
}

/**
 * Caption → reviewed URL, for every anchor in this fragment whose text is
 * a `Ficha Artículo N` block and whose href is a real http(s) URL.
 *
 * Must run BEFORE the strip pass and before text serialization: the link
 * is the only place the payload states where the ficha actually lives,
 * and the label alone (what the text stream keeps) is not openable.
 * `javascript:void(0);` handlers — what the shipped SINALEVI exports
 * carry — are deliberately skipped, so absence means "the source told us
 * nothing" rather than a fabricated link (M-LAW-07).
 */
function collectFichaSourceUrls(
  doc: Document,
  rules: Rules,
): Map<string, string> {
  const out = new Map<string, string>();
  doc.querySelectorAll("a").forEach((el) => {
    const caption = (el.textContent ?? "").trim();
    if (caption.length === 0 || !rules.fichaTerminator.test(caption)) return;
    const href = (el.getAttribute("href") ?? "").trim();
    if (!/^https?:\/\//i.test(href)) return;
    const key = captionKey(caption);
    if (key.length > 0 && !out.has(key)) out.set(key, href);
  });
  return out;
}

/** Case- and whitespace-insensitive identity for a Ficha caption. */
function captionKey(caption: string): string {
  return caption.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

/**
 * S-INI — resolver of the cleaned-text anchor markers. Each marker is
 * unique to one event (via `anchorToken` ↔ `sourceUnitId`) and must
 * appear on exactly one line in the cleaned text. The resolver:
 *   - extracts every marker from every line;
 *   - rejects a line that carries zero or more than one marker (a
 *     handled anchor may never share a cleaned line with another
 *     handled anchor — the `<br>` separator guarantees one per line
 *     in real payloads);
 *   - rejects a marker that resolves to an event not present in the
 *     supplied event sequence (foreign or duplicated marker);
 *   - rejects any event whose marker is missing from the cleaned
 *     text (the marker was lost during strip / serialization);
 *   - AFTER stripping the marker, requires that the remaining line is
 *     the originating event's normalized Ficha caption AND that its
 *     kind (article vs transitorio) matches the event's unitKind. A
 *     marker whose caption was removed, merged, changed, or displaced
 *     onto a neighbouring line must reject immediately — it may not
 *     become `unclassified-gap` and it may not bind a line owned by
 *     another event;
 *   - records the (line, event) bijection as `lineToEvent` for the
 *     downstream binding pass;
 *   - strips every marker from every line so the legal text carries
 *     no reserved bytes.
 */
function resolveAnchorMarkers(
  collapsed: string,
  sourceEvents: readonly FichaSourceEvent[],
): {
  readonly lines: string[];
  readonly lineToEvent: Map<number, FichaSourceEvent>;
} {
  const eventBySourceUnitId = new Map<number, FichaSourceEvent>();
  for (const e of sourceEvents) {
    if (eventBySourceUnitId.has(e.sourceUnitId)) {
      throw new Error(
        `extract: duplicate sourceUnitId ${e.sourceUnitId} across fragments`,
      );
    }
    eventBySourceUnitId.set(e.sourceUnitId, e);
  }
  const lines = collapsed.split("\n");
  const lineToEvent = new Map<number, FichaSourceEvent>();
  const seenSourceUnitIds = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const { sourceUnitIds, markerCount } = extractAnchorTokensFromLine(line);
    if (markerCount === 0) continue;
    if (markerCount > 1) {
      throw new Error(
        `extract: cleaned-text line ${i} carries ${markerCount} anchor markers (expected exactly 1)`,
      );
    }
    const sourceUnitId = sourceUnitIds[0]!;
    if (seenSourceUnitIds.has(sourceUnitId)) {
      throw new Error(
        `extract: duplicate anchor marker for sourceUnitId ${sourceUnitId} (one marker must map to exactly one cleaned-text line)`,
      );
    }
    const event = eventBySourceUnitId.get(sourceUnitId);
    if (event === undefined) {
      throw new Error(
        `extract: anchor marker references unknown sourceUnitId ${sourceUnitId} (no matching parsed event)`,
      );
    }
    // S-INI — after stripping the marker, the remaining cleaned-text
    // line MUST be the originating event's exact Ficha caption and
    // kind. A marker whose caption was removed, merged into
    // neighbouring text, displaced onto a different line, or whose
    // event carries a wrong-kind (article vs transitorio) unitKind
    // fails closed here — it may never become `unclassified-gap` and
    // it may never bind a line owned by another event.
    const stripped = stripAnchorMarkersFromLine(line);
    const strippedNormalized = normalizeFichaCaption(stripped);
    if (strippedNormalized !== event.caption) {
      throw new Error(
        `extract: anchor marker on cleaned-text line ${i} for sourceUnitId ${sourceUnitId} stripped to "${strippedNormalized || "<empty>"}", which does not match the originating event's normalized caption "${event.caption}" (marker displaced, merged, or its caption removed)`,
      );
    }
    if (!EXTENDED_FICHA_LINE.test(stripped)) {
      throw new Error(
        `extract: anchor marker on cleaned-text line ${i} stripped to "${strippedNormalized}", which is not a Ficha terminator line (marker not bound to its own anchor caption)`,
      );
    }
    const strippedKind: "article" | "transitorio" =
      /TRANSITORIO$/i.test(stripped) ? "transitorio" : "article";
    if (event.unitKind !== strippedKind) {
      throw new Error(
        `extract: anchor marker on cleaned-text line ${i} stripped to "${strippedNormalized}" with kind "${strippedKind}", but the originating event sourceUnitId ${sourceUnitId} declares unitKind "${event.unitKind}" (kind mismatch — token displaced or handler/label disagreement)`,
      );
    }
    seenSourceUnitIds.add(sourceUnitId);
    lineToEvent.set(i, event);
    lines[i] = stripped;
  }
  // Marker loss: every parsed event MUST show up on exactly one line.
  for (const e of sourceEvents) {
    if (!seenSourceUnitIds.has(e.sourceUnitId)) {
      throw new Error(
        `extract: anchor marker lost for sourceUnitId ${e.sourceUnitId} (handler parsed but no marker survived to cleaned text)`,
      );
    }
  }
  return { lines, lineToEvent };
}

function normalize(
  raw: string,
  rules: Rules,
): {
  readonly lines: string[];
  readonly sourceUrls: Map<string, string>;
  readonly sourceEvents: FichaSourceEvent[];
  readonly lineToEvent: Map<number, FichaSourceEvent>;
} {
  const fragments = splitFragments(raw, rules);
  const parts: string[] = [];
  const sourceUrls = new Map<string, string>();
  const sourceEvents: FichaSourceEvent[] = [];
  for (const fragment of fragments) {
    const cleaned = cleanFragment(fragment, rules);
    parts.push(cleaned.text);
    for (const [key, url] of cleaned.sourceUrls) {
      if (!sourceUrls.has(key)) sourceUrls.set(key, url);
    }
    for (const event of cleaned.fichaEvents) {
      // Re-stamp the GLOBAL document order across fragments; the
      // per-fragment index is meaningless for the ledger. The
      // anchorToken (derived from sourceUnitId, which is globally
      // unique by the handler-grammar validator) is preserved so the
      // marker injected during collectFichaSourceEvents still resolves
      // to its event after the global re-stamp.
      sourceEvents.push({ ...event, domOrder: sourceEvents.length });
    }
  }
  const joined = parts.join("\n");
  const collapsed = collapseWhitespace(joined, rules);
  const { lines, lineToEvent } = resolveAnchorMarkers(collapsed, sourceEvents);
  return { lines, sourceUrls, sourceEvents, lineToEvent };
}

function stripByTagName(root: Element | Document | null, rules: StripRule[]): void {
  if (!root) return;
  const patterns = rules
    .map((r) => r.match)
    .filter((m): m is RegExp => m instanceof RegExp);
  if (patterns.length === 0) return;

  const ownerDoc =
    (root as Element).ownerDocument ?? (root as unknown as Document);
  const walker = ownerDoc.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
  const toRemove: Element[] = [];
  let node = walker.nextNode() as Element | null;
  while (node) {
    const tag = (node.tagName || "").toLowerCase();
    if (patterns.some((p) => p.test(tag))) {
      toRemove.push(node);
    }
    node = walker.nextNode() as Element | null;
  }
  for (const el of toRemove) el.parentNode?.removeChild(el);
}

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "section",
  "article",
  "header",
  "footer",
  "blockquote",
  "pre",
]);

/**
 * Serialize a DOM subtree to text.
 *
 * Block elements emit their content followed by a newline. Inline elements
 * are wrapped in separating spaces on both sides — this is the critical fix
 * for MS-Word's habit of wrapping individual words/numbers in their own
 * `<span>`. Without these separators, `<span>ARTICULO</span><span>700</span>`
 * glues into the unmatchable token "ARTICULO700". The trailing
 * collapseWhitespace pass reduces the resulting space runs to single spaces,
 * so the only observable effect is that split words reassemble with a space.
 *
 * Newlines INSIDE text nodes are collapsed to spaces (browsers treat them as
 * formatting whitespace). The only `\n` characters in the output come from
 * block-tag boundaries, which is what segment() relies on to split lines.
 */
function domToText(node: Node | null): string {
  if (!node) return "";
  if (node.nodeType === 3 /* TEXT */) {
    return (node.nodeValue ?? "").replace(/[\r\n\f]+/g, " ");
  }
  if (node.nodeType !== 1 /* ELEMENT */) return "";

  const el = node as Element;
  const tag = (el.tagName || "").toLowerCase();

  if (tag === "br") return "\n";

  const isBlock = BLOCK_TAGS.has(tag);
  const children = Array.from(el.childNodes);

  let out = isBlock ? "" : " ";
  for (let i = 0; i < children.length; i++) {
    out += domToText(children[i] ?? null);
    if (i < children.length - 1) out += " ";
  }
  if (!isBlock) out += " ";
  else out += "\n";
  return out;
}

function collapseWhitespace(text: string, rules: Rules): string {
  return text
    .split("\n")
    .map((line) => line.replace(rules.whitespaceCollapse, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

type Event =
  | { kind: "heading"; heading: HierarchyNode; line: number }
  | {
      kind: "articleHeader";
      number: string;
      ordinalRaw: string;
      line: number;
      sameLineTail: string;
      /**
       * Penal provisional recovery seam — true when this articleHeader
       * event was injected by the private Penal recovery seam (see
       * `PENAL_PROVISIONAL_ADMISSION` / `PENAL_RECOVERY_SHAPE_*_RE`).
       * The article branch consults this flag to fold the source-side
       * body prefix (the lines stranded between the preceding handled
       * article-kind Ficha terminator and the recovered header) into
       * the emitted body. Canonical (non-recovered) articleHeader
       * events keep the historical composition — body starts at
       * `line + 1`, never at the preceding Ficha line.
       */
      isRecovered?: boolean;
    }
  | {
      /**
       * M-LAW-10 — a standalone transitorio header. `line` is also the
       * M-LAW-11 coordinate: every event kind records the cleaned-text line
       * it was found on, which is the single order space the hierarchy
       * nodes, articles and transitorios are stored in.
       */
      kind: "transitory";
      number: string;
      ordinalRaw: string;
      /** Article number for the "Transitorio al artículo N" form, else "". */
      attachesTo: string;
      /** Full printed display line (header + any same-line text). */
      label: string;
      /**
       * Compact printed HEADER only — the exact `transitoryHeader` match
       * (`trMatch[0]`) with outer boundary whitespace trimmed, case /
       * accents / number token / marker word / separator all preserved.
       * This is what the emitted-transitory source ledger carries as its
       * `unitLabel`; the full-provision `label` above stays the display
       * field. A same-line provision whose body runs past the catalog's
       * 512-code-unit label bound therefore never pushes the ledger row
       * out of the reviewed parser domain.
       */
      unitLabel: string;
      line: number;
      sameLineTail: string;
    }
  | {
      kind: "ficha";
      label: string;
      line: number;
      fichaNum: string;
      fichaSuffix: string;
      /**
       * S-INI — Ficha terminator kind. "article" for the plain
       * "Ficha Artículo N" form; "transitorio" for the
       * "Ficha Artículo N Transitorio" form consumed by a standalone
       * transitorio. Segmentation filters look-ahead by article kind
       * so an article's terminator is never a transitorio Ficha, and
       * the binding layer filters transitorios by transitorio kind so
       * they never consume the first arbitrary later handled terminator.
       */
      fichaKind: "article" | "transitorio";
      /** Reviewed URL of this ficha's own link, when the payload had one. */
      sourceUrl?: string;
    };

/**
 * Strip any `bis`/`ter`/`quáter`/`quinquies` suffix from a normalized
 * article-number string and return the leading base token. Used by the
 * article lookAhead to decide whether the eventual Ficha's base number
 * belongs to the current header — `"85 bis"` → `"85"`,
 * `"376 quinquies"` → `"376"`, `"152"` → `"152"`.
 */
function numericBase(numStr: string): string {
  const parts = numStr.split(/\s+/);
  return parts[0] ?? numStr;
}

/** Match a line against the ordered heading rules; returns the first hit. */
function matchHeading(
  line: string,
  rules: Rules,
): HierarchyNode | undefined {
  for (const rule of rules.headingRules) {
    if (rule.match.test(line)) {
      return { kind: rule.kind, label: line.trim() };
    }
  }
  return undefined;
}

/**
 * Heuristic: is `line` a descriptive label for the heading that just
 * appeared? CR law prints the marker ("TITULO PRIMERO") and, on the next
 * line, the descriptive title ("DISPOSICIONES GENERALES"). We recognize a
 * descriptive label as a line that is ENTIRELY uppercase letters/accents
 * and spaces, has at least 2 words, and does not itself look like a marker
 * or an article/ficha line.
 */
function isDescriptiveLabel(line: string): boolean {
  const t = line.trim();
  if (t.length < 4) return false;
  // All uppercase letters, accents, spaces, hyphens.
  if (!/^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ \t-]*$/.test(t)) return false;
  // At least 2 words of 3+ uppercase letters.
  const words = t.split(/[ \t]+/).filter((w) => w.length >= 3);
  if (words.length < 2) return false;
  // Reject article/ficha/marker-looking lines.
  if (
    /^ART[IÍií]CULO\b/i.test(t) ||
    /^FICHA\b/i.test(t) ||
    /^T[IÍ]TULO\b/i.test(t) ||
    /^CAP[IÍ]TULO\b/i.test(t) ||
    /^SECCI[OÓ]N\b/i.test(t)
  ) {
    return false;
  }
  return true;
}

/** Segmentation output plus the positional span data the source-unit
 *  ledger binds against. The spans are LINE coordinates in the cleaned
 *  text — the same coordinate space every extracted unit carries as
 *  `extractOrder` (M-LAW-11). */
interface Segmentation {
  readonly norma: ExtractedNormaWithSources;
  readonly articleHeaderLines: number[];
  readonly articleTerminatorLines: number[];
  readonly transitoryHeaderLines: number[];
  /**
   * S-INI — per-standalone-transitorio terminator line recorded during
   * segmentation. The transitorio scan is BOUNDED by the next competing
   * unit/header boundary (heading, article header, another transitorio
   * header, or article terminator), so the value is either the exact
   * transitorio-kind Ficha terminator line of THIS transitorio or `-1`
   * when no addressable terminator exists within its natural span
   * (binding surfaces a warning and emits without a coordinate).
   */
  readonly transitoryTerminatorLines: number[];
  /**
   * Per-emitted-transitory compact printed header (see the
   * `transitory` event's `unitLabel`). Carried POSITIONALLY, pushed only
   * when the transitorio is actually emitted, so index `i` always lines
   * up with `transitories[i]` and `transitoryTerminatorLines[i]` — an
   * empty-provision rejection (`continue`) pushes no slot, exactly like
   * the terminator array. The emitted-transitory ledger binds THIS
   * label, never the full display line.
   */
  readonly transitoryUnitLabels: string[];
  readonly lines: string[];
  /**
   * S-INI — exact DOM-anchor binding. Key is a Ficha terminator line
   * index in `lines`; value is the parsed FichaSourceEvent whose
   * reserved marker was emitted on that line and later stripped.
   * Legacy absolute-URL Ficha lines (no handler) are absent from the
   * map; they survive only as a warning and carry no source
   * coordinate.
   */
  readonly lineToEvent: Map<number, FichaSourceEvent>;
}

function segmentWithSpans(
  lines: string[],
  rules: Rules,
  sourceUrls: Map<string, string> = new Map(),
  lineToEvent: Map<number, FichaSourceEvent> = new Map(),
  headerAdmission: HeaderAdmissionContext = EXTRACT_NO_CONTEXT,
): Segmentation {
  const events: Event[] = [];
  const classifiedLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;

    if (rules.fichaTerminator.test(t) || EXTENDED_FICHA_LINE.test(t)) {
      const m = rules.fichaTerminator.exec(t);
      const num = m?.[1] ?? "";
      const suffix = (m?.[2] ?? "").trim();
      const label = suffix
        ? `Ficha Artículo ${num} ${suffix}`.trim()
        : `Ficha Artículo ${num}`.trim();
      const fichaSuffix = suffix.toLowerCase().replace("quater", "quáter");
      const fichaKind: "article" | "transitorio" = /TRANSITORIO$/i.test(t)
        ? "transitorio"
        : "article";
      const url = sourceUrls.get(captionKey(t));
      events.push({
        kind: "ficha",
        label,
        line: i,
        fichaNum: num,
        fichaSuffix,
        fichaKind,
        ...(url !== undefined ? { sourceUrl: url } : {}),
      });
      classifiedLines.add(i);
      continue;
    }

    const artMatch = rules.articleHeader.exec(t);
    if (artMatch) {
      const raw = (artMatch[1] ?? "").trim();
      const { number, ordinalRaw } = rules.normalizeNumber(raw);
      // Bounded quinquies emission: a `quinquies` article-header event is
      // admitted ONLY under the trusted CT Word-capture context (see
      // `CT_QUINQUIES_ADMISSION`). In every other context the regex match
      // is a grammar recognition only — no event is pushed, so the line
      // stays ordinary source text inside the surrounding body span and
      // its Ficha survives as an accounted generic gap at binding.
      if (
        QUINQUIES_NUMBER_RE.test(number) &&
        !admitsQuinquiesHeader(headerAdmission)
      ) {
        continue;
      }
      const sameLineTail = t.slice(artMatch[0].length).trim();
      events.push({
        kind: "articleHeader",
        number,
        ordinalRaw,
        line: i,
        sameLineTail,
      });
      classifiedLines.add(i);
      continue;
    }

    const heading = matchHeading(t, rules);
    if (heading) {
      events.push({ kind: "heading", heading, line: i });
      classifiedLines.add(i);
      continue;
    }

    // M-LAW-10 — a standalone transitorio header. Checked AFTER the ficha
    // and article branches so a template's own markers always win, and
    // after the heading branch because a heading is structural, never a
    // provision. Rulesets that print no transitorios omit the rule and
    // never reach this branch.
    if (rules.transitoryHeader) {
      const trMatch = rules.transitoryHeader.exec(t);
      if (trMatch) {
        const attachesTo = (trMatch[1] ?? "").trim();
        const { number, ordinalRaw } = rules.normalizeNumber(
          (trMatch[2] ?? attachesTo).trim(),
        );
        // Compact ledger label: the EXACT printed header is the full
        // `transitoryHeader` match `trMatch[0]` (marker word, optional
        // `DISPOSICIÓN/ES` prefix, `al artículo N` form, ordinal token,
        // and the trailing separator, all captured verbatim from line
        // start). Only the OUTER boundary whitespace is trimmed — case,
        // accents, number token, marker, and separator are preserved
        // exactly as printed; no case folding, no re-search, no
        // truncation. The display `label` stays the whole line.
        const unitLabel = trMatch[0].trim();
        events.push({
          kind: "transitory",
          number,
          ordinalRaw,
          attachesTo,
          label: t,
          unitLabel,
          line: i,
          sameLineTail: t.slice(trMatch[0].length).trim(),
        });
        classifiedLines.add(i);
      }
    }
  }

  // Penal provisional recovery seam (private, gated). The audited Penal
  // Word capture (5027/151473/`sinalevi-word-export`) prints eight
  // headers that the global `articleHeader` grammar deliberately does
  // not widen to: `53 bis`, `175 quinquies-`, `175 sexies-`,
  // `175 septies-`, `257 ter:`, `279 quinquies .-`, `279 sexies .-`,
  // and `339` (the bare base form). The seam admits them via TWO
  // audited candidate shapes — standard legal separators for spaced
  // `quinquies|sexies|septies` (shape 1), and `:` / punctuation-free
  // horizontal whitespace for any canonical base/suffix token (shape 2).
  // Each candidate is PROVISIONAL until structural ownership is proven:
  // the first subsequent structural boundary MUST be one handled
  // article-kind Ficha whose printed numeric base exactly equals
  // `numericBase(candidate.number)`. A canonical article header, a
  // hierarchy heading, a transitorio header, an other/wrong-kind Ficha,
  // or a second recovery candidate that intervenes BEFORE the matching
  // Ficha rejects the candidate outright — the line stays ordinary
  // source text inside the surrounding body span and the matching
  // handler (when one is on the rejected line) survives as an accounted
  // generic gap at binding. Outside the exact Penal context the seam is
  // dead and never produces an event.
  //
  // Two-pass seam: PASS 1 indexes every provisional candidate line
  // (shape match + glued-ordinal bail-out) WITHOUT emitting anything;
  // PASS 2 proves ownership against the first subsequent structural
  // boundary, where that boundary is the earlier of the next first-pass
  // event and the next indexed candidate line. A boundary that is
  // another candidate rejects the candidate outright — no scan may jump
  // across another candidate, and a candidate may never steal (or fold)
  // a sibling candidate's Ficha. Each candidate qualifies only under its
  // own nearest-boundary proof.
  //
  // Malformed glued-ordinal bail-out: shape 2's body-tail lookahead
  // permits any Unicode letter or decimal digit as the body's first
  // code point, but a real production Penal capture also printed
  // malformed glued-suffix tokens like `Articulo 175 quinquiesº-` and
  // `Articulo 175quinquies°-` (suffix + ordinal marker glued, with or
  // without the `[ \t]+` separator). Shape 2 matches those with the
  // token collapsed to bare `175` and the body tail starting with the
  // suffix + ordinal pair. The seam REJECTS such candidates via the
  // same-line-tail post-check: a body tail whose first token is one
  // of the recognized suffixes followed by a `[ \t\u00A0]*[º°]` ordinal
  // marker (or just `[ \t\u00A0]+` — a separator that would normally sit
  // between a token's suffix and the body, suggesting the recovery
  // captured a base where the suffix was actually present in the
  // source) is a malformed glued form. The line stays ordinary text
  // and the handler's Ficha stays an accounted generic gap at
  // binding. The same guard catches `Articulo 279 bisº-`,
  // `Articulo 261quáter°-`, and their no-space variants. The check is
  // CASE-INSENSITIVE (`i` flag — the production capture prints both
  // `quinquies` and `QUINQUIESº`) and NBSP-aware (`\u00A0` sits in
  // every whitespace slot exactly like space/tab — shape 2's body-tail
  // separator already admits NBSP, and the real Penal source separates
  // the glued ordinal with a horizontal NBSP in `quinquies\u00A0º`),
  // so `QUINQUIESº`, `Sexies°`, `SEPTIES°`, `QUÁTERº`, and
  // `quinquies\u00A0º` bailed out exactly like their lowercase ASCII
  // twins instead of backtracking to a bare numeric capture and
  // emitting a duplicate canonical base row.
  //
  // The `quater` family of the bail-out recognizes plain `quater`,
  // composed `qu\u00E1ter` (U+00E1), AND decomposed `qua\u0301ter`
  // (U+0061 + U+0301) — all three are canonically equivalent in NFC
  // and a real production Penal source printed the decomposed form
  // in `Articulo 175 QUA\u0301TER\u00A0º.- ...` (suffix + ordinal
  // marker glued, with the NBSP-aware separator collapsing the
  // horizontal NBSP between them). Without the decomposed alternative
  // the bail-out regex's `qu[aá]ter` character class would not match
  // the decomposed tail, shape 2 would backtrack to a bare numeric
  // capture, and a duplicate canonical Article 175 row would be
  // emitted whenever a real 175 had already been emitted upstream.
  // The fragment is composed via the private `PENAL_QUATER_ALT`
  // constant and reused by shape 2's suffix slot, the body-tail
  // bail-out, and the captured-token check so all three guards stay
  // in lockstep — the global Word and treaty `articleHeader` grammars
  // are deliberately NOT widened by this constant.
  if (admitsPenalProvisionalHeader(headerAdmission)) {
    // PASS 1 — index every provisional candidate line without emitting
    // anything. Shape matching and the glued-ordinal bail-out run here,
    // so PASS 2's ownership scan can treat another candidate as a
    // structural boundary even though recovered events are inserted
    // only after both passes finish.
    type PenalCandidate = {
      line: number;
      number: string;
      ordinalRaw: string;
      sameLineTail: string;
    };
    const candidates: PenalCandidate[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (classifiedLines.has(i)) continue;
      const t = lines[i]!.trim();
      if (!t) continue;
      const shape1 = PENAL_RECOVERY_SHAPE_1_RE.exec(t);
      const shape2 = shape1 ? null : PENAL_RECOVERY_SHAPE_2_RE.exec(t);
      const match = shape1 ?? shape2;
      if (!match) continue;
      const sameLineTail = t.slice(match[0].length).trim();
      // Malformed glued-ordinal bail-out. The body tail's first token
      // is a recognized suffix (`bis|ter|quáter|quinquies|sexies|septies`)
      // followed by an ordinal marker (`º` or `°`) — that means the
      // recovery token dropped a real source suffix (the source did
      // carry `quinquies` after `175`, but the regex engine captured
      // only the bare base because the suffix separator and the body
      // separator collapsed on the same `[ \t]+`). A body tail whose
      // first token is a recognized suffix followed by a
      // `[ \t\u00A0]+` or `[ \t\u00A0]*[º°]` ordinal marker is a
      // malformed glued form — the seam rejects it and the line stays
      // ordinary source text. A bailed-out line is NOT a candidate and
      // therefore never claims a boundary slot in PASS 2. The check is
      // CASE-INSENSITIVE (`i` flag) and NBSP-aware (`\u00A0` in every
      // whitespace slot, exactly like shape 2's body-tail separator),
      // so uppercase/title-case/accented/NBSP glued variants reject
      // instead of backtracking to a bare numeric capture. The
      // `quater` family uses the shared `PENAL_QUATER_ALT` fragment so
      // plain `quater`, composed `qu\u00E1ter`, and decomposed
      // `qua\u0301ter` all bail out uniformly — without it, the
      // decomposed form would backtrack to a bare numeric capture and
      // emit a duplicate canonical Article 175 row.
      const capturedRaw = (match[1] ?? "").trim();
      if (
        new RegExp(
          "^(?:bis|ter|" + PENAL_QUATER_ALT + "|quinquies|sexies|septies)(?:[ \\t\u00A0]+|[ \\t\u00A0]*[º°])",
          "i",
        ).test(sameLineTail) ||
        // DIRECT suffix+ordinal fusion INSIDE the captured token: shape
        // 2's suffix slot can legitimately capture `{base} {suffix}`
        // while the NBSP-aware body separator then absorbs the
        // horizontal NBSP that GLUES the ordinal marker onto the
        // captured suffix — the tail starts at the bare ordinal marker
        // (`º`/`°`), so the tail check above cannot see the fusion.
        // The marker is Unicode category Lo (a letter), so shape 2's
        // body-tail letter lookahead admits it and the candidate would
        // normalize to a legal `{base} {suffix}` coordinate and emit a
        // duplicate canonical row whose body starts with a bare ordinal
        // marker. Whenever the captured token carries a recognized
        // suffix, an ordinal marker as the tail's first code point is
        // the fused suffix+ordinal form the number grammar forbids —
        // reject it. (Valid recoveries never start their body with an
        // ordinal marker, and the marker is not a legal body-initial
        // character in any audited Penal row.) The `quater` family
        // again uses `PENAL_QUATER_ALT` so the captured-token suffix
        // check stays in lockstep with the tail-side bail-out — the
        // decomposed `qua\u0301ter` shape inside the captured token
        // (followed by an NBSP-then-marker fusion in the body tail)
        // bails out here too.
        (new RegExp(
          "[ \\t\u00A0](?:bis|ter|" + PENAL_QUATER_ALT + "|quinquies|sexies|septies)$",
          "i",
        ).test(capturedRaw) &&
          /^[º°]/.test(sameLineTail))
      ) {
        continue;
      }
      const raw = capturedRaw;
      const { number, ordinalRaw } = rules.normalizeNumber(raw);
      candidates.push({ line: i, number, ordinalRaw, sameLineTail });
    }
    // PASS 2 — ownership proof against the first subsequent structural
    // boundary. Both `events` (appended in ascending line order by the
    // first pass) and `candidates` (built in ascending line order here)
    // are line-sorted, so the boundary is the EARLIER of the next event
    // line and the next candidate line. A boundary that is another
    // provisional candidate rejects the candidate outright — no scan may
    // jump across another candidate, and each candidate qualifies only
    // under its own nearest-boundary proof. Ordinary text lines between
    // the candidate and that boundary are exactly the article body and
    // never compete for the slot.
    const penalRecoveries: Event[] = [];
    for (const cand of candidates) {
      let nextEvent: Event | undefined;
      for (const ev of events) {
        if (ev.line > cand.line) {
          nextEvent = ev;
          break;
        }
      }
      let nextCandidateLine = -1;
      for (const other of candidates) {
        if (other.line > cand.line) {
          nextCandidateLine = other.line;
          break;
        }
      }
      const boundaryIsAnotherCandidate =
        nextCandidateLine >= 0 &&
        (nextEvent === undefined || nextCandidateLine < nextEvent.line);
      // Ownership proof: the boundary MUST be the candidate's own
      // article-kind Ficha terminator. Any other boundary — another
      // provisional candidate, another article header, a hierarchy
      // heading, a transitorio header, a wrong-kind Ficha, a
      // different-article Ficha, or no boundary at all — fails the
      // candidate outright. The handler (when one sits after the
      // rejected line) keeps its handler-anchor on the cleaned text,
      // and the binding pass classifies its terminator row as an
      // `unconsumed-article-terminator` gap.
      if (
        boundaryIsAnotherCandidate ||
        !nextEvent ||
        nextEvent.kind !== "ficha" ||
        nextEvent.fichaKind !== "article" ||
        nextEvent.fichaNum !== numericBase(cand.number)
      ) {
        continue;
      }
      penalRecoveries.push({
        kind: "articleHeader",
        number: cand.number,
        ordinalRaw: cand.ordinalRaw,
        line: cand.line,
        sameLineTail: cand.sameLineTail,
        isRecovered: true,
      });
      classifiedLines.add(cand.line);
    }
    // Insert recovered events in line order so the main segmentation
    // loop consumes them in document order.
    penalRecoveries.sort((a, b) => a.line - b.line);
    for (const rec of penalRecoveries) {
      // Find the first existing event with a line strictly greater
      // than the recovery's line and insert before it; otherwise push
      // to the end. The result is a line-sorted events array.
      let inserted = false;
      for (let j = 0; j < events.length; j += 1) {
        if (events[j]!.line > rec.line) {
          events.splice(j, 0, rec);
          inserted = true;
          break;
        }
      }
      if (!inserted) events.push(rec);
    }
  }

  const hierarchy: HierarchyNode[] = [];
  const articles: Article[] = [];
  const articleHeaderLines: number[] = [];
  const articleTerminatorLines: number[] = [];
  const transitoryHeaderLines: number[] = [];
  /** S-INI — per-transitorio terminator line recorded during the
   *  bounded forward scan in the transitory branch. `-1` means the
   *  scan ran into a competing boundary (or off the end of the
   *  document) before finding an addressable transitorio Ficha. */
  const transitoryTerminatorLines: number[] = [];
  /** Per-emitted-transitory compact printed header; pushed only when the
   *  transitorio is actually emitted so the array stays positionally
   *  aligned with `transitories[]` and `transitoryTerminatorLines[]`. */
  const transitoryUnitLabels: string[] = [];
  /** M-LAW-10 — standalone transitorios, in document order. */
  const transitories: TransitoryProvision[] = [];
  const warnings: string[] = [];
  const dropped: DroppedSegment[] = [];
  // Level-aware heading stack. Depth order is fixed:
  //   libro (0) > titulo (1) > capitulo (2) > seccion (3)
  // When a heading of level L appears, the entry at level L is replaced and
  // all deeper levels are truncated, so `path` always reflects the CURRENT
  // nesting only — not every heading ever seen.
  //
  // The stack holds INDICES into `hierarchy[]`, not the nodes themselves.
  // This lets each Article record an unambiguous `hierarchyIndex` pointing
  // at its deepest active node — the DB layer uses that index directly
  // instead of brittle label matching (labels like "CAPITULO PRIMERO"
  // recur under every título).
  const LEVEL: Record<HierarchyKind, number> = {
    libro: 0,
    titulo: 1,
    capitulo: 2,
    seccion: 3,
  };
  const headingStack: number[] = [];
  const headingLines = new Set<number>();
  /** M-LAW-10 — lines consumed by a standalone transitorio record. */
  const provisionLines = new Set<number>();

  /** Replace the entry at `level` and truncate everything deeper. */
  function setHeadingLevel(heading: HierarchyNode, hierIndex: number): void {
    const level = LEVEL[heading.kind]!;
    // Drop any existing entries at this level or deeper.
    while (
      headingStack.length > 0 &&
      LEVEL[hierarchy[headingStack[headingStack.length - 1]!]!.kind]! >= level
    ) {
      headingStack.pop();
    }
    headingStack.push(hierIndex);
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "heading") {
      const hierIndex = hierarchy.length;
      setHeadingLevel(e.heading, hierIndex);
      headingLines.add(e.line);
      // M-LAW-11 — the marker's own line is its place in the single global
      // order the DB sorts mixed children by.
      e.heading.extractOrder = e.line;
      hierarchy.push(e.heading);

      // Consume the immediately-following line as a descriptive label if
      // it is not itself another event and looks like a label.
      const next = events[i + 1];
      const candidateLine = e.line + 1;
      const isImmediatelyFollowing =
        !next || next.line > candidateLine;
      if (isImmediatelyFollowing && candidateLine < lines.length) {
        const cand = lines[candidateLine]!.trim();
        if (cand.length > 0 && isDescriptiveLabel(cand)) {
          // Attach as displayLabel to the most recent heading in both the
          // stack (via hierarchy[]) and the emitted hierarchy list.
          const stackTopIdx = headingStack[headingStack.length - 1];
          if (stackTopIdx !== undefined) hierarchy[stackTopIdx]!.displayLabel = cand;
          const hierTop = hierarchy[hierarchy.length - 1];
          if (hierTop) hierTop.displayLabel = cand;
          headingLines.add(candidateLine);
        }
      }
    } else if (e.kind === "articleHeader") {
      // S-INI — the article's Ficha terminator is the NEXT ficha event
      // of ARTICLE KIND only. A transitorio-kind Ficha between the
      // header and the article terminator is a transitorio terminator
      // that lives INSIDE the article's body span; it remains inside
      // and gap detection later classifies it as
      // `transitorio-inside-article-body` when the next article-kind
      // Ficha closes the article.
      //
      // The article lookAhead may skip past in-body `articleHeader`
      // events (a cross-reference like "Artículo N.- Vease para el
      // detalle") ONLY when the eventual article-kind terminator's
      // BASE number belongs to the CURRENT header. A later real
      // article M whose own Ficha "Ficha Artículo M" sits between the
      // current header and its own terminator is NOT a cross-reference;
      // it is a real article that the current article's terminator was
      // supposed to precede. In that case the current article's own
      // Ficha is missing (or was duplicated past it), the current
      // article is recorded as TRUNCATED, and the later header/Ficha
      // pair is left for its own article lookup.
      //
      // Legitimate in-body cross-references (skipped: the eventual
      // Ficha's base number matches the current header) are still
      // folded into the body verbatim — only the ownership of the
      // eventual Ficha is gated on its base number.
      let next: Event | undefined;
      let lookAhead = -1;
      for (let j = i + 1; j < events.length; j += 1) {
        const candidate = events[j]!;
        if (candidate.kind === "ficha" && candidate.fichaKind === "article") {
          next = candidate;
          lookAhead = j;
          break;
        }
      }

      // Penal-only body prefix: a recovered article's source-side
      // natural span starts at the line IMMEDIATELY AFTER the preceding
      // handled Ficha terminator (the most recent article-kind Ficha
      // event whose `line` is strictly less than the current
      // article's line). Lines between that boundary and the recovered
      // header — for example the SINALEVI note preceding 175 septies,
      // the `Materiales nucleares` heading preceding 257 ter, or the
      // `Incumplimiento de deberes` heading preceding 339 — are
      // stranded source text that NO canonical article consumed, and
      // the work order requires they be folded into the recovered
      // article's body prefix verbatim (preserves exact source order
      // and substantive text). The seam tags the recovered event with
      // `sameLineTail` so the prefix-vs-tail composition is exact: the
      // body is `bodyPrefix + sameLineTail + post-header lines`, and
      // the recovered header line itself is NEVER in the body.
      // Canonical (non-recovered) article-header events keep the
      // historical composition where the body starts at
      // `e.line + 1` — the prefix for a canonical article is the
      // previous canonical article's body, never a stranded span.
      let prefixStart = -1;
      if (e.isRecovered === true) {
        let precedingFichaLine = -1;
        for (let j = 0; j < i; j += 1) {
          const pe = events[j]!;
          if (pe.kind === "ficha" && pe.fichaKind === "article") {
            precedingFichaLine = pe.line;
          }
        }
        if (precedingFichaLine >= 0) {
          prefixStart = precedingFichaLine + 1;
        } else {
          prefixStart = 0;
        }
      }
      const bodyEnd = next ? next.line : lines.length;
      const postHeaderStart = e.line + 1;
      const prefixLines =
        prefixStart >= 0
          ? lines
              .slice(prefixStart, e.line)
              .map((l) => l.trim())
              .filter((l) => l.length > 0)
          : [];
      const tailLines = lines
        .slice(postHeaderStart, bodyEnd)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      // Source body order is `bodyPrefix + sameLineTail + post-header
      // lines`: the stranded pre-header prefix lines come FIRST, then the
      // recovered header's own same-line tail, then the post-header body
      // lines. Composing the tail before the prefix would reorder the
      // source text (e.g. pushing `Penas accesorias` ahead of the
      // SINALEVI note that precedes `175 septies`). For canonical
      // (non-recovered) headers `prefixLines` is empty, so the historical
      // `sameLineTail + post-header lines` composition is byte-identical.
      const bodyParts = [...prefixLines, e.sameLineTail, ...tailLines].filter(
        (s) => s.length > 0,
      );
      const body = bodyParts.join(" ");
      const path = headingStack.map((idx) => hierarchy[idx]!.label);
      // Deepest active hierarchy node (the bottom of the live stack). This
      // is the unambiguous linkage the DB layer uses; null if no headings
      // were active when the article was emitted.
      const hierarchyIndex =
        headingStack.length > 0
          ? headingStack[headingStack.length - 1]!
          : null;

      // No Ficha anywhere after this header OR the eventual Ficha's
      // base number does NOT belong to the current header → the article
      // is truncated in the source. In the second sub-case an
      // intervening in-body articleHeader for a different article M
      // owns the eventual Ficha, so the current article's own
      // terminator was either missing (source bug) or printed past
      // article M (source ordering). Either way the current article
      // is recorded as DROPPED with a stable reason and the later
      // header/Ficha is left for article M's own lookup.
      if (!next || next.kind !== "ficha") {
        const snippet = lines
          .slice(e.line, Math.min(e.line + 3, lines.length))
          .join(" ")
          .slice(0, 120);
        dropped.push({
          reason:
            "article header without a following Ficha Artículo N terminator",
          numberGuess: e.number,
          snippet,
        });
        continue;
      }
      if (next.fichaKind === "article" && next.fichaNum !== numericBase(e.number)) {
        const snippet = lines
          .slice(e.line, Math.min(e.line + 3, lines.length))
          .join(" ")
          .slice(0, 120);
        dropped.push({
          reason:
            `article header followed by intervening article header that owns the eventual Ficha (expected Ficha Artículo ${numericBase(e.number)}, found Ficha Artículo ${next.fichaNum}); left the later header/Ficha for its own article`,
          numberGuess: e.number,
          snippet,
        });
        continue;
      }

      // Process any intermediate heading events that appeared inside the
      // article's fragment (e.g. transitorios that open a new DISPOSICIONES
      // FINALES section). They must update the heading stack and hierarchy
      // even though they are inside the article's body span.
      for (let mid = i + 1; mid < lookAhead; mid++) {
        const midEvent = events[mid]!;
        if (midEvent.kind === "heading") {
          const midHierIndex = hierarchy.length;
          setHeadingLevel(midEvent.heading, midHierIndex);
          headingLines.add(midEvent.line);
          // M-LAW-11 — same global coordinate rule as the top-level branch.
          midEvent.heading.extractOrder = midEvent.line;
          hierarchy.push(midEvent.heading);
          // Consume display label from the line after.
          const candidateLine = midEvent.line + 1;
          const midNext = events[mid + 1];
          const isImmediatelyFollowing =
            !midNext || midNext.line > candidateLine;
          if (isImmediatelyFollowing && candidateLine < lines.length) {
            const cand = lines[candidateLine]!.trim();
            if (cand.length > 0 && isDescriptiveLabel(cand)) {
              const stackTopIdx = headingStack[headingStack.length - 1];
              if (stackTopIdx !== undefined) hierarchy[stackTopIdx]!.displayLabel = cand;
              const hierTop = hierarchy[hierarchy.length - 1];
              if (hierTop) hierTop.displayLabel = cand;
              headingLines.add(candidateLine);
            }
          }
        }
      }

      // If we skipped one or more intermediate articleHeader events (in-
      // body cross-references), record a warning so the anomaly is
      // visible. The body retains the verbatim text including those
      // cross-references.
      let crossRefCount = 0;
      for (let mid = i + 1; mid < lookAhead; mid++) {
        if (events[mid]!.kind === "articleHeader") crossRefCount++;
      }
      if (crossRefCount > 0) {
        warnings.push(
          `article ${e.number}: ${crossRefCount} in-body "Artículo N" cross-reference(s) were folded into the body`,
        );
      }

      // Reconcile a header that dropped its bis/ter/quáter suffix.
      // SINALEVI's export sometimes prints the header as a bare "Articulo N.-"
      // while the authoritative Ficha terminator carries the suffix
      // ("Ficha Artículo N BIS"). Without this, the suffixed article collides
      // with the plain one on the same number and violates
      // UNIQUE(norma_id, number) at build. The adoption grammar is the
      // CLOSED `BIS|TER|QUÁTER` set from `fichaTerminator` (no QUINQUIES
      // Ficha caption was ever observed, but the suffix slot recognizes
      // `quinquies|sexies|septies` because `normalizeNumber` canonicalizes
      // the no-whitespace forms — e.g. `97bis`, `175 sexies`, `175
      // septies` — to `{base} {suffix}` BEFORE this branch runs). The
      // check uses a `[ \t]+` (one or more horizontal whitespace) prefix
      // and matches the closed canonical suffix set so an already
      // suffix-bearing header — a qualified Penal recovery included —
      // is detected here and is never re-adopted.
      let number = e.number;
      let ordinalRaw = e.ordinalRaw;
      const headerHasSuffix =
        /[ \t]+(?:bis|ter|qu[aá]ter|quinquies|sexies|septies)$/i.test(e.number);
      if (!headerHasSuffix && next.fichaSuffix && next.fichaNum === e.number) {
        number = `${e.number} ${next.fichaSuffix}`;
        ordinalRaw = "";
        warnings.push(
          `article ${e.number}: header dropped the "${next.fichaSuffix}" suffix present in its Ficha (${next.label}); adopted "${number}"`,
        );
      }

      articleHeaderLines.push(e.line);
      articleTerminatorLines.push(next.line);
      articles.push({
        number,
        ordinalRaw,
        body,
        // LABEL and reviewed URL are separate fields (M-LAW-07): the
        // terminator's caption is what a card shows, the URL is what a
        // "Ver en fuente" link can open. No URL is invented here.
        fichaRef: next.label,
        ...(next.sourceUrl !== undefined ? { sourceUrl: next.sourceUrl } : {}),
        path,
        hierarchyIndex,
        // M-LAW-11 — the header line is the article's place in the single
        // order shared with hierarchy nodes and transitorios.
        extractOrder: e.line,
      });

      // Advance past the consumed intermediate events so they are not
      // processed again as their own (dropped) articles.
      i = lookAhead - 1;
    } else if (e.kind === "transitory") {
      // M-LAW-10 — a transitorio the loop REACHED is by construction outside
      // every article's body span (the article branch above consumes every
      // event up to and including its Ficha, so a transitorio inside a body
      // stays folded into that body verbatim). Standalone ones used to be
      // lost without trace; here they become addressable records.
      //
      // S-INI — bounded forward scan for the transitorio's OWN
      // transitorio-kind Ficha terminator. The scan STOPS at the next
      // competing boundary (heading, article header, another
      // transitory header, or article terminator) so a standalone
      // transitorio may not scan arbitrarily forward past those
      // boundaries and steal a later token. The terminator line is
      // recorded here; binding uses the recorded line directly.
      let terminatorLine: number | undefined;
      for (let j = i + 1; j < events.length; j += 1) {
        const candidate = events[j]!;
        if (candidate.kind === "ficha") {
          if (candidate.fichaKind === "transitorio") {
            terminatorLine = candidate.line;
            break;
          }
          // Article-kind Ficha is an article terminator — competing
          // boundary. Do not consume.
          break;
        }
        if (
          candidate.kind === "heading" ||
          candidate.kind === "articleHeader" ||
          candidate.kind === "transitory"
        ) {
          // Competing unit/header boundary. Do not consume past it.
          break;
        }
      }

      // Body span ends at the terminator line (if found within bounds)
      // OR at the next competing boundary's line (if no terminator was
      // found) OR at lines.length (if there is no later event at all).
      const stopEvent = events[i + 1];
      const bodyEnd =
        terminatorLine !== undefined
          ? terminatorLine
          : stopEvent
            ? stopEvent.line
            : lines.length;
      // The record owns its whole span — the front-matter collector must not
      // claim the same text a second time.
      for (let l = e.line; l < bodyEnd; l++) provisionLines.add(l);
      const tailLines = lines
        .slice(e.line + 1, Math.max(e.line + 1, bodyEnd))
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const body = [e.sameLineTail, ...tailLines]
        .filter((s) => s.length > 0)
        .join(" ");
      if (body.length === 0) {
        // Never a silent empty record: the anomaly is surfaced instead.
        // Importantly, do NOT push a terminator slot here — the slot
        // would offset subsequent `transitoryTerminatorLines` indexes
        // from the corresponding `transitories[]` and break the
        // one-to-one downstream binding pass.
        warnings.push(
          `transitorio ${e.number}: header found with no provision text — not recorded`,
        );
        continue;
      }
      // S-INI — record the terminator line ONLY when the transitorio
      // is actually emitted. The slot index always lines up with the
      // emitted `transitories[]` entry that follows it. The compact
      // unit label rides the same positional discipline: pushed ONLY on
      // this emit path, never on the empty-provision `continue` above,
      // so `transitoryUnitLabels[i]` always describes the same record
      // as `transitories[i]` and `transitoryTerminatorLines[i]`.
      transitoryTerminatorLines.push(terminatorLine ?? -1);
      transitoryUnitLabels.push(e.unitLabel);
      transitoryHeaderLines.push(e.line);
      transitories.push({
        number: e.number,
        ordinalRaw: e.ordinalRaw,
        attachesTo: e.attachesTo,
        body,
        label: e.label,
        path: headingStack.map((idx) => hierarchy[idx]!.label),
        hierarchyIndex:
          headingStack.length > 0
            ? headingStack[headingStack.length - 1]!
            : null,
        extractOrder: e.line,
      });
    }
  }

  const firstArt = events.find((e) => e.kind === "articleHeader");
  let frontMatter: string | undefined;
  let frontLineCount = 0;
  if (firstArt) {
    const front = lines
      .slice(0, firstArt.line)
      .map((l, idx) => ({ text: l.trim(), line: idx }))
      .filter(
        (l) =>
          l.text.length > 0 &&
          !headingLines.has(l.line) &&
          !provisionLines.has(l.line),
      )
      .map((l) => l.text);
    if (front.length > 0) {
      frontMatter = front.join(" ");
      frontLineCount = front.length;
    }
  } else {
    const front = lines
      .map((l, idx) => ({ text: l.trim(), line: idx }))
      .filter(
        (l) =>
          l.text.length > 0 &&
          !headingLines.has(l.line) &&
          !provisionLines.has(l.line),
      )
      .map((l) => l.text);
    if (front.length > 0) {
      frontMatter = front.join(" ");
      frontLineCount = front.length;
    }
  }

  if (dropped.length > 0) {
    warnings.push(
      `${dropped.length} article header(s) had no Ficha terminator and were moved to \`dropped\``,
    );
  }

  // ── EXTRACTION-SANITY CHECKS (fail loud, never silent) ────────────────
  // If the cleaned text contains many "ARTICULO N" occurrences but the
  // extractor returned very few, an off-template payload is silently
  // producing 0-or-few articles instead of failing. Surface the gap.
  const articleMarkerRe = /\bART[IÍ]CULO\s+\d+/gi;
  const cleanedMarkerCount = (lines.join("\n").match(articleMarkerRe) ?? []).length;
  if (articles.length === 0) {
    warnings.push(
      `extractor returned 0 articles but the source contains ${cleanedMarkerCount} "ARTICULO N" occurrence(s) — off-template payload`,
    );
  } else if (cleanedMarkerCount > 0 && articles.length < cleanedMarkerCount * 0.5) {
    warnings.push(
      `extractor returned ${articles.length} articles but the source contains ${cleanedMarkerCount} "ARTICULO N" occurrence(s) — possible off-template or many dropped`,
    );
  }
  // frontMatter > 50% of the cleaned non-heading lines is suspicious
  // (most of a code is articles, not preamble). Both operands are LINE
  // counts — comparing a word count against a line count fired spuriously
  // on every treaty, whose front-matter prose is word-dense.
  if (frontLineCount > 0) {
    const totalNonEmpty = lines.filter((l) => l.trim().length > 0).length;
    if (totalNonEmpty > 0 && frontLineCount > totalNonEmpty * 0.5) {
      warnings.push(
        `frontMatter is ${frontLineCount} of ${totalNonEmpty} non-empty lines (${Math.round((frontLineCount / totalNonEmpty) * 100)}%) — suspiciously large`,
      );
    }
  }
  // LIBRO headings discovered but no articles under them is also
  // off-template; flag it.
  const libroCount = hierarchy.filter((h) => h.kind === "libro").length;
  if (libroCount > 0 && articles.length === 0) {
    warnings.push(
      `extractor saw ${libroCount} LIBRO heading(s) but extracted 0 articles — top-level structure present but body parsing failed`,
    );
  }

  return {
    norma: {
      hierarchy,
      articles,
      transitories,
      warnings,
      dropped,
      ...(frontMatter ? { frontMatter } : {}),
    },
    articleHeaderLines,
    articleTerminatorLines,
    transitoryHeaderLines,
    transitoryTerminatorLines,
    transitoryUnitLabels,
    lines,
    lineToEvent,
  };
}

/** One extended-grammar terminator line in the cleaned stream. */
interface Termin {
  readonly line: number;
  readonly caption: string;
  readonly kind: "article" | "transitorio";
}

function scanTerminators(lines: string[]): Termin[] {
  const out: Termin[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!;
    if (!EXTENDED_FICHA_LINE.test(t)) continue;
    const caption = normalizeFichaCaption(t);
    out.push({
      line: i,
      caption,
      kind: /TRANSITORIO$/i.test(caption) ? "transitorio" : "article",
    });
  }
  return out;
}

/**
 * S-INI — positional consumption and the complete one-to-one ledger.
 *
 * The cleaned-text anchor markers (injected during DOM serialization,
 * stripped before legal text is exposed) supply the EXACT one-to-one
 * mapping from a Ficha terminator LINE to its parsed DOM event. The
 * downstream binding uses that bijection directly — caption-subsequence
 * pairing is GONE. Two handlers carrying the same caption (base vs.
 * suffixed, repeated captions across fragments, cloned plain captions)
 * resolve to different events because their markers are different.
 *
 * Unit-kind filtering:
 *   - An emitted article consumes its exact terminator line, which must
 *     be bound by an article-kind event. Wrong-kind, missing, duplicated,
 *     displaced, or already-consumed token fails CLOSED.
 *   - An emitted standalone transitorio consumes the next unconsumed
 *     handled TRANSITORIO-KIND terminator line after its header — never
 *     the first arbitrary later handled terminator (an article-kind
 *     ficha is filtered out).
 *
 * Legacy absolute-URL Ficha lines (no handler) are absent from
 * `lineToEvent` and emit a warning; units around them are emitted
 * without a source coordinate.
 *
 * Whatever remains of `lineToEvent` after article/transitorio binding
 * is a typed known gap with a stable reason — never a silent drop.
 */
function bindSourceUnits(
  segmentation: Segmentation,
  sourceEvents: readonly FichaSourceEvent[],
  capture: CaptureContext & { template: TemplateContract },
): ExtractedNormaWithSources {
  const {
    norma,
    articleHeaderLines,
    articleTerminatorLines,
    transitoryHeaderLines,
    transitoryTerminatorLines,
    transitoryUnitLabels,
    lines,
    lineToEvent,
  } = segmentation;
  const terms = scanTerminators(lines);
  // S-INI — line-level binding data: every Ficha terminator line is
  // either bound to its exact event via `lineToEvent` (the cleaned-
  // text marker bijection) or unbound (legacy absolute-URL anchor;
  // emit a warning, no source coordinate). There is no two-pointer
  // caption subsequence pairing.
  const lineToTerm = new Map<number, Termin>();
  terms.forEach((t) => lineToTerm.set(t.line, t));
  for (const term of terms) {
    if (!lineToEvent.has(term.line)) {
      norma.warnings.push(
        `terminator line "${term.caption}" at line ${term.line} carries no SINALEVI source handler — units around it are emitted without a source coordinate`,
      );
    } else {
      const event = lineToEvent.get(term.line)!;
      // S-INI — kind fidelity: the cleaned-text line's terminator
      // kind MUST match the bound event's unitKind. A handler on a
      // "Ficha Artículo N Transitorio" line must declare unitKind
      // "transitorio"; a handler on a plain "Ficha Artículo N" line
      // must declare "article". A mismatch is a displaced/malformed
      // token and fails closed.
      if (event.unitKind !== term.kind) {
        throw new Error(
          `extract: terminator line "${term.caption}" at line ${term.line} bound to sourceUnitId ${event.sourceUnitId} of kind "${event.unitKind}", but the line is a ${term.kind}-kind Ficha (kind mismatch)`,
        );
      }
    }
  }

  const consumedLines = new Set<number>();
  const bindings: EmittedUnitBinding[] = [];
  for (let i = 0; i < norma.articles.length; i += 1) {
    const terminatorLine = articleTerminatorLines[i];
    if (terminatorLine === undefined) {
      throw new Error("extract: source-ledger article terminator line unknown");
    }
    const term = lineToTerm.get(terminatorLine);
    if (term === undefined) {
      throw new Error(
        `extract: article ${norma.articles[i]!.number} terminator line ${terminatorLine} is not a Ficha terminator line`,
      );
    }
    if (term.kind !== "article") {
      // Wrong-kind: the article's terminator resolved to a
      // transitorio-kind Ficha. The lookAhead in segmentWithSpans
      // already filters by article kind, so reaching here means a
      // downstream change broke the contract — fail closed.
      throw new Error(
        `extract: article ${norma.articles[i]!.number} terminator line ${terminatorLine} is a ${term.kind}-kind Ficha (expected article-kind)`,
      );
    }
    if (consumedLines.has(terminatorLine)) {
      throw new Error(
        `extract: article ${norma.articles[i]!.number} terminator line ${terminatorLine} is already consumed (token displaced or duplicated)`,
      );
    }
    const event = lineToEvent.get(terminatorLine);
    if (event === undefined) {
      // Legacy/off-template: the article's own terminator has no DOM
      // handler — emitted without a coordinate (warning already added).
      continue;
    }
    consumedLines.add(terminatorLine);
    Object.assign(norma.articles[i]!, { sourceUnitId: event.sourceUnitId });
    bindings.push({
      event,
      kind: "emitted-article",
      unitLabel: norma.articles[i]!.number,
    });
  }
  const transitories = norma.transitories ?? [];
  for (let i = 0; i < transitories.length; i += 1) {
    const headerLine = transitoryHeaderLines[i]!;
    const terminatorLine = transitoryTerminatorLines[i]!;
    if (terminatorLine < 0) {
      // S-INI — no addressable Ficha terminator within the bounded
      // span (the forward scan hit a competing boundary or off the
      // end of the document before finding a transitorio-kind Ficha).
      // The unit still emits (text is never lost); it simply has no
      // addressable coordinate — surfaced as a warning, and the
      // release catalog's transitory-coordinate expectation is what
      // fails CLOSED for reviewed templates.
      norma.warnings.push(
        `transitorio ${transitories[i]!.number}: no addressable Ficha terminator — emitted without a source coordinate`,
      );
      continue;
    }
    if (consumedLines.has(terminatorLine)) {
      throw new Error(
        `extract: transitorio ${transitories[i]!.number} terminator line ${terminatorLine} is already consumed (token displaced or duplicated)`,
      );
    }
    const term = lineToTerm.get(terminatorLine);
    if (term === undefined) {
      throw new Error(
        `extract: transitorio ${transitories[i]!.number} terminator line ${terminatorLine} is not a Ficha terminator line`,
      );
    }
    // S-INI — by construction the bounded scan only returns a
    // transitorio-kind Ficha, but defense-in-depth: a marker/term
    // disagreement (segmentation recorded the line as
    // transitorio-kind but the marker bound an article-kind event)
    // must fail closed rather than silently misclassify.
    if (term.kind !== "transitorio") {
      throw new Error(
        `extract: transitorio ${transitories[i]!.number} terminator line ${terminatorLine} is a ${term.kind}-kind Ficha (expected transitorio-kind)`,
      );
    }
    const event = lineToEvent.get(terminatorLine);
    if (event === undefined) {
      // Legacy/off-template: the transitorio's own terminator has no
      // DOM handler — emitted without a coordinate (warning already
      // added by the lineToTerm scan above).
      continue;
    }
    if (event.unitKind !== "transitorio") {
      throw new Error(
        `extract: transitorio ${transitories[i]!.number} bound event sourceUnitId ${event.sourceUnitId} has unitKind "${event.unitKind}" (expected transitorio)`,
      );
    }
    // The ledger binds the COMPACT printed header carried positionally
    // beside the emitted record — never the full display line/body (a
    // same-line provision longer than the catalog's 512-code-unit label
    // bound would otherwise fail the unchanged parser at preparation),
    // never a synthetic or truncated label. Alignment is a hard
    // invariant: a missing or disagreeing slot fails closed instead of
    // silently falling back to the whole-line label.
    const unitLabel = transitoryUnitLabels[i];
    if (unitLabel === undefined) {
      throw new Error(
        `extract: transitorio ${transitories[i]!.number} has no positionally aligned compact unit label`,
      );
    }
    if (!transitories[i]!.label.startsWith(unitLabel)) {
      throw new Error(
        `extract: transitorio ${transitories[i]!.number} compact unit label "${unitLabel}" is not the printed header prefix of its display line`,
      );
    }
    consumedLines.add(terminatorLine);
    Object.assign(transitories[i]!, { sourceUnitId: event.sourceUnitId });
    bindings.push({
      event,
      kind: "emitted-transitory",
      unitLabel,
    });
  }

  const sourceGaps: SourceGap[] = [];
  const gapReasonByDomOrder = new Map<number, string>();
  // S-INI — exact source-line arrays for every unbound event, built
  // positionally so the post-prevalidation classifier can see the lines
  // the auditor reviewed. Each array is the cleaned-text lines strictly
  // between the previous terminator's line and THIS terminator's line,
  // in original order (excludes the terminator caption itself, includes
  // the body span the auditor captured). The map is closure-shared
  // with `sourceLinesFor` below so the reconciler never inspects the
  // content — the array is forwarded verbatim.
  const sourceLinesByEvent = new Map<number, readonly string[]>();
  for (let i = 0; i < terms.length; i += 1) {
    const term = terms[i]!;
    if (consumedLines.has(term.line)) continue;
    const gapEvent = lineToEvent.get(term.line);
    if (gapEvent === undefined) continue; // unanchored legacy line — warning only
    const prevTerm = i > 0 ? terms[i - 1] : undefined;
    const prevLine = prevTerm ? prevTerm.line : -1;
    const rawBetween = lines.slice(prevLine + 1, term.line);
    const cleanedBetween = rawBetween
      .map((l) => stripAnchorMarkersFromLine(l).trim())
      .filter((l) => l.length > 0);
    sourceLinesByEvent.set(gapEvent.domOrder, cleanedBetween);
  }
  for (const term of terms) {
    if (consumedLines.has(term.line)) continue;
    const gapEvent = lineToEvent.get(term.line);
    if (gapEvent === undefined) continue; // unanchored legacy line — warning only
    let reason: string;
    if (term.kind === "transitorio") {
      reason = "transitorio-terminator-without-standalone-unit";
      for (let a = 0; a < articleTerminatorLines.length; a += 1) {
        if (
          term.line > articleHeaderLines[a]! &&
          term.line < articleTerminatorLines[a]!
        ) {
          reason = "transitorio-inside-article-body";
          break;
        }
      }
    } else {
      const idx = terms.indexOf(term);
      const prevTerm = idx > 0 ? terms[idx - 1] : undefined;
      const prevLine = prevTerm ? prevTerm.line : -1;
      const between = lines.slice(prevLine + 1, term.line).join(" ");
      reason = /Texto no disponible/i.test(between)
        ? "source-text-unavailable"
        : "unconsumed-article-terminator";
    }
    gapReasonByDomOrder.set(gapEvent.domOrder, reason);
    // Defer the source_gap row emission: the post-prevalidation
    // classifier may reclassify the event as `reviewed-exclusion`,
    // which never projects through `sourceGaps`. The persistable-gap
    // set is computed AFTER reconciliation, never before, so a
    // `reviewed-exclusion` cannot leak into the DB.
  }

  // S-INI — post-prevalidation classifier. Created from the trusted
  // CaptureContext ONLY; for any non-Penal context the factory
  // answers `null` for GENUINELY UNRELATED events (existing gapReason
  // fallback unchanged for unaffected authorities) but THROWS when a
  // reviewed policy target id appears under a drifted authority,
  // version, template id, or fingerprint — evidence/context drift is
  // never a silent passthrough. The classifier is consulted BEFORE
  // the gapReason callback; a `null` return falls through to
  // gapReason (preserving the v3 / generic behavior).
  const classifier: ReviewedSourceClassifier = createReviewedSourceClassifier(capture);
  const ledger = reconcileSourceUnits({
    context: capture,
    template: capture.template,
    events: sourceEvents,
    bindings,
    sourceLinesFor: (event) => sourceLinesByEvent.get(event.domOrder) ?? [],
    classify: classifier,
    gapReason: (event) => gapReasonByDomOrder.get(event.domOrder) ?? "unclassified-gap",
  });
  // S-INI — the classifier must see exactly the audited 18 entries
  // (other contexts short-circuit through the passthrough and never
  // throw). Any partial sequence fails closed here, BEFORE the
  // completeness assertion, so a candidate with an under-consumed
  // policy ledger cannot reach DB publication.
  classifier.validateFinalState();
  const incompleteness = assertReconciliationComplete(sourceEvents, ledger);
  if (incompleteness !== null) {
    throw new Error(`extract: source-ledger incomplete — ${incompleteness}`);
  }

  // Persistable source_gap rows: ONLY `known-gap` ledger entries (the
  // 17 audited `reviewed-exclusion` entries stay in the sourceLedger
  // for the build evidence but never project through `sourceGaps`,
  // and the strict CHECK in `addNorma` rejects them as collisions).
  for (const entry of ledger) {
    if (entry.kind !== "known-gap") continue;
    const gapEvent = entry.event;
    // Lookup the cleaned terminator caption for this event.
    const term = terms.find(
      (t) =>
        lineToEvent.get(t.line) !== undefined &&
        lineToEvent.get(t.line)!.domOrder === gapEvent.domOrder,
    );
    sourceGaps.push({
      sourceUnitId: gapEvent.sourceUnitId,
      reason: entry.reason,
      docOrder: gapEvent.domOrder,
      caption: term?.caption ?? gapEvent.caption,
    });
  }
  const ledgerEntries: SourceLedgerEntry[] = ledger.map((entry) => ({
    kind: entry.kind,
    sourceUnitId: entry.event.sourceUnitId,
    domOrder: entry.event.domOrder,
    caption: entry.event.caption,
    ...("reason" in entry ? { reason: entry.reason } : {}),
    ...("unitLabel" in entry ? { unitLabel: entry.unitLabel } : {}),
  }));
  return {
    ...norma,
    sourceGaps,
    sourceLedger: ledgerEntries,
  };
}
