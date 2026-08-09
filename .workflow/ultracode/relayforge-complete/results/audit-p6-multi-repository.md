# Phase 06 reference audit: multi-repository scheduling and integration

- Status: research gate complete; implementation gates remain open
- Date: 2026-08-09
- RelayForge baseline: `73051d510c6473fa763bc7cd81921f65bec00eea`
- Decision: [`docs/adr/007-multi-repository-execution.md`](../../../../docs/adr/007-multi-repository-execution.md)

## Scope and method

This audit covers repository identity, task-to-repository scope, dependency DAGs,
capability routing, bounded concurrency, worktree groups, cross-repository local
integration, crash recovery, remote publication, and operator recovery.

Untrivial Agent Orchestrator was inspected first. GitHub was then searched for
current coding-agent orchestrators and adjacent schedulers using combinations of
`multi repository coding agent`, `coding agent scheduler`, `agent worktree
manager`, `distributed task scheduler leases`, `DAG workers`, and `multi repo
transaction`. The initial corpus was expanded with DoorDash Agentic Orchestrator,
Kandev, Dagu, AgentsMesh, Kubernetes, Temporal, Nomad, and Scion. Source, tests,
design material, history, licenses, NOTICE files, and explanatory issues or PRs
were inspected. README claims were treated as discovery hints only.

The repositories were pinned locally and rechecked on 2026-08-09. The
`AgentWrapper/agent-orchestrator` remote resolved to the same commit and tree as
Untrivial Agent Orchestrator; it is independently named but supplies no second
implementation at this pin.

## Decision summary

RelayForge will model a multi-repository task as one durable, ordered set of
repository IDs, never as an ambient directory scan. A task attempt receives one
isolated worktree per authorized repository, created and provisioned as a group
before the provider is released. Scheduling is a durable reconcile operation:
dependency readiness and capability admission are projections, while a
generation-fenced lease is the only dispatch authority.

Local multi-repository integration is a recoverable saga, not falsely advertised
as an atomic Git operation. RelayForge prepares every candidate without moving a
target ref, verifies the complete candidate vector, applies each ref with
compare-and-swap, records each result transactionally, and compensates only refs
that it can prove it changed. An external ref movement or uncertain result enters
`recovery_required`; RelayForge never overwrites the external change. Remote
pushes and pull requests are a later, separately idempotent publication stage and
cannot retroactively make the local vector atomic.

The strongest implementation discovered per subproblem is:

- multi-repository worktree lifecycle: Untrivial Agent Orchestrator;
- persistent per-repository identity and resume ergonomics: Kandev;
- cross-repository candidate/CAS/compensation: DoorDash Agentic Orchestrator;
- dirty/processing reconcile semantics: Kubernetes workqueue;
- durable history and retry identity: Temporal plus RelayForge Phase 01;
- dequeue token, Ack/Nack, priority, and delivery-limit tests: Nomad;
- lightweight scheduled concurrency: Scion; and
- distributed claim/heartbeat failure taxonomy: Dagu, used only as negative and
  idea-level evidence because several authority paths fail open.

## Exact pins, activity, and legal review

