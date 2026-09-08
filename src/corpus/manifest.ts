/**
 * Corpus release manifest — the single source of truth for what a valid
 * packaged corpus is (H-01).
 *
 * The build script (`scripts/build-corpus-artifact.ts`) writes this
 * manifest next to `corpus.sqlite`; every startup path that loads the
 * packaged corpus validates the artifact against it BEFORE using it:
 * presence, manifest format/schema version, SQLite integrity, expected
 * authority counts, and per-norma identity. Failures are fail-closed
 * typed codes so callers surface actionable errors instead of silently
 * booting half-broken or falling back to a fresh corpus.
 *
 * Portable by design: no Node imports, no fetch, no fs — pure functions
 * over `Db` (see src/db/database.ts) so both the webview and unit tests
 * can drive them with fake handles.
 */
import type { Db, Row } from "../db/database.js";
import {
  isCanonicalArticleNumber,
  normalizeArticleNumber,
} from "../cite/article-number.js";
import {
  CORPUS_CONTENT_IDENTITY_RE,
  computeAdoptedIdentityV2,
  computeCorpusContentIdentity,
  computeReleaseEvidenceIdentityV2,
  computeStructuredCorpusIdentity,
  CORPUS_ADOPTED_IDENTITY_ALGORITHM_V1,
  CORPUS_ADOPTED_IDENTITY_ALGORITHM_V2,
  CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2,
  type CorpusIdentityValue,
} from "./content-identity.js";

/** Manifest format + corpus schema version. Bumped whenever the
 *  expected corpus shape changes; startup refuses a mismatch.
 *  V1 = the LEGACY lane: still fully readable/validatable during the
 *  vNext transition (an old packaged artifact must boot an old app and
 *  a vNext app alike); NOTHING may assume it is the current shape. */
export const CORPUS_MANIFEST_FORMAT_VERSION = 2;
export const CORPUS_SCHEMA_VERSION = 1;
/** S-INI (corpus vNext): manifest format v3 + corpus schema v2. */
export const CORPUS_MANIFEST_FORMAT_VERSION_V3 = 3;
export const CORPUS_SCHEMA_VERSION_V2 = 2;
export {
  CORPUS_ADOPTED_IDENTITY_ALGORITHM_V1,
  CORPUS_ADOPTED_IDENTITY_ALGORITHM_V2,
  CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2,
};

/** Fixture set the corpus is built from (source identity). */
export const CORPUS_FIXTURE_SET = "fixtures/full";

/** Source captures backing each authority. Gitignored by design; the
 *  build and the corpus evidence profile are fail-closed without them. */
export const CORPUS_FIXTURE_FILES: readonly string[] = [
  "codigo_trabajo_raw.json",
  "codigo_civil_raw.json",
  "constitucion_politica_raw.json",
  "lgap_raw.json",
  "ljc_raw.json",
  "codigo_penal_raw.json",
  "codigo_procesal_penal_raw.json",
  "codigo_familia_raw.json",
  "codigo_comercio_raw.json",
  "codigo_procesal_civil_raw.json",
  "codigo_procesal_contencioso_raw.json",
  "codigo_ninez_adolescencia_raw.json",
  "cadh_pacto_san_jose_raw.json",
  "oit_c87_raw.json",
  "oit_c98_raw.json",
  "oit_c29_raw.json",
  "oit_c100_raw.json",
  "oit_c111_raw.json",
  "oit_c105_raw.json",
  "oit_c138_raw.json",
];

/** Packaged locations — one definition, used by the build script, the
 * prebuild gate, and the runtime loader alike. */
export const CORPUS_BASE_PATH = "/corpus";
export const CORPUS_DB_FILE = "corpus.sqlite";
export const CORPUS_MANIFEST_FILE = "corpus-manifest.json";
/** Tracked canonical source notice (root `LEGAL_CORPUS_NOTICE.txt`) copied
 * deterministically into the package beside the DB + manifest (review fix #8). */
export const CORPUS_NOTICE_FILE = "NOTICE-SINALEVI.txt";
export const CORPUS_DB_URL = `${CORPUS_BASE_PATH}/${CORPUS_DB_FILE}`;
export const CORPUS_MANIFEST_URL = `${CORPUS_BASE_PATH}/${CORPUS_MANIFEST_FILE}`;

export interface CorpusNormaProfile {
  slug: string;
  docId: number;
  versionId: number;
  name: string;
  /** Articles ingested for this norma — validated at startup. */
  /** Exact count of loaded text-bearing article rows, not numbered positions. */
  articleCount: number;
}

export interface CorpusNormaExpectation extends CorpusNormaProfile {
  /** Deterministic identity of every corpus-owned field adoption reads. */
  contentIdentity: string;
}

export interface CorpusManifest {
  formatVersion: number;
  schemaVersion: number;
  fixtureSet: string;
  builtAt: string;
  readonly normas: readonly CorpusNormaExpectation[];
}

export interface CorpusManifestProfile {
  formatVersion: number;
  schemaVersion: number;
  fixtureSet: string;
  builtAt: string;
  readonly normas: readonly CorpusNormaProfile[];
}

export type CorpusFailureCode =
  | "manifest-missing"
  | "manifest-unreadable"
  | "manifest-invalid"
  | "manifest-version"
  | "notice-missing"
  | "notice-drift"
  | "corpus-missing"
  | "corpus-unreadable"
  | "corpus-integrity"
  | "corpus-authority-counts"
  | "corpus-content-identity"
  | "corpus-normas";

/** Startup/build failure with a fixed code and an actionable message. */
export class CorpusError extends Error {
  readonly code: CorpusFailureCode;

  constructor(code: CorpusFailureCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "CorpusError";
    this.code = code;
    // Assigned manually: `Error.cause` needs the ES2022.Error lib, which
    // not every tsconfig in this repo includes.
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * A generation-scoped reviewed authority list wrapper. Every lane
 * (legacy manifest v2 / corpus schema v1; candidate manifest v3 /
 * corpus schema v2) carries its OWN wrapper constant so the v3 corpus
 * API can reject a forced legacy 2/1 — or any untagged bare norma
 * array — with `manifest-version` even though the per-row data is
 * value-identical between the two generations. The formatVersion and
 * schemaVersion fields match the reviewed pair exactly, fixtureSet
 * mirrors the corpus-wide identity, and normas is a separately
 * allocated frozen array of separately allocated frozen rows.
 */
export interface CorpusNormaProfileSet {
  readonly formatVersion: number;
  readonly schemaVersion: number;
  readonly fixtureSet: string;
  readonly normas: readonly CorpusNormaProfile[];
}

type ReadonlyProfileSet = Readonly<CorpusNormaProfileSet>;

/** Expected packaged corpus: 20 authorities, 5 857 articles total. The
 *  counts below mirror the per-slug assertions in the build script and
 *  are re-validated at startup; drift fails closed on both sides. The
 *  SAME content is used by BOTH the legacy v2/schema1 and the candidate
 *  v3/schema2 reviewed profiles so each lane can carry its own reviewed
 *  authority/article-count profile later without changing any count or
 *  MCP code yet. */
const CORPUS_NORMA_PROFILE_SEED: ReadonlyArray<{
  readonly slug: string;
  readonly docId: number;
  readonly versionId: number;
  readonly name: string;
  readonly articleCount: number;
}> = Object.freeze([
  { slug: "ct", docId: 8045, versionId: 150791, name: "Código de Trabajo", articleCount: 724 },
  { slug: "cc", docId: 15437, versionId: 148770, name: "Código Civil", articleCount: 1410 },
  { slug: "cp", docId: 871, versionId: 147492, name: "Constitución Política", articleCount: 197 },
  { slug: "lgap", docId: 13231, versionId: 150737, name: "Ley General de la Administración Pública", articleCount: 369 },
  { slug: "ljc", docId: 38533, versionId: 127124, name: "Ley de la Jurisdicción Constitucional", articleCount: 113 },
  { slug: "penal", docId: 5027, versionId: 151473, name: "Código Penal", articleCount: 477 },
  { slug: "procesal_penal", docId: 41297, versionId: 151404, name: "Código Procesal Penal", articleCount: 504 },
  { slug: "familia", docId: 970, versionId: 145496, name: "Código de Familia", articleCount: 256 },
  { slug: "comercio", docId: 6239, versionId: 151293, name: "Código de Comercio", articleCount: 993 },
  { slug: "procesal_civil", docId: 81360, versionId: 150778, name: "Código Procesal Civil", articleCount: 185 },
  { slug: "cpca", docId: 57436, versionId: 146091, name: "Código Procesal Contencioso-Administrativo", articleCount: 224 },
  { slug: "ninez", docId: 43077, versionId: 143888, name: "Código de la Niñez y la Adolescencia", articleCount: 198 },
  // CADH: 81 text-bearing rows among 82 numbered positions — SINALEVI v38111
  // renders art. 53 as "Texto no disponible". A cite of that position surfaces
  // as source-text-unavailable rather than article nonexistence or text.
  { slug: "cadh", docId: 36150, versionId: 38111, name: "Convención Americana sobre Derechos Humanos (Pacto de San José)", articleCount: 81 },
  { slug: "oit87", docId: 40025, versionId: 42182, name: "Convenio OIT 87 Libertad Sindical y Derecho de Sindicalización", articleCount: 21 },
  { slug: "oit98", docId: 21129, versionId: 22447, name: "Convenio OIT 98 Derecho de Sindicalización y Negociación Colectiva", articleCount: 16 },
  { slug: "oit29", docId: 28886, versionId: 118408, name: "Convenio OIT 29 sobre Trabajo Forzoso u Obligatorio", articleCount: 33 },
  { slug: "oit100", docId: 41699, versionId: 43954, name: "Convenio OIT 100 Igualdad de Salario en Labor de Hombres y Mujeres", articleCount: 14 },
  { slug: "oit111", docId: 32970, versionId: 34786, name: "Convenio OIT 111 Relativo a la Discriminación en Materia de Empleo y Ocupación", articleCount: 14 },
  { slug: "oit105", docId: 40139, versionId: 42305, name: "Convenio OIT 105 sobre Abolición del Trabajo Forzoso", articleCount: 10 },
  { slug: "oit138", docId: 47340, versionId: 50218, name: "Convenio OIT 138 sobre la Edad Mínima de Admisión al Empleo", articleCount: 18 },
]);

/** Per-slug article-count overrides applied ONLY to the CANDIDATE
 *  v3/schema2 reviewed profile. The legacy v2/schema1 lane keeps the
 *  historical 5 857 totals byte-identical (no overrides); the candidate
 *  lane picks up the eight audited Word-template-parser-widening
 *  corrections:
 *
 *    familia          256 → 257   (Articulo78.-      / id 5542)
 *    comercio         993 → 994   (Articulo.530-     / id 34664)
 *    ninez            198 → 199   ((*)Articulo 155°- / id 185837)
 *    procesal_penal   504 → 505   ((*)ARTICULO 437.- / id 180681)
 *    ct               724 → 726   (Articulo 97bis-   / id 205535;
 *                                 Articulo 376 quinquies- / id 205531)
 *    lgap             369 → 370   (Articulos 274.-   / id 77341)
 *    ljc              113 → 114   (Articulo 6.En caso… / id 171370)
 *    penal            477 → 485   (Penal provisional recovery seam,
 *                                 gated to authority 5027 / version
 *                                 151473 / template `sinalevi-word-export`,
 *                                 admits the eight audited rows:
 *                                 53 bis / id 215676; 175 quinquies /
 *                                 id 215671; 175 sexies / id 215672;
 *                                 175 septies / id 215673; 257 ter /
 *                                 id 215634; 279 quinquies / id 215662;
 *                                 279 sexies / id 215663; 339 / id 24116).
 *                                 See `PENAL_PROVISIONAL_ADMISSION` and
 *                                 `PENAL_RECOVERY_SHAPE_*_RE` in
 *                                 `src/sinalevi/extractor.ts`.)
 *
 *  Net candidate v3 total: 5 873. The override map is the single
 *  source of truth: it is fully consumed by `candidateProfileRows()`,
 *  every key matches an entry in the legacy seed, and any future
 *  candidate-only addition must be committed here first. Drift
 *  between the override map and the legacy seed (missing key,
 *  unknown key, unconsumed entry) fails the candidate-row factory.
 *
 *  The override object's OWN STRING KEYS are independently pinned
 *  against the frozen `EXPECTED_CANDIDATE_OVERRIDE_SLUGS` inventory
 *  below BEFORE any candidate row is built: same order, same set, no
 *  symbol keys, no missing/extra keys. A mutation that deletes any
 *  single override (e.g. by removing a key) fails the module-load
 *  check at the inventory-comparison gate, not merely by lowering the
 *  derived total. */
const CANDIDATE_ARTICLE_COUNT_OVERRIDES: Readonly<Record<string, number>> =
  Object.freeze({
    familia: 257,
    comercio: 994,
    ninez: 199,
    procesal_penal: 505,
    ct: 726,
    lgap: 370,
    ljc: 114,
    penal: 485,
  });

/** Independent frozen inventory of the override-object's own string
 *  keys, in the same order they appear in `CANDIDATE_ARTICLE_COUNT_OVERRIDES`.
 *  This is the EXTERNAL reviewer contract for the candidate override
 *  map — declared separately from the map itself so a deletion, a
 *  reorder, an extra key, or a symbol key on the override object can
 *  be detected against the inventory WITHOUT consulting the override
 *  object or the candidate profile for "ground truth". Adding a new
 *  candidate-only override must commit BOTH this entry AND the map
 *  entry together; removing one without the other fails the module
 *  load before any caller reads the wrapper. Exported for test
 *  evidence: focused tests compare the inventory against an
 *  independently declared expected slug set (NOT against the override
 *  object or the candidate profile). */
export const EXPECTED_CANDIDATE_OVERRIDE_SLUGS: readonly string[] = Object.freeze([
  "familia",
  "comercio",
  "ninez",
  "procesal_penal",
  "ct",
  "lgap",
  "ljc",
  "penal",
]);

/** Each call returns a NEW frozen array of NEW frozen row objects. The
 *  legacy factory maps the shared seed; the candidate factory applies
 *  `CANDIDATE_ARTICLE_COUNT_OVERRIDES` on top of the same seed so each
 *  lane carries its own reviewed authority/article-count profile. The
 *  two factories return separately-allocated arrays and rows so no
 *  wrapper can accidentally share a row or array reference with its
 *  sibling — and a mutation against one cannot mutate the other. */
function freezeCorpusNormaProfileRows(): readonly CorpusNormaProfile[] {
  return Object.freeze(
    CORPUS_NORMA_PROFILE_SEED.map((entry) =>
      Object.freeze({ ...entry }) as CorpusNormaProfile,
    ),
  ) as readonly CorpusNormaProfile[];
}

/** Validate the override object's own string keys against the frozen
 *  inventory `EXPECTED_CANDIDATE_OVERRIDE_SLUGS`: same order, same set,
 *  no symbol keys, no missing/extra keys. Returns the override object's
 *  own string keys (which is what the candidate-row factory consumes).
 *  The inventory is the external contract; the override object is the
 *  implementation. Drift between them — including a single-key deletion
 *  that would otherwise only lower the derived total — fails the module
 *  load HERE, BEFORE any candidate row is built. */
function assertCandidateOverrideKeysMatchInventory(): readonly string[] {
  // `Reflect.ownKeys` returns ALL own keys — string keys in insertion
  // order, then symbol keys in insertion order. We split and check both.
  const ownKeys = Reflect.ownKeys(CANDIDATE_ARTICLE_COUNT_OVERRIDES);
  const stringKeys: string[] = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new Error(
        `candidate override map carries a non-string own key ${String(key)}; only canonical slug string keys are permitted`,
      );
    }
    stringKeys.push(key);
  }
  if (
    stringKeys.length !== EXPECTED_CANDIDATE_OVERRIDE_SLUGS.length ||
    stringKeys.some((key, index) => key !== EXPECTED_CANDIDATE_OVERRIDE_SLUGS[index])
  ) {
    const got = stringKeys.join(",");
    const want = EXPECTED_CANDIDATE_OVERRIDE_SLUGS.join(",");
    throw new Error(
      `candidate override map keys [${got}] do not match the pinned inventory [${want}] (order, set, length)`,
    );
  }
  return stringKeys;
}

