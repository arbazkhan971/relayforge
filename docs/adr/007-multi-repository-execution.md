# ADR 007: Fenced multi-repository execution with recoverable Git integration

- Status: Accepted and implemented as fail-closed library components (authority 21/21; orchestration 12/12; product/recovery/verifier 6/6; publication/SCM/integration 13/13). Not CLI/config-enabled for ordinary `relayforge run` — see [implementation-status.md](../implementation-status.md)
- Date: 2026-08-09
- Decision owners: RelayForge maintainers
- Research: [Phase 06 reference audit](../reference/phase-06-multi-repository-audit.md)

## Context

At decision time, RelayForge's configuration schema contained repository and
role-repository fields, but semantic validation correctly rejected them because
the ordinary runtime was still single-repository. Enabling those fields by
merely placing several repositories under one directory would create ambiguous
identity, partial workspace exposure, unfenced concurrent writers, and unsafe
branch integration. That ordinary-run fail-closed boundary remains.

Git provides atomic compare-and-swap for one ref, not an atomic transaction over
several repositories or remote forges. A truthful design must make partial
application recoverable and observable rather than rename it atomic.

The Phase-01 ControlStore supplies canonical events, projections, aggregate
versions, snapshots, cursors, and recovery. The existing run lease, worktree,
provisioning, containment, verifier, cost, and settlement paths remain the only
execution authorities. P6 extends these boundaries; it does not create a second
scheduler database, process launcher, or Git escape path.

## Decision

### Repository identity and scope

Every configured repository receives a validated `RepositoryId`. Canonical Git
common-directory or physical identity is checked so two config records cannot
silently alias the same repository. Display name, directory basename, relative
path, branch label, and remote URL are not identity.

Every task declares an immutable, non-empty ordered repository set. The parent
validates that the set exists and is a subset of the assigned role/provider
capability. Planner output is a proposal only; an agent cannot widen its own
scope. A scope change requires a durable replan/new task generation.

`RepositorySetId` is the canonical digest of ordered IDs and immutable base
policy. It is stored on task admission, leases, worktrees, verification,
integration, and publication facts.

### Dependency graph

Task dependencies are exact IDs and are validated as a bounded acyclic graph
before any provider, lease, worktree, budget, or Git action. Stable topological
ordering uses declared priority then canonical task ID. Repository scope does
not imply dependency; edges remain explicit.

### Durable reconciliation and admission

ControlStore events are the queue of record. Wake channels are coalesced hints
only. A task may be `processing` and `dirty` at once; a relevant event during
processing guarantees one later reconciliation.

Admission is one canonical transaction that validates:

1. nonterminal run/task state;
2. exact task generation and aggregate version;
3. dependency completion in expected generations;
4. role/provider/repository capability;
5. global, provider, repository, and task concurrency budgets;
6. repository lease availability and certainty; and
7. the exact repository-set digest.

It commits a random `TaskLeaseToken`, owner incarnation, expiry, repository set,
and reservations. The token, generation, and expected aggregate version fence
all later mutations. Lease expiry is not proof the old child stopped; recovery
must settle the exact child/process scope before a new writer is admitted.

Dispatch is a distinct event written only after the contained launch handshake.
Admission, process start, dispatch acknowledgement, terminal provider result,
verification, settlement, and task completion are separate facts.

### Worktree groups

One attempt owns a private worktree group with one member per authorized
repository. Each member records repository identity, canonical source identity,
destination identity, base ref, anchor OID, work branch/ref, provisioning
receipt, clean-state proof, and lifecycle state.

The group is not ready until every member is created, provisioned, revalidated,
and durably bound to the task lease and repository-set digest. No provider or
verifier observes a partially ready group. Failure cleans owned clean entries in
reverse deterministic order. Dirty, locked, replaced, externally moved, or
identity-uncertain entries are preserved with `recovery_required`; they are not
force-deleted.

The provider receives an explicit manifest of authorized roots. A third
repository is neither mounted nor included in prompts/context. Existing outer
containment remains mandatory.

### Candidate-vector verification

Integration begins only after the worker is settled and the task's worktree
heads are identity-checked. For each repository, RelayForge records target ref,
anchor/expected OID, child head, and policy. In detached temporary worktrees it
prepares candidate commits without moving target refs and validates the expected
commit-parent shape.

All candidates must exist before verification. Verification receives a canonical
manifest binding repository IDs, paths, candidate OIDs, commands, environment,
and policy. Results, bounded output digests, and containment/settlement evidence
are recorded in one digest-bound receipt. A mutation or identity drift invalidates
the vector.

### Recoverable local apply

Integration states are:

`planning -> preparing -> prepared -> verifying -> verified -> applying ->
applied`, with `compensating -> compensated` and `recovery_required` branches.

