/**
 * Node-side one-time setup: register the sql.js-fts5 initializer with the
 * portable core (database.ts). The browser/Tauri webview ships its own
 * equivalent setup that fetches the .wasm binary over HTTP.
 *
 * This file is Node-only — it reads the .wasm binary from disk. The core
 * (build.ts / query.ts / index-tree.ts) imports only `database.ts` and never
 * touches `node:fs`, so it stays portable.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import initSqlJs from "sql.js-fts5";
import { setSqlJsInit } from "./database.js";

let configured = false;

/**
 * Idempotently register the sql.js-fts5 initializer. Safe to call from any
 * test file's setup or from the Node bootstrap entry point.
 */
export function configureSqlJsOnce(): void {
  if (configured) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const wasmPath = resolve(
    here,
    "..",
    "..",
    "node_modules",
    "sql.js-fts5",
    "dist",
    "sql-wasm.wasm",
  );
  const wasmBinary = readFileSync(wasmPath);
  setSqlJsInit(async () => initSqlJs({ wasmBinary }));
  configured = true;
}