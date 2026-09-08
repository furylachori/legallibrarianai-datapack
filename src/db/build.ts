/**
 * Build a portable SQLite database from an extracted norma.
 *
 * Pure except the DB handle: it accepts a `Db` (created via createDatabase())
 * and populates it. The same module runs in Node (bootstrap) and in a
 * browser/Tauri webview (client-side rebuild) — neither environment imports
 * sql.js-fts5 directly here, the handle is injected by the caller.
 */
import type {
  Article,
  ExtractedNorma,
  HierarchyKind,
  HierarchyNode,
  TransitoryProvision,
} from "../sinalevi/types.js";
import {
  computeCorpusContentIdentity,
  computeCorpusTextHash,
} from "../corpus/content-identity.js";
import { createDatabase, type Db, type Row } from "./database.js";

/**
 * Norma-level metadata that is NOT in the HTML — supplied by the caller.
 * `importedAt` is injected by the caller to keep builds deterministic
 * (same input → same bytes); it defaults to the current time only when
 * the caller explicitly asks for non-determinism.
 */
export interface NormaMeta {
  idFichaNorma: number;
  idVersionNorma: number;
  number: string; // "2"
  name: string; // "Código de Trabajo"
  tipo: number; // SINALEVI TipoNorma code
  date: string; // "27/08/1943"
  sourceUrl: string;
  /**
   * ISO-8601 timestamp for when this build was produced. The caller is
   * responsible for providing a stable value (e.g. a content-derived
   * hash) so repeated builds of the same corpus produce identical bytes.
   * Optional — defaults to the current time when omitted, but tests
   * that need byte-level determinism should always pass it explicitly.
   */
  importedAt?: string;
}

/** Level number per kind — drives parent_id reconstruction. */
const KIND_LEVEL: Record<HierarchyKind, number> = {
  libro: 0,
  titulo: 1,
  capitulo: 2,
  seccion: 3,
};

/**
 * The one canonical CREATE statement per corpus-v2 table the strictness
 * repair below may rebuild, as functions of the (temporarily staged)
 * table name. `SCHEMA_DDL`, the repair, and its post-checks all derive
 * from these builders — a second competing definition of any of these
 * objects is the defect class this migration exists to close.
 */
function strictArticleDdl(table: string): string {
  return `CREATE TABLE ${table} (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  norma_id           INTEGER NOT NULL REFERENCES norma(id) ON DELETE CASCADE,
  number             TEXT    NOT NULL,
  ordinal_raw        TEXT    NOT NULL,
  body               TEXT    NOT NULL,
  ficha_ref         TEXT,
  hierarchy_node_id  INTEGER REFERENCES hierarchy_node(id) ON DELETE SET NULL,
  doc_order          INTEGER NOT NULL,
  -- M-LAW-11 — see hierarchy_node.extract_order.
  extract_order      INTEGER,
  -- S-INI (corpus schema v2) — the exact SINALEVI source-unit id of
  -- the Ficha terminator this article consumed. NULL means "captured
  -- before source-unit ids were tracked" (legacy rows / hand-built
  -- inputs); a present value is a positive SQLite integer. The
  -- partial unique index below plus assertSourceUnitNamespace keep
  -- articles/transitories/gaps one id namespace per authority.
  source_unit_id     INTEGER
    CHECK (source_unit_id IS NULL
           OR (typeof(source_unit_id) = 'integer' AND source_unit_id > 0)),
  UNIQUE (norma_id, number)
)`;
}

function strictTransitoryDdl(table: string): string {
  return `CREATE TABLE ${table} (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  norma_id           INTEGER NOT NULL REFERENCES norma(id) ON DELETE CASCADE,
  number             TEXT    NOT NULL,
  ordinal_raw        TEXT    NOT NULL,
  attaches_to        TEXT    NOT NULL DEFAULT '',
  body               TEXT    NOT NULL,
  label              TEXT    NOT NULL,
  hierarchy_node_id  INTEGER REFERENCES hierarchy_node(id) ON DELETE SET NULL,
  doc_order          INTEGER NOT NULL,
  -- M-LAW-11 — see hierarchy_node.extract_order.
  extract_order      INTEGER,
  -- S-INI — see article.source_unit_id. Standalone provisions are
  -- source-addressable units and share the same id namespace.
  source_unit_id     INTEGER
    CHECK (source_unit_id IS NULL
           OR (typeof(source_unit_id) = 'integer' AND source_unit_id > 0)),
  UNIQUE (norma_id, number, attaches_to)
)`;
}

function strictSourceGapDdl(table: string): string {
  return `CREATE TABLE ${table} (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  norma_id        INTEGER NOT NULL REFERENCES norma(id) ON DELETE CASCADE,
  source_unit_id  INTEGER NOT NULL
    CHECK (typeof(source_unit_id) = 'integer' AND source_unit_id > 0),
  reason          TEXT    NOT NULL CHECK (length(reason) > 0),
  caption         TEXT    NOT NULL DEFAULT '',
  doc_order       INTEGER NOT NULL,
  UNIQUE (norma_id, source_unit_id)
)`;
}

function strictFrontMatterDdl(table: string): string {
  return `CREATE TABLE ${table} (
  norma_id  INTEGER PRIMARY KEY REFERENCES norma(id) ON DELETE CASCADE,
  present   INTEGER NOT NULL CHECK (present IN (0, 1)),
  body      TEXT    NOT NULL DEFAULT '',
  CHECK ((present = 1 AND length(body) > 0) OR (present = 0 AND body = ''))
)`;
}

/** Add the IF-NOT EXISTS guard the full-DDL pass needs to a canonical
 *  CREATE TABLE. sqlite_master never stores the guard, so the canonical
 *  text stays the stored-text comparison baseline. */
function createIfMissing(ddl: string): string {
  return ddl.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ");
}

/**
 * Byte-exact CREATE text for the two v2 partial unique indexes. The
 * shipped-corpus artifact bytes are pinned by the release lock, and these
 * statements are the only objects the fresh-build path creates OUTSIDE
 * `SCHEMA_DDL` — so their exec text is frozen exactly as the additive
 * migration always ran it (leading newline and trailing indent included;
 * sqlite_master stores it minus the IF-NOT EXISTS guard).
 */
const INDEX_DDL_ARTICLE_SOURCE_UNIT = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_article_source_unit
        ON article(norma_id, source_unit_id) WHERE source_unit_id IS NOT NULL
    `;
const INDEX_DDL_TRANSITORY_SOURCE_UNIT = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transitory_source_unit
        ON transitory_provision(norma_id, source_unit_id) WHERE source_unit_id IS NOT NULL
    `;

/** The DDL, inlined so buildDatabase is self-contained. */
const SCHEMA_DDL = `
PRAGMA foreign_keys = ON;
-- One CURRENT version per norma. PK = idFichaNorma. Re-import of the
-- same idFichaNorma is an UPSERT (replaces the row + cascades through
-- articles / hierarchy_node via DELETE below).
--
-- Multi-version history is a LATER seam: when that arrives, the PK
-- becomes (idFichaNorma, version_id) and a version_history table tracks
-- superseded versions. Until then this table honestly represents
-- "the version of the norma we currently ship".
CREATE TABLE IF NOT EXISTS norma (
  id            INTEGER PRIMARY KEY,
  version_id    INTEGER NOT NULL,
  number        TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  tipo          INTEGER NOT NULL,
  date          TEXT    NOT NULL,
  source_url    TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  imported_at   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS hierarchy_node (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  norma_id      INTEGER NOT NULL REFERENCES norma(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK (kind IN ('libro','titulo','capitulo','seccion')),
  label         TEXT    NOT NULL,
  display_label TEXT,
  doc_order     INTEGER NOT NULL,
  -- M-LAW-11: ONE global extraction-order coordinate shared by
  -- hierarchy_node, article and transitory_provision. doc_order stays
  -- what it always was (the position inside the extractor's own array, so
  -- it restarts at 0 per kind); extract_order is the cleaned-text line
  -- the item was found on, which is the only value that can interleave a
  -- sub-section with the articles that follow it. NULL on rows written
  -- before this column existed (see migrateCorpusSchema) — the Super Index
  -- then falls back to doc_order.
  extract_order INTEGER,
  parent_id     INTEGER REFERENCES hierarchy_node(id) ON DELETE CASCADE
);
${createIfMissing(strictArticleDdl("article"))};
-- M-LAW-10: STANDALONE transitory provisions ("TRANSITORIO I.- …",
-- "Transitorio al artículo 148. …"). Deliberately NOT rows in article:
-- the release contract pins the per-authority ARTICLE counts (and the
-- citation engine resolves article numbers), so a transitorio gets its own
-- addressable table and can never shift an expected count.
-- attaches_to is '' (never NULL) when the provision carries no
-- "al artículo N" reference, so the identity is total.
${createIfMissing(strictTransitoryDdl("transitory_provision"))};

-- S-INI (corpus schema v2) — persisted typed known source gaps: every
-- Ficha handler the capture accounted for but could NOT emit as
-- standalone text. Rows ride the whole merge/adoption path so app and
-- MCP behavior never depends on repository source constants. Strict by
-- construction: positive integer ids, non-empty reason, one gap per
-- (norma_id, source_unit_id).
${createIfMissing(strictSourceGapDdl("source_gap"))};

-- S-INI (corpus schema v2) — one row per authority front matter with
-- explicit absent-vs-empty semantics: NO row = never captured;
-- present=0 + body='' = captured and empty; present=1 = captured
-- substantive text.
${createIfMissing(strictFrontMatterDdl("norma_front_matter"))};
CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(
  number, body, content='', tokenize='unicode61'
);
CREATE INDEX IF NOT EXISTS idx_article_norma      ON article(norma_id);
CREATE INDEX IF NOT EXISTS idx_article_hier_node   ON article(hierarchy_node_id);
CREATE INDEX IF NOT EXISTS idx_hier_norma          ON hierarchy_node(norma_id);
CREATE INDEX IF NOT EXISTS idx_hier_parent         ON hierarchy_node(parent_id);
CREATE INDEX IF NOT EXISTS idx_transitory_norma    ON transitory_provision(norma_id);
CREATE INDEX IF NOT EXISTS idx_source_gap_norma     ON source_gap(norma_id);
-- NOTE: the v2 PARTIAL unique indexes (idx_article_source_unit /
-- idx_transitory_source_unit) are created by migrateCorpusSchema AFTER
-- the additive ALTERs. Creating them inside this DDL string would name
-- a column that a pre-vNext table does not have yet (index creation
-- must never run before its column exists); the cross-kind rule
-- (article + transitory + gap sharing one namespace) is enforced at the
-- persistence boundary because SQLite cannot span tables in one index.
`;

/**
 * Build a fresh in-memory database and populate it with `meta` + `norma`.
 *
 * Thin wrapper: `createDatabase()` + `initSchema()` + `addNorma()`. The
 * `addNorma` half is the reusable seam — callers (e.g. the per-user
 * library) construct their own `Db` and call `addNorma(db, meta, norma)`
 * to ingest.
 */
export async function buildDatabase(
  meta: NormaMeta,
  norma: ExtractedNorma,
): Promise<Db> {
  const db = await createDatabase();
  initSchema(db);
  addNorma(db, meta, norma);
  return db;
}

/**
 * Ingest a single (meta, norma) into an existing Db, wrapped in a
 * transaction with the same DELETE-then-INSERT UPSERT semantics as
 * `buildDatabase`. The schema MUST already be initialised (via
 * `initSchema(db)`).
 *
 * This is the reusable seam: the per-user library reuses the corpus
 * schema verbatim and calls `addNorma` to populate it (one library
 * can hold many normas; buildDatabase creates a fresh Db each call).
 *
 * L-02: a caller that writes MANY normas (the corpus→library merge) must
 * not open one transaction per authority — a throw half-way would leave
 * the library holding some of the new normas and none of the rest. Use
 * `addNormaInTransaction` for that case and own the BEGIN/COMMIT yourself.
 */
export function addNorma(
  db: Db,
  meta: NormaMeta,
  norma: ExtractedNorma,
): void {
  const run = (sql: string, ...params: unknown[]): void => {
    db.run(sql, ...params);
  };
  run("BEGIN");
  try {
    addNormaInTransaction(db, meta, norma);
    run("COMMIT");
  } catch (e) {
    run("ROLLBACK");
    throw e;
  }
}

/**
 * The UPSERT body of `addNorma`, WITHOUT any transaction of its own. The
 * caller owns BEGIN/COMMIT/ROLLBACK, which is what lets the merge be one
 * atomic all-or-nothing upgrade across every authority it touches (L-02).
 */
export function addNormaInTransaction(
  db: Db,
  meta: NormaMeta,
  norma: ExtractedNorma,
): void {
  const run = (sql: string, ...params: unknown[]): void => {
    db.run(sql, ...params);
  };
  // The write below names the M-LAW-10 table and the M-LAW-11 columns, so
  // a library opened from pre-fix bytes has to be upgraded first. Cheap
  // and idempotent (PRAGMA-gated); the merge — which calls THIS function
  // to own one transaction across authorities — depends on it.
  migrateCorpusSchema(db);
  insertNorma(db, meta, norma, run);
  const hierarchyIds = insertHierarchy(
    db,
    meta.idFichaNorma,
    norma.hierarchy,
    run,
  );
  assertSourceUnitNamespace(meta.idFichaNorma, norma);
  insertArticles(db, meta.idFichaNorma, norma.articles, hierarchyIds, run);
  insertTransitories(
    db,
    meta.idFichaNorma,
    norma.transitories ?? [],
    hierarchyIds,
    run,
  );
  insertFrontMatter(db, meta.idFichaNorma, norma, run);
  insertSourceGaps(db, meta.idFichaNorma, norma, run);
}

/**
 * S-INI — the persistence-boundary cross-kind uniqueness rule (plan
 * §5.4): within one authority/version an article, a standalone
 * transitorio, and a typed gap share ONE source-unit id namespace, and
 * every emitted/gap id must be a positive safe integer used at most
 * once. A throw here aborts the whole authority write inside the
 * caller's transaction — nothing partial is ever persisted.
 */
function assertSourceUnitNamespace(normaId: number, norma: ExtractedNorma): void {
  const seen = new Set<number>();
  const take = (kind: string, value: number | undefined): void => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `addNorma: authority ${normaId} ${kind} carries a non-positive/non-integer source_unit_id`,
      );
    }
    if (seen.has(value)) {
      throw new Error(
        `addNorma: authority ${normaId} source_unit_id ${value} used by more than one unit`,
      );
    }
    seen.add(value);
  };
  for (const article of norma.articles) take("article", article.sourceUnitId);
  for (const transitorio of norma.transitories ?? []) {
    take("transitorio", transitorio.sourceUnitId);
  }
  for (const gap of norma.sourceGaps ?? []) {
    if (!Number.isSafeInteger(gap.sourceUnitId) || gap.sourceUnitId <= 0) {
      throw new Error(
        `addNorma: authority ${normaId} persisted gap carries a non-positive source_unit_id`,
      );
    }
    if (seen.has(gap.sourceUnitId)) {
      throw new Error(
        `addNorma: authority ${normaId} gap id ${gap.sourceUnitId} collides with an emitted unit`,
      );
    }
    seen.add(gap.sourceUnitId);
  }
}

/**
 * S-INI — persist front matter with absent-vs-empty semantics: no row
 * = never captured; present=0 body='' = captured empty; present=1 =
 * captured text (the table CHECK refuses an empty present body).
 */
function insertFrontMatter(
  db: Db,
  normaId: number,
  norma: ExtractedNorma,
  run: (sql: string, ...params: unknown[]) => void,
): void {
  if (norma.frontMatter === undefined) return; // explicitly absent
  const body = norma.frontMatter;
  if (body.length === 0) {
    run(
      `INSERT INTO norma_front_matter (norma_id, present, body) VALUES (?, 0, '')`,
      normaId,
    );
    return;
  }
  run(
    `INSERT INTO norma_front_matter (norma_id, present, body) VALUES (?, 1, ?)`,
    normaId,
    body,
  );
}

/** S-INI — persist the typed known gaps of one authority. */
function insertSourceGaps(
  db: Db,
  normaId: number,
  norma: ExtractedNorma,
  run: (sql: string, ...params: unknown[]) => void,
): void {
  for (const gap of norma.sourceGaps ?? []) {
    run(
      `INSERT INTO source_gap (norma_id, source_unit_id, reason, caption, doc_order)
       VALUES (?, ?, ?, ?, ?)`,
      normaId,
      gap.sourceUnitId,
      gap.reason,
      gap.caption ?? "",
      gap.docOrder,
    );
  }
}

/**
 * Apply the corpus schema. Idempotent (every CREATE uses IF NOT EXISTS).
 * Exposed for callers (e.g. the library) that build their own Db and
 * need the same DDL. Delegates to `migrateCorpusSchema`, which owns the
 * DDL plus the additive upgrade of a library written by an older app,
 * and reports whether this call actually changed the database.
 */
export function initSchema(db: Db): boolean {
  return migrateCorpusSchema(db);
}

/**
 * True when `table` exists in this schema. SQLite identifier comparison
 * is case-insensitive by default (every `name = ?` against `sqlite_master`
 * is, in practice, a `COLLATE BINARY` comparison the engine still applies
 * against the lowercase-folded identifier namespace), but the column-
 * side comparison in the WHERE clause is NOT — so a lax predecessor named
 * `Article` was treated as absent and later blessed by the migration that
 * was supposed to detect it. `LOWER(name) = LOWER(?)` makes the probe
 * follow SQLite's identifier semantics; a freshly-created, normal-case
 * `article` still matches (and a `Article` predecessor is now detected).
 */
function tableExists(db: Db, table: string): boolean {
  return (
    db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'table' AND LOWER(name) = LOWER(?)`,
      table,
    )[0]?.n ?? 0
  ) > 0;
}

/**
 * True when `table` has `column` — the PRAGMA gate every additive
 * migration below runs on. `pragma_table_xinfo(...)` resolves its
 * argument against the SQLite case-insensitive identifier namespace
 * (so `pragma_table_xinfo(article)` finds a table named `Article`),
 * returns the case the column was stored under, AND exposes hidden /
 * generated columns that `pragma_table_info` would skip. A predecessor
 * that already carries a generated lookalike column with the canonical
 * name must be detected here so the additive `ALTER TABLE … ADD
 * COLUMN` never fires into a slot that already exists (which would
 * raise a duplicate-column error mid-migration). The table name is
 * inlined as a quoted identifier (PRAGMA table functions do not
 * accept bound parameters in sql.js-fts5; the inlining is the same
 * pattern the prior `pragma_table_info` used and the table name is
 * always a known compile-time constant in this migration). The
 * column comparison below is folded on both sides so a case variant
 * of `source_unit_id` is still detected as "already present"; the
 * strictness repair lane (`sourceUnitColumnMatchesCanonical`) is the
 * verdict on whether the column is also CANONICAL.
 */
function hasColumn(db: Db, table: string, column: string): boolean {
  const wanted = column.toLowerCase();
  return db
    .query<{ name: string }>(`SELECT name FROM pragma_table_xinfo(${quoteIdent(table)})`)
    .some((c) => c.name.toLowerCase() === wanted);
}

/**
 * L-01 — rebuild the contentless `article_fts` index from the `article`
 * rows that actually exist.
 *
 * A `content=''` FTS5 table cannot be rebuilt in place (there is no
 * external content to read from) and cannot be `DELETE`d by rowid without
 * the exact values it indexed, so the only complete cleanup is drop +
 * recreate + re-index. Before this existed, every norma UPSERT / cascade
 * that removed `article` rows left their index entries behind forever —
 * pure index growth (the joins in `searchArticles` mask the ghosts from
 * the lawyer), which is exactly the defect this closes.
 *
 * Returns the number of rows dropped that had no source article. Runs
 * inside the caller's transaction when there is one.
 */
export function rebuildArticleFts(db: Db): number {
  const before = ftsGhostCount(db);
  const rows = db.query<Row & { id: number; number: string; body: string }>(
    `SELECT id, number, body FROM article ORDER BY id ASC`,
  );
  db.run("DROP TABLE IF EXISTS article_fts");
  db.run(
    `CREATE VIRTUAL TABLE article_fts USING fts5(
       number, body, content='', tokenize='unicode61'
     )`,
  );
  for (const r of rows) {
    db.run(
      `INSERT INTO article_fts (rowid, number, body) VALUES (?, ?, ?)`,
      r.id,
      r.number,
      r.body,
    );
  }
  return before;
}

/** How many `article_fts` rowids point at no `article` row (0 = clean). */
function ftsGhostCount(db: Db): number {
  const rows = db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM article_fts
     WHERE rowid NOT IN (SELECT id FROM article)`,
  );
  return (rows[0]?.n as number) ?? 0;
}

/**
 * L-01 / M-LAW-10 / M-LAW-11 / S-INI — the corpus-schema migration, safe
 * to call on every open:
 *
 *   0. read-only preflights that are verdicts on the UNTOUCHED database
 *      and run before the first write on EVERY path (fresh / additive /
 *      rebuild / index-only / no-op): the staging namespace must be
 *      free (`assertNoStagingResidue`), no canonical index name may be
 *      attached to a table it does not belong to
 *      (`assertCanonicalIndexOwnership`), the whole database must be
 *      free of foreign-key violations
 *      (`assertNoDatabaseForeignKeyViolations`), and the tracked
 *      `article` / `transitory_provision` tables must carry exactly the
 *      reviewed table-constraint inventory — the canonical
 *      logical-identity UNIQUE, the canonical outgoing FKs, and at most
 *      the canonical source-unit CHECK — with no unsupported
 *      `UNIQUE` / PRIMARY KEY / CHECK / FK extra that a rebuild would
 *      silently drop
 *      (`assertReviewedTableConstraints`), and every canonical column
 *      of those two tables must be PRESENT (apart from the two reviewed
 *      later-added columns `extract_order` / `source_unit_id`, which
 *      keep their additive ALTER lanes) and carry the EXACT effective
 *      metadata the canonical DDL declares — declared type, nullable /
 *      NOT NULL state, DEFAULT, PK ordinal, ordinary (non-generated)
 *      visibility, and BINARY collation — so a lost canonical column
 *      (which the migration would otherwise only be able to regenerate
 *      with guessed values) or a behavior-changing column declaration
 *      (a NOT NULL on the nullable SET NULL reference, a DEFAULT the
 *      canonical column never has, a non-BINARY COLLATE, a generated
 *      lookalike, …) refuses the migration instead of being blessed or
 *      silently rewritten by a rebuild;
 *   1. `transitory_provision` (M-LAW-10), the two `extract_order`
 *      columns (M-LAW-11), and the v2 `source_unit_id` columns (S-INI,
 *      added WITH their production CHECK) are created / ALTERed in place
 *      — a library written by an older app gets them on first touch;
 *   2. the strictness repair (`repairLooseV2Shapes`) inspects the
 *      EFFECTIVE shape of the v2 objects — not just their names, and not
 *      naive text equivalence: CHECK constraints are extracted from
 *      executable, comment-stripped DDL, and indexes are compared
 *      structurally through the PRAGMAs (with SQLite's case-insensitive
 *      identifier semantics) — and tightens the partially-migrated lax
 *      predecessors (source_unit_id without its
 *      real CHECK, source_gap without its CHECK/FK-cascade/caption
 *      semantics, front matter without the coupled absent-versus-empty
 *      CHECK or even its defaulted `body` column, same-named indexes
 *      with the wrong uniqueness/columns/predicate) into the canonical
 *      strict schema while preserving every valid row and stable row id.
 *      A required v2 table/column name STORED under noncanonical casing
 *      (`Source_Gap`, `Source_Unit_ID`) is part of that repair: SQLite
 *      resolves it, but the production manifest/schema/query/merge probes
 *      compare stored names exactly, so the rebuild rewrites it to the
 *      canonical lowercase spelling instead of blessing it.
 *      Before any destructive write it proves that no inbound dependent
 *      row of a rebuilt table can be acted on (`foreign_keys` is NEVER
 *      disabled — a reference that cannot be preserved without
 *      cascading/nulling a child fails the whole migration closed);
 *      afterwards `PRAGMA foreign_key_check` must be clean;
 *   3. the contentless `article_fts` index is rebuilt ONLY when ghost
 *      rowids are actually present (L-01), so a clean library pays nothing
 *      per open; an old library — where every pre-fix norma UPSERT left
 *      dead index rows behind — is cleaned once, transactionally.
 *
 * The ENTIRE mutation sequence — full DDL creation, additive ALTERs,
 * strict repairs, index replacement/creation, and the FTS repair — runs
 * inside ONE savepoint that works standalone (it opens and commits its
 * own transaction) and inside a caller-owned BEGIN alike (it nests). Any
 * failure rolls the savepoint back and rethrows, so the exact pre-call
 * schema/data/index set is intact and the caller CANNOT commit a partial
 * migration.
 *
 * RETURNS true when this call actually changed the database (a table /
 * index / column was created or ALTERed, a lax object was rebuilt, or the
 * ghost-index rebuild ran) and false when the schema was already current.
 * The caller MUST treat a true as a durable change even when zero corpus
 * rows moved — a schema-only migration that is not persisted would be
 * silently lost on the next open.
 */
