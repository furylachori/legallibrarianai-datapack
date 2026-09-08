/**
 * Fail-closed corpus artifact build (H-01). Produces
 * `app/public/corpus/corpus.sqlite` plus the release manifest
 * `app/public/corpus/corpus-manifest.json` and the canonical source notice
 * `app/public/corpus/NOTICE-SINALEVI.txt` (a deterministic copy of the
 * tracked root `LEGAL_CORPUS_NOTICE.txt`) from the approved fixture
 * set, and verifies the result end-to-end:
 *
 *  - every required source fixture must exist — a missing fixture is an
 *    actionable error naming each file and its expected directory; a
 *    partial artifact is never produced;
 *  - per-authority source-summary expectations (articles / transitories /
 *    known-gaps / reviewed-exclusions / ledger) are pinned per
 *    authority and asserted against the measured extraction; the
 *    persisted `sourceGaps` rows and the ledger's `known-gap` entries
 *    must agree with EQUAL CARDINALITY and EXACT ordered
 *    (sourceUnitId, reason, normalized caption, docOrder) identity —
 *    missing, extra, duplicated, reordered, or field-drifted rows all
 *    reject; every reviewed-exclusion id is absent from `sourceGaps`;
 *    and the full ledger id namespace is unique per authority
 *    (`assertSourceGapLedgerIdentity` in
 *    `src/sinalevi/corpus-builder-gate.ts`);
 *  - per-authority text-bearing article counts are asserted against the
 *    release contract in src/corpus/manifest.ts while ingesting, and no
 *    extracted article body may be blank (a blank body is a hollow row,
 *    never a text-bearing one);
 *  - the exported SQLite bytes are reloaded and validated with
 *    PRAGMA integrity_check + full manifest verification (total rows AND
 *    nonblank-body rows equal to each authority's release count) before
 *    being written to the packaged location.
 *
 * Import safety: `buildCorpusArtifact` is exported and only runs at module top
 * level behind an `isDirectEntry()` guard, so importing this module performs no
 * build, fixture read, write, log, exit, or DOM mutation. The build writes into
 * explicit roots (`CorpusArtifactRoots`); with no argument they default to the
 * repository paths derived from this module's URL. That roots parameter is a
 * programmatic/test seam (same category as the replay CLI's `runCli(argv, root)`);
 * at the process level the ONLY way to set roots is the exact allowlisted CLI
 * flags `--outDir <dir>` and `--fixturesDir <dir>` (both `--flag value` and
 * `--flag=value` spellings). No other flag exists — an unknown `--...` token is
 * a usage error (one stderr `REFUSAL: ERR_UNKNOWN_FLAG: ...` line, exit 2).
 * Roots are NEVER read from environment variables. `noticeSource` stays
 * module-derived and is not settable from the CLI.
 *
 * Bare-invocation defaults (resolved absolute paths; "inside repo" means equal
 * to the module-derived repo root or under it; "pinned fixtures" means
 * `<repoRoot>/fixtures/full`):
 *  - cwd inside the repo → fixtures `<repo>/fixtures/full`, outDir
 *    `<repo>/app/public/corpus` (production behavior, unchanged);
 *  - cwd outside the repo → fixtures `<cwd>/fixtures`, outDir `<cwd>/corpus-out`
 *    (standalone defaults; the data-lane slice B0 may supersede these).
 *
 * Fail-closed refusals (one stderr `REFUSAL: <KEY>: <detail>` line, exit 2, no
 * build started; the outDir check runs FIRST):
 *  - an explicit `--outDir` resolving inside the repo (any fixtures, any cwd)
 *    → `ERR_OUTDIR_IN_APP`;
 *  - otherwise, a resolved outDir inside the repo with an unpinned fixturesDir
 *    (the app-build path with unpinned sources) → `ERR_FIXTURES_NOT_PINNED`.
 * Build failures keep the existing `FATAL:` + exit 1 path.
 *
 * The argv parser (`parseBuildArgv`) is pure — no `process` access — so the
 * decision table above is unit-testable without running a build.
 *
 * Run via: npx vite-node scripts/build-corpus-artifact.ts [--outDir <dir>] [--fixturesDir <dir>]
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DOMParser } from "linkedom";
import { configureSqlJsOnce } from "../src/db/database-init.node.js";
import {
  assertCorpusExtractionPublishable,
  assertSourceGapLedgerIdentity,
} from "../src/sinalevi/corpus-builder-gate.js";
import { PENAL_REVIEWED_EXCLUSION_SOURCE_UNIT_IDS } from "../src/cite/reviewed-penal-source-classifications.js";
import {
  captureContextFor,
  REVIEWED_CORPUS_SOURCES,
  rulesFor,
  type ReviewedCorpusSourceEntry,
} from "../src/corpus/reviewed-corpus-sources.js";
import { extract } from "../src/sinalevi/extractor.js";

import type { ExtractedNorma } from "../src/sinalevi/types.js";
import { addNorma, initSchema } from "../src/db/build.js";
import { createDatabase, exportDatabase, loadDatabase } from "../src/db/database.js";
import {
  CORPUS_DB_FILE,
  CORPUS_MANIFEST_FILE,
  CORPUS_NOTICE_FILE,
  createCorpusManifestV3,
  hasSubstantiveText,
  validateCorpusDbV3,
  type CorpusManifestV3Shape,
  type ReleaseEvidenceInputs,
} from "../src/corpus/manifest.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The three roots the build reads from and writes into. Every path the builder
 * touches is derived from these rather than closed over at module scope, so a
 * caller (a focused test, or the next slice's isolated determinism proof) can
 * build into a scratch tree. Output FILENAMES are never part of this seam —
 * they always come from `CORPUS_DB_FILE` / `CORPUS_MANIFEST_FILE` /
 * `CORPUS_NOTICE_FILE`. At the process level exactly two CLI flags redirect a
 * root (`--outDir`, `--fixturesDir`; see the module header); `noticeSource`
 * has no flag and is always module-derived. The parameter itself remains the
 * programmatic/test seam, and a bare direct-entry invocation resolves to the
 * repository defaults below.
 */