function freezeCandidateCorpusNormaProfileRows(): readonly CorpusNormaProfile[] {
  // Inventory-pin first: own string keys must equal the frozen
  // EXPECTED_CANDIDATE_OVERRIDE_SLUGS exactly (order, set, length) AND
  // there must be no symbol own keys. A deletion or reorder of any
  // single override fails here before the unknown-slug scan runs.
  const overrideSlugs = assertCandidateOverrideKeysMatchInventory();
  const slugsInSeed = new Set(CORPUS_NORMA_PROFILE_SEED.map((entry) => entry.slug));
  for (const slug of overrideSlugs) {
    if (!slugsInSeed.has(slug)) {
      throw new Error(
        `candidate profile override refers to unknown slug ${slug}; every override must reference a row in the shared seed`,
      );
    }
  }
  const rows: CorpusNormaProfile[] = CORPUS_NORMA_PROFILE_SEED.map((entry) => {
    const override = CANDIDATE_ARTICLE_COUNT_OVERRIDES[entry.slug];
    return Object.freeze({
      ...entry,
      ...(override !== undefined ? { articleCount: override } : {}),
    }) as CorpusNormaProfile;
  });
  return Object.freeze(rows) as readonly CorpusNormaProfile[];
}

/** Module-construction self-check: every committed override must have
 *  been fully consumed by the candidate-row factory (no unconsumed
 *  entries left over). Drift between the override map and the legacy
 *  seed fails the module load before any caller reads the wrappers. */
const _seedSlugSet = new Set(CORPUS_NORMA_PROFILE_SEED.map((entry) => entry.slug));
for (const slug of Object.keys(CANDIDATE_ARTICLE_COUNT_OVERRIDES)) {
  if (!_seedSlugSet.has(slug)) {
    throw new Error(
      `candidate override ${slug} is not a slug in the shared seed; remove the override or add the slug to the seed`,
    );
  }
}
{
  // Fully-consumed invariant: every override was applied. The factory
  // itself only consumes overrides whose key is in the seed, so a
  // key-not-in-seed condition was just rejected above; here we assert
  // the candidate factory's article-count total equals
  // legacy_total + Σ(override - legacy_for_slug).
  const seedBySlug = new Map(
    CORPUS_NORMA_PROFILE_SEED.map((entry) => [entry.slug, entry.articleCount]),
  );
  const overrideDelta = Object.entries(CANDIDATE_ARTICLE_COUNT_OVERRIDES).reduce(
    (sum, [slug, count]) => sum + (count - (seedBySlug.get(slug) ?? 0)),
    0,
  );
  const legacyTotal = CORPUS_NORMA_PROFILE_SEED.reduce(
    (sum, entry) => sum + entry.articleCount,
    0,
  );
  const candidateTotal = freezeCandidateCorpusNormaProfileRows().reduce(
    (sum, entry) => sum + entry.articleCount,
    0,
  );
  if (candidateTotal !== legacyTotal + overrideDelta) {
    throw new Error(
      `candidate profile total ${candidateTotal} does not equal legacy ${legacyTotal} + override delta ${overrideDelta}`,
    );
  }
}

/** Reviewed legacy generation wrapper: manifest format v2 / corpus schema
 *  v1. Frozen wrapper carrying exactly `2/1` plus the shared fixture
 *  identity and a separately-allocated frozen array of frozen rows.
 *  Use this for the LEGACY v2 lane only; the v3 lane carries its own
 *  wrapper (see `CORPUS_NORMAS_PROFILE_V3_SCHEMA2`). */
export const CORPUS_NORMAS_PROFILE_V2_SCHEMA1: ReadonlyProfileSet =
  Object.freeze({
    formatVersion: 2,
    schemaVersion: 1,
    fixtureSet: CORPUS_FIXTURE_SET,
    normas: freezeCorpusNormaProfileRows(),
  });

/** Reviewed candidate generation wrapper: manifest format v3 / corpus
 *  schema v2 (S-INI). Frozen wrapper carrying exactly `3/2` plus the
 *  shared fixture identity and a separately-allocated frozen array
 *  of frozen rows whose per-slug `articleCount` reflects the eight
 *  Word-template-parser-widening corrections documented on
 *  `CANDIDATE_ARTICLE_COUNT_OVERRIDES` (legacy total 5 857 → candidate
 *  total 5 873). Every v3 API (`createCorpusManifestV3`,
 *  `assertManifestV3Usable`, `validateCorpusDbV3`) demands this tagged
 *  shape — a legacy 2/1 wrapper forced through a cast is rejected with
 *  `manifest-version` even though most rows are value-identical. */
export const CORPUS_NORMAS_PROFILE_V3_SCHEMA2: ReadonlyProfileSet =
  Object.freeze({
    formatVersion: 3,
    schemaVersion: 2,
    fixtureSet: CORPUS_FIXTURE_SET,
    normas: freezeCandidateCorpusNormaProfileRows(),
  });

/** Pure selector that returns the reviewed generation wrapper constant
 *  BY REFERENCE for the only two reviewed `formatVersion/schemaVersion`
 *  pairs: `2/1` (legacy) and `3/2` (candidate). Anything else —
 *  crossed, missing, fractional, string-coerced, NaN, null, undefined,
 *  symbols, BigInts, null-prototype objects, throwing-`toString`
 *  objects, or hostile proxies — fails closed with the same
 *  `CorpusError("manifest-version")` code. The comparison uses strict
 *  equality (`===`) so the rejection NEVER coerces, stringifies,
 *  inspects custom prototypes, or invokes hooks on the supplied
 *  values: the error message is fixed and content-free, and a hostile
 *  input can never leak a native exception out of this module. */
export function selectCorpusNormaProfile(
  formatVersion: unknown,
  schemaVersion: unknown,
): ReadonlyProfileSet {
  if (formatVersion === 2 && schemaVersion === 1) {
    return CORPUS_NORMAS_PROFILE_V2_SCHEMA1;
  }
  if (formatVersion === 3 && schemaVersion === 2) {
    return CORPUS_NORMAS_PROFILE_V3_SCHEMA2;
  }
  throw new CorpusError(
    "manifest-version",
    "unsupported corpus generation pair",
  );
}

