# Phase 07 — RelayForge release and compatibility audit

Research completed 2026-08-09 before release/rebrand implementation. The full
source-tree evidence log is
`.workflow/ultracode/relayforge-complete/results/audit-p7-release-rebrand.md`
and is intentionally not packaged. The shipped provenance summary is in the
[upstream ledger](../upstream-sources.md).

**Implementation status (handoff):** identity/package foundations implemented;
the committed local candidate passed the required-cgroup aggregate, exact
preview package smoke and packed Chrome connected/degraded/recovered lifecycle.
Publication remains fail-closed until real same-runner native receipts exist.
**No** tag, npm publish, GitHub Release or repository rename has been performed. Live tracker:
[implementation-status.md](../implementation-status.md).

## Decision

The product becomes **RelayForge**. The npm package and primary binary are `relayforge`; the
existing `loop` and `loop-orchestrator` binaries remain v1 compatibility aliases. New
initialization writes `relayforge.config.yaml`, while legacy `loop.config.*` and `.loop/`
state remain authoritative in place. If both config families exist and the operator did not
select one explicitly, RelayForge refuses ambiguity.

Persisted `.loop/` leaves, run/branch identifiers, tmux ownership, event names, SQLite
identities, and marker kinds are protocol. Renaming them without a separate data migration
would create a second apparent authority, so Phase 07 does not cosmetically rewrite them.

The first release target is `1.0.0-rc.1`. Source may become release-ready without claiming
that npm publication or a GitHub repository rename occurred; those are separately authorized
external actions and have **not** been performed.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Untrivial Agent Orchestrator `f65c48e` | npm entry shim, exact-SHA feature releases, CLI/desktop E2E | Primary ecosystem reference and strong credential boundary | native wrapper; package/runtime packaging recently regressed | Apache-2.0 repository; shim metadata MIT | `ARCHITECTURAL_INSPIRATION` |
| MCO `9eff964` | preview tarball, release-ref tests, exact-version registry preflight, safe retry, clean install | Strongest inspected npm publication loop | Python runtime inside Node wrapper | MIT | `ARCHITECTURAL_INSPIRATION` |
| Daintree `eb989c7` | packaged smoke and tests that trace release-gate dependencies | Strongest artifact and workflow-topology proof | Electron/signing/updater scope is irrelevant | Apache-2.0 + NOTICE | `ARCHITECTURAL_INSPIRATION` |
| Stagewise `104d1c2` | prerelease/nightly/version/release-note automation | strong monorepo release UX | AGPL and unnecessary updater complexity | AGPL-3.0 | `IDEA_ONLY` |
| Scion `91c26b3` | CLI backward compatibility and migration characterization | strongest old-state/old-flag behavior tests | Go/container packaging differs | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| Parallel Code `d000fff` | compact tag/release operator flow | pleasant release ergonomics | weaker tarball and clean-install proof | MIT | `IDEA_ONLY` |

## Chosen design

Best implementation discovered: no single repository wins every release subproblem. MCO is
best for npm registry correctness, Daintree for artifact and release-DAG tests, Scion for
compatibility, and Agent Orchestrator for exact-artifact/credential isolation.

RelayForge will independently implement:

- a preview tarball and an allowlisted, bounded package manifest;
- clean-prefix tests for the new and legacy bins, public ESM/types, disposable init/dry-run,
  and the loopback service lifecycle;
- exact tag/package/datetime-changelog binding;
- registry preflight that publishes only after a confirmed absent exact version, supports a
  retry after partial success, verifies the intended dist-tag, and clean-installs the registry
  artifact;
- structural tests proving every publisher remains blocked by every required gate;
- minimum/current supported Node jobs and package engine metadata that matches the SQLite
  dependency's actual supported majors;
- a release manifest binding commit, version, tarball SHA-256/size/files, runtime versions,
  audit pins, and test evidence.

No upstream release source or tests are copied. Stagewise remains idea-only because of its
license. Release automation must not add package-download scripts, telemetry, an updater,
automatic merge, or an unrequested external publication.

## Compatibility and failure gates

- Both config families without `--config`: refuse; mutate nothing.
- Legacy config/state only: adopt in place; do not copy or rename.
- Malformed existing state: recovery-required; never initialize empty state over it.
- All three binary names: identical command tree, machine JSON, version, and exit semantics.
- Internal package path: closed-export failure from the packed artifact.
- Missing or extra tarball file: prepublication failure.
- Registry timeout/auth/5xx: ambiguous failure; never interpreted as package absence.
- Already-published exact version: skip only the write and repeat all verification.
- Release job bypasses a gate: workflow-structure test fails.
- Required real-host test skips: release is ineligible, not green.

## Required implementation order

1. Identity/config compatibility and focused characterization.
2. Packed-artifact smoke and release-manifest generation.
3. Preview/publish workflow plus structural workflow tests.
4. Product, migration, architecture, API, adapter, and publishing documentation.
5. Fresh ecosystem rescan and full committed-head release-candidate gate.
