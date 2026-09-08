/**
 * Corpus-inventory regression test (CORPUS-SPLIT slice B0).
 *
 * The committed `data/corpus-inventory.json` is the classified file list
 * GATE-2a signs and B1's data CI re-asserts. This test keeps it honest:
 * regeneration byte-equals the committed file, every file under
 * `corpus-sources/` appears exactly once, no `public` entry matches a
 * deny pattern, and no raw capture is ever `public`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeCorpusInventory,
  matchesDenyPattern,
  renderInventoryJson,
  type InventoryEntry,
} from "./build-corpus-inventory.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const COMMITTED = resolve(REPO_ROOT, "data", "corpus-inventory.json");
const SOURCES = resolve(REPO_ROOT, "corpus-sources");

/** Independent walk of the tree (mirrors nothing in the script). */
function walkTree(dirAbs: string, rootAbs: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = resolve(dir, name);
      const stat = statSync(abs);
      if (stat.isDirectory()) visit(abs);
      else if (stat.isFile()) found.push(abs.slice(rootAbs.length + 1).split(sep).join("/"));
    }
  };
  visit(dirAbs);
  return found.sort();
}

function committedEntries(): InventoryEntry[] {
  return (JSON.parse(readFileSync(COMMITTED, "utf8")) as { entries: InventoryEntry[] }).entries;
}

describe("corpus inventory", () => {
  it("regeneration byte-equals the committed JSON", () => {
    expect(renderInventoryJson(computeCorpusInventory(REPO_ROOT))).toBe(
      readFileSync(COMMITTED, "utf8"),
    );
  });

  it("every file under corpus-sources/ appears exactly once", () => {
    const onDisk = walkTree(SOURCES, REPO_ROOT);
    const listed = committedEntries().map((entry) => entry.path).sort();
    expect(listed).toEqual(onDisk);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("zero public entries match a deny pattern", () => {
    const bad = committedEntries().filter(
      (entry) =>
        entry.verdict === "public" &&
        matchesDenyPattern(entry.path.split("/").pop() ?? entry.path),
    );
    expect(bad, `public entries matching a deny pattern: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it("zero raw-capture paths are public", () => {
    const bad = committedEntries().filter(
      (entry) => entry.path.endsWith(".raw.json.gz") && entry.verdict === "public",
    );
    expect(bad, `raw captures marked public: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it("verdict counts are pinned (public 21 / quarantined 20 / deny 0)", () => {
    const counts = { public: 0, quarantined: 0, deny: 0 };
    for (const entry of committedEntries()) counts[entry.verdict] += 1;
    expect(counts).toEqual({ public: 21, quarantined: 20, deny: 0 });
  });
});