/** Exact own keys a v3 profile wrapper MUST carry (order matters). The
 *  wrapper exposes only the four top-level fields the v3 discriminant
 *  reads; a swapped, missing, extra, replaced, or reordered key on the
 *  wrapper itself fails closed with `manifest-version` BEFORE any DB or
 *  manifest content is consulted — independent of the per-row check. */
const V3_PROFILE_WRAPPER_KEYS = [
  "formatVersion",
  "schemaVersion",
  "fixtureSet",
  "normas",
] as const;

/** Exact keys a v3 profile row MUST carry (order matters — see
 *  `hasExactKeys`). One row's keys cannot drift from this list without
 *  producing a manifest-version failure before any DB or manifest
 *  content is consulted. */
const V3_PROFILE_ROW_KEYS = [
  "slug",
  "docId",
  "versionId",
  "name",
  "articleCount",
] as const;

/** Canonical slug shape (already used by the v2 profile build seed). */
const V3_CANONICAL_SLUG_RE = /^[a-z][a-z0-9_]*$/;

/** Validates and snapshots the entire caller-owned profile inside ONE
 *  catch-all boundary, returning a newly allocated deeply frozen plain
 *  trusted profile wrapper. After this returns, downstream v3 APIs use
 *  ONLY the trusted returned snapshot — the caller-provided wrapper,
 *  normas array, and rows are NEVER reread. A frozen stateful proxy
 *  that passes every read during admission and then throws on its next
 *  `get` cannot escape as a native error: the v3 APIs no longer hold a
 *  reference to the caller-provided object after the snapshot is taken.
 *
 *  Every field of the wrapper, normas array, and row is captured into
 *  a local primitive BEFORE validation, and the snapshot is built from
 *  those captured locals. `Reflect.ownKeys` is used for wrapper/row
 *  own-key checks so symbol keys, non-enumerable string extras,
 *  reorderings, missing keys, and extras are all rejected.
 *
 *  Any throwable from `Object.isFrozen`, `Reflect.ownKeys`, property
 *  access, array length/index reads, iteration, `Set` operations, or
 *  row validation is converted to the same fixed `CorpusError` code
 *  `manifest-version` with no inspect, stringify, or retention of the
 *  caught value. */
function snapshotV3Profile(profile: unknown): ReadonlyProfileSet {
  try {
    if (profile === null || typeof profile !== "object") {
      throw new CorpusError(
        "manifest-version",
        "v3 corpus API requires the tagged frozen 3/2 wrapper",
      );
    }
    if (!Object.isFrozen(profile)) {
      throw new CorpusError(
        "manifest-version",
        "v3 corpus API requires the tagged frozen 3/2 wrapper",
      );
    }
    const candidate = profile as Record<PropertyKey, unknown>;
    // Exact own-key order/set check on the wrapper via
    // `Reflect.ownKeys`. Returns ALL own keys — string keys (enumerable
    // and non-enumerable) in insertion order, then symbol keys in
    // insertion order — so symbol keys and non-enumerable string
    // extras are exposed for rejection. A hostile `ownKeys` trap is
    // normalized to `manifest-version` by the outer boundary.
    const wrapperKeys = Reflect.ownKeys(candidate);
    if (
      wrapperKeys.length !== V3_PROFILE_WRAPPER_KEYS.length ||
      wrapperKeys.some((key, idx) => key !== V3_PROFILE_WRAPPER_KEYS[idx])
    ) {
      throw new CorpusError(
        "manifest-version",
        "v3 corpus wrapper must carry the exact declared own keys in order",
      );
    }
    // Capture every wrapper field into a local primitive BEFORE any
    // validation. After this point, the caller-provided wrapper is
    // never read again — the snapshot works entirely off the captured
    // locals.
    const formatVersion = candidate.formatVersion;
    const schemaVersion = candidate.schemaVersion;
    const fixtureSet = candidate.fixtureSet;
    const normasValue: unknown = candidate.normas;
    if (formatVersion !== 3 || schemaVersion !== 2) {
      throw new CorpusError(
        "manifest-version",
        "v3 corpus API requires exact 3/2 generation fields",
      );
    }
    if (fixtureSet !== CORPUS_FIXTURE_SET) {
      throw new CorpusError(
        "manifest-version",
        "v3 corpus API requires the canonical fixtureSet reference",
      );
    }
    if (!Array.isArray(normasValue) || !Object.isFrozen(normasValue)) {
      throw new CorpusError(
        "manifest-version",
        "v3 corpus API requires the frozen .normas array",
      );
    }
    const normas = normasValue as readonly unknown[];
    // `normas.length` and `normas[index]` use the array's `[[Get]]`
    // trap; a hostile `get` trap on a frozen normas proxy is captured
    // here and the read result is held in a local — after this point
    // the proxy is never queried again.
    const normasLength: number = normas.length;
    const seenSlugs = new Set<string>();
    const seenDocIds = new Set<number>();
    const snapshottedRows: CorpusNormaProfile[] = [];
    for (let index = 0; index < normasLength; index += 1) {
      const row = normas[index];
      if (row === null || typeof row !== "object" || !Object.isFrozen(row)) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row must be a frozen object",
        );
      }
      const r = row as Record<PropertyKey, unknown>;
      // Exact own-key order/set check on every row, mirroring the
      // wrapper. Symbol keys, extras (enumerable or not), reorderings,
      // and misses are all rejected.
      const rowKeys = Reflect.ownKeys(r);
      if (
        rowKeys.length !== V3_PROFILE_ROW_KEYS.length ||
        rowKeys.some((key, idx) => key !== V3_PROFILE_ROW_KEYS[idx])
      ) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row must carry the exact declared keys in order",
        );
      }
      // Capture every row field into a local primitive BEFORE
      // validation. After this point, the caller-provided row is
      // never read again by the snapshot.
      const slug = r.slug;
      const docId = r.docId;
      const versionId = r.versionId;
      const name = r.name;
      const articleCount = r.articleCount;
      // slug: nonempty canonical slug string.
      if (
        typeof slug !== "string" ||
        slug.length === 0 ||
        !V3_CANONICAL_SLUG_RE.test(slug)
      ) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row slug is not a canonical slug",
        );
      }
      if (seenSlugs.has(slug)) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row duplicates a slug",
        );
      }
      seenSlugs.add(slug);
      // docId: positive safe integer; unique across the wrapper.
      if (!Number.isSafeInteger(docId) || (docId as number) <= 0) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row docId is not a positive safe integer",
        );
      }
      if (seenDocIds.has(docId as number)) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row duplicates a docId",
        );
      }
      seenDocIds.add(docId as number);
      // versionId: positive safe integer.
      if (!Number.isSafeInteger(versionId) || (versionId as number) <= 0) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row versionId is not a positive safe integer",
        );
      }
      // name: nonempty string.
      if (typeof name !== "string" || name.length === 0) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row name is not a nonempty string",
        );
      }
      // articleCount: nonnegative safe integer. The v3 domain is
      // NONNEGATIVE (an authority may ship with zero text-bearing rows);
      // higher layers (manifest totals, validateCorpusDbV3) layer the
      // "this authority must carry at least one article" semantics on
      // top of admission.
      if (
        !Number.isSafeInteger(articleCount) ||
        (articleCount as number) < 0
      ) {
        throw new CorpusError(
          "manifest-version",
          "v3 corpus row articleCount is not a nonnegative safe integer",
        );
      }
      // Build a fresh plain row snapshot from the captured local
      // primitives; freeze it before pushing so the new array carries
      // only deeply-frozen entries with no caller-reference retention.
      snapshottedRows.push(Object.freeze({
        slug,
        docId,
        versionId,
        name,
        articleCount,
      }) as CorpusNormaProfile);
    }
    // Freeze the new array and the new wrapper before returning. The
    // returned value carries only primitives + a deeply-frozen array
    // of deeply-frozen plain rows — no caller reference is retained.
    const frozenArray = Object.freeze(snapshottedRows) as readonly CorpusNormaProfile[];
    return Object.freeze({
      formatVersion,
      schemaVersion,
      fixtureSet,
      normas: frozenArray,
    }) as ReadonlyProfileSet;
  } catch {
    // Every throwable inside the boundary is converted to the same
    // fixed `CorpusError` code `manifest-version` with no inspect,
    // stringify, or retention of the caught value. A stateful proxy
    // whose `get` trap throws on its next read inside the boundary is
    // normalized here, never leaking the host exception.
    throw new CorpusError(
      "manifest-version",
      "v3 corpus profile snapshot trapped",
    );
  }
}

/** Pure generation-bound helper for the LEGACY (2/1) lane: obtains the
 *  legacy wrapper through the selector and validates it by REFERENCE
 *  against the legacy constant. The strict equality check is the
 *  structural proof that the legacy factory cannot silently consume a
 *  candidate wrapper even though both wrappers' rows are value-
 *  identical. Returns the reviewed legacy wrapper; throws
 *  `manifest-version` if the selector ever yields anything else. */
export function selectLegacyGenerationProfile(): ReadonlyProfileSet {
  const wrapper = selectCorpusNormaProfile(2, 1);
  if (wrapper !== CORPUS_NORMAS_PROFILE_V2_SCHEMA1) {
    throw new CorpusError(
      "manifest-version",
      "legacy lane must read the reviewed 2/1 wrapper",
    );
  }
  return wrapper;
}

/** Pure generation-bound helper for the CANDIDATE (3/2) lane: returns
 *  the reviewed candidate wrapper BY REFERENCE through the selector.
 *  The canonical wrapper is module-owned and trusted (separately
 *  allocated, deeply frozen at module load); the v3 APIs snapshot any
 *  caller-provided profile argument before downstream use. Used as
 *  the default argument to every v3 API so the production routing is
 *  bound to the selector rather than a free-floating reference. */
export function selectCandidateGenerationProfile(): ReadonlyProfileSet {
  return selectCorpusNormaProfile(3, 2);
}

/** The legacy v2 / schema v1 release manifest profile factory. The
 *  format, schema, fixture identity and authority rows are sourced
 *  EXACTLY from the reviewed legacy wrapper, surfaced through the
 *  explicit `generationWrapper` seam; its default is the selector-
 *  bound legacy 2/1 wrapper, and the seam INDEPENDENTLY asserts the
 *  supplied wrapper is the exact reviewed 2/1 constant before the
 *  factory ever consumes `.normas`. Passing the candidate 3/2 wrapper
 *  through this seam (or any other value, including the bare selector
 *  default if its generation ever drifted) fails closed with
 *  `manifest-version` — so swapping the default source to the
 *  candidate lane fails behaviorally even though both wrappers' rows
 *  are value-identical. The returned `.normas` field is the EXACT
 *  frozen array from the reviewed legacy wrapper, surfaced BY
 *  REFERENCE (no per-call clone). A candidate-wrapper source swap,
 *  even though both wrappers' rows are value-identical, is therefore
 *  observable with `toBe` against `CORPUS_NORMAS_PROFILE_V2_SCHEMA1.normas`. */
export function expectedCorpusManifestProfile(
  builtAt: string = new Date(0).toISOString(),
  generationWrapper: ReadonlyProfileSet = selectCorpusNormaProfile(2, 1),
): CorpusManifestProfile {
  if (generationWrapper !== CORPUS_NORMAS_PROFILE_V2_SCHEMA1) {
    throw new CorpusError(
      "manifest-version",
      "legacy lane must read the reviewed 2/1 wrapper",
    );
  }
  return {
    formatVersion: CORPUS_MANIFEST_FORMAT_VERSION,
    schemaVersion: CORPUS_SCHEMA_VERSION,
    fixtureSet: CORPUS_FIXTURE_SET,
    builtAt,
    normas: generationWrapper.normas,
  };
}

