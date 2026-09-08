/**
 * Strict reviewed input catalog and capture-sidecar parsers
 * (`SINALEVI_CORPUS_AND_PRIVATE_RULINGS_PLAN.md` §4.1, §5.1–§5.4, §6.1,
 * §7, §11.2, §11.4).
 *
 * The reviewed input catalog (`corpus-sources/v1/reviewed-input-catalog.json`)
 * is the committed POLICY/EXPECTATIONS artifact: authority/version handles,
 * template/fingerprint, expected source-unit ledger, article/transitory/gap/
 * exclusion expectations, capture digests/byte counts, and profile
 * membership. The mandatory per-capture sidecar records acquisition
 * provenance (request/response, capture tool, artifacts, observed handler
 * accounting). `assertReviewedCaptureSidecarsMatchCatalog` is the coverage
 * gate between the two.
 *
 * Hard rules (each enforced by `reviewed-input-catalog.test.ts`):
 *   - pure policy module: NO filesystem, crypto, gzip, candidate, build,
 *     manifest, or builder data ever crosses this boundary;
 *   - exact own-key sets compared POSITIONALLY with `Reflect.ownKeys` at
 *     every level; symbols, accessors, non-enumerable extras, missing,
 *     extra, or reordered keys, non-plain prototypes, sparse arrays, and
 *     array extra properties all reject fail-closed;
 *   - nothing is coerced, normalized, repaired, or defaulted — reviewed
 *     data must already be canonical (NFC, trimmed, digest-stable);
 *   - the byte parsers are the mandatory file boundary: a real recursive
 *     JSON lexical pass (no regex) rejects duplicate decoded member names
 *     per object (including escape-equivalent spellings), BOM, malformed
 *     UTF-8, trailing content, signed/fractional/exponent/`-0`/
 *     leading-zero number lexemes, and unpaired surrogate escapes;
 *   - outputs are freshly allocated, recursively frozen plain objects and
 *     dense arrays that retain no caller-owned references;
 *   - errors are `ReviewedInputError` with a fixed code and the fixed
 *     content-free message for that code — hostile field values never
 *     appear in a message, and internal provenance is CALL-SCOPED: only a
 *     failure minted under the currently active public call keeps its
 *     specific internal code. Errors replayed from a completed call, from
 *     a nested/reentrant public call, from another API, or from
 *     caller/proxy code are remapped to the destination boundary's fixed
 *     default code.
 */
import { normalizeFichaCaption } from "../sinalevi/source-unit.js";
import { sinaleviWordRules } from "../sinalevi/rules.js";

// ---------------------------------------------------------------------------
// Version / path / source constants
// ---------------------------------------------------------------------------

export const REVIEWED_INPUT_CATALOG_FORMAT_VERSION = 1;
export const REVIEWED_CAPTURE_SIDECAR_FORMAT_VERSION = 1;
export const REVIEWED_INPUT_CATALOG_PATH =
  "corpus-sources/v1/reviewed-input-catalog.json";
export const SINALEVI_CAPTURE_ENDPOINT =
  "https://sinalevi.go.cr/ResultadosNormativa/_CargarTextoCompleto";

// ---------------------------------------------------------------------------
// Strict readonly domain types
// ---------------------------------------------------------------------------

export type ReviewedTemplateId =
  | "sinalevi-word-export"
  | "sinalevi-treaty-export";

export type ReviewedFrontMatterState = "absent" | "empty" | "present";

export type KnownGapReason =
  | "source-text-unavailable"
  | "unconsumed-article-terminator"
  | "transitorio-terminator-without-standalone-unit"
  | "transitorio-inside-article-body";

export type ReviewedExclusionReason =
  | "source-elimination-notice"
  | "source-renumber-redirect-notice";

export type ReviewedLedgerRowKind =
  | "emitted-article"
  | "emitted-transitory"
  | "known-gap"
  | "reviewed-exclusion";

/** Common fields of every expected-ledger row. */
interface ReviewedLedgerRowBase {
  readonly sourceUnitId: number;
  readonly domOrder: number;
  readonly caption: string;
}

/** Emitted rows require `unitLabel` and declare `reason` NOWHERE: this repo
 *  does not enable `exactOptionalPropertyTypes`, so a `reason?: never`
 *  marker would still accept an explicit `reason: undefined` on fresh
 *  literals. Full property absence makes the excess-property check reject
 *  any `reason`, including `undefined`. Runtime exact-key validation stays
 *  the authoritative guard for widened or intermediate structurally typed
 *  variables, because TypeScript offers no general exact object types. */
export interface ReviewedEmittedLedgerRow extends ReviewedLedgerRowBase {
  readonly kind: "emitted-article" | "emitted-transitory";
  readonly unitLabel: string;
}

/** Gap/exclusion rows require `reason` and declare `unitLabel` NOWHERE for
 *  the same explicit-undefined reason as above. */
export interface ReviewedGapLedgerRow extends ReviewedLedgerRowBase {
  readonly kind: "known-gap";
  readonly reason: KnownGapReason;
}

export interface ReviewedExclusionLedgerRow extends ReviewedLedgerRowBase {
  readonly kind: "reviewed-exclusion";
  readonly reason: ReviewedExclusionReason;
}

export type ReviewedLedgerRow =
  | ReviewedEmittedLedgerRow
  | ReviewedGapLedgerRow
  | ReviewedExclusionLedgerRow;

export interface ReviewedProfileMembership {
  readonly app: boolean;
  readonly mcp: boolean;
}

export interface ReviewedCatalogTemplate {
  readonly id: ReviewedTemplateId;
  readonly fingerprint: string;
  readonly allowsZeroFicha: boolean;
}

export interface ReviewedCaptureIdentity {
  readonly gzipPath: string;
  readonly sidecarPath: string;
  readonly rawSha256: string;
  readonly gzipSha256: string;
  readonly uncompressedBytes: number;
}

export interface ReviewedClassificationCounts {
  readonly emittedArticles: number;
  readonly emittedTransitories: number;
  readonly knownGaps: number;
  readonly reviewedExclusions: number;
  readonly total: number;
}

export interface ReviewedAuthorityExpectations {
  readonly frontMatter: ReviewedFrontMatterState;
  readonly classifications: ReviewedClassificationCounts;
  readonly sourceUnitCoordinates: number;
  readonly ledger: readonly ReviewedLedgerRow[];
}

export interface ReviewedCatalogAuthority {
  readonly slug: string;
  readonly authorityId: number;
  readonly versionId: number;
  readonly profileMembership: ReviewedProfileMembership;
  readonly template: ReviewedCatalogTemplate;
  readonly capture: ReviewedCaptureIdentity;
  readonly expectations: ReviewedAuthorityExpectations;
}

export interface ReviewedCatalogTotals {
  readonly authorities: number;
  readonly appAuthorities: number;
  readonly mcpAuthorities: number;
  readonly emittedArticles: number;
  readonly emittedTransitories: number;
  readonly knownGaps: number;
  readonly reviewedExclusions: number;
  readonly ledgerEntries: number;
  readonly sourceUnitCoordinates: number;
  readonly frontMatterAbsent: number;
  readonly frontMatterEmpty: number;
  readonly frontMatterPresent: number;
}

export interface ReviewedInputCatalog {
  readonly formatVersion: typeof REVIEWED_INPUT_CATALOG_FORMAT_VERSION;
  readonly totals: ReviewedCatalogTotals;
  readonly authorities: readonly ReviewedCatalogAuthority[];
}

export interface ReviewedCaptureSidecarHandle {
  readonly authorityId: number;
  readonly versionId: number;
}

export interface ReviewedCaptureSidecarTemplate {
  readonly id: ReviewedTemplateId;
  readonly fingerprint: string;
}

export interface ReviewedCaptureRequest {
  readonly method: "POST";
  readonly endpoint: typeof SINALEVI_CAPTURE_ENDPOINT;
}

export interface ReviewedCaptureContentType {
  readonly mediaType: "application/json";
  readonly charset: "utf-8" | null;
}

export interface ReviewedCaptureResponse {
  readonly status: 200;
  readonly contentType: ReviewedCaptureContentType;
  readonly capturedAt: string;
}

export interface ReviewedCaptureTool {
  readonly name: "sinalevi-fetch";
  readonly version: string;
}

export interface ReviewedObservedHandlers {
  readonly fichaAnchors: number;
  readonly parsedHandlers: number;
  readonly articleKind: number;
  readonly transitoryKind: number;
  readonly zeroFicha: number;
  readonly authorityFicha: number;
  readonly versionMatched: number;
  readonly distinctSourceUnitIds: number;
}