export function migrateCorpusSchema(db: Db): boolean {
  const savepoint = "corpus_schema_v2_migration";
  db.run(`SAVEPOINT ${savepoint}`);
  try {
    const changed = applyCorpusSchemaV2(db);
    db.run(`RELEASE SAVEPOINT ${savepoint}`);
    return changed;
  } catch (cause) {
    try {
      db.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.run(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // the original failure is the verdict; cleanup must not mask it
    }
    throw cause;
  }
}

/** The body of `migrateCorpusSchema`, running inside its savepoint. */
function applyCorpusSchemaV2(db: Db): boolean {
  let changed = false;
  // Fail-closed hazard detection BEFORE any write: staging-namespace
  // objects, unsupported user-schema dependents of tables this run may
  // rebuild, and inbound dependent rows (including a pre-existing
  // dangling child — findings 1 and 2) are all verdicts on the untouched
  // database. None of these can be repaired inside the migration.
  assertNoStagingResidue(db);
  // TEMP-schema preflight: SQLite's "TEMP shadows main on unqualified
  // lookup" resolution rule means a TEMP `__v2strict_article`,
  // `__v2strict_transitory_provision`, `__v2strict_source_gap`, or
  // `__v2strict_norma_front_matter` would redirect the rebuild's copy
  // step; a TEMP trigger/index of the same name would be dropped by
  // an unqualified `DROP TRIGGER …` / `DROP INDEX …`; a TEMP trigger
  // attached to a main target would be implicitly dropped when the
  // rebuilt target disappears; and on the FTS / index-only / additive /
  // no-op lanes the unqualified `SELECT … FROM article`,
  // `INSERT INTO article_fts …`, `DROP TABLE article_fts`, and
  // `CREATE INDEX …` statements resolve through TEMP-shadowing
  // precedence identically. Conservative closed-by-default: the gate
  // fires UNCONDITIONALLY before the FIRST mutation on EVERY path
  // (fresh / additive / index-only / FTS / rebuild / no-op) and refuses
  // with a fixed content-safe message that does NOT include the TEMP
  // object name, type, or owner. Read-only (verdict on the untouched
  // database), inside the outer savepoint so a refusal unwinds to the
  // exact pre-call state — main AND TEMP.
  assertNoTempSchemaObjects(db);
  // Canonical-index ownership preflight (finding 1): a canonical index
  // NAME attached to a table it does not belong to is an identity
  // collision this migration cannot repair. The owner-bound check used
  // to run only for tables that need a strict rebuild, so on an
  // index-only / no-op path the structural audit was the first to see
  // the name and silently dropped the user's index to re-create the
  // canonical one on its own owner. Read-only, and a verdict on the
  // untouched database, on every path.
  assertCanonicalIndexOwnership(db);
  // Whole-database FK preflight (additive-only path safety, finding 3):
  // a true-v1 table with a dangling inbound child migrates and used to
  // return true without reaching the per-rebuildable-table FK probe
  // (which only fires when a table actually needs rebuilding). The
  // bare `PRAGMA foreign_key_check` walks every row of every table —
  // including orphans a child carries against a parent this migration
  // does not rebuild — and refuses the migration before any schema
  // mutation when ANY violation exists. Read-only, valid inside a
  // caller-owned transaction, and required on every path
  // (additive / rebuild / no-op / fresh-build alike) so a true-v1
  // additive migration remains green while a true-v1 additive with a
  // pre-existing violation fails closed.
  assertNoDatabaseForeignKeyViolations(db);
  // Reviewed table-constraint preflight (unsupported table-constraint /
  // autoindex defect): `article` / `transitory_provision` may carry extra
  // inline/table constraints (a global `UNIQUE(source_unit_id)`,
  // `UNIQUE(body)`, a second CHECK, an extra/different outgoing FK) that
  // the canonical strict-v2 DDL cannot represent. Auditing only the
  // source-unit CHECK + column metadata blessed those extras, and any
  // rebuild then dropped them and their `sqlite_autoindex_*` silently.
  // This gate compares the EFFECTIVE CHECK / outgoing-FK / autoindex
  // inventory against the reviewed legacy-v1 and canonical-v2 sets and
  // refuses the migration before ANY schema write — schema, data, and
  // autoindexes stay exactly as found. Read-only, every path.
  assertReviewedTableConstraints(db);
  for (const spec of STRICT_V2_TABLE_SPECS) {
    if (tableNeedsStrictRebuild(db, spec)) {
      // FK pre-write proof: a child row that the rebuild's DROP would
      // cascade / null / RESTRICT (depending on its declared action)
      // fails the whole migration closed BEFORE any destructive write.
      // User-owned dependent objects (triggers, indexes, views) are no
      // longer a refusal criterion here — the rebuild captures their
      // exact SQL in `repairLooseV2Shapes` and recreates them from that
      // snapshot. A canonical index attached to the wrong owner was
      // already refused by the whole-database `assertCanonicalIndexOwnership`
      // preflight above.
      assertRebuildPreservesDependentRows(db, spec);
    }
  }
  const objectsBefore = schemaObjectKeys(db);
  db.run(SCHEMA_DDL);
  // SCHEMA_DDL only ever CREATES (IF NOT EXISTS), so any new master-entry
  // means this call upgraded the database.
  if (schemaObjectKeys(db).size > objectsBefore.size) changed = true;
  if (!hasColumn(db, "article", "extract_order")) {
    db.run(`ALTER TABLE article ADD COLUMN extract_order INTEGER`);
    changed = true;
  }
  if (!hasColumn(db, "hierarchy_node", "extract_order")) {
    db.run(`ALTER TABLE hierarchy_node ADD COLUMN extract_order INTEGER`);
    changed = true;
  }
  // S-INI (corpus schema v2) — additive, idempotent, and DURABLE even
  // when no corpus row changes: a library whose authorities are all
  // newer than the shipped set still upgrades to the v2 shape on open
  // and the migration persists through the normal durable path (the
  // boolean return is what makes the caller persist it).
  //
  // The `hasColumn` gate is intentional: a predecessor that already
  // carries a column named `source_unit_id` — including a generated
  // or hidden lookalike — must NOT trigger a duplicate-column
  // `ALTER TABLE … ADD COLUMN` failure. `pragma_table_info` exposes
  // generated/hidden columns by name (its visibility filter applies
  // to `SELECT *`, not to the column-listing PRAGMA); the strictness
  // repair lane (`sourceUnitColumnMatchesCanonical`, backed by
  // `pragma_table_xinfo`) then rejects the lookalike and rebuilds the
  // table with an ordinary `INTEGER` source_unit_id.
  if (!hasColumn(db, "article", "source_unit_id")) {
    db.run(
      `ALTER TABLE article ADD COLUMN source_unit_id INTEGER
         CHECK (source_unit_id IS NULL
                OR (typeof(source_unit_id) = 'integer' AND source_unit_id > 0))`,
    );
    changed = true;
  }
  if (!hasColumn(db, "transitory_provision", "source_unit_id")) {
    db.run(
      `ALTER TABLE transitory_provision ADD COLUMN source_unit_id INTEGER
         CHECK (source_unit_id IS NULL
                OR (typeof(source_unit_id) = 'integer' AND source_unit_id > 0))`,
    );
    changed = true;
  }
  // A partially-migrated predecessor can carry the v2 NAMES while the
  // effective objects stay materially lax (no source_unit_id CHECK, a
  // gap table without its CHECK/FK-cascade/caption semantics, front
  // matter without the coupled absent-versus-empty CHECK, same-named
  // indexes with the wrong uniqueness/columns/predicate). Existence
  // gates bless those shapes; this step inspects effective shape and
  // rebuilds what cannot be tightened in place — transactionally, or
  // not at all (plan §11.3).
  if (repairLooseV2Shapes(db)) changed = true;
  if (ftsGhostCount(db) > 0) {
    rebuildArticleFts(db);
    changed = true;
  }
  return changed;
}

/** Every named schema object currently in this database's master table. */
function schemaObjectKeys(db: Db): Set<string> {
  return new Set(
    db
      .query<{ key: string }>(
        `SELECT type || ':' || name AS key FROM sqlite_master
          WHERE type IN ('table', 'index', 'trigger', 'view')`,
      )
      .map((row) => row.key),
  );
}

/** The stored DDL text of one named master entry, or undefined when the
 *  object is absent. Shape inspection compares this effective text —
 *  never a bless-on-name existence check. The lookup is case-insensitive:
 *  a lax predecessor named `Article` is the same SQLite identifier as
 *  `article`, and the migration that was supposed to detect its laxness
 *  must read its stored DDL, not treat it as absent. */
function storedObjectSql(
  db: Db,
  type: "table" | "index",
  name: string,
): string | undefined {
  const row = db.query<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master
      WHERE type = ? AND LOWER(name) = LOWER(?)`,
    type,
    name,
  )[0];
  if (!row) return undefined;
  return row.sql ?? "";
}

/** The production CHECK every v2 `source_unit_id` column must carry,
 *  spelled exactly as the canonical builders embed it. */
const SOURCE_UNIT_COLUMN_CHECK = `CHECK (source_unit_id IS NULL
           OR (typeof(source_unit_id) = 'integer' AND source_unit_id > 0))`;

/**
 * Remove SQL comments from a stored statement, string- and
 * quoted-identifier-aware: `--` line comments and C-style block
 * comments vanish; single- AND double-quoted strings, backtick and
 * `[…]` quoted-identifier spans survive verbatim (including their
 * delimiters) so comment/string CONTENT can never masquerade as
 * executable SQL text in a shape comparison. A canonical CHECK copied
 * only into a comment is stripped here and stops counting as that
 * CHECK — the defect naive text equivalence blessed.
 *
 * Quoted-span rules follow what the repository SQLite engine actually
 * parses:
 *   - `'…'` / `"…"` / `` `…` `` honor a doubled-delimiter escape —
 *     `"source_""unit_id"` is the identifier `source_"unit_id`, not
 *     `"source_"` followed by text `""unit_id"`. The earlier scanner
 *     honored this only for `'`; for `"` and `` ` `` it closed on the
 *     first occurrence and let the doubled-up fragment become
 *     executable text — a lookalike CHECK predicate could then
 *     normalize into canonical tokens and bypass effective-shape
 *     inspection.
 *   - `[…]` has NO escape. The closing `]` ends the bracket span on
 *     the first occurrence (so `[a]]b]` parses as identifier `a`
 *     followed by the `]b]` text, which SQLite rejects as a syntax
 *     error in any position where an identifier cannot appear). The
 *     earlier scanner wrongly treated `]]` as an escape, which had no
 *     engine backing and let bracket-quoted fragments normalize into
 *     identifiers that did not correspond to anything the parser
 *     actually resolves.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  const skipQuoted = (start: number, close: string, escape: boolean): number => {
    let j = start + 1;
    while (j < n) {
      if (sql[j] === close) {
        if (escape && sql[j + 1] === close) {
          // Doubled delimiter = embedded literal of the delimiter
          // itself — only for forms SQLite actually honors as an
          // escape (`'`, `"`, `` ` ``); brackets are excluded.
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n;
  };
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue; // the newline itself survives on the next pass
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      out += " "; // keep token separation where the comment stood
      i = Math.min(j + 2, n);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipQuoted(i, ch, true);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "[") {
      // Bracket-quoted identifiers have NO doubled-escape; close at
      // the first `]`. SQLite parses `[a]]b]` as identifier `a`
      // followed by the `]b]` text — anything after a `]` belongs to
      // the surrounding executable token stream, not the bracket span.
      const end = skipQuoted(i, "]", false);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Normalize stored DDL for EFFECTIVE-shape comparison. Formatting
 * tolerance only, and only where SQLite itself is formatting-tolerant:
 * comments are removed (stripSqlComments), the IF-NOT EXISTS guard the
 * master may or may not store is dropped, whitespace and keyword case
 * outside string literals collapse (SQLite keywords/identifiers are
 * case-insensitive), punctuation is tightened, and double-quotes around a
 * SIMPLE identifier — what `ALTER TABLE … RENAME TO` leaves behind — are
 * unwrapped. String literals keep their exact text and case, and a quoted
 * span whose content is NOT a simple identifier (e.g. the single
 * `"norma_id, source_unit_id"` column an adversarial index is built on)
 * survives quoted and lowercase-folded, so it can never normalize into
 * two separate columns. No lax object can normalize its way into matching
 * the canonical strict text.
 */
function normalizeSqlShapeV2(sql: string): string {
  const stripped = stripSqlComments(sql);
  let out = "";
  let i = 0;
  const n = stripped.length;
  while (i < n) {
    const ch = stripped[i]!;
    if (ch === "'") {
      let j = i + 1;
      let lit = "'";
      while (j < n) {
        if (stripped[j] === "'") {
          if (stripped[j + 1] === "'") {
            lit += "''";
            j += 2;
            continue;
          }
          lit += "'";
          j++;
          break;
        }
        lit += stripped[j];
        j++;
      }
      out += lit;
      i = j;
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      const escape = ch !== "["; // brackets have NO doubled-delimiter escape
      let j = i + 1;
      let body = "";
      // A doubled delimiter inside a quoted span is an escaped literal
      // occurrence of the delimiter itself — `"a""b"` is the identifier
      // `a"b`, not `"a"` followed by text `""b"`. The earlier scan
      // stopped on the FIRST delimiter and let the doubled-up fragment
      // become executable text, where a lookalike name normalized into
      // canonical tokens; check the very next character for the
      // doubled escape BEFORE honoring the single-delimiter close.
      // Bracket-quoted identifiers close at the first `]` with no
      // escape (SQLite does not honor `]]` as a self-escape).
      while (j < n) {
        if (stripped[j] === close) {
          if (escape && stripped[j + 1] === close) {
            body += close;
            j += 2;
            continue;
          }
          break;
        }
        body += stripped[j]!;
        j++;
      }
      j = Math.min(j + 1, n);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)) {
        out += body.toLowerCase();
      } else {
        out += `"${body.toLowerCase()}"`;
      }
      i = j;
      continue;
    }
    if (isSqlWhitespace(ch)) {
      out += " ";
      i++;
      continue;
    }
    out += ch.toLowerCase();
    i++;
  }
  return out
    .replace(/\bif not exists\b/g, " ")
    .replace(/[ \t\r\n\f]*([(),=<>])[ \t\r\n\f]*/g, "$1")
    .replace(/[ \t\r\n\f]+/g, " ")
    .trim();
}

/** Skip one quoted span starting at `pos`; return the index after it.
 *
 *  Doubled-up delimiter characters are honored as escaped literal
 *  occurrences of the delimiter itself ONLY for the delimiter forms
 *  SQLite parses that way — single-quoted string literals (`'a''b'`)
 *  and double-quote / backtick identifier spans (`"a""b"`, `` `a``b` ``).
 *  Bracket-quoted identifiers have NO escape: `[a]]b]` parses as the
 *  identifier `a` followed by the `]b]` text, and the first `]`
 *  closes the span. The earlier implementation applied the
 *  doubled-delimiter rule uniformly and let a doubled-bracket
 *  fragment normalize into a lookalike identifier the parser would
 *  never actually resolve — closing on the first `]` is what aligns
 *  this scanner with the engine. */