| Repository | Audited object and recent activity | License / NOTICE | Reuse classification |
|---|---|---|---|
| [Untrivial Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec) | `f65c48e296e20a816221a4003c75a5f0387967ec`; 2026-08-09; multi-repo workspace lifecycle present in the squashed tree | Apache-2.0; no root NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| [DoorDash Agentic Orchestrator](https://github.com/doordash-oss/agentic-orchestrator/tree/101ca9a416371c4d9db0935cf4aef73f77551366) | `101ca9a416371c4d9db0935cf4aef73f77551366`; 2026-08-09; 99 commits in the preceding 90 days | Apache-2.0; `NOTICE.txt`; sampled files carry DoorDash copyright | `ARCHITECTURAL_INSPIRATION`; independent port of behavior only |
| [Kandev](https://github.com/kdlbs/kandev/tree/bbdd4267768e3b683bb3799e900bc69e155d0659) | `bbdd4267768e3b683bb3799e900bc69e155d0659`; 2026-08-09; 1,343 commits in the preceding 90 days | AGPL-3.0; no root NOTICE found | `IDEA_ONLY`; no code or test copying |
| [Dagu](https://github.com/dagucloud/dagu/tree/99863067370950e33a31969f77a07127ea09fe8f) | `99863067370950e33a31969f77a07127ea09fe8f`; 2026-08-09; 394 commits in the preceding 90 days | GPL-3.0; source files state `GPL-3.0-or-later` | `IDEA_ONLY`; no code or test copying |
| [AgentsMesh](https://github.com/AgentsMesh/AgentsMesh/tree/1f90b14194d03c353df4f281a05442afe93cae34) | `1f90b14194d03c353df4f281a05442afe93cae34`; 2026-08-03; 82 commits in the preceding 90 days | Business Source License 1.1, no production grant, change date 2030-02-28; NOTICE present | `IDEA_ONLY` / `NOT_USED` for code |
| [Kubernetes](https://github.com/kubernetes/kubernetes/tree/94c136764292cc5fac976c0de6587daaea56410f) | `94c136764292cc5fac976c0de6587daaea56410f`; 2026-08-08 | Apache-2.0; project NOTICE applies | `ARCHITECTURAL_INSPIRATION` |
| [Temporal](https://github.com/temporalio/temporal/tree/023cb7d861b6cc0e139564b2faaf10c106a7f37d) | `023cb7d861b6cc0e139564b2faaf10c106a7f37d`; 2026-08-07 | MIT; no root NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| [Nomad](https://github.com/hashicorp/nomad/tree/d78b9b59529a1503f013bb9f86f2e75c7cf889d4) | `d78b9b59529a1503f013bb9f86f2e75c7cf889d4`; 2026-08-07; 200 commits in the preceding 90 days | BUSL-1.1 for current source; sampled files have IBM copyright and SPDX | `IDEA_ONLY`; no code or test copying |
| [Google Scion](https://github.com/GoogleCloudPlatform/scion/tree/91c26b3) | `91c26b3`; 2026-08-08 | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |

No `DIRECT_COPY`, `MODIFIED_COPY`, or source-level `PORTED_IMPLEMENTATION` is
approved. RelayForge will independently implement the selected state machines
and write its own characterization tests. If implementation later copies an
expression, fixture, comment, or test, the ledger must be amended before commit.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Agent Orchestrator | `WorkspaceProject`, nested child worktrees, per-repo durable rows, preserve/restore/cleanup | Best coding-agent multi-repo worktree lifecycle and destructive-cleanup tests | One shared branch name; no recoverable cross-ref integration transaction | Apache-2.0 | Adapt architecture |
| DoorDash Agentic Orchestrator | durable transaction journal, detached candidate worktrees, Git ref CAS, conditional rollback | Best inspected multi-repo local integration and crash/race tests | Per-repo CAS is necessarily a saga; current event/lease authority is weaker than RelayForge P1 | Apache-2.0 + NOTICE | Independent behavioral port |
| Kandev | task/repo rows, per-repo environment/worktree/PR identity, resume and fan-out tests | Best operator-facing per-repo identity, migration, resume, and parallel read ergonomics | AGPL; no equivalent recoverable all-repo integration transaction found | AGPL-3.0 | Idea only |
| Dagu | queue processor, attempt leases, worker poller, zombie detector | Strong claim/heartbeat/staleness and queue failure corpus | GPL; watermark corruption and some lease-read errors fail open | GPL-3.0-or-later | Negative/idea evidence only |
| AgentsMesh | task scheduler, command queue, runner worktrees | Useful adjacent remote-runner shape | BSL with no production grant; no stronger multi-ref transaction found | BUSL-1.1 | Not used for code |
| Kubernetes | workqueue dirty/processing sets; leader lease | Best minimal reconcile dedup semantics and explicit non-fencing warning | In-memory queue is not durable; leader election explicitly does not fence | Apache-2.0 | Adapt concepts |
| Temporal | matching backlog reader/writer, ack levels, retry identities, history | Best durable workflow identity/replay and mature queue failure coverage | Distributed platform machinery is far beyond the local control-plane need | MIT | Architecture inspiration |
| Nomad | eval broker token, Ack/Nack timeout, priority/FIFO, plan queue | Best compact dequeue-token and delivery-limit tests | BUSL; broker is leader-memory state; Ack/Nack RPC failures are logged/swallowed | BUSL-1.1 | Idea and negative evidence |
| Scion | persistent schedules, global semaphore, advisory singleton | Best lightweight scheduled-concurrency ergonomics among coding-agent references | Advisory-lock absence can run unguarded; goroutine shutdown is weaker | Apache-2.0 | Test/design inspiration |

## Source, tests, design, and history evidence

### Untrivial Agent Orchestrator

Studied
[`backend/internal/ports/outbound.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/ports/outbound.go),
[`domain/project.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/domain/project.go),
the Git worktree adapter
[`workspace.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/adapters/workspace/gitworktree/workspace.go),
session manager materialization/restore/cleanup, SQLite session-worktree stores,
and architecture and lifecycle-persistence documents.

`WorkspaceProject` explicitly materializes a root repository and registered
children at validated relative paths. It canonicalizes source roots, refuses
unsafe relative paths, chooses one branch name free in all repositories, rolls
back partial creation in reverse order, records one durable row per worktree,
destroys children before the root, and preserves every repository on shutdown.
The session manager tests cover runtime failure after worktree creation,
per-row persistence failure, dirty rows, unregistered child rows, restore,
replacement, force-destroy failure, registry drift, and preservation conflicts.

This is the worktree lifecycle baseline RelayForge must meet. Its shared branch
name is pleasant but cannot define repository identity, and the workspace layer
does not prepare a verified candidate vector or make multiple refs atomic. The
current audited tree is a squash-root history, so `git blame` cannot explain the
earlier multi-repo evolution; that limits historical confidence despite strong
present tests.

### DoorDash Agentic Orchestrator

Studied
[`internal/feature/transaction.go`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/feature/transaction.go),
[`internal/orchestrator/child_transaction.go`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/orchestrator/child_transaction.go),
[`internal/git/ref_cas.go`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/git/ref_cas.go),
and
[`internal/git/merge_candidate.go`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/git/merge_candidate.go).

The journal records ordered repositories, target refs, original anchors,
expected refs, child heads, candidate commits, observed refs, dirty/conflict
state, and diagnostics. Candidate commits are produced in detached temporary
worktrees without advancing parent refs. Apply uses `git update-ref --stdin`
with the expected old SHA. Every successful application is persisted. If a
later repository fails, earlier refs are compensated only when their current
SHA still proves they contain the transaction's candidate. External movement
is retained and parked as attention instead of overwritten.

Studied tests include
[`ref_cas_test.go`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/git/ref_cas_test.go),
[`child_transaction_internal_test.go`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/orchestrator/child_transaction_internal_test.go),
the
[`three-repository integration test`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/test/integration/phase_implement_unified_3repo_cross_repo_test.go),
and the full transactional multi-repo journey. They cover clean two/three-repo
application, later CAS failure rolling back earlier refs, process interruption
after all CAS operations but before journal completion, idempotent resume,
conflicts, dirty parents, and external ref movement.

The implementation entered in commit
[`4dbd261ad321852e330254922174f7c37f34e188`](https://github.com/doordash-oss/agentic-orchestrator/commit/4dbd261ad321852e330254922174f7c37f34e188),
merged as [PR #113](https://github.com/doordash-oss/agentic-orchestrator/pull/113).
The PR describes durable child execution and recoverable transactional
integration. Some race/E2E checklist boxes in its PR body were not checked at
merge, although the current tree now contains the corresponding tests. This is
the strongest implementation for local integration, not proof of impossible
cross-repository atomicity.

### Kandev

Studied the executor and
[`executor_multi_repo_test.go`](https://github.com/kdlbs/kandev/blob/bbdd4267768e3b683bb3799e900bc69e155d0659/apps/backend/internal/orchestrator/executor/executor_multi_repo_test.go),
the lifecycle
[`env_preparer_worktree.go`](https://github.com/kdlbs/kandev/blob/bbdd4267768e3b683bb3799e900bc69e155d0659/apps/backend/internal/agent/runtime/lifecycle/env_preparer_worktree.go),
[`manager_multi_repo_test.go`](https://github.com/kdlbs/kandev/blob/bbdd4267768e3b683bb3799e900bc69e155d0659/apps/backend/internal/worktree/manager_multi_repo_test.go),
and
[`store_multi_repo_test.go`](https://github.com/kdlbs/kandev/blob/bbdd4267768e3b683bb3799e900bc69e155d0659/apps/backend/internal/github/store_multi_repo_test.go).

Kandev persists ordered task-to-repository rows, prepares one worktree per
repository, exposes one task root, prevents repository-secret key conflicts
before launch, reports a failing secondary repository, and persists per-repo
environment, worktree, branch, and PR rows. Worktree cache identity includes
session, repository, and branch slug. Migration tests protect legacy PR rows and
avoid duplicate watches.

Important bug-fix PRs explain the real edge cases:

- [#2138](https://github.com/kdlbs/kandev/pull/2138) parallelizes multi-repo Git
  log/diff fan-out while keeping deterministic subpath-order error selection and
  a shared Git throttle;
- [#1905](https://github.com/kdlbs/kandev/pull/1905) fixes resume retaining only
  the primary repository and orphaning a process;
- [#2007](https://github.com/kdlbs/kandev/pull/2007) prevents self-referential
  directory junction cleanup and requires filesystem identity before deletion;
- [#1568](https://github.com/kdlbs/kandev/pull/1568) replaces stale task
  worktree paths with provider-backed repository identity; and
- [#1795](https://github.com/kdlbs/kandev/pull/1795) fixes base-branch mismatch
  dropping all review files.

Kandev has the best inspected per-repository UX/identity regression corpus, but
its AGPL license makes it idea-only and no equivalent candidate/CAS/compensation
transaction was found.

### Dagu

Studied
[`queue_processor.go`](https://github.com/dagucloud/dagu/blob/99863067370950e33a31969f77a07127ea09fe8f/internal/service/scheduler/queue_processor.go),
[`distributed_attempts.go`](https://github.com/dagucloud/dagu/blob/99863067370950e33a31969f77a07127ea09fe8f/internal/service/coordinator/distributed_attempts.go),
[`worker/poller.go`](https://github.com/dagucloud/dagu/blob/99863067370950e33a31969f77a07127ea09fe8f/internal/service/worker/poller.go),
[`zombie_detector.go`](https://github.com/dagucloud/dagu/blob/99863067370950e33a31969f77a07127ea09fe8f/internal/service/scheduler/zombie_detector.go),
[`watermark_store.go`](https://github.com/dagucloud/dagu/blob/99863067370950e33a31969f77a07127ea09fe8f/internal/service/scheduler/watermark_store.go),
and their focused tests.

Useful concepts are explicit queue reservations, attempt identity,
claim/acknowledgement before execution, lease heartbeats, jittered polling,
bounded concurrency, and more than one stale observation before zombie action.
Rejected behavior is equally important: a lease-store read error can be treated
as not-inactive, and an unknown/corrupt watermark can start fresh. RelayForge
must enter an unavailable/recovery state on equivalent authority uncertainty.
The GPL license independently prohibits source/test copying into this project.

### Kubernetes and Temporal

Studied Kubernetes
[`workqueue/queue.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/client-go/util/workqueue/queue.go)
and
[`queue_test.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/client-go/util/workqueue/queue_test.go).
The dirty/processing sets guarantee that a key changed during reconciliation is
processed once more after `Done`, without spawning duplicate simultaneous work.
RelayForge adopts this semantic in durable projections, not the in-memory queue.

Kubernetes
[`leaderelection.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/client-go/tools/leaderelection/leaderelection.go)
explicitly says it does not provide fencing. Its `ReleaseOnCancel` warning also
requires work to finish before cancellation. RelayForge therefore rejects
"lease exists" as mutation authority: generation and expected-version fences
must accompany every event, worktree, ref, and publication mutation.

Studied Temporal's matching
[`task_reader.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/matching/task_reader.go),
[`task_writer.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/matching/task_writer.go),
ack manager, physical task queue tests, fairness tests, and history/rebuild
contracts. The mature separation between durable backlog, dispatch, completion,
ack level, retry identity, and projection recovery reinforces the Phase-01
ControlStore design. PRs/commits around task-queue fairness (#7967/#8500), the
read-level race (#5142), writer data race (#5892), and dropped-task observability
(#10759/#10642) supply regression ideas. RelayForge does not import Temporal's
distributed matching service.

### Nomad and Scion

Studied Nomad
[`eval_broker.go`](https://github.com/hashicorp/nomad/blob/d78b9b59529a1503f013bb9f86f2e75c7cf889d4/nomad/eval_broker.go),
[`eval_broker_test.go`](https://github.com/hashicorp/nomad/blob/d78b9b59529a1503f013bb9f86f2e75c7cf889d4/nomad/eval_broker_test.go),
[`plan_queue.go`](https://github.com/hashicorp/nomad/blob/d78b9b59529a1503f013bb9f86f2e75c7cf889d4/nomad/plan_queue.go),
its tests, and the scheduler worker. The broker demonstrates explicit random
dequeue tokens, token-checked Ack/Nack, Ack timeout, redelivery limit,
per-job serialization, priority, and FIFO within a priority. The plan queue
supports optimistic planning followed by leader validation. But both queues are
leader-memory structures, and worker Ack/Nack RPC errors are logged and
swallowed. RelayForge uses the tests as behavioral inspiration only and persists
admission, lease, dispatch, and completion as canonical events.

Scion's scheduler source/tests were inspected for persistent one-shot schedules,
startup recovery of expired timers, recurring jitter, and a shared concurrency
semaphore. Its advisory singleton runs without a guard when the store lacks the
optional lock interface, and recurring goroutines have weaker shutdown
accounting than RelayForge requires. The useful ergonomic concepts are retained;
the authority behavior is rejected.

## Quality score by relevant surface

Scores use the requested weighting: correctness 25, tests 20, failure handling
15, architecture 15, maintainability 10, activity 5, performance 5, and license
suitability 5. A high subsystem score does not authorize code reuse.

| Repository/surface | Correct | Tests | Failure | Arch | Maintain | Activity | Perf | License | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| DoorDash multi-ref transaction | 24 | 20 | 15 | 14 | 9 | 5 | 4 | 5 | **96** |
| AO multi-repo workspace lifecycle | 23 | 20 | 14 | 14 | 9 | 5 | 4 | 5 | **94** |
| Kubernetes reconcile/fencing guidance | 25 | 20 | 15 | 15 | 10 | 5 | 5 | 5 | **100** |
| Temporal durable matching/history | 25 | 20 | 15 | 15 | 9 | 5 | 5 | 5 | **99** |
| Nomad eval/plan broker | 23 | 20 | 13 | 15 | 9 | 5 | 5 | 0 | **90** |
| Kandev multi-repo identity/UX | 21 | 19 | 13 | 13 | 9 | 5 | 5 | 0 | **85** |
| Dagu distributed attempts | 18 | 18 | 9 | 12 | 8 | 5 | 4 | 0 | **74** |
| Scion scheduler | 18 | 15 | 10 | 13 | 8 | 5 | 4 | 5 | **78** |

Kubernetes and Temporal score highest for their narrow infrastructure surfaces;
they are not coding-agent worktree implementations. DoorDash and AO win the two
coding-specific surfaces RelayForge needs to synthesize.

## Consequential implementation comparisons

### Worktree group strategy

**Agent Orchestrator:** one session root, root repo plus validated child paths,
one branch name, reverse rollback, durable per-repo inventory, rich dirty/
restore/cleanup tests.

**Kandev:** one task root, per-repository and per-branch identities, independent
provider/base configuration, persisted environments and PRs, strong migration
and resume regression tests.

**RelayForge:** one private attempt root containing an ordered map of
`RepositoryId -> WorktreeIdentity`. Each repo retains its own base ref/anchor and
branch, even when display names match. All entries must be created, provisioned,
revalidated, and recorded before dispatch. Failure rolls back owned clean entries
in reverse order; dirty or identity-uncertain entries are preserved for recovery.
Provider visibility is limited to the task's declared repository set.

### Scheduler strategy

**Kubernetes:** deduplicated reconcile keys with dirty-while-processing replay;
not durable and its leader lease does not fence.

**Nomad:** priority/FIFO broker with Ack/Nack delivery token and bounded
redelivery; authoritative queue is in-memory and acknowledgement failure is best
effort.

**Temporal:** durable backlog/history, ack levels, retry identities, and rebuild;
far broader than a local coding control plane.

**RelayForge:** canonical ControlStore events are the queue. A pure projection
computes readiness, but dispatch requires a transaction that compares task
generation/version, records an immutable repository-set hash, and acquires a
lease token. Every later event supplies that token and expected version. Expiry
causes reconciliation, never automatic proof that the old worker stopped.

### Cross-repository integration

**DoorDash:** prepare detached candidates, persist, per-repo CAS, persist each
apply, conditionally roll back, park uncertain/external changes as attention.

**Kandev/AO:** excellent workspace/PR lifecycle, but no stronger inspected local
multi-ref transaction.

**RelayForge:** independently implements the DoorDash behavioral pattern on the
P1 event authority, adds ordered repository leases, generation fencing,
deterministic combined verification, digest-bound receipts, explicit uncertain
states, and separate remote publication. Compensation is not described as
rollback if it cannot restore the original vector exactly.

## Chosen design

### Best implementation discovered

There is no best overall repository. DoorDash is strongest for the local
candidate/CAS/compensation algorithm; AO is strongest for worktree-group
lifecycle; Kandev is strongest for per-repo operator identity; Kubernetes and
Temporal supply the reconcile and durable-history semantics.

### Why

Combining these proven boundaries avoids three common design errors: granting a
filesystem layout semantic identity, confusing lease ownership with fencing,
and claiming an impossible atomic transaction across independent Git refs or
remote forges.

### What RelayForge will reuse

- `ARCHITECTURAL_INSPIRATION`: worktree groups, durable per-repo inventory,
  reverse cleanup, detached candidate preparation, expected-old ref CAS,
  conditional compensation, dirty/processing reconciliation, dequeue-token
  semantics, explicit Ack/Nack phases, and durable retry identity.
- Public Git behavior: `git worktree`, detached candidate creation, merge-tree/
  merge candidate inspection, and `git update-ref` expected-old semantics,
  independently wrapped and tested.

### What RelayForge will change

- Every repository, task generation, attempt, lease, worktree, candidate, ref
  update, and remote artifact receives a typed identity and canonical event.
- Leases are acquired in sorted repository-ID order and fence every mutation;
  mere expiry or process death never authorizes a stale writer.
- The entire candidate vector is prepared and verified before the first target
  ref moves.
- A digest-bound integration receipt records exact anchors, candidates, apply
  results, compensation results, verification commands/results, and authority
  versions.
- External movement or an unreadable ref/store enters `recovery_required`; no
  reset, force push, guessed rollback, or silent fresh state is allowed.
- Remote push/PR creation is a separately gated, idempotent saga with per-repo
  receipts and cross-links. Local success is not remote atomicity.
- Concurrency is bounded globally, per provider, per repository, and per task;
  deterministic repository order controls both locks and diagnostics.

### How RelayForge will improve it

RelayForge adds canonical P1 event history, generation fencing, deterministic
lease ordering, capability-aware admission, full-vector verification,
cryptographic receipt digests, one settlement/containment path, typed uncertainty,
and end-to-end crash tests at every durable transition. These are substantive
improvements over the strongest coding-agent reference without rewriting its
sound Git CAS idea merely for originality.

## Domain and authority contract

### Stable identities

- `RepositoryId`: validated configuration ID; never inferred from basename.
- `RepositorySetId`: SHA-256 of canonical ordered repository IDs and immutable
  base-policy fields.
- `TaskGeneration`: increases only through the durable reopen transition.
- `AttemptId`: unique within task generation.
- `TaskLeaseToken`: random token bound to task generation, attempt, repository
  set, owner incarnation, lease version, and expiry.
- `WorktreeIdentity`: repository ID, source device/inode or Git common-dir
  identity, path, branch/ref, anchor OID, and lifecycle state.
- `IntegrationTransactionId`: immutable vector transaction identity.
- `RepositoryTransactionEntry`: target ref, anchor, expected OID, child head,
  candidate OID, observed OID, apply/compensation state, and diagnostics.
- `PublicationId`: repository-scoped remote artifact identity, separate from the
  local integration transaction.

Display names and directory paths are attributes, not identity. The same branch
label in two repositories does not imply the same ref or base.

### Task graph and repository scope

Each planned task declares a non-empty ordered repository set drawn from the
project registry. Role configuration declares a maximum repository capability
set. Admission requires the task set to be a subset of the role and provider
capabilities. Dependency edges reference exact task IDs and are validated as an
acyclic graph before any lease, worktree, provider call, or cost reservation.

The planner may propose repository scopes, but the parent validates and commits
them. A provider cannot expand its own scope. A later scope change creates a new
task generation or explicit replanning event; it never mutates an active lease.

### Durable scheduler

Reconciliation keys are task IDs. A task may be both processing and dirty; a
new relevant event while processing guarantees one subsequent reconciliation.
The canonical database, not the wake channel, owns this fact.

Admission transaction invariants:

1. run and task are nonterminal;
2. task generation and expected aggregate version match;
3. every dependency is durably accepted in its expected generation;
4. role/provider/repository capabilities and budgets are available;
5. concurrency reservations fit global, provider, repo, and task bounds;
6. no incompatible repository lease is live or uncertain;
7. repository-set digest matches the planned task; and
8. lease-granted and dispatch-admitted events commit atomically.

Dispatch is a second acknowledged fact after the contained child passes the
existing launch gate. Admission alone is never execution. Completion, retry,
expiry, cancellation, and recovery all compare the lease token and aggregate
version. A stale worker can submit evidence, but cannot mutate authority.

### Worktree group lifecycle

States are `planned -> creating -> ready -> active -> settling -> preserved |
reclaimable -> reclaimed`, with `recovery_required` from any identity-uncertain
transition. The group becomes `ready` only after every member:

- resolves to the configured canonical repository identity;
- has a safe private destination and unique branch/ref;
- records its anchor OID and clean-state proof;
- completes required provisioning and executable checks;
- passes source/destination identity revalidation; and
- is durably recorded with the same lease/repository-set token.

If creation fails, RelayForge walks owned entries in reverse order. It removes
only a clean worktree whose current identity and registration match the receipt.
Dirty, externally moved, locked, replaced, or unprovable paths remain preserved
with actionable recovery facts.

### Local integration transaction

Transaction states are:

`planning -> preparing -> prepared -> verifying -> verified -> applying ->
applied | compensating -> compensated | recovery_required`.

The parent acquires repository integration leases in sorted `RepositoryId`
order. For each repo it records the current target ref and expected OID, creates
a detached candidate from that exact OID, integrates the child head, validates
the resulting parent shape, and persists the candidate. No target ref moves in
prepare or verify.

Combined verification runs against a deterministic workspace manifest binding
every candidate OID and repository path. Only after a durable `verified` event
does apply begin. Each apply performs one expected-old ref CAS and records the
observed result before proceeding. A crash resumes from canonical events and
re-reads every ref before acting.

On failure, compensation walks successfully applied entries in reverse order.
It restores an anchor only if the ref still equals RelayForge's exact candidate.
Any other observation is external or uncertain and parks the entire vector in
`recovery_required`. Candidate commits and receipts are retained until a later
verified terminal decision.

### Remote publication

Remote publication occurs only after local applied state and a policy/human
gate. Each repository push uses an explicit remote/ref/expected remote OID or a
new unique ref and receives an idempotency receipt. PR/MR creation uses a stable
publication key and records provider request/response identities. Cross-links
are patched idempotently after all artifact IDs exist. A partial remote result is
reported as partial publication; RelayForge does not force-delete remote refs or
claim atomic rollback.

## Architectural consistency gate

Any P6 implementation must answer yes to all of these:

- Is every mutation represented in canonical ControlStore history?
- Are task, attempt, repository-set, lease, and aggregate generations checked?
- Is admission separate from launch acknowledgement and completion?
- Is the provider restricted to the declared repository capability set?
- Are worktrees private, identity-bound, provisioned, observable, and recoverable?
- Are all process calls routed through the existing contained transport and
  settlement authority?
- Are ref changes expected-old CAS operations with before/after evidence?
- Is combined verification deterministic and receipt-bound?
- Can every crash transition reconcile without guessing or destroying evidence?
- Are uncertain/external states surfaced, not silently reset?
- Are remote publication and local integration represented separately?

An external component that cannot fit these invariants is adapted or
independently reimplemented. RelayForge's domain model does not bend around it.

## Failure, recovery, and adversarial matrix

| Failure or race | Required durable result | Recovery/assertion |
|---|---|---|
| Duplicate repository ID or physical repo alias | config rejected | no filesystem access or event |
| Nested/overlapping destination paths | config rejected | exact indexed diagnostic |
| Task references unknown/unauthorized repo | plan rejected | no lease/provider call |
| Dependency cycle/self-edge | plan rejected | deterministic cycle path |
| Dependency completes while key processing | task remains dirty | exactly one later reconcile |
| Two schedulers admit same generation | one transaction wins | loser receives stale version/lease conflict |
| Lease expires while old child lives | state uncertain | no new writer until exact settlement/recovery |
| Stale worker reports completion | evidence retained, mutation refused | token/generation mismatch |
| Provider or repo concurrency full | task blocked with reason | wake/reconcile on release; no polling storm |
| Crash after admission before spawn | admitted, not dispatched | release reservation after owner-incarnation proof |
| Crash after child spawn before dispatch ack | launch handshake/journal reconciled | settle exact scope before redispatch |
| First worktree succeeds, second fails | reverse owned cleanup | dirty/uncertain first is preserved |
| Worktree path or Git registration replaced | recovery required | no delete/force cleanup |
| Provisioning fails in one repo | group never ready | no provider/verifier observes partial group |
| Source ref moves before candidate prepare | expected mismatch | rebuild only through explicit new plan/version |
| Merge conflict in one repo | transaction not prepared | retain conflict diagnostics/candidates |
| Crash after all candidates before verified event | prepared vector recoverable | rerun deterministic verification |
| Verification command mutates a candidate | verification refused | identity/cleanliness mismatch retained |
| Ref moves between verify and apply | pre-CAS mismatch | recovery/replan, never overwrite |
| First CAS succeeds, second CAS fails | compensate first if still exact candidate | otherwise recovery required |
| Crash after CAS before event commit | ref/event disagreement | re-read exact ref; append recovered result only with receipt proof |
| External actor moves already-applied ref | no compensation over external move | recovery required with observed OID |
| Compensation crashes mid-vector | resumable reverse walk | token/CAS makes repeats idempotent |
| Store integrity or ref read fails | recovery required | no fail-open fresh state |
| Duplicate publish request | existing receipt returned | no second push/PR |
| One remote push succeeds, next fails | partial publication | retry missing artifact only; no atomicity claim |
| Remote ref moves unexpectedly | publication conflict | no force push |
| PR created but receipt commit crashes | discover by stable head/base/key | bind exact existing PR or require recovery |
| Cancellation during integration | stop before next transition | settle process; preserve candidates and journal |
| Shutdown with in-flight reconciles | stop admission, drain known owners | dirty keys remain durable for restart |
| Very wide graph/repo set | bounded refusal | exact task/repo/edge limits |
| Malicious repo name/path/ref | strict ID/path/ref validation | argv-only Git; no shell interpolation |

## Required tests before implementation can be called complete

1. Pure schema/DAG tests: duplicate/alias/nesting, unknown scopes, role subset,
   cycles, stable topological order, width/depth bounds, canonical set digest.
2. Scheduler model tests: dirty-while-processing, two-owner races, generation and
   lease fencing, four-dimensional concurrency, fairness/starvation bounds,
   cancellation, shutdown, expiry with live owner, and crash/restart replay.
3. Real Git worktree-group tests: two and three repositories, different default
   branches, duplicate branch labels, partial creation, locked/stale/dirty/
   replaced worktrees, provisioning failure, reverse cleanup, and restart.
4. Real Git integration tests: prepare without ref movement, merge conflict,
   exact parent shape, full-vector verification, per-repo CAS, external movement,
   later-CAS compensation, every crash point, and idempotent resume.
5. Real child E2E: a contained agent edits two authorized repositories, cannot
   see a third, produces two candidate heads, verifies combined behavior, and
   lands through the recoverable transaction.
6. Publication fakes plus opt-in real forge gates: duplicate push/PR, partial
   failure, restart discovery, remote movement, cross-link retry, review/CI
   correlation, and no force operations.
7. Property/model checking: arbitrary crash point and retry sequences preserve
   "never overwrite an unproven ref" and "at most one fenced task generation may
   mutate each repository".
8. Full existing single-repository suite: an omitted `repositories` field must
   retain exact P0-P5 behavior and performance.

Every adapted behavior follows:

`REFERENCE -> CHARACTERIZATION TEST -> IMPLEMENT -> UNIT -> INTEGRATION ->
FAILURE -> REAL GIT/CHILD -> REGRESSION -> COMMIT -> TEST COMMITTED HEAD`.

## File-exclusive implementation packets

The implementation is deliberately split so parallel agents do not share hot
files. Integration order is P6-A, B/C/D/E in parallel, F, G, H, then I.

### P6-A — domain, configuration, and DAG validation

Own: new `src/multirepo/domain.ts`, new `src/multirepo/dag.ts`,
`src/config/schema.ts`, `src/config/validate.ts`, and focused tests. Add strict
repository IDs, canonical physical alias checks, role/task scopes, graph bounds,
stable topology, and repository-set digests. Do not remove the current
unsupported-feature rejection until all implementation gates can compose.

### P6-B — durable scheduler projection and leases

Own: new `src/multirepo/events.ts`, `src/multirepo/scheduler.ts`, focused tests,
and only additive P1 event/store changes agreed with the P1 owner. Implement
ready/dirty/processing projections, admission transactions, generation-fenced
leases, concurrency reservations, deterministic blocking reasons, and restart.

### P6-C — worktree groups

Own: new `src/multirepo/worktrees.ts`, focused fixtures/tests. Compose existing
single-repo worktree and provisioning primitives into a group; add identity,
reverse cleanup, preservation, and recovery without changing integration refs.

### P6-D — Git candidate and CAS primitives

Own: new `src/multirepo/git-transaction.ts`, real-Git tests. Implement detached
candidate creation, exact parent validation, expected-old ref CAS, observations,
and compensation kernels. No orchestrator or remote APIs.

### P6-E — combined verification and receipts

Own: new `src/multirepo/verification.ts`, new `src/multirepo/receipt.ts`, tests.
Bind candidate vector, commands, outputs, environment policy, and digests; reuse
the sole verifier containment/settlement path.

### P6-F — transaction reconciler

Own: new `src/multirepo/integration.ts`, crash fixtures/tests. Compose D/E with
canonical events, sorted repository leases, every crash transition, conditional
compensation, and recovery-required states.

### P6-G — orchestrator integration

Own: `src/orchestrator.ts` and new P6 E2E tests. One agent only. Route planning,
dispatch, worktree groups, provider scope, verification, and integration through
the new authority while retaining exact single-repo behavior.

### P6-H — SCM publication and operator surfaces

Own: new `src/multirepo/publication.ts`, relevant P3 integration files, control
view/CLI/dashboard additive surfaces, and tests. Keep remote publication a
separate idempotent saga with partial-state UX.

### P6-I — cutover, docs, and committed-head gates

Own: remove the unsupported semantic rejection only after all gates are green;
export stable APIs; update example/config/reference/ledger/status docs; run all
focused suites, the full suite, typecheck, build, real Git/child gates, package
smoke tests, commit, and rerun every required gate on committed HEAD.

## Legal conclusion

DoorDash and AO are permissively licensed, but no direct source copying is
needed. Their behavior is small enough to implement independently against Git's
public semantics and RelayForge's existing TypeScript domain. Kandev, Dagu,
Nomad, and AgentsMesh are restricted to idea/negative evidence under their
current licenses. Tests are independently authored; upstream fixtures and
comments are not copied. The implementation ledger must record any later change
to these classifications.
