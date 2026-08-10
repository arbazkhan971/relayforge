# RelayForge completion run

## Goal

Evolve the existing Loop Orchestrator implementation into RelayForge: a coherent,
crash-recoverable, policy-enforced autonomous software-engineering control plane
that meets or exceeds the best relevant open-source implementations.

The user's global multi-repository reference mandate is a release gate. No phase,
subsystem, major feature, or consequential architecture decision may enter product
implementation before its source/test/history/license audit is complete.

## Implementation base

- Product repository: `/home/arbaz/loop-orchestrator`
- Active branch at discovery: `agent/loop-engineering-hardening`
- Discovery HEAD: `66b60821d45466c9c5e15640a48ad3de25919376`
- Legacy campaign material: `/home/arbaz/loop-ao`
- External research clones: `/home/arbaz/.relayforge-references`

The repository name and CLI remain Loop Orchestrator at discovery. RelayForge is
therefore a product evolution and eventual rebrand, not a claim about the current
tree.

## Deliverables

1. A phase-by-phase Reference Audit with source, tests, design documents, recent
   history, relevant issue/PR evidence, licenses, a Reference Matrix, and a chosen
   design.
2. `docs/upstream-sources.md` with file-level study records and explicit reuse
   classifications.
3. `docs/ecosystem-watch.md` with milestone rescans and newly discovered projects.
4. Safe self-hosting: isolated offline worktree provisioning and verifier-scope
   delegation without weakening containment or settlement.
5. A persistent loopback control plane with durable facts, explicit state
   machines, derived views, replayable events, crash recovery, and diagnostics.
6. Parent-owned steering, task leases, policy enforcement, capability-based agent
   adapters, and deterministic dispatch/verification.
7. Trusted SCM observation and idempotent PR/CI/review/conflict repair loops.
8. Live redacted observability, terminal/session inspection, and a usable control
   room.
9. Multi-repository execution with explicit repository scopes and atomic,
   recoverable integration semantics.
10. RelayForge branding, architecture/ADR/API/adapter documentation, release
    packaging, and an honest feature comparison.

## Definition of done

- Every phase has a completed Reference Audit before its implementation diff.
- Every external source has a checked license and recorded reuse classification.
- No copied or ported code is used unless the ledger records compatible terms and
  attribution; unclear licensing means independent implementation.
- Containment, parent-owned state, clean-tree gates, settlement evidence, secret
  redaction, and human-controlled publication remain fail closed.
- New behavior has deterministic unit, integration, failure, recovery, and
  regression coverage appropriate to its risk.
- `npm run typecheck`, `npm run test`, and `npm run build` pass on committed HEAD.
- Required real-world loopback/browser/CLI/Git/worktree smokes pass.
- Documentation claims match the shipped source.
- A fresh release-candidate ecosystem scan is recorded.
- No material item remains under “Verification still needed.”

## Discovery evidence and unknowns

- Typecheck and build passed on discovery HEAD.
- The full baseline suite reported 687 passed and 2 failed out of 689. The failures
  were a 30-second CLI traversal-test timeout and a 70.068-second newline-flood
  performance result against a 60-second product bound. These are pre-existing
  failures and must be resolved in product code or demonstrated as host contention;
  they may not be hidden by weakening tests.
- The legacy AO parity roadmap covers P0-P6 but is narrower than RelayForge's new
  multi-repository mandate. It will be superseded by phase audits and ADRs while
  preserving its safety constraints.
- The exact package/repository rename point remains an architectural/release
  decision; implementation capability work can proceed under the current package
  identity until that decision is audited.