function skipQuotedSpan(s: string, pos: number): number {
  const ch = s[pos]!;
  const close = ch === "[" ? "]" : ch;
  const escape = ch !== "[";
  let j = pos + 1;
  while (j < s.length) {
    if (s[j] === close) {
      if (escape && s[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return s.length;
}

/** SQLite's bare-identifier tokenizer treats ASCII letters, digits, `_`,
 *  mid-word `$` AND ANY character with code point >= U+0080 (the engine's
 *  `HiDigit` rule — every non-ASCII byte is identifier material) as
 *  identifier characters. The stored-DDL scanners must use the SAME
 *  token boundaries: an ASCII-only `[a-z0-9…]` fragment walk split a bare
 *  Unicode constraint name like `ücollate` at the `ü` and then EXECUTED
 *  the trailing ASCII fragment (`collate`, `match`, `initially`,
 *  `references`, …) as if it were the keyword — misrefusing a canonical
 *  column or inventing a phantom FK clause. `isSqlBareIdentStart` is the
 *  class the engine accepts to OPEN a bare identifier (letter / `_` /
 *  any non-ASCII character); `isSqlBareIdentPart` additionally accepts
 *  digits and `$`. A quoted name is handled by the quoted-span scanners
 *  (unchanged); these two predicates govern BARE identifier walking
 *  only. */
function isSqlBareIdentStart(ch: string): boolean {
  // NaN (empty string) fails the comparison, which is the wanted verdict.
  return /[a-z_]/i.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function isSqlBareIdentPart(ch: string): boolean {
  return /[a-z0-9_$]/i.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/** SQLite's tokenizer recognizes EXACTLY five ASCII characters as
 *  whitespace: space (U+0020), tab (U+0009), LF (U+000A), FF (U+000C),
 *  and CR (U+000D) — the engine's `sqlite3GetToken` handles the
 *  CC_SPACE / CC_TAB / CC_LF / CC_FF / CC_CR cases and nothing else
 *  (vertical tab U+000B is NOT engine whitespace). JavaScript `/\s/`
 *  is NOT that class: it additionally matches vertical tab and every
 *  Unicode whitespace character — crucially NBSP (U+00A0), which the
 *  engine instead consumes as bare-IDENTIFIER material (the same
 *  HiDigit rule as `isSqlBareIdentPart`). A scanner that skips NBSP as
 *  whitespace splits a bare constraint name like `x\u00a0NOT` at the
 *  NBSP and then EXECUTES the trailing ASCII fragment (`not`,
 *  `collate`, `references`, …) as if the engine had seen the keyword —
 *  fabricating a column constraint that hides (or hiding one that
 *  fabricates) behind the name, exactly the defect class
 *  `isSqlBareIdentStart` / `isSqlBareIdentPart` closed for `ü`. Every
 *  stored-DDL token scanner must use THIS predicate for whitespace and
 *  the bare-identifier predicates for identifier material. */
function isSqlWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * The CHECK constraint EXPRESSIONS a stored statement actually carries,
 * comment- and string-aware: each `CHECK ( … )` group with its balanced
 * parentheses, normalized via `normalizeSqlShapeV2`. This is the
 * effective-shape question the naive substring check got wrong — a CHECK
 * that exists only inside a comment or a string literal is not extracted,
 * and only a real constraint of the destination is.
 */
function findCheckConstraintGroups(sql: string): string[] {
  const s = stripSqlComments(sql);
  const groups: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      i = skipQuotedSpan(s, i);
      continue;
    }
    if (/[a-z_$]/i.test(ch)) {
      let j = i;
      while (j < n && /[a-z0-9_$]/i.test(s[j]!)) j++;
      const word = s.slice(i, j).toLowerCase();
      if (word === "check") {
        let k = j;
        while (k < n && isSqlWhitespace(s[k]!)) k++;
        if (s[k] === "(") {
          let depth = 0;
          let m = k;
          let end = -1;
          while (m < n) {
            const c = s[m]!;
            if (c === "'" || c === '"' || c === "`" || c === "[") {
              m = skipQuotedSpan(s, m);
              continue;
            }
            if (c === "(") depth++;
            else if (c === ")") {
              depth--;
              if (depth === 0) {
                end = m + 1;
                break;
              }
            }
            m++;
          }
          if (end > 0) {
            groups.push(normalizeSqlShapeV2(s.slice(k, end)));
            i = end;
            continue;
          }
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return groups;
}

/** True when `sql` carries a real (not commented-out) CHECK equal to
 *  `canonicalCheck` (one entry of `findCheckConstraintGroups`). */
function hasCheckConstraint(sql: string, canonicalCheck: string): boolean {
  return findCheckConstraintGroups(sql).includes(canonicalCheck);
}

/**
 * The normalized WHERE predicate a stored index statement actually
 * carries, comment- and string-aware, or undefined when the index is not
 * partial by predicate. Extracted from executable text only — a `WHERE`
 * copied into a comment does not count, and the real one does.
 */
function extractIndexWherePredicate(sql: string): string | undefined {
  const s = stripSqlComments(sql);
  let i = 0;
  const n = s.length;
  let depth = 0;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      i = skipQuotedSpan(s, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /[a-z_$]/i.test(ch)) {
      let j = i;
      while (j < n && /[a-z0-9_$]/i.test(s[j]!)) j++;
      if (s.slice(i, j).toLowerCase() === "where") {
        return normalizeSqlShapeV2(s.slice(i));
      }
      i = j;
      continue;
    }
    i++;
  }
  return undefined;
}

/**
 * One rebuildable corpus-v2 table: its canonical CREATE plus the
 * destination column list. `whenAbsent` is the SQL literal the copy
 * materializes for rows that predate the column — EXACTLY what
 * `ALTER TABLE … ADD COLUMN … DEFAULT …` would have stored for them (the
 * canonical column's own DEFAULT, e.g. `''` for a defaulted TEXT column),
 * and NULL only where the canonical column carries no default — so a
 * missing column with a canonical default materializes that default,
 * while any NOT NULL/CHECK the predecessor genuinely cannot satisfy fails
 * the copy closed instead of coercing a value.
 */
interface StrictV2TableSpec {
  readonly table: string;
  readonly ddl: (name: string) => string;
  readonly keyColumn: string;
  readonly columns: ReadonlyArray<{
    readonly name: string;
    readonly whenAbsent: string;
  }>;
}

const STRICT_V2_TABLE_SPECS: readonly StrictV2TableSpec[] = [
  {
    table: "article",
    ddl: strictArticleDdl,
    keyColumn: "id",
    columns: [
      { name: "id", whenAbsent: "NULL" },
      { name: "norma_id", whenAbsent: "NULL" },
      { name: "number", whenAbsent: "NULL" },
      { name: "ordinal_raw", whenAbsent: "NULL" },
      { name: "body", whenAbsent: "NULL" },
      { name: "ficha_ref", whenAbsent: "NULL" },
      { name: "hierarchy_node_id", whenAbsent: "NULL" },
      { name: "doc_order", whenAbsent: "NULL" },
      { name: "extract_order", whenAbsent: "NULL" },
      { name: "source_unit_id", whenAbsent: "NULL" },
    ],
  },
  {
    table: "transitory_provision",
    ddl: strictTransitoryDdl,
    keyColumn: "id",
    columns: [
      { name: "id", whenAbsent: "NULL" },
      { name: "norma_id", whenAbsent: "NULL" },
      { name: "number", whenAbsent: "NULL" },
      { name: "ordinal_raw", whenAbsent: "NULL" },
      { name: "attaches_to", whenAbsent: "''" },
      { name: "body", whenAbsent: "NULL" },
      { name: "label", whenAbsent: "NULL" },
      { name: "hierarchy_node_id", whenAbsent: "NULL" },
      { name: "doc_order", whenAbsent: "NULL" },
      { name: "extract_order", whenAbsent: "NULL" },
      { name: "source_unit_id", whenAbsent: "NULL" },
    ],
  },
  {
    table: "source_gap",
    ddl: strictSourceGapDdl,
    keyColumn: "id",
    columns: [
      { name: "id", whenAbsent: "NULL" },
      { name: "norma_id", whenAbsent: "NULL" },
      { name: "source_unit_id", whenAbsent: "NULL" },
      { name: "reason", whenAbsent: "NULL" },
      { name: "caption", whenAbsent: "''" },
      { name: "doc_order", whenAbsent: "NULL" },
    ],
  },
  {
    table: "norma_front_matter",
    ddl: strictFrontMatterDdl,
    keyColumn: "norma_id",
    columns: [
      { name: "norma_id", whenAbsent: "NULL" },
      { name: "present", whenAbsent: "NULL" },
      // Canonical `body` is `TEXT NOT NULL DEFAULT ''`: a captured-empty
      // predecessor that never had the column materializes the exact
      // default, it is not copied as NULL (which would fail NOT NULL and
      // wrongly poison a legal present=0 row).
      { name: "body", whenAbsent: "''" },
    ],
  },
];

/**
 * The EXACT stored table-constraint inventory of the two tracked
 * rebuildable tables. The strict rebuild rewrites them with
 * `strictArticleDdl` / `strictTransitoryDdl`, whose only inline table
 * constraints are the canonical logical-identity UNIQUE (one autoindex
 * with `origin = 'u'`, canonical key columns, ASC, BINARY, no
 * expression) and (v2 only) the canonical source-unit CHECK; the
 * outgoing references are the two column-level FKs with their canonical
 * ON UPDATE / ON DELETE / MATCH behavior from production DDL.
 *
 * The reviewed inventory covers BOTH generations the migration
 * legitimately upgrades from (see `REVIEWED_TABLE_CONSTRAINTS`):
 *   - a legacy v1 shape: the canonical identity UNIQUE autoindex, no
 *     source-unit CHECK (added by the additive ALTER), and the reviewed
 *     outgoing FKs WITHOUT explicit ON DELETE — the engine's default
 *     `NO ACTION` is reviewed and the rebuild normalises the
 *     missing/default actions to canonical CASCADE / SET NULL;
 *   - a canonical v2 shape: the SAME identity UNIQUE autoindex AND the
 *     SAME outgoing FKs WITH the canonical CASCADE / SET NULL actions,
 *     PLUS exactly the canonical source-unit CHECK.
 *
 * Anything beyond this set — an extra `UNIQUE(...)`/PK (which SQLite
 * materialises as an unexpected `sqlite_autoindex_*` entry), a second
 * table CHECK, an outgoing FK with wrong parent/from/to or a
 * wrong-action not in the reviewed set (`RESTRICT`, `SET DEFAULT`, …),
 * or a composite PRIMARY KEY masquerading as the identity UNIQUE — is
 * a user-authored table constraint the canonical strict-v2 DDL cannot
 * represent, so a rebuild would silently drop it (and its autoindex).
 * `assertReviewedTableConstraints` refuses those shapes closed instead;
 * the canonical rebuild path repairs a MISSING canonical identity
 * UNIQUE or canonical FK on a v2-looking table exactly once (rows must
 * satisfy the destination) and converges to false on subsequent calls.
 */
interface ReviewedForeignKey {
  readonly from: string;
  readonly parent: string;
  readonly onDelete: "NO ACTION" | "CASCADE" | "SET NULL" | "RESTRICT" | "SET DEFAULT";
  readonly onUpdate: "NO ACTION" | "CASCADE" | "SET NULL" | "RESTRICT" | "SET DEFAULT";
  readonly match: "NONE" | "PARTIAL" | "FULL";
}

interface ReviewedTableConstraints {
  readonly table: string;
  /** Ordered key-column signature of the reviewed logical-identity
   *  UNIQUE (the one allowed `origin = 'u'` autoindex), lowercase. */
  readonly identityColumns: readonly string[];
  /** Every reviewed outgoing FK shape — v1 defaults (NO ACTION / NONE)
   *  AND v2 canonical (CASCADE / SET NULL / NONE). Any existing FK must
   *  match one of these shapes verbatim (from, parent, on_delete,
   *  on_update, match); anything else (RESTRICT, SET DEFAULT, …) is a
   *  behavior-changing wrong action and refuses the migration. */
  readonly reviewedForeignKeys: ReadonlyArray<ReviewedForeignKey>;
  /** The strict v2 canonical outgoing FK inventory — the FK shape the
   *  rebuild restores and the only one that lets a v2-looking table
   *  converge. A v2-looking table missing any of these or carrying any
   *  FK not in `reviewedForeignKeys` is repaired once (or refused when
   *  the extras are wrong). */
  readonly canonicalForeignKeys: ReadonlyArray<ReviewedForeignKey>;
  /** The EXACT canonical effective metadata of every column the
   *  tracked table's canonical DDL declares (see
   *  `CanonicalColumnMetadata`). `assertReviewedTableConstraints`
   *  audits it so a present canonical-named column can never be
   *  blessed with behavior-changing metadata (a NOT NULL / DEFAULT /
   *  wrong type / generated column / non-BINARY COLLATE that the
   *  canonical declaration does not carry) or have that metadata
   *  silently rewritten by an unrelated rebuild. */
  readonly columnMetadata: ReadonlyArray<CanonicalColumnMetadata>;
}

/** The canonical EFFECTIVE metadata of one article / transitory column
 *  exactly as `strictArticleDdl` / `strictTransitoryDdl` (and the
 *  mirrored `SCHEMA_DDL` / `schema.sql`) declares it, in the shape
 *  `pragma_table_xinfo` exposes plus the one field the PRAGMA omits:
 *
 *  - `name`: the exact stored column name (canonical lowercase; a
 *    noncanonical STORED CASING is the approved canonicalization repair
 *    lane, so the audit matches case-insensitively and never refuses
 *    for casing alone);
 *  - `type`: the exact declared type the engine reports (trimmed /
 *    uppercased — `INTEGER` / `TEXT` verbatim, NOT `INT`, `BIGINT`,
 *    `INTEGER(8)`, `VARCHAR`, or the empty type of an untyped
 *    declaration, whose different affinity silently coerces (or fails
 *    to coerce) stored values);
 *  - `notNull`: the nullable / NOT NULL state (SQLite's `notnull`
 *    flag — including the implicit NOT NULL state of the rowid alias);
 *  - `defaultText`: the exact `dflt_value` text (`''` for the
 *    transitory `attaches_to` default; `null` when the canonical
 *    declaration carries NO DEFAULT);
 *  - `pk`: the PRIMARY KEY ordinal (1 for the `id` rowid alias, 0 for
 *    every other canonical column — a composite PK distributes the
 *    ordinal and the row-identity / autoindex gates refuse it).
 *
 *  Two further canonical properties are constant for every column and
 *  need no per-entry field: the column is ORDINARY (`hidden = 0` —
 *  never a hidden or STORED/VIRTUAL generated column) and its
 *  EFFECTIVE collation is BINARY (the canonical DDL declares no
 *  COLLATE clause; an explicit `COLLATE BINARY` is the same effective
 *  collation and is accepted, while any other collation changes
 *  comparison semantics and must never be blessed or silently
 *  rewritten). `pragma_table_xinfo` does not expose column collation,
 *  so the stored-DDL column parser is the verdict there.
 *
 *  This mirrors the canonical DDL builders; `strictArticleDdl` /
 *  `strictTransitoryDdl` remain the schema owner — keep both in sync
 *  for any changed column. */
interface CanonicalColumnMetadata {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultText: string | null;
  readonly pk: number;
}

const CANONICAL_ARTICLE_COLUMN_METADATA: readonly CanonicalColumnMetadata[] = [
  { name: "id", type: "INTEGER", notNull: false, defaultText: null, pk: 1 },
  { name: "norma_id", type: "INTEGER", notNull: true, defaultText: null, pk: 0 },
  { name: "number", type: "TEXT", notNull: true, defaultText: null, pk: 0 },
  { name: "ordinal_raw", type: "TEXT", notNull: true, defaultText: null, pk: 0 },
  { name: "body", type: "TEXT", notNull: true, defaultText: null, pk: 0 },
  { name: "ficha_ref", type: "TEXT", notNull: false, defaultText: null, pk: 0 },
  { name: "hierarchy_node_id", type: "INTEGER", notNull: false, defaultText: null, pk: 0 },
  { name: "doc_order", type: "INTEGER", notNull: true, defaultText: null, pk: 0 },
  { name: "extract_order", type: "INTEGER", notNull: false, defaultText: null, pk: 0 },
  // `source_unit_id` is canonical `INTEGER` nullable without DEFAULT and
  // non-PK, but its metadata verdict lives in its dedicated repair lane
  // (`sourceUnitColumnMatchesCanonical` + the additive ALTER) — the
  // per-column audit never double-drives that column.
  { name: "source_unit_id", type: "INTEGER", notNull: false, defaultText: null, pk: 0 },
];

const CANONICAL_TRANSITORY_COLUMN_METADATA: readonly CanonicalColumnMetadata[] = [
  { name: "id", type: "INTEGER", notNull: false, defaultText: null, pk: 1 },
  { name: "norma_id", type: "INTEGER", notNull: true, defaultText: null, pk: 0 },
  { name: "number", type: "TEXT", notNull: true, defaultText: null, pk: 0 },
  { name: "ordinal_raw", type: "TEXT", notNull: true, defaultText: null, pk: 0 },
  { name: "attaches_to", type: "TEXT", notNull: true, defaultText: "''", pk: 0 },
  { name: "body", type: "TEXT", notNull: true, defaultText: null, pk: 0 },
  { name: "label", type: "TEXT", notNull: true, defaultText: null, pk: 0 },
  { name: "hierarchy_node_id", type: "INTEGER", notNull: false, defaultText: null, pk: 0 },
  { name: "doc_order", type: "INTEGER", notNull: true, defaultText: null, pk: 0 },
  { name: "extract_order", type: "INTEGER", notNull: false, defaultText: null, pk: 0 },
  { name: "source_unit_id", type: "INTEGER", notNull: false, defaultText: null, pk: 0 },
];

/** The canonical v2 FK shape constants, spelled exactly as
 *  `strictArticleDdl` / `strictTransitoryDdl` declare them. Production
 *  DDL: `REFERENCES parent(id) ON DELETE CASCADE` / `ON DELETE SET
 *  NULL`; `ON UPDATE` and `MATCH` default to `NO ACTION` / `NONE`. */
const FK_ON_UPDATE_NO_ACTION: ReviewedForeignKey["onUpdate"] = "NO ACTION";
const FK_MATCH_NONE: ReviewedForeignKey["match"] = "NONE";

const CANONICAL_ARTICLE_FKS: readonly ReviewedForeignKey[] = [
  {
    from: "norma_id",
    parent: "norma",
    onDelete: "CASCADE",
    onUpdate: FK_ON_UPDATE_NO_ACTION,
    match: FK_MATCH_NONE,
  },
  {
    from: "hierarchy_node_id",
    parent: "hierarchy_node",
    onDelete: "SET NULL",
    onUpdate: FK_ON_UPDATE_NO_ACTION,
    match: FK_MATCH_NONE,
  },
];

/** v1 legacy default — the original repository v1 DDL declared BOTH
 *  outgoing article FKs with the engine default `NO ACTION`:
 *  `norma_id REFERENCES norma(id)` and
 *  `hierarchy_node_id REFERENCES hierarchy_node(id)`. Neither FK
 *  carries an explicit `ON DELETE` clause, so the engine reports the
 *  default `NO ACTION` through `pragma_foreign_key_list`. The rebuild
 *  normalises these defaults to the canonical CASCADE / SET NULL
 *  actions in ONE atomic migration. A v1+additive predecessor where
 *  the FK is *missing entirely* (just `INTEGER NOT NULL` with no
 *  REFERENCES clause) is in the same family: the engine reports zero
 *  outgoing FKs for the column, the rebuild creates the canonical FK
 *  with the canonical CASCADE / SET NULL action afterwards, and the
 *  post-migration inventory converges to the canonical set. */
const REVIEWED_ARTICLE_FKS: readonly ReviewedForeignKey[] = [
  ...CANONICAL_ARTICLE_FKS,
  {
    from: "norma_id",
    parent: "norma",
    onDelete: "NO ACTION",
    onUpdate: FK_ON_UPDATE_NO_ACTION,
    match: FK_MATCH_NONE,
  },
  {
    from: "hierarchy_node_id",
    parent: "hierarchy_node",
    onDelete: "NO ACTION",
    onUpdate: FK_ON_UPDATE_NO_ACTION,
    match: FK_MATCH_NONE,
  },
];

const CANONICAL_TRANSITORY_FKS: readonly ReviewedForeignKey[] = CANONICAL_ARTICLE_FKS;
const REVIEWED_TRANSITORY_FKS: readonly ReviewedForeignKey[] = REVIEWED_ARTICLE_FKS;

const REVIEWED_TABLE_CONSTRAINTS: readonly ReviewedTableConstraints[] = [
  {
    table: "article",
    identityColumns: ["norma_id", "number"],
    reviewedForeignKeys: REVIEWED_ARTICLE_FKS,
    canonicalForeignKeys: CANONICAL_ARTICLE_FKS,
    columnMetadata: CANONICAL_ARTICLE_COLUMN_METADATA,
  },
  {
    table: "transitory_provision",
    identityColumns: ["norma_id", "number", "attaches_to"],
    reviewedForeignKeys: REVIEWED_TRANSITORY_FKS,
    canonicalForeignKeys: CANONICAL_TRANSITORY_FKS,
    columnMetadata: CANONICAL_TRANSITORY_COLUMN_METADATA,
  },
];

/** The complete canonical index inventory: the EFFECTIVE structural shape
 *  (owning table, uniqueness, partial flag, ordered columns, predicate)
 *  that `collectIndexRepairs` verifies via PRAGMAs and sqlite_master, plus
 *  the byte-exact DDL text the repair re-executes. The partial entries
 *  carry the frozen gate text; the rest mirror the `SCHEMA_DDL` lines.
 *  Structural comparison — not naive text equivalence — is what catches an
 *  index that is same-named but keyed on one weird quoted identifier
 *  (`"norma_id, source_unit_id"` normalizes like two columns but IS one),
 *  the wrong uniqueness, or a predicate that survives only inside a
 *  comment; SQLite cannot tighten any of those in place, so a mismatch is
 *  dropped and re-created from the canonical text. */
interface CanonicalIndexShape {
  readonly name: string;
  readonly table: string;
  readonly unique: 0 | 1;
  readonly partial: 0 | 1;
  readonly columns: ReadonlyArray<string>;
  /** Raw predicate text (no WHERE keyword) for a partial index. */
  readonly where?: string;
  readonly ddl: string;
}

const CANONICAL_INDEX_SHAPES: readonly CanonicalIndexShape[] = [
  { name: "idx_article_norma", table: "article", unique: 0, partial: 0, columns: ["norma_id"], ddl: `CREATE INDEX IF NOT EXISTS idx_article_norma      ON article(norma_id)` },
  { name: "idx_article_hier_node", table: "article", unique: 0, partial: 0, columns: ["hierarchy_node_id"], ddl: `CREATE INDEX IF NOT EXISTS idx_article_hier_node   ON article(hierarchy_node_id)` },
  { name: "idx_hier_norma", table: "hierarchy_node", unique: 0, partial: 0, columns: ["norma_id"], ddl: `CREATE INDEX IF NOT EXISTS idx_hier_norma          ON hierarchy_node(norma_id)` },
  { name: "idx_hier_parent", table: "hierarchy_node", unique: 0, partial: 0, columns: ["parent_id"], ddl: `CREATE INDEX IF NOT EXISTS idx_hier_parent         ON hierarchy_node(parent_id)` },
  { name: "idx_transitory_norma", table: "transitory_provision", unique: 0, partial: 0, columns: ["norma_id"], ddl: `CREATE INDEX IF NOT EXISTS idx_transitory_norma    ON transitory_provision(norma_id)` },
  { name: "idx_source_gap_norma", table: "source_gap", unique: 0, partial: 0, columns: ["norma_id"], ddl: `CREATE INDEX IF NOT EXISTS idx_source_gap_norma     ON source_gap(norma_id)` },
  { name: "idx_article_source_unit", table: "article", unique: 1, partial: 1, columns: ["norma_id", "source_unit_id"], where: "source_unit_id IS NOT NULL", ddl: INDEX_DDL_ARTICLE_SOURCE_UNIT },
  { name: "idx_transitory_source_unit", table: "transitory_provision", unique: 1, partial: 1, columns: ["norma_id", "source_unit_id"], where: "source_unit_id IS NOT NULL", ddl: INDEX_DDL_TRANSITORY_SOURCE_UNIT },
];

/** The EXACT stored name of the master entry SQLite resolves `table` to,
 *  or undefined when no such table exists. SQLite's identifier namespace
 *  is case-insensitive but `sqlite_master.name` / `PRAGMA table_info`
 *  hand back the STORED spelling, which is what the production
 *  manifest/schema/query/merge probes compare exactly. */
function storedTableName(db: Db, table: string): string | undefined {
  return db.query<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND LOWER(name) = LOWER(?)`,
    table,
  )[0]?.name;
}

/**
 * True when this table stores a REQUIRED v2 identifier under
 * noncanonical casing — the table name itself (`Source_Gap`) or any
 * canonical column of the spec (`Source_Unit_ID`).
 *
 * SQLite resolves both against the canonical lowercase name, so every
 * SQL statement keeps working; but `sqlite_master.name` and
 * `PRAGMA table_info` expose the STORED spelling, and the production
 * manifest/schema/query/merge probes compare those names exactly
 * (`corpusSchemaVersionOf` → schema v1, omitted persisted coordinates,
 * missing identity inputs). Accepting the variant case-insensitively
 * inside this migration and leaving the stored spelling alone therefore
 * ships a database the rest of production reads as pre-v2.
 *
 * The schema owner is the right place to fix that: a noncanonical
 * stored spelling of a required name is a MIGRATION CHANGE, and the
 * canonical rebuild (staged canonical CREATE → copy from the stored
 * columns → drop → rename to the canonical lowercase name) is exactly
 * the mechanism that rewrites it, preserving every row and row id. A
 * column the predecessor carries that is NOT part of the canonical set
 * is untouched here (the rebuild's unknown-column gate is the verdict
 * on those).
 */
function hasNoncanonicalStoredIdentifiers(
  db: Db,
  spec: StrictV2TableSpec,
): boolean {
  const storedName = storedTableName(db, spec.table);
  if (storedName !== undefined && storedName !== spec.table) return true;
  const canonicalByLower = new Map(
    spec.columns.map((column) => [column.name.toLowerCase(), column.name]),
  );
  // Use `pragma_table_xinfo` so a generated/hidden column with a
  // canonical-name STORED under noncanonical casing also trips this
  // gate (a generated `Source_Unit_ID` is the same identifier as a
  // generated `source_unit_id`, and the production probes compare
  // stored names exactly).
  for (const column of db.query<{ name: string }>(
    `SELECT name FROM pragma_table_xinfo(?)`,
    spec.table,
  )) {
    const canonical = canonicalByLower.get(column.name.toLowerCase());
    if (canonical !== undefined && column.name !== canonical) return true;
  }
  return false;
}

/** True when `table` carries the article / transitory `source_unit_id`
 *  column with the EXACT metadata the canonical DDL declares:
 *  nullable, no DEFAULT, non-PK, ordinary (NOT generated / NOT hidden),
 *  with declared type `INTEGER` verbatim (after harmless trim/case
 *  normalization) AND no column-level COLLATE clause (canonical
 *  `INTEGER` resolves to implicit BINARY; any explicit
 *  `COLLATE NOCASE` / `COLLATE RTRIM` / etc. makes the canonical
 *  partial UNIQUE index inherit that collation, the index-shape
 *  repair then drops+recreates the index without ever touching the
 *  column declaration, and the recreated index re-inherits the same
 *  collation — a forever-loop until the table itself is rebuilt).
 *  Anything else is wrong by spec and must rebuild:
 *
 *   - `TEXT`/`REAL`/`BLOB`/`NUMERIC` silently coerces INTEGER writes
 *     through that column's affinity to text/real/blob and the
 *     canonical CHECK then rejects every legitimate write with a
 *     confusing message;
 *   - `INT`, `BIGINT`, `TINYINT`, `SMALLINT`, `UNSIGNED BIG INT`,
 *     `POINT`, `INTERVAL`, etc. are all `INT`-affinity columns but the
 *     canonical DDL stores EXACTLY `INTEGER` — the prior
 *     `t.includes("INT")` test accepted every one of them as canonical
 *     and shipped a database the production schema fingerprint would
 *     never recognise as v2;
 *   - `NOT NULL`, `DEFAULT`, `PK` change the cross-kind uniqueness
 *     semantics — a `source_unit_id INTEGER NOT NULL DEFAULT 0` or
 *     `source_unit_id INTEGER PRIMARY KEY` is a different shape;
 *   - a hidden/generated column (`pragma_table_xinfo` reports
 *     `hidden` = 1/2/3 for hidden, STORED, VIRTUAL generated columns)
 *     does not store user-written row values; an `ALTER TABLE … ADD
 *     COLUMN source_unit_id INTEGER GENERATED ALWAYS AS (…)` lookalike
 *     is invisible to `pragma_table_info`'s hidden flag but is
 *     detected by `pragma_table_xinfo` and treated as non-ordinary;
 *   - a column-level `COLLATE <not_binary>` is a different effective
 *     shape — see the JSDoc above for the index-loop class.
 *
 * The authoritative "this column is canonical" verdict is the union of
 * declared-type exact match + ordinary visibility + nullable + no
 * DEFAULT + non-PK + canonical (implicit-BINARY) collation; presence
 * plus CHECK text alone was the lax acceptance criterion the prior
 * code used and the defect this closes. */
function sourceUnitColumnMatchesCanonical(db: Db, table: string): boolean {
  const rows = db.query<
    Row & {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }
  >(
    `SELECT name, type, "notnull", dflt_value, pk, hidden
     FROM pragma_table_xinfo(?) WHERE LOWER(name) = 'source_unit_id'`,
    table,
  );
  const col = rows[0];
  if (!col) return false;
  // Reject hidden/generated columns: pragma_table_xinfo reports
  // `hidden = 0` for ordinary columns, 1 for hidden, 2 for STORED
  // generated, 3 for VIRTUAL generated. A generated lookalike does
  // not hold real row values the canonical CHECK inspects.
  if (col.hidden !== 0) return false;
  // EXACT declared type — see the JSDoc above for the list of
  // lookalike declarations an `INT`-substring test used to bless.
  const t = (col.type ?? "").trim().toUpperCase();
  if (t !== "INTEGER") return false;
  if (col.notnull !== 0) return false;
  if (col.dflt_value !== null) return false;
  if (col.pk !== 0) return false;
  // The column declaration must NOT carry an explicit non-BINARY
  // COLLATE clause. `pragma_table_xinfo` does not expose column
  // collation directly (only `pragma_index_xinfo` does, and only for
  // the index entries), so the stored CREATE TEXT is the verdict:
  // the SAME top-level, Unicode-aware column-definition/collation
  // parser the per-column metadata audit uses scans the whole
  // declaration (SQLite parses column constraints in any order, and a
  // bare constraint name — Unicode, `$`, NBSP included — is one
  // identifier, never a keyword fragment) and refuses anything other
  // than `BINARY` (or absent — implicit BINARY is canonical for
  // INTEGER). The former duplicate ASCII scanner of this lane is
  // deleted; the verdicts of the two parsers agree on every
  // previously-tested shape, and the shared parser additionally
  // catches a COLLATE hidden behind a boundary keyword or a Unicode
  // name.
  const stored = storedObjectSql(db, "table", table);
  if (stored === undefined) return false;
  if (columnEffectiveCollationIsNonBinary(stored, "source_unit_id")) return false;
  return true;
}

/** Decode one quoted-identifier span at `pos` (its opening delimiter),
 *  honoring the doubled-delimiter escape for `close === '"'` and
 *  `close === '`'` (which is what the SQLite identifier grammar
 *  supports for `"…"` and `` `…` ``), and the first-`]` close rule
 *  for `close === "]"`. Returns the body text (escape-resolved) and
 *  the index after the closing delimiter, or `null` when the span is
 *  unterminated in the source. */
function readQuotedIdentBody(
  s: string,
  pos: number,
  close: string,
  escape: boolean,
): { body: string; end: number } | null {
  let j = pos + 1;
  const bodyStart = j;
  while (j < s.length) {
    if (s[j] === close) {
      if (escape && s[j + 1] === close) {
        j += 2;
        continue;
      }
      return { body: s.slice(bodyStart, j), end: j + 1 };
    }
    j++;
  }
  return null;
}

/** Split a CREATE TABLE DDL body into its top-level comma-separated
 *  entries. SQLite's CREATE TABLE grammar places each column or table
 *  constraint between top-level commas — `CREATE TABLE x(a INTEGER,
 *  b TEXT, CHECK (a > 0))` is two columns and one table constraint.
 *  Commas INSIDE parenthesised expressions (CHECK predicates, DEFAULT
 *  function bodies, parenthesised types like `VARCHAR(255)`) and
 *  inside string literals or quoted identifiers are NOT top-level and
 *  do not split — only a comma at paren-depth zero, outside any quoted
 *  span, ends an entry. Returns the half-open ranges `[start, end)`
 *  (start inclusive, end exclusive) in source order. The outer CREATE
 *  TABLE paren list spans `[tableParenStart, tableParenEnd)` and the
 *  function returns every entry between those parens. */
function splitCreateTableEntries(
  s: string,
  tableParenStart: number,
  tableParenEnd: number,
): Array<{ start: number; end: number }> {
  // Walk the half-open span [tableParenStart + 1, tableParenEnd) — the
  // contents of the column list excluding its surrounding parens. Depth
  // starts at 0 and only goes positive on a `(` inside the list; the
  // close paren at tableParenEnd is the column-list terminator, not a
  // depth-0 close here. A comma at depth 0 is the only top-level split.
  const entries: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let entryStart = tableParenStart + 1;
  let i = tableParenStart + 1;
  const n = tableParenEnd;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const span = readQuotedIdentBody(s, i, ch, true);
      if (span === null) break;
      i = span.end;
      continue;
    }
    if (ch === "[") {
      const span = readQuotedIdentBody(s, i, "]", false);
      if (span === null) break;
      i = span.end;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      entries.push({ start: entryStart, end: i });
      entryStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  // Final entry — the last comma-less tail spans to the closing paren.
  if (entryStart < n) entries.push({ start: entryStart, end: n });
  return entries;
}

/** Locate the open paren that opens a CREATE TABLE / CREATE VIEW / CREATE
 *  VIRTUAL TABLE column list, returning its index and the matching close
 *  paren index. Returns `null` when the statement has no `( … )` column
 *  list (e.g. a `CREATE TABLE … AS SELECT …` form whose body is a
 *  parenthesised SELECT, not a column list — those are not in the
 *  production schema). The match honors string literals, doubled-
 *  delimiter escapes for `'…'` / `"…"` / `` `…` ``, and the first-`]`
 *  close rule for `[…]`. */
function findCreateTableColumnListParens(
  s: string,
  startAt: number,
): { open: number; close: number } | null {
  const n = s.length;
  let i = startAt;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const span = readQuotedIdentBody(s, i, ch, true);
      if (span === null) return null;
      i = span.end;
      continue;
    }
    if (ch === "[") {
      const span = readQuotedIdentBody(s, i, "]", false);
      if (span === null) return null;
      i = span.end;
      continue;
    }
    if (ch === "(") {
      // Walk forward to the matching `)` at paren-depth zero, honoring
      // nested parens, strings, and quoted identifiers.
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const c = s[j]!;
        if (c === "'" || c === '"' || c === "`") {
          const span = readQuotedIdentBody(s, j, c, true);
          if (span === null) return null;
          j = span.end;
          continue;
        }
        if (c === "[") {
          const span = readQuotedIdentBody(s, j, "]", false);
          if (span === null) return null;
          j = span.end;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") depth--;
        j++;
      }
      if (depth !== 0) return null;
      return { open: i, close: j - 1 };
    }
    i++;
  }
  return null;
}

/** Locate the column declaration range (half-open `[start, end)`) inside
 *  a CREATE TABLE DDL body `s`, where the first top-level entry whose
 *  FIRST identifier token is `column` (bare, `"…"` / `` `…` `` / `[…]`
 *  quoted, with case-insensitive match) defines the column. Returns
 *  `null` when no such top-level entry exists. The first identifier
 *  token rule is what isolates the column declaration from an earlier
 *  constraint name (`UNIQUE (source_unit_id)`, `CHECK (source_unit_id
 *  > 0)`), a CHECK-body string or comment, or another column's COLLATE
 *  clause — none of those entries has `source_unit_id` as its first
 *  identifier.
 *
 *  The returned `start` is the position of the first identifier token
 *  (bare / quoted opening delimiter); the returned `end` is the entry
 *  boundary (the top-level `,` or the column-list close `)` that ends
 *  this column declaration). The inner scan starts at `start`, not at
 *  `end`, so the COLUMN name itself is also part of the declaration.
 */
function findColumnDeclaration(
  s: string,
  column: string,
): { start: number; end: number } | null {
  // Find the CREATE TABLE statement's column-list paren pair. The
  // production DDL always carries one; the fallback returns null on
  // any pathological form.
  const createPos = s.toLowerCase().indexOf("create");
  if (createPos === -1) return null;
  const parens = findCreateTableColumnListParens(s, createPos);
  if (parens === null) return null;
  const wanted = column.toLowerCase();
  for (const entry of splitCreateTableEntries(s, parens.open, parens.close)) {
    // Skip leading whitespace inside the entry.
    let k = entry.start;
    while (k < entry.end && isSqlWhitespace(s[k]!)) k++;
    if (k >= entry.end) continue;
    const ch = s[k]!;
    let head: string;
    if (ch === '"' || ch === "`") {
      const span = readQuotedIdentBody(s, k, ch, true);
      if (span === null) continue;
      head = span.body.toLowerCase();
    } else if (ch === "[") {
      const span = readQuotedIdentBody(s, k, "]", false);
      if (span === null) continue;
      head = span.body.toLowerCase();
    } else if (ch === "'") {
      // SQLite accepts a single-quoted identifier in CREATE TABLE
      // column-definition position. A string literal in this position
      // is impossible by grammar — no CHECK / DEFAULT / INSERT VALUES
      // / WHERE clause lives there — so a single-quoted span at the
      // START of a top-level CREATE TABLE column entry is a
      // single-quoted identifier. Doubled-delimiter escapes are honored
      // (same as `skipQuotedSpan` does for string literals elsewhere).
      // The first-identifier-only rule means a single-quoted span
      // ELSEWHERE in the column entry (a string default, a CHECK-body
      // literal, an inline comment disguise) is NEVER treated as a
      // column declaration here; that pattern never appears at the
      // START of a column entry in practice and the split-on-comma
      // walk below already filters to entries whose first identifier
      // is the requested column name.
      const span = readQuotedIdentBody(s, k, "'", true);
      if (span === null) continue;
      head = span.body.toLowerCase();
    } else if (/[a-z_]/i.test(ch)) {
      let j = k;
      while (j < entry.end && /[a-z0-9_]/i.test(s[j]!)) j++;
      head = s.slice(k, j).toLowerCase();
    } else {
      // Unrecognised leading token — not a column definition.
      continue;
    }
    if (head === wanted) {
      return { start: k, end: entry.end };
    }
    // Not a column declaration (the first token was UNIQUE / CHECK /
    // PRIMARY / FOREIGN / CONSTRAINT / another column name). Continue.
  }
  return null;
}

/** Locate the position just AFTER the column identifier at the start of
 *  a CREATE TABLE column declaration. Used to start the inner COLLATE
 *  scan from the type-token boundary, not from a position past the
 *  whole declaration. Returns `null` when no such declaration exists. */
function findColumnDeclarationAfterIdent(
  s: string,
  column: string,
): { afterIdent: number; end: number } | null {
  const decl = findColumnDeclaration(s, column);
  if (decl === null) return null;
  let j = decl.start;
  const ch = s[j]!;
  if (ch === '"' || ch === "`") {
    const span = readQuotedIdentBody(s, j, ch, true);
    if (span === null) return null;
    return { afterIdent: span.end, end: decl.end };
  }
  if (ch === "[") {
    const span = readQuotedIdentBody(s, j, "]", false);
    if (span === null) return null;
    return { afterIdent: span.end, end: decl.end };
  }
  if (ch === "'") {
    // Single-quoted identifier (see `findColumnDeclaration`): SQLite
    // accepts `'source_unit_id'` as the column name in CREATE TABLE
    // column-definition position. The first-identifier rule confines
    // this decoding to the START of a top-level column entry, where
    // a literal is grammatically impossible.
    const span = readQuotedIdentBody(s, j, "'", true);
    if (span === null) return null;
    return { afterIdent: span.end, end: decl.end };
  }
  while (j < decl.end && /[a-z0-9_]/i.test(s[j]!)) j++;
  return { afterIdent: j, end: decl.end };
}

/** True when the `column` declaration in `stored` DDL carries an
 *  executable column-level COLLATE clause with an effective collation
 *  other than BINARY, scanning the WHOLE column declaration (SQLite
 *  allows column constraints in any order, so a COLLATE may follow
 *  NOT NULL / DEFAULT / CHECK / REFERENCES rather than the type
 *  token). This is the SINGLE EFFECTIVE-collation verdict for every
 *  canonical column — the per-column metadata audit AND the
 *  source-unit repair lane (`sourceUnitColumnMatchesCanonical`) both
 *  route through it. The source lane's former duplicate scanner
 *  (`scanColumnDeclarationCollation`, which stopped at the first
 *  `NOT` / `DEFAULT` / `UNIQUE` / `PRIMARY` boundary token and
 *  tokenized bare identifiers with ASCII-only classes) is deleted:
 *  it HID a genuine `COLLATE <x>` placed after a boundary keyword
 *  and SPLIT a Unicode / NBSP constraint name like `ücollate` /
 *  `x\u00a0NOT` into the executing ASCII fragment, so the source
 *  column's collation verdict could fabricate a rebuild on canonical
 *  input or bless a live non-BINARY collation forever.
 *
 *  Comment-stripped text; quoted spans (`'…'` / `"…"` / `` `…` `` /
 *  `[…]`) and balanced parenthesised groups (CHECK bodies, DEFAULT
 *  expressions, parenthesised types) are skipped whole so a COLLATE
 *  keyword inside a string literal, a CHECK predicate, or a comment
 *  never counts, and the collation argument is decoded in every
 *  identifier form SQLite accepts at that position. `COLLATE BINARY`
 *  (bare or quoted, any case) is the canonical effective collation
 *  (canonical columns declare no COLLATE clause and resolve to
 *  implicit BINARY) and keeps the scan going; any other collation is
 *  behavior-changing. Bare identifiers are tokenized with SQLite's own
 *  boundaries (see `isSqlBareIdentPart` and `isSqlWhitespace`), and a
 *  `CONSTRAINT` keyword consumes its complete name token (bare —
 *  Unicode, `$`, and NBSP included, via `skipConstraintNameToken` — or
 *  quoted in any form) before the scan continues, so a constraint NAME
 *  like `ücollate` is never split into the executing ASCII fragment
 *  `collate` and a named `CONSTRAINT … COLLATE <x>` still reaches the
 *  real COLLATE clause. Unparseable residue (an unterminated quote or
 *  paren inside the declaration) fails closed. */
function columnEffectiveCollationIsNonBinary(
  stored: string,
  column: string,
): boolean {
  const s = stripSqlComments(stored);
  const decl = findColumnDeclarationAfterIdent(s, column);
  if (decl === null) return false;
  return scanColumnDeclarationCollationFull(s, decl.afterIdent, decl.end);
}

/** Scan the whole span `[start, end)` of one column declaration for a
 *  non-BINARY COLLATE clause (see `columnEffectiveCollationIsNonBinary`
 *  for the policy). `end` is the top-level entry boundary, so no later
 *  column's clause can bleed in; there is no early boundary token
 *  because SQLite parses column constraints in any order. */
function scanColumnDeclarationCollationFull(
  s: string,
  start: number,
  end: number,
): boolean {
  const n = end;
  let k = start;
  while (k < n) {
    const ch = s[k]!;
    if (isSqlWhitespace(ch)) {
      k++;
      continue;
    }
    if (ch === "(") {
      // Balanced parens for CHECK(...) / DEFAULT(...) / generated AS
      // expressions / parenthesised types. An opening paren that never
      // closes inside the declaration is unparseable residue — fail
      // closed rather than bless.
      let depth = 1;
      k++;
      while (k < n && depth > 0) {
        const c = s[k]!;
        if (c === "'" || c === '"' || c === "`") {
          const span = readQuotedIdentBody(s, k, c, true);
          if (span === null) return true;
          k = span.end;
          continue;
        }
        if (c === "[") {
          const span = readQuotedIdentBody(s, k, "]", false);
          if (span === null) return true;
          k = span.end;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") depth--;
        k++;
      }
      if (depth > 0) return true; // unclosed within the declaration
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const span = readQuotedIdentBody(s, k, ch, true);
      if (span === null) return true; // dangling quote — fail closed
      k = span.end;
      continue;
    }
    if (ch === "[") {
      const span = readQuotedIdentBody(s, k, "]", false);
      if (span === null) return true;
      k = span.end;
      continue;
    }
    // Identifier token — could be the COLLATE keyword or a CONSTRAINT
    // name introducer.
    let l = k;
    while (l < n && isSqlBareIdentPart(s[l]!)) l++;
    if (l === k) {
      // Unrecognised character — advance to avoid an infinite loop.
      k++;
      continue;
    }
    const tok = s.slice(k, l).toLowerCase();
    if (tok === "constraint") {
      // A column-constraint introducer: skip the COMPLETE name token
      // (bare — Unicode / `$` included, or quoted in any identifier
      // form) so a name like `ücollate` is never split into the
      // executing ASCII fragment `collate`. An unterminated quoted
      // name is unparseable residue — fail closed.
      const afterName = skipConstraintNameToken(s, l, n);
      if (afterName === null) return true;
      k = afterName > l ? afterName : l;
      continue;
    }
    if (tok === "collate") {
      // Read the collation name — bare or quoted in any identifier
      // form the engine accepts at this position.
      let m = l;
      while (m < n && isSqlWhitespace(s[m]!)) m++;
      let collationName = "";
      let mEnd = m;
      const mCh = s[m];
      if (mCh === "'" || mCh === '"' || mCh === "`") {
        const span = readQuotedIdentBody(s, m, mCh, true);
        if (span === null) return true;
        collationName = span.body.toLowerCase();
        mEnd = span.end;
      } else if (mCh === "[") {
        const span = readQuotedIdentBody(s, m, "]", false);
        if (span === null) return true;
        collationName = span.body.toLowerCase();
        mEnd = span.end;
      } else {
        let p = m;
        while (p < n && isSqlBareIdentPart(s[p]!)) p++;
        collationName = s.slice(m, p).toLowerCase();
        mEnd = p;
      }
      if (collationName !== "" && collationName !== "binary") {
        return true;
      }
      // COLLATE BINARY (or an argumentless keyword the engine would
      // have rejected at CREATE) — keep scanning the rest.
      k = mEnd;
      continue;
    }
    // Type, constraint keyword, or argument token — consume and keep
    // scanning (SQLite allows the COLLATE clause after NOT NULL /
    // DEFAULT / CHECK / REFERENCES in the same declaration).
    k = l;
  }
  return false;
}

/** True when the table exists in a shape that cannot serve as the strict
 *  production schema and must be rebuilt. An ABSENT table is not a
 *  repair case — `SCHEMA_DDL` creates it canonical (and the additive
 *  ALTERs add `source_unit_id` WITH its production CHECK). Inspection is
 *  EFFECTIVE: real CHECK constraints extracted comment-/string-aware
 *  from the stored DDL, never a substring match that a commented-out
 *  canonical CHECK could fool; column metadata that does not match the
 *  canonical declaration; stored spelling that does not match the
 *  canonical lowercase identifier; AND — for v2-looking tables — the
 *  exact canonical logical-identity UNIQUE autoindex (`origin = 'u'`,
 *  canonical key columns, ASC, BINARY, no expression / extra key) plus
 *  the complete canonical outgoing-FK inventory (`norma_id → norma(id)`
 *  with `ON DELETE CASCADE`, `hierarchy_node_id → hierarchy_node(id)`
 *  with `ON DELETE SET NULL`, both with the canonical `ON UPDATE NO
 *  ACTION` and `MATCH NONE`). A v2-looking table missing any of these
 *  rebuilds once; after the rebuild every later call and reopen is a
 *  byte-stable no-op. Wrong constraints (an extra UNIQUE, a composite
 *  PK masquerade, a wrong-action FK, a wrong-parent FK, …) are refused
 *  REPEATEDLY by `assertReviewedTableConstraints` until manually
 *  corrected — they never reach this rebuild check because that
 *  preflight closes them off BEFORE any schema write. */
function tableNeedsStrictRebuild(db: Db, spec: StrictV2TableSpec): boolean {
  const stored = storedObjectSql(db, "table", spec.table);
  if (stored === undefined) return false;
  // Canonicalization first: a required table/column name stored under
  // noncanonical casing is a migration change on EVERY path — including
  // the `article`/`transitory_provision` lanes below, whose CHECK-only
  // verdict would otherwise bless `Source_Unit_ID` forever.
  if (hasNoncanonicalStoredIdentifiers(db, spec)) return true;
  if (spec.table === "article" || spec.table === "transitory_provision") {
    // Canonical row identity: the `id` column must be the exact
    // `INTEGER PRIMARY KEY AUTOINCREMENT` rowid alias. Anything else
    // (no PK, PK without AUTOINCREMENT, NOT NULL on the column,
    // composite PK) refuses the migration BEFORE any schema write
    // through `assertReviewedTableConstraints` above. A v2-looking
    // table that is otherwise canonical (UNIQUE + CHECK + FKs all
    // canonical) but is missing the AUTOINCREMENT keyword on the `id`
    // declaration is a REPAIRABLE shape: the rows carry valid explicit
    // integer ids, the rebuild recreates the canonical declaration
    // through `strictArticleDdl` / `strictTransitoryDdl`, and the
    // explicit ids / FTS rowids / `sqlite_sequence` high-water mark
    // survive the staged CREATE → COPY → DROP → RENAME dance. The
    // verdict: if the column-level metadata matches but the AUTOINCREMENT
    // keyword is missing, return true so the rebuild runs once.
    // (Anything else is a non-repairable wrong row identity that the
    // preflight gate above refused without mutation.)
    if (
      idColumnIsRepairableRowIdentity(db, spec.table) &&
      !canonicalRowIdentityMatches(db, spec.table)
    ) {
      return true;
    }
    // A v1 database reaches these two through `ALTER … ADD COLUMN`, so
    // the stored text legitimately differs from a fresh build. The
    // invariant that must hold is the production CHECK on the tracked
    // column itself — an additive predecessor that carried the column
    // WITHOUT it (or with it only inside a comment) stays lax. (No
    // column at all means the ALTER above adds it with the CHECK;
    // nothing to rebuild.)
    if (!hasColumn(db, spec.table, "source_unit_id")) return false;
    // The column exists — its EFFECTIVE metadata must match the canonical
    // declaration. A `source_unit_id TEXT` (or NOT NULL, or DEFAULT, or
    // PK, or hidden/generated) silently coerces legitimate integer writes
    // away from INTEGER and the canonical CHECK then rejects them; the prior
    // CHECK-text-only verdict blessed exactly that wrong-type shape.
    if (!sourceUnitColumnMatchesCanonical(db, spec.table)) return true;
    const canonicalCheck = findCheckConstraintGroups(SOURCE_UNIT_COLUMN_CHECK)[0]!;
    if (!hasCheckConstraint(stored, canonicalCheck)) return true;
    // The table is now v2-looking (canonical column + canonical CHECK).
    // Beyond the CHECK, the v2-canonical inventory must hold exactly:
    // one canonical logical-identity UNIQUE autoindex AND the complete
    // canonical outgoing-FK inventory (CASCADE / SET NULL / NO ACTION /
    // NONE). Missing or wrong-shaped entries here would otherwise be
    // BLESSED forever — the rebuild restores them, then the next call
    // converges to false.
    if (!hasCanonicalIdentityAutoIndex(db, spec.table)) return true;
    if (!hasCanonicalForeignKeyInventory(db, spec.table)) return true;
    return false;
  }
  // source_gap / norma_front_matter are CREATE-only objects: any
  // EFFECTIVE text deviation (comments stripped, strings and non-simple
  // quoted identifiers preserved) is a lax or half-migrated predecessor.
  return normalizeSqlShapeV2(stored) !== normalizeSqlShapeV2(spec.ddl(spec.table));
}

/** True when the `id` column of `table` carries the canonical
 *  rowid-alias metadata (hidden = 0, INTEGER, pk = 1, NOT NULL = 0)
 *  AND every existing row has a non-NULL integer id that the rebuild
 *  can preserve (no row id = NULL, no row id = non-integer / 0 /
 *  duplicate that destination insertion would auto-generate or
 *  coerce into a fresh AUTOINCREMENT value). This is the REPAIRABLE
 *  miss case for `canonicalRowIdentityMatches` — a v2-looking table
 *  with valid explicit ids but missing only the AUTOINCREMENT keyword
 *  on the column declaration is rebuilt once, the canonical strict-v2
 *  DDL adds the keyword back, every row keeps its explicit id, and
 *  the rebuild converges on the next call.
 *
 *  The duplicate-id probe is the key correctness check: a predecessor
 *  whose rowid alias carries two rows with the same explicit `id`
 *  cannot be migrated into a canonical `INTEGER PRIMARY KEY
 *  AUTOINCREMENT` declaration (the COPY INTO staged fails on the
 *  PRIMARY KEY), so the rebuild would atomically roll back and the
 *  caller would see the same repair surface again. Returning false
 *  here lets the table stay canonical-on-everything-but-row-identity,
 *  and the row-identity gate above refuses the migration closed with
 *  a clear message — the caller fixes the explicit id collision and
 *  re-runs. */
/** True when the `id` column of `table` carries the exact ordinary
 *  rowid-alias metadata the canonical `id INTEGER PRIMARY KEY
 *  AUTOINCREMENT` declaration has: hidden = 0 (ordinary, NOT
 *  generated / NOT hidden), declared type `INTEGER` verbatim
 *  (after harmless trim/case normalization), NOT NULL = 0 (a
 *  `NOT NULL` on the column would force the staged COPY to coerce
 *  NULL ids into fresh auto-generated values, silently rewriting
 *  `(id=NULL, rowid=7)` into `id=1`), pk = 1 (the only situation
 *  yielding pk = 1 is `INTEGER PRIMARY KEY` — composite PKs
 *  distribute pk across multiple columns and the rowid alias is
 *  NEVER at pk = 1 there), and dflt_value = NULL (the canonical
 *  declaration has no DEFAULT — a non-NULL `dflt_value` is a
 *  different effective shape because the staged COPY would write
 *  the default for missing ids instead of the canonical
 *  AUTOINCREMENT-allocated value). This is the structural half of
 *  the row-identity verdict; the data half lives in
 *  `idColumnDataIsRepairable`. */
function idColumnHasRowidAliasShape(db: Db, table: string): boolean {
  const col = db.query<
    Row & {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }
  >(
    `SELECT name, type, "notnull", dflt_value, pk, hidden
       FROM pragma_table_xinfo(?)
      WHERE LOWER(name) = 'id'`,
    table,
  )[0];
  if (!col) return false;
  if (col.hidden !== 0) return false;
  if ((col.type ?? "").trim().toUpperCase() !== "INTEGER") return false;
  if (col.notnull !== 0) return false;
  if (col.pk !== 1) return false;
  if (col.dflt_value !== null) return false;
  return true;
}

/** True when every row of `table` carries a non-NULL SQLite integer
 *  `id` (the staged COPY preserves explicit ids) AND no duplicate (the
 *  canonical PRIMARY KEY would reject duplicates during the COPY).
 *
 *  The verdict accepts id = 0 and negative integer ids: the canonical
 *  `INTEGER PRIMARY KEY AUTOINCREMENT` declaration is a rowid alias
 *  (any 64-bit signed integer SQLite can store is a legal explicit
 *  id), and rejecting strictly-positive ids would silently auto-generate
 *  fresh values on the staged COPY for rowid positions the predecessor
 *  already owns. The "rowid alias relationship" the FTS copy relies on
 *  (the explicit `id` is the rowid) is automatic — a v2 column with
 *  valid explicit ids already preserves every rowid across the rebuild.
 *
 *  `COALESCE(..., 0)` wraps each `SUM` aggregate so an empty table —
 *  where `SUM` returns `NULL` — counts as `0` row ids in every bucket
 *  and the verdict resolves the same way it would for an explicitly
 *  empty predecessor. The previous implementation relied on the SUM
 *  bucketing alone and dropped the comparison to `NULL > 0` (which is
 *  also `NULL`), silently refusing empty tables on every migration of
 *  a fresh database whose strict rebuild lane had nothing to inspect.
 *
 *  Malformed data — NULL ids, non-integer ids (text / blob / float),
 *  duplicate explicit ids — still refuses, because each of those would
 *  either be silently rewritten by the staged COPY or atomically fail
 *  the staged COPY's PRIMARY KEY check. */
function idColumnDataIsRepairable(db: Db, table: string): boolean {
  const counts = db.query<{
    total: number;
    nullIds: number;
    nonIntIds: number;
    integerIds: number;
    distinctIntegerIds: number;
  }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN id IS NULL THEN 1 ELSE 0 END), 0) AS nullIds,
            COALESCE(SUM(CASE WHEN id IS NOT NULL AND typeof(id) <> 'integer' THEN 1 ELSE 0 END), 0) AS nonIntIds,
            COALESCE(SUM(CASE WHEN id IS NOT NULL AND typeof(id) = 'integer' THEN 1 ELSE 0 END), 0) AS integerIds,
            COUNT(DISTINCT CASE WHEN id IS NOT NULL AND typeof(id) = 'integer' THEN id END) AS distinctIntegerIds
       FROM ${quoteIdent(table)}`,
  )[0]!;
  if (counts.nullIds > 0) return false;
  if (counts.nonIntIds > 0) return false;
  // Every explicit integer id must be unique — equal counts imply no
  // duplicate id rows. (On an empty table both are 0.)
  if (counts.distinctIntegerIds !== counts.integerIds) return false;
  return true;
}

/** True when the `id` column of `table` is a safely repairable
 *  rowid alias — the structural shape matches the canonical
 *  `INTEGER PRIMARY KEY AUTOINCREMENT` rowid alias (see
 *  `idColumnHasRowidAliasShape`) AND every existing row has a
 *  non-NULL positive integer id with no duplicate. This is the
 *  REPAIRABLE miss case for `canonicalRowIdentityMatches` — a
 *  v2-looking table with valid explicit ids but missing only the
 *  AUTOINCREMENT keyword on the column declaration is rebuilt once,
 *  the canonical strict-v2 DDL adds the keyword back, every row
 *  keeps its explicit id, the `sqlite_sequence` high-water mark is
 *  preserved, and the rebuild converges on the next call.
 *
 *  The duplicate-id probe is the key correctness check: a predecessor
 *  whose rowid alias carries two rows with the same explicit `id`
 *  cannot be migrated into a canonical `INTEGER PRIMARY KEY
 *  AUTOINCREMENT` declaration (the COPY INTO staged fails on the
 *  PRIMARY KEY), so the rebuild would atomically roll back and the
 *  caller would see the same repair surface again. Returning false
 *  here lets the table stay canonical-on-everything-but-row-identity,
 *  and the row-identity gate above refuses the migration closed with
 *  a clear message — the caller fixes the explicit id collision and
 *  re-runs. */
function idColumnIsRepairableRowIdentity(db: Db, table: string): boolean {
  if (!idColumnHasRowidAliasShape(db, table)) return false;
  if (!idColumnDataIsRepairable(db, table)) return false;
  return true;
}

/** True when the tracked table carries exactly one canonical
 *  logical-identity UNIQUE autoindex (`origin = 'u'`, canonical key
 *  columns in order, every key ASC + BINARY + column name non-null,
 *  no composite PK masquerade, no extra constraint autoindex). For
 *  v2-looking tables this is the verdict that lets a successful
 *  rebuild converge to false; a missing or non-canonical identity
 *  returns true and triggers a rebuild that materialises the canonical
 *  DDL's `UNIQUE (…)` clause. */
function hasCanonicalIdentityAutoIndex(db: Db, table: string): boolean {
  const reviewed = REVIEWED_TABLE_CONSTRAINTS.find((r) => r.table === table);
  if (!reviewed) return false;
  let identitySeen = false;
  for (const a of constraintAutoIndexes(db, table)) {
    if (isCanonicalIdentityAutoIndex(a, reviewed)) {
      identitySeen = true;
      continue;
    }
    return false;
  }
  return identitySeen;
}

/** True when the tracked table's EFFECTIVE outgoing-FK inventory
 *  matches the strict v2 canonical set EXACTLY: every canonical FK is
 *  present with the canonical `from`, `parent`, `on_delete`,
 *  `on_update`, and `match` actions, AND no extra FK exists. Used by
 *  `tableNeedsStrictRebuild` to decide whether a v2-looking table is
 *  already canonical; the rebuild path materialises the canonical FKs
 *  via `strictArticleDdl` / `strictTransitoryDdl` when this returns
 *  false. Wrong-action / wrong-parent / extra FKs are closed by the
 *  pre-write `assertReviewedTableConstraints` gate — they never reach
 *  this rebuild check because they refuse BEFORE any schema write. */
function hasCanonicalForeignKeyInventory(db: Db, table: string): boolean {
  const reviewed = REVIEWED_TABLE_CONSTRAINTS.find((r) => r.table === table);
  if (!reviewed) return false;
  const actual = effectiveOutgoingForeignKeys(db, table);
  if (actual.length !== reviewed.canonicalForeignKeys.length) return false;
  for (const canonical of reviewed.canonicalForeignKeys) {
    const matches = actual.some(
      (g) =>
        g.from === canonical.from &&
        g.parent === canonical.parent &&
        g.toColumns.length <= 1 &&
        (g.toColumns.length === 0 || g.toColumns[0] === "" || g.toColumns[0] === "id") &&
        g.onDelete === canonical.onDelete &&
        g.onUpdate === canonical.onUpdate &&
        g.match === canonical.match,
    );
    if (!matches) return false;
  }
  return true;
}

/** The EFFECTIVE structural definition of one stored index, read through
 *  the PRAGMAs and sqlite_master — owning table, uniqueness, partial
 *  flag, ordered key columns, and the real WHERE predicate (comment- and
 *  string-aware; a predicate existing only in a comment reads as none).
 *  The lookup is case-insensitive (SQLite treats `IDX_ARTICLE_NORMA` and
 *  `idx_article_norma` as the same identifier); the returned `owner` is
 *  the STORED `tbl_name`, which the caller folds before comparing to the
 *  canonical owner (see `indexShapeMatches`). */
function indexStructuralShape(
  db: Db,
  name: string,
): {
  readonly owner: string;
  readonly unique: number;
  readonly partial: number;
  readonly columns: ReadonlyArray<{
    readonly name: string;
    readonly desc: number;
    readonly coll: string;
  }>;
  readonly where?: string;
} | undefined {
  const master = db.query<{ tbl_name: string; sql: string | null }>(
    `SELECT tbl_name, sql FROM sqlite_master
      WHERE type = 'index' AND LOWER(name) = LOWER(?)`,
    name,
  )[0];
  if (!master) return undefined;
  const list = db.query<{ unique: number; partial: number }>(
    `SELECT "unique", partial FROM pragma_index_list(?) WHERE LOWER(name) = LOWER(?)`,
    master.tbl_name,
    name,
  )[0];
  const cols = db.query<
    Row & {
      name: string | null;
      desc: number;
      coll: string;
      key: number;
    }
  >(
    `SELECT name, desc, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno ASC`,
    name,
  );
  const shape = {
    owner: master.tbl_name,
    unique: list?.unique ?? -1,
    partial: list?.partial ?? -1,
    // Filter to KEY columns only: `pragma_index_xinfo` returns every
    // index entry including non-key entries (column-include / covering
    // index entries show `key = 0`); the canonical inventory has none
    // of those and a mismatch on the count would otherwise mis-classify
    // any covering index as a different shape.
    columns: cols
      .filter((c) => (c.key ?? 0) === 1)
      .map((c) => ({
        name: c.name ?? "",
        desc: c.desc ?? 0,
        coll: c.coll ?? "",
      })),
    where: extractIndexWherePredicate(master.sql ?? ""),
  };
  return shape;
}

/** True when the stored structural shape equals the canonical one.
 *  Identifier comparison follows SQLite's own case-insensitive semantics
 *  on BOTH the owning table and the key columns: `pragma_index_xinfo`
 *  returns each key column with the case the TABLE stored it under
 *  (`Norma_ID` stays `Norma_ID`), so an exact column comparison declared
 *  a structurally correct index lax on every open and dropped/recreated
 *  it forever — the migration could never converge to false. Canonical
 *  stored spelling of the required v2 names is a separate concern, owned
 *  by `hasNoncanonicalStoredIdentifiers` + the canonical rebuild.
 *
 *  `pragma_index_xinfo` exposes the EFFECTIVE shape — direction
 *  (`desc`: 0 = ASC, 1 = DESC) and declared collation (`coll`:
 *  `BINARY`, `NOCASE`, `RTRIM`, …) — that the prior `pragma_index_info`
 *  call never read. A canonical-named index over `source_unit_id DESC`
 *  or `source_unit_id COLLATE NOCASE` is NOT canonical by shape even
 *  when its columns and uniqueness match: the partial uniqueness rule
 *  depends on the BINARY-comparable ascending integer value, not on a
 *  case-folded string or a reversed scan. Such an index accepted
 *  duplicates the canonical partial unique index would have rejected,
 *  and silently preserved them until something downstream tried to
 *  look up by the canonical key. The `key = 1` filter above excludes
 *  any column-include / covering-index entries, which SQLite only
 *  creates for explicit `INDEXED BY` covering indexes the canonical
 *  inventory never declares. */
function indexShapeMatches(
  shape: CanonicalIndexShape,
  actual:
    | {
        readonly owner: string;
        readonly unique: number;
        readonly partial: number;
        readonly columns: ReadonlyArray<{
          readonly name: string;
          readonly desc: number;
          readonly coll: string;
        }>;
        readonly where?: string;
      }
    | undefined,
): boolean {
  if (!actual) return false;
  if (actual.owner.toLowerCase() !== shape.table.toLowerCase()) return false;
  if (actual.unique !== shape.unique) return false;
  if (actual.partial !== shape.partial) return false;
  if (
    actual.columns.length !== shape.columns.length ||
    actual.columns.some((c, i) => {
      const expected = shape.columns[i] ?? "";
      if (c.name.toLowerCase() !== expected.toLowerCase()) return true;
      // ASC only: a DESC key scans the opposite order, and the partial
      // uniqueness rule depends on exact BINARY-comparable equality.
      if (c.desc !== 0) return true;
      // pragma_index_xinfo returns "BINARY" when the column has no
      // explicit COLLATE clause (which the INTEGER family resolves to
      // BINARY implicitly); an explicit non-BINARY collation is a
      // different effective shape.
      if (c.coll !== "BINARY") return true;
      return false;
    })
  ) {
    return false;
  }
  const expectedWhere = shape.where
    ? normalizeSqlShapeV2(`WHERE ${shape.where}`)
    : undefined;
  return actual.where === expectedWhere;
}

/** Canonical indexes that are absent or stored with a non-canonical
 *  EFFECTIVE shape and must be (re)created. */
function collectIndexRepairs(
  db: Db,
): Array<{ readonly name: string; readonly ddl: string; readonly present: boolean }> {
  const repairs: Array<{
    readonly name: string;
    readonly ddl: string;
    readonly present: boolean;
  }> = [];
  for (const shape of CANONICAL_INDEX_SHAPES) {
    const actual = indexStructuralShape(db, shape.name);
    if (!actual) {
      repairs.push({ name: shape.name, ddl: shape.ddl, present: false });
    } else if (!indexShapeMatches(shape, actual)) {
      repairs.push({ name: shape.name, ddl: shape.ddl, present: true });
    }
  }
  return repairs;
}

/** The current AUTOINCREMENT high-water mark for `table`, if any.
 *  `sqlite_sequence.name` stores the case the predecessor CREATE used
 *  (`Article` stays `Article`), so a case-insensitive lookup is the only
 *  way to find the high-water mark of a case-variant predecessor. */
function tableSequence(db: Db, table: string): number | undefined {
  if (!tableExists(db, "sqlite_sequence")) return undefined;
  return db.query<{ seq: number }>(
    `SELECT seq FROM sqlite_sequence WHERE LOWER(name) = LOWER(?)`,
    table,
  )[0]?.seq;
}

/** Double-quote an identifier for SQL text, escaping embedded quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Schema-qualify an identifier as `main.<ident>` for SQL text. SQLite
 *  resolves `main.<ident>` against the main schema explicitly, which
 *  bypasses the "TEMP shadows main" resolution rule on every DDL/DML
 *  the strict-rebuild lane issues. The TEMP preflight above
 *  (`assertNoTempSchemaObjects`) is the primary guard; this helper is
 *  the belt-and-suspenders alignment that keeps unqualified TEMP
 *  lookups from redirecting a qualified statement if the preflight is
 *  ever bypassed for an index-only or no-op lane. */
function quoteMainIdent(name: string): string {
  return `main.${quoteIdent(name)}`;
}

/**
 * ASCII-only case fold: A–Z → a–z, every other code point verbatim.
 *
 * This is the fold SQLite 3.33 applies to IDENTIFIER comparison
 * (built-in keyword / identifier lookups, the `LOWER(name)` probes
 * against `sqlite_master`, the trigger/index/table resolution against
 * the case-insensitive identifier namespace). JavaScript's
 * `String.prototype.toLowerCase()` does Unicode case mapping — so
 * `Ä` (U+00C4 LATIN CAPITAL LETTER A WITH DIAERESIS) folds to `ä`
 * (U+00E4) while SQLite's identifier namespace treats them as two
 * distinct identifiers. Two distinct main-schema objects can therefore
 * collapse in the migration's in-memory set when dedup keys are
 * computed with `toLowerCase()`, silently dropping one of them and
 * recreating only the other after rebuild — a real Unicode collision
 * (`Ä_idx` vs `ä_idx`, `Ä_tr` vs `ä_tr`) on the captured dependents is
 * exactly the failure the work order pins.
 *
 * The fold is one byte per code unit over the ASCII range and a
 * no-op past it, so two distinct non-ASCII identifiers always compare
 * unequal even though they happen to lowercase-fold to the same JS
 * string. Pairs like `Ä_idx` / `ä_idx` therefore both survive the
 * capture-side dedup, the rebuild drops each by its exact name, and
 * the recreation step rebuilds both from their exact stored SQL.
 */
function asciiFold(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : name[i];
  }
  return out;
}

/** One foreign-key constraint declared by some OTHER table and pointing
 *  AT a rebuildable table. Captured from `pragma_foreign_key_list`, which
 *  is where SQLite exposes the EFFECTIVE inbound reference (parent name,
 *  column pairs, and the ON DELETE/UPDATE actions), regardless of how the
 *  child DDL was spelled. */
interface InboundForeignKey {
  readonly child: string;
  readonly fromColumns: string[];
  /** Empty when the child omitted the parent column list (implicit PK). */
  readonly toColumns: string[];
  readonly onDelete: string;
}

/** Every inbound FK reference from a live table to `parent`. */
function inboundForeignKeysTo(db: Db, parent: string): InboundForeignKey[] {
  const refs: InboundForeignKey[] = [];
  const tables = db.query<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const entry of tables) {
    if (entry.name.startsWith("__v2strict_")) continue;
    const rows = db.query<
      Row & {
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string | null;
        on_delete: string;
      }
    >(`SELECT * FROM pragma_foreign_key_list(?) ORDER BY id ASC, seq ASC`, entry.name);
    const byId = new Map<number, InboundForeignKey>();
    for (const row of rows) {
      if (row.table.toLowerCase() !== parent.toLowerCase()) continue;
      let ref = byId.get(row.id);
      if (!ref) {
        ref = { child: entry.name, fromColumns: [], toColumns: [], onDelete: row.on_delete };
        byId.set(row.id, ref);
        refs.push(ref);
      }
      ref.fromColumns.push(row.from);
      if (row.to !== null) ref.toColumns.push(row.to);
    }
  }
  return refs;
}

/** How many rows of the child side of `ref` currently reference a row of
 *  the rebuildable table — the rows a DROP of the parent's content would
 *  act on. The probe itself failing (unresolvable columns) is handled by
 *  the caller as "cannot prove safety". A child that omitted the parent
 *  column list references the key column implicitly. */
function countDependentRows(
  db: Db,
  spec: StrictV2TableSpec,
  ref: InboundForeignKey,
): number {
  const parentCols = ref.toColumns.length > 0 ? ref.toColumns : [spec.keyColumn];
  if (ref.fromColumns.length !== parentCols.length) {
    throw new Error(
      `inbound foreign key ${ref.child}(${ref.fromColumns.join(", ")}) ` +
        `REFERENCES ${spec.table}(${parentCols.join(", ")}) has mismatched column arity`,
    );
  }
  const fromList = ref.fromColumns.map(quoteIdent).join(", ");
  const toList = parentCols.map(quoteIdent).join(", ");
  const key =
    ref.fromColumns.length === 1
      ? `${fromList} IN (SELECT ${toList} FROM ${quoteIdent(spec.table)})`
      : `(${fromList}) IN (SELECT ${toList} FROM ${quoteIdent(spec.table)})`;
  const rows = db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${quoteIdent(ref.child)} WHERE ${key}`,
  );
  return (rows[0]?.n as number) ?? 0;
}

