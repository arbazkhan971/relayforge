# Phase 07 reference audit: RelayForge identity, packaging, and release

Audit date: 2026-08-09 UTC
RelayForge baseline: `73051d510c6473fa763bc7cd81921f65bec00eea`

## Scope and release decision

This is the final implementation gate, not a marketing-only rename. It covers:

- the npm package and executable identity;
- compatibility for existing `loop` and `loop-orchestrator` invocations;
- existing `loop.config.*`, `.loop/`, durable store, run, branch, and tmux identities;
- public exports and generated declarations;
- changelog, architecture, operator, adapter, and migration documentation;
- tag/version/package consistency, tarball contents, clean installation, and post-publish proof;
- CI/release workflow behavior and the release-candidate ecosystem rescan.

The product will become **RelayForge**, with npm package and primary binary `relayforge`.
The old `loop` and `loop-orchestrator` binary names remain compatibility aliases for the
v1 line. Existing config and durable state are adopted in place. They are not renamed or
copied merely for appearance: moving `.loop/` or changing persisted identifiers would
create split authority and make old runs look absent.

The first honest release target is `1.0.0-rc.1`, not an unqualified stable v1. The release
candidate must pass the committed-head gates in this audit. Publishing and repository
renaming remain explicit external operator actions; source changes must not claim that an
npm or GitHub mutation occurred.

## Research method

The audit began with the mandatory primary reference and searched GitHub again using:

- `coding agent orchestrator CLI release packaging smoke tests npm`;
- `multi agent coding orchestrator release workflow CLI compatibility package`;
- `AI coding fleet CLI npm package release test worktree orchestrator`;
- `RelayForge agent orchestrator`.

The search found MCO as a particularly strong, previously unused npm-release reference.
For every selected repository, the audit inspected checked-out source, tests, release
workflows or scripts, recent history, repository license, NOTICE where present, and the
bug/PR evidence named below. README claims were used only as navigation.

Activity is the number of commits reachable from the inspected pin in the preceding 30
days. It is a freshness signal, not a quality score.

## Exact pins and legal review