/**
 * Build the release manifest from the opened database itself. Content
 * identities are never transcribed into source: the builder derives them
 * from the exact authority rows it is about to export.
 */
export function createCorpusManifest(
  db: Db,
  builtAt: string = new Date(0).toISOString(),
): CorpusManifest {
  const profile = expectedCorpusManifestProfile(builtAt);
  return {
    ...profile,
    normas: profile.normas.map((entry) => ({
      ...entry,
      contentIdentity: contentIdentityFromDb(db, entry.docId),
    })),
  };
}

/** True only for a well-formed manifest at the supported versions whose
 *  authority list equals the expected corpus exactly. */
export function isManifestShapeValid(manifest: unknown): boolean {
  try {
    assertManifestUsable(manifest);
    return true;
  } catch {
    return false;
  }
}

/** Assert that `db` satisfies the release manifest, converting any
 *  validation or engine failure into a fail-closed `CorpusError`. */
export function verifyCorpusAgainstManifest(
  db: Db,
  manifest: CorpusManifest,
): void {
  try {
    validateCorpusDb(db, manifest);
  } catch (cause) {
    if (cause instanceof CorpusError) throw cause;
    throw new CorpusError(
      "corpus-integrity",
      "corpus failed integrity validation and cannot be used",
      { cause },
    );
  }
}

/**
 * Fetch the packaged manifest and open the packaged corpus, validating
 * both before handing the database to the caller. Any fetch, parse,
 * version, integrity, or authority-count problem fails closed with a
 * `CorpusError`; the opened handle is always closed on failure. This is
 * the single entry point every startup path uses to obtain the shipped
 * corpus — there is no silent fallback.
 */
export async function loadAndValidatePackagedCorpus(
  fetchImpl: typeof fetch,
  loadDb: (bytes: Uint8Array) => Promise<Db>,
): Promise<Db> {
  let manifestResponse: Response;
  try {
    manifestResponse = await fetchImpl(CORPUS_MANIFEST_URL);
  } catch (cause) {
    throw new CorpusError(
      "manifest-missing",
      `could not request the packaged corpus manifest at ${CORPUS_MANIFEST_URL}`,
      { cause },
    );
  }
  if (!manifestResponse.ok) {
    throw new CorpusError(
      "manifest-missing",
      `packaged corpus manifest is missing at ${CORPUS_MANIFEST_URL} (HTTP ${manifestResponse.status}). Rebuild it with: npx vite-node scripts/build-corpus-artifact.ts`,
    );
  }
  let manifestJson: unknown;
  try {
    manifestJson = await manifestResponse.json();
  } catch (cause) {
    throw new CorpusError(
      "manifest-unreadable",
      `packaged corpus manifest at ${CORPUS_MANIFEST_URL} is not valid JSON`,
      { cause },
    );
  }
  // S-INI — assertManifestUsable is the single version dispatcher (v3
  // vNext / v2 legacy).
  const manifest = assertManifestUsable(manifestJson);

  let dbResponse: Response;
  try {
    dbResponse = await fetchImpl(CORPUS_DB_URL);
  } catch (cause) {
    throw new CorpusError(
      "corpus-missing",
      `could not request the packaged corpus database at ${CORPUS_DB_URL}`,
      { cause },
    );
  }
  if (!dbResponse.ok) {
    throw new CorpusError(
      "corpus-missing",
      `packaged corpus database is missing at ${CORPUS_DB_URL} (HTTP ${dbResponse.status}). Rebuild it with: npx vite-node scripts/build-corpus-artifact.ts`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await dbResponse.arrayBuffer());
  } catch (cause) {
    throw new CorpusError(
      "corpus-unreadable",
      `packaged corpus database at ${CORPUS_DB_URL} could not be read`,
      { cause },
    );
  }

  let db: Db;
  try {
    db = await loadDb(bytes);
  } catch (cause) {
    throw new CorpusError(
      "corpus-unreadable",
      "packaged corpus database could not be opened as SQLite",
      { cause },
    );
  }
  try {
    verifyCorpusAgainstManifest(db, manifest);
  } catch (cause) {
    try {
      db.close();
    } catch {
      // Preserve the fail-closed startup error even if cleanup also fails.
    }
    throw cause;
  }
  return db;
}

/**
 * Validate parsed manifest JSON against the expected release contract.
 * Throws a `CorpusError` with a fixed code; never returns partially.
 *
 * Lane dispatch is driven by the selector, read from the manifest's
 * raw `formatVersion/schemaVersion` pair. A SINGLE optional
 * `generationProfile` override is exposed — there is no separate
 * legacy expected slot and no opposite-lane slot. The override's only
 * valid values are:
 *
 *   - `undefined`: treated as omission, the selected wrapper drives
 *     the lane;
 *   - the exact reviewed legacy 2/1 wrapper, but ONLY for a legacy
 *     v2 manifest;
 *   - a strictly validated tagged 3/2 wrapper (focused tests), but
 *     ONLY for a candidate v3 manifest.
 *
 * Every other input — the candidate 3/2 wrapper cast through the
 * override slot of a legacy v2 manifest, the legacy 2/1 wrapper cast
 * through the override slot of a candidate v3 manifest, an explicit
 * `null` override, or any malformed same-lane override — is rejected
 * with `manifest-version` BEFORE any DB or manifest field is consumed
 * or any further validation runs. There is no independent default,
 * no fallback, no profile blending, and no compatibility overload.
 * The selector is the single source of truth for which wrapper drives
 * which lane.
 */
export function assertManifestUsable(
  manifest: unknown,
  generationProfile?: ReadonlyProfileSet,
): CorpusManifest {
  // Non-object fails closed with `manifest-invalid` BEFORE we even try
  // the version selector so the historical error code is preserved.
  if (manifest === null || typeof manifest !== "object") {
    throw new CorpusError(
      "manifest-invalid",
      "corpus manifest is not a JSON object",
    );
  }
  const raw = manifest as { formatVersion?: unknown; schemaVersion?: unknown };
  // S-INI — single dispatch point: the selector reads the raw
  // manifest's pair and returns the reviewed generation wrapper BY
  // REFERENCE. Crossed/coerced/missing pairs fail here with
  // `manifest-version`. The selected wrapper is what reaches the
  // matching lane; any override must belong to the same generation
  // or be rejected with `manifest-version`.
  const wrapper = selectCorpusNormaProfile(raw.formatVersion, raw.schemaVersion);
  // Validate the override belongs to the selected generation BEFORE
  // any further read. `null` is rejected (it's not `undefined`); an
  // explicit opposite-generation wrapper is rejected by the
  // per-generation identity check below.
  if (generationProfile === null) {
    throw new CorpusError(
      "manifest-version",
      "explicit null override is not a generation-profile seam",
    );
  }
  // Holds the trusted snapshot returned by `snapshotV3Profile` for
  // the v3 lane, when the caller supplied an explicit override. The
  // trusted snapshot — NEVER the original caller-controlled
  // `generationProfile` — is what reaches `assertManifestV3Usable`,
  // so a stateful proxy that swaps values on later reads cannot
  // cause the dispatcher to admit against the swapped value.
  let trustedProfile: ReadonlyProfileSet | undefined;
  if (generationProfile !== undefined) {
    if (wrapper === CORPUS_NORMAS_PROFILE_V3_SCHEMA2) {
      // v3 lane: the override, if any, must be the candidate 3/2
      // wrapper — snapshot it now so a malformed or hostile proxy is
      // fail-closed with `manifest-version` BEFORE any manifest field
      // is read, AND so the trusted snapshot (NOT the original
      // caller-controlled profile) is what reaches the downstream v3
      // APIs. A stateful proxy that swaps to a different valid row
      // set on a later read therefore cannot cause the dispatcher to
      // admit against the swapped value: the v3 APIs read only the
      // trusted snapshot, never the caller-provided proxy again. A
      // legacy 2/1 wrapper or any malformed value fails closed here.
      trustedProfile = snapshotV3Profile(generationProfile);
    } else if (generationProfile !== CORPUS_NORMAS_PROFILE_V2_SCHEMA1) {
      // Legacy lane: the override, if any, must be the exact reviewed
      // legacy 2/1 constant. A candidate 3/2 wrapper or any other
      // value fails closed here — never silently ignored.
      throw new CorpusError(
        "manifest-version",
        "legacy manifest override must be the reviewed 2/1 wrapper",
      );
    }
  }
  // The trusted snapshot (when present) is the ONLY profile the
  // downstream v3 APIs ever see. The caller-controlled
  // `generationProfile` is dropped here — it is no longer referenced.
  const profileForLane = trustedProfile ?? wrapper;
  if (wrapper === CORPUS_NORMAS_PROFILE_V3_SCHEMA2) {
    return assertManifestV3Usable(manifest, profileForLane) as unknown as CorpusManifest;
  }
  // Legacy lane: the expected profile is built from the legacy
  // wrapper BY REFERENCE — no profile blending, no per-call clone.
  const legacyExpected = expectedCorpusManifestProfile();
  const candidate = manifest as Partial<CorpusManifest>;
  if (!hasExactKeys(candidate, [
    "formatVersion",
    "schemaVersion",
    "fixtureSet",
    "builtAt",
    "normas",
  ])) {
    throw new CorpusError(
      "manifest-invalid",
      "corpus manifest root keys are missing, extra, or reordered",
    );
  }
  if (candidate.formatVersion !== legacyExpected.formatVersion) {
    throw new CorpusError(
      "manifest-version",
      `corpus manifest format version ${String(candidate.formatVersion)} does not match app-supported ${legacyExpected.formatVersion}`,
    );
  }
  if (candidate.schemaVersion !== legacyExpected.schemaVersion) {
    throw new CorpusError(
      "manifest-version",
      `corpus schema version ${String(candidate.schemaVersion)} does not match app-supported ${legacyExpected.schemaVersion}`,
    );
  }
  if (candidate.fixtureSet !== legacyExpected.fixtureSet) {
    throw new CorpusError(
      "manifest-version",
      `corpus fixture set ${String(candidate.fixtureSet)} does not match expected ${legacyExpected.fixtureSet}`,
    );
  }
  if (candidate.builtAt !== legacyExpected.builtAt) {
    throw new CorpusError(
      "manifest-invalid",
      `corpus manifest builtAt ${String(candidate.builtAt)} does not match expected ${legacyExpected.builtAt}`,
    );
  }
  if (!Array.isArray(candidate.normas) || candidate.normas.length !== legacyExpected.normas.length) {
    throw new CorpusError(
      "corpus-authority-counts",
      `corpus manifest lists ${Array.isArray(candidate.normas) ? candidate.normas.length : "no"} authorities, expected ${legacyExpected.normas.length}`,
    );
  }
  const seenDocIds = new Set<number>();
  const seenSlugs = new Set<string>();
  for (const entry of candidate.normas) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !hasExactKeys(entry, [
        "slug",
        "docId",
        "versionId",
        "name",
        "articleCount",
        "contentIdentity",
      ]) ||
      !Number.isSafeInteger(entry.docId) ||
      (entry.docId as number) <= 0 ||
      !Number.isSafeInteger(entry.versionId) ||
      (entry.versionId as number) <= 0 ||
      !Number.isSafeInteger(entry.articleCount) ||
      (entry.articleCount as number) <= 0 ||
      typeof entry.slug !== "string" ||
      !/^[a-z][a-z0-9_]*$/.test(entry.slug) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      typeof entry.contentIdentity !== "string" ||
      !CORPUS_CONTENT_IDENTITY_RE.test(entry.contentIdentity)
    ) {
      throw new CorpusError(
        "manifest-invalid",
        "corpus manifest contains a malformed authority entry",
      );
    }
    if (seenDocIds.has(entry.docId) || seenSlugs.has(entry.slug)) {
      throw new CorpusError(
        "manifest-invalid",
        "corpus manifest contains duplicate authority or slug identities",
      );
    }
    seenDocIds.add(entry.docId);
    seenSlugs.add(entry.slug);
  }
  for (let index = 0; index < legacyExpected.normas.length; index += 1) {
    const want = legacyExpected.normas[index]!;
    const got = candidate.normas[index]!;
    if (
      got.slug !== want.slug ||
      got.docId !== want.docId ||
      got.versionId !== want.versionId ||
      got.name !== want.name ||
      got.articleCount !== want.articleCount
    ) {
      throw new CorpusError(
        "corpus-authority-counts",
        `corpus manifest authority mismatch for ${want.slug} (doc ${want.docId})`,
      );
    }
  }
  return candidate as CorpusManifest;
}

function hasExactKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function authorityArticlesFromDb(
  db: Db,
  docId: number,
): Array<{ number: string; body: string }> {
  const rows = db.query<{ number: unknown; body: unknown }>(
    `SELECT number, body FROM article
      WHERE norma_id = ? ORDER BY doc_order ASC`,
    docId,
  );
  if (
    rows.some(
      (row) =>
        typeof row.number !== "string" ||
        typeof row.body !== "string" ||
        !isCanonicalArticleNumber(row.number) ||
        normalizeArticleNumber(row.number) !== row.number,
    )
  ) {
    throw new CorpusError(
      "corpus-content-identity",
      `corpus authority ${docId} has malformed content identity inputs`,
    );
  }
  return rows as Array<{ number: string; body: string }>;
}

/** Historical `norma.content_hash`, independently recomputed from rows. */
export function articleContentHashFromDb(db: Db, docId: number): string {
  return computeCorpusContentIdentity(authorityArticlesFromDb(db, docId));
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return db
    .query<{ name: string }>(`PRAGMA table_info(${table})`)
    .some((entry) => entry.name === column);
}

function tableExists(db: Db, table: string): boolean {
  return (
    db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
      table,
    )[0]?.n === 1
  );
}

function assertIdentityString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CorpusError(
      "corpus-content-identity",
      `corpus authority identity has malformed ${label}`,
    );
  }
  return value;
}

function assertIdentityInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new CorpusError(
      "corpus-content-identity",
      `corpus authority identity has malformed ${label}`,
    );
  }
  return value as number;
}

function identityNullableString(value: unknown, label: string): string | null {
  return value === null ? null : assertIdentityString(value, label);
}

function identityNullableInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number | null {
  return value === null ? null : assertIdentityInteger(value, label, minimum);
}

/**
 * Compute the full accepted authority identity from every corpus-owned field
 * the adoption path reads: norma metadata (including stable imported_at),
 * hierarchy/path coordinates, article ordinal/body/ficha/order, and optional
 * transitory rows. Surrogate row ids are translated to hierarchy indexes so
 * an equivalent transactional rewrite keeps the same identity.
 */
export function contentIdentityFromDb(db: Db, docId: number): string {
  return computeStructuredCorpusIdentity(identityValuesFromDb(db, docId));
}

/** The exact v1-adopted field stream, shared verbatim by the v1 hash
 *  and as the prefix of the v2 stream (S-INI). */