/**
 * Finding 1 — the strict rebuild of `spec.table` moves its content into a
 * replacement table and DROPs the predecessor. With `foreign_keys = ON`
 * (which this migration NEVER disables — no PRAGMA state is toggled at
 * all) a DROP performs an implicit DELETE FROM that fires the configured
 * ON DELETE CASCADE / SET NULL actions on every inbound dependent row.
 * There is no SQLite lane (≥3.26 always rewrites child FK clauses onto
 * renames; foreign_keys cannot be toggled inside a transaction, and
 * suppression is forbidden anyway) that survives a parent swap without
 * mutating matching children, so the migration must PROVE the children
 * are not touched before it writes anything:
 *
 *   - every inbound reference must point at the table's key column
 *     (the only parent key the canonical rebuild is guaranteed to keep
 *     byte-identical, row for row, id for id);
 *   - zero pre-existing FK violations on the inbound child (a dangling
 *     non-NULL row whose value has no matching parent — finding 2: a
 *     previous version of this gate used `IN (SELECT … FROM parent)`
 *     which only counted MATCHING children, so a dangling row was
 *     blessed, the migration ran, and `PRAGMA foreign_key_check`
 *     afterwards still reported the violation);
 *   - zero child rows may currently reference a parent row — then the
 *     implicit DELETE acts on nothing, the child's FK clause keeps
 *     resolving to the canonical replacement by name, and the dependent
 *     data AND the reference semantics survive (the generic preservation
 *     lane);
 *   - anything else (a matching dependent row, a pre-existing violation,
 *     an unresolvable probe) is an inbound reference that cannot be
 *     migrated without cascading, nulling, or silently mutating the
 *     child → fail closed BEFORE any destructive write; the single
 *     migration savepoint then restores the complete pre-call schema
 *     and data.
 */
function assertRebuildPreservesDependentRows(
  db: Db,
  spec: StrictV2TableSpec,
): void {
  for (const ref of inboundForeignKeysTo(db, spec.table)) {
    const refuse = (why: string): Error =>
      new Error(
        `migrateCorpusSchema: refusing strict rebuild of ${spec.table} — inbound foreign key ` +
          `${ref.child}(${ref.fromColumns.join(", ")}) REFERENCES ${spec.table}(...) ` +
          `(${ref.onDelete || "NO ACTION"}) cannot be migrated without cascading/nulling/mutating ` +
          `dependent rows: ${why}`,
      );
    let parentCols = ref.toColumns;
    if (parentCols.length === 0) parentCols = [spec.keyColumn];
    if (
      parentCols.length !== ref.fromColumns.length ||
      parentCols.length !== 1 ||
      parentCols[0]!.toLowerCase() !== spec.keyColumn.toLowerCase()
    ) {
      // The canonical table guarantees uniqueness on its KEY column only.
      // Any other parent key leans on a unique index that lives on the
      // predecessor and is destroyed by the rebuild — the reference's
      // enforcement could not survive even with zero dependent rows.
      throw refuse("parent key is not the rebuilt table's canonical key column");
    }
    // Finding 2 — a pre-existing FK violation on the inbound child is a
    // verdict on the untouched database. `countDependentRows` only counts
    // child rows whose key MATCHES a current parent, so a dangling
    // non-NULL child (its key has no matching parent) used to be treated
    // as safe, the migration ran, and the post-check still surfaced the
    // same violation. Probe SQLite directly here so the dangling row
    // refuses the migration closed BEFORE any destructive write.
    const priorViolations = db.query<Row>(
      `PRAGMA foreign_key_check(${quoteIdent(ref.child)})`,
    );
    if (priorViolations.length > 0) {
      throw refuse(
        `existing foreign-key violation in ${ref.child}: ${JSON.stringify(priorViolations)}`,
      );
    }
    let dependants: number;
    try {
      dependants = countDependentRows(db, spec, ref);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw refuse(detail);
    }
    if (dependants > 0) {
      throw refuse(`${dependants} dependent row(s) live in ${ref.child}`);
    }
  }
}

/** A comparable fingerprint of the inbound references' effective state:
 *  the child-side FK clause metadata (parent, column pairs, delete action)
 *  plus each child's row count. Captured before and re-verified after a
 *  rebuild so any surprise mutation of a dependent fails the migration
 *  closed inside the savepoint instead of shipping data loss. */
function inboundReferenceState(db: Db, spec: StrictV2TableSpec): string {
  const state = inboundForeignKeysTo(db, spec.table).map((ref) => ({
    child: ref.child,
    from: ref.fromColumns,
    to: ref.toColumns,
    onDelete: ref.onDelete,
    rows: db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(ref.child)}`,
    )[0]?.n ?? 0,
  }));
  return JSON.stringify(state.sort((a, b) => (a.child < b.child ? -1 : 1)));
}

/** Refuse to touch a database that carries objects from this repair's
 *  staging namespace — a `__v2strict_…` name is owned by the migration,
 *  and a pre-existing one means the shape underneath is not what this
 *  repair can reason about. Checked BEFORE any write. */
function assertNoStagingResidue(db: Db): void {
  const found = db.query<{ type: string; name: string }>(
    `SELECT type, name FROM sqlite_master
      WHERE name LIKE '\\_\\_v2strict\\_%' ESCAPE '\\'`,
  );
  if (found.length > 0) {
    const first = found[0]!;
    throw new Error(
      `migrateCorpusSchema: unexpected ${first.type} ${first.name} — refusing to migrate a database ` +
        `that carries objects in the strict-rebuild staging namespace`,
    );
  }
}

/**
 * Fail-closed whole-DB preflight against TEMP-schema objects. UNCONDITIONAL:
 * fires before the FIRST mutation on EVERY path (fresh / additive /
 * index-only / FTS / rebuild / no-op). Conservative by design: any row in
 * `sqlite_temp_master` (a TEMP table, index, view, or trigger) refuses the
 * migration with a fixed content-safe message — the message never includes
 * the TEMP object name, type, or owner, so the refusal text cannot leak
 * arbitrary content the migration discovered.
 *
 * SQLite's resolution rule is "TEMP shadows main when an identifier is
 * unqualified". Every DDL/DML the migration issues is unqualified (e.g.
 * `article`, `__v2strict_article`, `DROP TABLE …`, `ALTER TABLE …`,
 * `CREATE INDEX …`, `INSERT INTO article_fts …`) — even on additive /
 * index-only / FTS-only / no-op paths, because the canonical DDL names are
 * unqualified and the `IF NOT EXISTS` guard evaluates against main ALONE,
 * leaving the read/write/drop resolution of any same-named TEMP object
 * still shadowing main. The four concrete consequences the work order pins
 * apply on every path:
 *
 *   1. a TEMP `__v2strict_article` shadows the staging carrier and the
 *      rebuild's `INSERT INTO __v2strict_article SELECT … FROM article`
 *      copies rows from the TEMP predecessor (or, if no TEMP carrier
 *      yet exists, the main table is deleted by `DROP TABLE article`
 *      and the TEMP carrier alone survives export);
 *   2. a same-named TEMP trigger/index is dropped by an unqualified
 *      `DROP TRIGGER …` / `DROP INDEX …` issued against a main-schema
 *      object that exists;
 *   3. a TEMP trigger attached to a main target that the rebuild
 *      replaces is implicitly dropped when the main target disappears,
 *      because SQLite resolves the attachment by name against the
 *      shadowing precedence;
 *   4. on the FTS ghost path, `rebuildArticleFts` reads
 *      `SELECT id, number, body FROM article` and `DROP TABLE
 *      article_fts`; a TEMP `article` (or TEMP `article_fts`) shadows
 *      main and the rebuild copies rows from the TEMP predecessor into
 *      a fresh main FTS — the canonical ghost-cleanup loop never
 *      rebuilds main FTS from a TEMP carrier.
 *
 * The "no-op" path is the most insidious of all: a no-op that creates
 * any object (e.g. a pending canonical index in the additive branch)
 * while a TEMP object of the same name exists has done the migration
 * a mutation it does not report. Refusing unconditionally makes the
 * pre-write promise true on every path.
 *
 * Parsing TEMP dependencies is out of scope and unsafe: TEMP objects
 * can reference main tables, views, triggers, and other TEMP objects
 * with the full SQLite grammar. Conservative closed-by-default is the
 * safe answer; the work order pins it explicitly.
 *
 * Read-only (`SELECT … FROM sqlite_temp_master` reads the engine's
 * own shadow catalog without toggling any PRAGMA) and a verdict on the
 * untouched database. Runs inside the migration's outer savepoint so
 * a refusal unwinds to the exact pre-call state — main AND TEMP.
 */
function assertNoTempSchemaObjects(db: Db): void {
  const found = db.query<{ type: string; name: string; tbl_name: string }>(
    `SELECT type, name, tbl_name FROM sqlite_temp_master`,
  );
  if (found.length > 0) {
    // Content-safe fixed message: NEVER include the TEMP object name,
    // type, or owner (the work order pins the message to be content-
    // safe so the refusal text cannot leak arbitrary content).
    throw new Error(
      `migrateCorpusSchema: refusing migration — TEMP-schema objects are present and ` +
        `could shadow or be dropped by the migration's unqualified DDL/DML. SQLite's resolution ` +
        `rule lets TEMP shadow main on unqualified lookups. Drop or rename TEMP schema objects ` +
        `before running this migration (disconnecting any open TEMP triggers first).`,
    );
  }
}

/**
 * Read-only whole-database FK preflight. `PRAGMA foreign_key_check` (no
 * table argument) walks every row of every table and reports every
 * dangling reference; `PRAGMA foreign_key_check(<table>)` only checks
 * one table. The per-rebuildable-table inbound probe below catches a
 * pre-existing violation on the inbound children of a table this run
 * rebuilds — but a true-v1 table that does NOT need rebuilding carries
 * an inbound child with a dangling row, the migration returns true,
 * and the same violation still surfaces afterwards. This gate refuses
 * the migration closed BEFORE any schema mutation when ANY database-
 * wide violation is present. Read-only (no PRAGMA state is toggled),
 * so it remains valid inside a caller-owned transaction and as the
 * first statement of a savepoint.
 */
function assertNoDatabaseForeignKeyViolations(db: Db): void {
  const violations = db.query<Row>(`PRAGMA foreign_key_check`);
  if (violations.length > 0) {
    throw new Error(
      `migrateCorpusSchema: refusing migration — pre-existing foreign-key violation(s): ${JSON.stringify(violations)}`,
    );
  }
}

/**
 * Read-only whole-database canonical-index ownership preflight, run
 * BEFORE the first write on EVERY path (fresh / additive / rebuild /
 * index-only / no-op).
 *
 * `collectUnsupportedDependents` binds a canonical index name to its
 * owning table, but it only runs for a table that actually needs a
 * strict rebuild. When no table needs rebuilding — an otherwise strict
 * database carrying `idx_hier_norma ON article(body)` — the structural
 * index audit was the first thing to see that name: it read the wrong
 * owner as a shape mismatch, DROPped the user's index, and re-created
 * the canonical index on `hierarchy_node`. That is silent destruction of
 * a user object under a name collision this migration cannot reason
 * about, so it must be a verdict on the untouched database instead.
 *
 * Ownership is compared case-insensitively on both sides: a case variant
 * of a canonical name on its CORRECT owner is legitimate (SQLite treats
 * `IDX_ARTICLE_NORMA` and `idx_article_norma` as one identifier) and
 * proceeds into the structural audit/repair lane; only a canonical name
 * attached to the wrong table fails closed — without moving, dropping,
 * or re-creating anything.
 */
function assertCanonicalIndexOwnership(db: Db): void {
  for (const entry of db.query<{ name: string; tbl_name: string }>(
    `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'`,
  )) {
    const canonical = CANONICAL_INDEX_BY_NAME.get(entry.name.toLowerCase());
    if (!canonical) continue;
    if (entry.tbl_name.toLowerCase() === canonical.table.toLowerCase()) continue;
    throw new Error(
      `migrateCorpusSchema: refusing migration — canonical index ${entry.name} is attached to ` +
        `${entry.tbl_name} but belongs to ${canonical.table}; this migration owns that name and ` +
        `cannot move, drop, or re-create it on a foreign owner — remove or rename the colliding ` +
        `index manually before this repair can run`,
    );
  }
}

/** True when `name` is an autoindex SQLite creates for a UNIQUE/PRIMARY KEY
 *  constraint (e.g. `sqlite_autoindex_article_1`). Autoindexes are NOT
 *  disposable implementation detail: every `sqlite_autoindex_*` entry is the
 *  physical form of a user-authored inline/table UNIQUE or PRIMARY KEY
 *  constraint. The canonical strict-v2 DDL for the tracked tables carries
 *  EXACTLY the logical-identity UNIQUE (one autoindex) — so `collectIndexRepairs`
 *  and the snapshot/recreate lane may treat a same-named USER index as the
 *  migration's to manage, but an UNEXPECTED constraint autoindex must never be
 *  silently dropped by a rebuild. `assertReviewedTableConstraints` reads this
 *  inventory and fails closed on any unsupported extra BEFORE the first write;
 *  once that gate has passed, the only autoindexes left are the reviewed
 *  logical-identity ones, which are SQLite's (they drop and re-form with the
 *  parent table), so the snapshot/recreate lane must not mistake them for user
 *  objects. */
function isSqliteAutoIndex(name: string): boolean {
  return name.startsWith("sqlite_autoindex_");
}

