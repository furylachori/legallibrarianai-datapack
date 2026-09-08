/**
 * Declarative parsing rules for the SINALEVI "Word-Export" page template
 * used by the Código de Trabajo (and similar códigos/leyes).
 *
 * To support a different SINALEVI template, add a new Rules object and pass
 * it to `extract()`. The extractor core never references these directly;
 * everything is looked up from the rules object.
 */

import type { HierarchyKind } from "./types.js";

export interface StripRule {
  /** CSS selector OR element-tag-name regex; both are tried. */
  match: string | RegExp;
}

export interface HeadingRule {
  /** The hierarchy kind this rule produces. */
  kind: HierarchyKind;
  /**
   * Regex applied line-by-line (no `m` flag needed). The match must be
   * a FULL-LINE match (`^[ \t]*…[ \t]*$`) so we don't pick up mid-line
   * mentions of the marker word. Group 1, if present, is the ordinal/
   * roman/numeric token; we keep the WHOLE line as the label.
   */
  match: RegExp;
}

export interface Rules {
  /** Strip every node matching any of these selectors/patterns before text extraction. */
  strip: StripRule[];

  /** Fragment boundary regex. Diagnostic only — the cleaner parses the whole payload. */
  fragmentBoundary: RegExp;

  /**
   * Article-header regex applied line-by-line (no `m` flag needed).
   * Captures group 1 = the full number token including optional ordinal
   * (e.g. "1º", "85 bis", "7 quáter"). The trailing separator is consumed
   * but not captured — it is the source convention, not part of the number.
   */
  articleHeader: RegExp;

  /** Article terminator regex applied line-by-line. Captures the Ficha number. */
  fichaTerminator: RegExp;

  /**
   * M-LAW-10 — transitory-provision header regex applied line-by-line,
   * with the SAME line-anchor discipline as `articleHeader`. Optional:
   * only the templates that print standalone transitorios supply it, and a
   * ruleset without it simply never emits a `transitories[]` record.
   *
   * Group 1 = the ordinal token ("I", "2", "148"), group 2 = the optional
   * `al artículo N` reference the CT form carries. A line this rejects is
   * ordinary prose and stays where it was.
   */
  transitoryHeader?: RegExp;

  /**
   * Ordered heading rules. The extractor checks them in this order and
   * uses the FIRST match. A descriptive all-caps line that immediately
   * follows a matched marker becomes that node's `displayLabel`, NOT a
   * separate hierarchy node.
   */
  headingRules: HeadingRule[];

  /**
   * Normalize the matched number token (group 1 of `articleHeader`) into
   * the canonical { number, ordinalRaw } pair. The number is text — never
   * coerced to integer — so "85 bis" and "7 quáter" round-trip.
   */
  normalizeNumber: (raw: string) => { number: string; ordinalRaw: string };

  /** Whitespace-collapse pattern applied to every cleaned line. */
  whitespaceCollapse: RegExp;
}

/**
 * Strip selectors for MS-Word HTML export. linkedom supports basic CSS
 * selectors; we additionally walk the tree to drop namespace-prefixed
 * tags that CSS selectors cannot reach (o:p, o:smarttag, …).
 *
 * IMPORTANT: only strip tags that are guaranteed empty in real SINALEVI
 * exports. `<zz>`, `<st*>`, `<u*>` look like namespace junk but they are
 * legitimate inline font/formatting wrappers in MS-Word HTML — stripping
 * them removes the article body. Only `<o:*>` is safe to strip.
 */
const wordStripSelectors: StripRule[] = [
  { match: "style" },
  { match: "script" },
  { match: "head" },
  { match: "meta" },
  { match: "link" },
  { match: "title" },
  // MS-Office namespace prefixes (o:p, o:smarttag, …) — always empty.
  { match: /^o:/ },
];

/**
 * Ordinal token that follows a LIBRO/TÍTULO/CAPÍTULO/SECCIÓN marker word.
 * Accepts three forms:
 *   - spelled-out ordinals (PRIMERO…QUINTO, plus DECIMOTERCERO…DECIMOQUINTO
 *     and the all-purpose UNICO/ÚNICO)
 *   - roman numerals (I, II, III, IV, …, XXXIX — for LIBRO / SECCIÓN)
 *   - arabic numerals (1, 2, 3, …)
 *
 * General-purpose: the list is no longer capped at "DUODÉCIMO". Long
 * códigos (Código Civil has 88 TÍTULOs and uses TÍTULO TRIGÉSIMO…) fall
 * back to the roman or arabic form when the spelled form runs out.
 */