function identityValuesFromDb(db: Db, docId: number): CorpusIdentityValue[] {
  const norma = db.query<Record<string, unknown> & Row>(
    `SELECT id, version_id, number, name, tipo, date, source_url,
            content_hash, imported_at
       FROM norma WHERE id = ?`,
    docId,
  );
  if (norma.length !== 1) {
    throw new CorpusError(
      "corpus-content-identity",
      `corpus authority ${docId} is missing or duplicated`,
    );
  }
  const n = norma[0]!;
  const values: CorpusIdentityValue[] = [
    "norma",
    assertIdentityInteger(n.id, "norma.id", 1),
    assertIdentityInteger(n.version_id, "norma.version_id", 1),
    assertIdentityString(n.number, "norma.number"),
    assertIdentityString(n.name, "norma.name"),
    assertIdentityInteger(n.tipo, "norma.tipo"),
    assertIdentityString(n.date, "norma.date"),
    assertIdentityString(n.source_url, "norma.source_url"),
    assertIdentityString(n.content_hash, "norma.content_hash"),
    assertIdentityString(n.imported_at, "norma.imported_at"),
  ];

  const hierarchyExtract = hasColumn(db, "hierarchy_node", "extract_order")
    ? "extract_order"
    : "CAST(NULL AS INTEGER)";
  const hierarchy = db.query<Record<string, unknown> & Row>(
    `SELECT id, kind, label, display_label, doc_order,
            ${hierarchyExtract} AS extract_order, parent_id
       FROM hierarchy_node WHERE norma_id = ? ORDER BY doc_order ASC`,
    docId,
  );
  const hierarchyIndex = new Map<number, number>();
  hierarchy.forEach((row, index) => {
    const id = assertIdentityInteger(row.id, "hierarchy.id", 1);
    if (hierarchyIndex.has(id)) {
      throw new CorpusError("corpus-content-identity", "duplicate hierarchy identity");
    }
    hierarchyIndex.set(id, index);
  });
  values.push("hierarchy-count", hierarchy.length);
  const hierarchyLevel: Record<string, number> = {
    libro: 0,
    titulo: 1,
    capitulo: 2,
    seccion: 3,
  };
  const lastHierarchyAtLevel: Array<number | undefined> = [];
  hierarchy.forEach((row, index) => {
    const kind = assertIdentityString(row.kind, "hierarchy.kind");
    const level = hierarchyLevel[kind];
    if (level === undefined || row.doc_order !== index) {
      throw new CorpusError(
        "corpus-content-identity",
        "hierarchy order/kind is not adoption-canonical",
      );
    }
    const parentId = identityNullableInteger(row.parent_id, "hierarchy.parent_id");
    const parentIndex = parentId === null ? null : hierarchyIndex.get(parentId);
    if (parentId !== null && parentIndex === undefined) {
      throw new CorpusError("corpus-content-identity", "unresolved hierarchy parent");
    }
    let expectedParent: number | null = null;
    for (let parentLevel = level - 1; parentLevel >= 0; parentLevel -= 1) {
      if (lastHierarchyAtLevel[parentLevel] !== undefined) {
        expectedParent = lastHierarchyAtLevel[parentLevel]!;
        break;
      }
    }
    if ((parentIndex ?? null) !== expectedParent) {
      throw new CorpusError(
        "corpus-content-identity",
        "hierarchy parent is not adoption-canonical",
      );
    }
    for (
      let resetLevel = level;
      resetLevel < lastHierarchyAtLevel.length;
      resetLevel += 1
    ) {
      lastHierarchyAtLevel[resetLevel] = undefined;
    }
    lastHierarchyAtLevel[level] = index;
    values.push(
      "hierarchy",
      index,
      kind,
      assertIdentityString(row.label, "hierarchy.label"),
      identityNullableString(row.display_label, "hierarchy.display_label"),
      assertIdentityInteger(row.doc_order, "hierarchy.doc_order"),
      identityNullableInteger(row.extract_order, "hierarchy.extract_order"),
      parentIndex ?? null,
    );
  });

  const articleExtract = hasColumn(db, "article", "extract_order")
    ? "extract_order"
    : "CAST(NULL AS INTEGER)";
  const articles = db.query<Record<string, unknown> & Row>(
    `SELECT number, ordinal_raw, body, ficha_ref, hierarchy_node_id,
            doc_order, ${articleExtract} AS extract_order
       FROM article WHERE norma_id = ? ORDER BY doc_order ASC`,
    docId,
  );
  values.push("article-count", articles.length);
  for (let articleIndex = 0; articleIndex < articles.length; articleIndex += 1) {
    const row = articles[articleIndex]!;
    const number = assertIdentityString(row.number, "article.number");
    if (
      !isCanonicalArticleNumber(number) ||
      normalizeArticleNumber(number) !== number
    ) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${docId} has noncanonical article identity`,
      );
    }
    const hierarchyId = identityNullableInteger(
      row.hierarchy_node_id,
      "article.hierarchy_node_id",
    );
    const nodeIndex = hierarchyId === null ? null : hierarchyIndex.get(hierarchyId);
    if (hierarchyId !== null && nodeIndex === undefined) {
      throw new CorpusError("corpus-content-identity", "unresolved article hierarchy");
    }
    if (row.doc_order !== articleIndex) {
      throw new CorpusError(
        "corpus-content-identity",
        "article order is not adoption-canonical",
      );
    }
    values.push(
      "article",
      number,
      assertIdentityString(row.ordinal_raw, "article.ordinal_raw"),
      assertIdentityString(row.body, "article.body"),
      identityNullableString(row.ficha_ref, "article.ficha_ref"),
      nodeIndex ?? null,
      assertIdentityInteger(row.doc_order, "article.doc_order"),
      identityNullableInteger(row.extract_order, "article.extract_order"),
    );
  }

  if (!tableExists(db, "transitory_provision")) {
    values.push("transitory-count", 0);
  } else {
    const transitoryExtract = hasColumn(
      db,
      "transitory_provision",
      "extract_order",
    )
      ? "extract_order"
      : "CAST(NULL AS INTEGER)";
    const transitories = db.query<Record<string, unknown> & Row>(
      `SELECT number, ordinal_raw, attaches_to, body, label,
              hierarchy_node_id, doc_order,
              ${transitoryExtract} AS extract_order
         FROM transitory_provision
        WHERE norma_id = ? ORDER BY doc_order ASC`,
      docId,
    );
    values.push("transitory-count", transitories.length);
    for (
      let transitoryIndex = 0;
      transitoryIndex < transitories.length;
      transitoryIndex += 1
    ) {
      const row = transitories[transitoryIndex]!;
      const hierarchyId = identityNullableInteger(
        row.hierarchy_node_id,
        "transitory.hierarchy_node_id",
      );
      const nodeIndex = hierarchyId === null ? null : hierarchyIndex.get(hierarchyId);
      if (hierarchyId !== null && nodeIndex === undefined) {
        throw new CorpusError("corpus-content-identity", "unresolved transitory hierarchy");
      }
      if (row.doc_order !== transitoryIndex) {
        throw new CorpusError(
          "corpus-content-identity",
          "transitory order is not adoption-canonical",
        );
      }
      values.push(
        "transitory",
        assertIdentityString(row.number, "transitory.number"),
        assertIdentityString(row.ordinal_raw, "transitory.ordinal_raw"),
        assertIdentityString(row.attaches_to, "transitory.attaches_to"),
        assertIdentityString(row.body, "transitory.body"),
        assertIdentityString(row.label, "transitory.label"),
        nodeIndex ?? null,
        assertIdentityInteger(row.doc_order, "transitory.doc_order"),
        identityNullableInteger(row.extract_order, "transitory.extract_order"),
      );
    }
  }
  return values;
}

interface NormaAggregate extends Row {
  id: number;
  version_id: number;
  name: string;
  content_hash: unknown;
  articles: number;
}

/**
 * A code point that can never carry legal text: Unicode whitespace
 * (`\p{White_Space}` — NBSP, em/ideographic spaces, line separators), C0/C1
 * controls (`\p{Cc}` — NUL, EL, …), and format/control characters
 * (`\p{Cf}` — BOM `\uFEFF`, zero-width space/joiner, the bidi embedding and
 * isolate marks, word joiner, soft hyphen). `String.prototype.trim` does NOT
 * strip the Cf/Cc members, so a body of nothing but `\u200B\u200E\ufeff`
 * would otherwise masquerade as text-bearing.
 */
const SUBSTANTIVE_TEXT_RE = /[^\p{White_Space}\p{Cc}\p{Cf}]/u;

/**
 * Shared substantive-text predicate for the release "text-bearing" contract
 * (H-01). True only for strings containing at least one code point that is
 * not Unicode whitespace and not a control/format/bidi/BOM character; the
 * old `trim().length > 0` was misleading because it accepted exactly the
 * invisible-marker-only bodies this rejects. Real legal text (letters,
 * digits, punctuation, accents) always satisfies it. Used by the corpus
 * build (`scripts/build-corpus-artifact.ts`), the app-side packaged-corpus
 * validation (`validateCorpusDb`), and MCP startup (`verifyProfile`).
 */
export function hasSubstantiveText(value: unknown): value is string {
  return typeof value === "string" && SUBSTANTIVE_TEXT_RE.test(value);
}

function normalizeIntegrityResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "number") return String(result);
  if (result instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(result);
    } catch {
      return "<undecodable>";
    }
  }
  return "<unknown>";
}

/**
 * Validate an opened corpus database against the manifest: PRAGMA
 * integrity_check must be exactly "ok", every expected authority must
 * be present with the exact version id and article count, and no extra
 * authorities may exist. Pure over `Db.query` so tests can drive it
 * with fake handles.
 */
export function validateCorpusDb(
  db: Db,
  manifest: CorpusManifest,
): void {
  // S-INI — v3 manifests validate through the vNext pipeline (schema v2
  // shape + both identity generations recomputed from SQLite alone).
  if ((manifest as { formatVersion?: unknown }).formatVersion === 3) {
    validateCorpusDbV3(db, manifest as unknown as CorpusManifestV3Shape);
    return;
  }
  assertManifestUsable(manifest);
  const integrityRows = db.query<{ integrity_check: unknown }>(
    "PRAGMA integrity_check",
  );
  const verdict = normalizeIntegrityResult(integrityRows[0]?.integrity_check);
  if (integrityRows.length !== 1 || verdict !== "ok") {
    throw new CorpusError(
      "corpus-integrity",
      `corpus failed SQLite integrity check (${verdict})`,
    );
  }

  const rows = db.query<NormaAggregate>(
    `SELECT n.id AS id, n.version_id AS version_id, n.name AS name,
            n.content_hash AS content_hash,
            COUNT(a.id) AS articles
       FROM norma n
       LEFT JOIN article a ON a.norma_id = n.id
      GROUP BY n.id, n.version_id, n.name
      ORDER BY n.id ASC`,
  );
  // Text-bearing counts without dragging the full corpus text through the
  // JavaScript heap: the SQL candidate prefilter can only EXCLUDE rows that
  // are provably substantive (any ASCII letter/digit passes
  // `hasSubstantiveText`), so the shared predicate still decides every row
  // exactly. bearing = total rows − candidates that fail the predicate.
  const nonBearingByAuthority = new Map<number, number>();
  for (const article of db.query<{ norma_id: number; body: unknown }>(
    `SELECT norma_id, body FROM article
      WHERE body IS NULL OR body NOT GLOB '*[A-Za-z0-9]*'
      ORDER BY norma_id ASC, id ASC`,
  )) {
    if (hasSubstantiveText(article.body)) continue;
    nonBearingByAuthority.set(
      article.norma_id,
      (nonBearingByAuthority.get(article.norma_id) ?? 0) + 1,
    );
  }
  const actual = new Map(rows.map((row) => [row.id, row]));
  const problems: string[] = [];
  const identityProblems: string[] = [];
  for (const want of manifest.normas) {
    const got = actual.get(want.docId);
    if (!got) {
      problems.push(`${want.slug}: missing authority ${want.docId}`);
      continue;
    }
    if (got.version_id !== want.versionId) {
      problems.push(
        `${want.slug}: version ${got.version_id} != expected ${want.versionId}`,
      );
    }
    if (got.name !== want.name) {
      problems.push(`${want.slug}: name does not match manifest`);
    }
    // Release count = TEXT-BEARING rows. Require BOTH the total row count and
    // the nonblank-body count to equal it (review fix #7): an extra blank
    // row, or a total that only matches because blank rows were dropped, both
    // fail here instead of silently shipping a hollow article.
    if (got.articles !== want.articleCount) {
      problems.push(
        `${want.slug}: ${got.articles} rows != expected ${want.articleCount}`,
      );
    }
    const bearing = got.articles - (nonBearingByAuthority.get(want.docId) ?? 0);
    if (bearing !== want.articleCount) {
      problems.push(
        `${want.slug}: ${bearing} text-bearing rows != expected ${want.articleCount}`,
      );
    }
    const computedArticleHash = articleContentHashFromDb(db, want.docId);
    const computedIdentity = contentIdentityFromDb(db, want.docId);
    if (
      got.content_hash !== computedArticleHash ||
      computedIdentity !== want.contentIdentity
    ) {
      identityProblems.push(
        `${want.slug}: content identity does not match opened DB`,
      );
    }
  }
  for (const row of rows) {
    if (!manifest.normas.some((entry) => entry.docId === row.id)) {
      problems.push(`unexpected authority ${row.id} in corpus`);
    }
  }
  if (problems.length > 0) {
    throw new CorpusError(
      "corpus-authority-counts",
      `corpus does not match the release manifest: ${problems.join("; ")}`,
    );
  }
  if (identityProblems.length > 0) {
    throw new CorpusError(
      "corpus-content-identity",
      `corpus content identity mismatch: ${identityProblems.join("; ")}`,
    );
  }
}

// ── S-INI: corpus vNext — adoptedContentIdentityV2 + manifest v3 ────

function hasTableNamed(db: Db, table: string): boolean {
  return tableExists(db, table);
}

function hasColumnNamed(db: Db, table: string, column: string): boolean {
  return hasColumn(db, table, column);
}

/**
 * The FULL SQLite-recomputable adopted identity at the v2 stream: the
 * exact v1 field stream (norma metadata incl. the historical
 * content_hash, hierarchy, article number/ordinal/body/ficha/order,
 * transitories) PLUS the vNext additions — per-unit source-unit
 * coordinates, front matter with absent-vs-empty semantics, and the
 * persisted typed gaps. Domain-separated from v1
 * (`corpus-authority-v2`), so the two can never collide, and the
 * historical `norma.content_hash` (legacy article-number/body hash)
 * is preserved unchanged as a v2 STREAM INPUT, never redefined.
 */
export function adoptedContentIdentityV2FromDb(db: Db, docId: number): string {
  // Reuse the exact v1 value stream, then append the v2 extras.
  const values = identityValuesFromDb(db, docId);

  const frontMatter = hasTableNamed(db, "norma_front_matter")
    ? db.query<{ present: number; body: string }>(
        `SELECT present, body FROM norma_front_matter WHERE norma_id = ?`,
        docId,
      )[0]
    : undefined;
  if (frontMatter === undefined) {
    values.push("fm", "absent");
  } else {
    values.push(
      "fm",
      Number(frontMatter.present) === 1 ? "present" : "empty",
      String(frontMatter.body),
    );
  }

  if (hasColumnNamed(db, "article", "source_unit_id")) {
    const rows = db.query<{ number: string; source_unit_id: number | null }>(
      `SELECT number, source_unit_id FROM article
        WHERE norma_id = ? ORDER BY doc_order ASC`,
      docId,
    );
    values.push("acoords", rows.length);
    for (const r of rows) {
      values.push(
        "ac",
        String(r.number),
        r.source_unit_id === null ? null : assertIdentityInteger(r.source_unit_id, "article.source_unit_id", 1),
      );
    }
  } else {
    values.push("acoords", 0);
  }
  if (hasColumnNamed(db, "transitory_provision", "source_unit_id")) {
    const rows = db.query<{
      number: string;
      attaches_to: string;
      source_unit_id: number | null;
    }>(
      `SELECT number, attaches_to, source_unit_id FROM transitory_provision
        WHERE norma_id = ? ORDER BY doc_order ASC`,
      docId,
    );
    values.push("tcoords", rows.length);
    for (const r of rows) {
      values.push(
        "tc",
        String(r.number),
        String(r.attaches_to),
        r.source_unit_id === null ? null : assertIdentityInteger(r.source_unit_id, "transitory.source_unit_id", 1),
      );
    }
  } else {
    values.push("tcoords", 0);
  }
  if (hasTableNamed(db, "source_gap")) {
    const rows = db.query<{
      source_unit_id: number;
      reason: string;
      caption: string | null;
      doc_order: number;
    }>(
      `SELECT source_unit_id, reason, caption, doc_order FROM source_gap
        WHERE norma_id = ? ORDER BY doc_order ASC, source_unit_id ASC`,
      docId,
    );
    values.push("gaps", rows.length);
    for (const g of rows) {
      values.push(
        "g",
        assertIdentityInteger(g.source_unit_id, "gap.source_unit_id", 1),
        String(g.reason),
        g.caption === null ? "" : String(g.caption),
        assertIdentityInteger(g.doc_order, "gap.doc_order"),
      );
    }
  } else {
    values.push("gaps", 0);
  }
  return computeAdoptedIdentityV2(values);
}

/**
 * Schema-aware adopted identity: corpora that satisfy the vNext shape
 * (source_unit_id columns + gap/front-matter tables) hash with
 * `corpus-authority-v2`; legacy v1-shape corpora keep hashing with the
 * exact historical v1 stream. Adoption, equal-version comparison, pin
 * provenance, and drift all go through THIS function, so each side is
 * compared at its own generation without silent widening.
 */
export function adoptedCorpusIdentityFromDb(db: Db, docId: number): string {
  return corpusSchemaVersionOf(db) === 2
    ? adoptedContentIdentityV2FromDb(db, docId)
    : contentIdentityFromDb(db, docId);
}

/** 1 when the DB has the legacy shape, 2 when the full vNext shape. */
export function corpusSchemaVersionOf(db: Db): 1 | 2 {
  if (
    hasColumnNamed(db, "article", "source_unit_id") &&
    hasColumnNamed(db, "transitory_provision", "source_unit_id") &&
    hasTableNamed(db, "source_gap") &&
    hasTableNamed(db, "norma_front_matter")
  ) {
    return 2;
  }
  return 1;
}

/**
 * v2 evidence identity over the release evidence inputs (reviewed
 * catalog digest, per-authority complete handler ledger, capture
 * sidecar digests, manifest agreement facts). Release validation and
 * the MCP startup / byte lock lane ONLY — never compared to a pin.
 */
export function computeReleaseEvidenceIdentity(
  values: Iterable<CorpusIdentityValue>,
): string {
  return computeReleaseEvidenceIdentityV2(values);
}

/** Per-authority persisted facts used by manifest v3 totals. */
export interface CorpusAuthorityMeasurements {
  slug: string;
  docId: number;
  versionId: number;
  name: string;
  articleCount: number;
  transitoryCount: number;
  gapCount: number;
  frontMatter: "present" | "absent";
  sourceUnitCoordinates: number;
  contentHash: string;
  contentIdentityV1: string;
  adoptedContentIdentityV2: string;
}

export function measureAuthorityForManifestV3(
  db: Db,
  slug: string,
  docId: number,
): CorpusAuthorityMeasurements {
  const norma = db.query<{ version_id: number; name: string; content_hash: unknown }>(
    `SELECT version_id, name, content_hash FROM norma WHERE id = ?`,
    docId,
  )[0];
  if (!norma) {
    throw new CorpusError("corpus-content-identity", `authority ${docId} missing`);
  }
  const articleCount = Number(
    db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM article WHERE norma_id = ?`,
      docId,
    )[0]?.n ?? 0,
  );
  const transitoryCount = hasTableNamed(db, "transitory_provision")
    ? Number(
        db.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM transitory_provision WHERE norma_id = ?`,
          docId,
        )[0]?.n ?? 0,
      )
    : 0;
  const gapCount = hasTableNamed(db, "source_gap")
    ? Number(
        db.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM source_gap WHERE norma_id = ?`,
          docId,
        )[0]?.n ?? 0,
      )
    : 0;
  const coordinateRows = hasColumnNamed(db, "article", "source_unit_id")
    ? db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM article
          WHERE norma_id = ? AND source_unit_id IS NOT NULL`,
        docId,
      )[0]?.n ?? 0
    : 0;
  const transitoryCoordinates = hasColumnNamed(db, "transitory_provision", "source_unit_id")
    ? db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transitory_provision
          WHERE norma_id = ? AND source_unit_id IS NOT NULL`,
        docId,
      )[0]?.n ?? 0
    : 0;
  const fm = hasTableNamed(db, "norma_front_matter")
    ? db.query<{ present: number }>(
        `SELECT present FROM norma_front_matter WHERE norma_id = ?`,
        docId,
      )[0]
    : undefined;
  return {
    slug,
    docId,
    versionId: Number(norma.version_id),
    name: String(norma.name),
    articleCount,
    transitoryCount,
    gapCount,
    frontMatter: fm !== undefined ? "present" : "absent",
    sourceUnitCoordinates: Number(coordinateRows) + Number(transitoryCoordinates),
    contentHash: String(norma.content_hash),
    contentIdentityV1: contentIdentityFromDb(db, docId),
    adoptedContentIdentityV2: adoptedContentIdentityV2FromDb(db, docId),
  };
}