export interface ReviewedCaptureSidecar {
  readonly formatVersion: typeof REVIEWED_CAPTURE_SIDECAR_FORMAT_VERSION;
  readonly slug: string;
  readonly requestedHandle: ReviewedCaptureSidecarHandle;
  readonly template: ReviewedCaptureSidecarTemplate;
  readonly request: ReviewedCaptureRequest;
  readonly response: ReviewedCaptureResponse;
  readonly captureTool: ReviewedCaptureTool;
  readonly artifacts: ReviewedCaptureIdentity;
  readonly observedHandlers: ReviewedObservedHandlers;
}

export interface ReviewedCaptureSidecarDocument {
  readonly path: string;
  readonly sidecar: ReviewedCaptureSidecar;
}

// ---------------------------------------------------------------------------
// Typed error — fixed codes only, never hostile field values
// ---------------------------------------------------------------------------

export type ReviewedInputErrorCode =
  | "catalog-version"
  | "catalog-invalid"
  | "capture-sidecar-version"
  | "capture-sidecar-invalid"
  | "capture-sidecar-coverage";

/**
 * Fixed, content-free default message per error code. Caller/proxy-thrown
 * failures are remapped to the current API boundary's fixed default code and
 * this message, so attacker-controlled text never reaches a caller.
 */
const FIXED_DEFAULT_MESSAGES: Readonly<
  Record<ReviewedInputErrorCode, string>
> = Object.freeze({
  "catalog-version": "reviewed input rejected at the reviewed input catalog boundary",
  "catalog-invalid": "reviewed input rejected at the reviewed input catalog boundary",
  "capture-sidecar-version":
    "reviewed input rejected at the reviewed capture sidecar boundary",
  "capture-sidecar-invalid":
    "reviewed input rejected at the reviewed capture sidecar boundary",
  "capture-sidecar-coverage":
    "reviewed input rejected at the reviewed sidecar coverage boundary",
});

/**
 * The public typed error carries a fixed code and the fixed content-free
 * message for that code. Arbitrary caller messages are not accepted, and
 * every instance a public API throws is freshly built here from an
 * immutable recorded code.
 */
export class ReviewedInputError extends Error {
  public readonly code: ReviewedInputErrorCode;

  constructor(code: ReviewedInputErrorCode) {
    super(FIXED_DEFAULT_MESSAGES[code]);
    this.name = "ReviewedInputError";
    this.code = code;
  }
}

/**
 * Private per-call provenance. Every public API invocation installs a fresh
 * token; an internal failure records its immutable code plus the token that
 * was active when it was minted, OUTSIDE any caller-visible error property.
 * Trust is decided purely by object identity (`WeakMap` lookup, which fires
 * no proxy trap and reads no mutable `name`/`message`/`code`/`stack`/
 * `cause`/prototype/getter) plus exact token equality.
 */
interface MintedFailure {
  readonly code: ReviewedInputErrorCode;
  readonly token: object;
}

const MINTED_FAILURES = new WeakMap<object, MintedFailure>();

/** Token of the public call currently executing, or `null` outside one. */
let activeCallToken: object | null = null;

function makeInternalError(
  code: ReviewedInputErrorCode,
  message: string,
): ReviewedInputError {
  const error = new ReviewedInputError(code);
  // Structural label/reason text stays on the internal object for local
  // debugging only; the boundary never lets this instance escape.
  error.message = message;
  if (activeCallToken !== null) {
    MINTED_FAILURES.set(error, { code, token: activeCallToken });
  }
  return error;
}

/**
 * The immutable internal code recorded for `error`, but only when `error`
 * was minted under EXACTLY `token`. Anything else — a foreign object, a
 * spoof, a proxy wrapper, or an internal failure from a completed or
 * nested call — yields `null`.
 */
function recordedCodeForCall(
  error: unknown,
  token: object,
): ReviewedInputErrorCode | null {
  const minted = MINTED_FAILURES.get(error as object);
  if (minted === undefined || minted.token !== token) return null;
  return minted.code;
}

interface Codes {
  readonly invalid: ReviewedInputErrorCode;
  readonly version: ReviewedInputErrorCode;
}

const CATALOG_CODES: Codes = {
  invalid: "catalog-invalid",
  version: "catalog-version",
};

const SIDECAR_CODES: Codes = {
  invalid: "capture-sidecar-invalid",
  version: "capture-sidecar-version",
};

const COVERAGE_CODES: Codes = {
  invalid: "capture-sidecar-coverage",
  version: "capture-sidecar-coverage",
};

function fail(code: ReviewedInputErrorCode, label: string, reason: string): never {
  // Messages carry only structural labels (paths, indices, fixed reasons) —
  // never a hostile field value. The minted failure is bound to the active
  // call so the boundary can distinguish it from replayed/foreign objects.
  throw makeInternalError(code, `reviewed input [${label}] ${reason}`);
}

/**
 * The single synchronous public-API boundary. It installs a fresh call
 * token (restoring the previous one on the way out, so reentrant parser
 * calls from hostile traps cannot strand it), and converts every failure
 * into a FRESH `ReviewedInputError`: the recorded internal code when the
 * caught object was minted under this exact active call, otherwise this
 * boundary's fixed default code.
 */
function boundary<T>(code: ReviewedInputErrorCode, fn: () => T): T {
  const token = {};
  const outer = activeCallToken;
  activeCallToken = token;
  try {
    return fn();
  } catch (error) {
    throw new ReviewedInputError(recordedCodeForCall(error, token) ?? code);
  } finally {
    activeCallToken = outer;
  }
}

// ---------------------------------------------------------------------------
// Closed vocabularies and exact key sets
// ---------------------------------------------------------------------------

const CATALOG_ROOT_KEYS = ["formatVersion", "totals", "authorities"] as const;
const TOTALS_KEYS = [
  "authorities",
  "appAuthorities",
  "mcpAuthorities",
  "emittedArticles",
  "emittedTransitories",
  "knownGaps",
  "reviewedExclusions",
  "ledgerEntries",
  "sourceUnitCoordinates",
  "frontMatterAbsent",
  "frontMatterEmpty",
  "frontMatterPresent",
] as const;
const AUTHORITY_KEYS = [
  "slug",
  "authorityId",
  "versionId",
  "profileMembership",
  "template",
  "capture",
  "expectations",
] as const;
const PROFILE_KEYS = ["app", "mcp"] as const;
const CATALOG_TEMPLATE_KEYS = ["id", "fingerprint", "allowsZeroFicha"] as const;
const CAPTURE_IDENTITY_KEYS = [
  "gzipPath",
  "sidecarPath",
  "rawSha256",
  "gzipSha256",
  "uncompressedBytes",
] as const;
const EXPECTATIONS_KEYS = [
  "frontMatter",
  "classifications",
  "sourceUnitCoordinates",
  "ledger",
] as const;
const CLASSIFICATIONS_KEYS = [
  "emittedArticles",
  "emittedTransitories",
  "knownGaps",
  "reviewedExclusions",
  "total",
] as const;
const EMITTED_ROW_KEYS = [
  "kind",
  "sourceUnitId",
  "domOrder",
  "caption",
  "unitLabel",
] as const;
const REASON_ROW_KEYS = [
  "kind",
  "sourceUnitId",
  "domOrder",
  "caption",
  "reason",
] as const;
const SIDECAR_ROOT_KEYS = [
  "formatVersion",
  "slug",
  "requestedHandle",
  "template",
  "request",
  "response",
  "captureTool",
  "artifacts",
  "observedHandlers",
] as const;
const HANDLE_KEYS = ["authorityId", "versionId"] as const;
const SIDECAR_TEMPLATE_KEYS = ["id", "fingerprint"] as const;
const REQUEST_KEYS = ["method", "endpoint"] as const;
const RESPONSE_KEYS = ["status", "contentType", "capturedAt"] as const;
const CONTENT_TYPE_KEYS = ["mediaType", "charset"] as const;
const CAPTURE_TOOL_KEYS = ["name", "version"] as const;
const OBSERVED_HANDLER_KEYS = [
  "fichaAnchors",
  "parsedHandlers",
  "articleKind",
  "transitoryKind",
  "zeroFicha",
  "authorityFicha",
  "versionMatched",
  "distinctSourceUnitIds",
] as const;
const DOCUMENT_KEYS = ["path", "sidecar"] as const;

