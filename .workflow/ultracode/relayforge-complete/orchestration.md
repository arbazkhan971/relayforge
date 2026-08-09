# Orchestration

The parent session owns all integration and final design decisions. Parallel
packets in a wave are read-only or have disjoint file ownership.

**Live handoff:** [docs/implementation-status.md](../../../docs/implementation-status.md)
(relative from this file). Branch `agent/loop-engineering-hardening`; last pushed
handoff commit `860688c55207be051431d470b44b038025a12e5c`. Large integration
source tree remains dirty/uncommitted beyond that checkpoint; no final
integration SHA exists. No tag, npm publish, GitHub release, repository rename,
or real native receipt has been performed.

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

| Packet | Kind | Owned files | Status |
| --- | --- | --- | --- |
| `provision-core` | worker | `src/provision.ts`, `tests/provision.test.ts` | done (99/99) |
| `provision-wiring` | worker | orchestrator/index/fake provider/E2E | done |
| `provision-doctor` | worker | config/doctor/config docs/focused test | done |
| `p0-closeout` | parent | roadmap, audit, attribution, workflow results | done |

## Capability waves (current status)

| Wave | Capability | Status | Evidence |
| --- | --- | --- | --- |
| P0.2 | Verifier cgroup delegation | done | required-host 21/21; nested 46/46 + 193/193; exact cgroup/no-leak |
| P1 | Durable control plane | done | focused 210/210 |
| P2 | Session steering | done | CLI live E2E 1/1; adjacent 25/25; exact cgroup/no-leak |
| P3 | SCM feedback machinery | done/product-integrated | focused 155/155; explicit SCM/P6 publication config drives publication, polling, and reaction-to-P2 |
| P4 | Adapter registry + natives | done (release receipts open) | OpenCode characterization exists with hardened fixture/required-host tests; real receipt needs designated runner + exact binary + live credential; Pi/Grok typed unavailable (no release receipt); ordinary OpenCode/Pi/Grok refuse before mutation; publish path fail-closed until distinct same-runner receipts |
| P5 | Live observability / control room | done | focused 125/125 |
| P6 | Multi-repository | **done (product-integrated)** | strict config/validation, CLI run route, ControlStore, authority, DAG/scheduler, worktree groups, contained transport/settlement, publication bridge, read isolation, crash recovery, real product E2Es; authority 21/21; orchestration 12/12; product/recovery/verifier 6/6; publication/SCM/integration 13/13 |
| P7 | Identity / release proof | local dirty-tree gates green; commit pending | aggregate 171 files / 1,925 tests + clean TS build; source smoke strong-path marker; exact preview tarball 1,626,928 bytes SHA-256 618ef91fd72c6a551ce21cd11ad753b5a11458ea5a2468ca75e80328db720b84; packed Chrome 150.0.7871.128 connected→degraded→recovered; final committed-HEAD aggregate pending; no tag/publish/rename/native receipt |

## Resume order (exact)

1. Do not tag, publish, rename, or invent native receipts.
2. Inspect/stage the dirty integration tree.
3. Create one reviewed integration commit of the complete product tree.
4. Rerun full committed-HEAD aggregate, source smoke, focused strong gates,
   exact preview + Chrome, and clean-tree scans.
5. Push the branch.
6. Separately implement and collect real Pi, Grok, and OpenCode same-runner
   release receipts (designated runner, exact installed binary, live credential
   where required).
7. Only with explicit operator authority after the above: tag, npm publish,
   GitHub Release, or repository rename.

Canonical tracker:
[docs/implementation-status.md](../../../docs/implementation-status.md).

## Guardrails

Workers must not modify unrelated safety, settlement, CI, or user-owned files
outside their packet ownership. This is a shared dirty worktree: preserve every
unrelated change. Do not commit, push, reset, checkout, tag, or publish from
documentation-only handoff packets unless the operator explicitly authorizes it.