/** Ledger-derived evidence values for manifest v3 (plan §6.1: the
 *  complete reconciliation ledger participates in the evidence). */
export interface ReleaseEvidenceInputs {
  readonly catalogDigest: string;
  readonly fixtureSetDigest: string;
  readonly sidecarDigests: ReadonlyMap<string, string>;
  readonly ledgers: ReadonlyMap<string, readonly { sourceUnitId: number; kind: string; reason?: string }[]>;
  readonly measurements: readonly CorpusAuthorityMeasurements[];
}

export function buildReleaseEvidenceIdentityV3(
  inputs: ReleaseEvidenceInputs,
): string {
  const values: CorpusIdentityValue[] = [
    "catalog",
    inputs.catalogDigest,
    "fixtures",
    inputs.fixtureSetDigest,
  ];
  for (const [slug, digest] of [...inputs.sidecarDigests.entries()].sort()) {
    values.push("sidecar", slug, digest);
  }
  for (const slug of [...inputs.measurements.map((m) => m.slug)].sort()) {
    const ledger = inputs.ledgers.get(slug) ?? [];
    values.push("ledger", slug, ledger.length);
    for (const entry of ledger) {
      values.push("e", entry.sourceUnitId, entry.kind, entry.reason ?? null);
    }
  }
  for (const m of inputs.measurements) {
    values.push(
      "measure",
      m.slug,
      m.articleCount,
      m.transitoryCount,
      m.gapCount,
      m.frontMatter,
      m.sourceUnitCoordinates,
      m.adoptedContentIdentityV2,
    );
  }
  return computeReleaseEvidenceIdentity(values);
}

/** Deterministic single release id shared by manifest, lock, and MCP
 *  distribution metadata: the release evidence identity IS the
 *  generation id (content-derived, never a timestamp). */
export function releaseGenerationIdFromEvidence(evidence: string): string {
  return evidence;
}

export interface CorpusManifestV3Shape {
  formatVersion: 3;
  schemaVersion: 2;
  fixtureSet: string;
  builtAt: string;
  releaseGenerationId: string;
  identityAlgorithms: {
    adopted: typeof CORPUS_ADOPTED_IDENTITY_ALGORITHM_V2;
    releaseEvidence: typeof CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2;
  };
  totals: {
    authorities: number;
    articles: number;
    transitories: number;
    gaps: number;
    frontMatterPresent: number;
    frontMatterAbsent: number;
    sourceUnitCoordinates: number;
  };
  normas: readonly ({
    slug: string;
    docId: number;
    versionId: number;
    name: string;
    articleCount: number;
    transitoryCount: number;
    gapCount: number;
    frontMatter: "present" | "absent";
    sourceUnitCoordinates: number;
    contentHash: string;
    contentIdentity: string;
    adoptedContentIdentity: string;
  })[];
  releaseEvidenceIdentity: {
    algorithm: typeof CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2;
    value: string;
  };
}

export function createCorpusManifestV3(
  db: Db,
  evidence: Omit<ReleaseEvidenceInputs, "measurements">,
  builtAt: string = new Date(0).toISOString(),
  profile: ReadonlyProfileSet = selectCandidateGenerationProfile(),
): CorpusManifestV3Shape {
  // Snapshot the caller-provided profile inside the fail-closed
  // boundary. After this point, only the trusted snapshot is read —
  // the caller-provided wrapper, normas array, and rows are NEVER
  // reread. A frozen stateful proxy that throws on its next `get`
  // cannot escape as a native error here.
  const trustedProfile = snapshotV3Profile(profile);
  const measurements = trustedProfile.normas.map((entry) =>
    measureAuthorityForManifestV3(db, entry.slug, entry.docId),
  );
  const releaseEvidence = buildReleaseEvidenceIdentityV3({
    ...evidence,
    measurements,
  });
  const totals = {
    authorities: measurements.length,
    articles: measurements.reduce((n, m) => n + m.articleCount, 0),
    transitories: measurements.reduce((n, m) => n + m.transitoryCount, 0),
    gaps: measurements.reduce((n, m) => n + m.gapCount, 0),
    frontMatterPresent: measurements.filter((m) => m.frontMatter === "present").length,
    frontMatterAbsent: measurements.filter((m) => m.frontMatter === "absent").length,
    sourceUnitCoordinates: measurements.reduce((n, m) => n + m.sourceUnitCoordinates, 0),
  };
  return {
    formatVersion: 3,
    schemaVersion: 2,
    fixtureSet: CORPUS_FIXTURE_SET,
    builtAt,
    releaseGenerationId: releaseGenerationIdFromEvidence(releaseEvidence),
    identityAlgorithms: {
      adopted: CORPUS_ADOPTED_IDENTITY_ALGORITHM_V2,
      releaseEvidence: CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2,
    },
    totals,
    normas: measurements.map((m) => ({
      slug: m.slug,
      docId: m.docId,
      versionId: m.versionId,
      name: m.name,
      articleCount: m.articleCount,
      transitoryCount: m.transitoryCount,
      gapCount: m.gapCount,
      frontMatter: m.frontMatter,
      sourceUnitCoordinates: m.sourceUnitCoordinates,
      contentHash: m.contentHash,
      contentIdentity: m.contentIdentityV1,
      adoptedContentIdentity: m.adoptedContentIdentityV2,
    })),
    releaseEvidenceIdentity: {
      algorithm: CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2,
      value: releaseEvidence,
    },
  };
}

const HEX64_RE = /^[0-9a-f]{64}$/;