const ORDINAL_WORDS =
  "(?:PRIMERO|PRIMER|SEGUNDO|TERCERO|CUARTO|QUINTO|SEXTO|S[EÉ]PTIMO|SETIMO|S[EÉ]TIMO|OCTAVO|OCTAVENO|NOVENO|D[EÉ]CIMO|UNDECIMO|UNDÉCIMO|DUODECIMO|DUODÉCIMO|DECIMOTERCERO|DECIMOCUARTO|DECIMOQUINTO|DECIMOSEXTO|DECIMOS[EÉ]PTIMO|DECIMOS[EÉ]TIMO|DECIMOOCTAVO|DECIMONOVENO|VIG[EÉ]SIMO|TRIG[EÉ]SIMO|TRIGESIMOPRIMERO|UNICO|ÚNICO|[IVXLCDM]+|\\d+)";

const LIBRO_WORD = "LIBRO";
const TITULO_WORD = "T[IÍ]TULO";
const CAPITULO_WORD = "CAP[IÍ]TULO";
const SECCION_WORD = "SECCI[OÓ]N";

/**
 * Default ruleset for the SINALEVI Word-Export template.
 */
export const sinaleviWordRules: Rules = {
  strip: wordStripSelectors,

  fragmentBoundary: /<html[\s>][\s\S]*?<\/html>/gi,

  // Matches the article header line in either of two source forms:
  //   ARTICULO 1º.-         (uppercase, NO accent — early articles)
  //   Artículo 700.-        (title-case, ACCENTED í — later articles)
  //   Artículo 1045.-       (4-digit — long códigos like Código Civil
  //                          run past 1000; do NOT cap the digit count)
  //   Artículo 376-         (single dash, no period)
  //   Artículo 120 bis.—    (em-dash separator, no period)
  //   ARTICULO 182 . - (...) (MS-Word split the separator across <span>s;
  //                          after inline-gluing the period and dash have
  //                          spaces between them — we allow that here)
  //   A RTICULO 103.-       (MS-Word split the very first letter "A" of
  //                          "ARTICULO" into its own <zz>; after gluing, a
  //                          single space remains between A and RTICULO)
  //   A R TICULO 182.-      (Constitución 871/147492: Word split BOTH
  //                          leading letters — "A R TICULO" after gluing)
  //   ARTICULO 1º.          (Constitución art 1: ordinal + period, no dash)
  //   Articulo 13. La…      (LJC 38533/127124: no accent, no ordinal, no
  //                          dash — bare period + space, body on the same
  //                          line. The historical period-only branch
  //                          requires horizontal whitespace after the
  //                          period; the ^ line anchor is the prose
  //                          guard — mid-sentence mentions never sit at
  //                          line start. Empirically safe: CT (724 at
  //                          that audit) and CC 1410 baselines stayed
  //                          byte-identical under this widening.)
  //   (*)Articulo 155°- ...  (Niñez 43077/143888 art 155 + CPP 41297/151404
  //                          art 437: SINALEVI prints a literal `(*)`
  //                          editorial flag at line start; the digit
  //                          follows after a single space, as in the
  //                          regular `Artículo N` form. The flag is
  //                          exact-equal `(*)` — `(**)` and other
  //                          variants are rejected, preserving the
  //                          boundary against arbitrary prose prefixes.)
  //   Articulo78.- ...      (Familia 970/145496 art 78: no whitespace
  //                          between `Articulo` and the article number;
  //                          the standard legal separator still follows.
  //                          Only the immediate-digit alternative opens;
  //                          arbitrary prose like `Articulo:` is still
  //                          rejected because the next char must be a
  //                          digit.)
  //   Articulo.530-...      (Comercio 6239/151293 art 530: a literal
  //                          period between `Articulo` and the digit,
  //                          optional horizontal whitespace, then the
  //                          digit; the legal separator ` -` (no period)
  //                          follows the digit. The period is consumed
  //                          INSIDE the article-header branch so the
  //                          existing legal-separator class is not
  //                          perturbed and the line-anchor / capture
  //                          group / suffix / ordinal discipline is
  //                          unchanged.)
  //   Articulo 97bis-       (CT 8045/150791 art 97 bis / id 205535:
  //                          zero horizontal whitespace between the
  //                          numeric base and the recognized `bis`
  //                          suffix; the suffix is exact-equal and
  //                          canonicalized to `97 bis`. Arbitrary trailing
  //                          letters like `97bisaaa` reject because the
  //                          suffix word must END the number token and the
  //                          next character must be a legal separator.)
  //   Articulo 376 quinquies- (CT 8045/150791 art 376 quinquies / id 205531:
  //                          extends the suffix vocabulary from
  //                          `bis|ter|quáter` to `bis|ter|qu[aá]ter|quinquies`.
  //                          The recognized suffix consumes zero or more
  //                          horizontal whitespace between the numeric
  //                          base and itself. The regex match alone does
  //                          NOT emit the article: the extractor admits a
  //                          `quinquies` header event ONLY for the already
  //                          trusted exact CT Word-capture context
  //                          (authority 8045 / version 150791 / template
  //                          `sinalevi-word-export`, enforced in
  //                          `extractor.ts` after number normalization).
  //                          Outside this global-regex admission the line
  //                          stays ordinary source text. Penal
  //                          5027/151473 recovers its audited
  //                          `quinquies|sexies|septies` headers through
  //                          the separate, reviewed Penal provisional
  //                          recovery seam in `extractor.ts` (gated to
  //                          authority 5027 / version 151473 / template
  //                          `sinalevi-word-export`), so their Fichas are
  //                          consumed by emitted articles; every other
  //                          capture keeps the line as ordinary source
  //                          text with its Ficha an accounted generic
  //                          gap. The Ficha terminator for
  //                          this article is the base-only
  //                          `Ficha Artículo 376` — the article is
  //                          identified entirely by its header, never by
  //                          a Ficha suffix adoption.)
  //   Articulos 274.-       (LGAP 13231/150737 art 274 / id 77341: an
  //                          exact optional plural `s` on the Word
  //                          marker (`Articulo` OR `Articulos`). The
  //                          plural forms are exact-equal, line-start-
  //                          anchored, and every other marker guard is
  //                          preserved — pluralizations beyond the exact
  //                          final `s` (e.g. `Articuloses`) reject.)
  //   Articulo 6.En caso…   (LJC 38533/127124 art 6 / id 171370: a
  //                          bare terminal period followed IMMEDIATELY by
  //                          a body-initial letter or decimal digit —
  //                          no intervening space or dash, and NOT an
  //                          arbitrary non-whitespace character. The
  //                          historical period+whitespace branch is
  //                          preserved verbatim; the new branch only
  //                          admits a Spanish-letter (disjoint Latin-1
  //                          letter ranges) or ASCII digit body start,
  //                          so `Articulo 6.: Texto`,
  //                          `Articulo 6..Texto`, `Articulo 6.;Texto`,
  //                          `Articulo 6.,Texto` and `Articulo 6.)Texto`
  //                          all reject. A bare `Articulo N.` with no
  //                          body still rejects because neither the
  //                          whitespace nor the immediate-letter/digit
  //                          lookahead matches. The lookahead's letter
  //                          side uses two DISJOINT Latin-1 ranges that
  //                          provably exclude the U+00D7 `×` and
  //                          U+00F7 `÷` mathematical symbols
  //                          (`\xC0-\xD6` + `\xD8-\xF6` + `\xF8-\xFF`),
  //                          never a contiguous range that contains
  //                          either symbol. The line-start anchor
  //                          remains the prose guard: mid-line mentions
  //                          never sit at line start.)
  // SINALEVI is inconsistent: the first ~370 articles use the legacy
  // "ARTICULO" form; the back half uses "Artículo". The separator is
  // usually ".-" but some articles use "-" or ".—" or "—". The character
  // class [IÍií] makes the regex accent- AND case-insensitive without
  // relying on the `i` flag's Unicode behavior (which Node's regex does
  // not honor for accented Latin by default).
  // Captures group 1 = the full number token. The token's number
  // grammar keeps suffix and ordinal ALTERNATIVES MUTUALLY EXCLUSIVE:
  // exactly one of { bare number, number + one exact suffix, number +
  // one ordinal marker } may match. A suffix word may never be
  // followed by an ordinal marker (`175 quinquiesº`, `175quinquies°`
  // reject) and an ordinal marker may never be followed by a suffix
  // (`155°bis` rejects) — SINALEVI printed a malformed
  // `Articulo 175 quinquiesº-` production row whose glued ordinal
  // previously normalized away and evaded the CT-only `quinquies`
  // gate; the mutual exclusion rejects that shape at the grammar so
  // the CT-only gate stays airtight. Suffix (bis/ter/quáter/quinquies)
  // is captured with optional zero-or-more horizontal whitespace
  // between the numeric base and the recognized suffix word — a
  // `quinquies` MATCH, however, only becomes an article-header EVENT
  // inside the trusted CT capture context (see `extractor.ts`);
  // everywhere else the line stays ordinary source text. The period
  // separator keeps the historical period+whitespace form and adds
  // only the bounded period+immediate-letter/digit form.
  // The `(*)` editor flag and the no-space / dot-then-digit connective
  // are alternative-prefix branches; they share the same mandatory
  // legal separator and the same capture group, so reconciliation,
  // suffix adoption, and Ficha binding all reuse the existing
  // post-match pipeline unchanged.
  articleHeader: new RegExp(
    "^[ \\t]*(?:\\(\\*\\)[ \\t]*)?" +
      "A[ \\t]*R[ \\t]*T[IÍií]CULOS?" +
      "(?:[ \\t]+|(?:\\.[ \\t]*)?)" +
      "(\\d+(?:(?:[ \\t]*(?:bis|ter|qu[aá]ter|quinquies))|(?:[ \\t]*[º°]))?)" +
      "(?:[ \\t]*\\.?[ \\t]*[-—][ \\t]*|[ \\t]*\\.[ \\t]+|[ \\t]*\\.(?=[0-9A-Za-z\\xC0-\\xD6\\xD8-\\xF6\\xF8-\\xFF]))",
    "i",
  ),

  // "Ficha Artículo N" — terminator. Line-anchored. The source writes
  // "Ficha Artículo N" (accented "í"). For bis/ter articles the label is
  // "Ficha Artículo 94  BIS" — uppercase suffix, optionally with extra
  // whitespace. We capture group 1 = the bare number and group 2 = the
  // optional suffix word, both used by the extractor to build fichaRef.
  // The adoption grammar is the CLOSED `BIS|TER|QUÁTER` set: the audited
  // CT 376 quinquies Ficha is base-only `Ficha Artículo 376`, so no
  // QUINQUIES form was ever observed and none is admitted here.
  fichaTerminator:
    /^[ \t]*Ficha[ \t]+Art[IÍií]culo[ \t]+(\d+)(?:[ \t]+(BIS|TER|QU[AÁ]TER))?[ \t]*$/i,

  /**
   * M-LAW-10 — STANDALONE transitory-provision header, line-anchored with
   * the same discipline as `articleHeader`. Observed forms:
   *   TRANSITORIO I.- Mientras tanto…           (roman ordinal + ".-")
   *   Transitorio 1º.- Regla de vigencia…       (arabic ordinal)
   *   DISPOSICIÓN TRANSITORIA 2.- …             (spelled-out singular)
   *   Transitorio al artículo 148. Por única    (CT 8045: the provision has
   *    vez, el disfrute del feriado…            no own number — it attaches
   *                                             to the article it amends)
   * Group 1 = the amended article number of the `al artículo N` form;
   * group 2 = the provision's own ordinal token (spelled, roman or arabic)
   * when it carries one. The marker word accepts either spelling of either
   * number (`TRANSITORIO`/`TRANSITORIA`, with or without a
   * `DISPOSICIÓN/ES ` prefix), because SINALEVI mixes them in one file.
   *
   * The separator class is the prose guard, identical in shape to the one
   * on `articleHeader`: a line that starts with the word "transitorio" but
   * carries no token, or a token with no ".-"/"-"/". " boundary, is
   * ordinary text. A bare section caption ("DISPOSICIONES TRANSITORIAS")
   * therefore never matches — only a numbered provision does.
   */
  transitoryHeader: new RegExp(
    "^[ \\t]*(?:DISPOSICI[OÓ]N(?:ES)?[ \\t]+)?TRANSITOR(?:IO|IA|IOS|IAS)[ \\t]+" +
      "(?:AL[ \\t]+ART[IÍ]CULO[ \\t]+(\\d+)|(" +
      ORDINAL_WORDS +
      "(?:[ \\t]*[º°])?))" +
      "(?:[ \\t]*\\.?[ \\t]*[-—][ \\t]*|[ \\t]*\\.[ \\t]+)",
    "i",
  ),

  // Hierarchy rules — checked in this order. Only explicit marker forms
  // create hierarchy nodes. A descriptive all-caps line that follows a
  // marker becomes the node's displayLabel (consumed by the extractor),
  // never a standalone hierarchy node.
  headingRules: [
    {
      // "LIBRO I", "LIBRO II", "LIBRO III", "LIBRO IV" (roman). The
      // Código Civil is organized this way; long códigos often start
      // with a top-level LIBRO division. LIBRO is checked FIRST so
      // a top-of-document LIBRO sets the level correctly before any
      // inner TÍTULO / CAPÍTULO appears.
      kind: "libro",
      match: new RegExp(
        `^[ \\t]*${LIBRO_WORD}[ \\t]+${ORDINAL_WORDS}(?:[ \\t]*\\(\\*\\))?[ \\t]*$`,
        "i",
      ),
    },
    {
      kind: "titulo",
      // "TITULO PRIMERO", "TÍTULO DUODÉCIMO" — case-insensitive on the
      // accent; the ordinal is case-insensitive too. Trailing marker junk
      // like "(*)" is allowed (some TÍTULOs carry footnote flags).
      match: new RegExp(
        `^[ \\t]*${TITULO_WORD}[ \\t]+${ORDINAL_WORDS}(?:[ \\t]*\\(\\*\\))?[ \\t]*$`,
        "i",
      ),
    },
    {
      kind: "capitulo",
      match: new RegExp(
        `^[ \\t]*${CAPITULO_WORD}[ \\t]+${ORDINAL_WORDS}[ \\t]*$`,
        "i",
      ),
    },
    {
      kind: "seccion",
      match: new RegExp(
        `^[ \\t]*${SECCION_WORD}[ \\t]+${ORDINAL_WORDS}[ \\t]*$`,
        "i",
      ),
    },
  ],

  /**
   * Normalize the captured number token.
   *   "1º"        -> { number: "1",        ordinalRaw: "1º" }
   *   "85 bis"    -> { number: "85 bis",   ordinalRaw: "" }
   *   "97bis"     -> { number: "97 bis",   ordinalRaw: "" }
   *   "7 quáter"  -> { number: "7 quáter", ordinalRaw: "" }
   *   "7 quater"  -> { number: "7 quáter", ordinalRaw: "" }
   *   "7 qua\u0301ter" -> { number: "7 qu\u00E1ter" = "7 quáter", ordinalRaw: "" }
   *   "376 quinquies" -> { number: "376 quinquies", ordinalRaw: "" }
   *   "175 sexies" -> { number: "175 sexies", ordinalRaw: "" }
   *   "175 septies" -> { number: "175 septies", ordinalRaw: "" }
   *   "1°"        -> { number: "1",        ordinalRaw: "1°" }
   *
   * The no-whitespace suffix form (`97bis`) is canonicalized to the
   * same `{base} {suffix}` shape as the spaced form. The trailing
   * suffix word must END the token (the suffix regex anchors with `$`)
   * so adversarial inputs like `97bisaaa` still reject — the upstream
   * header regex itself also requires the suffix word to be followed
   * by a legal separator, which is the outer prose guard.
   *
   * The `quater` family of the suffix regex accepts plain `quater`,
   * composed `qu\u00E1ter`, and decomposed `qua\u0301ter` (U+0061 +
   * U+0301); the NFC normalization in the canonicalization step folds
   * the decomposed input into the composed form so all three
   * equivalent spellings emit the same `qu\u00E1ter` coordinate.
   *
   * `sexies` and `septies` are the audited Penal-only suffix additions
   * for the Word template parser. They are recognized in
   * `normalizeNumber` so the shared suffix-vs-suffix adoption check
   * (`headerHasSuffix`) and the reconciliation against the suffix-bearing
   * Ficha caption agree on the canonical coordinate. HEADER emission of
   * these suffixes is bounded to the reviewed provisional Penal seam
   * in `extractor.ts` — the global `articleHeader` regex above does
   * NOT widen, so every other capture stays ordinary source text and
   * its Ficha stays an accounted generic gap.
   *
   * Suffix and ordinal are MUTUALLY EXCLUSIVE alternatives in the
   * upstream capture grammar, so a combined token like
   * `175 quinquiesº` can never reach this function through
   * `articleHeader`; the ordinal and suffix regexes below therefore
   * never both match the same token. The fallback branch exists for
   * non-`articleHeader` callers only. Defense in depth for that
   * fallback: a token that fuses a recognized suffix AND a trailing
   * ordinal marker (any case, any space/tab/NBSP spacing) is
   * noncanonical by construction and is returned VERBATIM (never
   * collapsed to the bare base) so a malformed glued form can never
   * normalize to a bare numeric coordinate.
   */
  normalizeNumber(raw: string): { number: string; ordinalRaw: string } {
    const trimmed = raw.trim();
    const ordinal = /^(\d+)\s*([º°])\s*$/.exec(trimmed);
    if (ordinal) {
      return { number: ordinal[1]!, ordinalRaw: trimmed };
    }
    const suffix = /^(\d+)\s*(bis|ter|qu(?:a\u0301|\u00E1|a)ter|quinquies|sexies|septies)$/i.exec(trimmed);
    if (suffix) {
      // NFC normalization folds a decomposed `qua\u0301ter` (U+0061 +
      // U+0301) into the composed `qu\u00E1ter` so all three
      // equivalent spellings (plain `quater`, composed `qu\u00E1ter`,
      // decomposed `qua\u0301ter`) collapse to one canonical
      // composed suffix. The `quater → qu\u00E1ter` replace then
      // canonicalizes the no-accent spelling the same way it always
      // has; the composed spelling is already canonical after NFC
      // and the replace is a no-op for it.
      const canon = suffix[2]!
        .toLowerCase()
        .normalize("NFC")
        .replace("quater", "qu\u00E1ter");
      return { number: `${suffix[1]} ${canon}`, ordinalRaw: "" };
    }
    if (/^\d+$/.test(trimmed)) {
      return { number: trimmed, ordinalRaw: "" };
    }
    // Malformed fused suffix+ordinal token (e.g. `175 quinquiesº`):
    // noncanonical by the mutual-exclusion contract above — return it
    // verbatim so no caller can mistake it for the bare base `175`.
    return { number: trimmed, ordinalRaw: "" };
  },

  /** Collapse runs of in-line whitespace (preserves newlines). */
  whitespaceCollapse: /[ \t\f\v]+/g,
};