const TEMPLATE_IDS: readonly string[] = [
  "sinalevi-word-export",
  "sinalevi-treaty-export",
];
const FRONT_MATTER_STATES: readonly string[] = ["absent", "empty", "present"];
const KNOWN_GAP_REASONS: readonly string[] = [
  "source-text-unavailable",
  "unconsumed-article-terminator",
  "transitorio-terminator-without-standalone-unit",
  "transitorio-inside-article-body",
];
const EXCLUSION_REASONS: readonly string[] = [
  "source-elimination-notice",
  "source-renumber-redirect-notice",
];
const TRANSITORIO_GAP_REASONS: readonly string[] = [
  "transitorio-terminator-without-standalone-unit",
  "transitorio-inside-article-body",
];

const FICHA_CAPTION_PREFIX = "Ficha Artículo ";
const TRANSITORIO_CAPTION_SUFFIX = " Transitorio";
const MAX_CAPTION_CODE_UNITS = 512;
const MAX_LABEL_CODE_UNITS = 512;
const MAX_SLUG_CODE_UNITS = 64;

const SLUG_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256_RE = /^[0-9a-f]{64}$/;
const CAPTURE_TOOL_VERSION_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const CAPTURED_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const UNICODE_CONTROL_RE = /[\p{Cc}\p{Cf}]/u;
const CANONICAL_ARTICLE_NUMBER_RE =
  /^(?:0|[1-9][0-9]*)(?: (?:bis|ter|quáter|quinquies|sexies|septies))?$/;

// ---------------------------------------------------------------------------
// Exact positional own-key snapshot helpers
// ---------------------------------------------------------------------------

function snapObject(
  value: unknown,
  keys: readonly string[],
  label: string,
  code: ReviewedInputErrorCode,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, label, "expected a plain object");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, label, "expected a plain-object prototype");
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) {
    fail(code, label, `expected exactly ${String(keys.length)} own keys`);
  }
  for (let i = 0; i < keys.length; i += 1) {
    if (own[i] !== keys[i]) {
      fail(code, label, "own keys must match exactly and in the reviewed order");
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (
      desc === undefined ||
      !("value" in desc) ||
      desc.enumerable !== true
    ) {
      fail(code, label, `key ${key} must be an enumerable data property`);
    }
    out[key] = (desc as PropertyDescriptor).value;
  }
  return out;
}

function snapArray(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): unknown[] {
  if (!Array.isArray(value)) {
    fail(code, label, "expected a dense array");
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code, label, "expected an Array prototype");
  }
  const length: unknown = value.length;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    Object.is(length, -0)
  ) {
    fail(code, label, "expected a nonnegative safe-integer length");
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== length + 1) {
    fail(code, label, "sparse arrays and array extra properties are rejected");
  }
  for (let i = 0; i < length; i += 1) {
    if (own[i] !== String(i)) {
      fail(code, label, "arrays must be dense with contiguous index keys");
    }
  }
  if (own[length] !== "length") {
    fail(code, label, "arrays must carry only the length marker after their indices");
  }
  const items: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, String(i));
    if (
      desc === undefined ||
      !("value" in desc) ||
      desc.enumerable !== true
    ) {
      fail(code, label, `index ${String(i)} must be an enumerable data property`);
    }
    items.push((desc as PropertyDescriptor).value);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Scalar validators — no coercion, no defaults
// ---------------------------------------------------------------------------

function reqString(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): string {
  if (typeof value !== "string") {
    fail(code, label, "expected a primitive string");
  }
  return value;
}

function reqBoolean(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): boolean {
  if (typeof value !== "boolean") {
    fail(code, label, "expected a primitive boolean");
  }
  return value;
}

function reqSafeInteger(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(code, label, "expected a primitive safe integer");
  }
  if (Object.is(value, -0)) {
    fail(code, label, "negative zero is rejected");
  }
  return value;
}

function reqPositiveId(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): number {
  const n = reqSafeInteger(value, label, code);
  if (n <= 0) {
    fail(code, label, "expected a positive safe integer");
  }
  return n;
}

function reqCount(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): number {
  const n = reqSafeInteger(value, label, code);
  if (n < 0) {
    fail(code, label, "expected a nonnegative safe integer count");
  }
  return n;
}

function reqEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  code: ReviewedInputErrorCode,
): T {
  if (typeof value === "string") {
    for (const candidate of allowed) {
      if (value === candidate) return candidate;
    }
  }
  fail(code, label, "value is outside the closed reviewed vocabulary");
}

function reqPattern(
  value: unknown,
  pattern: RegExp,
  label: string,
  code: ReviewedInputErrorCode,
): string {
  const s = reqString(value, label, code);
  if (!pattern.test(s)) {
    fail(code, label, "string does not match the exact reviewed grammar");
  }
  return s;
}

function reqExactString(
  value: unknown,
  exact: string,
  label: string,
  code: ReviewedInputErrorCode,
): string {
  const s = reqString(value, label, code);
  if (s !== exact) {
    fail(code, label, "string must equal the exact reviewed constant");
  }
  return s;
}

function safeAdd(
  a: number,
  b: number,
  label: string,
  code: ReviewedInputErrorCode,
): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    fail(code, label, "sum overflowed the safe-integer domain");
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Human-string, caption, label, slug, path, timestamp validators
// ---------------------------------------------------------------------------

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Human strings must ALREADY be NFC, trimmed, surrogate-paired, and free
 *  of Unicode Cc/Cf controls. Nothing is normalized silently. */
function reqHumanString(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
  maxCodeUnits: number,
): string {
  const s = reqString(value, label, code);
  if (s.length === 0 || s.length > maxCodeUnits) {
    fail(code, label, "expected a substantive string within the size bound");
  }
  if (s !== s.normalize("NFC")) {
    fail(code, label, "string must already be NFC-normalized");
  }
  if (s !== s.trim()) {
    fail(code, label, "string must already be trimmed");
  }
  if (hasUnpairedSurrogate(s)) {
    fail(code, label, "unpaired surrogates are rejected");
  }
  if (UNICODE_CONTROL_RE.test(s)) {
    fail(code, label, "Unicode Cc/Cf controls are rejected");
  }
  return s;
}

function reqCaption(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): string {
  const s = reqHumanString(value, label, code, MAX_CAPTION_CODE_UNITS);
  if (!s.startsWith(FICHA_CAPTION_PREFIX) || s.length <= FICHA_CAPTION_PREFIX.length) {
    fail(code, label, "caption must begin with the exact Ficha Artículo prefix");
  }
  if (s !== normalizeFichaCaption(s)) {
    fail(code, label, "caption must already equal its normalized shape");
  }
  return s;
}

function reqArticleUnitLabel(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): string {
  const s = reqHumanString(value, label, code, MAX_LABEL_CODE_UNITS);
  if (!CANONICAL_ARTICLE_NUMBER_RE.test(s)) {
    fail(code, label, "article unit label must use the canonical number grammar");
  }
  const canonical = sinaleviWordRules.normalizeNumber(s);
  if (canonical.number !== s || canonical.ordinalRaw !== "") {
    fail(code, label, "article unit label must already satisfy canonical normalization");
  }
  return s;
}

function reqTransitoryUnitLabel(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): string {
  return reqHumanString(value, label, code, MAX_LABEL_CODE_UNITS);
}

function reqSlug(value: unknown, label: string, code: ReviewedInputErrorCode): string {
  const s = reqString(value, label, code);
  if (s.length === 0 || s.length > MAX_SLUG_CODE_UNITS) {
    fail(code, label, "slug exceeds the size bound");
  }
  if (!SLUG_RE.test(s)) {
    fail(code, label, "slug does not match the exact reviewed grammar");
  }
  return s;
}

export function derivedGzipPath(
  slug: string,
  authorityId: number,
  versionId: number,
): string {
  return `corpus-sources/v1/${slug}/${String(authorityId)}-${String(versionId)}.raw.json.gz`;
}

export function derivedSidecarPath(
  slug: string,
  authorityId: number,
  versionId: number,
): string {
  return `corpus-sources/v1/${slug}/${String(authorityId)}-${String(versionId)}.capture.json`;
}

/** Exact derived-path equality — traversal/backslash/absolute/percent/
 *  repeated-separator/lookalike variants fail by comparison, never by
 *  sanitization. */
