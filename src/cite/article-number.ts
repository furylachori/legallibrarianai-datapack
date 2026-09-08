/**
 * Shared article-number / citation-shadow normalizer (MCP-1 §5).
 *
 * One definition used by `detectReferences` (before `resolveCitation`) and by
 * the MCP coordinate lookup. Fixed order, pinned by engine + MCP regressions:
 *
 *   1. trim;
 *   2. remove the ordinal marker `º`/`°` ONLY when it follows a decimal
 *      numeral and precedes the end of the token or a supported suffix —
 *      BEFORE any compatibility normalization, because NFKC turns `º` into
 *      the letter `o` and would erase the marker;
 *   3. NFKC (full-width digits fold to ASCII; decomposed `a` + U+0301 folds
 *      to `á`);
 *   4. collapse whitespace;
 *   5. canonicalize the suffix case-insensitively: `bis`/`ter` lowercase,
 *      `quater`/`quáter` map to `quáter`.
 *
 * Invalid forms survive steps 1–4 in a lowercased shape that can never match
 * {@link CANONICAL_ARTICLE_NUMBER_RE}; callers treat that as invalid.
 */

/** The closed canonical grammar every projected/frozen identity must match.
 *  `bis` / `ter` / `quáter` / `quinquies` / `sexies` / `septies` are the
 *  six recognized Latin suffixes for the SINALEVI Word-export template;
 *  every other suffix form is rejected by the citation engine. `sexies`
 *  and `septies` are the audited Penal-only additions — their NORMALIZED
 *  canonical form is admitted everywhere (so MCP coordinates and detector
 *  matches stay uniform), but their HEADER emission is bounded to the
 *  reviewed provisional Penal seam in `extractor.ts` and the existing
 *  CT-only `quinquies` admission. */
export const CANONICAL_ARTICLE_NUMBER_RE =
  /^[0-9]+(?: (?:bis|ter|quáter|quinquies|sexies|septies))?$/;

/** A suffix spelling (bis/ter/quáter/quinquies/sexies/septies) in composed,
 *  decomposed, or plain form. */
const SUFFIX_ALT =
  "bis|ter|qu(?:a\\u0301|\\u00E1|a)ter|quinquies|sexies|septies";

/**
 * Regex source for one article number in free prose (NO capture groups of its
 * own — wrap it in `(...)` at the use site): ASCII or full-width decimal
 * digits, an optional contextual ordinal marker, and an optional bis/ter/
 * quáter/quinquies/sexies/septies suffix in composed or decomposed spelling.
 * Always used with the case-insensitive flag (uppercase suffixes pin).
 *
 * The suffix has a Unicode boundary; the detector then checks the code point
 * immediately after the greedy match with
 * `hasGluedArticleNumberContinuation`. The post-check also catches the narrow
 * uppercase malformed-suffix backtrack without rejecting valid prose such as
 * `artículo 28 termina` merely because the next word begins with `ter`.
 */
export const ARTICLE_NUMBER_CAPTURE_SRC =
  `[0-9\\uFF10-\\uFF19]+(?:\\s*[\\u00BA\\u00B0])?` +
  `(?:\\s+(?:${SUFFIX_ALT})(?![\\p{L}\\p{N}\\p{M}\\u00AA\\u00BA\\u00B0]))?`;

/**
 * True when the character following the greedy match extends it into a
 * larger Unicode token. Whitespace and punctuation are honest boundaries,
 * so `artículo 28 termina` remains a citation while `28abc`, `28α`,
 * `28漢`, `1ºx`, `261 BIScuarto`, and `261 Biscuarto` do not.
 *
 * Categories considered "glued continuation":
 *  - Unicode letters, numbers, marks (\p{L}\p{N}\p{M})
 *  - Ordinal/sexagesimal markers U+00AA, U+00BA, U+00B0
 *  - Compatibility, mathematical, and enclosed symbols (`\p{S}`) — the
 *    single-letter `ⓧ` (U+24E7), the digit-in-circle `①`, the parenthesized
 *    `(a)` variants, etc. They visually CONTAIN an alphanumeric so a
 *    number followed by one is a malformed larger token.
 *  - Format characters (\p{Cf}) — zero-width space (U+200B), zero-width
 *    non-joiner (U+200C), zero-width joiner (U+200D), left/right-to-left
 *    marks (U+200E, U+200F), word joiner (U+2060), BOM/ZWNBSP (U+FEFF),
 *    bidi controls, etc. An invisible char between digits and a legal
 *    suffix turns `85\u200Bbis` into a malformed glued token.
 */
const GLUED_CONTINUATION_RE =
  /[\p{L}\p{N}\p{M}\p{S}\p{Cf}\u00AA\u00BA\u00B0]/u;

/**
 * Uppercase malformed suffix — `BIS` / `TER` / `QUÁTER` / `QUINQUIES` /
 * `SEXIES` / `SEPTIES` glued to a lowercase continuation. Already pinned
 * by an earlier review fix: a lawyer who types `BIScuarto` is clearly
 * attempting the legal suffix and slipping into more text; rejecting the
 * whole token preserves the invariant that the citation engine never
 * resolves a malformed larger token as a shorter article.
 */
const CASED_MALFORMED_SUFFIX_RE =
  /^\s+(?:BIS|TER|QU(?:A\u0301|Á|A)TER|QUINQUIES|SEXIES|SEPTIES|Bis|Ter|Qu(?:a\u0301|á|a)ter|Quinquies|Sexies|Septies)[\p{L}\p{N}\p{M}\p{S}\p{Cf}\u00AA\u00BA\u00B0]/u;

