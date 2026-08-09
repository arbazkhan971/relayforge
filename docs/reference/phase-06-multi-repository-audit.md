# Phase 06 reference audit: multi-repository scheduling and integration

- Status: research gate complete; P6 implemented as library (authority 21/21; orchestration 12/12; product/recovery/verifier 6/6; publication/SCM/integration 13/13). Not CLI/config-enabled for ordinary runs — see [implementation-status.md](../implementation-status.md)
- Date: 2026-08-09
- RelayForge baseline: `73051d510c6473fa763bc7cd81921f65bec00eea`
- Full evidence: source-tree packet
  `.workflow/ultracode/relayforge-complete/results/audit-p6-multi-repository.md`
  (intentionally not packaged); pins and legal decisions remain in the
  [upstream ledger](../upstream-sources.md)
- Decision: [ADR 007](../adr/007-multi-repository-execution.md)

## Scope and method

This audit covers repository identity, task repository scopes, dependency DAGs,
capability routing, concurrency, multi-repository worktrees, local integration,
crash recovery, and remote publication. Untrivial Agent Orchestrator was studied
first. GitHub searches then identified competing coding-agent implementations
and mature scheduler/workflow references. Actual source, tests, design documents,
history, licenses, NOTICE files, and explanatory PRs were inspected at exact
pins. README claims were not accepted as implementation evidence.

`AgentWrapper/agent-orchestrator` resolved to the same commit and tree as the
Untrivial repository and therefore does not count as an independent design.

## Decision summary

RelayForge will represent every multi-repository task as an explicit ordered set
of stable repository IDs. One private worktree per authorized repository is
created, provisioned, revalidated, and durably recorded before dispatch. A task
becomes executable only through a canonical ControlStore admission transaction
that checks dependencies, capabilities, concurrency, generation, expected
version, and repository leases.

Local integration is a recoverable saga. All candidate commits are prepared and
the complete vector is verified before any target ref moves. Each ref then moves
through expected-old compare-and-swap with a durable result. A later failure
compensates only refs still proven to equal RelayForge's candidate. Any external
movement or unreadable authority becomes `recovery_required`; it is never
overwritten. Remote push and PR creation are a separate idempotent publication
saga and are not described as cross-repository atomic.

## Exact pins and legal classification