function reqExactDerivedPath(
  value: unknown,
  expected: string,
  label: string,
  code: ReviewedInputErrorCode,
): string {
  const s = reqString(value, label, code);
  if (s !== expected) {
    fail(code, label, "path must equal the exact derived capture path");
  }
  return s;
}

function isGregorianLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Exact Gregorian-valid UTC `YYYY-MM-DDTHH:mm:ss.SSSZ`. Offsets, lowercase
 *  z, omitted milliseconds, leap seconds, and impossible dates reject. */
function reqCapturedAt(
  value: unknown,
  label: string,
  code: ReviewedInputErrorCode,
): string {
  const s = reqString(value, label, code);
  const match = CAPTURED_AT_RE.exec(s);
  if (match === null) {
    fail(code, label, "capturedAt must be exact Gregorian UTC millisecond form");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12) {
    fail(code, label, "capturedAt carries an out-of-range year or month");
  }
  const daysInMonth = [31, isGregorianLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > daysInMonth) {
    fail(code, label, "capturedAt carries an impossible day of month");
  }
  if (hour > 23 || minute > 59 || second > 59) {
    fail(code, label, "capturedAt carries an out-of-range time or leap second");
  }
  return s;
}

// ---------------------------------------------------------------------------
// Catalog validators
// ---------------------------------------------------------------------------

function validateCaptureIdentity(
  value: unknown,
  slug: string,
  authorityId: number,
  versionId: number,
  label: string,
  codes: Codes,
): ReviewedCaptureIdentity {
  const raw = snapObject(value, CAPTURE_IDENTITY_KEYS, label, codes.invalid);
  const gzipPath = reqExactDerivedPath(
    raw.gzipPath,
    derivedGzipPath(slug, authorityId, versionId),
    `${label}.gzipPath`,
    codes.invalid,
  );
  const sidecarPath = reqExactDerivedPath(
    raw.sidecarPath,
    derivedSidecarPath(slug, authorityId, versionId),
    `${label}.sidecarPath`,
    codes.invalid,
  );
  const rawSha256 = reqPattern(
    raw.rawSha256,
    BARE_SHA256_RE,
    `${label}.rawSha256`,
    codes.invalid,
  );
  const gzipSha256 = reqPattern(
    raw.gzipSha256,
    BARE_SHA256_RE,
    `${label}.gzipSha256`,
    codes.invalid,
  );
  const uncompressedBytes = reqCount(
    raw.uncompressedBytes,
    `${label}.uncompressedBytes`,
    codes.invalid,
  );
  return Object.freeze({ gzipPath, sidecarPath, rawSha256, gzipSha256, uncompressedBytes });
}

function validateLedgerRow(
  value: unknown,
  index: number,
  label: string,
  codes: Codes,
): { readonly row: ReviewedLedgerRow; readonly kind: ReviewedLedgerRowKind } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(codes.invalid, label, "expected a plain object");
  }
  // Read the discriminator WITHOUT trusting anything else about the row:
  // it must be an own enumerable data property at position `kind`.
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(codes.invalid, label, "expected a plain-object prototype");
  }
  const kindDesc = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    kindDesc === undefined ||
    !("value" in kindDesc) ||
    kindDesc.enumerable !== true
  ) {
    fail(codes.invalid, label, "kind must be an enumerable data property");
  }
  const kind = reqEnum(
    (kindDesc as PropertyDescriptor).value,
    ["emitted-article", "emitted-transitory", "known-gap", "reviewed-exclusion"] as const,
    `${label}.kind`,
    codes.invalid,
  );
  const emitted = kind === "emitted-article" || kind === "emitted-transitory";
  const raw = snapObject(
    value,
    emitted ? EMITTED_ROW_KEYS : REASON_ROW_KEYS,
    label,
    codes.invalid,
  );
  const sourceUnitId = reqPositiveId(
    raw.sourceUnitId,
    `${label}.sourceUnitId`,
    codes.invalid,
  );
  const domOrder = reqCount(raw.domOrder, `${label}.domOrder`, codes.invalid);
  if (domOrder !== index) {
    fail(codes.invalid, `${label}.domOrder`, "domOrder must equal the contiguous ledger index");
  }
  const caption = reqCaption(raw.caption, `${label}.caption`, codes.invalid);
  const endsTransitorio = caption.endsWith(TRANSITORIO_CAPTION_SUFFIX);
  let row: ReviewedLedgerRow;
  if (kind === "emitted-article") {
    if (endsTransitorio) {
      fail(codes.invalid, label, "article emissions forbid the Transitorio suffix");
    }
    row = {
      kind,
      sourceUnitId,
      domOrder,
      caption,
      unitLabel: reqArticleUnitLabel(raw.unitLabel, `${label}.unitLabel`, codes.invalid),
    };
  } else if (kind === "emitted-transitory") {
    if (!endsTransitorio) {
      fail(codes.invalid, label, "transitory emissions require the Transitorio caption suffix");
    }
    row = {
      kind,
      sourceUnitId,
      domOrder,
      caption,
      unitLabel: reqTransitoryUnitLabel(
        raw.unitLabel,
        `${label}.unitLabel`,
        codes.invalid,
      ),
    };
  } else if (kind === "known-gap") {
    const reason = reqEnum(
      raw.reason,
      KNOWN_GAP_REASONS as readonly KnownGapReason[],
      `${label}.reason`,
      codes.invalid,
    );
    const reasonIsTransitory = TRANSITORIO_GAP_REASONS.includes(reason);
    if (reasonIsTransitory && !endsTransitorio) {
      fail(codes.invalid, label, "transitory-gap reasons require the Transitorio caption suffix");
    }
    if (!reasonIsTransitory && endsTransitorio) {
      fail(codes.invalid, label, "article-gap reasons forbid the Transitorio suffix");
    }
    row = { kind, sourceUnitId, domOrder, caption, reason };
  } else {
    const reason = reqEnum(
      raw.reason,
      EXCLUSION_REASONS as readonly ReviewedExclusionReason[],
      `${label}.reason`,
      codes.invalid,
    );
    if (endsTransitorio) {
      fail(codes.invalid, label, "exclusions forbid the Transitorio suffix");
    }
    row = { kind, sourceUnitId, domOrder, caption, reason };
  }
  return { row: Object.freeze(row), kind };
}

interface AuthorityStats {
  readonly app: boolean;
  readonly mcp: boolean;
  readonly frontMatter: ReviewedFrontMatterState;
  readonly emittedArticles: number;
  readonly emittedTransitories: number;
  readonly knownGaps: number;
  readonly reviewedExclusions: number;
  readonly total: number;
  readonly ledgerLength: number;
  readonly sourceUnitCoordinates: number;
}

