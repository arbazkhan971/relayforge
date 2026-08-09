# Orchestration

The parent session owns all integration and final design decisions. Parallel
packets in a wave are read-only or have disjoint file ownership.

## Wave R0: repository discovery and Phase 0 research

| Packet | Kind | Scope | Status |
| --- | --- | --- | --- |
| `discover-base` | explorer | Workspace candidates and legacy campaign state | done |
| `audit-ao-worktrees` | explorer | Untrivial/AgentWrapper Agent Orchestrator | done |
| `audit-worktree-ux` | explorer | Parallel Code, Daintree, Scion | done |
| `audit-modern-worktrees` | explorer | agtx, agent-worktree, Overstory, AWS CAO | done |
| `audit-setup-workflows` | explorer | Stagewise, MyClaude, ChatDev setup behavior | done |
| `provision-threat-review` | reviewer | Adversarial path, symlink, copy and publish design | done |
| `diagnose-baseline-tests` | explorer | Existing CLI/streaming timing failures | done |
| `phase0-synthesis` | parent | Reference Audit, matrix, attribution ledger, design | done |

No product implementation file is owned by a packet in Wave R0.

## Wave P0.1: worktree dependency provisioning

Begins only after `phase0-synthesis` is complete.

| Packet | Kind | Owned files | Expected return |
| --- | --- | --- | --- |
| `provision-core` | worker | `src/provision.ts`, `tests/provision.test.ts` | running |
| `provision-wiring` | worker | orchestrator/index/fake provider/new E2E test | running |
| `provision-doctor` | worker | config/doctor/config docs/new focused test | running |
| `p0-closeout` | parent | roadmap, audit, attribution, workflow results | Integrated review plus committed-HEAD verification |

Workers must not modify existing safety, settlement, CI, or unrelated test files.
The parent will assign exact disjoint ownership after auditing the current API and
the rejected historical attempt.

## Later waves

Each later capability wave is preceded by a new research wave and Reference Audit:

1. P0.2 verifier-scope delegation.
2. P1 durable daemon and event transport.
3. P2 steering and lifecycle derivation.
4. P3 SCM feedback.
5. P4 capability/adapter registry.
6. P5 live observability and control room.
7. Multi-repository scheduler, leases, policy, and recovery.
8. RelayForge product/release completion.
