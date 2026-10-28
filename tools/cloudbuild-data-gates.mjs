import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedInventoryPath = process.argv[2];
assert(generatedInventoryPath, "usage: node tools/cloudbuild-data-gates.mjs <generated-inventory.json>");

const readJson = (path) => JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
const publicPaths = (inventory) => new Set(inventory.entries.filter((entry) => entry.verdict === "public").map((entry) => entry.path));
const sorted = (set) => [...set].sort();
const assertSameSet = (actual, expected, message) => {
  assert.deepEqual(sorted(actual), sorted(expected), message);
};

assert(readFileSync(resolve(repoRoot, "LEGAL_CORPUS_NOTICE.txt"), "utf8").trim().length > 0,
  "LEGAL_CORPUS_NOTICE.txt must exist and be non-empty");
assert(!readdirSync(repoRoot, { withFileTypes: true }).some((entry) => entry.name === "app"),
  "the public data repository must not contain an app/ tree");

const committedInventory = readJson("data/corpus-inventory.json");
const generatedInventory = JSON.parse(readFileSync(resolve(generatedInventoryPath), "utf8"));
const invalidEntries = generatedInventory.entries.filter((entry) => entry.verdict !== "public");
assert.deepEqual(invalidEntries, [], "generated inventory contains quarantined or denied files");
assertSameSet(publicPaths(generatedInventory), publicPaths(committedInventory),
  "generated public inventory differs from data/corpus-inventory.json");

function walkFiles(directory, { rejectSymlinks = false, rejectRawPaths = false } = {}) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (path === resolve(repoRoot, ".git")) continue;
    if (rejectRawPaths && entry.name.endsWith(".raw.json.gz")) {
      throw new Error(`raw quarantined captures must not be present in the repository tree: ${relative(repoRoot, path)}`);
    }
    if (entry.isSymbolicLink()) {
      if (rejectSymlinks) {
        throw new Error(`symbolic link is not allowed in this source inventory: ${relative(repoRoot, path)}`);
      }
      continue;
    }
    if (entry.isDirectory()) files.push(...walkFiles(path, { rejectSymlinks, rejectRawPaths }));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const sourceRoot = resolve(repoRoot, "corpus-sources");
assert(lstatSync(sourceRoot).isDirectory(), "corpus-sources must be a real directory, not a symbolic link");
const sourceFiles = walkFiles(sourceRoot, { rejectSymlinks: true })
  .map((path) => relative(repoRoot, path).split(sep).join("/"));
const denyBasename = /(?:dictamen|criterio|pronunciamiento|consulta|opinion|ruling|private)/i;
const denyHits = sourceFiles.filter((path) => denyBasename.test(path.split("/").pop() ?? path));
assert.deepEqual(denyHits, [], "corpus-sources contains a denied private-ruling basename");
assertSameSet(new Set(sourceFiles), publicPaths(committedInventory),
  "filesystem corpus-sources inventory differs from committed public inventory");

walkFiles(repoRoot, { rejectRawPaths: true });

const dataPackage = readJson("data/package.json");
const rootPackage = readJson("package.json");
const rootLock = readJson("package-lock.json");
const zodPin = rootPackage.dependencies?.zod;
assert(zodPin, "root package.json must pin the zod dependency");
const expectedRoot = {
  ...dataPackage,
  dependencies: { ...(dataPackage.dependencies ?? {}), zod: zodPin },
};
assert.deepEqual(rootPackage, expectedRoot,
  "root package.json must equal the data package plus its zod pin");
assert.deepEqual(rootLock.packages[""].dependencies ?? {}, rootPackage.dependencies ?? {},
  "root lockfile dependencies differ from package.json");
assert.deepEqual(rootLock.packages[""].devDependencies ?? {}, rootPackage.devDependencies ?? {},
  "root lockfile devDependencies differ from package.json");
assert.equal(rootLock.packages["node_modules/zod"]?.version, zodPin,
  "root lockfile zod version differs from package.json");

const closure = readJson("data/build-closure.json");
const dependencies = { ...(rootPackage.dependencies ?? {}), ...(rootPackage.devDependencies ?? {}) };
const unpinned = closure.externals.npm.filter((name) =>
  typeof dependencies[name] !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(dependencies[name]),
);
assert.deepEqual(unpinned, [], "every external npm dependency in the build closure must be exactly pinned");

console.log(`Corpus gates passed for ${sourceFiles.length} committed public source files.`);