function validateAuthority(
  value: unknown,
  index: number,
  codes: Codes,
): { readonly authority: ReviewedCatalogAuthority; readonly stats: AuthorityStats } {
  const label = `authorities[${String(index)}]`;
  const raw = snapObject(value, AUTHORITY_KEYS, label, codes.invalid);
  const slug = reqSlug(raw.slug, `${label}.slug`, codes.invalid);
  const authorityId = reqPositiveId(raw.authorityId, `${label}.authorityId`, codes.invalid);
  const versionId = reqPositiveId(raw.versionId, `${label}.versionId`, codes.invalid);

  const profileRaw = snapObject(
    raw.profileMembership,
    PROFILE_KEYS,
    `${label}.profileMembership`,
    codes.invalid,
  );
  const app = reqBoolean(profileRaw.app, `${label}.profileMembership.app`, codes.invalid);
  const mcp = reqBoolean(profileRaw.mcp, `${label}.profileMembership.mcp`, codes.invalid);
  if (!app && !mcp) {
    fail(codes.invalid, `${label}.profileMembership`, "at least one profile flag must be true");
  }
  const profileMembership = Object.freeze({ app, mcp });

  const templateRaw = snapObject(
    raw.template,
    CATALOG_TEMPLATE_KEYS,
    `${label}.template`,
    codes.invalid,
  );
  const templateId = reqEnum(
    templateRaw.id,
    TEMPLATE_IDS as readonly ReviewedTemplateId[],
    `${label}.template.id`,
    codes.invalid,
  );
  const fingerprint = reqPattern(
    templateRaw.fingerprint,
    FINGERPRINT_RE,
    `${label}.template.fingerprint`,
    codes.invalid,
  );
  const allowsZeroFicha = reqBoolean(
    templateRaw.allowsZeroFicha,
    `${label}.template.allowsZeroFicha`,
    codes.invalid,
  );
  const template = Object.freeze({
    id: templateId,
    fingerprint,
    allowsZeroFicha,
  });

  const capture = validateCaptureIdentity(
    raw.capture,
    slug,
    authorityId,
    versionId,
    `${label}.capture`,
    codes,
  );

  const expectationsRaw = snapObject(
    raw.expectations,
    EXPECTATIONS_KEYS,
    `${label}.expectations`,
    codes.invalid,
  );
  const frontMatter = reqEnum(
    expectationsRaw.frontMatter,
    FRONT_MATTER_STATES as readonly ReviewedFrontMatterState[],
    `${label}.expectations.frontMatter`,
    codes.invalid,
  );
  const ledgerItems = snapArray(
    expectationsRaw.ledger,
    `${label}.expectations.ledger`,
    codes.invalid,
  );
  const seenSourceUnitIds = new Set<number>();
  const rows: ReviewedLedgerRow[] = [];
  let emittedArticles = 0;
  let emittedTransitories = 0;
  let knownGaps = 0;
  let reviewedExclusions = 0;
  for (let i = 0; i < ledgerItems.length; i += 1) {
    const rowLabel = `${label}.expectations.ledger[${String(i)}]`;
    const { row, kind } = validateLedgerRow(ledgerItems[i], i, rowLabel, codes);
    if (seenSourceUnitIds.has(row.sourceUnitId)) {
      fail(codes.invalid, rowLabel, "sourceUnitId must be unique within an authority ledger");
    }
    seenSourceUnitIds.add(row.sourceUnitId);
    if (kind === "emitted-article") emittedArticles += 1;
    else if (kind === "emitted-transitory") emittedTransitories += 1;
    else if (kind === "known-gap") knownGaps += 1;
    else reviewedExclusions += 1;
    rows.push(row);
  }

  const classificationsRaw = snapObject(
    expectationsRaw.classifications,
    CLASSIFICATIONS_KEYS,
    `${label}.expectations.classifications`,
    codes.invalid,
  );
  const cEmittedArticles = reqCount(
    classificationsRaw.emittedArticles,
    `${label}.expectations.classifications.emittedArticles`,
    codes.invalid,
  );
  const cEmittedTransitories = reqCount(
    classificationsRaw.emittedTransitories,
    `${label}.expectations.classifications.emittedTransitories`,
    codes.invalid,
  );
  const cKnownGaps = reqCount(
    classificationsRaw.knownGaps,
    `${label}.expectations.classifications.knownGaps`,
    codes.invalid,
  );
  const cReviewedExclusions = reqCount(
    classificationsRaw.reviewedExclusions,
    `${label}.expectations.classifications.reviewedExclusions`,
    codes.invalid,
  );
  const cTotal = reqCount(
    classificationsRaw.total,
    `${label}.expectations.classifications.total`,
    codes.invalid,
  );
  if (
    cEmittedArticles !== emittedArticles ||
    cEmittedTransitories !== emittedTransitories ||
    cKnownGaps !== knownGaps ||
    cReviewedExclusions !== reviewedExclusions
  ) {
    fail(codes.invalid, `${label}.expectations.classifications`, "counts do not recount the ledger");
  }
  let recountSum = safeAdd(cEmittedArticles, cEmittedTransitories, `${label}.classifications`, codes.invalid);
  recountSum = safeAdd(recountSum, cKnownGaps, `${label}.classifications`, codes.invalid);
  recountSum = safeAdd(recountSum, cReviewedExclusions, `${label}.classifications`, codes.invalid);
  if (cTotal !== recountSum) {
    fail(codes.invalid, `${label}.expectations.classifications.total`, "total must equal the sum of the four counts");
  }
  if (rows.length !== cTotal) {
    fail(codes.invalid, `${label}.expectations.ledger`, "ledger length must equal classifications.total");
  }
  const sourceUnitCoordinates = reqCount(
    expectationsRaw.sourceUnitCoordinates,
    `${label}.expectations.sourceUnitCoordinates`,
    codes.invalid,
  );
  let wantCoordinates = safeAdd(cEmittedArticles, cEmittedTransitories, `${label}.coordinates`, codes.invalid);
  wantCoordinates = safeAdd(wantCoordinates, cKnownGaps, `${label}.coordinates`, codes.invalid);
  if (sourceUnitCoordinates !== wantCoordinates) {
    fail(codes.invalid, `${label}.expectations.sourceUnitCoordinates`, "coordinates must equal emitted articles + transitories + known gaps");
  }
  const expectations = Object.freeze({
    frontMatter,
    classifications: Object.freeze({
      emittedArticles: cEmittedArticles,
      emittedTransitories: cEmittedTransitories,
      knownGaps: cKnownGaps,
      reviewedExclusions: cReviewedExclusions,
      total: cTotal,
    }),
    sourceUnitCoordinates,
    ledger: Object.freeze(rows),
  });

  const authority = Object.freeze({
    slug,
    authorityId,
    versionId,
    profileMembership,
    template,
    capture,
    expectations,
  });
  const stats: AuthorityStats = {
    app,
    mcp,
    frontMatter,
    emittedArticles: cEmittedArticles,
    emittedTransitories: cEmittedTransitories,
    knownGaps: cKnownGaps,
    reviewedExclusions: cReviewedExclusions,
    total: cTotal,
    ledgerLength: rows.length,
    sourceUnitCoordinates,
  };
  return { authority, stats };
}

function validateTotals(
  value: unknown,
  stats: readonly AuthorityStats[],
  codes: Codes,
): ReviewedCatalogTotals {
  const label = "totals";
  const raw = snapObject(value, TOTALS_KEYS, label, codes.invalid);
  const authorities = reqCount(raw.authorities, `${label}.authorities`, codes.invalid);
  const appAuthorities = reqCount(raw.appAuthorities, `${label}.appAuthorities`, codes.invalid);
  const mcpAuthorities = reqCount(raw.mcpAuthorities, `${label}.mcpAuthorities`, codes.invalid);
  const emittedArticles = reqCount(raw.emittedArticles, `${label}.emittedArticles`, codes.invalid);
  const emittedTransitories = reqCount(raw.emittedTransitories, `${label}.emittedTransitories`, codes.invalid);
  const knownGaps = reqCount(raw.knownGaps, `${label}.knownGaps`, codes.invalid);
  const reviewedExclusions = reqCount(raw.reviewedExclusions, `${label}.reviewedExclusions`, codes.invalid);
  const ledgerEntries = reqCount(raw.ledgerEntries, `${label}.ledgerEntries`, codes.invalid);
  const sourceUnitCoordinates = reqCount(raw.sourceUnitCoordinates, `${label}.sourceUnitCoordinates`, codes.invalid);
  const frontMatterAbsent = reqCount(raw.frontMatterAbsent, `${label}.frontMatterAbsent`, codes.invalid);
  const frontMatterEmpty = reqCount(raw.frontMatterEmpty, `${label}.frontMatterEmpty`, codes.invalid);
  const frontMatterPresent = reqCount(raw.frontMatterPresent, `${label}.frontMatterPresent`, codes.invalid);

  const sum = (pick: (s: AuthorityStats) => number, partLabel: string): number => {
    let acc = 0;
    for (const entry of stats) {
      acc = safeAdd(acc, pick(entry), `${label}.${partLabel}`, codes.invalid);
    }
    return acc;
  };
  let appCount = 0;
  let mcpCount = 0;
  let absentCount = 0;
  let emptyCount = 0;
  let presentCount = 0;
  for (const entry of stats) {
    if (entry.app) appCount += 1;
    if (entry.mcp) mcpCount += 1;
    if (entry.frontMatter === "absent") absentCount += 1;
    else if (entry.frontMatter === "empty") emptyCount += 1;
    else presentCount += 1;
  }
  const partition = safeAdd(safeAdd(absentCount, emptyCount, `${label}.frontMatter`, codes.invalid), presentCount, `${label}.frontMatter`, codes.invalid);
  if (partition !== stats.length) {
    fail(codes.invalid, `${label}.frontMatter*`, "front-matter counts must partition the authority count exactly");
  }
  if (authorities !== stats.length) {
    fail(codes.invalid, `${label}.authorities`, "authorities total must equal the authority count");
  }
  if (appAuthorities !== appCount) {
    fail(codes.invalid, `${label}.appAuthorities`, "appAuthorities must recount the profile flags");
  }
  if (mcpAuthorities !== mcpCount) {
    fail(codes.invalid, `${label}.mcpAuthorities`, "mcpAuthorities must recount the profile flags");
  }
  if (emittedArticles !== sum((s) => s.emittedArticles, "emittedArticles")) {
    fail(codes.invalid, `${label}.emittedArticles`, "totals drift from the authority recount");
  }
  if (emittedTransitories !== sum((s) => s.emittedTransitories, "emittedTransitories")) {
    fail(codes.invalid, `${label}.emittedTransitories`, "totals drift from the authority recount");
  }
  if (knownGaps !== sum((s) => s.knownGaps, "knownGaps")) {
    fail(codes.invalid, `${label}.knownGaps`, "totals drift from the authority recount");
  }
  if (reviewedExclusions !== sum((s) => s.reviewedExclusions, "reviewedExclusions")) {
    fail(codes.invalid, `${label}.reviewedExclusions`, "totals drift from the authority recount");
  }
  if (ledgerEntries !== sum((s) => s.ledgerLength, "ledgerEntries")) {
    fail(codes.invalid, `${label}.ledgerEntries`, "totals drift from the ledger recount");
  }
  if (sourceUnitCoordinates !== sum((s) => s.sourceUnitCoordinates, "sourceUnitCoordinates")) {
    fail(codes.invalid, `${label}.sourceUnitCoordinates`, "totals drift from the coordinate recount");
  }
  if (frontMatterAbsent !== absentCount) {
    fail(codes.invalid, `${label}.frontMatterAbsent`, "totals drift from the front-matter recount");
  }
  if (frontMatterEmpty !== emptyCount) {
    fail(codes.invalid, `${label}.frontMatterEmpty`, "totals drift from the front-matter recount");
  }
  if (frontMatterPresent !== presentCount) {
    fail(codes.invalid, `${label}.frontMatterPresent`, "totals drift from the front-matter recount");
  }
  return Object.freeze({
    authorities,
    appAuthorities,
    mcpAuthorities,
    emittedArticles,
    emittedTransitories,
    knownGaps,
    reviewedExclusions,
    ledgerEntries,
    sourceUnitCoordinates,
    frontMatterAbsent,
    frontMatterEmpty,
    frontMatterPresent,
  });
}