export function assertManifestV3Usable(
  manifest: unknown,
  profile: ReadonlyProfileSet = selectCandidateGenerationProfile(),
): CorpusManifestV3Shape {
  // Snapshot the caller-provided profile inside the fail-closed
  // boundary. After this point, only the trusted snapshot is read —
  // the caller-provided wrapper, normas array, and rows are NEVER
  // reread. A frozen stateful proxy that throws on its next `get`
  // cannot escape as a native error here.
  const trustedProfile = snapshotV3Profile(profile);
  if (manifest === null || typeof manifest !== "object") {
    throw new CorpusError("manifest-invalid", "corpus manifest v3 is not an object");
  }
  const m = manifest as Partial<CorpusManifestV3Shape> & Record<string, unknown>;
  if (!hasExactKeys(m, [
    "formatVersion",
    "schemaVersion",
    "fixtureSet",
    "builtAt",
    "releaseGenerationId",
    "identityAlgorithms",
    "totals",
    "normas",
    "releaseEvidenceIdentity",
  ])) {
    throw new CorpusError("manifest-invalid", "corpus manifest v3 root keys drift");
  }
  if (m.formatVersion !== 3 || m.schemaVersion !== 2) {
    throw new CorpusError("manifest-version", "corpus manifest v3 version fields drift");
  }
  if (m.fixtureSet !== CORPUS_FIXTURE_SET) {
    throw new CorpusError("manifest-version", "corpus manifest v3 fixtureSet drift");
  }
  if (typeof m.builtAt !== "string" || !/\d{4}-\d{2}-\d{2}T/.test(m.builtAt)) {
    throw new CorpusError("manifest-invalid", "corpus manifest v3 builtAt invalid");
  }
  if (typeof m.releaseGenerationId !== "string" || !CORPUS_CONTENT_IDENTITY_RE.test(m.releaseGenerationId)) {
    throw new CorpusError("manifest-invalid", "corpus manifest v3 releaseGenerationId invalid");
  }
  if (
    m.identityAlgorithms === null || typeof m.identityAlgorithms !== "object" ||
    !hasExactKeys(m.identityAlgorithms, ["adopted", "releaseEvidence"]) ||
    (m.identityAlgorithms as Record<string, unknown>).adopted !== CORPUS_ADOPTED_IDENTITY_ALGORITHM_V2 ||
    (m.identityAlgorithms as Record<string, unknown>).releaseEvidence !== CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2
  ) {
    throw new CorpusError("manifest-invalid", "corpus manifest v3 identity algorithms drift");
  }
  if (
    m.releaseEvidenceIdentity === null || typeof m.releaseEvidenceIdentity !== "object" ||
    !hasExactKeys(m.releaseEvidenceIdentity, ["algorithm", "value"]) ||
    (m.releaseEvidenceIdentity as Record<string, unknown>).algorithm !== CORPUS_RELEASE_EVIDENCE_IDENTITY_ALGORITHM_V2 ||
    typeof (m.releaseEvidenceIdentity as Record<string, unknown>).value !== "string" ||
    !(CORPUS_CONTENT_IDENTITY_RE as RegExp).test((m.releaseEvidenceIdentity as { value: string }).value)
  ) {
    throw new CorpusError("manifest-invalid", "corpus manifest v3 release evidence identity drift");
  }
  if ((m.releaseEvidenceIdentity as { value: string }).value !== m.releaseGenerationId) {
    throw new CorpusError("manifest-invalid", "corpus manifest v3 generation/evidence mismatch");
  }
  const totals = m.totals as Record<string, unknown> | null;
  if (totals === null || typeof totals !== "object" || !hasExactKeys(totals, [
    "authorities", "articles", "transitories", "gaps",
    "frontMatterPresent", "frontMatterAbsent", "sourceUnitCoordinates",
  ])) {
    throw new CorpusError("manifest-invalid", "corpus manifest v3 totals keys drift");
  }
  if (!Array.isArray(m.normas) || m.normas.length !== trustedProfile.normas.length) {
    throw new CorpusError("corpus-authority-counts", "corpus manifest v3 authority list drift");
  }
  let articles = 0;
  let transitories = 0;
  let gaps = 0;
  let fmPresent = 0;
  let coords = 0;
  m.normas.forEach((entry, index) => {
    const want = trustedProfile.normas[index]!;
    const e = entry as Record<string, unknown>;
    if (
      !hasExactKeys(e, [
        "slug", "docId", "versionId", "name", "articleCount", "transitoryCount",
        "gapCount", "frontMatter", "sourceUnitCoordinates", "contentHash",
        "contentIdentity", "adoptedContentIdentity",
      ]) ||
      e.slug !== want.slug ||
      e.docId !== want.docId ||
      e.versionId !== want.versionId ||
      e.name !== want.name ||
      e.articleCount !== want.articleCount ||
      !Number.isSafeInteger(e.transitoryCount) || (e.transitoryCount as number) < 0 ||
      !Number.isSafeInteger(e.gapCount) || (e.gapCount as number) < 0 ||
      (e.frontMatter !== "present" && e.frontMatter !== "absent") ||
      !Number.isSafeInteger(e.sourceUnitCoordinates) || (e.sourceUnitCoordinates as number) < 0 ||
      typeof e.contentHash !== "string" || !CORPUS_CONTENT_IDENTITY_RE.test(e.contentHash) ||
      typeof e.contentIdentity !== "string" || !CORPUS_CONTENT_IDENTITY_RE.test(e.contentIdentity) ||
      typeof e.adoptedContentIdentity !== "string" || !CORPUS_CONTENT_IDENTITY_RE.test(e.adoptedContentIdentity)
    ) {
      throw new CorpusError("manifest-invalid", `corpus manifest v3 entry ${index} malformed`);
    }
    articles += e.articleCount as number;
    transitories += e.transitoryCount as number;
    gaps += e.gapCount as number;
    if (e.frontMatter === "present") fmPresent += 1;
    coords += e.sourceUnitCoordinates as number;
  });
  const expectTotal = (key: string, got: unknown, wantVal: number) => {
    if (got !== wantVal) {
      throw new CorpusError("manifest-invalid", `corpus manifest v3 totals.${key} drift`);
    }
  };
  expectTotal("authorities", totals.authorities, m.normas.length);
  expectTotal("articles", totals.articles, articles);
  expectTotal("transitories", totals.transitories, transitories);
  expectTotal("gaps", totals.gaps, gaps);
  expectTotal("frontMatterPresent", totals.frontMatterPresent, fmPresent);
  expectTotal("frontMatterAbsent", totals.frontMatterAbsent, m.normas.length - fmPresent);
  expectTotal("sourceUnitCoordinates", totals.sourceUnitCoordinates, coords);
  return m as unknown as CorpusManifestV3Shape;
}

/**
 * Validate an opened vNext corpus against a manifest v3: integrity,
 * exact per-authority counts, BOTH identity generations recomputed
 * from SQLite alone (historical content_hash + v1 identity preserved
 * exactly, adopted v2 identity matching), persisted gap/front matter
 * agreement, FULL coordinate coverage per authority, and the
 * all-null-coverage rejection.
 */
export function validateCorpusDbV3(
  db: Db,
  manifest: CorpusManifestV3Shape,
  profile: ReadonlyProfileSet = selectCandidateGenerationProfile(),
): void {
  // Snapshot the caller-provided profile inside the fail-closed
  // boundary. After this point, only the trusted snapshot is read —
  // the caller-provided wrapper, normas array, and rows are NEVER
  // reread. The trusted snapshot (NOT the original profile) is passed
  // into `assertManifestV3Usable` so no caller-owned object ever
  // reaches another validator/helper.
  const trustedProfile = snapshotV3Profile(profile);
  assertManifestV3Usable(manifest, trustedProfile);
  const integrityRows = db.query<{ integrity_check: unknown }>("PRAGMA integrity_check");
  const verdict = normalizeIntegrityResult(integrityRows[0]?.integrity_check);
  if (integrityRows.length !== 1 || verdict !== "ok") {
    throw new CorpusError("corpus-integrity", `corpus failed SQLite integrity check (${verdict})`);
  }
  if (corpusSchemaVersionOf(db) !== 2) {
    throw new CorpusError(
      "manifest-version",
      "manifest v3 requires a schema-v2 corpus (source_unit_id, source_gap, norma_front_matter)",
    );
  }
  for (const entry of manifest.normas) {
    // S-INI semantic checks — independent of the self-consistent
    // regenerated manifest measurements below. These reject a corpus
    // whose rows are internally wrong even when a freshly recomputed
    // manifest would bless them.
    //
    // 1) The historical `norma.content_hash` must recompute from the
    //    ordered article-number/body legacy hash.
    const storedHash = db.query<{ content_hash: unknown }>(
      `SELECT content_hash FROM norma WHERE id = ?`,
      entry.docId,
    )[0]?.content_hash;
    if (storedHash !== articleContentHashFromDb(db, entry.docId)) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${entry.slug} has a wrong historical content_hash`,
      );
    }
    // 2) Every text-bearing body must be substantive: article bodies,
    //    standalone transitory bodies, and present front matter. A
    //    reviewed absent front matter (no row) or present=0 empty row
    //    stays valid.
    const blankArticles = db
      .query<{ body: unknown }>(
        `SELECT body FROM article WHERE norma_id = ?`,
        entry.docId,
      )
      .filter((row) => !hasSubstantiveText(row.body));
    if (blankArticles.length > 0) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${entry.slug} has a blank/non-substantive article body`,
      );
    }
    const blankTransitories = db
      .query<{ body: unknown }>(
        `SELECT body FROM transitory_provision WHERE norma_id = ?`,
        entry.docId,
      )
      .filter((row) => !hasSubstantiveText(row.body));
    if (blankTransitories.length > 0) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${entry.slug} has a blank/non-substantive transitory body`,
      );
    }
    const frontMatter = db.query<{ present: number; body: unknown }>(
      `SELECT present, body FROM norma_front_matter WHERE norma_id = ?`,
      entry.docId,
    )[0];
    if (
      frontMatter &&
      Number(frontMatter.present) === 1 &&
      !hasSubstantiveText(frontMatter.body)
    ) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${entry.slug} has non-substantive present front matter`,
      );
    }
    // 3) Every non-null article/transitory/gap source-unit id must be a
    //    positive safe integer (the table CHECKs already reject
    //    non-integer and <=0; this also rejects values above
    //    Number.MAX_SAFE_INTEGER that SQLite would otherwise store).
    const invalidSourceIds = (table: string): number =>
      Number(
        db.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table}
            WHERE norma_id = ? AND source_unit_id IS NOT NULL
              AND (typeof(source_unit_id) != 'integer'
                   OR source_unit_id <= 0
                   OR source_unit_id > ${Number.MAX_SAFE_INTEGER})`,
          entry.docId,
        )[0]?.n ?? 0,
      );
    if (
      invalidSourceIds("article") +
        invalidSourceIds("transitory_provision") +
        invalidSourceIds("source_gap") >
      0
    ) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${entry.slug} has a non-positive/non-safe source_unit_id`,
      );
    }
    // 4) The article/transitory/gap source-unit namespaces share ONE id
    //    namespace per authority/version; a cross-table collision fails.
    const sourceIds = new Set<number>();
    const takeSourceId = (kind: string, value: unknown): void => {
      if (value === null || value === undefined) return;
      const id = value as number;
      if (sourceIds.has(id)) {
        throw new CorpusError(
          "corpus-content-identity",
          `corpus authority ${entry.slug} has a cross-table source_unit_id collision (${id})`,
        );
      }
      sourceIds.add(id);
    };
    for (const row of db.query<{ source_unit_id: unknown }>(
      `SELECT source_unit_id FROM article
        WHERE norma_id = ? AND source_unit_id IS NOT NULL`,
      entry.docId,
    )) {
      takeSourceId("article", row.source_unit_id);
    }
    for (const row of db.query<{ source_unit_id: unknown }>(
      `SELECT source_unit_id FROM transitory_provision
        WHERE norma_id = ? AND source_unit_id IS NOT NULL`,
      entry.docId,
    )) {
      takeSourceId("transitory", row.source_unit_id);
    }
    for (const row of db.query<{ source_unit_id: unknown }>(
      `SELECT source_unit_id FROM source_gap WHERE norma_id = ?`,
      entry.docId,
    )) {
      takeSourceId("gap", row.source_unit_id);
    }

    const measurements = measureAuthorityForManifestV3(db, entry.slug, entry.docId);
    const drift =
      measurements.versionId !== entry.versionId ||
      measurements.name !== entry.name ||
      measurements.articleCount !== entry.articleCount ||
      measurements.transitoryCount !== entry.transitoryCount ||
      measurements.gapCount !== entry.gapCount ||
      measurements.frontMatter !== entry.frontMatter ||
      measurements.sourceUnitCoordinates !== entry.sourceUnitCoordinates ||
      measurements.contentHash !== entry.contentHash ||
      measurements.contentIdentityV1 !== entry.contentIdentity ||
      measurements.adoptedContentIdentityV2 !== entry.adoptedContentIdentity;
    if (drift) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${entry.slug} does not recompute the manifest v3 record`,
      );
    }
    // FULL coordinate coverage: every text-bearing article and every
    // standalone transitorio of a vNext authority must carry its
    // persisted source-unit id; an all-null or partial coverage corpus
    // fails even if bytes would otherwise match.
    const missing = db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM article
        WHERE norma_id = ? AND source_unit_id IS NULL`,
      entry.docId,
    )[0]?.n ?? 0;
    if (Number(missing) > 0) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${entry.slug} has articles without source coordinates`,
      );
    }
    const missingT = db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM transitory_provision
        WHERE norma_id = ? AND source_unit_id IS NULL`,
      entry.docId,
    )[0]?.n ?? 0;
    if (Number(missingT) > 0) {
      throw new CorpusError(
        "corpus-content-identity",
        `corpus authority ${entry.slug} has transitories without source coordinates`,
      );
    }
  }
  const extra = db.query<{ id: number }>(
    `SELECT id FROM norma WHERE id NOT IN (${
      manifest.normas.length > 0
        ? manifest.normas.map((n) => n.docId).join(",")
        : "NULL"
    })`,
  );
  if (extra.length > 0) {
    throw new CorpusError("corpus-authority-counts", "unexpected authority rows in vNext corpus");
  }
}