export interface CorpusArtifactRoots {
  /** Directory holding the reviewed `*_raw.json` fixtures. */
  readonly fixturesDir: string;
  /** Directory the DB, manifest, and copied notice are written into. */
  readonly outDir: string;
  /**
   * The canonical tracked source notice, copied byte-for-byte into the package
   * (review fix #8). The root file is the single source.
   */
  readonly noticeSource: string;
}

/** Repository defaults — the exact paths this builder wrote before the
 * roots seam existed, pinned so a future refactor cannot silently move them.
 * Exported so the CLI-flag tests can assert bare-invocation production
 * equivalence against these exact constants. */
export const DEFAULT_FIXTURES_DIR = resolve(ROOT, "fixtures", "full");
export const DEFAULT_OUT_DIR = resolve(ROOT, "app", "public", "corpus");
const DEFAULT_NOTICE_SOURCE = join(ROOT, "LEGAL_CORPUS_NOTICE.txt");

/** Observable result of one build: the resolved roots, the three artifact
 * paths, the exported DB byte length, and the verified manifest. */
export interface CorpusArtifactBuildResult {
  readonly roots: CorpusArtifactRoots;
  readonly dbPath: string;
  readonly manifestPath: string;
  readonly noticePath: string;
  readonly dbBytes: number;
  readonly manifest: CorpusManifestV3Shape;
}

/** Fill any omitted root with its repository default and freeze the result. */
export function resolveCorpusArtifactRoots(
  roots: Partial<CorpusArtifactRoots> = {},
): CorpusArtifactRoots {
  return Object.freeze({
    fixturesDir: roots.fixturesDir ?? DEFAULT_FIXTURES_DIR,
    outDir: roots.outDir ?? DEFAULT_OUT_DIR,
    noticeSource: roots.noticeSource ?? DEFAULT_NOTICE_SOURCE,
  });
}

// ---------------------------------------------------------------------------
// Standalone build CLI flags (fail-closed argv contract)
// ---------------------------------------------------------------------------

/** Refusal keys for the standalone build CLI. Every key maps to exit 2 via
 * `exitCodeForBuildRefusal`; build failures (not refusals) keep `FATAL:` + 1. */
export type BuildRefusalKey =
  | "ERR_OUTDIR_IN_APP"
  | "ERR_FIXTURES_NOT_PINNED"
  | "ERR_UNKNOWN_FLAG";

/** Result of `parseBuildArgv`: resolved roots on success, or the refusal key
 * plus a human-readable detail (rendered as `REFUSAL: <KEY>: <detail>`) when
 * the invocation must not build. */
export type ParseBuildArgvResult =
  | { readonly ok: true; readonly fixturesDir: string; readonly outDir: string }
  | {
      readonly ok: false;
      readonly refusalKey: BuildRefusalKey;
      readonly message: string;
    };