function validateCatalogRoot(value: unknown, codes: Codes): ReviewedInputCatalog {
  const raw = snapObject(value, CATALOG_ROOT_KEYS, "catalog root", codes.invalid);
  if (raw.formatVersion !== REVIEWED_INPUT_CATALOG_FORMAT_VERSION) {
    fail(codes.version, "catalog root.formatVersion", "unreviewed catalog format version");
  }
  const authorityItems = snapArray(raw.authorities, "catalog authorities", codes.invalid);
  const authorities: ReviewedCatalogAuthority[] = [];
  const stats: AuthorityStats[] = [];
  const seenAuthorityIds = new Set<number>();
  const seenSlugs = new Set<string>();
  const seenGzipPaths = new Set<string>();
  const seenSidecarPaths = new Set<string>();
  let previousAuthorityId = 0;
  for (let i = 0; i < authorityItems.length; i += 1) {
    const { authority, stats: entryStats } = validateAuthority(authorityItems[i], i, codes);
    if (authority.authorityId <= previousAuthorityId) {
      fail(codes.invalid, `authorities[${String(i)}].authorityId`, "authorityIds must strictly increase");
    }
    previousAuthorityId = authority.authorityId;
    if (seenAuthorityIds.has(authority.authorityId)) {
      fail(codes.invalid, `authorities[${String(i)}].authorityId`, "duplicate authority id");
    }
    seenAuthorityIds.add(authority.authorityId);
    if (seenSlugs.has(authority.slug)) {
      fail(codes.invalid, `authorities[${String(i)}].slug`, "duplicate slug");
    }
    seenSlugs.add(authority.slug);
    if (seenGzipPaths.has(authority.capture.gzipPath)) {
      fail(codes.invalid, `authorities[${String(i)}].capture.gzipPath`, "duplicate gzip path");
    }
    seenGzipPaths.add(authority.capture.gzipPath);
    if (seenSidecarPaths.has(authority.capture.sidecarPath)) {
      fail(codes.invalid, `authorities[${String(i)}].capture.sidecarPath`, "duplicate sidecar path");
    }
    seenSidecarPaths.add(authority.capture.sidecarPath);
    authorities.push(authority);
    stats.push(entryStats);
  }
  const totals = validateTotals(raw.totals, stats, codes);
  return Object.freeze({
    formatVersion: REVIEWED_INPUT_CATALOG_FORMAT_VERSION as typeof REVIEWED_INPUT_CATALOG_FORMAT_VERSION,
    totals,
    authorities: Object.freeze(authorities),
  });
}

// ---------------------------------------------------------------------------
// Sidecar validators
// ---------------------------------------------------------------------------

function validateSidecarRoot(value: unknown, codes: Codes): ReviewedCaptureSidecar {
  const raw = snapObject(value, SIDECAR_ROOT_KEYS, "capture sidecar root", codes.invalid);
  if (raw.formatVersion !== REVIEWED_CAPTURE_SIDECAR_FORMAT_VERSION) {
    fail(codes.version, "capture sidecar root.formatVersion", "unreviewed sidecar format version");
  }
  const slug = reqSlug(raw.slug, "capture sidecar.slug", codes.invalid);

  const handleRaw = snapObject(
    raw.requestedHandle,
    HANDLE_KEYS,
    "capture sidecar.requestedHandle",
    codes.invalid,
  );
  const authorityId = reqPositiveId(
    handleRaw.authorityId,
    "capture sidecar.requestedHandle.authorityId",
    codes.invalid,
  );
  const versionId = reqPositiveId(
    handleRaw.versionId,
    "capture sidecar.requestedHandle.versionId",
    codes.invalid,
  );
  const requestedHandle = Object.freeze({ authorityId, versionId });

  const templateRaw = snapObject(
    raw.template,
    SIDECAR_TEMPLATE_KEYS,
    "capture sidecar.template",
    codes.invalid,
  );
  const templateId = reqEnum(
    templateRaw.id,
    TEMPLATE_IDS as readonly ReviewedTemplateId[],
    "capture sidecar.template.id",
    codes.invalid,
  );
  const fingerprint = reqPattern(
    templateRaw.fingerprint,
    FINGERPRINT_RE,
    "capture sidecar.template.fingerprint",
    codes.invalid,
  );
  const template = Object.freeze({ id: templateId, fingerprint });

  const requestRaw = snapObject(
    raw.request,
    REQUEST_KEYS,
    "capture sidecar.request",
    codes.invalid,
  );
  reqExactString(requestRaw.method, "POST", "capture sidecar.request.method", codes.invalid);
  reqExactString(
    requestRaw.endpoint,
    SINALEVI_CAPTURE_ENDPOINT,
    "capture sidecar.request.endpoint",
    codes.invalid,
  );
  const request = Object.freeze({
    method: "POST" as const,
    endpoint: SINALEVI_CAPTURE_ENDPOINT as typeof SINALEVI_CAPTURE_ENDPOINT,
  });

  const responseRaw = snapObject(
    raw.response,
    RESPONSE_KEYS,
    "capture sidecar.response",
    codes.invalid,
  );
  if (responseRaw.status !== 200) {
    fail(codes.invalid, "capture sidecar.response.status", "status must be exactly 200");
  }
  const contentTypeRaw = snapObject(
    responseRaw.contentType,
    CONTENT_TYPE_KEYS,
    "capture sidecar.response.contentType",
    codes.invalid,
  );
  reqExactString(
    contentTypeRaw.mediaType,
    "application/json",
    "capture sidecar.response.contentType.mediaType",
    codes.invalid,
  );
  if (contentTypeRaw.charset !== "utf-8" && contentTypeRaw.charset !== null) {
    fail(codes.invalid, "capture sidecar.response.contentType.charset", "charset must be utf-8 or null");
  }
  const capturedAt = reqCapturedAt(
    responseRaw.capturedAt,
    "capture sidecar.response.capturedAt",
    codes.invalid,
  );
  const response = Object.freeze({
    status: 200 as const,
    contentType: Object.freeze({
      mediaType: "application/json" as const,
      charset: contentTypeRaw.charset as "utf-8" | null,
    }),
    capturedAt,
  });

  const toolRaw = snapObject(
    raw.captureTool,
    CAPTURE_TOOL_KEYS,
    "capture sidecar.captureTool",
    codes.invalid,
  );
  reqExactString(toolRaw.name, "sinalevi-fetch", "capture sidecar.captureTool.name", codes.invalid);
  const toolVersion = reqPattern(
    toolRaw.version,
    CAPTURE_TOOL_VERSION_RE,
    "capture sidecar.captureTool.version",
    codes.invalid,
  );
  const captureTool = Object.freeze({ name: "sinalevi-fetch" as const, version: toolVersion });

  const artifacts = validateCaptureIdentity(
    raw.artifacts,
    slug,
    authorityId,
    versionId,
    "capture sidecar.artifacts",
    codes,
  );

  const handlersRaw = snapObject(
    raw.observedHandlers,
    OBSERVED_HANDLER_KEYS,
    "capture sidecar.observedHandlers",
    codes.invalid,
  );
  const fichaAnchors = reqCount(handlersRaw.fichaAnchors, "capture sidecar.observedHandlers.fichaAnchors", codes.invalid);
  const parsedHandlers = reqCount(handlersRaw.parsedHandlers, "capture sidecar.observedHandlers.parsedHandlers", codes.invalid);
  const articleKind = reqCount(handlersRaw.articleKind, "capture sidecar.observedHandlers.articleKind", codes.invalid);
  const transitoryKind = reqCount(handlersRaw.transitoryKind, "capture sidecar.observedHandlers.transitoryKind", codes.invalid);
  const zeroFicha = reqCount(handlersRaw.zeroFicha, "capture sidecar.observedHandlers.zeroFicha", codes.invalid);
  const authorityFicha = reqCount(handlersRaw.authorityFicha, "capture sidecar.observedHandlers.authorityFicha", codes.invalid);
  const versionMatched = reqCount(handlersRaw.versionMatched, "capture sidecar.observedHandlers.versionMatched", codes.invalid);
  const distinctSourceUnitIds = reqCount(handlersRaw.distinctSourceUnitIds, "capture sidecar.observedHandlers.distinctSourceUnitIds", codes.invalid);

  if (fichaAnchors !== parsedHandlers) {
    fail(codes.invalid, "capture sidecar.observedHandlers", "fichaAnchors must equal parsedHandlers");
  }
  if (safeAdd(articleKind, transitoryKind, "capture sidecar.observedHandlers", codes.invalid) !== parsedHandlers) {
    fail(codes.invalid, "capture sidecar.observedHandlers", "parsedHandlers must equal articleKind + transitoryKind");
  }
  if (safeAdd(zeroFicha, authorityFicha, "capture sidecar.observedHandlers", codes.invalid) !== parsedHandlers) {
    fail(codes.invalid, "capture sidecar.observedHandlers", "parsedHandlers must equal zeroFicha + authorityFicha");
  }
  if (versionMatched !== parsedHandlers || distinctSourceUnitIds !== parsedHandlers) {
    fail(codes.invalid, "capture sidecar.observedHandlers", "versionMatched and distinctSourceUnitIds must equal parsedHandlers");
  }
  const observedHandlers = Object.freeze({
    fichaAnchors,
    parsedHandlers,
    articleKind,
    transitoryKind,
    zeroFicha,
    authorityFicha,
    versionMatched,
    distinctSourceUnitIds,
  });

  return Object.freeze({
    formatVersion: REVIEWED_CAPTURE_SIDECAR_FORMAT_VERSION as typeof REVIEWED_CAPTURE_SIDECAR_FORMAT_VERSION,
    slug,
    requestedHandle,
    template,
    request,
    response,
    captureTool,
    artifacts,
    observedHandlers,
  });
}

