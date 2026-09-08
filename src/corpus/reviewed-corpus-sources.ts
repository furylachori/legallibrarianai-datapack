/**
 * Reviewed corpus source registry
 * (`SINALEVI_CORPUS_AND_PRIVATE_RULINGS_PLAN.md` §5.1, §10.2, §11.2).
 *
 * The single import-safe home for the reviewed 20-authority build source
 * set that `scripts/build-corpus-artifact.ts` previously compiled as a
 * private `MANIFEST` list: exact per-authority fixture identity, template
 * family, Ficha metadata, text-bearing article expectations, the audited
 * source-summary breakdown, the fail-closed approved-warning admission
 * sets, and explicit reviewed profile membership. The builder imports and
 * iterates `REVIEWED_CORPUS_SOURCES` in place; nothing else may carry a
 * second copy of this data or of the template fingerprint algorithm.
 *
 * Hard rules:
 *   - ORDER IS CONTRACT: `REVIEWED_CORPUS_SOURCES` is the shipped build
 *     order; the builder's ledger-identity and catalog-digest streams key
 *     off this exact positional order, so entries may only be added,
 *     removed, or reordered through a reviewed commit;
 *   - REVIEWED DATA ONLY: `approvedWarnings` are the audited allowlist
 *     (exact extractor output strings, upper bounds, never generated
 *     candidates — see the per-field notes on
 *     `ReviewedCorpusSourceEntry`), and the counts mirror the release
 *     contract in `src/corpus/manifest.ts` so a drift fails at build time
 *     AND at startup;
 *   - LEGACY PROVENANCE FALLBACK: an entry's optional
 *     `legacyCaptureFallback` is the pinned, owner-approved capture
 *     provenance for a metadata-less historical capture (only `ct` and
 *     `cc` today); it is reviewed committed data like everything else
 *     here, never a generated candidate;
 *   - ONE FINGERPRINT IMPLEMENTATION: `templateFingerprintFor` is the
 *     deterministic template-contract fingerprint (moved verbatim from
 *     the builder); `rulesFor`, `templateIdFor`, `templateContractFor`,
 *     and `captureContextFor` are the canonical template/context
 *     derivations shared with the reviewed catalog/capture lanes;
 *   - PURE AND IMPORT-SAFE: module load performs no filesystem, network,
 *     DB, process, build, artifact, or capture access — it only freezes
 *     committed literal data and exposes synchronous pure helpers. It
 *     never reads `fixtures/full` or any capture; consuming an entry's
 *     fixture bytes remains the builder's (fail-closed) responsibility.
 */
import { createHash } from "node:crypto";
import type { NormaMeta } from "../db/build.js";
import { sinaleviTreatyRules, sinaleviWordRules, type Rules } from "../sinalevi/rules.js";
import type { CaptureContext, TemplateContract } from "../sinalevi/source-unit.js";
import type {
  ReviewedCaptureResponse,
  ReviewedProfileMembership,
  ReviewedTemplateId,
} from "./reviewed-input-catalog.js";

/** The canonical SINALEVI full-text capture endpoint every reviewed
 *  source meta points at (legacy absolute route; §5.4 keeps it out of
 *  canonical runtime links — it is capture provenance only). */
export const SOURCE_URL =
  "https://sinalevi.go.cr/ResultadosNormativa/_CargarTextoCompleto";

/**
 * Exact legacy capture provenance fallback for a reviewed capture whose
 * historical fetch left NO `_meta.json` sidecar at all. The pair mirrors
 * the owner-approved historical bytes verbatim: the raw response digest
 * (bare lowercase sha256 hex, no prefix) and uncompressed byte count
 * gate the fallback admission, while `response`/`captureToolVersion`
 * carry the reviewed legacy migration policy (HTTP 200, application/json,
 * utf-8, capturedAt = the audited historical fetch time, tool version
 * `"0.0.0"` = unversioned marker). Consumed ONLY by
 * `resolveReviewedCaptureProvenance` when no metadata exists; the
 * sidecar parser remains the final value gate.
 */
