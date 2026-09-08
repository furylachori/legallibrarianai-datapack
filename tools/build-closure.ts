/**
 * Build-lane import-closure walker (CORPUS-SPLIT slice B0).
 *
 * Walks the static (plus dynamic `import(...)`) module graph of the
 * standalone corpus build entry `scripts/build-corpus-artifact.ts` using
 * the TypeScript compiler API and reports every reachable repo source
 * plus every external the lane needs. B1 consumes the committed output
 * (`data/build-closure.json`) as the exact file list to vendor/allowlist
 * in the public data repo.
 *
 * Rules:
 *  - source files only: relative imports are followed (`.js` suffix
 *    remapped to `.ts`, the repo's ESM convention); `node:` imports are
 *    recorded as builtin; bare specifiers are recorded as npm packages;
 *  - deterministic output: every list is sorted, object keys are fixed;
 *  - import-safe: importing this module performs no walk, read, or write
 *    (the walk runs only through `computeBuildClosure` or the CLI below).
 *
 * Substitution note (recorded in `data/BUILD-DEPS-DECISION.md`): the plan
 * named `npx madge`, which is not installable offline, so this walker
 * uses the already-vendored TypeScript compiler API instead.
 */
import { builtinModules } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

export interface BuildClosureReport {
  readonly entry: string;
  readonly files: readonly string[];
  readonly externals: {
    readonly npm: readonly string[];
    readonly builtin: readonly string[];
  };
}

const BUILTINS = new Set<string>();
for (const name of builtinModules) {
  BUILTINS.add(name);
  BUILTINS.add(name.startsWith("node:") ? name.slice("node:".length) : `node:${name}`);
}

/** Bare specifier to its package name (`@scope/name` or first segment). */
function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) {
    const slash = specifier.indexOf("/");
    return slash < 0 ? specifier : specifier.slice(0, slash);
  }
  const slash = specifier.indexOf("/");
  return slash < 0 ? specifier : specifier.slice(0, slash);
}

/** Collect every module specifier in one source file (static + dynamic). */
function specifiersOf(sourceFile: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0]!;
      if (ts.isStringLiteralLike(arg)) found.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Resolve a relative specifier against its importer to an absolute `.ts`
 * path, or `undefined` when the target does not exist on disk. Mirrors
 * the repo's ESM convention (`./x.js` means `./x.ts`).
 */
function resolveRelative(specifier: string, importerAbs: string): string | undefined {
  const base = resolve(dirname(importerAbs), specifier);
  const candidates: string[] = [base];
  if (base.endsWith(".js")) candidates.push(base.slice(0, -".js".length) + ".ts");
  candidates.push(`${base}.ts`, `${base}.d.ts`, resolve(base, "index.ts"));
  for (const candidate of candidates) {
    try {
      if (ts.sys.fileExists(candidate)) return candidate;
    } catch {
      // A throwing stat is "not found" for closure purposes.
    }
  }
  return undefined;
}

function toRepoRelative(abs: string, repoRoot: string): string {
  return abs.startsWith(repoRoot + sep) ? abs.slice(repoRoot.length + 1).split(sep).join("/") : abs;
}

/**
 * Compute the deterministic import closure of `entryAbs` (absolute path
 * to the build entry). `repoRoot` anchors repo-relative output paths.
 * Throws when a relative import cannot be resolved on disk (fail-closed:
 * a silently dropped edge would understate the vendor list).
 */
export function computeBuildClosure(entryAbs: string, repoRoot: string): BuildClosureReport {
  const entry = resolve(entryAbs);
  const root = resolve(repoRoot);
  const files: string[] = [];
  const seen = new Set<string>();
  const npm = new Set<string>();
  const builtin = new Set<string>();
  const queue: string[] = [entry];
  seen.add(entry);
  while (queue.length > 0) {
    const current = queue.shift()!;
    let text: string;
    try {
      const read = ts.sys.readFile(current);
      if (read === undefined) throw new Error(`unreadable source file ${current}`);
      text = read;
    } catch (error) {
      throw new Error(`build closure cannot read ${toRepoRelative(current, root)}: ${(error as Error).message}`);
    }
    files.push(toRepoRelative(current, root));
    const sourceFile = ts.createSourceFile(current, text, ts.ScriptTarget.ES2022, false);
    for (const specifier of specifiersOf(sourceFile)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(specifier, current);
        if (resolved === undefined) {
          throw new Error(
            `build closure cannot resolve relative import ${JSON.stringify(specifier)} from ${toRepoRelative(current, root)}`,
          );
        }
        if (!seen.has(resolved)) {
          seen.add(resolved);
          queue.push(resolved);
        }
      } else if (specifier.startsWith("node:") || BUILTINS.has(specifier)) {
        builtin.add(specifier.startsWith("node:") ? specifier : `node:${specifier}`);
      } else {
        npm.add(packageNameOf(specifier));
      }
    }
  }
  files.sort();
  return {
    entry: toRepoRelative(entry, root),
    files: Object.freeze(files),
    externals: {
      npm: Object.freeze([...npm].sort()),
      builtin: Object.freeze([...builtin].sort()),
    },
  };
}

/** Render the canonical committed bytes for a report (single formatter). */
export function renderClosureJson(report: BuildClosureReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Direct-entry decision, mirroring the `builderEntryRequested` launcher
 * contract in `scripts/build-corpus-artifact.ts`: `node <file>` names this
 * module as argv[1]; plain `vite-node <file>` strips the target so argv[1]
 * names the launcher bin (accepted when not under a Vitest worker, where
 * argv[1] is the pool worker entry instead). Emitting JSON to stdout is
 * the only effect, so the documented launcher ambiguity is harmless here.
 */
function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const selfHref = import.meta.url;
  if (selfHref === pathToFileURL(resolve(entry)).href) return true;
  const base = entry.split(sep).pop() ?? "";
  const launcher = base === "vite-node" || base === "vite-node.mjs";
  const underWorker =
    (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== undefined;
  return launcher && entry.includes("node_modules") && !underWorker;
}

if (isDirectEntry()) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");
  const entry = resolve(here, "build-corpus-artifact.ts");
  process.stdout.write(renderClosureJson(computeBuildClosure(entry, repoRoot)));
}
