/**
 * Build-closure regression test (CORPUS-SPLIT slice B0).
 *
 * The committed `data/build-closure.json` is the exact file list B1
 * vendors into the public data repo. This test keeps it honest:
 * regenerating the closure byte-equals the committed file, every listed
 * source exists, and every npm external carries an exact (range-free)
 * pin in `data/package.json` that matches the installed version.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildClosure, renderClosureJson } from "./build-closure.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const COMMITTED = resolve(REPO_ROOT, "data", "build-closure.json");
const LANE_PACKAGE = resolve(REPO_ROOT, "data", "package.json");

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("build closure", () => {
  it("regenerating the closure byte-equals the committed JSON", () => {
    const report = computeBuildClosure(
      resolve(REPO_ROOT, "scripts", "build-corpus-artifact.ts"),
      REPO_ROOT,
    );
    expect(renderClosureJson(report)).toBe(readFileSync(COMMITTED, "utf8"));
  });

  it("every listed file exists on disk", () => {
    const report = readJson(COMMITTED) as { files: string[] };
    expect(report.files.length).toBeGreaterThan(0);
    for (const file of report.files) {
      expect(
        (() => {
          try {
            readFileSync(resolve(REPO_ROOT, file));
            return true;
          } catch {
            return false;
          }
        })(),
        `closure file missing: ${file}`,
      ).toBe(true);
    }
  });

  it("every npm external has an exact pin in data/package.json", () => {
    const report = readJson(COMMITTED) as { externals: { npm: string[] } };
    const lane = readJson(LANE_PACKAGE) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pins = { ...(lane.dependencies ?? {}), ...(lane.devDependencies ?? {}) };
    expect(report.externals.npm.length).toBeGreaterThan(0);
    for (const name of report.externals.npm) {
      const pinned = pins[name];
      expect(pinned, `npm external ${name} has no pin in data/package.json`).toBeDefined();
      expect(pinned, `pin for ${name} must be exact, got ${pinned}`).toMatch(EXACT_VERSION_RE);
      const installed = readJson(
        resolve(REPO_ROOT, "node_modules", ...name.split("/"), "package.json"),
      ) as { version: string };
      expect(pinned, `pin for ${name} drifts from the installed version`).toBe(installed.version);
    }
  });
});