/**
 * Ruleset for the SINALEVI TREATY template family (CADH / Pacto de San
 * José, OIT convenios). Observed 2026-07-29 (CRAWL-5): article headers are
 * a bare "Articulo N" (or uppercase "ARTICULO N") with NO ".-"/"."/"—"
 * separator — the title or body follows directly, on the same line or the
 * next. `Ficha Artículo N` terminators are identical to the Word template.
 *
 * The negative lookahead after the number token is the load-bearing part:
 *   - it REJECTS the ratification-shell form "ARTICULO 1º.- Ratifícanse…"
 *     that precedes the convention text inside multi-convention approval
 *     fichas (Ley 2561), so the shell lands in frontMatter instead of
 *     colliding with the convention's own art. 1–2;
 *   - it rejects prose forms like "Artículo 19, párrafo 5º…" at line start.
 * A treaty header using a separator would therefore NOT match — that is
 * deliberate fail-loud behavior (article/Ficha count mismatch surfaces in
 * warnings) rather than risking shell/prose capture.
 *
 * Hierarchy: treaties use PARTE as the top division (mapped to `libro`);
 * CAPÍTULO/SECCIÓN reuse the Word rules.
 *
 * `sinaleviWordRules` is intentionally NOT widened — the 12 shipped
 * códigos are byte-pinned against it.
 */
export const sinaleviTreatyRules: Rules = {
  ...sinaleviWordRules,

  articleHeader: new RegExp(
    "^[ \\t]*A[ \\t]*R[ \\t]*T[IÍií]CULO[ \\t]+" +
      "(\\d+(?:[ \\t]+(?:bis|ter|qu[aá]ter))?(?:[ \\t]*[º°])?)" +
      "(?![ \\t]*[.,;:\\-—])" +
      "(?:[ \\t]+|$)",
    "i",
  ),

  headingRules: [
    {
      kind: "libro",
      match: new RegExp(
        `^[ \\t]*PARTE[ \\t]+${ORDINAL_WORDS}[ \\t]*$`,
        "i",
      ),
    },
    ...sinaleviWordRules.headingRules,
  ],
};