export interface ReviewedLegacyCaptureFallback {
  readonly rawSha256: string;
  readonly rawBytes: number;
  readonly response: ReviewedCaptureResponse;
  readonly captureToolVersion: string;
}

/**
 * One reviewed build source: the exact fixture, template family, Ficha
 * identity, and audited expectations for a single authority. Field
 * semantics are unchanged from the builder's historical `CorpusEntry`;
 * `profileMembership` makes the reviewed app/MCP packaging explicit so
 * catalog-driven lanes (§10.2) can consume the same registry.
 */
export interface ReviewedCorpusSourceEntry {
  readonly slug: string;
  readonly fixture: string;
  /** Template family: absent selects the Word export; `"treaty"` is
   *  explicit. Feeds `rulesFor`/`templateIdFor` and the builder's
   *  positional catalog-digest stream (`entry.rules ?? "word"`). */
  readonly rules?: "treaty";
  readonly meta: NormaMeta;
  /** Exact text-bearing article-row count this authority must ingest to. */
  readonly expectedArticles: number;
  /**
   * Per-authority source-summary expectations (the audited
   * ledger breakdown — articles / emitted transitorios / persisted
   * known gaps / nonpersisted reviewed exclusions / total ledger). The
   * builder asserts each authority's ledger exactly equals
   * `articles + transitorios + knownGaps + reviewedExclusions`; every
   * unknown authority carries zero transitories/gaps/exclusions and a
   * ledger equal to its article count. The list pins the production
   * totals in the build (no manifest derivation) and is the source of
   * truth for the per-authority source summary in `validateCorpusDbV3`.
   */
  readonly sourceSummary: {
    readonly articles: number;
    readonly transitorios: number;
    readonly knownGaps: number;
    readonly reviewedExclusions: number;
  };
  /**
   * Fail-closed admission set: exact JavaScript-string equality, bounded
   * multiplicity. The strings listed here are the ONLY `norma.warnings`
   * this authority is allowed to emit at build; every other
   * warning, every near-match, and every additional duplicate fails the
   * build via `assertCorpusExtractionPublishable`. Approvals are upper
   * bounds, not generated candidate expectations — they MUST be reviewed
   * and committed beside each entry (not derived from `norma.warnings`,
   * the manifest, or any candidate output).
   */
  readonly approvedWarnings: readonly string[];
  /** Reviewed profile membership; every current entry is packaged for
   *  BOTH the app corpus and the MCP distribution. */
  readonly profileMembership: ReviewedProfileMembership;
  /**
   * Optional deeply-readonly legacy capture provenance fallback, present
   * ONLY for the two reviewed captures whose historical fetch has no
   * `_meta.json` sidecar (currently `ct` and `cc`, pinned to the exact
   * owner-approved captured bytes). Every other entry omits this key
   * entirely; no metadata-less capture may be admitted through any other
   * digest, length, response, or tool version.
   */
  readonly legacyCaptureFallback?: ReviewedLegacyCaptureFallback;
}

// Warning templates (§ the audited allowlist). The strings are the EXACT
// extractor output and use the literal em dash (U+2014) emitted by the
// ratio-warning template. No `norma.warnings`, manifest, or candidate
// output feeds them — these are the reviewed contract, committed as code
// beside each entry.
const RATIO = (extracted: number, occurrences: number): string =>
  `extractor returned ${extracted} articles but the source contains ${occurrences} "ARTICULO N" occurrence(s) — possible off-template or many dropped`;
const XREF = (articleNumber: string, count: number): string =>
  `article ${articleNumber}: ${count} in-body "Artículo N" cross-reference(s) were folded into the body`;
const ADOPTED_BIS = `article 152: header dropped the "bis" suffix present in its Ficha (Ficha Artículo 152 BIS); adopted "152 bis"`;