/** Process exit status for every CLI refusal (usage errors and fail-closed
 * refusals alike). */
export const BUILD_REFUSAL_EXIT_CODE = 2;

/** Total mapping from refusal key to process exit code. Every known key maps
 * to `BUILD_REFUSAL_EXIT_CODE`; the function exists so the direct-entry
 * boundary never hardcodes the status and tests can assert the mapping
 * without spawning processes. */
export function exitCodeForBuildRefusal(_key: BuildRefusalKey): number {
  return BUILD_REFUSAL_EXIT_CODE;
}

/** Render one refusal as the single stderr line the boundary prints:
 * `REFUSAL: <KEY>: <detail>`. */
export function formatBuildRefusal(refusal: {
  readonly refusalKey: BuildRefusalKey;
  readonly message: string;
}): string {
  return `REFUSAL: ${refusal.refusalKey}: ${refusal.message}`;
}

/** True when the resolved absolute path equals the resolved repo root or
 * lies under it. The trailing-`sep` comparison keeps `/repo2` outside
 * `/repo`. */
function isPathInsideRepo(resolvedPath: string, resolvedRepoRoot: string): boolean {
  return (
    resolvedPath === resolvedRepoRoot ||
    resolvedPath.startsWith(resolvedRepoRoot + sep)
  );
}

/**
 * Pure parser for the standalone build CLI (no `process` access: fully
 * unit-testable).
 *
 * @param argv the full process argv (`argv[0]` runtime, `argv[1]`
 * entry/launcher — flags are read from index 2 on, uniformly across the
 * `node <file>` and launcher-stripped `vite-node <file>` shapes).
 * @param cwd the process working directory (`process.cwd()` at the boundary).
 * @param repoRoot the module-derived repository root (`ROOT` at the boundary).
 *
 * Only `--outDir <dir>` and `--fixturesDir <dir>` (each also as
 * `--flag=<dir>`) are accepted; a repeated flag resolves last-wins. Anything
 * else starting with `-`, a positional argument, or a missing/empty value is
 * a usage refusal (`ERR_UNKNOWN_FLAG`). Relative values resolve against
 * `cwd`. Environment variables are never consulted. Success returns resolved
 * absolute `{ fixturesDir, outDir }` (`noticeSource` is intentionally absent:
 * it stays module-derived); the decision table in the module header applies.
 */
export function parseBuildArgv(
  argv: readonly string[],
  cwd: string,
  repoRoot: string,
): ParseBuildArgvResult {
  const repo = resolve(repoRoot);
  const base = resolve(cwd);
  const pinnedFixtures = resolve(repo, "fixtures", "full");
  const repoOutDir = resolve(repo, "app", "public", "corpus");
  const cwdInsideRepo = isPathInsideRepo(base, repo);

  let outDirArg: string | undefined;
  let fixturesArg: string | undefined;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    const eq = token.indexOf("=");
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    let value: string | undefined =
      eq >= 0 ? token.slice(eq + 1) : undefined;
    if (flag === "--outDir" || flag === "--fixturesDir") {
      if (value === undefined) {
        i += 1;
        value = args[i];
        if (value === undefined) {
          return {
            ok: false,
            refusalKey: "ERR_UNKNOWN_FLAG",
            message: `flag ${flag} requires a value (allowed: --outDir, --fixturesDir)`,
          };
        }
      }
      if (value === "" || value.startsWith("-")) {
        return {
          ok: false,
          refusalKey: "ERR_UNKNOWN_FLAG",
          message: `flag ${flag} requires a directory value, got ${JSON.stringify(value)} (allowed: --outDir, --fixturesDir)`,
        };
      }
      if (flag === "--outDir") outDirArg = value;
      else fixturesArg = value;
    } else if (flag.startsWith("-")) {
      return {
        ok: false,
        refusalKey: "ERR_UNKNOWN_FLAG",
        message: `unknown flag ${JSON.stringify(flag)} (allowed: --outDir, --fixturesDir)`,
      };
    } else {
      return {
        ok: false,
        refusalKey: "ERR_UNKNOWN_FLAG",
        message: `unexpected positional argument ${JSON.stringify(token)} (allowed: --outDir, --fixturesDir)`,
      };
    }
  }

  const fixturesDir =
    fixturesArg !== undefined
      ? resolve(base, fixturesArg)
      : cwdInsideRepo
        ? pinnedFixtures
        : resolve(base, "fixtures");
  const outDir =
    outDirArg !== undefined
      ? resolve(base, outDirArg)
      : cwdInsideRepo
        ? repoOutDir
        : resolve(base, "corpus-out");

  // R1 first: an explicit outDir inside the repo always refuses, whatever the
  // fixtures and cwd are.
  if (outDirArg !== undefined && isPathInsideRepo(outDir, repo)) {
    return {
      ok: false,
      refusalKey: "ERR_OUTDIR_IN_APP",
      message: `explicit --outDir ${outDir} is inside the app repo ${repo}; standalone builds must write outside the repo`,
    };
  }
  // R2: the app-build path (outDir inside the repo) with unpinned sources.
  if (isPathInsideRepo(outDir, repo) && fixturesDir !== pinnedFixtures) {
    return {
      ok: false,
      refusalKey: "ERR_FIXTURES_NOT_PINNED",
      message: `outDir ${outDir} is inside the app repo but fixturesDir ${fixturesDir} is not the pinned ${pinnedFixtures}`,
    };
  }
  return { ok: true, fixturesDir, outDir };
}