/** Lowercase suffix-shaped words are ambiguous with ordinary Spanish prose.
 * Fail closed when a canonical suffix is visibly continued inside the same
 * word/token, but preserve the common real prose families that can follow a
 * valid article number (`termina`, `tercero`, `terreno`, `bisagra`, etc.). */
const LOWERCASE_MALFORMED_SUFFIX_RE =
  /^\s+((?:bis|ter|qu(?:a\u0301|á|a)ter|quinquies|sexies|septies)(?=[\p{L}\p{N}\p{M}\p{S}\p{Cf}])[\p{L}\p{N}\p{M}\p{S}\p{Cf}]*)/u;
const ORDINARY_SUFFIX_PREFIX_PROSE_RE =
  /^(?:bisagras?|bisiest(?:o|a|os|as)|bisabuel(?:o|a|os|as)|tercer(?:o|a|os|as)?|terren(?:o|a|os|as)|terrestr(?:e|es)|terremotos?|termin[\p{L}\p{M}]*|terapi[\p{L}\p{M}]*)$/u;

/** Invalid numeric punctuation glued directly to an otherwise-valid integer.
 * Punctuation is normally an honest prose boundary, but `1.5`, `1,5`,
 * `1-2`, `1/2`, `12:00`, `1..2`, and `1.º` must not resolve partially as
 * article `1` / `12`. Whitespace deliberately is not accepted between the
 * punctuation and following token code point, preserving sentence/list
 * boundaries. */
const MALFORMED_NUMERIC_CONTINUATION_RE =
  /^[.,:/-]+[\p{L}\p{N}\p{M}\p{So}\p{Cf}\u00AA\u00BA\u00B0]/u;

/**
 * True when a greedy article-number match ends inside a larger Unicode
 * token. Whitespace and punctuation are honest boundaries, so
 * `artículo 28 termina` remains a citation while `28abc`, `28α`,
 * `28漢`, `1ºx`, `261 BIScuarto`, and `261 Biscuarto` do not.
 *
 * Two failure modes are guarded:
 *  - Direct glued continuation (GLUED_CONTINUATION_RE catches letters,
 *    digits, marks, ordinal markers, compatibility / enclosed-letter
 *    symbols, and format/control characters — so `28ⓧ`, `85\u200Bbis`,
 *    `85\u2060bis` are all rejected before the suffix regex sees them).
 *  - Suffix-glued-to-prose (the two MALFORMED_SUFFIX_RE patterns),
 *    which fires only when the suffix regex BACKTRACKS because the next
 *    code point is a letter — a case the boundary check itself can't
 *    surface because the regex already gave up.
 */
export function hasGluedArticleNumberContinuation(
  text: string,
  matchEnd: number,
): boolean {
  const tail = text.slice(matchEnd);
  const next = Array.from(tail)[0];
  if (next !== undefined && GLUED_CONTINUATION_RE.test(next)) return true;
  if (CASED_MALFORMED_SUFFIX_RE.test(tail)) return true;
  if (MALFORMED_NUMERIC_CONTINUATION_RE.test(tail)) return true;
  // Compatibility punctuation (for example full-width `．`) must be
  // judged by the same continuation grammar as ASCII punctuation. Normalize
  // only a bounded lookahead; the cited text itself remains untouched.
  const normalizedTail = Array.from(tail).slice(0, 64).join("").normalize("NFKC");
  if (MALFORMED_NUMERIC_CONTINUATION_RE.test(normalizedTail)) return true;
  const lowercaseGlue = LOWERCASE_MALFORMED_SUFFIX_RE.exec(tail);
  if (lowercaseGlue) {
    const word = lowercaseGlue[1]!.normalize("NFC");
    if (!ORDINARY_SUFFIX_PREFIX_PROSE_RE.test(word)) return true;
  }
  return false;
}

/** Ordinal marker removal: digit-anchored, end- or suffix-lookahead. */
const ORDINAL_STRIP_RE =
  /([0-9\uFF10-\uFF19])\s*[\u00BA\u00B0](?=\s*(?:(?:bis|ter|qu(?:a\u0301|\u00E1|a)ter|quinquies|sexies|septies))?\s*$)/gi;

/** Whole-token shape after steps 1–4: digits + optional canonical suffix. */
const SHAPED_TOKEN_RE =
  /^([0-9]+)(?: (bis|ter|qu(?:a\u0301|\u00E1|a)ter|quinquies|sexies|septies))?$/i;

function canonicalSuffix(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower === "bis" ||
    lower === "ter" ||
    lower === "quinquies" ||
    lower === "sexies" ||
    lower === "septies"
  ) {
    return ` ${lower}`;
  }
  if (/^qu(?:a\u0301|\u00E1|a)ter$/.test(lower)) return " quáter";
  return ` ${lower}`;
}

/**
 * Normalize one captured/raw article-number token to the canonical grammar,
 * ordinal-before-NFKC. The result matches
 * {@link CANONICAL_ARTICLE_NUMBER_RE} exactly when the input was a valid
 * article-number spelling.
 */
export function normalizeArticleNumber(raw: string): string {
  let token = raw.trim();
  if (token.length === 0) return "";
  token = token.replace(ORDINAL_STRIP_RE, "$1");
  token = token.normalize("NFKC");
  token = token.replace(/\s+/g, " ").trim();
  const shaped = SHAPED_TOKEN_RE.exec(token);
  if (!shaped) return token.toLowerCase();
  const digits = shaped[1]!;
  const suffix = shaped[2];
  return suffix ? `${digits}${canonicalSuffix(suffix)}` : digits;
}

/** True when `value` already matches the closed canonical grammar. */
export function isCanonicalArticleNumber(value: string): boolean {
  return CANONICAL_ARTICLE_NUMBER_RE.test(value);
}