Repository integration leases are acquired in ascending `RepositoryId` order
and released in reverse. After a durable `verified` event, RelayForge applies
each target ref with one expected-old compare-and-swap. The observation/result
is durably recorded before the next ref.

If a later apply fails, compensation walks proven applied entries in reverse.
It restores an anchor only if the current ref still equals the exact candidate
RelayForge installed. Any other OID, read failure, store integrity failure, or
uncertain previous result enters `recovery_required`. RelayForge never resets,
force-updates, or overwrites an external change.

A restart replays canonical events, revalidates the transaction receipt and all
refs, and resumes the state machine idempotently. Candidate commits, worktrees,
and evidence are retained until a verified terminal state permits cleanup.

### Remote publication

Local integration and remote publication are distinct. Publication requires
local `applied` state plus configured human/policy approval. Each repository
push and PR/MR has a stable `PublicationId`, explicit remote/ref/base/head,
expected remote state or unique new ref, and an idempotency receipt.

After every per-repo artifact exists, cross-links are patched idempotently. A
partial remote result remains visible and retryable. RelayForge does not force
push, delete a remote ref merely to simulate rollback, or claim remote atomicity.

### Observability and operator recovery

Control views expose task dependency/blocking reason, repository scope,
capability route, concurrency reservation, lease owner/generation, every
worktree state, candidate/apply/compensation vector, verification receipt,
publication state, and exact recovery instructions. Derived status is a
projection; canonical events remain authoritative.

Recovery actions require exact transaction/repository IDs and expected versions.
There is no generic "continue anyway" operation. Operator choices are retry a
proven idempotent transition, accept an externally observed vector through a new
versioned decision, or preserve evidence and abort.

## Authority prohibitions

P6 code may not:

- discover repository scope by recursive filesystem scan;
- infer identity from basename, path, branch, or remote text;
- let a provider add/mount a repository or choose a launcher;
- treat lease ownership/expiry as fencing;
- expose a partial worktree group to a child;
- move any target ref during candidate preparation or verification;
- use a ref update without an expected old OID;
- compensate over an external or uncertain ref;
- reset corrupted/unknown scheduler state to empty;
- use shell command strings for Git operations;
- call local integration atomic across repositories;
- combine local integration and remote publication into one ambiguous status;
- force push or delete remote evidence to manufacture success; or
- bypass existing containment, verification, accounting, settlement, or P1
  event authority.

## Failure semantics

- Invalid/aliased repositories, unsafe paths, unauthorized scopes, cycles, and
  graph bounds fail before side effects.
- Capacity conflict is a durable blocked reason, not failure or busy polling.
- Stale generation/token/version evidence is retained but cannot mutate state.
- Worktree-group failure preserves dirty/uncertain entries and prevents launch.
- Candidate conflict prevents `prepared`; verification failure prevents apply.
- Pre-CAS movement causes conflict/replan; it is never overwritten.
- Later-CAS failure triggers conditional compensation of proven earlier writes.
- Any unprovable ref/store/process state becomes `recovery_required`.
- Partial publication is explicit and per-artifact retryable.

## Verification gates

P6 requires independently authored schema/DAG, scheduler model, real Git
worktree group, real Git transaction, crash-injection, property, contained child,
publication, control-surface, and full single-repository regression suites. Real
Git tests must cover two and three repositories, different defaults, conflicts,
partial creation, every CAS/event crash window, external movement,
compensation, and idempotent resume.

At least one non-skipping E2E must prove a contained child can modify exactly
two authorized repositories, cannot observe a third, and can land the verified
candidate vector through the recoverable transaction. Required gates run again
on committed HEAD.

## Consequences

Multi-repository execution becomes slower and more explicit than a loop over
directories. That cost buys deterministic identity, bounded concurrency,
recoverable partial application, honest remote status, and safe retries. The
single-repository path remains the one-element specialization and must retain
its current behavior and performance.

The design does not promise impossible cross-repository or cross-forge ACID
atomicity. It promises fenced ownership, complete preparation before apply,
per-ref atomic CAS, exact durable evidence, conditional compensation, and
operator-visible recovery when certainty ends.

## Rejected alternatives

- **Enable existing config fields and loop over paths:** no identity, fencing,
  full-vector verification, or recovery.
- **One giant parent repository or submodules:** changes user topology and does
  not solve independent-ref/remote publication.
- **One shared branch name as identity:** labels can collide and bases differ.
- **Lease-only singleton:** Kubernetes explicitly documents that leases do not
  provide fencing.
- **In-memory priority queue:** loses admission/retry authority on crash.
- **Merge each repo immediately after its worker:** exposes partial vector before
  combined verification.
- **Reset/force-update on failure:** can destroy external work.
- **Best-effort rollback named atomic:** conceals uncertainty and partial remote
  side effects.
- **Copy Kandev/Dagu/Nomad implementations:** license-incompatible or
  insufficient authority semantics; only ideas/negative cases are used.