type MetaSidecar = {
  idFichaNorma: number;
  idVersionNorma: number;
  titulo: string;
  numero: string;
  fecha: string;
  tipo: number;
  sourceUrl: string;
};

/**
 * The reviewed 20-authority build source set now lives in
 * `src/corpus/reviewed-corpus-sources.ts` (single source of truth; §10.2
 * catalog-driven validation). The local alias keeps the iteration/
 * catalog-digest code below byte-for-byte meaningful: `REVIEWED_CORPUS_SOURCES`
 * carries the exact historical entry order, slugs, fixtures, template
 * families, metadata, expected article counts, source summaries, and
 * approved warning strings, and the ledger identity digest consumed by
 * `buildReleaseEvidenceIdentityV3` keys off that same positional order.
 */
const MANIFEST: readonly ReviewedCorpusSourceEntry[] = REVIEWED_CORPUS_SOURCES;

/** Digest of the compiled reviewed expectation list (handles, counts,
 *  template family, order). Stable across rebuilds of the same inputs. */
function catalogDigestOfManifestList(): string {
  const hash = createHash("sha256");
  for (const entry of MANIFEST) {
    hash
      .update(entry.slug)
      .update("\u0000")
      .update(String(entry.meta.idFichaNorma))
      .update("\u0000")
      .update(String(entry.meta.idVersionNorma))
      .update("\u0000")
      .update(String(entry.expectedArticles))
      .update("\u0000")
      .update(entry.rules ?? "word")
      .update("\u0001");
  }
  return hash.digest("hex");
}