// Entry order is the shipped order; counts mirror the release contract
// in src/corpus/manifest.ts so a drift fails here at build time AND at
// startup. The `sourceSummary` field pins the exact audited
// articles / transitorios / known-gaps / reviewed-exclusions / ledger
// breakdown per authority — every ledger row is one of `emitted-article`
// / `emitted-transitory` / `known-gap` / `reviewed-exclusion`. The
// reviewed Penal Word-template capture (5027 / 151473 / canonical
// fingerprint) admits exactly 1 known-gap + 17 reviewed-exclusions via
// `src/cite/reviewed-penal-source-classifications.ts`; CADH keeps its
// existing public CADH-53 known-gap; every other authority has zero
// transitories/gaps/exclusions and `ledger === articles`. The ledger
// identity digest (consumed by `buildReleaseEvidenceIdentityV3`) keys
// off this exact per-authority ordering.
//
// CADH has 81 text-bearing rows among 82 numbered positions: SINALEVI
// v38111 renders art. 53 as "Texto no disponible", and a cite of that
// position surfaces as source-text-unavailable rather than fabricated
// text.
//
// `approvedWarnings` is the audited allowlist for every `norma.warnings`
// value the extractor is permitted to emit on this build.
const REVIEWED_CORPUS_SOURCES_UNFROZEN: readonly ReviewedCorpusSourceEntry[] = [
  { slug: "ct", fixture: "codigo_trabajo_raw.json", expectedArticles: 726, sourceSummary: { articles: 726, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(726, 2351)], meta: { idFichaNorma: 8045, idVersionNorma: 150791, number: "2", name: "Código de Trabajo", tipo: 8, date: "27/08/1943", sourceUrl: SOURCE_URL, importedAt: "1943-08-27T00:00:00.000Z" }, profileMembership: { app: true, mcp: true }, legacyCaptureFallback: { rawSha256: "60482771c0ff3b37aaf31fe93faa0dbad044c7fbe283990f8c5d217ac99bb50c", rawBytes: 4370790, response: { status: 200, contentType: { mediaType: "application/json", charset: "utf-8" }, capturedAt: "2026-07-23T22:34:15.000Z" }, captureToolVersion: "0.0.0" } },
  { slug: "cc", fixture: "codigo_civil_raw.json", expectedArticles: 1410, sourceSummary: { articles: 1410, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(1410, 3256), XREF("417", 1)], meta: { idFichaNorma: 15437, idVersionNorma: 148770, number: "63", name: "Código Civil", tipo: 8, date: "28/09/1887", sourceUrl: SOURCE_URL, importedAt: "1887-09-28T00:00:00.000Z" }, profileMembership: { app: true, mcp: true }, legacyCaptureFallback: { rawSha256: "cebdd8e742e5ad66e81e9f470a6503a50c3820cb359dc270b9ce1d3285f98f23", rawBytes: 5014563, response: { status: 200, contentType: { mediaType: "application/json", charset: "utf-8" }, capturedAt: "2026-07-24T16:10:47.000Z" }, captureToolVersion: "0.0.0" } },
  { slug: "cp", fixture: "constitucion_politica_raw.json", expectedArticles: 197, sourceSummary: { articles: 197, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(197, 486), XREF("177", 1), XREF("197", 20)], meta: { idFichaNorma: 871, idVersionNorma: 147492, number: "0", name: "Constitución Política", tipo: 1, date: "07/11/1949", sourceUrl: SOURCE_URL, importedAt: "1949-11-07T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "lgap", fixture: "lgap_raw.json", expectedArticles: 370, sourceSummary: { articles: 370, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(370, 826)], meta: { idFichaNorma: 13231, idVersionNorma: 150737, number: "6227", name: "Ley General de la Administración Pública", tipo: 8, date: "02/05/1978", sourceUrl: SOURCE_URL, importedAt: "1978-05-02T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "ljc", fixture: "ljc_raw.json", expectedArticles: 114, sourceSummary: { articles: 114, transitorios: 3, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(114, 287)], meta: { idFichaNorma: 38533, idVersionNorma: 127124, number: "7135", name: "Ley de la Jurisdicción Constitucional", tipo: 8, date: "11/10/1989", sourceUrl: SOURCE_URL, importedAt: "1989-10-11T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "penal", fixture: "codigo_penal_raw.json", expectedArticles: 485, sourceSummary: { articles: 485, transitorios: 0, knownGaps: 1, reviewedExclusions: 17 }, approvedWarnings: [RATIO(485, 2141), XREF("117", 1), XREF("128", 1), XREF("261 bis", 1)], meta: { idFichaNorma: 5027, idVersionNorma: 151473, number: "4573", name: "Código Penal", tipo: 8, date: "04/05/1970", sourceUrl: SOURCE_URL, importedAt: "1970-05-04T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "procesal_penal", fixture: "codigo_procesal_penal_raw.json", expectedArticles: 505, sourceSummary: { articles: 505, transitorios: 5, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(505, 1352), ADOPTED_BIS], meta: { idFichaNorma: 41297, idVersionNorma: 151404, number: "7594", name: "Código Procesal Penal", tipo: 8, date: "10/04/1996", sourceUrl: SOURCE_URL, importedAt: "1996-04-10T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "familia", fixture: "codigo_familia_raw.json", expectedArticles: 257, sourceSummary: { articles: 257, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(257, 993)], meta: { idFichaNorma: 970, idVersionNorma: 145496, number: "5476", name: "Código de Familia", tipo: 8, date: "21/12/1973", sourceUrl: SOURCE_URL, importedAt: "1973-12-21T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "comercio", fixture: "codigo_comercio_raw.json", expectedArticles: 994, sourceSummary: { articles: 994, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(994, 2465)], meta: { idFichaNorma: 6239, idVersionNorma: 151293, number: "3284", name: "Código de Comercio", tipo: 8, date: "30/04/1964", sourceUrl: SOURCE_URL, importedAt: "1964-04-30T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "procesal_civil", fixture: "codigo_procesal_civil_raw.json", expectedArticles: 185, sourceSummary: { articles: 185, transitorios: 6, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(185, 418), XREF("184", 6)], meta: { idFichaNorma: 81360, idVersionNorma: 150778, number: "9342", name: "Código Procesal Civil", tipo: 8, date: "03/02/2016", sourceUrl: SOURCE_URL, importedAt: "2016-02-03T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "cpca", fixture: "codigo_procesal_contencioso_raw.json", expectedArticles: 224, sourceSummary: { articles: 224, transitorios: 5, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(224, 630), XREF("215", 2), XREF("218", 1)], meta: { idFichaNorma: 57436, idVersionNorma: 146091, number: "8508", name: "Código Procesal Contencioso-Administrativo", tipo: 8, date: "28/04/2006", sourceUrl: SOURCE_URL, importedAt: "2006-04-28T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "ninez", fixture: "codigo_ninez_adolescencia_raw.json", expectedArticles: 199, sourceSummary: { articles: 199, transitorios: 6, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(199, 449)], meta: { idFichaNorma: 43077, idVersionNorma: 143888, number: "7739", name: "Código de la Niñez y la Adolescencia", tipo: 8, date: "06/01/1998", sourceUrl: SOURCE_URL, importedAt: "1998-01-06T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "cadh", rules: "treaty", fixture: "cadh_pacto_san_jose_raw.json", expectedArticles: 81, sourceSummary: { articles: 81, transitorios: 0, knownGaps: 1, reviewedExclusions: 0 }, approvedWarnings: [RATIO(81, 175)], meta: { idFichaNorma: 36150, idVersionNorma: 38111, number: "4534", name: "Convención Americana sobre Derechos Humanos (Pacto de San José)", tipo: 8, date: "23/02/1970", sourceUrl: SOURCE_URL, importedAt: "1970-02-23T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "oit87", rules: "treaty", fixture: "oit_c87_raw.json", expectedArticles: 21, sourceSummary: { articles: 21, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(21, 63), XREF("9", 1)], meta: { idFichaNorma: 40025, idVersionNorma: 42182, number: "2561", name: "Convenio OIT 87 Libertad Sindical y Derecho de Sindicalización", tipo: 8, date: "11/05/1960", sourceUrl: SOURCE_URL, importedAt: "1960-05-11T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "oit98", rules: "treaty", fixture: "oit_c98_raw.json", expectedArticles: 16, sourceSummary: { articles: 16, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(16, 54), XREF("5", 1), XREF("10", 1)], meta: { idFichaNorma: 21129, idVersionNorma: 22447, number: "2561", name: "Convenio OIT 98 Derecho de Sindicalización y Negociación Colectiva", tipo: 8, date: "11/05/1960", sourceUrl: SOURCE_URL, importedAt: "1960-05-11T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "oit29", rules: "treaty", fixture: "oit_c29_raw.json", expectedArticles: 33, sourceSummary: { articles: 33, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(33, 106)], meta: { idFichaNorma: 28886, idVersionNorma: 118408, number: "2561", name: "Convenio OIT 29 sobre Trabajo Forzoso u Obligatorio", tipo: 8, date: "11/05/1960", sourceUrl: SOURCE_URL, importedAt: "1960-05-11T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "oit100", rules: "treaty", fixture: "oit_c100_raw.json", expectedArticles: 14, sourceSummary: { articles: 14, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(14, 49), XREF("8", 1)], meta: { idFichaNorma: 41699, idVersionNorma: 43954, number: "2561", name: "Convenio OIT 100 Igualdad de Salario en Labor de Hombres y Mujeres", tipo: 8, date: "11/05/1960", sourceUrl: SOURCE_URL, importedAt: "1960-05-11T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "oit111", rules: "treaty", fixture: "oit_c111_raw.json", expectedArticles: 14, sourceSummary: { articles: 14, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(14, 30)], meta: { idFichaNorma: 32970, idVersionNorma: 34786, number: "2848", name: "Convenio OIT 111 Relativo a la Discriminación en Materia de Empleo y Ocupación", tipo: 8, date: "26/10/1961", sourceUrl: SOURCE_URL, importedAt: "1961-10-26T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "oit105", rules: "treaty", fixture: "oit_c105_raw.json", expectedArticles: 10, sourceSummary: { articles: 10, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(10, 25)], meta: { idFichaNorma: 40139, idVersionNorma: 42305, number: "2330", name: "Convenio OIT 105 sobre Abolición del Trabajo Forzoso", tipo: 8, date: "09/04/1959", sourceUrl: SOURCE_URL, importedAt: "1959-04-09T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
  { slug: "oit138", rules: "treaty", fixture: "oit_c138_raw.json", expectedArticles: 18, sourceSummary: { articles: 18, transitorios: 0, knownGaps: 0, reviewedExclusions: 0 }, approvedWarnings: [RATIO(18, 56), XREF("10", 1)], meta: { idFichaNorma: 47340, idVersionNorma: 50218, number: "5594", name: "Convenio OIT 138 sobre la Edad Mínima de Admisión al Empleo", tipo: 8, date: "21/10/1974", sourceUrl: SOURCE_URL, importedAt: "1974-10-21T00:00:00.000Z" }, profileMembership: { app: true, mcp: true } },
];

function deepFreezeLegacyCaptureFallback(
  fallback: ReviewedLegacyCaptureFallback,
): ReviewedLegacyCaptureFallback {
  return Object.freeze({
    ...fallback,
    response: Object.freeze({
      ...fallback.response,
      contentType: Object.freeze({ ...fallback.response.contentType }),
    }),
  });
}

function deepFreezeSourceEntry(entry: ReviewedCorpusSourceEntry): ReviewedCorpusSourceEntry {
  return Object.freeze({
    ...entry,
    meta: Object.freeze({ ...entry.meta }) as NormaMeta,
    sourceSummary: Object.freeze({ ...entry.sourceSummary }),
    approvedWarnings: Object.freeze([...entry.approvedWarnings]),
    profileMembership: Object.freeze({ ...entry.profileMembership }),
    ...(entry.legacyCaptureFallback
      ? {
          legacyCaptureFallback: deepFreezeLegacyCaptureFallback(
            entry.legacyCaptureFallback,
          ),
        }
      : {}),
  });
}

/**
 * The reviewed 20-authority build source set, in shipped order, deeply
 * frozen. This is the single source of truth shared by the corpus
 * builder and every later reviewed lane (catalog cross-checks, source
 * replay) — never copy an entry or a warning string elsewhere.
 */
export const REVIEWED_CORPUS_SOURCES: readonly ReviewedCorpusSourceEntry[] =
  Object.freeze(
    REVIEWED_CORPUS_SOURCES_UNFROZEN.map((entry) => deepFreezeSourceEntry(entry)),
  );

/** The canonical Word/treaty `Rules` object selected by an entry's
 *  reviewed template family. Returns the shared module-level rules
 *  instances — never a copy. */
export function rulesFor(entry: ReviewedCorpusSourceEntry): Rules {
  return entry.rules === "treaty" ? sinaleviTreatyRules : sinaleviWordRules;
}

/** The reviewed template id selected by an entry's template family. */
export function templateIdFor(entry: ReviewedCorpusSourceEntry): ReviewedTemplateId {
  return entry.rules === "treaty" ? "sinalevi-treaty-export" : "sinalevi-word-export";
}

/**
 * S-INI — deterministic template fingerprint. The fingerprint covers
 * the RULES serialization (the template contract itself), never the
 * captured bytes: filename or candidate DB data is not authority, and
 * the reviewed catalog pins the expected fingerprint per template.
 * This is the ONE implementation; the catalog/sidecar lanes validate
 * fingerprint FORMATS, they never recompute them.
 */
export function templateFingerprintFor(rules: Rules): string {
  const canonical = JSON.stringify({
    strip: rules.strip.map((r) =>
      typeof r.match === "string" ? r.match : String(r.match),
    ),
    fragmentBoundary: String(rules.fragmentBoundary),
    articleHeader: String(rules.articleHeader),
    fichaTerminator: String(rules.fichaTerminator),
    transitoryHeader: rules.transitoryHeader ? String(rules.transitoryHeader) : null,
    headingRules: rules.headingRules.map((h) => ({
      kind: h.kind,
      match: String(h.match),
    })),
    normalizeNumber: rules.normalizeNumber.toString(),
    whitespaceCollapse: String(rules.whitespaceCollapse),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * The full reviewed template contract for an entry: id, canonical
 * fingerprint, and the zero-ficha admission fact. Both reviewed
 * templates allow handler ficha `0` (§5.1), matching the extractor's
 * template gate and every reviewed capture/sidecar lane.
 */
export function templateContractFor(
  entry: ReviewedCorpusSourceEntry,
): TemplateContract {
  return Object.freeze({
    templateId: templateIdFor(entry),
    templateFingerprint: templateFingerprintFor(rulesFor(entry)),
    allowsZeroFicha: true,
  });
}

/**
 * The trusted `CaptureContext` (§5.1) for a reviewed source entry:
 * authority/version identity come from the reviewed Ficha metadata and
 * the template identity from the canonical derivations above.
 */
export function captureContextFor(entry: ReviewedCorpusSourceEntry): CaptureContext {
  return {
    authorityId: entry.meta.idFichaNorma,
    versionId: entry.meta.idVersionNorma,
    templateId: templateIdFor(entry),
    templateFingerprint: templateFingerprintFor(rulesFor(entry)),
  };
}
