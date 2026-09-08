/**
 * Portable SQLite access via sql.js-fts5 (WASM SQLite with FTS5 compiled in).
 *
 * The Db interface is intentionally tiny so the core build/query modules never
 * depend on the sql.js-fts5 module. The SQL engine is resolved through an
 * injected initializer (see `setSqlJsInit`), exactly mirroring how the
 * extractor resolves DOMParser via dom-shim.ts:
 *
 *   - In Node (bootstrap + tests): a setup file imports sql.js-fts5, reads
 *     the .wasm binary from disk, and registers the initializer once at start.
 *   - In a browser/Tauri webview: the bundler/host loads the .wasm binary
 *     (e.g. fetch + ArrayBuffer) and registers the same initializer.
 *
 * The core db modules (build.ts, query.ts, index-tree.ts) call `getSqlJsInit()`
 * indirectly via `createDatabase()` / `loadDatabase()` and never see sql.js-fts5.
 */

/** A single row from a query, keyed by column name. */
export type Row = Record<string, unknown>;

/**
 * Minimal, portable DB handle. Everything build.ts/query.ts/index-tree.ts
 * touches lives on this surface — never on the sql.js-fts5 Database type.
 */
export interface Db {
  /** Run a statement with no result (DDL/DML). Binds `?` to params in order. */
  run(sql: string, ...params: unknown[]): void;
  /** Run a query and return rows (empty if none). Throws on error. */
  query<T extends Row = Row>(sql: string, ...params: unknown[]): T[];
  /** Export the whole DB to a portable Uint8Array (sql.js `.export()`). */
  export(): Uint8Array;
  /**
   * Atomically replace the wrapped sql.js handle while preserving this Db
   * object's identity. The replacement is fully opened and FK-enforced before
   * the prior handle is retired; failure leaves the prior handle installed.
   */
  replaceWith?(bytes: Uint8Array): void;
  /** Close the DB and free WASM memory. */
  close(): void;
}

/** sql.js-fts5 initializer — returns the SQL namespace (the `SQL` object). */
export interface SqlJsInit {
  (): Promise<SqlJsNamespace>;
}

/** Minimal surface of the sql.js-fts5 `SQL` namespace we use. */
export interface SqlJsNamespace {
  Database: new (data?: Uint8Array | null) => SqlJsDatabase;
}

/** Minimal surface of the sql.js-fts5 `Database` class we use. */
export interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): QueryExecResult[];
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

export interface SqlJsStatement {
  bind(params: unknown[]): boolean;
  step(): boolean;
  get(): unknown[];
  getColumnNames(): string[];
  free(): void;
}

export interface QueryExecResult {
  columns: string[];
  values: unknown[][];
}

let cachedInit: SqlJsInit | undefined;

/** Register the sql.js-fts5 initializer (called once at process start). */
export function setSqlJsInit(init: SqlJsInit): void {
  cachedInit = init;
}

function getInit(): SqlJsInit {
  if (!cachedInit) {
    throw new Error(
      "No sql.js-fts5 initializer registered. Call setSqlJsInit() once " +
        "at process start (see database-init.node.ts / the browser setup).",
    );
  }
  return cachedInit;
}

/** Create an empty in-memory database. */
export async function createDatabase(): Promise<Db> {
  const SQL = await getInit()();
  const db = new SQL.Database();
  return wrap(db, SQL);
}

/** Load a database from a previously exported Uint8Array (client-side reload). */
export async function loadDatabase(bytes: Uint8Array): Promise<Db> {
  const SQL = await getInit()();
  const db = new SQL.Database(bytes);
  return wrap(db, SQL);
}

/** Export the whole DB to a portable Uint8Array — the ship-to-client artifact. */
export function exportDatabase(db: Db): Uint8Array {
  return db.export();
}

function wrap(initialDb: SqlJsDatabase, SQL: SqlJsNamespace): Db {
  let db = initialDb;
  try {
    enableForeignKeys(db);
  } catch (cause) {
    // The raw handle exists but no Db wrapper was ever returned, so no
    // caller can close it: close it exactly once here, swallow any close
    // failure, and rethrow the original FK-enable failure.
    try {
      db.close();
    } catch {
      // the FK-enable failure is the verdict; cleanup must not mask it
    }
    throw cause;
  }
  return {
    run(sql: string, ...params: unknown[]): void {
      if (params.length === 0) {
        // No params: allow multi-statement DDL via exec().
        db.exec(sql);
      } else {
        // sql.js-fts5's db.run signature is (sql, paramsArray). It does NOT
        // accept a variadic list. Wrap the spread args in a single array.
        db.run(sql, params);
      }
    },
    query<T extends Row = Row>(sql: string, ...params: unknown[]): T[] {
      let results: QueryExecResult[];
      if (params.length === 0) {
        results = db.exec(sql);
      } else {
        // sql.js-fts5's db.exec does NOT bind params. Use a prepared statement
        // for parameterized queries so `?` placeholders actually bind.
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params);
          results = [];
          const cols = stmt.getColumnNames();
          const values: unknown[][] = [];
          while (stmt.step()) {
            values.push(stmt.get());
          }
          if (values.length > 0) {
            results.push({ columns: cols, values });
          }
        } finally {
          stmt.free();
        }
      }
      if (results.length === 0) return [];
      const r = results[0]!;
      const cols = r.columns;
      return r.values.map((vals) => {
        const row: Row = {};
        for (let i = 0; i < cols.length; i++) {
          row[cols[i]! as string] = vals[i];
        }
        return row as T;
      });
    },
    export(): Uint8Array {
      const bytes = db.export();
      // sql.js export closes and reopens its SQLite connection, which resets
      // connection-local PRAGMAs. Keep the still-live source handle enforced.
      enableForeignKeys(db);
      return bytes;
    },
    replaceWith(bytes: Uint8Array): void {
      let replacement: SqlJsDatabase | null = null;
      try {
        replacement = new SQL.Database(new Uint8Array(bytes));
        enableForeignKeys(replacement);
      } catch (cause) {
        try {
          replacement?.close();
        } catch {
          // The still-installed prior handle remains authoritative.
        }
        throw cause;
      }
      const prior = db;
      db = replacement;
      try {
        prior.close();
      } catch {
        // Replacement is already installed; a prior-handle cleanup failure
        // must not roll visibility back to stale state.
      }
    },
    close(): void {
      db.close();
    },
  };
}

function enableForeignKeys(db: SqlJsDatabase): void {
  db.run("PRAGMA foreign_keys = ON");
}