| Repository | Pin / activity | License | Reuse |
|---|---|---|---|
| [Untrivial Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec) | `f65c48e`; 2026-08-09 | Apache-2.0; no root NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| [DoorDash Agentic Orchestrator](https://github.com/doordash-oss/agentic-orchestrator/tree/101ca9a416371c4d9db0935cf4aef73f77551366) | `101ca9a`; 2026-08-09; 99 commits/90d | Apache-2.0 + NOTICE | `ARCHITECTURAL_INSPIRATION`; independent behavioral port |
| [Kandev](https://github.com/kdlbs/kandev/tree/bbdd4267768e3b683bb3799e900bc69e155d0659) | `bbdd426`; 2026-08-09; 1,343 commits/90d | AGPL-3.0 | `IDEA_ONLY` |
| [Dagu](https://github.com/dagucloud/dagu/tree/99863067370950e33a31969f77a07127ea09fe8f) | `9986306`; 2026-08-09; 394 commits/90d | GPL-3.0-or-later | `IDEA_ONLY` |
| [AgentsMesh](https://github.com/AgentsMesh/AgentsMesh/tree/1f90b14194d03c353df4f281a05442afe93cae34) | `1f90b14`; 2026-08-03; 82 commits/90d | BUSL-1.1, no production grant until change date | `IDEA_ONLY` / `NOT_USED` for code |
| [Kubernetes](https://github.com/kubernetes/kubernetes/tree/94c136764292cc5fac976c0de6587daaea56410f) | `94c1367`; 2026-08-08 | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| [Temporal](https://github.com/temporalio/temporal/tree/023cb7d861b6cc0e139564b2faaf10c106a7f37d) | `023cb7d`; 2026-08-07 | MIT | `ARCHITECTURAL_INSPIRATION` |
| [Nomad](https://github.com/hashicorp/nomad/tree/d78b9b59529a1503f013bb9f86f2e75c7cf889d4) | `d78b9b5`; 2026-08-07; 200 commits/90d | BUSL-1.1 | `IDEA_ONLY` |
| [Google Scion](https://github.com/GoogleCloudPlatform/scion/tree/91c26b3) | `91c26b3`; 2026-08-08 | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |

No direct or modified copy is approved. Kandev, Dagu, Nomad, and AgentsMesh are
strictly idea/negative references. All RelayForge tests are independently
written.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Agent Orchestrator | nested workspace worktrees, per-repo rows, preservation and restore | Best coding-agent multi-repo worktree lifecycle and teardown corpus | One shared branch; no recoverable multi-ref integration | Apache-2.0 | Adapt architecture |
| DoorDash Agentic Orchestrator | transaction journal, detached candidates, ref CAS, conditional rollback | Best local multi-repo integration and crash/race tests | A recoverable saga, not true atomicity; weaker canonical event/fence model | Apache-2.0 + NOTICE | Independent behavioral port |
| Kandev | per-repo task/environment/worktree/PR identity and resume | Best operator identity, migration, resume, and fan-out ergonomics | AGPL; no equivalent local multi-ref transaction found | AGPL-3.0 | Idea only |
| Dagu | reservations, attempt leases, poller and zombie detection | Useful distributed claim/heartbeat test corpus | GPL; corrupt watermark and some lease read paths fail open | GPL-3.0-or-later | Negative/idea evidence |
| Kubernetes | dirty/processing workqueue and leader-election contract | Best reconcile dedup semantics and explicit fencing warning | Queue is memory-only; leader lease does not fence | Apache-2.0 | Adapt concepts |
| Temporal | matching backlog/ack levels/history/rebuild | Best durable retry identity and recovery model | Far broader distributed machinery than required | MIT | Architecture inspiration |
| Nomad | tokenized dequeue, Ack/Nack, priority/FIFO, delivery limit | Best compact broker characterization suite | BUSL; leader-memory queue; Ack/Nack send failure is best effort | BUSL-1.1 | Idea/negative evidence |
| Scion | persistent timers and shared concurrency semaphore | Strong lightweight scheduling ergonomics | Missing advisory-lock capability can run unguarded | Apache-2.0 | Test/design inspiration |

## Evidence and subsystem winners

### Worktree lifecycle — Agent Orchestrator

Studied the workspace ports, project/session domain, Git worktree adapter,
session manager, SQLite worktree store, architecture document, lifecycle plan,
and focused tests. Its `WorkspaceProject` validates physical source roots and
child paths, creates the root then children, records base SHAs and per-repo
rows, reverses partial creation, destroys children before the root, and
preserves/restores every repository. Tests cover runtime and row-persistence
failure, dirty/unregistered/locked/stale worktrees, registry drift, replacement,
shutdown preservation, restore conflicts, and retryable cleanup.

RelayForge adopts the group lifecycle while keeping independent repository
identity, base, and branch data. A directory position or shared branch label is
never identity.

### Local integration — DoorDash Agentic Orchestrator

Studied its
[`transaction journal`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/feature/transaction.go),
[`transaction reconciler`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/orchestrator/child_transaction.go),
[`ref CAS`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/git/ref_cas.go),
detached candidate builder, unit/integration/E2E tests, commit
[`4dbd261`](https://github.com/doordash-oss/agentic-orchestrator/commit/4dbd261ad321852e330254922174f7c37f34e188),
and [PR #113](https://github.com/doordash-oss/agentic-orchestrator/pull/113).

The journal stores exact anchors, expected refs, child heads, candidates,
observations, and diagnostics. Candidate commits are prepared without moving a
target. Apply is expected-old `git update-ref`; each result is persisted. A
later failure compensates only exact candidates, and an external movement is
parked for attention. Current tests include later-CAS compensation, crash after
all CAS operations before journal completion, idempotent resume, conflicts,
dirty parents, and external movement. This is the strongest inspected local
transaction pattern.

RelayForge independently ports the behavior onto P1 canonical events and adds
sorted repository leases, generation fencing, deterministic combined
verification, receipt digests, typed uncertainty, and separate publication.

### Per-repository identity and UX — Kandev

Studied executor, worktree preparer, worktree manager, GitHub store, migrations,
and multi-repo tests. Kandev persists ordered task/repository rows and one
environment/worktree/branch/PR identity per repository. It catches conflicting
repository secrets before launch and identifies a failing secondary repo.
Cache identity includes session, repository, and branch slug.

PRs [#2138](https://github.com/kdlbs/kandev/pull/2138),
[#1905](https://github.com/kdlbs/kandev/pull/1905),
[#2007](https://github.com/kdlbs/kandev/pull/2007),
[#1568](https://github.com/kdlbs/kandev/pull/1568), and
[#1795](https://github.com/kdlbs/kandev/pull/1795) document deterministic
parallel fan-out, resume losing secondary repos, junction cleanup, stale
repository identity, and review-base mismatch. RelayForge adopts these
regressions as independently authored tests; AGPL code is not copied.

### Reconcile, leases, and durable delivery

Kubernetes workqueue's dirty/processing sets guarantee one later reconcile
when a key changes during processing. RelayForge persists that semantic rather
than adopting its in-memory queue. Kubernetes leader election explicitly says
it does not provide fencing, so every RelayForge mutation must carry the task
generation, lease token, and expected aggregate version.

Temporal's matching reader/writer, ack manager, queue tests, fairness history,
and rebuild model separate durable backlog from dispatch and completion.
Nomad supplies useful token-checked Ack/Nack, timeout, bounded redelivery,
priority, and FIFO tests but retains leader-memory authority and swallows
worker acknowledgement errors. Dagu supplies attempt/heartbeat/zombie cases but
has unacceptable fail-open uncertainty paths. RelayForge uses canonical P1
events as the queue, an ephemeral wake only as an optimization, and a second
launch acknowledgement after admission.

## Chosen design

### Best implementation discovered

No repository wins overall. Agent Orchestrator wins worktree lifecycle,
DoorDash wins local integration, Kandev wins per-repo UX/identity, Kubernetes
wins minimal reconcile semantics, and Temporal wins durable history/retry.

### Why

The synthesis preserves one RelayForge architecture while avoiding ambient path
identity, unfenced leases, partial workspace exposure, and false cross-repository
atomicity claims.

### What RelayForge will reuse

- `ARCHITECTURAL_INSPIRATION`: group materialization, durable inventory,
  reverse cleanup, detached candidate preparation, expected-old ref CAS,
  conditional compensation, dirty-while-processing reconciliation, tokenized
  delivery, and durable retry identities.
- Public Git semantics through independently written wrappers and tests.

### What RelayForge will change

- Every task, repository set, attempt, lease, worktree, candidate, ref update,
  verification result, and publication artifact becomes a typed canonical fact.
- Repository leases are acquired in stable ID order and fence every mutation.
- Every candidate is prepared and the vector verified before the first CAS.
- Ref/store uncertainty enters `recovery_required`; no reset, force operation,
  guessed rollback, or empty-state fallback is allowed.
- Local integration and remote publication are separate state machines.
- Concurrency is bounded globally, per provider, per repository, and per task.

### How RelayForge will improve it

RelayForge adds event-sourced recovery, generation fencing, deterministic lease
ordering and diagnostics, capability-aware scheduling, full-vector verification,
digest-bound receipts, the existing containment/settlement authority, and crash
tests at every durable transition.

## Required authority and state machines

Stable identities include `RepositoryId`, canonical `RepositorySetId`,
`TaskGeneration`, `AttemptId`, `TaskLeaseToken`, `WorktreeIdentity`,
`IntegrationTransactionId`, per-repo transaction entries, and independent
`PublicationId` values. Display names, basenames, relative paths, and branch
labels are attributes only.

Scheduler admission atomically checks task/run state, generation/version,
dependency generations, capability subset, four-dimensional concurrency,
repository lease availability, and repository-set digest. It records both the
lease and reservation. Dispatch is recorded only after the contained launch
handshake. Admission is not execution.

Worktree groups progress through `planned -> creating -> ready -> active ->
settling -> preserved|reclaimable -> reclaimed`; any identity uncertainty enters
`recovery_required`. A group is ready only when all worktrees are canonical,
private, clean, provisioned, revalidated, and durably bound to the same lease.

Local integration progresses through `planning -> preparing -> prepared ->
verifying -> verified -> applying -> applied`, with `compensating -> compensated`
or `recovery_required` failure branches. Compensation uses expected-current
candidate CAS in reverse order. Evidence remains until a verified terminal
decision.

Remote publication starts only after local applied state and policy approval.
Per-repo push and PR operations are idempotent and receipt-bound; partial remote
success is shown honestly and retried per artifact.

## Architecture consistency gate

P6 cannot ship unless every answer is yes:

- Is every authority mutation in canonical ControlStore history?
- Do all mutations check generation, lease token, and expected version?
- Are admission, launch acknowledgement, completion, and publication distinct?
- Can a provider access only its declared repository set?
- Is every worktree private, identity-bound, provisioned, and recoverable?
- Does execution retain the sole contained transport and settlement path?
- Are ref moves expected-old CAS operations with exact before/after evidence?
- Is verification deterministic and bound to the whole candidate vector?
- Does crash recovery converge without guessing or destructive cleanup?
- Are local integration, compensation, and remote publication named honestly?

## Required adversarial coverage

Tests must cover duplicate/aliased/nested repos, unknown scopes, role subset,
cycles, stable topology, width bounds, dirty-while-processing, two-owner races,
lease expiry with a live child, stale completions, concurrency fairness, crash
after admission/before spawn, two/three real repositories, different defaults,
partial creation/provisioning, dirty/locked/stale/replaced worktrees, conflicts,
prepare-without-ref-movement, ref movement before/after verify, later-CAS
compensation, crashes before and after every CAS/event commit, external movement,
idempotent resume, duplicate/partial remote publication, and an E2E contained
agent that can modify exactly two authorized repositories but cannot observe a
third. The complete matrix and file-exclusive P6-A through P6-I packets are in
the full research artifact.

Implementation follows:

`REFERENCE -> CHARACTERIZATION TEST -> IMPLEMENT -> UNIT -> INTEGRATION ->
FAILURE -> REAL GIT/CHILD -> REGRESSION -> COMMIT -> TEST COMMITTED HEAD`.