// ---------------------------------------------------------------------------
// Strict recursive JSON parser (no regex) — the mandatory byte boundary
// ---------------------------------------------------------------------------

const JSON_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

const MAX_PARSE_DEPTH = 64;

/**
 * Real recursive JSON lexical/parser pass. Rejects duplicate decoded member
 * names independently in every object (including escape-equivalent
 * spellings), signed/fractional/exponent/`-0`/leading-zero number lexemes,
 * unescaped control characters, unpaired surrogate escapes, trailing
 * content, and any other non-canonical shape. Numbers accept only the
 * canonical unsigned-integer lexeme `0 | [1-9][0-9]*`.
 */
class StrictJsonParser {
  private pos = 0;

  constructor(private readonly text: string, private readonly code: ReviewedInputErrorCode) {}

  private failAt(why: string): never {
    fail(this.code, `json at offset ${String(this.pos)}`, why);
  }

  private isJsonSpace(ch: string): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length && this.isJsonSpace(this.text[this.pos] as string)) {
      this.pos += 1;
    }
  }

  parseDocument(): unknown {
    this.skipWhitespace();
    const value = this.readValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      this.failAt("expected exactly one JSON value with JSON whitespace only");
    }
    return value;
  }

  private readValue(depth: number): unknown {
    if (depth > MAX_PARSE_DEPTH) {
      this.failAt("nesting depth exceeds the reviewed bound");
    }
    if (this.pos >= this.text.length) {
      this.failAt("unexpected end of input");
    }
    const ch = this.text[this.pos] as string;
    if (ch === "{") return this.readObject(depth);
    if (ch === "[") return this.readArray(depth);
    if (ch === '"') return this.readString();
    if (ch === "-") this.failAt("signed number lexemes are rejected");
    if (ch >= "0" && ch <= "9") return this.readNumber();
    if (this.text.startsWith("true", this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.text.startsWith("false", this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.text.startsWith("null", this.pos)) {
      this.pos += 4;
      return null;
    }
    this.failAt("unexpected character in value position");
  }

  private readNumber(): number {
    const start = this.pos;
    if (this.text[this.pos] === "0") {
      this.pos += 1;
      const next = this.pos < this.text.length ? (this.text[this.pos] as string) : "";
      if (next >= "0" && next <= "9") {
        this.failAt("leading-zero number lexemes are rejected");
      }
    } else {
      while (this.pos < this.text.length) {
        const ch = this.text[this.pos] as string;
        if (ch >= "0" && ch <= "9") this.pos += 1;
        else break;
      }
    }
    if (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (ch === "." || ch === "e" || ch === "E") {
        this.failAt("fractional and exponent number lexemes are rejected");
      }
    }
    const digits = this.text.slice(start, this.pos);
    return Number(digits);
  }

  private readString(): string {
    this.pos += 1; // opening quote
    const parts: string[] = [];
    for (;;) {
      if (this.pos >= this.text.length) {
        this.failAt("unterminated string");
      }
      const ch = this.text[this.pos] as string;
      if (ch === '"') {
        this.pos += 1;
        return parts.join("");
      }
      if (ch === "\\") {
        this.pos += 1;
        if (this.pos >= this.text.length) {
          this.failAt("unterminated escape sequence");
        }
        const esc = this.text[this.pos] as string;
        if (esc === "u") {
          this.pos += 1;
          const first = this.readHex4();
          if (first >= 0xd800 && first <= 0xdbff) {
            if (
              this.pos + 1 < this.text.length &&
              this.text[this.pos] === "\\" &&
              this.text[this.pos + 1] === "u"
            ) {
              this.pos += 2;
              const second = this.readHex4();
              if (second >= 0xdc00 && second <= 0xdfff) {
                parts.push(String.fromCharCode(first, second));
                continue;
              }
              this.failAt("unpaired surrogate escapes are rejected");
            }
            this.failAt("unpaired surrogate escapes are rejected");
          }
          if (first >= 0xdc00 && first <= 0xdfff) {
            this.failAt("unpaired surrogate escapes are rejected");
          }
          parts.push(String.fromCharCode(first));
          continue;
        }
        const mapped = JSON_ESCAPES[esc];
        if (mapped === undefined) {
          this.failAt("unknown escape character");
        }
        parts.push(mapped);
        this.pos += 1;
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        this.failAt("unescaped control characters in strings are rejected");
      }
      parts.push(ch);
      this.pos += 1;
    }
  }

  private readHex4(): number {
    if (this.pos + 4 > this.text.length) {
      this.failAt("truncated unicode escape");
    }
    const hex = this.text.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      this.failAt("malformed unicode escape");
    }
    this.pos += 4;
    return parseInt(hex, 16);
  }

  private readObject(depth: number): Record<string, unknown> {
    this.pos += 1; // '{'
    // defineProperty keeps `__proto__` an ordinary own data property instead
    // of a prototype-setting assignment.
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return obj;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') {
        this.failAt("object keys must be strings");
      }
      const key = this.readString();
      if (seen.has(key)) {
        this.failAt("duplicate decoded member name in object");
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") {
        this.failAt("expected ':' after object key");
      }
      this.pos += 1;
      this.skipWhitespace();
      const value = this.readValue(depth + 1);
      Object.defineProperty(obj, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const ch = this.text[this.pos];
      if (ch === ",") {
        this.pos += 1;
        continue;
      }
      if (ch === "}") {
        this.pos += 1;
        return obj;
      }
      this.failAt("expected ',' or '}' in object");
    }
  }

  private readArray(depth: number): unknown[] {
    this.pos += 1; // '['
    const arr: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return arr;
    }
    for (;;) {
      this.skipWhitespace();
      arr.push(this.readValue(depth + 1));
      this.skipWhitespace();
      const ch = this.text[this.pos];
      if (ch === ",") {
        this.pos += 1;
        continue;
      }
      if (ch === "]") {
        this.pos += 1;
        return arr;
      }
      this.failAt("expected ',' or ']' in array");
    }
  }
}