/** The EFFECTIVE constraint autoindex inventory of one table, read
 *  through the PRAGMAs (`origin`, ordered key columns, direction, and
 *  declared collation). `pragma_index_xinfo` returns every index entry
 *  in column order; `key = 1` filters to the actual key columns (a
 *  covering index's `key = 0` entries are not part of the shape). The
 *  ordinary `id INTEGER PRIMARY KEY AUTOINCREMENT` rowid is NOT in
 *  this list (SQLite stores it as the table's own rowid, no autoindex);
 *  a composite `PRIMARY KEY (a, b)` shows up here with `origin = 'pk'`,
 *  distinct from `origin = 'u'` UNIQUE constraints, and the canonical
 *  identity must specifically have `origin = 'u'` so a composite PK
 *  masquerading as the identity UNIQUE is detected. SQLite refuses
 *  expressions in PRIMARY KEY / UNIQUE constraints inside CREATE TABLE,
 *  so a NULL `name` on a key column is impossible — the canonical
 *  shape only needs the `name IS NOT NULL` guard for completeness. */
interface ConstraintAutoIndex {
  readonly name: string;
  readonly origin: string;
  readonly keyColumns: ReadonlyArray<{
    readonly name: string;
    readonly desc: number;
    readonly coll: string;
  }>;
}

function constraintAutoIndexes(db: Db, table: string): ConstraintAutoIndex[] {
  const out: ConstraintAutoIndex[] = [];
  const indexes = db.query<{ name: string; origin: string }>(
    `SELECT name, origin FROM pragma_index_list(?)`,
    table,
  );
  for (const a of indexes) {
    const isConstraint =
      a.origin === "u" || a.origin === "pk" || isSqliteAutoIndex(a.name);
    if (!isConstraint) continue;
    const cols = db
      .query<
        Row & {
          name: string | null;
          desc: number;
          coll: string;
          key: number;
        }
      >(
        `SELECT name, desc, coll, key FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno ASC`,
        a.name,
      )
      .map((c) => ({
        name: c.name ?? "",
        desc: c.desc ?? 0,
        coll: c.coll ?? "",
      }));
    out.push({ name: a.name, origin: a.origin, keyColumns: cols });
  }
  return out;
}

/** True when the stored constraint autoindex matches the canonical
 *  logical-identity shape: `origin = 'u'`, exact key columns in order,
 *  ASC direction on every key, BINARY collation on every key, and no
 *  expression / extra key (every key column has a non-null column
 *  name). The `id INTEGER PRIMARY KEY AUTOINCREMENT` rowid carries no
 *  autoindex and is therefore absent from this check — SQLite's
 *  ordinary rowid identity is canonical by definition, not by
 *  constraint. A composite PRIMARY KEY with the same key columns is
 *  REJECTED because its `origin` is `'pk'`, not `'u'`: a composite PK
 *  masquerade must never be blessed as the logical-identity UNIQUE
 *  (a subsequent strict rebuild would silently DROP it because the
 *  canonical strict-v2 DDL only stores the canonical UNIQUE). */
function isCanonicalIdentityAutoIndex(
  autoindex: ConstraintAutoIndex,
  reviewed: ReviewedTableConstraints,
): boolean {
  if (autoindex.origin !== "u") return false;
  if (autoindex.keyColumns.length !== reviewed.identityColumns.length) return false;
  for (let i = 0; i < autoindex.keyColumns.length; i++) {
    const actual = autoindex.keyColumns[i]!;
    const expected = reviewed.identityColumns[i]!;
    if (actual.name.toLowerCase() !== expected) return false;
    // ASC only — a DESC key scans the opposite order and the partial
    // uniqueness rule depends on exact BINARY-comparable equality.
    if (actual.desc !== 0) return false;
    // BINARY collation only (canonical INTEGER resolves to BINARY
    // implicitly; an explicit non-BINARY collation is a different
    // effective shape).
    if (actual.coll !== "BINARY") return false;
    // No expression keys: SQLite refuses expressions in PRIMARY KEY /
    // UNIQUE constraints in CREATE TABLE, but the guard documents the
    // invariant and protects against a future SQLite change.
    if (actual.name === "") return false;
  }
  return true;
}

/** Skip ONE constraint-name token starting at `pos` (leading whitespace
 *  already skipped by the caller). The name may be a bare identifier
 *  (which SQLite allows to contain `$`, any non-ASCII character — NBSP
 *  included — e.g. `a$b`, `ünïq$1`, `x\u00a0NOT`) or a quoted identifier
 *  in any of the `"…"` / `` `…` `` / `'…'` / `[…]` forms the engine
 *  accepts in `CONSTRAINT <name>` position. Returns the index just after
 *  the name, or `pos` when there is no name to consume (the next char is
 *  whitespace / a delimiter), or `null` when a quoted span opens but
 *  never closes (a malformed statement the caller stops on). Unlike
 *  `consumeFkClauseName` this treats ANY run of non-delimiter characters
 *  as a bare name — with SQLite's ASCII whitespace class, not JS
 *  `/\s/` — so a Unicode / NBSP constraint name is skipped whole rather
 *  than halting the scan and executing the name's ASCII tail as a
 *  keyword. */
