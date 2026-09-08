# Build-lane dependency decision (CORPUS-SPLIT B0 exit requirement)

## Decision

**Allowlist with exact pins — do NOT vendor.** The public data repo installs
the build lane from the registry using `data/package.json` (exact versions,
no ranges) plus `data/package-lock.json`, and data CI enforces the closure
with a dependency-assertion test (B1). No `node_modules` copy is committed
anywhere.

Rationale: the measured closure is tiny (16 repo sources, 2 npm packages).
Vendoring would duplicate megabytes of `linkedom` + the sql.js WASM blob,
add license-attribution burden, and risk stale copies drifting from the
pins. Exact pins + lockfile give reproducible installs without that cost.
The lane stays offline-reproducible: every version below was read from the
app-repo install (`package.json` / `node_modules`), zero network used.

## Pins table

| package | exact version | why needed |
|---|---|---|
| `linkedom` | 0.18.13 | build entry parses fixtures via `DOMParser` (`scripts/build-corpus-artifact.ts`) |
| `sql.js-fts5` | 1.4.0 | SQLite engine behind `src/db/database.ts` (`database-init.node.ts`) |
| `typescript` | 5.9.3 | compiles the lane; the B0 closure walker itself uses the compiler API |
| `vite-node` | 2.1.9 | executes the build entry (`Run via: npx vite-node scripts/...`) |
| `vitest` | 2.1.9 | runs the lane's fast gates (closure/inventory/determinism tests) |
| `@types/node` | 22.20.1 | typechecks the lane's `node:` imports (`crypto/fs/path/url`) |

Node runtime pinned by CI image: local evidence produced under Node v26.3.0;
B1 pins the data-CI Node version explicitly.

## Deterministic toolchain params (read, not changed)

Observed from `src/db/` + `src/corpus/manifest.ts` via the repo's own sql.js:

- SQLite engine: **3.33.0** (`SELECT sqlite_version()` through sql.js-fts5 1.4.0).
- `page_size` **4096**, `encoding` **UTF-8**, `journal_mode` **delete**,
  `auto_vacuum` **0 (NONE)** — all engine defaults, none overridden in code.
- Deterministic vacuum: there is **no VACUUM step** in the build path
  (no `VACUUM` string in `src/db/`, `src/corpus/manifest.ts`, or the entry
  chain). The artifact is one sql.js `.export()` of the in-memory DB; B1
  must not add a vacuum/sweep step without re-proving byte determinism.
- Fixed mtime: `norma.imported_at` is caller-supplied and pinned in the
  reviewed literals (`src/corpus/reviewed-corpus-sources.ts`, e.g.
  `1943-08-27T00:00:00.000Z`); manifest `builtAt` defaults to the epoch
  (`new Date(0)`) and B1 must pass a fixed value per release. No wall-clock
  read exists in the build chain.
- Seeded UUID inputs: **none** — no `randomUUID`/`Math.random` in
  `src/db/`, `src/corpus/manifest.ts`, or the entry chain (the only
  `Date.now`/`Math.random` hits are unrelated server/library tests).
  `AUTOINCREMENT` ids are insertion-order deterministic.
- Hash primary: manifest logical-row content identity
  (`contentIdentityFromDb` / `adoptedContentIdentityV2FromDb`) is the
  comparison authority; exported bytes are secondary. Proven by
  `src/corpus/build-determinism.test.ts` (synthetic, never a full build).

## Data-repo layout proposal (B1 input)

- `corpus-sources/` — the 21 `public` files from `data/corpus-inventory.json`
  (20 `*.capture.json` + `reviewed-input-catalog.json`); the 20
  `*.raw.json.gz` files stay out (quarantined, never public).
- `lane/` — the 16 closure files from `data/build-closure.json` at their
  repo-relative paths (`scripts/build-corpus-artifact.ts`, `src/...`).
- `lane/package.json` + `lane/package-lock.json` — this `data/` pair, moved.
- `LEGAL_CORPUS_NOTICE.txt` — canonical template copy (byte-equality assert).
- `data/channel-registry.json` — monotonic counter + tag map (plan §Target).
- `.github/workflows/data-ci.yml` — NOTICE assert, app-path reject,
  content-gate re-assert (deny patterns + raw quarantine), dependency-allowlist
  assert, deterministic-build proof, atomic publish.

## Inventory method summary

- Closure: `scripts/build-closure.ts` (TypeScript compiler API) from the
  build entry; relative imports followed, `node:` → builtin, bare → npm;
  output sorted and committed as `data/build-closure.json`. Independently
  cross-checked by grepping every specifier in the 16 files (exact match).
- Inventory: `scripts/build-corpus-inventory.ts` walks `corpus-sources/`
  (41 files): deny patterns first, then raw-quarantine, then catalog-traced
  reviewed captures → public, catalog → public, else deny/`unmatched-rule`.
  Result: **public 21 / quarantined 20 / deny 0**, committed as
  `data/corpus-inventory.json` for the GATE-2a signature.

## Substitutions log

- `madge` → TypeScript compiler API: `madge` is not installable offline, and
  the vendored `typescript` package already exposes the parser. Same graph
  semantics for static + dynamic imports; no new dependency.
- Lockfile: see acceptance report — generation attempted cache-only offline;
  if absent, B1 must generate it in an online environment (entry requirement).
- `node:crypto` continuity: the RFC 8032 vectors verify under the test file's
  existing `node:crypto` helper (stdlib, zero new deps) — verified in a
  scratch run before fill, including a tampered-variant rejection. The lane
  keeps `node:crypto`; no Ed25519 package enters the build closure.
