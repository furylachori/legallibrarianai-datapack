/**
 * Classified public-only corpus inventory (CORPUS-SPLIT slice B0).
 *
 * Walks `corpus-sources/` and emits one entry per file
 * `{ path, verdict: public|quarantined|deny, provenance, reason }` for the
 * GATE-2a content check and the B1 data-CI content gate. Rule order is
 * load-bearing (deny first, so a deny-shaped name can never slip through
 * as public):
 *
 *  1. basename matches a `PRIVATE_RULING_DENY_BASENAMES` pattern → `deny`
 *     (private advisory products — dictámenes/criterios — are outside the
 *     Ley 6683 art. 75 legislative-reproduction basis in
 *     `LEGAL_CORPUS_NOTICE.txt` and must never ship in the public pack);
 *  2. raw capture (`*.raw.json.gz`) → `quarantined`, never public
 *     (unreviewed fetch bytes; only the reviewed sidecar may ship);
 *  3. reviewed capture traceable to the committed reviewed input catalog
 *     (`*.capture.json` listed as a catalog `sidecarPath`) → `public`
 *     with per-file provenance (slug + authority/version);
 *  4. the reviewed input catalog itself → `public` (committed build
 *     metadata, not a capture);
 *  5. anything else → `deny` with reason `unmatched-rule` (nothing is
 *     silently included).
 *
 * Deterministic output: files are walked in sorted order and the renderer
 * (`renderInventoryJson`) is the single formatter the committed
 * `data/corpus-inventory.json` and the regression test share.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type InventoryVerdict = "public" | "quarantined" | "deny";

export interface InventoryEntry {
  readonly path: string;
  readonly verdict: InventoryVerdict;
  readonly provenance: string;
  readonly reason: string;
}

export interface CorpusInventory {
  readonly generatedBy: string;
  readonly root: string;
  readonly entries: readonly InventoryEntry[];
}

/**
 * Private-ruling deny patterns: basename shapes of non-legislative PGR
 * advisory products (dictámenes, criterios, pronunciamientos, consultas)
 * plus their English equivalents. No file in `corpus-sources/` matches
 * today — the gate is forward-looking: B1's data CI re-asserts these on
 * every change so a private ruling can never enter the public pack.
 */
export const PRIVATE_RULING_DENY_BASENAMES: readonly RegExp[] = Object.freeze([
  /dictamen/i,
  /criterio/i,
  /pronunciamiento/i,
  /consulta/i,
  /opinion/i,
  /ruling/i,
  /private/i,
]);

export function matchesDenyPattern(basename: string): boolean {
  return PRIVATE_RULING_DENY_BASENAMES.some((pattern) => pattern.test(basename));
}

interface CatalogCapture {
  readonly slug: string;
  readonly authorityId: number;
  readonly versionId: number;
  readonly sidecarPath: string;
  readonly gzipPath: string;
}

function readCatalog(repoRoot: string): CatalogCapture[] {
  const catalogPath = resolve(repoRoot, "corpus-sources", "v1", "reviewed-input-catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    authorities: {
      slug: string;
      authorityId: number;
      versionId: number;
      capture: { gzipPath: string; sidecarPath: string };
    }[];
  };
  return catalog.authorities.map((entry) => ({
    slug: entry.slug,
    authorityId: entry.authorityId,
    versionId: entry.versionId,
    sidecarPath: entry.capture.sidecarPath,
    gzipPath: entry.capture.gzipPath,
  }));
}

function walkFiles(dirAbs: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const abs = resolve(dir, name.name);
      if (name.isDirectory()) visit(abs);
      else if (name.isFile()) found.push(abs);
    }
  };
  visit(dirAbs);
  return found;
}

/** Compute the classified inventory for the `corpus-sources/` tree. */
export function computeCorpusInventory(repoRoot: string): CorpusInventory {
  const root = resolve(repoRoot);
  const captures = readCatalog(root);
  const sidecars = new Map(captures.map((c) => [c.sidecarPath, c]));
  const gzips = new Map(captures.map((c) => [c.gzipPath, c]));
  const entries: InventoryEntry[] = [];
  for (const abs of walkFiles(resolve(root, "corpus-sources"))) {
    const rel = abs.slice(root.length + 1).split(sep).join("/");
    const basename = rel.split("/").pop() ?? rel;
    if (matchesDenyPattern(basename)) {
      entries.push({
        path: rel,
        verdict: "deny",
        provenance: "private-ruling deny pattern (non-legislative advisory product)",
        reason: "deny-private-ruling-basename",
      });
      continue;
    }
    const sidecar = sidecars.get(rel);
    if (sidecar !== undefined) {
      entries.push({
        path: rel,
        verdict: "public",
        provenance:
          `reviewed-capture slug=${sidecar.slug} authority=${sidecar.authorityId} version=${sidecar.versionId} via corpus-sources/v1/reviewed-input-catalog.json`,
        reason: "reviewed-capture",
      });
      continue;
    }
    const gzip = gzips.get(rel);
    if (gzip !== undefined || rel.endsWith(".raw.json.gz")) {
      const who = gzip === undefined
        ? "untracked raw capture"
        : `raw-capture slug=${gzip.slug} authority=${gzip.authorityId} version=${gzip.versionId}`;
      entries.push({
        path: rel,
        verdict: "quarantined",
        provenance: `${who} (unreviewed fetch bytes; only the reviewed sidecar ships)`,
        reason: "raw-capture-quarantine",
      });
      continue;
    }
    if (rel === "corpus-sources/v1/reviewed-input-catalog.json") {
      entries.push({
        path: rel,
        verdict: "public",
        provenance: "reviewed-input-catalog (committed build metadata, not a capture)",
        reason: "reviewed-catalog",
      });
      continue;
    }
    entries.push({
      path: rel,
      verdict: "deny",
      provenance: "no classification rule admits this file",
      reason: "unmatched-rule",
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    generatedBy: "scripts/build-corpus-inventory.ts",
    root: "corpus-sources",
    entries: Object.freeze(entries),
  };
}

/** Render the canonical committed bytes (one entry per line). */
export function renderInventoryJson(inventory: CorpusInventory): string {
  const lines = [
    "{",
    `  "generatedBy": ${JSON.stringify(inventory.generatedBy)},`,
    `  "root": ${JSON.stringify(inventory.root)},`,
    "  \"entries\": [",
    ...inventory.entries.map((entry, index) =>
      `    ${JSON.stringify(entry)}${index + 1 < inventory.entries.length ? "," : ""}`
    ),
    "  ]",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  if (import.meta.url === pathToFileURL(resolve(entry)).href) return true;
  const base = entry.split(sep).pop() ?? "";
  const launcher = base === "vite-node" || base === "vite-node.mjs";
  const underWorker =
    (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== undefined;
  return launcher && entry.includes("node_modules") && !underWorker;
}

if (isDirectEntry()) {
  const here = dirname(fileURLToPath(import.meta.url));
  process.stdout.write(renderInventoryJson(computeCorpusInventory(resolve(here, ".."))));
}
