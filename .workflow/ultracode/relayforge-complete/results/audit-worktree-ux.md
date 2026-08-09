# Worktree UX, lifecycle, and distributed provisioning audit

Audited 2026-08-09. All reference trees remained unmodified.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| `johannesjo/parallel-code` `d000fff6` | Worktree creation/import, ignore discovery, selected links, ownership-aware cleanup, and focused ignore/link tests | Lightweight operator UX and a clear imported/user-owned distinction | Shares mutable dependencies and potentially secrets; lacks durable reconciliation and an operation lease | MIT | `ARCHITECTURAL_INSPIRATION` |
| `daintreehq/daintree` `eb989c76` | Serialized/coalesced worktree creation, topology monitoring, lifecycle service, retry UI, context injection, and broad lifecycle tests | Strongest inspected local lifecycle and race characterization | Announces creation before setup finishes; hooks are unsandboxed; teardown failures can permit deletion; tightly coupled service | Apache-2.0 plus NOTICE/trademark terms | `ARCHITECTURAL_INSPIRATION`; no source or tests copied |
| `GoogleCloudPlatform/scion` `91c26b34` | Shared/container provisioning, advisory locks, sentinels, layered context, recovery, doctor, and design/test corpus | Strongest shared-provisioning and diagnostic model | Provision/delete race, weak sentinel validation, unsandboxed hooks, and weaker local recovery UX | Apache-2.0 with Google file headers | `ARCHITECTURAL_INSPIRATION` |

## parallel-code evidence

- Create, ignored-path discovery, selected symlinks, `.claude` seeding, common
  excludes, and removal: `electron/ipc/git.ts:813-1173`.
- Coordinator create/ownership/race cleanup and retryable teardown:
  `electron/mcp/coordinator.ts:773-988`, `:1486-1573`, and `:1795-1849`.
- Serialized provider preamble writes and restoration:
  `electron/mcp/preamble.ts:39-157`.
- Imported-worktree protection: `src/store/tasks.ts:485-560` and `:623-655`.
- Ignore/exclude tests: `electron/ipc/git-worktree.test.ts:59-245` and
  `electron/ipc/git-symlink-excludes.test.ts:46-257`.
- Relevant recent fixes: `054060b`, `146578b`, `c9fcfff`, and `630249d`.

Its pleasant imported/user-owned worktree distinction should be retained. Its
default `node_modules`/`.env` symlinking is rejected because it shares mutable
state and secrets across workers.

## Daintree evidence

- Request coalescing, per-repository serialization, normalized keys, path/ref
  validation, pending topology and post-add monitoring:
  `electron/workspace-host/WorkspaceService.ts:2398-2678`.
- Canonical nearest-existing-ancestor containment:
  `electron/workspace-host/worktreeUtils.ts:147-212`.
- Topology reconciliation: `WorkspaceService.ts:686-694` and `:2352-2370`.
- Setup retry and lifecycle service:
  `WorkspaceService.ts:2748-2853` and
  `electron/workspace-host/WorktreeLifecycleService.ts:145-1035`.
- Idempotent mutation/deletion semantics: `WorkspaceService.ts:2867-3124`.
- Cancellation-aware context injection: `src/hooks/useContextInjection.ts:26-461`.
- Broad create, delete and lifecycle tests:
  `WorkspaceService.createWorktree.test.ts:284-1421`,
  `WorkspaceService.deleteWorktree.test.ts:239-950`, and
  `WorktreeLifecycleService.test.ts:52-1499`.
- Key bug fixes: `2f40ef9`, `928f036`, `41cd70e`, `835c5b9`, and
  `723716b`.

Daintree is the strongest local lifecycle reference, but RelayForge must never
equate a Git checkout with readiness. Setup is an explicit gated state and
failed external-resource teardown remains durable repair work.

## Scion evidence

- Host/container worktree guards and removal:
  `pkg/util/git.go:165-302`.
- Sentinel, stable identity, shared clone, advisory lock and per-agent worktree
  provisioning: `pkg/provision/provision.go:36-600`.
- Atomic-ish sharer registry: `pkg/provision/sharers.go:27-184`.
- Local stale-directory recovery and path policy:
  `pkg/agent/provision.go:469-705` and `:1690-1765`.
- Layered hooks, skills and mandatory context:
  `pkg/agent/provision.go:337-383`, `:804-1094`, and `:1391-1530`.
- Host/agent doctor: `cmd/doctor.go:37-190` and
  `cmd/sciontool/commands/doctor.go:28-548`.
- Design records: `.design/worktree-per-agent-phase1-plan.md:41-184`,
  `.design/worktree-guards.md:6-168`, and
  `.design/project-prestart-hooks.md:11-404`.
- Provision, sharer, recovery, delete, doctor and hook tests under
  `pkg/provision`, `pkg/agent`, `pkg/runtime`, and `cmd/sciontool`.

Scion's lock/idempotency/diagnostic ideas are valuable, but a sentinel alone is
not proof of readiness. RelayForge must validate remote/HEAD/configuration and
serialize provision with deletion under the same lease domain.

## Chosen design

### Best implementation discovered

Daintree is strongest for local lifecycle serialization and recovery UX;
Scion is strongest for shared provisioning, locking, layered context, and
doctor; Parallel Code is strongest for lightweight imported-worktree ergonomics.

### Why

Their source and tests solve complementary parts of the problem. None combines
readiness gating, durable intent, cross-process ownership, isolated dependency
provisioning, and repairable cleanup, so no single implementation is suitable
as the Phase 00 design.

### What RelayForge will reuse

Only `ARCHITECTURAL_INSPIRATION`: Parallel Code's user-owned distinction,
Daintree's coalescing/serialization and retry characterization, and Scion's
lock, topology, context, and doctor concepts. No code or tests were copied.

### What RelayForge will change

Setup becomes a blocking readiness state; dependency material is copied rather
than linked; hooks require a separate trusted bounded policy; cleanup retains
durable repair state; and cross-process leases complement in-process
serialization.

### How RelayForge will improve it

1. Persist a mutation ID and lifecycle intent, then combine Daintree-style
   in-process coalescing/serialization with a cross-process lock and RelayForge
   lease.
2. Reconcile the registry, `git worktree list --porcelain`, filesystem, branch
   ownership, provision result and live runtime at startup and periodically.
3. Model `CREATING → CREATED → PROVISIONING → READY`; dispatch requires `READY`.
4. Copy isolated dependencies by default. Never share `.env`; expose secrets by
   explicit references/policy only.
5. Make later hooks hashed, trusted, audited, bounded, cancellable and
   capability-constrained.
6. Make cleanup an idempotent saga with fresh dirty/ownership checks and durable
   acknowledgement; never delete imported/user-owned worktrees implicitly.
7. Build dedicated diagnostics for Git/common-dir behavior, topology drift,
   leases, locks, containment, provision results, runtime identity and agent
   health.

No code was copied during this audit.