| Repository | Pin | Activity | License / notice | Reuse class |
|---|---|---:|---|---|
| Untrivial-ai/agent-orchestrator | `f65c48e296e20a816221a4003c75a5f0387967ec` | 453 | repository Apache-2.0; npm shim metadata says MIT, so file provenance must be evaluated independently | `ARCHITECTURAL_INSPIRATION` |
| mco-org/mco | `9eff964825e4da234d8c8079c61fb010854ae44e` | 5 | MIT; no NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| daintreehq/daintree | `eb989c7613db8ff9dc948775291f56e42c5ada3a` | 1,623 | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` |
| stagewise-io/stagewise | `104d1c27376bc37e6b93adfc3617254358346823` | 180 | AGPL-3.0; package-local licenses also exist | `IDEA_ONLY` |
| GoogleCloudPlatform/scion | `91c26b343a26b7697f9432de5792cd7372b391a6` | 421 | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| johannesjo/parallel-code | `d000fff65989f4c9fe48e5814a9d7c807ae83ba6` | 64 | MIT | `IDEA_ONLY` |

No upstream source or test is copied. Release scripts and tests will be independently
implemented for RelayForge's TypeScript/npm layout. This avoids the ambiguous repository
Apache/package-MIT boundary in Agent Orchestrator and the incompatible Stagewise license.

## Source, test, and history evidence

### RelayForge baseline

Files inspected:

- `package.json`, `package-lock.json`, `tsconfig.json`;
- `src/cli.ts`, `src/config/load.ts`, `src/config/schema.ts`, `src/cli/support.ts`;
- `src/runtime.ts`, `src/ids.ts`, `src/tmux-client.ts`, `src/control/runfile.ts`;
- `tests/package-exports.test.ts`, `tests/cli.test.ts`, `tests/config.test.ts`;
- `scripts/smoke.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`;
- `README.md`, `CHANGELOG.md`, `docs/publishing.md`.

Strengths already present:

- a closed exports map blocks sensitive internal subpaths;
- both `loop` and `loop-orchestrator` bins resolve to one built CLI;
- the disposable-repository smoke proves the original checkout is unchanged and treats
  unsupported containment as a fail-closed result;
- tag/package version equality and `npm pack --dry-run` are release gates;
- durable state is already namespaced and migration-sensitive.

Gaps:

- package, primary command, help, docs, and most output still say Loop Orchestrator;
- no tarball is installed into a clean prefix in CI before publication;
- no tarball file manifest/size policy, legacy-bin smoke, declaration import smoke, or
  clean-install control-service lifecycle smoke exists;
- release is triggered directly by any matching tag and does not prove a dated changelog,
  exact registry state, idempotent retry, or `latest` convergence;
- CI exercises Node 22 while package metadata says `>=20`; the newly pinned SQLite binding
  does not support Node 21, so the current engine declaration is inaccurate;
- README still says multi-repository execution is unsupported and describes retired polling
  endpoints;
- the release workflow does not call the real product smoke.

### Untrivial Agent Orchestrator

Files inspected:

- `packages/ao/package.json` and `packages/ao/bin/ao.js`;
- each `packages/ao-{darwin-arm64,darwin-x64,linux-x64,win32-x64}/package.json`;
- `packages/build-binaries.sh`;
- `.github/workflows/testing-build.yml`, `feature-release.yml`,
  `release-latest-guard.yml`, and frontend release workflows;
- `backend/internal/cli/e2e_test.go` and desktop Playwright smoke suites;
- `frontend/docs/desktop-release.md`.

The strongest idea is a tiny stable package entry point with platform resolution and
explicit unsupported-host errors. The feature-release workflow also reads PR-controlled
version metadata through the GitHub contents API before checkout, separates untrusted
guard work from credentialed release jobs, pins the exact PR SHA, uses isolated channels,
and limits live previews.

The direct binary-wrapper architecture is not needed for RelayForge's portable JS package.
The shim also has weak signal propagation (`result.signal` becomes exit 1) and no focused
test beside broader CLI E2E evidence. Commit `3c8e7ce3` / PR #3660 repaired ACP runtime
packaging, demonstrating that a green source build is not proof of a correct packaged app.
RelayForge adopts the exact-artifact and preview isolation principles, not the wrapper code.

### MCO

Files inspected:

- `package.json`, `RELEASING.md`, `CHANGELOG.md`;
- `.github/workflows/gate.yml`, `preview-package.yml`, and `publish-npm.yml`;
- `scripts/run_npm_packaging_smoke.sh`, `scripts/check_release_ref.py`, and
  `scripts/check_package_version.py`;
- `tests/test_release_ref.py`, `tests/test_package_version.py`, and Node launcher/installer
  tests under `tests/node/`.

MCO has the strongest inspected npm publication loop. Pull requests create an installable
preview tarball without publishing. The tag is checked against package metadata and a dated
changelog. The publish job queries the exact version first, distinguishes a confirmed E404
from ambiguous registry failure, supports safe retry after partial success, waits for
`latest`, then installs from the registry in a clean prefix and checks the real binary
version. Tests structurally assert the workflow commands and order. Release PR #122 and
commit `9eff964` consolidate this behavior.

Weaknesses for RelayForge: MCO packages a Python runtime through a Node wrapper, has several
version sources, and its manual fallback depends on human npm web authentication. RelayForge
has one npm version source and must add its own store/daemon/data migration smokes. The
design is `ARCHITECTURAL_INSPIRATION`, not copied shell/Python.

### Daintree

Files inspected:

- `docs/release.md` and the macOS/Linux/Windows/package release workflows;
- `scripts/run-packaged-smoke.mjs`, `scripts/run-packaged-smoke.test.mjs`;
- `scripts/ci/release-e2e-gates.test.mjs`;
- packaged smoke support in `electron/services/smokeTest.ts`.

Daintree is the strongest artifact-level smoke and workflow-structure reference. Its tests
verify required smoke markers per platform, timeouts, post-success shutdown noise, native
module loading, persistence stress, and platform-specific process supervision. The release
gate regression for issue #11117 does not trust job names: it parses each workflow, resolves
which suites actually run, follows only `needs` paths that propagate failure, and asserts
every publisher remains blocked by every required gate.

RelayForge is not Electron and should not reproduce signing, notarization, updater, native
PTY, or R2 machinery. It will independently apply the core lesson: test the packed artifact
and test that workflow topology cannot bypass gates. Daintree's Apache NOTICE must be
preserved if code were copied; none will be.

### Stagewise

Files inspected:

- `.github/workflows/prepare-release.yml`, `auto-release.yml`, nightly and component release
  workflows;
- root and CLI/browser package manifests plus release version files;
- update/release-note and compatibility tests found under apps/packages;
- history around `1.28.0`, release-note overlap, and provider-discovery compatibility.

Stagewise demonstrates coordinated monorepo versioning, prerelease/nightly separation, and
user-visible release-note/update behavior. RelayForge is a single package without an updater,
so that machinery adds little. Because the repository is AGPL-3.0, it is `IDEA_ONLY` and no
source or tests will be reused.

### Scion and Parallel Code

Scion files inspected include `.github/workflows/build-release.yml`, `hack/smoke_test.sh`,
`cmd/root_test.go`, `cmd/start_test.go`, `cmd/server_migrate_test.go`, and the extensive
provision/migration compatibility tests. Scion is strongest for preserving deprecated flags
and proving data/config migrations as behavior, not documentation.

Parallel Code files inspected include `package.json`, `.github/workflows/release.yml`, and
history around `52d1057` (auto-update metadata) and release tags. It provides a pleasant
single-command version/tag flow but weaker package/clean-install evidence than MCO and
Daintree, so it is not the selected release implementation.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Agent Orchestrator | stable npm entry point, platform packages, guarded preview releases, CLI/desktop E2E | Primary ecosystem reference; exact-SHA and credential boundary discipline | architecture is a native binary wrapper; repository/package license boundary differs; packaged runtime needed a recent repair | Apache-2.0 repo; shim metadata MIT | `ARCHITECTURAL_INSPIRATION` |
| MCO | preview tarball, tag/changelog/version checks, idempotent registry publish, clean install smoke, workflow tests | Best npm release correctness and retry story | Python-in-Node package and multiple version sources do not fit RelayForge | MIT | `ARCHITECTURAL_INSPIRATION` |
| Daintree | packaged application smoke and tests that prove release DAG gates publishers | Best artifact and release-topology testing | Electron/signing/updater complexity is irrelevant | Apache-2.0 + NOTICE | `ARCHITECTURAL_INSPIRATION` |
| Stagewise | coordinated/nightly release and release-note UX | Strong monorepo automation | AGPL; monorepo/updater design is unnecessary | AGPL-3.0 | `IDEA_ONLY` |
| Scion | CLI back-compat and migration characterization | Strongest durable compatibility tests | Go/container release form differs | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| Parallel Code | simple tag/Electron release ergonomics | Easy operator flow | weaker clean-install and workflow gate proof | MIT | `IDEA_ONLY` |

## Subsystem winners

| Subproblem | Best implementation found | RelayForge decision |
|---|---|---|
| Primary reference/product parity | Agent Orchestrator | retain exact-artifact, preview, and full CLI E2E principles |
| npm publication and retry | MCO | independently implement exact-version preflight, safe retry, latest convergence, clean registry install |
| packed-artifact smoke | Daintree | independently implement tarball install and real CLI/control/store smoke with explicit markers |
| release workflow correctness | Daintree | add structural tests proving every publisher depends on every gate with failure propagation |
| durable compatibility | Scion | characterize old binary/config/state identifiers; adopt in place |
| prerelease channels | AO + Stagewise | use `1.0.0-rc.1` and preview tarballs; do not update `latest` accidentally |
| small operator experience | Parallel Code | keep one documented path while retaining stronger hidden gates |

## Chosen design

### Best implementation discovered

There is no single winner. MCO is best for npm registry semantics, Daintree for artifact and
workflow-gate tests, Scion for compatibility, and Agent Orchestrator for the ecosystem's
release/trust boundary. RelayForge will combine those behaviors in a smaller npm-only flow.

### Why

The inspected source, tests, and release histories protect different failure
boundaries: registry ambiguity/retry, exact packed-artifact behavior, workflow
gate topology, legacy compatibility, and credential isolation. No candidate
provides all of them in a TypeScript-only package without unrelated native,
Electron, updater, or monorepo machinery.

### What RelayForge will reuse

Only principles and independently written behavior:

- preview the exact npm tarball before publication;
- bind tag, package version, changelog, tarball digest, and tested commit;
- treat confirmed “version absent” differently from an ambiguous registry error;
- make a repeated publish job continue verification if the exact version already exists;
- install the packed and then published package into a clean prefix and run the real binary;
- structurally test that every publisher is blocked by every required gate;
- preserve old executable/config/state identities until a tested migration retires them.

### What RelayForge will change

- one TypeScript/npm package, no native shim or postinstall;
- package/primary bin `relayforge`, with `loop` and `loop-orchestrator` aliases;
- default discovery prefers `relayforge.config.*`, then accepts legacy `loop.config.*`; two
  competing configs are an explicit ambiguity error rather than precedence by accident;
- new init writes `relayforge.config.yaml`, while existing legacy config and `.loop/` state
  remain authoritative in place;
- persisted schema names, branch namespaces, marker kinds, and `.loop/` are compatibility
  protocol, not user-facing branding; changing them requires a later audited migration;
- `RELAYFORGE_*` environment names become primary where public; conflicting old/new values
  fail closed, and old `LOOP_*` names remain supported for v1;
- engine metadata exactly matches supported Node majors (`20.x || >=22` with an upper-bound
  policy revisited when dependencies change), and CI includes the minimum plus current LTS;
- no telemetry, updater, auto-merge, or automatic external publication is introduced.

### How RelayForge will improve it

The clean tarball smoke will go beyond `--help`: it will verify both new and legacy binary
names, import the public ESM/declaration surface, initialize a disposable repo, adopt legacy
config/state, execute a dry run, start/status/stop the loopback service, and prove the
checkout and package prefix are isolated. The release manifest records commit, version,
tarball filename/SHA-256/bytes/file list, Node/npm versions, test summary, reference-audit
pins, and whether real containment/adapter gates ran. Claims in README/comparison tables are
checked against exports/config/tests rather than manually trusted.

## Compatibility contract

1. `relayforge` is the canonical CLI and help/product name.
2. `loop` and `loop-orchestrator` invoke identical code and emit one bounded deprecation note
   only where it cannot break JSON or scripts; no warning is written into machine JSON.
3. `relayforge.config.yaml|yml|json` is preferred only when no legacy config exists. Presence
   of both families without an explicit `--config` is `CONFIG_AMBIGUOUS`.
4. Existing `loop.config.*` loads without rewriting.
5. `.loop/`, existing branches, tmux ownership metadata, run IDs/epochs, event types, SQLite
   identities, and marker kinds remain byte-compatible in v1.
6. New init is additive and never overwrites either config family or an existing private
   state tree.
7. Public ESM exports remain allowlisted. Sensitive ledger/settlement internals remain
   inaccessible under both the packed package and self-reference tests.
8. `--version` reports package version and product identity; legacy bins return the same
   version and exit behavior.

## Release authority and artifact contract

The source repository produces evidence; it does not silently publish. A release candidate
is eligible only if:

- worktree is clean and HEAD equals the recorded tested commit;
- tag is exactly `v<package.version>` and the changelog has a dated matching heading;
- phase audits P0-P7 and the upstream ledger contain no missing/unclear code reuse;
- typecheck, full tests, build, product smoke, packed-tarball smoke, declaration/import smoke,
  and workflow-structure tests pass;
- required Linux cgroup and adapter real-host jobs either pass on their declared required
  runners or the release is explicitly ineligible (not “skipped green”);
- the tarball has an allowlisted file set, no source/test/private state, bounded size, and a
  recorded SHA-256;
- installation into an empty prefix succeeds with scripts disabled unless a reviewed package
  script is intentionally required (RelayForge requires none);
- the exact installed binary and version are exercised from the prefix;
- publication checks exact-version absence before write, never treats network/auth errors as
  absence, and after write verifies the exact version and intended dist-tag;
- retry after a partial publish skips only the already-confirmed exact package write, then
  repeats all registry and clean-install verification.

## Failure and recovery matrix

| Failure | Required result |
|---|---|
| both RelayForge and legacy config found | fail with explicit ambiguity; no state mutation |
| legacy config/state only | adopt and operate in place; no copy/rename |
| malformed legacy durable state | recovery-required; never initialize empty RelayForge state over it |
| new and legacy binary entry | identical command tree, exit status, JSON, and version |
| package name/subpath typo | Node closed-exports error; no internal import fallback |
| omitted dist file | tarball smoke fails before publication |
| extra secret/private/test/source file | manifest policy fails |
| version/tag mismatch | publication gate refuses before npm authentication/write |
| version only under Unreleased changelog | dated-release gate refuses |
| registry query timeout/401/5xx | ambiguous failure; never call publish |
| exact version already published with matching integrity | skip write, repeat latest/dist-tag/install verification |
| exact version returns unexpected metadata | refuse; operator recovery required |
| npm publish succeeds then workflow dies | retry detects exact version and resumes verification |
| wrong `latest`/`next` tag | release incomplete; do not claim success |
| clean install resolves workspace files | smoke fails by running outside repository |
| Node minimum unsupported | engine/CI gate fails before release |
| release DAG loses test dependency or adds `always()` bypass | structural workflow test fails |
| required host test is skipped | release ineligible |
| README claims unsupported/missing feature | documentation contract test or review gate fails |
| external npm/GitHub credentials unavailable | source release bundle still produced; publication remains pending and is reported honestly |

## Implementation packets

### P7-A — identity and compatibility

Own `package.json`, lockfile, CLI/config discovery, branding helper, focused identity/config
tests. Add the new binary/config identity while preserving legacy state. Do not edit storage
schemas or bulk-replace `loop` domain terminology.

### P7-B — packed artifact and release manifest

Own new scripts/tests for deterministic `npm pack`, allowlisted tarball inspection, clean
prefix install, all binary aliases, public ESM/types, disposable init/dry-run/control-service
smoke, and JSON release manifest generation.

### P7-C — release workflow

Own CI/release workflow and structural tests. Implement preview tarball, minimum/current Node
matrix, tag/changelog gate, exact-version registry preflight, idempotent retry, explicit
prerelease dist-tag, post-publish convergence, and clean registry install.

### P7-D — product and operator documentation

Own README, changelog, architecture/API/adapter/operator/migration/publishing docs, examples,
and generated screenshots only if they match the shipped UI. State honestly which external
publish/rename actions remain.

### P7-E — release-candidate rescan and committed-head gate

Repeat GitHub ecosystem search, append ecosystem watch/upstream ledger, audit all reuse,
commit, then run the complete gate on the committed object. Produce a final report that names
the exact commit and every real-world test result.

## Exit gate

P7 is complete only when all implementation phases P0-P7 are represented in source, tests,
ADRs/reference audits, attribution ledger, and ecosystem watch; the package is RelayForge
without orphaning Loop Orchestrator users; the packed artifact is the object tested; and the
full committed-head gate is green. An unperformed external npm publish or GitHub repository
rename must be listed as an operator action, not disguised as completed engineering.
