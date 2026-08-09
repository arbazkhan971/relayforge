# ADR 008: RelayForge identity and release authority

Status: Accepted; identity/package foundations implemented. Packed Chrome/browser gate IN PROGRESS (`PACKED_CHROME_BROWSER_GATE_FINAL_UPDATE`). No tag, npm publish, GitHub release, or repository rename performed. Final committed-HEAD aggregate pending — see [implementation-status.md](../implementation-status.md).
Date: 2026-08-09

## Context

The implementation began as Loop Orchestrator and now contains a durable control plane,
explicit workflow state, containment, steering, SCM feedback, adapters, observability, and
multi-repository execution. A text-only rename would be incomplete; a destructive state
rename would be worse, because existing authoritative histories could appear absent.

The release audit compared Agent Orchestrator, MCO, Daintree, Stagewise, Scion, and Parallel
Code at exact pins. It found different winners for npm publication, packed-artifact proof,
workflow-gate proof, and compatibility. The detailed evidence and legal classifications are
in [the Phase 07 audit](../reference/phase-07-release-audit.md).

## Decision

### Public identity

- Product, npm package, help name, and primary executable: `RelayForge` / `relayforge`.
- Initial release target: `1.0.0-rc.1`.
- `loop` and `loop-orchestrator` remain v1 binary aliases.
- New init writes `relayforge.config.yaml`.
- Config discovery accepts either one RelayForge-family file or one legacy Loop-family file.
  Cross-family or within-family ambiguity is an error unless `--config` selects an exact file.

### Durable identity

Existing `.loop/` state, run and branch names, tmux ownership metadata, event schemas,
database identity, and authority marker literals remain byte-compatible. They are storage
protocol, not current branding. A future change requires its own audited, crash-recoverable,
one-way migration with characterization tests.

Public `RELAYFORGE_*` environment names become canonical where a public Loop variable exists.
The old name remains compatible for v1. If both are supplied with different values,
RelayForge refuses the conflict instead of choosing silently. Provider-internal legacy
variables remain wire protocol until every adapter and transcript contract migrates.

### Release authority

Only the exact packed artifact that passed the release gate is eligible for publication. A
release record binds:

- clean committed HEAD and matching `v<version>` tag;
- a dated changelog entry;
- npm tarball name, SHA-256, bytes, and allowlisted files;
- Node/npm versions and supported-major matrix;
- phase/reference audit pins and legal reuse ledger;
- typecheck, full tests, build, real product smoke, packed install, public exports/types,
  control-service lifecycle, and required-host evidence.

Registry publication is a separate write. It occurs only after the exact version is proven
absent; an auth, network, timeout, or server error is never absence. If publication succeeded
but later verification failed, a retry may skip the package write only after the registry
returns the exact expected version. It must still verify the intended dist-tag and perform a
clean registry installation.

### External boundary

Engineering may prepare the source, tarball, workflow, and release record. It must not claim
that npm publication, dist-tag mutation, GitHub release creation, or repository rename
happened unless the corresponding external operation was explicitly authorized and verified.

## Consequences

Benefits:

- RelayForge has a coherent product and CLI identity without orphaning prior users or runs.
- Packed behavior, rather than source-tree success, gates the release.
- Partial npm publication is recoverable and idempotent.
- Release workflow drift is tested as behavior.
- Old identifiers have an explicit retirement policy instead of an accidental deadline.

Costs:

- help/docs/tests carry compatibility names during v1;
- `.loop/` remains visible in storage paths despite the new brand;
- a future removal of aliases requires a major version and migration evidence;
- an RC can be source-complete while external publication remains pending.

## Rejected alternatives

- **Bulk replace every `loop` string.** Rejected because domain terms, provider wire fields,
  durable paths, and compatibility identifiers are not interchangeable with branding.
- **Rename `.loop/` on first start.** Rejected because a crash or competing process could
  create two authorities and because rollback is not naturally atomic across the tree.
- **Silently prefer a new config when both exist.** Rejected because the ignored file may
  represent the operator's actual authority.
- **Keep the package named `loop-orchestrator`.** Rejected because it leaves the public product
  evolution incomplete and makes future compatibility harder.
- **Publish on any `v*` tag after a source build.** Rejected because tag mistakes, missing
  tarball files, partial publication, and workflow dependency drift are established failure
  modes in the inspected ecosystem.
- **Copy MCO/Daintree release tests.** Rejected; RelayForge independently implements the
  behavior against its own package and retains only architectural inspiration.