function skipConstraintNameToken(
  s: string,
  pos: number,
  end: number,
): number | null {
  let i = pos;
  while (i < end && isSqlWhitespace(s[i]!)) i++;
  if (i >= end) return i;
  const ch = s[i]!;
  if (ch === "'" || ch === '"' || ch === "`") {
    const span = readQuotedIdentBody(s, i, ch, true);
    return span === null ? null : span.end;
  }
  if (ch === "[") {
    const span = readQuotedIdentBody(s, i, "]", false);
    return span === null ? null : span.end;
  }
  // A bare name: any run of characters that are not SQLite whitespace, a
  // comma, a paren, a bracket, or a quote delimiter. This covers `$`,
  // digits, and non-ASCII characters (NBSP included) that SQLite accepts
  // inside an unquoted identifier — JS `/\s/` must NOT be used here or a
  // name like `x\u00a0NOT` would be split at the NBSP and its ASCII tail
  // executed as a fabricated keyword.
  let j = i;
  while (
    j < end &&
    !/[ \t\r\n\f,()[\]"'`]/.test(s[j]!)
  )
    j++;
  return j;
}

/** Count the top-level UNIQUE constraint DECLARATIONS in the stored
 *  CREATE TABLE DDL. A declaration is a column-list entry that, after an
 *  optional `CONSTRAINT <name>` prefix, has `UNIQUE` as its leading
 *  keyword — a table-level `UNIQUE (…)` / `CONSTRAINT … UNIQUE (…)`. The
 *  canonical strict-v2 DDL (`strictArticleDdl` / `strictTransitoryDdl`)
 *  declares the logical-identity UNIQUE exactly once, so a count above one
 *  is a duplicate the canonical DDL cannot reproduce and a rebuild would
 *  silently reduce.
 *
 *  This replaces the earlier signature matcher (which compared each
 *  `UNIQUE (…)` key list against the canonical identity column list). That
 *  parser kept silently MISSING duplicates whose second declaration used a
 *  single-/double-/backtick-/bracket-quoted, Unicode, or `$` constraint
 *  name, or a semantically equivalent `ASC` / `COLLATE BINARY` key
 *  spelling — SQLite coalesces every such declaration into the SAME single
 *  `sqlite_autoindex_*` entry, so the engine-side `pragma_index_list` audit
 *  cannot see them either. Counting bare `UNIQUE` KEYWORDS at the top-level
 *  grammar sidesteps the whole signature-spelling problem: any second
 *  declaration — whatever its name quoting or key spelling — contributes a
 *  second keyword and refuses. UNIQUE text that lives only in a comment,
 *  a string literal, or a quoted identifier is NOT a bare keyword and is
 *  never counted (comments are stripped; quoted spans are skipped). A
 *  column-level inline `col … UNIQUE` is NOT a top-level declaration either
 *  — its entry leads with the column name — and that extra is left to the
 *  engine-side autoindex audit (it produces its own non-canonical
 *  `origin = 'u'` index). Zero declarations stays repairable (the rebuild's
 *  canonical DDL adds the identity); exactly one still needs the existing
 *  PRAGMA effective-shape check to confirm the column set / direction /
 *  collation. */
function countTopLevelUniqueDeclarations(stored: string): number {
  const s = stripSqlComments(stored);
  const createPos = s.toLowerCase().indexOf("create");
  if (createPos === -1) return 0;
  const parens = findCreateTableColumnListParens(s, createPos);
  if (parens === null) return 0;
  let count = 0;
  for (const entry of splitCreateTableEntries(s, parens.open, parens.close)) {
    let i = entry.start;
    while (i < entry.end && isSqlWhitespace(s[i]!)) i++;
    if (i >= entry.end) continue;
    // Optional `CONSTRAINT <name>` prefix — consume the keyword and the
    // name (any quoting form) so the identity keyword can be read next.
    if (/[a-z_]/i.test(s[i]!)) {
      let j = i;
      while (j < entry.end && /[a-z0-9_$]/i.test(s[j]!)) j++;
      if (s.slice(i, j).toLowerCase() === "constraint") {
        const afterName = skipConstraintNameToken(s, j, entry.end);
        if (afterName === null) continue; // malformed quoted name
        i = afterName;
        while (i < entry.end && isSqlWhitespace(s[i]!)) i++;
      }
    }
    // The leading keyword of the (possibly prefixed) entry — must be the
    // bare ASCII `UNIQUE` constraint keyword for this to be a declaration.
    if (i < entry.end && /[a-z_]/i.test(s[i]!)) {
      let j = i;
      while (j < entry.end && /[a-z0-9_$]/i.test(s[j]!)) j++;
      if (s.slice(i, j).toLowerCase() === "unique") count++;
    }
  }
  return count;
}

/** The EFFECTIVE outgoing foreign-key inventory of one table, in the
 *  shape the audit compares to the reviewed set. `from` is always
 *  lowercase; an empty `toColumns` array means the FK omitted the
 *  parent column list and resolves to the parent's rowid (canonical).
 *  Actions come straight from `pragma_foreign_key_list`, which reports
 *  the EFFECTIVE action including the engine defaults (a missing
 *  `ON DELETE` clause reads as `NO ACTION`). */
interface EffectiveOutgoingForeignKey {
  readonly from: string;
  readonly parent: string;
  readonly toColumns: ReadonlyArray<string>;
  readonly onDelete: ReviewedForeignKey["onDelete"];
  readonly onUpdate: ReviewedForeignKey["onUpdate"];
  readonly match: ReviewedForeignKey["match"];
}

function effectiveOutgoingForeignKeys(db: Db, table: string): EffectiveOutgoingForeignKey[] {
  const rows = db.query<
    Row & {
      id: number;
      table: string;
      from: string | null;
      to: string | null;
      on_delete: string;
      on_update: string;
      match: string;
    }
  >(
    `SELECT id, "table", "from", "to", on_delete, on_update, match
       FROM pragma_foreign_key_list(?) ORDER BY id ASC, seq ASC`,
    table,
  );
  const byId = new Map<
    number,
    {
      from: string;
      parent: string;
      tos: (string | null)[];
      onDelete: ReviewedForeignKey["onDelete"];
      onUpdate: ReviewedForeignKey["onUpdate"];
      match: ReviewedForeignKey["match"];
    }
  >();
  for (const row of rows) {
    let g = byId.get(row.id);
    if (!g) {
      g = {
        from: (row.from ?? "").toLowerCase(),
        parent: row.table,
        tos: [],
        onDelete: row.on_delete as ReviewedForeignKey["onDelete"],
        onUpdate: row.on_update as ReviewedForeignKey["onUpdate"],
        match: row.match as ReviewedForeignKey["match"],
      };
      byId.set(row.id, g);
    }
    g.tos.push(row.to == null ? null : row.to.toLowerCase());
  }
  const out: EffectiveOutgoingForeignKey[] = [];
  for (const g of byId.values()) {
    out.push({
      from: g.from,
      parent: g.parent.toLowerCase(),
      toColumns: g.tos.map((t) => (t == null ? "" : t)),
      onDelete: g.onDelete,
      onUpdate: g.onUpdate,
      match: g.match,
    });
  }
  return out;
}

/** True when `actual` exactly matches one of the reviewed FK shapes
 *  for `reviewed` (from, parent, onDelete, onUpdate, match). The
 *  referenced parent columns must resolve to the parent's rowid
 *  (omitted parent column list or explicit `id`). A composite FK
 *  (more than one `from` column) is NEVER reviewed; a wrong parent
 *  column list, a wrong parent table, or any action not in the
 *  reviewed set is NEVER reviewed. */
function outgoingForeignKeyIsReviewed(
  reviewed: ReviewedTableConstraints,
  actual: EffectiveOutgoingForeignKey,
): boolean {
  if (actual.toColumns.length !== 1) return false;
  if (actual.toColumns[0] !== "" && actual.toColumns[0] !== "id") return false;
  return reviewed.reviewedForeignKeys.some(
    (fk) =>
      fk.from === actual.from &&
      fk.parent === actual.parent &&
      fk.onDelete === actual.onDelete &&
      fk.onUpdate === actual.onUpdate &&
      fk.match === actual.match,
  );
}

/** Canonical row identity declaration: `id INTEGER PRIMARY KEY
 *  AUTOINCREMENT` — exactly the canonical SQLite rowid alias that
 *  guarantees a non-reusable, monotonically-increasing, never-colliding
 *  integer id. Read from the canonical DDL builders (`strictArticleDdl`
 *  and `strictTransitoryDdl`). Returns the position in the stored DDL
 *  immediately after the AUTOINCREMENT keyword when the column is
 *  canonical, or `null` for any non-canonical declaration:
 *
 *   - absent column (no `id` column at all — only valid for v1
 *     additive paths where the migration adds it through ALTER);
 *   - `id INTEGER` (just an INTEGER column, not a rowid alias; no
 *     AUTOINCREMENT counter, ids not guaranteed to be unique or
 *     monotonically increasing; the canonical rebuild would silently
 *     create rows without the rowid contract);
 *   - `id INTEGER PRIMARY KEY` (the rowid alias without AUTOINCREMENT;
 *     ids ARE unique and may not be reused after delete, but the
 *     canonical AUTOINCREMENT counter is what the production schema
 *     pins — a rebuild MUST re-establish the counter and the explicit
 *     keyword, otherwise the `sqlite_sequence` entry is meaningless
 *     and an UPSERT can collide with a deleted id);
 *   - `id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT` (the column is
 *     nullable on the canonical declaration so a pre-migration row
 *     with NULL `id` materializes the `whenAbsent: NULL` literal;
 *     NOT NULL would force the COPY to coerce NULL into a fresh
 *     auto-generated id, silently turning `(id=NULL, rowid=7)` into
 *     `id=1` — a malformed predecessor row that destination insertion
 *     would auto-generate from is REFUSED here so the rebuild can fail
 *     closed before any write);
 *   - composite PRIMARY KEY (`PRIMARY KEY (a, b)` instead of column-
 *     level `id INTEGER PRIMARY KEY AUTOINCREMENT`) — the autoindex
 *     list would still carry an `origin = 'pk'` entry over the
 *     canonical identity columns; that masquerade is rejected by the
 *     reviewed-constraint preflight, but a v1 predecessor whose `id`
 *     column IS NOT the rowid alias (it participates in the composite
 *     PK) trips this gate first with a clear message);
 *
 *  The scan is comment- and string-aware (so `AUTOINCREMENT` buried
 *  in a `--` line or a string literal does not count) and runs only
 *  against executable CREATE TABLE text — the AUTOINCREMENT keyword
 *  the canonical DDL emits is the same one this gate looks for. */
function canonicalRowIdentityMatches(db: Db, table: string): boolean {
  // The id column must exist in `pragma_table_xinfo` as the ordinary
  // (hidden = 0) INTEGER primary-key column (pk = 1). `pragma_table_xinfo`
  // reports pk in column position for the rowid alias (the only
  // situation that yields `pk = 1` here is `INTEGER PRIMARY KEY`).
  const col = db.query<
    Row & {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      hidden: number;
    }
  >(
    `SELECT name, type, "notnull", pk, hidden
       FROM pragma_table_xinfo(?)
      WHERE LOWER(name) = 'id'`,
    table,
  )[0];
  if (!col) return false; // no `id` column at all
  if (col.hidden !== 0) return false; // generated / hidden lookalike
  const t = (col.type ?? "").trim().toUpperCase();
  if (t !== "INTEGER") return false;
  // Canonical declaration is nullable (no NOT NULL clause) so a
  // missing id materializes the `whenAbsent: NULL` literal and the
  // COPY promotes NULL to a fresh AUTOINCREMENT value. NOT NULL on
  // the column forces the COPY to coerce the value into the
  // destination, which is exactly the silent id-rewriting failure
  // this gate refuses.
  if (col.notnull !== 0) return false;
  // Composite PRIMARY KEY distributes pk across multiple columns; the
  // canonical rowid alias leaves `id` at pk = 1 with no other
  // pk = 2 / 3 entries. A composite PK table may still report
  // `pk = 1` on `id` only when `id` is one of the composite columns
  // — the AUTOINCREMENT keyword check below rejects it.
  if (col.pk !== 1) return false;
  const stored = storedObjectSql(db, "table", table);
  if (stored === undefined) return false;
  return findColumnDeclarationHasAutoincrement(stored, "id");
}

/** True when the `column` declaration in `stored` DDL carries the
 *  exact `PRIMARY KEY AUTOINCREMENT` token pair, comment- and string-
 *  aware. Returns false for `PRIMARY KEY` alone (no AUTOINCREMENT —
 *  the rowid alias exists but the counter is not enforced), for
 *  PRIMARY KEY declarations without the AUTOINCREMENT keyword (a
 *  composite `PRIMARY KEY (a, b)` at table level), or for a column
 *  declaration that has AUTOINCREMENT but no PRIMARY KEY (which
 *  SQLite refuses to parse but the scanner does not assume). The
 *  parser is balanced against comment-stripped text only — every
 *  caller must run `stripSqlComments` first; otherwise a `'`
 *  inside a `--` line comment can be misread as a string-literal
 *  opener and the column-list paren walker loses track of nested
 *  parens. */
function findColumnDeclarationHasAutoincrement(
  stored: string,
  column: string,
): boolean {
  const s = stripSqlComments(stored);
  const decl = findColumnDeclarationAfterIdent(s, column);
  if (decl === null) return false;
  return scanColumnDeclarationHasAutoincrement(s, decl.afterIdent);
}

/** Scan the rest of a column declaration from `start` (just after the
 *  column identifier) for the canonical `PRIMARY KEY AUTOINCREMENT`
 *  token pair, returning true only when both appear in order before
 *  the column boundary. Stops at column boundary (top-level `,` or
 *  `)`) or at the canonical boundary tokens (NOT / DEFAULT / UNIQUE /
 *  COLLATE) so neither a later column's clause nor a CHECK-body
 *  string bleeds in. The keyword scan is comment- and string-aware,
 *  and an `AUTOINCREMENT` keyword buried in a comment or string does
 *  not satisfy the gate. */
function scanColumnDeclarationHasAutoincrement(
  s: string,
  start: number,
): boolean {
  const n = s.length;
  let k = start;
  let seenPrimaryKey = false;
  let seenAutoIncrement = false;
  while (k < n) {
    const ch = s[k]!;
    if (isSqlWhitespace(ch)) {
      k++;
      continue;
    }
    // Column boundary: the canonical declaration has been seen iff
    // BOTH keywords appeared in order. `PRIMARY KEY` alone is the
    // rowid alias WITHOUT the monotonic counter, and the canonical
    // strict-v2 DDL requires the exact `PRIMARY KEY AUTOINCREMENT`
    // pair. Returning `seenPrimaryKey` here is the misleading verdict
    // that blessed a predecessor with `id INTEGER PRIMARY KEY` (no
    // AUTOINCREMENT) as canonical — the column has valid explicit
    // integer ids but `sqlite_sequence` is empty, a future UPSERT
    // can collide with a deleted id, and the canonical rebuild's
    // re-establishment of the counter is the only fix the
    // repair-converges path can drive.
    if (ch === "," || ch === ")") return seenPrimaryKey && seenAutoIncrement;
    if (ch === "(") {
      // Balanced parens for CHECK(...) / DEFAULT(...) / parenthesised type.
      let depth = 1;
      k++;
      while (k < n && depth > 0) {
        const c = s[k]!;
        if (c === "'" || c === '"' || c === "`") {
          const span = readQuotedIdentBody(s, k, c, true);
          if (span === null) return seenPrimaryKey && seenAutoIncrement;
          k = span.end;
          continue;
        }
        if (c === "[") {
          const span = readQuotedIdentBody(s, k, "]", false);
          if (span === null) return seenPrimaryKey && seenAutoIncrement;
          k = span.end;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") depth--;
        k++;
      }
      continue;
    }
    if (ch === "'") {
      const span = readQuotedIdentBody(s, k, "'", true);
      if (span === null) return seenPrimaryKey && seenAutoIncrement;
      k = span.end;
      continue;
    }
    if (ch === '"' || ch === "`") {
      const span = readQuotedIdentBody(s, k, ch, true);
      if (span === null) return seenPrimaryKey && seenAutoIncrement;
      k = span.end;
      continue;
    }
    if (ch === "[") {
      const span = readQuotedIdentBody(s, k, "]", false);
      if (span === null) return seenPrimaryKey && seenAutoIncrement;
      k = span.end;
      continue;
    }
    // Bare identifier with SQLite's own token boundaries (a Unicode
    // constraint name like `üreferences` is ONE token, never the
    // boundary-keyword fragment `references`).
    let l = k;
    while (l < n && isSqlBareIdentPart(s[l]!)) l++;
    if (l === k) {
      k++;
      continue;
    }
    const tok = s.slice(k, l).toLowerCase();
    if (tok === "primary") {
      // Read the next token — must be `key`.
      let m = l;
      while (m < n && isSqlWhitespace(s[m]!)) m++;
      let end = m;
      while (end < n && isSqlBareIdentPart(s[end]!)) end++;
      const next = s.slice(m, end).toLowerCase();
      if (next === "key") {
        seenPrimaryKey = true;
        k = end;
        continue;
      }
      // `PRIMARY` followed by something else — boundary, not the
      // canonical pair. (When the column is `id INTEGER PRIMARY
      // KEY AUTOINCREMENT`, `l` is the index just after the `Y`
      // of `PRIMARY` — whitespace-skip finds `key` next, and the
      // expected pair is honored above.)
      return false;
    }
    if (tok === "autoincrement") {
      if (seenPrimaryKey) {
        seenAutoIncrement = true;
        k = l;
        continue;
      }
      // AUTOINCREMENT without PRIMARY KEY is a parse error SQLite
      // would have raised, but defensively declare not-canonical.
      return false;
    }
    if (
      tok === "not" ||
      tok === "default" ||
      tok === "unique" ||
      tok === "collate" ||
      tok === "check" ||
      tok === "references"
    ) {
      // Boundary — once any other column-level keyword appears the
      // AUTOINCREMENT we wanted would have come before this.
      return false;
    }
    // Type or other column-level token — consume and keep scanning.
    k = l;
  }
  return seenPrimaryKey && seenAutoIncrement;
}

/** True when the stored CREATE TABLE / CREATE INDEX DDL contains an
 *  executable `ON CONFLICT <clause>` clause anywhere outside
 *  comments, strings, and quoted identifiers. SQLite preserves the
 *  `ON CONFLICT` keyword in stored DDL but `pragma_index_list` /
 *  `pragma_index_xinfo` do not expose the conflict policy, so it
 *  must be inspected from text. The canonical schema never declares
 *  an explicit `ON CONFLICT` — every UNIQUE / PRIMARY KEY is the
 *  default ABORT. Any other policy (IGNORE, REPLACE, FAIL, ROLLBACK)
 *  is a different effective shape that the canonical rebuild would
 *  silently rewrite. */
function storedDdlHasOnConflictClause(stored: string): boolean {
  const s = stripSqlComments(stored);
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuotedSpan(s, i);
      continue;
    }
    if (ch === "[") {
      i = skipQuotedSpan(s, i);
      continue;
    }
    if (/[a-z_]/i.test(ch)) {
      let j = i;
      while (j < n && /[a-z0-9_]/i.test(s[j]!)) j++;
      if (s.slice(i, j).toLowerCase() === "on") {
        let m = j;
        while (m < n && isSqlWhitespace(s[m]!)) m++;
        let end = m;
        while (end < n && /[a-z0-9_]/i.test(s[end]!)) end++;
        if (s.slice(m, end).toLowerCase() === "conflict") return true;
      }
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

/** Extract the action SUFFIX of every FK clause (column-level inline
 *  `REFERENCES` and table-level `[CONSTRAINT name] FOREIGN KEY …
 *  REFERENCES …`) declared in the stored CREATE TABLE DDL. The
 *  action suffix is the text from the end of the parenthesized
 *  parent-column list (or from after the bare parent-table
 *  identifier when no parent columns are named) up to the column-
 *  list boundary — i.e. everything that follows the `REFERENCES
 *  <parent>[(<cols>)]` proper. The function is the FK-scope version
 *  of the previous arbitrary-token scanners: it confines MATCH /
 *  DEFERRABLE / INITIALLY / ON DELETE / ON UPDATE detection to the
 *  trailing suffix each real FK clause carries, so a CONSTRAINT
 *  name `match` (`CONSTRAINT match UNIQUE (…)`), a CONSTRAINT name
 *  `initially` (`CONSTRAINT initially UNIQUE (…)`), or a column
 *  name `match` placed BEFORE the table's first REFERENCES clause
 *  cannot masquerade as the FK's own suffix and refuse the
 *  migration. The audit on each suffix (see
 *  `scanForeignKeyActionSuffix`) handles every argument form SQLite
 *  parses: bare / single-quoted / double-quoted / backtick-quoted /
 *  bracket-quoted for `MATCH <arg>`; bare for `DEFERRABLE`,
 *  `INITIALLY <IMMEDIATE|DEFERRED>`, `ON DELETE <action>`, and
 *  `ON UPDATE <action>`. The parent identifier itself is read in every
 *  identifier form SQLite accepts at the `REFERENCES` target — bare,
 *  `"…"`, `` `…` ``, `[…]`, AND `'…'` (single-quoted — SQLite decodes
 *  a string literal as an identifier in identifier context) — together
 *  with an optionally parenthesised referenced-column list whose items
 *  may each carry any of the five forms. Parsing the whole parent span
 *  is what keeps the audited suffix anchored: a suffix that started
 *  mid-identifier would silently truncate the clause and let a genuine
 *  MATCH / DEFERRABLE / INITIALLY / duplicate-`ON` after
 *  `REFERENCES 'norma'('id')` escape the audit and be erased by an
 *  unrelated rebuild. The constraint name in a `CONSTRAINT <name>
 *  FOREIGN KEY …` cannot bypass the scope check — the name appears at
 *  the START of the top-level entry, while the audit only walks the
 *  entry FROM the `REFERENCES` keyword onwards. Each clause is also
 *  paired with the raw text that trails the bounded FK clause up to
 *  the top-level column-definition boundary;
 *  `scanTrailingForeignKeyColumnConstraint` decides whether that
 *  residue is an executable post-FK column constraint the canonical
 *  strict-v2 DDL cannot represent. */
interface ForeignKeyClauseParts {
  /** Bounded trailing FK-clause text (`MATCH` / `ON DELETE|UPDATE` /
   *  `[NOT] DEFERRABLE` / `INITIALLY …`) that the suffix scanner
   *  audits for noncanonical declarators. */
  readonly suffix: string;
  /** Executable text between the FK-clause boundary and the end of
   *  the top-level entry — the region where a following column
   *  constraint (`CONSTRAINT … NOT NULL`, `COLLATE …`, `DEFAULT …`, a
   *  second `REFERENCES`, …) lives. Empty for a canonical
   *  `REFERENCES … [actions]` declaration that ends the entry. The
   *  canonical DDL carries NO post-FK column constraints at all, so
   *  every non-empty residue of this span is unsupported (including a
   *  NOT NULL that "merely duplicates" a pre-REFERENCES declaration —
   *  the canonical required column declares NOT NULL once, before the
   *  REFERENCES keyword, and never repeats it after the FK clause). */
  readonly trailing: string;
}

function extractForeignKeyActionSuffixes(stored: string): ForeignKeyClauseParts[] {
  const s = stripSqlComments(stored);
  const createPos = s.toLowerCase().indexOf("create");
  if (createPos === -1) return [];
  const parens = findCreateTableColumnListParens(s, createPos);
  if (parens === null) return [];
  const out: ForeignKeyClauseParts[] = [];
  for (const entry of splitCreateTableEntries(s, parens.open, parens.close)) {
    const parts = extractForeignKeyActionSuffixInEntry(s, entry.start, entry.end);
    if (parts === null) continue;
    out.push({
      suffix: parts.suffix.trim(),
      trailing: parts.trailing.trim(),
    });
  }
  return out;
}

/** Consume one bare / quoted / bracket identifier starting at `pos`
 *  (leading whitespace first) and return the index just after it, or
 *  `pos` when no identifier is present (so the caller can stop). Used
 *  by `boundForeignKeyClauseEnd` to walk the argument of a `MATCH <arg>`
 *  declarator and the tail of a `SET NULL` / `SET DEFAULT` / `NO ACTION`
 *  action without mistaking a following token for FK-clause content. */
function consumeFkClauseName(
  s: string,
  pos: number,
  n: number,
): number {
  let i = pos;
  while (i < n && isSqlWhitespace(s[i]!)) i++;
  if (i >= n) return pos;
  const ch = s[i]!;
  if (ch === "'" || ch === '"' || ch === "`") {
    const span = readQuotedIdentBody(s, i, ch, true);
    return span === null ? pos : span.end;
  }
  if (ch === "[") {
    const span = readQuotedIdentBody(s, i, "]", false);
    return span === null ? pos : span.end;
  }
  if (!isSqlBareIdentStart(ch)) return pos;
  let j = i;
  while (j < n && isSqlBareIdentPart(s[j]!)) j++;
  return j;
}

/** Read the next bare identifier (lowercased) at `pos` after whitespace,
 *  without consuming it. Returns `null` when the next token is not a bare
 *  word (punctuation, a quote/bracket, or end of range), which the FK
 *  clause walker uses to decide whether a clause continues. */
function peekFkClauseWord(
  s: string,
  pos: number,
  n: number,
): { word: string; start: number; end: number } | null {
  let i = pos;
  while (i < n && isSqlWhitespace(s[i]!)) i++;
  if (i >= n || !isSqlBareIdentStart(s[i]!)) return null;
  let j = i;
  while (j < n && isSqlBareIdentPart(s[j]!)) j++;
  return { word: s.slice(i, j).toLowerCase(), start: i, end: j };
}

/** Bound the trailing FK action suffix so it stops at the FIRST
 *  subsequent column constraint rather than running to the entry end.
 *
 *  A column declaration may chain several column constraints after its
 *  inline FK clause — `norma_id INTEGER NOT NULL REFERENCES norma(id)
 *  ON DELETE CASCADE CONSTRAINT match NOT NULL`, or a following
 *  `CHECK (match > 0)`, `COLLATE BINARY`, `PRIMARY KEY`, `UNIQUE`,
 *  `DEFAULT 'UNIQUE'`, or a second `REFERENCES`. The FK-clause grammar
 *  SQLite accepts AFTER `REFERENCES <parent>[(<cols>)]` is exactly:
 *    - `MATCH <name>` (bare or quoted in any identifier form),
 *    - `ON DELETE|UPDATE SET NULL|SET DEFAULT|NO ACTION|RESTRICT|CASCADE`,
 *    - `[NOT] DEFERRABLE`,
 *    - `INITIALLY DEFERRED|IMMEDIATE`,
 *  in any interleaving. Any other token ends the FK clause and opens a
 *  NEW column constraint. Walking the clause and returning only the text
 *  it consumed keeps a subsequent column-constraint NAME (`match`,
 *  `initially`, `deferrable`) or a subsequent `CHECK`/`DEFAULT`/
 *  `COLLATE`/`UNIQUE`/`PRIMARY KEY`/`REFERENCES` from being misread as a
 *  FK MATCH / DEFERRABLE / INITIALLY declarator — while a genuine
 *  `MATCH`/`DEFERRABLE`/`INITIALLY`/duplicate-`ON` that really lives in
 *  the FK clause stays inside the returned suffix and is still refused.
 *  `pos` is the start of the suffix (already past the parent table and
 *  its optional column list); `n` is the entry end. */
function boundForeignKeyClauseEnd(
  s: string,
  pos: number,
  n: number,
): number {
  let i = pos;
  for (;;) {
    const head = peekFkClauseWord(s, i, n);
    if (head === null) break; // punctuation / quoted token / end → clause over
    const word = head.word;
    if (word === "match") {
      // `MATCH <arg>` — consume the argument (bare or quoted). Keep the
      // MATCH keyword inside the suffix so the scanner still refuses it.
      const afterArg = consumeFkClauseName(s, head.end, n);
      i = afterArg === head.end ? n : afterArg;
      continue;
    }
    if (word === "on") {
      const kw = peekFkClauseWord(s, head.end, n);
      if (kw === null || (kw.word !== "delete" && kw.word !== "update")) {
        break; // `ON` not followed by DELETE/UPDATE → not an action clause
      }
      const act = peekFkClauseWord(s, kw.end, n);
      if (act === null) {
        i = kw.end;
        break;
      }
      if (act.word === "set" || act.word === "no") {
        // `SET NULL` / `SET DEFAULT` / `NO ACTION` — consume the tail word.
        const tail = consumeFkClauseName(s, act.end, n);
        i = tail === act.end ? act.end : tail;
      } else {
        // `CASCADE` / `RESTRICT` (or anything else) — one token.
        i = act.end;
      }
      continue;
    }
    if (word === "deferrable") {
      i = head.end;
      continue;
    }
    if (word === "not") {
      const kw = peekFkClauseWord(s, head.end, n);
      if (kw !== null && kw.word === "deferrable") {
        i = kw.end; // `NOT DEFERRABLE` belongs to the FK clause
        continue;
      }
      i = head.start ?? pos; // NOT NULL / NOT … → subsequent column constraint
      break;
    }
    if (word === "initially") {
      const kw = peekFkClauseWord(s, head.end, n);
      if (
        kw !== null &&
        (kw.word === "deferred" || kw.word === "immediate")
      ) {
        i = kw.end; // `INITIALLY DEFERRED|IMMEDIATE` is FK-clause content
        continue;
      }
      i = head.end;
      break;
    }
    // Any other token (`constraint`, `check`, `collate`, `primary`,
    // `unique`, `default`, `references`, a column type, …) starts a new
    // constraint or is not FK-clause syntax → the clause has ended.
    break;
  }
  return i;
}

/** One entry's FK clause parts (or `null` when the entry declares
 *  no `REFERENCES` clause): the bounded action suffix and the raw text
 *  trailing the suffix up to the entry boundary. The walker honors
 *  comment-stripped text and quoted spans (`"…"`, `` `…` ``, `[…]`,
 *  `'…'`) so a `REFERENCES` keyword appearing inside a string literal
 *  or a comment never counts; a `CONSTRAINT <name>` introducer consumes
 *  its COMPLETE name token (bare names with SQLite's own identifier
 *  boundaries — Unicode and `$` included — or any quoted form) so a
 *  name like `üreferences` is never split into an executing `references`
 *  fragment and fabricated into a phantom FK clause; and a parenthesized
 *  parent-column list is
 *  also balanced for nested parens and quoted spans. */
function extractForeignKeyActionSuffixInEntry(
  s: string,
  start: number,
  end: number,
): { suffix: string; trailing: string } | null {
  let i = start;
  const n = end;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const span = readQuotedIdentBody(s, i, ch, true);
      if (span === null) return null;
      i = span.end;
      continue;
    }
    if (ch === "[") {
      const span = readQuotedIdentBody(s, i, "]", false);
      if (span === null) return null;
      i = span.end;
      continue;
    }
    if (ch === "(") {
      // Balanced parens for any nested expression BEFORE references —
      // CHECK predicates, DEFAULT function bodies, parenthesised types,
      // parenthesised FOREIGN KEY column lists. We skip past them so a
      // `REFERENCES` keyword appearing later in the same entry is
      // still found.
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const c = s[i]!;
        if (c === "'" || c === '"' || c === "`") {
          const span = readQuotedIdentBody(s, i, c, true);
          if (span === null) return null;
          i = span.end;
          continue;
        }
        if (c === "[") {
          const span = readQuotedIdentBody(s, i, "]", false);
          if (span === null) return null;
          i = span.end;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") depth--;
        i++;
      }
      continue;
    }
    if (isSqlBareIdentStart(ch)) {
      let j = i;
      while (j < n && isSqlBareIdentPart(s[j]!)) j++;
      const word = s.slice(i, j).toLowerCase();
      if (word === "constraint") {
        // A `CONSTRAINT <name>` introducer at entry level (a named
        // column constraint BEFORE the REFERENCES clause): consume the
        // COMPLETE name token — bare (Unicode / `$` included) or
        // quoted — so a name like `üreferences` is never split into
        // the executing ASCII fragment `references` and fabricated
        // into a phantom FK clause.
        const afterName = skipConstraintNameToken(s, j, n);
        if (afterName === null) return null; // malformed quoted name
        i = afterName > j ? afterName : j;
        continue;
      }
      if (word === "references") {
        // Found REFERENCES at top level of the entry — return the
        // suffix from after the parent-table identifier (and its
        // optional parenthesised column list) up to the column-list
        // boundary. A bare parent table name (`REFERENCES parent`), a
        // schema-qualified (`REFERENCES main.parent`) dotted name, and
        // every identifier quoting form the engine accepts at this
        // position — `"…"`, `` `…` ``, `[…]`, and `'…'` (SQLite
        // decodes a single-quoted string as an identifier in
        // identifier context) — all live before what the audit reads
        // as the trailing suffix. Parsing the single-quoted form here
        // is the defect fix: leaving `'norma'('id')` unconsumed made
        // the boundary walker stop at the opening quote and return an
        // EMPTY suffix, so a genuine MATCH / DEFERRABLE / INITIALLY /
        // duplicate ON that really followed the clause escaped the
        // audit and an unrelated rebuild silently erased it.
        let k = j;
        while (k < n && isSqlWhitespace(s[k]!)) k++;
        // Parent table identifier (possibly schema-qualified — accept
        // `schema.table`-style dotted identifier; case-folded later
        // by `sqlite_master` lookup).
        if (s[k] === '"' || s[k] === "`" || s[k] === "'") {
          const span = readQuotedIdentBody(s, k, s[k]!, true);
          if (span === null) return null;
          k = span.end;
        } else if (s[k] === "[") {
          const span = readQuotedIdentBody(s, k, "]", false);
          if (span === null) return null;
          k = span.end;
        } else {
          while (k < n && (isSqlBareIdentPart(s[k]!) || s[k] === ".")) k++;
        }
        while (k < n && isSqlWhitespace(s[k]!)) k++;
        // Optional parenthesised parent-column list.
        if (s[k] === "(") {
          let depth = 1;
          k++;
          while (k < n && depth > 0) {
            const c = s[k]!;
            if (c === "'" || c === '"' || c === "`") {
              const span = readQuotedIdentBody(s, k, c, true);
              if (span === null) return null;
              k = span.end;
              continue;
            }
            if (c === "[") {
              const span = readQuotedIdentBody(s, k, "]", false);
              if (span === null) return null;
              k = span.end;
              continue;
            }
            if (c === "(") depth++;
            else if (c === ")") depth--;
            k++;
          }
        }
        // Bound the FK clause so it stops at the first subsequent
        // column constraint — everything SQLite parses as trailing
        // FK-clause syntax (`MATCH <arg>`, `ON DELETE/UPDATE <action>`,
        // `[NOT] DEFERRABLE`, `INITIALLY DEFERRED|IMMEDIATE`) stays in
        // the returned suffix, while a following `CONSTRAINT match
        // NOT NULL`, `CHECK (…)`, `COLLATE …`, `PRIMARY KEY`, `UNIQUE`,
        // `DEFAULT …`, or second `REFERENCES` does NOT leak into the
        // audited suffix and masquerade as a FK MATCH / DEFERRABLE /
        // INITIALLY declarator. The stopped position opens the
        // TRAILING span: an executable column constraint there is not
        // "harmless residue" — the canonical FK column declarations
        // carry no post-FK column constraints, and a strict rebuild
        // would silently erase one — so it is reported for the
        // fail-closed trailing audit as well.
        const clauseEnd = boundForeignKeyClauseEnd(s, k, n);
        return {
          suffix: s.slice(k, clauseEnd),
          trailing: s.slice(clauseEnd, n),
        };
      }
      i = j;
      continue;
    }
    i++;
  }
  return null;
}

/** Audit a single FK action suffix (the trailing text after
 *  `REFERENCES <parent>[(<cols>)]`) for unsupported declarators that
 *  `pragma_foreign_key_list` does not surface:
 *
 *  - `MATCH <arg>` — `FULL` / `PARTIAL` / `SIMPLE` / `NONE`, in any of
 *    the bare / single / double / backtick / bracket quoted argument
 *    forms the engine accepts (a quoted span that opens but never
 *    closes is itself a malformed statement; defensively treat the
 *    keyword as present);
 *  - `DEFERRABLE` / `INITIALLY` — both keywords and the `INITIALLY
 *    IMMEDIATE` / `INITIALLY DEFERRED` argument form are unsupported
 *    (the canonical strict-v2 DDL never declares deferred semantics;
 *    every FK is the engine default immediate, NOT DEFERRABLE);
 *  - duplicate `ON DELETE` / `ON UPDATE` — a single FK clause that
 *    declares `ON DELETE CASCADE ON DELETE SET NULL` (or any pair of
 *    `ON DELETE` / `ON UPDATE`) is unsupported: PRAGMA collapses
 *    duplicate action declarators to the LAST effective action, so the
 *    first `ON DELETE` is invisible to the FK inventory audit yet
 *    persists in the stored DDL with whatever semantic SQLite's parser
 *    honored on creation. The work order pins this case: an
 *    unrelated rebuild MUST NOT silently reduce duplicate declarative
 *    syntax (the rebuild would rewrite only the EFFECTIVE action and
 *    discard the visible-by-DDL duplicate). Repeated declarators
 *    refuse the migration mutation-free; missing action declarators
 *    (the canonical v1 default — neither `ON DELETE` nor `ON UPDATE`
 *    declared) are still accepted and rebuilt to the canonical v2
 *    explicit-delete declaration as already designed.
 *
 *  Returns one of:
 *    - `"none"` when the suffix is empty of every unwanted declarator;
 *    - `"match"` for an explicit `MATCH <arg>` clause;
 *    - `"deferrable"` for `DEFERRABLE` (with or without a paired
 *      `INITIALLY`);
 *    - `"initially"` for `INITIALLY` without `DEFERRABLE`;
 *    - `"duplicate-delete"` for two-or-more `ON DELETE` declarators;
 *    - `"duplicate-update"` for two-or-more `ON UPDATE` declarators.
 *  The caller refuses closed on any non-`"none"` value. The audit is
 *  comment- and quoted-span-aware — a `MATCH` keyword buried in a
 *  comment or a column-comment / constraint-comment string never
 *  counts. */
function scanForeignKeyActionSuffix(
  suffix: string,
): "none" | "match" | "deferrable" | "initially" | "duplicate-delete" | "duplicate-update" {
  const s = stripSqlComments(suffix);
  const n = s.length;
  let hasMatch = false;
  let hasDeferrable = false;
  let hasInitially = false;
  let onDeleteCount = 0;
  let onUpdateCount = 0;
  let i = 0;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuotedSpan(s, i);
      continue;
    }
    if (ch === "[") {
      i = skipQuotedSpan(s, i);
      continue;
    }
    if (isSqlBareIdentStart(ch)) {
      let j = i;
      while (j < n && isSqlBareIdentPart(s[j]!)) j++;
      const word = s.slice(i, j).toLowerCase();
      if (word === "match") {
        // The MATCH argument is read whether bare or quoted in any
        // of the four identifier-quoting forms the engine accepts
        // (`'arg'`, `"arg"`, `` `arg` ``, `[arg]`). Presence of any
        // argument — bare or quoted, full / partial / simple / none
        // — is enough; the canonical DDL never declares MATCH, so
        // any form is refused. A MATCH keyword at end-of-suffix
        // (no argument follows) is a parse error SQLite would have
        // raised; defensively treat as MATCH-present.
        let m = j;
        while (m < n && isSqlWhitespace(s[m]!)) m++;
        if (m < n) hasMatch = true;
        else hasMatch = true;
        i = j;
        continue;
      }
      if (word === "deferrable") {
        hasDeferrable = true;
        i = j;
        continue;
      }
      if (word === "initially") {
        hasInitially = true;
        i = j;
        continue;
      }
      if (word === "on") {
        let m = j;
        while (m < n && isSqlWhitespace(s[m]!)) m++;
        let end = m;
        while (end < n && isSqlBareIdentPart(s[end]!)) end++;
        const next = s.slice(m, end).toLowerCase();
        if (next === "delete") onDeleteCount++;
        else if (next === "update") onUpdateCount++;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (hasMatch) return "match";
  if (hasDeferrable) return "deferrable";
  if (hasInitially) return "initially";
  if (onDeleteCount > 1) return "duplicate-delete";
  if (onUpdateCount > 1) return "duplicate-update";
  return "none";
}

/** Verdict on the text that trails a bounded FK clause inside the same
 *  top-level column definition: `null` when the residue holds no
 *  executable column constraint, otherwise the offending (trimmed)
 *  text.
 *
 *  The FK-clause boundary (`boundForeignKeyClauseEnd`) stops at the
 *  first token SQLite does not parse as FK-clause syntax, but the
 *  rest of the audit must NOT treat whatever follows as harmless.
 *  The canonical article / transitory FK column declarations —
 *  `norma_id INTEGER NOT NULL REFERENCES norma(id) ON DELETE CASCADE`
 *  and `hierarchy_node_id INTEGER REFERENCES hierarchy_node(id)
 *  ON DELETE SET NULL` — contain no post-FK column constraints beyond
 *  their reviewed action syntax, so ANY executable trailing column
 *  constraint is noncanonical: the strict rebuild rewrites the entry
 *  from the canonical DDL and silently erases it. `hierarchy_node_id
 *  … REFERENCES … CONSTRAINT match NOT NULL` is the pinned example —
 *  a NOT NULL the canonical SET NULL reference never carries and that
 *  would block the canonical SET NULL behavior outright — and it must
 *  be refused before mutation, not rebuilt away.
 *
 *  There is NO column-agnostic exception. A trailing `NOT NULL` is
 *  refused even when the column's own pre-REFERENCES declaration
 *  already carries `NOT NULL` (the `norma_id … ON DELETE CASCADE
 *  NOT NULL` shape): the canonical strict DDL declares no redundant
 *  post-FK constraints, the duplicate declaration is exactly what an
 *  unrelated rebuild would silently erase, and matching effective
 *  nullability is not a reason to bless noncanonical DDL text. A
 *  required column keeps `NOT NULL` in its canonical pre-REFERENCES
 *  position (audited by the per-column metadata gate); every named
 *  constraint (`CONSTRAINT <name> …`, any name-quoting form), every
 *  `COLLATE …`, `UNIQUE`, `CHECK (…)`, `DEFAULT …`, `PRIMARY KEY`, an
 *  explicit `NULL`, a second `REFERENCES`, generated-column syntax, or
 *  unparseable residue likewise fails closed. */
function scanTrailingForeignKeyColumnConstraint(
  trailing: string,
): string | null {
  // There is no column-agnostic exception and no word-by-word verdict:
  // ANY non-blank residue between the bounded FK clause and the
  // top-level entry boundary is an executable (named or unnamed
  // `NOT NULL`, `NULL`, `COLLATE …`, `UNIQUE`, `CHECK (…)`, `DEFAULT …`,
  // `PRIMARY KEY`, a second `REFERENCES`, generated-column syntax) or
  // unparseable post-FK column constraint outside the reviewed
  // inventory, and the whole span is reported as the offending text.
  // `extractForeignKeyActionSuffixes` already trims the span, so a
  // blank residue is exactly the canonical declaration that ends with
  // its reviewed action syntax — nothing executable follows the FK
  // clause and the verdict is `null`.
  return trailing.trim() === "" ? null : trailing;
}

/** The set of FK auxiliary-clause refusals across every FK clause in
 *  `stored` — i.e. the work-order FK-clause scope: each clause is
 *  audited individually for MATCH / DEFERRABLE / INITIALLY / repeated
 *  action declarators and for an executable trailing column
 *  constraint after the bounded clause, and the first offending
 *  clause (in source order) is reported. The audit is FK-scope, NOT
 *  arbitrary-token: a `CONSTRAINT match UNIQUE (…)` constraint NAME
 *  (or a `CONSTRAINT initially UNIQUE (…)` / `CONSTRAINT match
 *  FOREIGN KEY (…)` / column-named `match`) cannot masquerade as a
 *  FK action suffix because the suffix walker only ever inspects the
 *  trailing text after a `REFERENCES <parent>[(<cols>)]` declaration.
 *  The reader accepts every argument form SQLite parses (bare,
 *  single-quoted, double-quoted, backtick-quoted, bracket-quoted) so
 *  genuine `MATCH <arg>` clauses anywhere in the suffix — `FULL`,
 *  `PARTIAL`, `SIMPLE`, `NONE`, whether bare or quoted in any of the
 *  four identifier forms — still refuse, and because the parent
 *  identifier itself is parsed in every one of those forms, a genuine
 *  MATCH / DEFERRABLE / INITIALLY / duplicate-`ON` after
 *  `REFERENCES 'norma'('id')` can no longer hide behind an
 *  empty-suffix parse failure. The bounded-clause boundary is where
 *  the suffix audit stops; what follows it up to the top-level entry
 *  boundary is handed to `scanTrailingForeignKeyColumnConstraint`, so
 *  a `CONSTRAINT … NOT NULL` / `COLLATE …` / `DEFAULT …` /
 *  second-`REFERENCES` trailing an FK clause fails the migration
 *  closed instead of being treated as harmless and erased by the
 *  rebuild. */
type FkAuxiliaryClauseIssue =
  | {
      readonly kind:
        | "match"
        | "deferrable"
        | "initially"
        | "duplicate-delete"
        | "duplicate-update";
      readonly position: number;
    }
  | {
      readonly kind: "trailing-constraint";
      readonly position: number;
      readonly text: string;
    };

function storedDdlHasFkAuxiliaryClause(stored: string): FkAuxiliaryClauseIssue | null {
  const clauses = extractForeignKeyActionSuffixes(stored);
  let position = 0;
  for (const clause of clauses) {
    const kind = scanForeignKeyActionSuffix(clause.suffix);
    if (kind !== "none") return { kind, position };
    const trailing = scanTrailingForeignKeyColumnConstraint(clause.trailing);
    if (trailing !== null) return { kind: "trailing-constraint", position, text: trailing };
    position++;
  }
  return null;
}

/** The stable refusal for a tracked table missing one non-additive
 *  canonical column entirely. Shared by `assertCanonicalColumnsPresent`
 *  (the EARLY preflight — see its JSDoc for why it must run before any
 *  row-identity DATA query) and `assertCanonicalColumnMetadata` (whose
 *  per-column walk keeps the identical verdict standalone-safe), so the
 *  message can never drift between the two call orders. */
function missingCanonicalColumnError(
  table: string,
  want: CanonicalColumnMetadata,
): Error {
  return new Error(
    `migrateCorpusSchema: refusing migration — table ${table} is missing the canonical ` +
      `column \`${want.name}\` entirely; the canonical declaration is \`${want.name} ${want.type}` +
      `${want.notNull ? " NOT NULL" : ""}${want.defaultText !== null ? ` DEFAULT ${want.defaultText}` : ""}` +
      `${want.pk > 0 ? " PRIMARY KEY AUTOINCREMENT" : ""}\` (nullable, no DEFAULT, and ordinary when ` +
      `those parts are not shown). Only the reviewed later-added columns (\`extract_order\`, ` +
      `\`source_unit_id\`) have additive ALTER lanes and an absent whole table has the SCHEMA_DDL ` +
      `creation lane; a PRESENT table missing a canonical column could only be completed by ` +
      `regenerating or guessing values no stored row ever carried, which this migration never ` +
      `does, and the strict rebuild must not silently materialize the gap either. Recreate the ` +
      `table with the canonical declaration (or restore the column from a backup) before this repair`,
  );
}

/** Refuse closed BEFORE any row-identity DATA query when a present
 *  tracked table lacks a canonical column outside the two reviewed
 *  later-added omissions. The verdict itself is `assertCanonical-
 *  ColumnMetadata`'s, but the ABSENCE question must be settled early:
 *  gate 2a of `assertReviewedTableConstraints` reads the id DATA
 *  through a plain `SELECT … id … FROM <table>` (via
 *  `idColumnDataIsRepairable`), and on a table whose `id` column is
 *  gone that raw query blew up with an engine "no such column: id"
 *  error — a message that is neither the stable migration refusal nor
 *  stable across callers. Running the presence preflight first gives
 *  EVERY missing non-additive column (`id`, `body`, `label`, …) the
 *  same descriptive refusal, mutation-free and repeat/reopen-stable,
 *  before any data query touches the table. `extract_order` and
 *  `source_unit_id` keep their reviewed additive ALTER / dedicated
 *  repair lanes and are never refused here; an absent WHOLE table is
 *  skipped by the caller (SCHEMA_DDL creation lane). */
function assertCanonicalColumnsPresent(
  db: Db,
  reviewed: ReviewedTableConstraints,
): void {
  const present = new Set(
    db
      .query<{ name: string }>(
        `SELECT name FROM pragma_table_xinfo(?)`,
        reviewed.table,
      )
      .map((column) => column.name.toLowerCase()),
  );
  for (const want of reviewed.columnMetadata) {
    if (want.name === "source_unit_id") continue; // dedicated repair lane
    if (present.has(want.name.toLowerCase())) continue;
    if (want.name === "extract_order") continue; // additive ALTER lane
    throw missingCanonicalColumnError(reviewed.table, want);
  }
}

/** Refuse closed (before ANY schema write) when a tracked table carries
 *  a canonical-named column whose EFFECTIVE metadata is not what the
 *  canonical strict-v2 DDL declares — for EVERY article / transitory
 *  column, not just `id` (row-identity gate) and `source_unit_id`
 *  (dedicated repair lane).
 *
 *  The audit reads the PRAGMA-visible half of the shape from
 *  `pragma_table_xinfo` (exact declared type, nullable / NOT NULL
 *  state, DEFAULT text, PK ordinal, ordinary-vs-generated visibility)
 *  and the one thing the PRAGMA omits — the effective column
 *  COLLATION — from the stored DDL through the top-level column
 *  definition parser (`columnEffectiveCollationIsNonBinary`, which
 *  scans the whole declaration because SQLite lets a COLLATE clause
 *  follow NOT NULL / DEFAULT / CHECK / REFERENCES).
 *
 *  Verdict rules:
 *   - a MISSING canonical column is refused here (in the shipped gate
 *     order the earlier `assertCanonicalColumnsPresent` preflight has
 *     already refused it, so this walk stays byte-identical as a
 *     standalone safety net) UNLESS it is one of the
 *     two reviewed later-added omissions with a real migration lane:
 *     `extract_order` (added by the additive ALTER) and `source_unit_id`
 *     (skipped below — its dedicated ALTER + rebuild-and-converge lane).
 *     An ABSENT whole table is not refused either (`assertReviewedTable-
 *     Constraints` skips it — `SCHEMA_DDL` creates it canonical). Every
 *     OTHER absent canonical column (`body`, `ordinal_raw`, `doc_order`,
 *     `label`, `ficha_ref`, …) refuses the migration BEFORE any write:
 *     no lane legitimately materializes it, and an unrelated rebuild
 *     would silently regenerate the column with a guessed value (NULL /
 *     the copy default) that no predecessor row ever carried — the
 *     fail-closed verdict keeps the exact schema and data intact instead
 *     of returning false/current or inventing values;
 *   - noncanonical STORED CASING of a canonical name (`Number`) is the
 *     approved canonicalization repair lane — names match
 *     case-insensitively and casing alone never feeds this gate;
 *   - every PRESENT canonical column must carry the canonical
 *     metadata exactly. In particular the canonical NULLABLE
 *     `hierarchy_node_id` may not carry a pre-REFERENCES `NOT NULL`
 *     (post-REFERENCES ones are refused by the trailing-constraint
 *     gate above), no canonical column may carry a pre- or
 *     post-REFERENCES `DEFAULT` the canonical declaration does not
 *     have, and no canonical column may carry a non-BINARY COLLATE.
 *     Such declarations change behavior (a NOT NULL blocks the
 *     canonical SET NULL delete; a DEFAULT silently materializes
 *     values the canonical schema rejects; a NOCASE / RTRIM collation
 *     silently re-keys comparisons), the canonical strict-v2 DDL
 *     cannot represent them, and a rebuild would silently rewrite
 *     them — so they must never be blessed, repeatedly repaired, or
 *     quietly erased by an unrelated rebuild;
 *   - `source_unit_id` is EXCLUDED: its wrong-metadata shapes
 *     (wrong type / NOT NULL / DEFAULT / PK / generated / non-BINARY
 *     collation) remain the established single rebuild-and-converge
 *     lane pinned by S2M-22/26/27/30/31/38, and the unknown-column
 *     gate still owns every non-canonical name. */
function assertCanonicalColumnMetadata(
  db: Db,
  reviewed: ReviewedTableConstraints,
  stored: string,
): void {
  const columns = db.query<
    Row & {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }
  >(
    `SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)`,
    reviewed.table,
  );
  const byLower = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  for (const want of reviewed.columnMetadata) {
    if (want.name === "source_unit_id") continue; // dedicated repair lane
    const got = byLower.get(want.name.toLowerCase());
    if (got === undefined) {
      if (want.name === "extract_order") continue; // additive ALTER lane
      throw missingCanonicalColumnError(reviewed.table, want);
    }
    const issues: string[] = [];
    const type = (got.type ?? "").trim().toUpperCase();
    if (type !== want.type) {
      issues.push(
        `declared type \`${got.type}\` where the canonical column declares \`${want.type}\` ` +
          `(an untyped or lookalike declaration selects a different affinity)`,
      );
    }
    if ((got.notnull !== 0) !== want.notNull) {
      issues.push(
        want.notNull
          ? "is nullable where the canonical column is NOT NULL"
          : "carries NOT NULL where the canonical column is nullable " +
            "(a NOT NULL on the ON DELETE SET NULL reference blocks the canonical SET NULL delete outright)",
      );
    }
    const defaultText = got.dflt_value === null ? null : got.dflt_value.trim();
    if (defaultText !== want.defaultText) {
      issues.push(
        want.defaultText === null
          ? `carries DEFAULT ${defaultText ?? "''"} where the canonical column declares no DEFAULT`
          : `carries DEFAULT ${defaultText ?? "(none)"} where the canonical column declares DEFAULT ${want.defaultText}`,
      );
    }
    if (got.pk !== want.pk) {
      issues.push(
        `is at PRIMARY KEY ordinal ${got.pk} where the canonical column sits at ordinal ${want.pk}`,
      );
    }
    if (got.hidden !== 0) {
      issues.push(
        `is a hidden / generated column (hidden = ${got.hidden}) where the canonical column is ordinary`,
      );
    }
    if (columnEffectiveCollationIsNonBinary(stored, want.name)) {
      issues.push(
        "declares a non-BINARY column COLLATE clause where the canonical column resolves to implicit BINARY",
      );
    }
    if (issues.length > 0) {
      throw new Error(
        `migrateCorpusSchema: refusing migration — table ${reviewed.table} column ${want.name} ` +
          `carries effective metadata the canonical strict-v2 DDL cannot represent (${issues.join("; ")}). ` +
          `The canonical declaration is \`${want.name} ${want.type}${want.notNull ? " NOT NULL" : ""}` +
          `${want.defaultText !== null ? ` DEFAULT ${want.defaultText}` : ""}${want.pk > 0 ? ` PRIMARY KEY AUTOINCREMENT` : ""}\` ` +
          `with no DEFAULT (unless listed), ordinary visibility, and BINARY collation; the column must ` +
          `match it exactly, and behavior-changing metadata is never blessed, rebuilt away, or silently ` +
          `canonicalized by an unrelated rebuild. Align the column metadata or drop and recreate the ` +
          `table with the canonical declaration before this repair`,
      );
    }
  }
}

/**
 * Read-only whole-database table-constraint / column-metadata preflight
 * for the two tracked rebuildable tables (`article` /
 * `transitory_provision`), run BEFORE the first schema write on EVERY
 * path (fresh / additive / rebuild / index-only / no-op). The preflight
 * pins the reviewed TABLE-constraint inventory (identity UNIQUE, CHECKs,
 * FKs, FK auxiliary clauses and post-FK column constraints) AND the
 * canonical EFFECTIVE metadata of every column the canonical DDL
 * declares (`assertCanonicalColumnMetadata` — exact declared type,
 * nullable / NOT NULL state, DEFAULT text, PK ordinal, ordinary-vs-
 * generated visibility, and the PRAGMA-invisible effective collation),
 * so no behavior-changing declaration can be blessed on an otherwise-
 * canonical table or be silently rewritten by an unrelated rebuild.
 * The ABSENCE of a non-additive canonical column is refused by the
 * early `assertCanonicalColumnsPresent` preflight, which runs BEFORE
 * the row-identity gate's raw `SELECT … id …` DATA query so every
 * missing-column shape reaches the stable migration error instead of
 * an engine column-resolution failure.
 *
 * The strict rebuild replaces the whole table with `strictArticleDdl` /
 * `strictTransitoryDdl`, whose ONLY table-level constraints are the canonical
 * logical-identity UNIQUE and (once the column exists) the canonical
 * source-unit CHECK; the two column-level outgoing references are fixed too.
 * A predecessor that carries a materially DIFFERENT constraint set — a global
 * `UNIQUE (source_unit_id)` (SQLite's `sqlite_autoindex_article_2`), a
 * `UNIQUE (body)` autoindex, an extra table-level CHECK, or an extra/different
 * outgoing FK — cannot be represented in the canonical strict-v2 DDL. Auditing
 * such a shape as "already canonical" (because the column + source-unit CHECK
 * + name all match) BLESSES a constraint the production schema never declares,
 * and flagging the table lax for an unrelated reason then rebuilds it from the
 * canonical DDL and SILENTLY DROPS the user's extra constraint and its
 * autoindex. Both are wrong: this gate inspects the EFFECTIVE constraint
 * inventory (CHECK expressions, outgoing FK list, and `pragma_index_list` /
 * `pragma_index_xinfo` autoindex set) and refuses closed BEFORE any mutation
 * whenever a constraint that is not part of the reviewed inventory is
 * present, so the exact schema, data, and autoindexes are retained.
 *
 * The reviewed inventory covers BOTH generations the migration legitimately
 * upgrades from (see `REVIEWED_TABLE_CONSTRAINTS`):
 *   - a legacy v1 shape: the logical-identity UNIQUE and the two column-level
 *     outgoing FKs, WITHOUT the source-unit CHECK (the column itself is added
 *     by the additive `ALTER … ADD COLUMN … CHECK`);
 *   - a canonical v2 shape: the SAME logical-identity UNIQUE and outgoing FKs,
 *     PLUS exactly the canonical source-unit CHECK.
 * A CHECK group is reviewed only when it is the canonical source-unit CHECK
 * (a legacy shape carries none). Any OTHER effective CHECK, any autoindex whose
 * key-column signature is not the single logical-identity UNIQUE, and any
 * outgoing FK not among the canonical references is an unsupported extra.
 *
 * A predecessor carrying a column OUTSIDE the canonical set is a different
 * defect the strict rebuild already refuses closed (the "unknown column"
 * lane) — those shapes (the doubled-quote / backtick / bracket lookalikes) are
 * left to that gate so their established fail-closed behavior is unchanged.
 * This preflight is read-only (sqlite_master + PRAGMA table functions only,
 * no PRAGMA state is toggled), so it is valid inside a caller-owned
 * transaction and as the first statements of the migration's savepoint.
 */
function assertReviewedTableConstraints(db: Db): void {
  const canonicalCheck = findCheckConstraintGroups(SOURCE_UNIT_COLUMN_CHECK)[0]!;
  for (const reviewed of REVIEWED_TABLE_CONSTRAINTS) {
    const stored = storedObjectSql(db, "table", reviewed.table);
    if (stored === undefined) continue; // absent → SCHEMA_DDL creates it canonical
    const spec = STRICT_V2_TABLE_SPECS.find((s) => s.table === reviewed.table)!;
    // Fail closed BEFORE any write when the tracked table carries a
    // column outside its canonical column set. A noncanonical extra
    // (the user-added `extension_note TEXT NULL` case) is unsupported
    // because the canonical strict-v2 DDL cannot represent it and a
    // rebuild would silently DROP the data the predecessor stored
    // there. The prior implementation `continue`d past this branch,
    // skipping every downstream audit (row identity, CHECK inventory,
    // ON CONFLICT, DEFERRABLE, MATCH, UNIQUE autoindex, FK inventory)
    // — a nullable `extension_note` therefore let a malformed row
    // identity, an `ON CONFLICT IGNORE` UNIQUE policy, a deferred FK
    // declaration, an extra FK on the canonical column, or a wrong-
    // action FK converge without ever being inspected. Refusing here,
    // with the exact stored DDL and data still byte-identical, is the
    // only honest verdict: the strict rebuild cannot represent an
    // unknown column, so any other audit that the preflight would
    // surface is moot on a predecessor that carries one.
    const canonicalColumns = new Set(
      spec.columns.map((column) => column.name.toLowerCase()),
    );
    const unknownColumns = db
      .query<{ name: string }>(
        `SELECT name FROM pragma_table_xinfo(?)`,
        reviewed.table,
      )
      .filter((column) => !canonicalColumns.has(column.name.toLowerCase()));
    if (unknownColumns.length > 0) {
      throw new Error(
        `migrateCorpusSchema: refusing migration — table ${reviewed.table} carries ` +
          `non-canonical extra column(s) [${unknownColumns.map((c) => c.name).join(", ")}]; ` +
          `the canonical strict-v2 DDL cannot represent them and a strict rebuild would drop ` +
          `their data silently. Remove the unsupported extra column(s) before this repair`,
      );
    }

    // 0. Canonical column PRESENCE preflight — MUST run before every
    //    row-identity DATA query (gate 2a reads the id rows through a
    //    plain `SELECT … id … FROM <table>`). When a non-additive
    //    canonical column (`id`, `body`, `label`, …) is ABSENT, that raw
    //    data query used to throw an engine "no such column: id" error
    //    before the descriptive missing-column gate could speak. Refusing
    //    here gives the same stable migration message for every such
    //    omission, mutation-free, before any data is touched. `extract_order`
    //    and `source_unit_id` are excluded (reviewed additive / repair lanes).
    assertCanonicalColumnsPresent(db, reviewed);

    // 1. Effective CHECK inventory — declared multiplicity is enforced
    //    BEFORE the per-group review so a DUPLICATE of the canonical
    //    source-unit CHECK cannot slip through the canonical-review loop
    //    (which silently accepts every occurrence of `canonicalCheck`)
    //    and let a strict rebuild rewrite the predicate via the canonical
    //    DDL while leaving the duplicate declaration behind. Article /
    //    transitory may carry ZERO canonical source-unit CHECKs on a v1
    //    predecessor (the column + CHECK are additively created by the
    //    migration later) or EXACTLY ONE canonical source-unit CHECK on a
    //    v2-lookalike predecessor; two or more is non-representable (the
    //    canonical strict-v2 DDL declares exactly one) and any rebuild /
    //    additive migration cannot reduce the duplicate declaration down
    //    to its single target. The audit inspects stored DDL directly —
    //    `pragma_table_xinfo` and friends do not expose declared CHECK
    //    counts at all, and a `CHECK (…)` declaration the engine merges
    //    into one effective constraint still appears N times in the
    //    stored DDL where the rebuild would have to drop the duplicates
    //    silently. Refused mutation-free before any schema write.
    let canonicalCheckCount = 0;
    for (const group of findCheckConstraintGroups(stored)) {
      if (group === canonicalCheck) {
        canonicalCheckCount++;
        continue;
      }
      throw new Error(
        `migrateCorpusSchema: refusing migration — table ${reviewed.table} carries ` +
          `a table-level CHECK that is not the canonical source-unit CHECK (${group}); ` +
          `the canonical strict-v2 DDL cannot represent it and a rebuild would drop ` +
          `it silently. Remove the unsupported CHECK constraint before this repair`,
      );
    }
    if (canonicalCheckCount > 1) {
      throw new Error(
        `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares ` +
          `${canonicalCheckCount} identical canonical source-unit CHECKs in stored DDL; ` +
          `the canonical strict-v2 DDL declares the canonical CHECK exactly once and a ` +
          `strict rebuild would silently drop the duplicates. Remove the duplicate ` +
          `CHECK declaration(s) before this repair`,
      );
    }

    // 2. Effective autoindex (inline/table UNIQUE / PRIMARY KEY) inventory.
    //    EXACTLY one canonical logical-identity UNIQUE autoindex must
    //    exist (`origin = 'u'`, canonical key columns, ASC, BINARY, no
    //    expression / extra key), and NO extra constraint autoindex —
    //    `sqlite_autoindex_*` entries are the physical form of
    //    user-authored table constraints and cannot be silently dropped
    //    by a rebuild. A composite PRIMARY KEY with the canonical key
    //    columns (origin = 'pk') is REJECTED — it would masquerade as
    //    the identity UNIQUE and the rebuild would silently drop it.
    //
    //    The remaining stored-DDL multiplicity check (declared
    //    UNIQUE NORMALLY vs. SQLite-coalesced autoindex) lives below:
    //    even when SQLite exposes one coalesced autoindex, a duplicate
    //    `UNIQUE (canonical_cols)` declaration in stored DDL would be
    //    silently rewritten by the rebuild's canonical DDL and the
    //    duplicate would never reappear — refusing the duplicate here
    //    (storage-side) and refusing the unexpected autoindex above
    //    (engine-side) closes the gap.
    let identitySeen = false;
    for (const a of constraintAutoIndexes(db, reviewed.table)) {
      if (isCanonicalIdentityAutoIndex(a, reviewed)) {
        identitySeen = true;
        continue;
      }
      const keySig = a.keyColumns
        .map((c) => `${c.name}${c.desc !== 0 ? " DESC" : ""}${c.coll !== "BINARY" ? ` COLLATE ${c.coll}` : ""}`)
        .join(", ");
      throw new Error(
        `migrateCorpusSchema: refusing migration — table ${reviewed.table} carries ` +
          `an unexpected ${a.origin === "pk" ? "PRIMARY KEY" : "UNIQUE"} table ` +
          `constraint (autoindex ${a.name} over (${keySig})) that is ` +
          `not its canonical logical-identity UNIQUE; the strict-v2 DDL cannot ` +
          `represent it and a rebuild would drop it and its autoindex silently. ` +
          `Remove the unsupported table constraint before this repair`,
      );
    }
    // Stored-DDL multiplicity check: count the top-level UNIQUE
    // constraint DECLARATIONS in the CREATE TABLE column list (a
    // table-level `UNIQUE (…)` / `CONSTRAINT … UNIQUE (…)`, whatever its
    // key-column spelling or name quoting). The canonical strict-v2 DDL
    // declares exactly one logical-identity UNIQUE, so more than one
    // declaration is a duplicate that a rebuild would silently reduce —
    // refused mutation-free below the engine-side autoindex check, so the
    // storage-side and engine-side gates close the multiplicity class
    // together (SQLite coalesces duplicate identical `UNIQUE (cols)`
    // declarations into a single autoindex, so the engine-side loop alone
    // cannot see them; the raw keyword count catches every spelling). A
    // missing canonical identity autoindex above is still repairable (the
    // rebuild's canonical DDL declares it); a DECLARED DUPLICATE UNIQUE on
    // top of an existing autoindex is not.
    const canonicalUniqueCount = countTopLevelUniqueDeclarations(stored);
    if (canonicalUniqueCount > 1) {
      throw new Error(
        `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares ` +
          `${canonicalUniqueCount} top-level UNIQUE constraint declarations in stored DDL; ` +
          `the canonical strict-v2 DDL declares the logical-identity UNIQUE exactly once and a strict ` +
          `rebuild would silently drop the duplicate. Remove the duplicate UNIQUE declaration(s) ` +
          `before this repair`,
      );
    }
    // A missing canonical logical-identity UNIQUE autoindex is NOT
    // refused here — the strictness repair lane rebuilds such a
    // non-extra lax predecessor once via `strictArticleDdl` /
    // `strictTransitoryDdl` (which declare the canonical UNIQUE),
    // preserving every row + stable row id. A wrong-shape identity
    // autoindex above (DESC, non-BINARY, composite PK masquerade, …)
    // is refused REPEATEDLY without mutation because the strict
    // rebuild would silently drop the user's shape and never recreate
    // it — those are the wrong-constraint refusals the work order
    // pins.

    // 2a. Canonical row identity — three-way verdict:
    //     - canonical: `id INTEGER PRIMARY KEY AUTOINCREMENT` → no
    //       rebuild needed, the rowid alias and the monotonic
    //       counter are both in force;
    //     - safely repairable: `id INTEGER PRIMARY KEY` (no
    //       AUTOINCREMENT keyword) with valid explicit integer ids →
    //       the strict rebuild adds the keyword back via
    //       `strictArticleDdl` / `strictTransitoryDdl`, preserves
    //       every row's explicit id, restores / preserves the
    //       `sqlite_sequence` high-water mark, and converges on the
    //       next call;
    //     - invalid: any of `id INTEGER` (no PK, not the rowid
    //       alias), `id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT`
    //       (NOT NULL on the column would force the staged COPY to
    //       coerce NULL ids into fresh auto-generated values,
    //       silently rewriting `(id=NULL, rowid=7)` into `id=1`),
    //       a composite PK (pk distributed across multiple columns
    //       — the rowid alias is at `pk = 1` only), a hidden /
    //       generated column, a non-`INTEGER` declared type, a
    //       non-NULL `dflt_value`, OR a predecessor with NULL /
    //       non-integer / duplicate id rows (the staged COPY into a
    //       PRIMARY KEY rejects duplicates; an auto-generated
    //       substitute would silently rewrite data).
    //
    //     SQLite's `pragma_table_xinfo` exposes the column with
    //     pk = 1, type = `INTEGER`, NOT NULL = 0, dflt_value = NULL,
    //     hidden = 0 when the canonical declaration is in force; the
    //     AUTOINCREMENT keyword itself is not in the PRAGMA output
    //     and must be inspected from stored DDL. The canonical /
    //     repairable / invalid split is the work order's structural
    //     vs. data requirement: the structural half is
    //     `idColumnHasRowidAliasShape` (column metadata only), the
    //     data half is `idColumnDataIsRepairable` (row id validity
    //     only), and the conjunction is `idColumnIsRepairableRowIdentity`.
    if (!canonicalRowIdentityMatches(db, reviewed.table)) {
      const hasRowidAliasShape = idColumnHasRowidAliasShape(db, reviewed.table);
      const hasRepairableData = idColumnDataIsRepairable(db, reviewed.table);
      if (hasRowidAliasShape && hasRepairableData) {
        // Repairable: `id INTEGER PRIMARY KEY` (no AUTOINCREMENT) with
        // valid explicit integer ids — the strict rebuild restores the
        // canonical declaration while preserving every row's explicit id.
        // Do not refuse; let the rebuild path run.
      } else {
        throw new Error(
          `migrateCorpusSchema: refusing migration — table ${reviewed.table} row identity is not the canonical ` +
            `\`id INTEGER PRIMARY KEY AUTOINCREMENT\` rowid alias and is not a safely repairable ` +
            `rowid alias either${
              hasRowidAliasShape
                ? " (the rowid-alias shape is intact but existing rows carry NULL / non-integer / duplicate ids, so the strict rebuild's COPY INTO staged would fail on the PRIMARY KEY or silently auto-generate ids)"
                : " (the column metadata is not the rowid-alias shape: expected hidden = 0, declared type INTEGER, NOT NULL = 0, dflt_value = NULL, pk = 1; the canonical strict-v2 DDL requires the exact declaration and any of `id INTEGER` (no PK), `id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT`, a non-INTEGER declared type, a non-NULL DEFAULT, a hidden / generated column, or a composite PK is noncanonical)"
            }; align the row identity declaration and/or the data before this repair`,
        );
      }
    }

    // 2b. UNIQUE conflict policy. The identity autoindex above inspects
    //     `pragma_index_xinfo`; an explicit noncanonical conflict
    //     policy on the same UNIQUE clause (`UNIQUE (...) ON CONFLICT
    //     IGNORE` / `ON CONFLICT REPLACE` / `ON CONFLICT FAIL`) is
    //     invisible to `pragma_index_list` / `pragma_index_xinfo` and
    //     must be inspected from stored DDL. The canonical schema
    //     NEVER declares an `ON CONFLICT` clause; every UNIQUE /
    //     PRIMARY KEY is the engine default ABORT. A canonical-looking
    //     autoindex on an `UNIQUE ... ON CONFLICT IGNORE` predecessor
    //     would silently keep the IGNORE policy after migration and
    //     silently drop duplicate logical rows in production.
    if (storedDdlHasOnConflictClause(stored)) {
      throw new Error(
        `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares an explicit ` +
          `\`ON CONFLICT\` clause on a UNIQUE / PRIMARY KEY constraint; the canonical strict-v2 DDL ` +
          `never declares one (every constraint uses the engine default ABORT). Remove the explicit ` +
          `conflict policy before this repair`,
      );
    }

    // 2c. FK declaration semantics not exposed by pragma_foreign_key_list.
    //     SQLite stores `DEFERRABLE` / `INITIALLY DEFERRED` / `INITIALLY
    //     IMMEDIATE` / `MATCH PARTIAL` / `MATCH FULL` / `MATCH SIMPLE` /
    //     `MATCH NONE` / duplicate `ON DELETE` / duplicate `ON UPDATE` in
    //     `sqlite_master.sql` but `pragma_foreign_key_list` reports the
    //     engine default (`match = 'NONE'`, NOT DEFERRABLE, the LAST
    //     effective action for repeated declarators) for every clause
    //     without an explicit value. Each of those is a behavior-changing
    //     wrong declaration the canonical strict-v2 DDL never represents;
    //     the audit is FK-scope (only the trailing suffix of each
    //     declared `REFERENCES …` is inspected) so a `CONSTRAINT match
    //     UNIQUE (…)` constraint NAME (or column name, comment, string
    //     literal) cannot masquerade as the FK's own MATCH / DEFERRABLE
    //     / INITIALLY suffix, and an unrelated rebuild (one that would
    //     otherwise fire) must NEVER silently normalize a duplicate
    //     `ON DELETE` declarator down to the effective single action the
    //     rebuild writes — the duplicate declaration in the stored DDL
    //     is non-representable input the strict DDL cannot reproduce.
    //     The suffix boundary stops at the next column constraint, and
    //     what it stops AT is then audited too: an executable trailing
    //     column constraint after the FK clause (named or unnamed
    //     `NOT NULL` / `COLLATE` / `UNIQUE` / `CHECK` / `DEFAULT`, a
    //     `PRIMARY KEY`, a second `REFERENCES`, …) is equally outside
    //     the reviewed inventory — the canonical FK column declarations
    //     carry no post-FK column constraints, so a strict rebuild
    //     would silently erase one, and a trailing NOT NULL on the
    //     SET NULL reference would block the canonical delete behavior
    //     the rebuild restores. Refused closed before any mutation.
    const auxIssue = storedDdlHasFkAuxiliaryClause(stored);
    if (auxIssue !== null) {
      switch (auxIssue.kind) {
        case "match":
          throw new Error(
            `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares an explicit ` +
              `\`MATCH <arg>\` clause on a foreign key (FULL / PARTIAL / SIMPLE / NONE, in any of ` +
              `the bare / single-quoted / double-quoted / backtick-quoted / bracket-quoted argument ` +
              `forms the engine accepts); pragma_foreign_key_list does not expose this and the canonical ` +
              `strict-v2 DDL never declares a MATCH clause (every FK uses the engine default). ` +
              `Remove the explicit MATCH clause before this repair`,
          );
        case "deferrable":
          throw new Error(
            `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares an explicit ` +
              `\`DEFERRABLE\` clause on a foreign key; pragma_foreign_key_list does not expose this and ` +
              `the canonical strict-v2 DDL never declares deferred semantics (every FK is the engine ` +
              `default immediate, NOT DEFERRABLE). Remove the deferrable clause before this repair`,
          );
        case "initially":
          throw new Error(
            `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares an explicit ` +
              `\`INITIALLY <DEFERRED|IMMEDIATE>\` clause on a foreign key; pragma_foreign_key_list does not ` +
              `expose this and the canonical strict-v2 DDL never declares deferred semantics (every FK is ` +
              `the engine default immediate, NOT DEFERRABLE). Remove the deferrable clause before this repair`,
          );
        case "duplicate-delete":
          throw new Error(
            `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares multiple ` +
              `\`ON DELETE\` actions on a single foreign key; pragma_foreign_key_list collapses duplicate ` +
              `declarators to the LAST effective action, so the leading declaration is invisible to the FK ` +
              `inventory audit yet persists in the stored DDL with whatever semantic the engine honored ` +
              `on creation. The canonical strict-v2 DDL declares each canonical action exactly once, and an ` +
              `unrelated rebuild must not silently reduce duplicate declarative syntax. Remove the duplicate ` +
              `ON DELETE declarator before this repair`,
          );
        case "duplicate-update":
          throw new Error(
            `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares multiple ` +
              `\`ON UPDATE\` actions on a single foreign key; pragma_foreign_key_list collapses duplicate ` +
              `declarators to the LAST effective action, so the leading declaration is invisible to the FK ` +
              `inventory audit yet persists in the stored DDL with whatever semantic the engine honored ` +
              `on creation. The canonical strict-v2 DDL declares each canonical action exactly once, and an ` +
              `unrelated rebuild must not silently reduce duplicate declarative syntax. Remove the duplicate ` +
              `ON UPDATE declarator before this repair`,
          );
        case "trailing-constraint":
          throw new Error(
            `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares an executable ` +
              `trailing column constraint after a foreign key clause (${auxIssue.text}); the canonical ` +
              `article / transitory FK column declarations carry no post-FK column constraints beyond the ` +
              `reviewed action syntax, so the strict rebuild would silently erase one — and a trailing ` +
              `\`NOT NULL\` after an ON DELETE SET NULL reference blocks the canonical SET NULL behavior ` +
              `outright. There is no exception: even a trailing \`NOT NULL\` that duplicates the column's ` +
              `own pre-REFERENCES \`NOT NULL\` is noncanonical (the canonical required column declares ` +
              `NOT NULL once, before REFERENCES, and the canonical DDL carries no redundant post-FK ` +
              `constraints), and a named \`CONSTRAINT …\` form never is. Remove the trailing column ` +
              `constraint before this repair`,
          );
      }
    }

    // 3. Effective outgoing foreign-key inventory. Every reference must
    //    be a single-column reference onto one of the canonical parents
    //    with reviewed ON UPDATE / ON DELETE / MATCH behavior (v1
    //    defaults AND v2 canonical). The referenced key must resolve to
    //    the parent's rowid/`id`. The actions matter now — a missing
    //    ON DELETE / ON UPDATE clause reads as `NO ACTION` via
    //    `pragma_foreign_key_list`, the engine default; `RESTRICT`,
    //    `SET DEFAULT`, or any other non-reviewed action is a
    //    behavior-changing wrong action and refuses the migration
    //    BEFORE the first schema write. A MISSING canonical FK
    //    (v1 legacy lacks `norma_id REFERENCES norma(id)`; the engine
    //    has no row to audit) is NOT refused — the strictness repair
    //    lane rebuilds the table once via `strictArticleDdl` which
    //    declares the canonical FKs.
    //
    //    Multiplicity is checked BEFORE the per-FK review so a
    //    duplicate of an otherwise-canonical FK cannot sneak through
    //    the review pass on the first FK and let the strict rebuild
    //    silently drop the duplicate when its DDL rewrites the
    //    outgoing inventory. Each canonical `from` column is allowed
    //    AT MOST one outgoing FK reference: a second FK on a
    //    canonical column is an unsupported extra the canonical
    //    strict-v2 DDL cannot represent (which declares each
    //    canonical FK exactly once), and a rebuild would silently
    //    drop it. Missing required FKs are still repairable — the
    //    strict rebuild's DDL re-establishes them — but duplicates
    //    of canonical FKs are not, so the migration must refuse
    //    closed here, with the exact stored DDL and data still
    //    byte-identical.
    const fkInventory = effectiveOutgoingForeignKeys(db, reviewed.table);
    const canonicalFromCounts = new Map<string, number>();
    for (const g of fkInventory) {
      canonicalFromCounts.set(
        g.from,
        (canonicalFromCounts.get(g.from) ?? 0) + 1,
      );
    }
    for (const [from, count] of canonicalFromCounts) {
      if (count > 1) {
        throw new Error(
          `migrateCorpusSchema: refusing migration — table ${reviewed.table} declares ` +
            `${count} outgoing foreign keys on canonical column \`${from}\`; the canonical ` +
            `strict-v2 DDL declares each canonical FK exactly once and a strict rebuild ` +
            `would silently drop the duplicate. Remove the duplicate foreign key before ` +
            `this repair`,
        );
      }
    }
    for (const g of fkInventory) {
      if (outgoingForeignKeyIsReviewed(reviewed, g)) continue;
      throw new Error(
        `migrateCorpusSchema: refusing migration — table ${reviewed.table} carries ` +
          `an outgoing foreign key (${g.from}) → ${g.parent}` +
          (g.toColumns.length > 0 && g.toColumns[0] !== "" && g.toColumns[0] !== "id"
            ? `(${g.toColumns.join(", ")})`
            : "") +
          ` with ON DELETE ${g.onDelete} / ON UPDATE ${g.onUpdate} / MATCH ${g.match} ` +
          `that is not one of the canonical references; the strict-v2 DDL cannot ` +
          `represent it and a rebuild would silently rewrite an explicitly ` +
          `different FK action. Remove or align the unsupported foreign key ` +
          `before this repair`,
      );
    }

    // 4. Effective per-column metadata for EVERY canonical column of
    //    the tracked table (exact stored name modulo the approved
    //    casing-repair lane, declared type, nullable / NOT NULL state,
    //    DEFAULT text, PK ordinal, ordinary-vs-generated visibility,
    //    and effective COLLATION read from the stored DDL because the
    //    PRAGMA omits it). A MISSING column is refused fail-closed here
    //    unless it is one of the two reviewed later-added omissions
    //    with a real migration lane (`extract_order` / `source_unit_id`
    //    — additive ALTERs; an absent whole table stays on the
    //    SCHEMA_DDL creation lane): the migration never regenerates or
    //    guesses values for a canonical column a present table lost. A
    //    PRESENT canonical column carrying a
    //    behavior-changing declaration the canonical DDL does not have
    //    — `hierarchy_node_id` NOT NULL before REFERENCES, a DEFAULT
    //    before or after REFERENCES, a non-BINARY COLLATE, a wrong
    //    affinity type, a generated / hidden column, a moved PK
    //    ordinal — refuses the migration here, before the first schema
    //    write and BEFORE the rebuild lane below could fire for an
    //    unrelated reason and silently rewrite the declaration. Run
    //    last so every established first-refusal gate keeps its exact
    //    verdict; this gate only closes what all of them used to
    //    bless.
    assertCanonicalColumnMetadata(db, reviewed, stored);
  }
}

/** Canonical index names this migration owns, keyed by their lowercased
 *  form so the membership test follows SQLite's case-insensitive identifier
 *  semantics (`IDX_ARTICLE_NORMA` and `idx_article_norma` resolve to the
 *  same canonical shape). Each entry is the SHAPE the canonical index
 *  binds to — its owning table, uniqueness, columns, and predicate — so
 *  the pre-write gate can detect a canonical-named index on the WRONG
 *  table and refuse the migration, while a case variant on the CORRECT
 *  owner enters the canonical repair/audit lane (not custom-object
 *  refusal). The name-as-a-set fallback is preserved for tests and
 *  callers that only need membership, not ownership. */
const CANONICAL_INDEX_BY_NAME: ReadonlyMap<string, CanonicalIndexShape> = new Map(
  CANONICAL_INDEX_SHAPES.map((shape) => [shape.name.toLowerCase(), shape]),
);
const CANONICAL_INDEX_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_INDEX_SHAPES.map((shape) => shape.name),
);

/**
 * One user-owned dependent object the strict rebuild must preserve
 * by snapshotting its EXACT stored SQL, kind, owner (tbl_name), and
 * creation order before any destructive write. The global snapshot-
 * and-recreate strategy captures EVERY user view in the main schema,
 * EVERY user trigger in the main schema, and every noncanonical user
 * index attached to any rebuild target — independent of any table-
 * reference parser — and recreates each from its exact stored SQL
 * exactly once. Drop order is deterministic and dependency-safe:
 * triggers FIRST (including INSTEAD OF triggers on views and triggers
 * attached to rebuild targets — neither survives an explicit DROP
 * after the carrier is gone), then views in REVERSE creation order
 * (the latest view depends on the earliest, so drop dependents first),
 * then custom target indexes (so DROP TABLE never sees them and the
 * recreation step recreates each exactly once). Recreation order
 * mirrors the dependency direction: targets, canonical indexes,
 * custom indexes (their tables now exist), views in natural creation
 * order (so any view-to-view reference resolves), then triggers LAST
 * (every trigger target — a rebuild table, a cross-table table, or a
 * view recreated in the previous step — must already exist for the
 * recreated CREATE TRIGGER statement to parse). Failure to drop,
 * rebuild, recreate, or audit any dependent rolls the whole
 * migration back via the outer savepoint. */
interface CapturedDependent {
  readonly kind: "trigger" | "index" | "view";
  readonly name: string;
  readonly sql: string;
  /** `sqlite_master.rowid` at capture time — the stable creation order. */
  readonly rowid: number;
  /** True when this dependent must be dropped before DROP TABLE.
   *  Always true for views, triggers, and captured custom indexes —
   *  `dropCapturedDependents` drops every captured object explicitly. */
  readonly mustDrop: boolean;
  /** True for triggers/indexes attached to a rebuild target;
   *  false for cross-table dependents (views are always cross-table;
   *  triggers can be either). */
  readonly attachedToTarget: boolean;
  /** The STORED `tbl_name` for triggers/indexes (the table the object
   *  was attached to at capture time, in the case the engine stored
   *  it under), or `null` for views (which have no `tbl_name`).
   *  Carried so the post-rebuild audit can verify the recreated
   *  object is attached to the SAME owner, not just present in
   *  `sqlite_master` under the same name. */
  readonly owner: string | null;
}

/** Snapshot every user-owned dependent the strict rebuild could drop
 *  or invalidate — taken ONCE across every rebuild target, BEFORE any
 *  write (including the FK probes). This replaces the prior
 *  per-target capture that walked an ad-hoc SQL reference parser: the
 *  parser could miss nested/comma/JOIN/CTE/table-function forms, was
 *  reset on parentheses and ON/USING, and let a destructive statement
 *  reach a rebuild target before rollback fired. The new strategy
 *  captures EVERY user view and EVERY user trigger in the main schema
 *  plus every non-canonical user index attached to any rebuild target,
 *  dedupes by kind+name, and trusts the captured SQL exactly — no
 *  parser decides whether an object is "related". Unrelated views and
 *  triggers are therefore also dropped inside the savepoint and
 *  recreated from their stored SQL; the whole database ends with the
 *  same set of user objects, byte-identical by definition.
 *
 *  Order is `sqlite_master.rowid` (the engine's stable creation
 *  order). Every captured object is dropped EXPLICITLY (triggers →
 *  views in reverse creation order → custom target indexes) and
 *  recreated in viability order (custom indexes → views in creation
 *  order → triggers last) by `dropCapturedDependents` /
 *  `recreateDependents` — nothing relies on DROP TABLE's implicit
 *  dependent-drop behavior. Each capture carries the object's EXACT
 *  stored `tbl_name` owner (null for views) so the post-rebuild audit
 *  can verify the recreated object is attached to the SAME owner. */
function captureGlobalRebuildDependents(
  db: Db,
  targetsLower: ReadonlySet<string>,
): readonly CapturedDependent[] {
  const out: CapturedDependent[] = [];
  // Every user view in the main schema. Views on rebuilt tables fail
  // DROP TABLE; views that DO NOT reference a rebuild target are also
  // captured (and dropped+recreated) so the dependency parser does not
  // decide relevance — a view the rebuild actually leaves untouched is
  // recreated from its exact stored SQL and answers identically.
  for (const v of db.query<
    Row & { name: string; sql: string | null; rowid: number }
  >(
    `SELECT name, sql, rowid FROM sqlite_master
       WHERE type = 'view' AND sql IS NOT NULL`,
  )) {
    if (!v.sql) continue;
    out.push({
      kind: "view",
      name: v.name,
      sql: v.sql,
      rowid: v.rowid,
      mustDrop: true,
      attachedToTarget: false,
      owner: null,
    });
  }
  // Every user trigger in the main schema — attached triggers
  // (`tbl_name` is a rebuild target), cross-table triggers, and
  // `INSTEAD OF` triggers on views alike. All of them are dropped
  // EXPLICITLY first (`dropCapturedDependents`): SQLite's ALTER TABLE
  // RENAME re-parses their bodies and the re-parse fails mid-rename
  // when the OLD name is gone but the NEW name is not yet present
  // (only the staged `__v2strict_<table>` carrier exists), and an
  // `INSTEAD OF` trigger's carrier view is dropped in the view phase,
  // which would take the trigger with it if it were still attached.
  for (const t of db.query<
    Row & { name: string; sql: string | null; rowid: number; tbl_name: string }
  >(
    `SELECT name, sql, rowid, tbl_name FROM sqlite_master
       WHERE type = 'trigger' AND sql IS NOT NULL`,
  )) {
    if (!t.sql) continue;
    const attached = targetsLower.has(t.tbl_name.toLowerCase());
    out.push({
      kind: "trigger",
      name: t.name,
      sql: t.sql,
      rowid: t.rowid,
      mustDrop: true,
      attachedToTarget: attached,
      // The EXACT stored `tbl_name` — the owner the recreated trigger
      // must be attached to again (case-preserving: the audit below
      // compares the stored spellings verbatim).
      owner: t.tbl_name,
    });
  }
  // Non-canonical user indexes on every rebuild target. These are
  // dropped EXPLICITLY by `dropCapturedDependents` (never left to the
  // implicit DROP TABLE behavior) and recreated once by
  // `recreateDependents`. Canonical indexes on the correct owner are
  // owned by the structural repair lane (`collectIndexRepairs`); the
  // only constraint autoindexes that can reach here are the reviewed
  // logical-identity UNIQUEs — `assertReviewedTableConstraints` refused
  // any unexpected `sqlite_autoindex_*` (a user-authored table
  // constraint, not a disposable implementation detail) before the
  // first write — and those re-form from the canonical DDL with their
  // parent table, so they are SQLite's, not user objects.
  for (const targetLower of targetsLower) {
    for (const i of db.query<
      Row & { name: string; sql: string | null; rowid: number; tbl_name: string }
    >(
      `SELECT name, sql, rowid, tbl_name FROM sqlite_master
         WHERE type = 'index' AND LOWER(tbl_name) = ?`,
      targetLower,
    )) {
      if (isSqliteAutoIndex(i.name)) continue;
      const canonical = CANONICAL_INDEX_BY_NAME.get(i.name.toLowerCase());
      if (canonical && canonical.table.toLowerCase() === targetLower) continue;
      out.push({
        kind: "index",
        name: i.name,
        sql: i.sql ?? "",
        rowid: i.rowid,
        mustDrop: true,
        attachedToTarget: true,
        owner: i.tbl_name,
      });
    }
  }
  // Dedup by ASCII-folded kind+name: two rebuild targets can share a
  // dependent (e.g. a view that reads both, a trigger attached to one
  // that reads another). Without dedupe, DROP+CREATE would race on
  // the same name and the recreation step would fail with
  // "already exists". The fold is ASCII-only (`asciiFold`), matching
  // SQLite's identifier namespace — `String.prototype.toLowerCase()`
  // collapses distinct Unicode identifiers like `Ä_idx` / `ä_idx` and
  // `Ä_tr` / `ä_tr` that the engine treats as different, which used to
  // silently drop one of every such pair from the captured set. Sort
  // by rowid for stable creation order.
  const seen = new Set<string>();
  const deduped: CapturedDependent[] = [];
  for (const dep of out) {
    const key = `${dep.kind}:${asciiFold(dep.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(dep);
  }
  deduped.sort((a, b) => a.rowid - b.rowid);
  return deduped;
}

/** Drop every captured dependent EXPLICITLY, in dependency-safe order:
 *
 *  1. triggers first, in capture (creation) order. Every trigger in the
 *     schema — attached to a rebuild target, attached to a
 *     non-rebuildable cross-table object, or an `INSTEAD OF` trigger on
 *     a view — is dropped here. `attachedToTarget` does NOT decide
 *     whether the trigger is dropped: DROP TABLE drops an attached
 *     trigger implicitly, but DROP TABLE does not run until after every
 *     view is gone, and an `INSTEAD OF` trigger's carrier view is
 *     dropped in step 2 — an explicit trigger drop MUST precede that
 *     (dropping the carrier first would take the trigger with it and
 *     the later recreate would resurrect it from stale SQL, double-
 *     creating against the captured name). Dropping each trigger here
 *     also removes the mid-rename re-parse hazard: SQLite's ALTER TABLE
 *     RENAME re-parses every dependent trigger body, and that re-parse
 *     fails mid-rename when the OLD table name is already gone and the
 *     NEW one is not yet present (only the staged `__v2strict_<table>`
 *     carrier exists).
 *  2. views next in REVERSE capture order — the LATEST view may depend
 *     on an earlier one (view-on-view chains are created in exactly the
 *     opposite direction), so dropping the newest first never removes a
 *     view another still-living view depends on. A drop failure throws
 *     and the outer savepoint rolls the whole migration back.
 *  3. custom indexes on the rebuild targets LAST — explicitly, never
 *     via the implicit DROP TABLE behavior, so no captured object's
 *     recreation ever relies on the engine's side effects and the
 *     recreate step below recreates each exactly once from its
 *     snapshot. */
function dropCapturedDependents(
  db: Db,
  dependents: readonly CapturedDependent[],
): void {
  for (const dep of dependents) {
    if (dep.kind !== "trigger") continue;
    db.run(`DROP TRIGGER ${quoteIdent(dep.name)}`);
  }
  for (const dep of [...dependents].reverse()) {
    if (dep.kind !== "view") continue;
    db.run(`DROP VIEW ${quoteIdent(dep.name)}`);
  }
  for (const dep of dependents) {
    if (dep.kind !== "index") continue;
    db.run(`DROP INDEX ${quoteIdent(dep.name)}`);
  }
}

/** Recreate every captured dependent from its exact stored SQL, in
 *  viability order (a stable `sqlite_master.rowid` order):
 *
 *  - custom indexes FIRST. Their owner tables already exist (the
 *    rebuild just recreated them; canonical indexes have been repaired
 *    by `collectIndexRepairs` before this runs) and nothing in the
 *    snapshot can depend on an index.
 *  - views next in NATURAL capture order: a view-on-view chain was
 *    created base-first, so re-running the stored SQL in creation order
 *    resolves every view-to-view reference. `CREATE VIEW` resolves its
 *    FROM targets immediately, so an out-of-order recreation would fail
 *    the whole migration.
 *  - triggers LAST. `CREATE TRIGGER` resolves the trigger's TARGET
 *    table or view immediately (a missing target is a recreation
 *    error), while the trigger BODY resolves lazily at fire time. A
 *    trigger on a view — including the `INSTEAD OF` form — therefore
 *    requires its carrier view to exist first, which the views step
 *    above has already restored; a trigger on any table (rebuild target
 *    or not) finds its target present as well.
 *
 *  Each object is recreated from the stored SQL VERBATIM (the stored
 *  text already carries the exact quoting and spelling — no identifier
 *  rewriting) and exactly once; a recreation failure throws — the outer
 *  savepoint rolls the whole migration back. */
function recreateDependents(
  db: Db,
  dependents: readonly CapturedDependent[],
): void {
  for (const dep of dependents) {
    if (dep.kind !== "index") continue;
    db.run(dep.sql);
  }
  for (const dep of dependents) {
    if (dep.kind !== "view") continue;
    db.run(dep.sql);
  }
  for (const dep of dependents) {
    if (dep.kind !== "trigger") continue;
    db.run(dep.sql);
  }
}

/** Audit the dependents that the rebuild recreated. Every captured
 *  dependent must be back in `sqlite_master` EXACTLY ONCE, with its
 *  EXACT stored SQL, and — for triggers and indexes — attached to the
 *  SAME stored owner (`tbl_name`) it carried at capture time; views
 *  carry no meaningful owner (SQLite stores the view's own name there).
 *  Beyond the master-row shape, every recreated view is BEHAVIORALLY
 *  probed: a `SELECT ... LIMIT 0` against it must resolve. SQLite
 *  parses a view's FROM targets at CREATE time, but a stored view can
 *  still be unrecreatable-in-effect (e.g. a stale `sqlite_master` row
 *  left by a rolled-back write or a hand-edited master): the probe
 *  proves the recreated view actually resolves against the rebuilt
 *  schema. Any audit failure throws — the outer savepoint rolls the
 *  whole migration back, restoring the complete pre-migration schema. */
function auditRecreatedDependents(
  db: Db,
  dependents: readonly CapturedDependent[],
): void {
  for (const dep of dependents) {
    const rows = db.query<Row & { name: string; tbl_name: string; sql: string | null }>(
      `SELECT name, tbl_name, sql FROM sqlite_master
        WHERE type = ? AND LOWER(name) = LOWER(?)`,
      dep.kind,
      dep.name,
    );
    if (rows.length !== 1) {
      throw new Error(
        `migrateCorpusSchema: dependent ${dep.kind} ${dep.name} not recreated exactly once after strict rebuild ` +
          `(found ${rows.length} master rows)`,
      );
    }
    const row = rows[0]!;
    if (row.sql !== dep.sql) {
      throw new Error(
        `migrateCorpusSchema: dependent ${dep.kind} ${dep.name} was recreated with different SQL than captured`,
      );
    }
    // Owner comparison is SEMANTIC (SQLite's case-insensitive identifier
    // namespace, ASCII-folded) but the custom index/trigger SQL itself is
    // still compared byte-exactly above — the stored SQL is the exact
    // user-authored DDL and a difference in it is a real divergence.
    // Semantic owner comparison is what makes the casing-canonicalization
    // path converge: a custom index captured on a predecessor table
    // stored under noncanonical casing (`Article`) is recreated against
    // the canonical `article` after the rebuild and the engine's own
    // `tbl_name` reports the canonical spelling. A byte-exact owner
    // comparison rejected the canonicalization forever, blocked the
    // savepoint from committing, and let the strict-rebuild path fail
    // closed on a database that was otherwise correct. ASCII-fold is
    // the fold the engine itself uses for identifier lookup; a Unicode
    // case-mismatch on the owner (e.g. `Ä` vs `ä`) still compares
    // distinct, so a real owner divergence is not masked.
    const expectedOwner = dep.kind === "view" ? dep.name : dep.owner;
    if (
      expectedOwner !== null &&
      asciiFold(row.tbl_name) !== asciiFold(expectedOwner)
    ) {
      throw new Error(
        `migrateCorpusSchema: dependent ${dep.kind} ${dep.name} is attached to ${row.tbl_name} ` +
          `but was captured attached to ${expectedOwner}`,
      );
    }
    if (dep.kind === "view") {
      // The recreated view must RESOLVE against the rebuilt schema —
      // existence in the master alone is not behavior. LIMIT 0 keeps
      // the probe O(1) on any row count.
      db.query(`SELECT 1 FROM ${quoteIdent(dep.name)} LIMIT 0`);
    }
  }
}

/**
 *  Rebuild `spec.table` into its canonical strict definition while
 *  keeping every row and every row id. The caller (the strictness
 *  repair) is responsible for capturing the EXACT stored SQL of every
 *  user-owned dependent (trigger, index, view) BEFORE this runs and
 *  for dropping the cross-table dependents and recreating every
 *  captured dependent from its stored SQL around this call. Doing the
 *  capture/drop/recreate once across ALL rebuild targets — instead of
 *  per-target with an ad-hoc table-reference parser — is what closes
 *  the parser-miss class (nested/comma/JOIN/CTE/table-function forms
 *  the parser used to skip and that let a destructive statement reach
 *  the rebuild before rollback fired).
 *
 *  Before the staged CREATE, `assertRebuildPreservesDependentRows`
 *  proves no inbound FK child row can be acted on by the predecessor
 *  drop — foreign-key suppression is never used; children and their
 *  reference semantics survive because the implicit DELETE of the drop
 *  provably acts on zero rows — and the inbound state is re-verified
 *  afterwards. The rebuild itself is the staged-create copy
 *  (`__v2strict_<table>` → DROP → RENAME) under the existing savepoint;
 *  any failure unwinds the whole migration and nothing of the rebuild
 *  is committed.
 */
function rebuildStrictV2Table(
  db: Db,
  spec: StrictV2TableSpec,
  dependantsBefore: string,
): void {
  const prior = spec.table;
  const staged = `__v2strict_${prior}`;
  if (storedObjectSql(db, "table", staged) !== undefined) {
    throw new Error(
      `migrateCorpusSchema: refusing strict rebuild — unexpected table ${staged} already exists`,
    );
  }
  // Schema-qualified names so SQLite's "TEMP shadows main" rule
  // cannot redirect any of these statements to a TEMP object of the
  // same name (e.g. a TEMP `__v2strict_article`). SQLite accepts
  // `main.<ident>` on every CREATE/INSERT/SELECT/DROP/ALTER below;
  // `quoteIdent` doubles embedded `"` exactly the way the engine's
  // identifier escape requires. The TEMP preflight above
  // (`assertNoTempSchemaObjects`) already fails closed when any TEMP
  // schema object exists on EVERY path, so this is a
  // belt-and-suspenders alignment rather than a primary guard — but
  // the alignment is what keeps the rebuild honest if the preflight
  // is ever weakened for an index-only or no-op lane.
  // `pragma_table_xinfo` (not `pragma_table_info`) so the predecessor's
  // generated / hidden columns are part of the inventory. A generated
  // `source_unit_id INTEGER GENERATED ALWAYS AS (…)` is the column the
  // predecessor actually stores values under; the prior
  // `pragma_table_info` lookup omitted it, the COPY expression then
  // fell back to the `whenAbsent: NULL` literal, and every legitimate
  // row value the predecessor had computed silently turned into NULL.
  // Reading from `pragma_table_xinfo` keeps the generated column in
  // `storedByLower`, the COPY expression references it by its STORED
  // name (SQLite evaluates the generated expression per row during
  // SELECT), and the evaluated value lands in the canonical ordinary
  // INTEGER destination column. A generated / hidden column that is
  // NOT part of the canonical column set (an unknown extra) is now
  // detected by the `extras` fail-closed gate below — the prior
  // `pragma_table_info` inventory did not see it at all.
  const priorColumns = db.query<{ name: string }>(
    `SELECT name FROM pragma_table_xinfo(?)`,
    prior,
  );
  // Column-name comparison is case-insensitive: SQLite treats `Body` and
  // `body` as the same identifier, and the column-existence probe must
  // resolve the predecessor's stored case before comparing it to the
  // canonical lowercase column list. The COPY below uses the STORED name
  // (the `priorColumns[i].name` value) so a case-variant predecessor
  // column keeps its row values intact, not a NULL forced by canonical
  // miss.
  const storedByLower = new Map<string, string>();
  for (const row of priorColumns) storedByLower.set(row.name.toLowerCase(), row.name);
  const have = new Set(storedByLower.keys());
  const wanted = new Set(spec.columns.map((column) => column.name.toLowerCase()));
  const extras = [...have].filter((name) => !wanted.has(name));
  if (extras.length > 0) {
    throw new Error(
      `migrateCorpusSchema: predecessor ${prior} carries unknown column(s) ${extras.join(", ")} — strict rebuild would drop data`,
    );
  }
  if (!have.has(spec.keyColumn.toLowerCase())) {
    throw new Error(
      `migrateCorpusSchema: predecessor ${prior} lacks its key column ${spec.keyColumn} — refusing to regenerate row ids`,
    );
  }
  const priorSeq = tableSequence(db, prior);
  // Schema-qualify every name on the rebuild path (see the note above).
  // `spec.ddl(staged)` already issues `CREATE TABLE __v2strict_<prior>`
  // unqualified; the rebuild below addresses it explicitly with
  // `main.__v2strict_<prior>` on every reference. The unqualified
  // CREATE in the DDL string remains correct because no TEMP object
  // exists (the preflight above is a verdict on the untouched database
  // and refused if any did); schema-qualifying the CREATE itself would
  // mean re-quoting the canonical builders, so we leave the canonical
  // text verbatim and qualify every reference to it from this lane.
  db.run(spec.ddl(staged));
  const mainStaged = quoteMainIdent(staged);
  const mainPrior = quoteMainIdent(prior);
  const columns = spec.columns.map((column) => column.name).join(", ");
  const expressions = spec.columns
    .map((column) => {
      const stored = storedByLower.get(column.name.toLowerCase());
      return stored !== undefined ? stored : column.whenAbsent;
    })
    .join(", ");
  db.run(
    `INSERT INTO ${mainStaged} (${columns}) SELECT ${expressions} FROM ${mainPrior} ORDER BY ${spec.keyColumn} ASC`,
  );
  db.run(`DROP TABLE ${mainPrior}`);
  db.run(`ALTER TABLE ${mainStaged} RENAME TO ${prior}`);
  if (priorSeq !== undefined) {
    // After the rebuild the canonical sequence row may live under a name
    // SQLite tracks as the staged-table-renamed entry (`__v2strict_…`
    // becomes the canonical lowercase on rename). A case-variant predecessor
    // would have stored its row under the case the CREATE used, and the
    // existing entry's exact name (now `__v2strict_<prior>` before the
    // rename) is what `name = ?` matches case-sensitively. Use the
    // same case-insensitive lookup the rest of the migration uses to find
    // and rewrite it.
    const existingSeq = db.query<{ name: string }>(
      `SELECT name FROM sqlite_sequence WHERE LOWER(name) = LOWER(?)`,
      prior,
    )[0];
    const currentSeq = tableSequence(db, prior);
    if (currentSeq === undefined) {
      db.run(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`, prior, priorSeq);
    } else if (priorSeq > currentSeq) {
      if (existingSeq && existingSeq.name !== prior) {
        db.run(`UPDATE sqlite_sequence SET name = ?, seq = ? WHERE name = ?`, prior, priorSeq, existingSeq.name);
      } else {
        db.run(`UPDATE sqlite_sequence SET seq = ? WHERE name = ?`, priorSeq, prior);
      }
    }
  }
  // Belt-and-suspenders (finding 1): the pre-write proof said no child
  // row could be acted on; verify the dependents' FK clauses and row
  // counts really survived the swap. Any surprise aborts the whole
  // migration via the outer savepoint — nothing half-preserved is
  // ever committed.
  const dependantsAfter = inboundReferenceState(db, spec);
  if (dependantsAfter !== dependantsBefore) {
    throw new Error(
      `migrateCorpusSchema: inbound dependents of ${prior} changed during strict rebuild — aborting`,
    );
  }
}

/**
 * The strictness repair: inspect the EFFECTIVE shape of the corpus-v2
 * objects (not just their names — comment-stripped CHECK extraction for
 * tables, PRAGMA-level structural inspection for indexes) and tighten
 * every lax one. Destructive work (a table rebuild or an index
 * drop+recreate) happens only after `assertRebuildPreservesDependentRows`
 * has proven no inbound dependent row can be touched, and the whole
 * repair runs inside the single savepoint `migrateCorpusSchema` owns —
 * so it all-commits or leaves the complete pre-migration schema and data
 * verbatim, standalone and under a caller transaction alike. Purely
 * additive index creation needs no teardown and runs statement-by-
 * statement exactly as the old additive gates did, keeping fresh-build
 * artifact bytes stable (the release lock pins them). Returns true only
 * when it actually rebuilt or re-created something — a healthy database
 * pays a read-only inspection and no bytes move.
 *
 * The rebuild safety strategy replaces the prior per-target table-
 * reference parser with a single GLOBAL snapshot taken BEFORE the
 * first write: every user view in the main schema, every user trigger
 * in the main schema, and every non-canonical user index attached to
 * any rebuild target. The captured set is deduped by case-insensitive
 * kind+name, sorted by `sqlite_master.rowid` for stable creation
 * order. The drop and recreate phases then run ONCE around the entire
 * rebuild set, so a multi-target migration can never double-drop /
 * double-create the same object and an unrelated view that survives
 * the rebuild is restored from its stored SQL byte-for-byte. The
 * table-reference parser (`sqlTableReferences` / `sqlReferencesTable`)
 * is no longer consulted for safety decisions.
 */
function repairLooseV2Shapes(db: Db): boolean {
  const rebuilds = STRICT_V2_TABLE_SPECS.filter((spec) =>
    tableNeedsStrictRebuild(db, spec),
  );
  const pending = collectIndexRepairs(db);
  if (rebuilds.length === 0 && pending.length === 0) {
    return false;
  }
  if (rebuilds.length === 0 && pending.every((repair) => !repair.present)) {
    // Additive-only: canonical indexes are simply absent (a fresh or v1
    // database reaching the v2 shape for the first time). Nothing is
    // dropped here, so each CREATE runs as its own statement.
    for (const repair of pending) db.run(repair.ddl);
    return true;
  }
  try {
    // ONE global snapshot, BEFORE the FK probes and any destructive
    // write. Every user view in the main schema, every user trigger,
    // and every noncanonical user index attached to any rebuild
    // target. Deduped by case-insensitive kind+name so two rebuild
    // targets that share a dependent (e.g. a view referencing both,
    // a trigger attached to one that reads the other) never trigger a
    // double-drop / double-create race.
    const targetsLower = new Set(rebuilds.map((spec) => spec.table.toLowerCase()));
    const allDependents = captureGlobalRebuildDependents(db, targetsLower);

    // FK pre-write proof for every rebuild target. The whole-database
    // preflight above (`assertNoDatabaseForeignKeyViolations`) already
    // refused a pre-existing FK violation; this per-target probe
    // proves no inbound child row could be acted on by the predecessor
    // drop. Failure of any probe rolls the whole migration back.
    for (const spec of rebuilds) assertRebuildPreservesDependentRows(db, spec);

    // Capture the inbound-FK fingerprint for each rebuild target so the
    // post-rebuild comparison has the right baseline.
    const dependantsBeforeByTarget = new Map<string, string>();
    for (const spec of rebuilds) {
      dependantsBeforeByTarget.set(spec.table, inboundReferenceState(db, spec));
    }

    // Drop every captured dependent EXPLICITLY, dependency-safe: ALL
    // triggers first (target-attached and `INSTEAD OF` view triggers
    // alike — the view carrier is about to be dropped and would take
    // an INSTEAD OF trigger with it), then ALL views in reverse
    // creation order, then the captured custom target indexes. After
    // this loop the rebuild targets carry no captured dependent at
    // all, so neither the mid-rename trigger re-parse nor the DROP
    // TABLE implicit-drop behavior is ever relied on.
    dropCapturedDependents(db, allDependents);

    // Rebuild every target. Each rebuild stages a canonical copy and
    // swaps it in via DROP+RENAME under the same savepoint.
    for (const spec of rebuilds) {
      rebuildStrictV2Table(
        db,
        spec,
        dependantsBeforeByTarget.get(spec.table) ?? "",
      );
    }

    // Canonical index repair — recomputed AFTER the rebuilds because
    // dropping a table takes its indexes with it and the audit must
    // see the fresh (empty) state.
    for (const repair of collectIndexRepairs(db)) {
      if (repair.present) db.run(`DROP INDEX ${repair.name}`);
      db.run(repair.ddl);
    }

    // Recreate every captured dependent from its exact stored SQL,
    // once across all targets (deduped), in viability order — custom
    // indexes, then views in natural creation order, then triggers
    // last (a trigger's target, including a recreated `INSTEAD OF`
    // carrier view, must already exist for CREATE TRIGGER to parse).
    // A failure here throws and the outer savepoint rolls the whole
    // migration back; nothing half-preserved is ever committed.
    recreateDependents(db, allDependents);

    // Audit: every captured dependent must be back in sqlite_master
    // exactly once, byte-identical by stored SQL, attached to the
    // SAME owner it was captured on, and — for views — actually
    // resolving against the rebuilt schema.
    auditRecreatedDependents(db, allDependents);

    // Whole-database FK check (finding 2): the per-rebuilt-table
    // probe only walked the rebuilt parent's outgoing FKs and missed
    // orphan rows an inbound child may now carry against the rebuilt
    // table. A bare `PRAGMA foreign_key_check` walks every row of
    // every table — every affected inbound child AND every outgoing
    // FK of the rebuilt parent — and fails the migration closed on
    // any violation.
    const violations = db.query<Row>(`PRAGMA foreign_key_check`);
    if (violations.length > 0) {
      throw new Error(
        `migrateCorpusSchema: foreign_key_check failed after strict rebuild — ${JSON.stringify(violations)}`,
      );
    }
    return true;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (detail.includes("strict corpus-v2 shape repair failed")) throw cause;
    throw new Error(
      `migrateCorpusSchema: strict corpus-v2 shape repair failed — pre-migration schema and data left intact (${detail})`,
    );
  }
}

function insertNorma(
  db: Db,
  meta: NormaMeta,
  norma: ExtractedNorma,
  run: (sql: string, ...params: unknown[]) => void,
): void {
  // Compute content_hash from the concatenated verbatim article bodies —
  // the change-detection key for the corpus. SHA-256 (hex) is the de-facto
  // standard, available natively in Node via the global `crypto` module.
  const contentHash = computeContentHash(norma);
  const importedAt = meta.importedAt ?? new Date().toISOString();
  // UPSERT: delete the prior version (cascades) then insert fresh. Cheaper
  // than ON CONFLICT DO UPDATE because we need to clear articles /
  // hierarchy_node anyway (their FKs point at the old norma id).
  // L-01: the DELETE below cascades to this norma's `article` rows, and a
  // contentless FTS5 index does NOT follow its source rows. The entries
  // have to be removed with the exact values they were indexed with —
  // which are still readable from the article rows right now. A previous
  // version left them behind as permanent ghosts (masked from search by
  // the JOIN, but growing the exported library forever).
  unindexArticlesOfNorma(db, meta.idFichaNorma, run);
  run(
    `DELETE FROM norma WHERE id = ?`,
    meta.idFichaNorma,
  );
  run(
    `INSERT INTO norma (id, version_id, number, name, tipo, date, source_url, content_hash, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    meta.idFichaNorma,
    meta.idVersionNorma,
    meta.number,
    meta.name,
    meta.tipo,
    meta.date,
    meta.sourceUrl,
    contentHash,
    importedAt,
  );
}

/**
 * L-01 — remove the `article_fts` entries of every article currently
 * stored for `normaId`, using the delete-form of a contentless table.
 *
 * MUST run while the `article` rows still exist: FTS5 needs the exact
 * indexed values, and the source rows are the only place they are kept.
 */
function unindexArticlesOfNorma(
  db: Db,
  normaId: number,
  run: (sql: string, ...params: unknown[]) => void,
): void {
  if (!tableExists(db, "article_fts")) return;
  const rows = db.query<Row & { id: number; number: string; body: string }>(
    `SELECT id, number, body FROM article WHERE norma_id = ? ORDER BY id ASC`,
    normaId,
  );
  for (const r of rows) {
    run(
      `INSERT INTO article_fts (article_fts, rowid, number, body)
       VALUES ('delete', ?, ?, ?)`,
      r.id,
      r.number,
      r.body,
    );
  }
}

/**
 * SHA-256 of the concatenated verbatim article bodies, in document
 * order. Acts as the change-detection key: if the body text changes
 * (or articles are added/removed), the hash changes. The function is
 * pure with respect to the inputs (no Date.now, no Math.random).
 */
export function computeContentHash(norma: ExtractedNorma): string {
  return computeCorpusContentIdentity(norma.articles);
}

/**
 * Hash an arbitrary text blob (e.g. a ruling's body) with the same
 * FNV-1a 64-bit hash family the corpus uses for `content_hash`. One
 * definition, two callers — server and client use the same change-
 * detection key.
 */
export function computeTextHash(text: string): string {
  return computeCorpusTextHash(text);
}

/**
 * Insert hierarchy nodes in document order and reconstruct parent links.
 * Returns a list of node ids (one per extractor HierarchyNode, in order) so
 * articles can resolve to the deepest node currently in force for them.
 *
 * Parent reconstruction: a node's parent is the most recent PRIOR node at a
 * strictly SHALLOWER level. e.g. the parent of a CAPÍTULO is the most recent
 * prior TÍTULO; the parent of a SECCIÓN is the most recent prior CAPÍTULO (or
 * TÍTULO, if no CAPÍTULO appeared). TÍTULOs have parent NULL.
 */
function insertHierarchy(
  db: Db,
  normaId: number,
  hierarchy: HierarchyNode[],
  run: (sql: string, ...params: unknown[]) => void,
): number[] {
  // Per-level last-seen node id. libro=0, titulo=1, capitulo=2, seccion=3.
  const lastIdByLevel: (number | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  const ids: number[] = [];

  for (let i = 0; i < hierarchy.length; i++) {
    const node = hierarchy[i]!;
    const level = KIND_LEVEL[node.kind];

    // Find the deepest level strictly shallower than this one with a known id.
    let parentId: number | null = null;
    for (let L = level - 1; L >= 0; L--) {
      if (lastIdByLevel[L] !== undefined) {
        parentId = lastIdByLevel[L]!;
        break;
      }
    }

    // Truncate deeper-level "last seen" — a new LIBRO resets TÍTULO +
    // CAPÍTULO + SECCIÓN; a new TÍTULO resets CAPÍTULO + SECCIÓN; etc.
    for (let L = level; L < lastIdByLevel.length; L++) {
      lastIdByLevel[L] = undefined;
    }
    lastIdByLevel[level] = insertHierarchyNode(db, normaId, node, i, parentId, run);
    ids.push(lastIdByLevel[level]!);
  }
  return ids;
}

function insertHierarchyNode(
  db: Db,
  normaId: number,
  node: HierarchyNode,
  docOrder: number,
  parentId: number | null,
  run: (sql: string, ...params: unknown[]) => void,
): number {
  run(
    `INSERT INTO hierarchy_node (norma_id, kind, label, display_label, doc_order, extract_order, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    normaId,
    node.kind,
    node.label,
    node.displayLabel ?? null,
    docOrder,
    node.extractOrder ?? null,
    parentId,
  );
  const rows = db.query<{ id: number }>(
    `SELECT last_insert_rowid() AS id`,
  );
  return rows[0]!.id;
}

/**
 * Insert articles and link each to the deepest hierarchy node in force at
 * its position. Linkage uses the extractor's unambiguous `hierarchyIndex`
 * (an index into `hierarchy[]` assigned from the extractor's live heading
 * stack) — NOT label matching, which is ambiguous because "CAPITULO
 * PRIMERO" recurs under every título. The parallel `hierarchyIds[]` array
 * maps the extractor index to the inserted DB row id.
 */
function insertArticles(
  db: Db,
  normaId: number,
  articles: Article[],
  hierarchyIds: number[],
  run: (sql: string, ...params: unknown[]) => void,
): void {
  for (let i = 0; i < articles.length; i++) {
    const art = articles[i]!;
    const hierarchyNodeId =
      art.hierarchyIndex !== undefined && art.hierarchyIndex !== null
        ? (hierarchyIds[art.hierarchyIndex] ?? null)
        : null;
    run(
      `INSERT INTO article (norma_id, number, ordinal_raw, body, ficha_ref, hierarchy_node_id, doc_order, extract_order, source_unit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      normaId,
      art.number,
      art.ordinalRaw,
      art.body,
      art.fichaRef ?? null,
      hierarchyNodeId,
      i,
      art.extractOrder ?? null,
      art.sourceUnitId ?? null,
    );
    // FTS5 contentless index: index the body+number, mapping back to article.id.
    const articleId = db.query<{ id: number }>(
      `SELECT last_insert_rowid() AS id`,
    )[0]!.id;
    run(
      `INSERT INTO article_fts (rowid, number, body) VALUES (?, ?, ?)`,
      articleId,
      art.number,
      art.body,
    );
  }
}

/**
 * M-LAW-10 — store the STANDALONE transitory provisions of a norma.
 *
 * Same hierarchy-linkage rule as `insertArticles` (the extractor's
 * `hierarchyIndex` resolved through `hierarchyIds`), same document-order
 * discipline (`doc_order` = position in the array, `extract_order` = the
 * global coordinate shared with articles and nodes).
 *
 * S-INI (corpus schema v2): the old lossy `INSERT OR IGNORE` is GONE.
 * Inputs are prevalidated (`assertSourceUnitNamespace` + the explicit
 * logical-identity duplicate probe below); a repeated
 * (norma_id, number, attaches_to) identity aborts the whole authority
 * write instead of silently dropping a provision row.
 */
function insertTransitories(
  db: Db,
  normaId: number,
  transitories: TransitoryProvision[],
  hierarchyIds: number[],
  run: (sql: string, ...params: unknown[]) => void,
): void {
  if (!tableExists(db, "transitory_provision")) return;
  const seenIdentities = new Set<string>();
  for (const t of transitories) {
    const key = `${t.number}\u0000${t.attachesTo ?? ""}`;
    if (seenIdentities.has(key)) {
      throw new Error(
        "insertTransitories: duplicate transitory logical identity — strict persistence rejects lossy writes",
      );
    }
    seenIdentities.add(key);
  }
  for (let i = 0; i < transitories.length; i++) {
    const t = transitories[i]!;
    const hierarchyNodeId =
      t.hierarchyIndex !== undefined && t.hierarchyIndex !== null
        ? (hierarchyIds[t.hierarchyIndex] ?? null)
        : null;
    run(
      `INSERT INTO transitory_provision
         (norma_id, number, ordinal_raw, attaches_to, body, label,
          hierarchy_node_id, doc_order, extract_order, source_unit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      normaId,
      t.number,
      t.ordinalRaw,
      t.attachesTo ?? "",
      t.body,
      t.label ?? `Transitorio ${t.number}`,
      hierarchyNodeId,
      i,
      t.extractOrder ?? null,
      t.sourceUnitId ?? null,
    );
  }
}