function parseJsonWithSlugContext<T>(
  raw: string,
  slug: string,
  fileName: string,
  filePath: string,
  kind: "fixture" | "sidecar",
): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `${slug}: malformed ${kind} JSON in ${fileName} at ${filePath}: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function readFixtureHtml(fixturesDir: string, entry: ReviewedCorpusSourceEntry): string {
  const fixturePath = resolve(fixturesDir, entry.fixture);
  const content = parseJsonWithSlugContext<{
    html?: unknown;
    TextoNorma?: unknown;
  }>(readFileSync(fixturePath, "utf8"), entry.slug, entry.fixture, fixturePath, "fixture");
  if (content.html !== undefined) return String(content.html);
  if (content.TextoNorma) return String(content.TextoNorma);
  throw new Error(`fixture ${entry.fixture} has no recognizable HTML payload`);
}

export async function buildCorpusArtifact(
  roots?: Partial<CorpusArtifactRoots>,
): Promise<CorpusArtifactBuildResult> {
  const resolved = resolveCorpusArtifactRoots(roots);
  const { fixturesDir, outDir, noticeSource } = resolved;
  const out = join(outDir, CORPUS_DB_FILE);
  const outManifest = join(outDir, CORPUS_MANIFEST_FILE);
  const outNotice = join(outDir, CORPUS_NOTICE_FILE);

  const missing: string[] = [];
  for (const entry of MANIFEST) {
    if (!existsSync(resolve(fixturesDir, entry.fixture))) {
      missing.push(join(fixturesDir, entry.fixture));
    }
  }

  if (missing.length > 0) {
    // Fail-closed: a missing fixture is an actionable error naming each file
    // and its expected directory. Throw (never exit) so a caller can handle
    // the failure; the direct-entry boundary prints one `FATAL:` line. No
    // partial artifact is produced. (D-05) The product no longer fetches from
    // SINALEVI at runtime — fixtures are regenerated offline from the
    // committed reviewed-capture packs, so the diagnostic points operators at
    // the replay command instead of the acquisition script. (H-7) The
    // guidance is root-aware: `fixturesDir` is an independently overridable
    // seam, and replay publishes ONLY to the default tree, so a custom
    // `fixturesDir` must be populated directly — replay cannot fix it.
    const isDefaultFixturesDir =
      resolve(fixturesDir) === DEFAULT_FIXTURES_DIR;
    throw new Error(
      [
        `corpus build is fail-closed — ${missing.length} required source fixture(s) are missing.`,
        `Each captured SINALEVI fixture must exist under ${fixturesDir}/`,
        ...(isDefaultFixturesDir
          ? [
              "(gitignored by design; regenerate offline from the committed reviewed-capture packs with):",
              "  npm run replay:reviewed-sources",
            ]
          : [
              `(custom fixturesDir; \`npm run replay:reviewed-sources\` regenerates ONLY the default ${DEFAULT_FIXTURES_DIR}/ tree — populate ${fixturesDir}/ directly, or re-run with default roots.)`,
            ]),
        ...missing.map((path) => `  - ${path}`),
        "No partial corpus artifact was produced.",
      ].join("\n"),
    );
  }

  (globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;
  configureSqlJsOnce();

  const db = await createDatabase();
  initSchema(db);

  const extracted = new Map<string, ExtractedNorma>();
  for (const entry of MANIFEST) {
    const html = readFixtureHtml(fixturesDir, entry);

    // Optional sidecar metadata must agree with the compiled identity.
    const metaPath = resolve(
      fixturesDir,
      entry.fixture.replace("_raw.json", "_meta.json"),
    );
    if (existsSync(metaPath)) {
      const sidecar = parseJsonWithSlugContext<MetaSidecar>(
        readFileSync(metaPath, "utf8"),
        entry.slug,
        basename(metaPath),
        metaPath,
        "sidecar",
      );
      if (
        sidecar.idFichaNorma !== entry.meta.idFichaNorma ||
        sidecar.idVersionNorma !== entry.meta.idVersionNorma
      ) {
        throw new Error(
          `Sidecar mismatch for ${entry.slug}: expected ${entry.meta.idFichaNorma}/${entry.meta.idVersionNorma}, got ${sidecar.idFichaNorma}/${sidecar.idVersionNorma}`,
        );
      }
    }

    const rules = rulesFor(entry);
    const norma = extract(html, rules, captureContextFor(entry));
    // Fail-closed admission gate (warning/drop slice): the audited
    // allowlist is the ONLY source of approval for `norma.warnings` and
    // any `dropped` segment. Typed `sourceGaps` are deliberately outside
    // this gate (they are structured records consumed by the source
    // ledger). Call this BEFORE the ledger / count / blank-body checks
    // so a build whose extraction already drifted from the contract
    // cannot progress to ingest a partial artifact into the DB.
    assertCorpusExtractionPublishable(
      { slug: entry.slug, fixture: entry.fixture },
      norma,
      entry.approvedWarnings,
    );
    // S-INI — ledger gates: every emitted coordinate is a distinct
    // positive safe integer; the ledger covers exactly the emitted +
    // known-gap + reviewed-exclusion classification of every source
    // handler. Per-authority per-kind counts match the audited
    // `sourceSummary` expectation; the full ledger id namespace is
    // unique; every known-gap ledger entry matches the persisted
    // `sourceGaps` row by sourceUnitId + caption + docOrder; every
    // reviewed-exclusion id is absent from `sourceGaps`.
    const unitIds = new Set<number>();
    for (const article of norma.articles) {
      if (article.sourceUnitId === undefined) {
        throw new Error(`${entry.slug}: emitted article without a bound source unit id`);
      }
      if (unitIds.has(article.sourceUnitId)) {
        throw new Error(`${entry.slug}: duplicate sourceUnitId ${article.sourceUnitId}`);
      }
      unitIds.add(article.sourceUnitId);
    }
    for (const transitorio of norma.transitories ?? []) {
      if (transitorio.sourceUnitId === undefined) {
        throw new Error(`${entry.slug}: emitted transitorio without a bound source unit id`);
      }
      if (unitIds.has(transitorio.sourceUnitId)) {
        throw new Error(`${entry.slug}: duplicate sourceUnitId ${transitorio.sourceUnitId}`);
      }
      unitIds.add(transitorio.sourceUnitId);
    }
    const ledger = norma.sourceLedger ?? [];
    // S-INI — exact gap/ledger identity admission
    // (`src/sinalevi/corpus-builder-gate.ts`): full-ledger source-unit
    // ids are positive, safe, and unique across EVERY kind; the
    // persisted `sourceGaps` rows and the ledger's `known-gap` entries
    // agree with equal cardinality and exact (sourceUnitId, reason,
    // normalized caption, docOrder) identity in deterministic order —
    // missing, extra, duplicated, reordered, or field-drifted rows all
    // reject; and every reviewed-exclusion id (24190..24206) is
    // proven absent from `sourceGaps`.
    assertSourceGapLedgerIdentity(
      { slug: entry.slug, fixture: entry.fixture },
      norma.sourceGaps ?? [],
      ledger,
      PENAL_REVIEWED_EXCLUSION_SOURCE_UNIT_IDS,
    );
    // Source-handler namespace: emitted unit ids plus the ledger's
    // known-gap and reviewed-exclusion ids must all be distinct, and
    // the ledger must cover exactly that namespace (one row per
    // source handler, no hollow or extra entries).
    for (const ledgerEntry of ledger) {
      if (
        ledgerEntry.kind === "known-gap" ||
        ledgerEntry.kind === "reviewed-exclusion"
      ) {
        if (unitIds.has(ledgerEntry.sourceUnitId)) {
          throw new Error(
            `${entry.slug}: ${ledgerEntry.kind} sourceUnitId ${ledgerEntry.sourceUnitId} collides with an emitted unit`,
          );
        }
        unitIds.add(ledgerEntry.sourceUnitId);
      }
    }
    if (ledger.length !== unitIds.size) {
      throw new Error(
        `${entry.slug}: ledger (${ledger.length}) does not cover every source handler (${unitIds.size})`,
      );
    }
    // Source-unit accounting equation: `ledger = emitted articles +
    // emitted transitorios + persisted known gaps + reviewed exclusions`.
    // Per-authority per-kind counts must match the audited
    // `sourceSummary`; the equation must hold EXACTLY for every
    // authority.
    let emittedArticles = 0;
    let emittedTransitorios = 0;
    let knownGaps = 0;
    let reviewedExclusions = 0;
    for (const entry of ledger) {
      if (entry.kind === "emitted-article") emittedArticles += 1;
      else if (entry.kind === "emitted-transitory") emittedTransitorios += 1;
      else if (entry.kind === "known-gap") knownGaps += 1;
      else if (entry.kind === "reviewed-exclusion") reviewedExclusions += 1;
    }
    const measuredSummary = {
      articles: emittedArticles,
      transitorios: emittedTransitorios,
      knownGaps,
      reviewedExclusions,
    };
    const expectedLedger =
      entry.sourceSummary.articles +
      entry.sourceSummary.transitorios +
      entry.sourceSummary.knownGaps +
      entry.sourceSummary.reviewedExclusions;
    if (measuredSummary.articles !== entry.sourceSummary.articles) {
      throw new Error(
        `${entry.slug}: ledger emitted-article count ${measuredSummary.articles} drifts from sourceSummary.articles ${entry.sourceSummary.articles}`,
      );
    }
    if (measuredSummary.transitorios !== entry.sourceSummary.transitorios) {
      throw new Error(
        `${entry.slug}: ledger emitted-transitorio count ${measuredSummary.transitorios} drifts from sourceSummary.transitorios ${entry.sourceSummary.transitorios}`,
      );
    }
    if (measuredSummary.knownGaps !== entry.sourceSummary.knownGaps) {
      throw new Error(
        `${entry.slug}: ledger known-gap count ${measuredSummary.knownGaps} drifts from sourceSummary.knownGaps ${entry.sourceSummary.knownGaps}`,
      );
    }
    if (measuredSummary.reviewedExclusions !== entry.sourceSummary.reviewedExclusions) {
      throw new Error(
        `${entry.slug}: ledger reviewed-exclusion count ${measuredSummary.reviewedExclusions} drifts from sourceSummary.reviewedExclusions ${entry.sourceSummary.reviewedExclusions}`,
      );
    }
    if (ledger.length !== expectedLedger) {
      throw new Error(
        `${entry.slug}: ledger length ${ledger.length} does not equal articles+transitorios+knownGaps+reviewedExclusions (${expectedLedger})`,
      );
    }
    if (norma.articles.length !== entry.expectedArticles) {
      throw new Error(
        `${entry.slug} text-bearing article count mismatch: ${norma.articles.length} !== ${entry.expectedArticles}`,
      );
    }
    // Review fix #7: the release count is a TEXT-BEARING count. A body
    // without substantive text (Unicode-whitespace- or control/format-only)
    // means the count was met with a hollow row; fail the build rather than
    // ship an "article" with no source text. Same shared predicate as the
    // app startup (`validateCorpusDb`) and MCP (`verifyProfile`) gates.
    const blank = norma.articles.filter((a) => !hasSubstantiveText(a.body));
    if (blank.length > 0) {
      throw new Error(
        `${entry.slug}: ${blank.length} extracted article body(ies) blank (numbers: ${blank
          .slice(0, 5)
          .map((a) => JSON.stringify(a.number))
          .join(", ")})`,
      );
    }
    addNorma(db, entry.meta, norma);
    extracted.set(entry.slug, norma);
    console.log(`ingested ${entry.slug}: ${norma.articles.length} text-bearing articles`);
  }

  // F04: derive each authority's content identity from the exact opened DB
  // that will be exported. No digest is manually transcribed into source.
  // S-INI — manifest v3: evidence inputs are the CAPTURE digests (input
  // side: raw fixture bytes + the compiled reviewed expectations) and the
  // complete handler ledgers measured during extraction. The manifest may
  // not attest its own completeness: every ledger here is reconciled 1:1
  // against the positional source-unit ledger (the builder already
  // rejects unaccounted handlers fail-closed above).
  const ledgers = new Map<
    string,
    { sourceUnitId: number; kind: string; reason?: string }[]
  >();
  for (const [slug, norma] of extracted) {
    ledgers.set(
      slug,
      (norma.sourceLedger ?? []).map((e) => ({
        sourceUnitId: e.sourceUnitId,
        kind: e.kind,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
      })),
    );
  }
  const sidecarDigests = new Map<string, string>();
  const hashUpdate = createHash("sha256");
  for (const entry of MANIFEST) {
    const raw = readFileSync(resolve(fixturesDir, entry.fixture));
    const digest = createHash("sha256").update(raw).digest("hex");
    sidecarDigests.set(entry.slug, digest);
    hashUpdate.update(entry.slug).update("\u0000").update(digest).update("\u0001");
  }
  const evidence: Omit<ReleaseEvidenceInputs, "measurements"> = {
    // The reviewed expectations compiled into THIS builder's MANIFEST
    // list (handles + text-bearing counts + template family) — the same
    // values the release catalog will carry; candidates never feed it.
    catalogDigest: catalogDigestOfManifestList(),
    fixtureSetDigest: hashUpdate.digest("hex"),
    sidecarDigests,
    ledgers,
  };
  const manifest = createCorpusManifestV3(db, evidence);
  const bytes = exportDatabase(db);
  db.close();

  // Verify the exported artifact itself: reload the exact bytes we are
  // about to ship and run the same validation startup will run. Only a
  // verified artifact gets written — never a partial or broken one.
  const verified = await loadDatabase(bytes);
  try {
    validateCorpusDbV3(verified, manifest);
  } finally {
    verified.close();
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, bytes);
  writeFileSync(outManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  // Review fix #8: the canonical tracked notice is copied byte-for-byte into
  // the package beside the DB + manifest. Never regenerate it here — the
  // root file is the single source; any drift shows up as a reviewable diff
  // on the tracked file.
  copyFileSync(noticeSource, outNotice);
  console.log(
    `wrote ${out} (${bytes.byteLength} bytes), ${outManifest}, and ${outNotice} — integrity + manifest verified`,
  );

  return {
    roots: resolved,
    dbPath: out,
    manifestPath: outManifest,
    noticePath: outNotice,
    dbBytes: bytes.byteLength,
    manifest,
  };
}

// ---------------------------------------------------------------------------
// Direct-entry boundary
// ---------------------------------------------------------------------------

/**
 * True only when THIS process is itself a Vitest worker. The single signal is
 * the in-process, non-inheritable `globalThis.__vitest_worker__` marker that
 * Vitest installs in its worker (measured: an object with `ctx`, `filepath`,
 * `current`, … under vitest 2.1.9).
 *
 * `process.env.VITEST` must NOT be consulted here: an environment variable is
 * INHERITED by every child process spawned from a test run, so the prebuild
 * gate's own legitimate `vite-node` rebuild child was misclassified as a test
 * worker. The entry guard then returned false and this builder exited 0 having
 * written nothing — the silent no-op the gate's fail-closed contract exists to
 * prevent.
 *
 * Import safety does not actually rest on this marker either way: a test that
 * merely imports this module runs with `argv[1]` pointing at the Vitest pool
 * worker entry, which is neither this module nor a vite-node launcher, so
 * `builderEntryRequested` already returns false on argv discrimination alone.
 * The marker is a backstop for the narrow case where the test runner is itself
 * launched via `vite-node`, so `argv[1]` names the launcher.
 */
function isUnderTestWorker(): boolean {
  const worker = (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
  return worker !== undefined;
}

/** Launcher basenames that identify a plain (target-stripping) vite-node run.
 * Both real spellings must be accepted: the npx bin symlink
 * `node_modules/.bin/vite-node` and the prebuild spawn target
 * `node_modules/vite-node/vite-node.mjs` (scripts/verify-corpus-artifact.ts). */
const VITE_NODE_LAUNCHER_BASENAMES: readonly string[] = ["vite-node", "vite-node.mjs"];

/**
 * Pure direct-entry decision, parameterized so every real launcher argv shape
 * is unit-testable without spawning anything. The build runs at import time
 * ONLY when this module IS the process target — never when a test or another
 * module merely imports it. Three real launchers are supported:
 *
 *  1. `node <file>` / `vite-node --script <file>` — argv[1] is exactly this
 *     module's path (strict identity). Honored even under a test worker: a
 *     runner that names this exact file as argv[1] is a direct entry by
 *     definition, and a Vitest pool worker never does.
 *  2. plain `vite-node <file>` (`npx vite-node scripts/build-corpus-artifact.ts`)
 *     — vite-node strips the target from argv, so argv[1] names the launcher
 *     bin `node_modules/.bin/vite-node`.
 *  3. the prebuild spawn (`node node_modules/vite-node/vite-node.mjs
 *     scripts/build-corpus-artifact.ts`) — same stripping, but argv[1] names
 *     the launcher module `vite-node.mjs`.
 *
 * Inherent limitation of forms 2 and 3: with the target stripped, the launcher
 * basename is the only in-band signal, and it cannot distinguish "vite-node
 * launched THIS module" from "vite-node launched some other module that
 * transitively imports this one" — such a run would trigger a build here. What
 * keeps a test run inert is that under Vitest `argv[1]` is the pool worker
 * entry, which matches neither this module nor a launcher, so the argv
 * discrimination alone returns false; the in-process `__vitest_worker__`
 * exclusion is only a backstop for a runner itself launched via vite-node. An
 * inherited `VITEST` env marker is deliberately NOT a signal here, because the
 * builder's own real children inherit it (see `isUnderTestWorker`). Nothing in
 * this repository imports this module outside its own test. A plain
 * `node <importer>` names neither the launcher nor this module as target, so
 * it stays inert too. The launcher match additionally requires a
 * `node_modules` path segment so an unrelated `vite-node` file elsewhere on
 * disk cannot match.
 */
export function builderEntryRequested(
  argv: readonly (string | undefined)[],
  selfUrl: string,
  underTestWorker: boolean,
): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  const resolvedEntry = resolve(entry);
  if (selfUrl === pathToFileURL(resolvedEntry).href) return true;
  if (underTestWorker) return false;
  return (
    VITE_NODE_LAUNCHER_BASENAMES.includes(basename(resolvedEntry)) &&
    resolvedEntry.split(sep).includes("node_modules")
  );
}

function isDirectEntry(): boolean {
  return builderEntryRequested(process.argv, import.meta.url, isUnderTestWorker());
}

if (isDirectEntry()) {
  // Standalone CLI: roots come ONLY from the allowlisted `--outDir` /
  // `--fixturesDir` flags via `parseBuildArgv` (bare in-repo cwd resolves to
  // the repository defaults, so production is unaffected). A refusal prints
  // one `REFUSAL:` line and sets exit 2 with no build started. Reusable logic
  // only throws; the boundary prints one `FATAL:` line and sets
  // `process.exitCode = 1`, never `process.exit()`. Roots are never read from
  // env vars; `noticeSource` stays module-derived through
  // `resolveCorpusArtifactRoots` defaults.
  const parsed = parseBuildArgv(process.argv, process.cwd(), ROOT);
  if (!parsed.ok) {
    console.error(formatBuildRefusal(parsed));
    process.exitCode = exitCodeForBuildRefusal(parsed.refusalKey);
  } else {
    void buildCorpusArtifact({
      fixturesDir: parsed.fixturesDir,
      outDir: parsed.outDir,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`FATAL: ${message}`);
      process.exitCode = 1;
    });
  }
}
