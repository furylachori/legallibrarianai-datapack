# Cloud Build checks

`cloudbuild.yaml` is the fast pull request gate. It installs the locked npm
dependencies, regenerates and checks the committed public corpus inventory,
checks the root/data manifest and lockfile relationship, runs the existing
build-closure test, and verifies the required notice and absence of app files
or raw captures.

`cloudbuild.full.yaml` runs the same gates and then builds the full fixture
corpus twice into separate `/tmp` directories. It compares the outputs and
checks that the built notice matches `LEGAL_CORPUS_NOTICE.txt`. Both builds and
the comparison run in one Cloud Build step so the temporary outputs are
available together. The builder receives only the checked-in fixtures; the
tests do not fetch a live corpus or call a provider.

The content gate uses filesystem enumeration for the source file inventory,
so it does not require Cloud Build to retain Git's index or `.git` directory.
It still compares the on-disk corpus sources to the committed public
inventory, fails on any generated deny/quarantine entry, and rejects raw
capture files, preserves the existing private-ruling basename deny list,
rejects a symlinked `corpus-sources/` root and symlinks beneath it, and rejects
raw-capture paths regardless of whether they are files, directories, or symlinks.
The raw-file scan checks the full checkout, including generated metadata and
dependency trees, and prunes only the checkout's root `.git`, matching the
existing `data-ci` workflow's raw-capture check. Dependency installation uses `npm ci` and
requires npm registry network access; the test and fixture build steps run
after install without live services.

Both configurations run `tools/cloudbuild-data-gates.test.mjs` to check the
helper's acceptance and rejection behavior using temporary synthetic trees.
The GitHub `data-ci` content gate also executes the helper against its regenerated
inventory and runs these regressions; this does not execute the Cloud Build YAML.

The `data-ci` GitHub workflow's `publish` job is intentionally excluded. These
Cloud Build configs do not use signing keys, the GitHub API, release tags,
registry changes, or pushes to `main`.

## Cloud Build setup

The retained repository is `furylachori/legallibrarianai-datapack`. Use project
`project-33a976dd-e360-4c43-8d9`, Cloud Build region `northamerica-south1`, and
the existing GitHub connection `mex`. Configure the PR trigger to load
`cloudbuild.yaml`; configure a separate main-branch full-check trigger to load
`cloudbuild.full.yaml`. Cloud Scheduler can call the latter twice daily with
cron `0 6,18 * * *` and timezone `America/Costa_Rica`. No trigger or schedule
is created here.

Both configs name the existing
`ci-pr-smoke@project-33a976dd-e360-4c43-8d9.iam.gserviceaccount.com` build
identity and use Cloud Logging. For a trigger, select that identity on the
trigger itself because Cloud Build ignores the YAML `serviceAccount` field for
triggered builds. Scope `iam.serviceAccounts.actAs` to the exact build
identity for the human or scheduler principal that submits the build; do not
grant the build identity permission to impersonate itself. Build submission
permission belongs to the submitting principal and should be limited to the
required build operation. The existing identity has Logs Writer and a custom
`cloudbuild.builds.create` permission. That create permission belongs on the
human or scheduler submitter, not a runtime identity executing PR code. Before
enabling a PR trigger, the owner should remove it from `ci-pr-smoke` or select
a logs-only runtime identity; no IAM change is part of this draft. Do not grant
the runtime identity self-`actAs` or add broad project roles.

## Runtime, timeouts, and cost

The build uses the repository's pinned Node 26.3.0 runtime in
`node:26.3.0-bookworm-slim`, `E2_STANDARD_2`, and 20-minute (PR) / 60-minute
(full) hard timeouts. The existing exact dependency lockfiles are installed
with `npm ci`.

An initial run in the same Node 26.3.0 container took 7.1 seconds for `npm
ci`, 1.4 seconds for the fast inventory/content/closure gates, and 14.7 seconds
for the additional two fixture builds and comparisons. After expanding the raw
scan to the full checkout, the final helper alone took 49 ms with the installed
`node_modules` tree present. A negative probe placed a synthetic raw capture
under `node_modules/`; the gate rejected it. The final full sequence passed in
15 seconds with `npm ci --offline` using the warmed local cache: the 21 corpus
source files matched the committed inventory, the full-tree raw scan passed,
all 3 closure tests passed, and both generated 7.45 MB SQLite fixtures
compared equal. This is local evidence, not a Cloud Build result. Conservative
Cloud Build estimates are 5 minutes for the PR config and 10 minutes for the
full config; at $0.006 per E2_STANDARD_2 build-minute, that is $0.03 and $0.06
per run. Sixty scheduled full runs at the 60-minute hard timeout ceiling cost
$21.60/month before PR builds, logs, and other charges.

Across all four repos, scheduled timeout ceilings total $68.40/month. At 60 PR
runs per repo using each fast config's timeout ceiling, the combined build
minute ceiling is $95.40 before logs, storage, and network charges. This is a
planning envelope, not an enforced cap; PR volume and ancillary charges need
separate ownership before the monthly target can be guaranteed. No free-tier
minutes or temporary credits are included.
