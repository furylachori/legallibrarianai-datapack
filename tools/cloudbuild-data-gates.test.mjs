import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Run the actual CLI against an archive-shaped tree with no Git metadata or
// installed dependencies. Source bytes are irrelevant to this path/manifest
// gate; inventory regeneration and fixture builds are separate checks.
function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), "cloudbuild-data-gates-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "repo");
  const put = (path, contents = "{}\n") => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  for (const path of [
    "tools/cloudbuild-data-gates.mjs", "LEGAL_CORPUS_NOTICE.txt",
    "data/corpus-inventory.json", "data/build-closure.json",
    "data/package.json", "package.json", "package-lock.json",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(root, path));
  }
  const inventory = JSON.parse(readFileSync(join(root, "data/corpus-inventory.json"), "utf8"));
  const generated = {
    ...inventory,
    entries: inventory.entries.filter((entry) => entry.verdict === "public"),
  };
  for (const entry of generated.entries) put(entry.path);
  const inventoryPath = join(scratch, "generated-inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(generated));

  return {
    root, scratch, put, generated,
    setGenerated(value) { writeFileSync(inventoryPath, JSON.stringify(value)); },
    updateJson(path, mutate) {
      const value = JSON.parse(readFileSync(join(root, path), "utf8"));
      mutate(value);
      put(path, JSON.stringify(value));
    },
    run() {
      const result = spawnSync(process.execPath, [join(root, "tools/cloudbuild-data-gates.mjs"), inventoryPath], {
        cwd: root, encoding: "utf8", timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, "gate process must exit normally");
      return result;
    },
  };
}

function passes(f) {
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Corpus gates passed for \d+ committed public source files/);
}

function rejects(f, reason) {
  const result = f.run();
  assert.notEqual(result.status, 0, "gate unexpectedly accepted the modified tree");
  if (reason) assert.match(result.stderr, reason);
}

test("accepts an archive without Git metadata", (t) => passes(fixture(t)));

test("excludes only root Git metadata and accepts ordinary dependency symlinks", (t) => {
  const f = fixture(t);
  f.put(".git/untracked.raw.json.gz");
  f.put("node_modules/package/bin.js");
  mkdirSync(join(f.root, "node_modules/.bin"));
  symlinkSync("../package/bin.js", join(f.root, "node_modules/.bin/package"));
  passes(f);
});

for (const path of [
  "capture.raw.json.gz",
  "node_modules/package/capture.raw.json.gz",
  "node_modules/package/.git/capture.raw.json.gz",
  "generated/cache/.git/capture.raw.json.gz",
]) {
  test(`rejects raw capture at ${path}`, (t) => {
    const f = fixture(t);
    f.put(path);
    rejects(f, /raw quarantined captures/);
  });
}

for (const target of ["LEGAL_CORPUS_NOTICE.txt", "missing-target"]) {
  test(`rejects raw capture symlink to ${target}`, (t) => {
    const f = fixture(t);
    symlinkSync(target, join(f.root, "capture.raw.json.gz"));
    rejects(f, /raw quarantined captures|symbolic link/);
  });
}

for (const populated of [false, true]) {
  test(`rejects ${populated ? "nonempty" : "empty"} raw-named directory`, (t) => {
    const f = fixture(t);
    mkdirSync(join(f.root, "capture.raw.json.gz"));
    if (populated) f.put("capture.raw.json.gz/data.json");
    rejects(f, /raw quarantined captures/);
  });
}

for (const name of ["link.json", ".git"]) {
  test(`rejects corpus source symlink named ${name}`, (t) => {
    const f = fixture(t);
    symlinkSync("../LEGAL_CORPUS_NOTICE.txt", join(f.root, "corpus-sources", name));
    rejects(f, /symbolic link/);
  });
}

test("rejects a symlink replacing the corpus source root", (t) => {
  const f = fixture(t);
  const target = join(f.scratch, "external-sources");
  renameSync(join(f.root, "corpus-sources"), target);
  symlinkSync(target, join(f.root, "corpus-sources"));
  rejects(f, /corpus-sources must be a real directory/);
});

test("rejects an empty notice", (t) => {
  const f = fixture(t);
  f.put("LEGAL_CORPUS_NOTICE.txt", " \n");
  rejects(f, /notice.*non-empty/i);
});

test("rejects an app tree", (t) => {
  const f = fixture(t);
  f.put("app/entry.js");
  rejects(f, /must not contain an app/);
});

for (const verdict of ["deny", "quarantined"]) {
  test(`rejects a generated ${verdict} inventory entry`, (t) => {
    const f = fixture(t);
    f.generated.entries[0].verdict = verdict;
    f.setGenerated(f.generated);
    rejects(f, /generated inventory contains quarantined or denied/);
  });
}

test("rejects a generated inventory missing a public source", (t) => {
  const f = fixture(t);
  f.generated.entries.pop();
  f.setGenerated(f.generated);
  rejects(f, /generated public inventory differs/);
});

test("rejects a source missing on disk", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, f.generated.entries[0].path));
  rejects(f, /filesystem corpus-sources inventory differs/);
});

test("rejects an unlisted source on disk", (t) => {
  const f = fixture(t);
  f.put("corpus-sources/unlisted.json");
  rejects(f, /filesystem corpus-sources inventory differs/);
});

test("rejects private-ruling basenames", (t) => {
  const f = fixture(t);
  f.put("corpus-sources/dictamen.json");
  rejects(f, /denied private-ruling basename/);
});

test("rejects manifest drift", (t) => {
  const f = fixture(t);
  f.updateJson("package.json", (value) => { value.version = "0.0.0"; });
  rejects(f, /root package.json must equal the data package/);
});

test("rejects lockfile dependency drift", (t) => {
  const f = fixture(t);
  f.updateJson("package-lock.json", (value) => { value.packages[""].dependencies.zod = "0.0.0"; });
  rejects(f, /root lockfile dependencies differ/);
});

test("rejects lockfile zod version drift", (t) => {
  const f = fixture(t);
  f.updateJson("package-lock.json", (value) => { value.packages["node_modules/zod"].version = "0.0.0"; });
  rejects(f, /root lockfile zod version differs/);
});

test("rejects dependency ranges even when manifests and lock roots agree", (t) => {
  const f = fixture(t);
  for (const path of ["package.json", "data/package.json"]) {
    f.updateJson(path, (value) => { value.dependencies.linkedom = "^0.18.13"; });
  }
  f.updateJson("package-lock.json", (value) => { value.packages[""].dependencies.linkedom = "^0.18.13"; });
  rejects(f, /every external npm dependency.*exactly pinned/);
});
