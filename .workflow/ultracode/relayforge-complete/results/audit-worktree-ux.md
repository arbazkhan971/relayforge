# Worktree UX, lifecycle, and distributed provisioning audit

Audited 2026-08-09. All reference trees remained unmodified.

## Reference matrix

| Repository | Audited commit | Best contribution | Important weakness | License | Reuse |
| --- | --- | --- | --- | --- | --- |
| `johannesjo/parallel-code` | `d000fff6` | Lightweight worktree/import UX, Git-ignore discovery, retryable cleanup UI | Symlinks mutable dependencies and potentially secrets; no durable reconciliation or operation lease | MIT | `ARCHITECTURAL_INSPIRATION` |
| `daintreehq/daintree` | `eb989c76` | Strongest local creation serialization/coalescing, lifecycle tests, topology monitoring and retry UX | Announces creation before setup completes; hooks unsandboxed; teardown failures can permit deletion; coupled service | Apache-2.0 plus NOTICE/trademark terms | `ARCHITECTURAL_INSPIRATION`; narrow ports only with attribution |
| `GoogleCloudPlatform/scion` | `91c26b34` | Strongest shared/container provisioning, advisory locks, sentinels, layered context and doctor | Provision/delete race, weak readiness sentinel validation, unsandboxed hooks, less local recovery UX | Apache-2.0 with Google file headers | `ARCHITECTURAL_INSPIRATION` |

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

## Chosen synthesis

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