function decodeStrictUtf8(bytes: Uint8Array, code: ReviewedInputErrorCode): string {
  if (!(bytes instanceof Uint8Array)) {
    fail(code, "bytes", "expected a Uint8Array");
  }
  let text: string;
  try {
    // Fatal decoding; `ignoreBOM: true` preserves the BOM so it can be
    // rejected explicitly instead of silently stripped.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(code, "bytes", "malformed UTF-8 is rejected");
  }
  if (text.startsWith("\uFEFF")) {
    fail(code, "bytes", "UTF-8 BOM is rejected");
  }
  return text;
}

function parseBytesToValue(bytes: Uint8Array, code: ReviewedInputErrorCode): unknown {
  // Internal helper: it runs INSIDE the caller's public boundary, so any
  // foreign failure raised by the caller-owned byte argument (`instanceof`
  // and `decode` traps) is remapped by that single boundary instead of
  // being laundered through a nested public call.
  const text = decodeStrictUtf8(bytes, code);
  return new StrictJsonParser(text, code).parseDocument();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseReviewedInputCatalogObject(value: unknown): ReviewedInputCatalog {
  return boundary(CATALOG_CODES.invalid, () => validateCatalogRoot(value, CATALOG_CODES));
}

export function parseReviewedInputCatalogBytes(bytes: Uint8Array): ReviewedInputCatalog {
  return boundary(CATALOG_CODES.invalid, () =>
    validateCatalogRoot(parseBytesToValue(bytes, CATALOG_CODES.invalid), CATALOG_CODES),
  );
}

export function parseReviewedCaptureSidecarObject(value: unknown): ReviewedCaptureSidecar {
  return boundary(SIDECAR_CODES.invalid, () => validateSidecarRoot(value, SIDECAR_CODES));
}

export function parseReviewedCaptureSidecarBytes(bytes: Uint8Array): ReviewedCaptureSidecar {
  return boundary(SIDECAR_CODES.invalid, () =>
    validateSidecarRoot(parseBytesToValue(bytes, SIDECAR_CODES.invalid), SIDECAR_CODES),
  );
}

/**
 * Mandatory coverage gate: sidecar documents must appear in EXACT catalog
 * authority order and count, each document path/slug/handle/template/
 * artifacts must equal the catalog record, the observed-handler accounting
 * must close against the catalog's reviewed classification total AND against
 * an independent article-kind/transitory-kind recount of that authority's
 * validated ledger, and a template that forbids zero ficha must carry zero.
 * Every missing, extra, reordered, duplicated, or cross-paired sidecar
 * rejects.
 */
export function assertReviewedCaptureSidecarsMatchCatalog(
  catalog: ReviewedInputCatalog,
  documents: readonly ReviewedCaptureSidecarDocument[],
): void {
  boundary(COVERAGE_CODES.invalid, () => {
    const trusted = validateCatalogRoot(catalog, CATALOG_CODES);
    const docs = snapArray(documents, "sidecar documents", COVERAGE_CODES.invalid);
    if (docs.length !== trusted.authorities.length) {
      fail(
        COVERAGE_CODES.invalid,
        "sidecar documents",
        "document count must equal the catalog authority count exactly",
      );
    }
    const seenDocPaths = new Set<string>();
    const seenSlugs = new Set<string>();
    const seenHandles = new Set<string>();
    const seenGzipPaths = new Set<string>();
    const seenSidecarPaths = new Set<string>();
    for (let i = 0; i < docs.length; i += 1) {
      const label = `sidecar documents[${String(i)}]`;
      const authority = trusted.authorities[i] as ReviewedCatalogAuthority;
      const doc = snapObject(docs[i], DOCUMENT_KEYS, label, COVERAGE_CODES.invalid);
      const path = reqString(doc.path, `${label}.path`, COVERAGE_CODES.invalid);
      const sidecar = validateSidecarRoot(doc.sidecar, COVERAGE_CODES);
      if (path !== authority.capture.sidecarPath) {
        fail(COVERAGE_CODES.invalid, `${label}.path`, "document path must equal the catalog sidecar path");
      }
      if (sidecar.slug !== authority.slug) {
        fail(COVERAGE_CODES.invalid, `${label}.slug`, "sidecar slug must equal the catalog slug");
      }
      if (
        sidecar.requestedHandle.authorityId !== authority.authorityId ||
        sidecar.requestedHandle.versionId !== authority.versionId
      ) {
        fail(COVERAGE_CODES.invalid, `${label}.requestedHandle`, "requested handle must equal the catalog authority/version");
      }
      if (
        sidecar.template.id !== authority.template.id ||
        sidecar.template.fingerprint !== authority.template.fingerprint
      ) {
        fail(COVERAGE_CODES.invalid, `${label}.template`, "template id/fingerprint must equal the catalog template");
      }
      if (
        sidecar.artifacts.gzipPath !== authority.capture.gzipPath ||
        sidecar.artifacts.sidecarPath !== authority.capture.sidecarPath ||
        sidecar.artifacts.rawSha256 !== authority.capture.rawSha256 ||
        sidecar.artifacts.gzipSha256 !== authority.capture.gzipSha256 ||
        sidecar.artifacts.uncompressedBytes !== authority.capture.uncompressedBytes
      ) {
        fail(COVERAGE_CODES.invalid, `${label}.artifacts`, "artifact paths/digests/byte count must equal the catalog capture identity");
      }
      const handleKey = `${String(sidecar.requestedHandle.authorityId)}\u0000${String(sidecar.requestedHandle.versionId)}`;
      for (const [set, key, what] of [
        [seenDocPaths, path, "document path"],
        [seenSlugs, sidecar.slug, "slug"],
        [seenHandles, handleKey, "handle"],
        [seenGzipPaths, sidecar.artifacts.gzipPath, "gzip path"],
        [seenSidecarPaths, sidecar.artifacts.sidecarPath, "sidecar path"],
      ] as const) {
        if (set.has(key)) {
          fail(COVERAGE_CODES.invalid, label, `duplicate ${what}`);
        }
        set.add(key);
      }
      if (
        sidecar.observedHandlers.parsedHandlers !==
        authority.expectations.classifications.total
      ) {
        fail(COVERAGE_CODES.invalid, `${label}.observedHandlers`, "parsedHandlers must equal the catalog classifications.total");
      }
      // Independent kind recount from the already validated ledger:
      // transitory-kind = emitted transitories plus transitory-kind known
      // gaps; article-kind = every other (non-transitory) validated row,
      // i.e. emitted articles, article known gaps, and reviewed exclusions.
      let expectedTransitoryKind = 0;
      let expectedArticleKind = 0;
      for (const row of authority.expectations.ledger) {
        const transitoryKindRow =
          row.kind === "emitted-transitory" ||
          (row.kind === "known-gap" && TRANSITORIO_GAP_REASONS.includes(row.reason));
        if (transitoryKindRow) expectedTransitoryKind += 1;
        else expectedArticleKind += 1;
      }
      if (
        sidecar.observedHandlers.articleKind !== expectedArticleKind ||
        sidecar.observedHandlers.transitoryKind !== expectedTransitoryKind
      ) {
        fail(COVERAGE_CODES.invalid, `${label}.observedHandlers`, "articleKind/transitoryKind must equal the catalog ledger kind recount");
      }
      if (!authority.template.allowsZeroFicha && sidecar.observedHandlers.zeroFicha !== 0) {
        fail(COVERAGE_CODES.invalid, `${label}.observedHandlers.zeroFicha`, "zeroFicha must be zero when the template forbids it");
      }
    }
  });
}
