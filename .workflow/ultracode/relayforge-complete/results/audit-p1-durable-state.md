# P1 durable control-plane state reference audit

Date: 2026-08-09

RelayForge pin inspected: `66b60821d45466c9c5e15640a48ad3de25919376`

Scope: durable facts, event identity and ordering, retention/compaction, crash recovery, and pure derived activity views. Research/design only: no product source, tests, public documentation, dependency manifest, or upstream attribution ledger was changed by this audit.

## Executive decision

RelayForge's current `tasks.jsonl` / `events.jsonl` / `messages.jsonl` board is not a safe control-plane authority. Its append path has no transaction that binds an event to its materialized fact, the fold silently skips malformed records, event identity and fencing are absent, and `compactBoard()` can race writers while irreversibly discarding history. `loadLoopState()` is worse for recovery: malformed durable state is silently replaced with a new default. Those behaviors can turn corruption or a stale writer into a plausible but false run state.

The answer to the mandatory question **“Is there another open-source implementation that does this better?” is yes, but not one repository for every subproblem**:

- [Temporal](https://github.com/temporalio/temporal/tree/023cb7d861b6cc0e139564b2faaf10c106a7f37d) has the strongest canonical history/rebuild model: ordered history is authority, mutable state is a reconstructable optimization, and transaction/version lineage detects conflicting appends.
- [Untrivial Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec) has the best fit for a single-host coding-agent daemon: SQLite transactions bind facts to change-log entries, provider events have stable identities, controller generations fence stale writers, and operator status is derived from durable facts.
- [Kubernetes](https://github.com/kubernetes/kubernetes/tree/94c136764292cc5fac976c0de6587daaea56410f) has the clearest identity/version/generation separation and the strongest expired-cursor contract: an observer whose cursor predates retained history gets a typed expiration and must relist; it is never given a misleading partial stream.
- [Restate](https://github.com/restatedev/restate/tree/f26577320b8be42b7a754d20932e881f06988876) has the clearest separation between journal retention and terminal idempotency-result retention, plus deterministic replay feature gates. Its current BSL-1.1 terms are not approved for copying into RelayForge without separate legal review; this audit uses concepts only.
- RelayForge's own run-scoped money ledger already has stronger local fail-closed file identity, durability proof, crash recovery, and adversarial tests than its board. The event store should reuse those *local invariants and I/O test seams*, not copy the ledger's money-specific WAL protocol wholesale.

The coherent RelayForge design is a daemon-owned, run-scoped SQLite authority with an append-only canonical event table, transactionally maintained fact projections, stable retry identity, monotonically allocated sequence, run/task generations, verified snapshots, an explicit retained-history floor, and pure activity derivation. The database must use WAL, `foreign_keys=ON`, a bounded busy timeout, `synchronous=FULL` for authority commits, and one serialized writer. An event and its fact projection commit together or neither is visible. No agent process writes the database directly.

For P1, **do not delete canonical events at all**. Replace the unsafe board rewrite with snapshot creation and verification only. Prefix deletion becomes a later opt-in operation limited to terminal runs after a configured retention horizon, a verified snapshot, and advancement of every durable consumer cursor. Reads before the retained floor return `CURSOR_EXPIRED { floorSeq, headSeq, snapshotSeq }`.

The implementation is not ready to ship until every mandatory failure/recovery test in this audit passes, including hard-kill transaction boundaries, exact duplicate/conflicting duplicate behavior, stale-generation rejection, snapshot/replay equivalence, legacy interior-corruption refusal, cursor expiration, and “malformed run state never resets to defaults.”

## Scope and decision boundaries

This audit covers only:

1. the identity, ordering, append, replay, and migration of durable run/task/message facts;
2. retention, snapshots, compaction floors, and cursor behavior;
3. daemon restart and crash recovery for that state;
4. pure operator-facing activity/status views derived from durable facts and a supplied clock.

It deliberately does not select a distributed consensus system, redesign scheduling, perform a security scan, define sandbox policy, or redesign the desktop UI. File/path identity issues are recorded only where they affect crash-safe state. Sandbox and hostile-repository threat analysis belongs to its own phase.

## Audit method and exact reference set

Every repository below was cloned under `/home/arbaz/.relayforge-references`, pinned by commit, and inspected with `rg`, `git log`, `git show`, and targeted history/issue/PR review. Source, migrations, tests, and design documents were read before forming the recommendation. README claims were not treated as implementation evidence.

| Repository | Exact pin inspected | Last pinned activity | License finding |
|---|---|---|---|
| RelayForge / `loop-orchestrator` | `66b60821d45466c9c5e15640a48ad3de25919376` | 2026-07-16 | MIT; root `LICENSE`, package metadata |
| Untrivial-ai/agent-orchestrator | `f65c48e296e20a816221a4003c75a5f0387967ec` | 2026-08-09, PR #3709 | Apache-2.0; root `LICENSE`; no root `NOTICE` found; relevant files have no extra incompatible header |
| AgentWrapper/agent-orchestrator | same object `f65c48e296e20a816221a4003c75a5f0387967ec` | same history | Same checkout/history as the renamed Untrivial repository, so not counted as an independent implementation |
| temporalio/temporal | `023cb7d861b6cc0e139564b2faaf10c106a7f37d` | 2026-08-07, PR #11442 | MIT at root; copyright Temporal Technologies 2025 / Uber 2020; some unrelated subtrees have their own licenses |
| kubernetes/kubernetes | `94c136764292cc5fac976c0de6587daaea56410f` | 2026-08-08, PR #141273 merge | Apache-2.0; root `LICENSE`; relevant files carry Apache headers; no root `NOTICE` found |
| restatedev/restate | `f26577320b8be42b7a754d20932e881f06988876` | 2026-08-07, 1.8.0-dev bump | BSL-1.1 with an additional-use grant and future Apache-2.0 change; repository expressly says current software is not open source. No code/test/comment copying permitted |
| inngest/inngest | `ce19803e185b791121352a77601216abc25ee7be` | 2026-08-07, PR #4723 | `LICENSE.md` applies SSPLv1 with a future per-version Apache-2.0 date; current-version reuse is not safely permissive. Concepts only |
| WiseLibs/better-sqlite3 | `dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb`; installable compatibility tag `v12.11.1` at `4cbc39ca582fecb6b51dd920dfdd338ba4b72230` and later unpublished tag `v12.12.0` also inspected | 2026-08-05, v13.0.3; installable pin 2026-06-15 | MIT, root `LICENSE`, no `NOTICE`. v13 requires Node >=22; published v12.11.1 declares Node 20 support |

The `AgentWrapper/agent-orchestrator` URL currently resolves to the same repository objects and exact head as `Untrivial-ai/agent-orchestrator`. Treating it as a second vote would fabricate reference diversity, so the matrix records it as an alias and counts Temporal, Kubernetes, Restate, and Inngest as the independent adjacent implementations.

## RelayForge current-state audit

### Files and history inspected

- [`src/board.ts`](../../../../src/board.ts): board schemas, JSONL reads/appends, fold, summary, and compaction.
- [`src/orchestrator.ts`](../../../../src/orchestrator.ts): `loadLoopState`, `saveLoopState`, `logLoopEvent`, attempt recovery, and status mutation.
- [`src/runtime.ts`](../../../../src/runtime.ts): weak `atomicWrite` versus the stronger `readStateFile` / `writeStateFileDurable`, run lease, and path validation.
- [`src/ledger.ts`](../../../../src/ledger.ts): pinned descriptors, ledger generation, intent/commit recovery, publication proof, and fail-closed folding.
- [`src/dashboard/data.ts`](../../../../src/dashboard/data.ts): current direct use of board events for KPIs, task graph, agent cards, and timeline.
- [`tests/board.test.ts`](../../../../tests/board.test.ts), [`tests/dashboard-data.test.ts`](../../../../tests/dashboard-data.test.ts), [`tests/resume.test.ts`](../../../../tests/resume.test.ts), and [`tests/ledger-transaction.test.ts`](../../../../tests/ledger-transaction.test.ts).
- Board origin and evolution: `25bda6ca` (2026-06-13, autonomous SME team), `89ad79a` (SOTA autonomy), `d077ada` (dashboard), `9848c99` (engineering controls), and `576770b8` (hardening).

### What is durable today

`initBoard()` creates three mode-restricted JSONL leaves and uses the stronger state-file reader on initialization. After initialization, however, `addTask`, `addEvent`, and `addMessage` call `appendJsonl()`, which calls `appendFileSync(path, JSON + "\n")` by pathname. There is no durable event identifier, per-run epoch, per-task generation, expected version, transaction, sync, or post-publication proof. A write may be visible without being durable; a state transition is not coupled atomically to any other fact.

`readJsonl()` splits the entire file on newline and catches/ignores every `JSON.parse` failure. That makes an interior corrupted record indistinguishable from a deliberately absent event. Only a demonstrably torn final record may be treated as a recoverable append tail; all interior corruption must fail closed.

`foldBoard()` uses physical line order, but timestamps remain caller-controlled display fields. Duplicate task IDs overwrite earlier task definitions in a `Map`. Unknown-task events are ignored. “First claim wins” is implemented only for later claim records; a later status event from any role can still advance or regress the task because there is no claimant check, transition table, expected version, or generation fence. A terminal state can therefore regress without an explicit reopen fact.

`compactBoard()` creates `.compact.lock` with an existence check followed by ordinary `writeFileSync`, not an exclusive kernel lock. Two processes can pass the check together. It folds the board and replaces task/event leaves through temporary-path renames while agents may still append to the old inode. It preserves only one synthetic terminal/current event per task, losing claim history, failure-attempt multiplicity, messages/activity linkage, and the information needed to prove reducer equivalence. It has no snapshot sequence, reducer/schema version, event floor, durable consumer cursor, directory-sync proof, or recovery receipt. This operation must be disabled before the board becomes authoritative.

`loadLoopState()` catches malformed JSON, manufactures a fresh initial state, and overwrites the file via `atomicWrite()`. That is a recovery violation: corruption can reset iteration/status facts and resurrect a run. `atomicWrite()` is a temp-file rename without the fsync and pinned-handle assurances provided by `writeStateFileDurable()`. `logLoopEvent()` is another unsynced pathname append with no stable identity or ordering cursor.

### Strong local precedent that should be reused

The run-scoped money ledger establishes useful RelayForge-native invariants:

- every record is bound to run/epoch and a durable ledger generation;
- a duplicate/orphan/conflicting call identity is corruption, never silent overwrite;
- existing state is never recreated as an empty authority after deletion/replacement;
- writes use pinned descriptors and prove file plus directory publication;
- intent/commit recovery refuses ambiguity instead of guessing;
- legacy migration is explicit, one-way, receipted, idempotent, and crash-tested at injected I/O boundaries;
- a torn final append can be repaired while interior corruption fails closed;
- kernel-held serialization releases automatically after holder death.

Those invariants and fault-injection seams should become common control-store behavior. The ledger's specialized fixed-point accounting records and bespoke file-WAL choreography should remain ledger-specific; SQLite already supplies atomic page/WAL recovery for the general event/fact transaction.

### Coverage gap

The board suite protects initialization, a happy-path status fold, first claim, completion, and summary counts. Dashboard tests protect deterministic computations for sample in-memory data. Resume tests protect an important end-to-end abandoned-attempt and spend-recovery scenario. They do not protect duplicate identities, conflicting retry payloads, concurrent claims, stale writers, illegal transitions, event/fact atomicity, corrupt interior records, database replacement, crash points, cursor gaps, snapshot equivalence, retention safety, or compaction under live writers. In contrast, `ledger-transaction.test.ts` already demonstrates the test depth P1 state requires.

## Primary reference: Untrivial Agent Orchestrator

### Durable facts and SQLite transaction boundary

The relevant implementation is in:

- [`backend/internal/storage/sqlite/db.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/db.go)
- [`backend/internal/storage/sqlite/migrations/0001_init.sql`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/migrations/0001_init.sql)
- [`backend/internal/storage/sqlite/migrations/0030_session_cleanup_facts.sql`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/migrations/0030_session_cleanup_facts.sql)
- [`backend/internal/storage/sqlite/migrations/0033_add_session_runtime_launch_id.sql`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/migrations/0033_add_session_runtime_launch_id.sql)
- [`backend/internal/storage/sqlite/migrations/0066_chat_session_mode.sql`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/migrations/0066_chat_session_mode.sql)
- [`backend/internal/storage/sqlite/migrations/0069_conversation_compaction.sql`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/migrations/0069_conversation_compaction.sql)
- [`backend/internal/storage/sqlite/migrations/0072_conversation_history_ops.sql`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/migrations/0072_conversation_history_ops.sql)
- [`backend/internal/storage/sqlite/store/conversation_store.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/store/conversation_store.go)
- [`backend/internal/storage/sqlite/store/conversation_history_store_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/store/conversation_history_store_test.go)
- [`backend/internal/storage/sqlite/store/session_cleanup_store_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/store/session_cleanup_store_test.go)
- [`backend/internal/integration/lifecycle_sqlite_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/integration/lifecycle_sqlite_test.go)
- [`docs/architecture.md`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/docs/architecture.md) and [`docs/plans/session-lifecycle-persistence.md`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/docs/plans/session-lifecycle-persistence.md)

The daemon uses pure-Go SQLite with WAL, foreign keys, a 5-second busy timeout, one writer connection, and multiple readers. The initial schema stores session fact rows and an auto-incrementing `change_log.seq`. Triggers emit change-log entries in the same database transaction as fact mutation, so a reader cannot observe the fact without its invalidation or the invalidation without its fact.

The newer conversation path is closer to RelayForge's needed event identity. `ProjectProviderEvent` serializes the writer, checks controller generation, inserts an immutable raw provider event with a unique provider event ID, and projects it in the same transaction. An exact duplicate commits no second projection. Tests prove that a projection error rolls back both raw event and projection, a stale generation archives/projects nothing, duplicate provider identity projects once, sequence remains immutable, and snapshot paging does not scramble order.

Cleanup records include `cleanup_generation`, attempts, timestamps, and precise phase facts. Retry-only bookkeeping is deliberately prevented from producing false semantic CDC. `runtime_launch_id` separates a current runtime instance from a stale process identifier.

The architecture document makes the intended boundary explicit as `OBSERVE external facts → UPDATE durable facts → DERIVE display status`; display status is not stored. The lifecycle persistence plan also records a useful crash invariant for external resources: capture durable recovery identity and commit it before destroying the worktree. These documents agree with the source and tests rather than serving as unsupported claims.

### Change-log cursors and pure status

The relevant code is:

- [`backend/internal/cdc/event.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/cdc/event.go)
- [`backend/internal/cdc/poller.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/cdc/poller.go)
- [`backend/internal/cdc/cdc_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/cdc/cdc_test.go)
- [`backend/internal/storage/sqlite/store/changelog_store.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/storage/sqlite/store/changelog_store.go)
- [`backend/internal/httpd/events.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/httpd/events.go) and [`events_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/httpd/events_test.go)
- [`backend/internal/domain/session.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/domain/session.go)
- [`backend/internal/service/session/status.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/service/session/status.go) and [`status_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/service/session/status_test.go)

CDC polls `EventsAfter(seq)` in fixed batches and broadcasts monotonic events. Tests pin trigger-to-change-log-to-broadcast order, no duplicate on re-poll, and isolation of a panicking subscriber. SSE accepts cursors / `Last-Event-ID` for durable catch-up. On server restart the live poller seeks the current head; clients reconcile durable facts and use their cursor rather than treating the transient broadcaster as authority.

The domain explicitly labels `SessionRecord` as durable facts. Operator status is not a writable umbrella field: `deriveStatus` combines activity, runtime exit, input, SCM/PR, and signal facts with tested precedence. Stack status uses a deterministic worst-wins fold. This is the right direction for RelayForge activity views.

### Bugs and tradeoffs learned from history

- [PR #3472](https://github.com/Untrivial-ai/agent-orchestrator/pull/3472), merged 2026-08-06, introduced the durable chat model: raw provider-event archive and projection in one transaction, unique provider identity, generation fencing, and paged snapshots. Its acknowledged follow-up is cursor/gap-aware semantic streaming; durable rows alone do not define a complete reconnect contract.
- [Issue #3710](https://github.com/Untrivial-ai/agent-orchestrator/issues/3710) and [PR #3711](https://github.com/Untrivial-ai/agent-orchestrator/pull/3711), merged 2026-08-08, fixed a stream-close path that could leave durable chat state `idle`, `active`, or `blocked` and then reject resume. The fix records a generation-fenced exit, handles blocked transitions, and validates current controller ownership before resume.
- [Issue #3475](https://github.com/Untrivial-ai/agent-orchestrator/issues/3475) and [PR #3491](https://github.com/Untrivial-ai/agent-orchestrator/pull/3491), merged 2026-08-05, document three recovery failures: a stale PID killed the wrong tmux server, one server-level probe failure made all sessions look dead, and a burned migration version did not prove the physical schema existed. Fixes include process identity proof, `probe failed` distinct from `dead`, a mass-death circuit breaker, and physical schema reconciliation.
- [PR #2928](https://github.com/Untrivial-ai/agent-orchestrator/pull/2928), merged 2026-08-06, couples usage event and cursor advancement so a restart cannot double-count, adds startup reconciliation, and bounds retry.

These bugs directly constrain RelayForge: never infer process identity from PID alone; preserve “unknown/probe failed”; update a durable cursor in the same transaction as its side effect; and verify the physical schema rather than trusting only a migration ledger.

### Limitation

Agent Orchestrator's `change_log` is primarily CDC/invalidation, not a complete canonical domain history. Payloads are often partial, and no general retained-floor/expired-cursor protocol or change-log GC policy was found. Session deletion can remove seed-related change-log rows while live delivery is intentionally transient. RelayForge should adopt the single-host transaction/generation model, but its P1 `events` table must remain canonical and replayable rather than becoming only an invalidation log.

## Adjacent reference: Temporal

### Source and tests inspected

- [`docs/architecture/history-service.md`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/docs/architecture/history-service.md) and [`workflow-lifecycle.md`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/docs/architecture/workflow-lifecycle.md)
- [`service/history/historybuilder/event_store.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/historybuilder/event_store.go), [`history_builder.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/historybuilder/history_builder.go), and [`event_factory.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/historybuilder/event_factory.go)
- [`service/history/workflow/mutable_state_rebuilder.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/workflow/mutable_state_rebuilder.go) and its tests
- [`service/history/workflow/context.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/workflow/context.go)
- [`common/persistence/persistence_interface.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/common/persistence/persistence_interface.go), [`history_manager.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/common/persistence/history_manager.go), and persistence tests
- [`service/history/deletemanager/delete_manager.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/deletemanager/delete_manager.go) and tests
- [`service/worker/scanner/history/scavenger.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/worker/scanner/history/scavenger.go), [`tests/history_node_cleanup_test.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/tests/history_node_cleanup_test.go), and history/rebuild/reset tests

Each state transition appends ordered workflow-history events, updates mutable state, and creates downstream tasks. History is sufficient to rebuild mutable state and tasks; mutable state is the optimized working snapshot and visibility is secondary. `event_store.go` assigns sequential event IDs and distinguishes buffered/uncommitted IDs from committed history. Persistence batches include node/transaction/previous-transaction lineage; conflicting versions at the same event boundary can be detected rather than folded by arrival time.

Deletion is staged and retention-aware. Scavengers page through eligible histories and test branch cleanup, including reset branches. Temporal's retention unit is the completed workflow execution; long-running workflows normally use Continue-As-New. It is not a general license to erase arbitrary active-history prefixes.

[PR #2532](https://github.com/temporalio/temporal/pull/2532) added an explicit mutable-state rebuild API for database-corruption recovery and an integration test reconstructing state from persisted history. [PR #11353](https://github.com/temporalio/temporal/pull/11353), merged 2026-08-04, fixed a race caused by reading a slice before taking its lock and added race-detector coverage. RelayForge should take both lessons: canonical history must rebuild projections, and locks must cover the read that participates in a mutation decision—not only the write.

### Fit decision

Use Temporal's **authority hierarchy**—history first, snapshots/projections second—and its event/version lineage as architectural inspiration. Do not import its distributed history branches, shard ownership, replication conflict resolution, or Continue-As-New machinery. Those solve a multi-cluster service and would distort a single-host control plane.

## Adjacent reference: Kubernetes

### Source and tests inspected

- [`staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go)
- [`staging/src/k8s.io/apimachinery/pkg/api/meta/conditions.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apimachinery/pkg/api/meta/conditions.go) and [`conditions_test.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apimachinery/pkg/api/meta/conditions_test.go)
- [`staging/src/k8s.io/apiserver/pkg/storage/cacher/watch_cache_history.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apiserver/pkg/storage/cacher/watch_cache_history.go)
- [`staging/src/k8s.io/apiserver/pkg/storage/cacher/store/watch_cache_storage.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apiserver/pkg/storage/cacher/store/watch_cache_storage.go)
- [`staging/src/k8s.io/apiserver/pkg/storage/etcd3/watcher.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apiserver/pkg/storage/etcd3/watcher.go) and watcher tests
- [`pkg/controller/deployment/sync.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/pkg/controller/deployment/sync.go) and deployment sync/status tests

Kubernetes separates immutable object identity (`UID`), an opaque mutation/watch position (`resourceVersion`), and desired-state revision (`generation`). Conditions carry `observedGeneration`, transition time, reason, and message, allowing readers to recognize status computed against stale desired state. `SetStatusCondition` preserves `lastTransitionTime` unless the semantic status actually changes.

The watch cache maintains a bounded interval. If requested history is older than the retained window or an exact snapshot is unavailable, it returns typed `ResourceExpired`; it never returns an apparently complete suffix. Etcd watcher tests physically compact history and assert that mid-stream compaction maps to expiration/relist behavior.

Deployment status is a derived function of desired objects and observed ReplicaSet facts, stamped with observed generation, and updated idempotently. Owner UID and deterministic names prevent a coincidental name match from being accepted as identity.

[Issue #138774](https://github.com/kubernetes/kubernetes/issues/138774) documents how watch events traverse multiple queues and become difficult to diagnose without per-stage freshness. [PR #140860](https://github.com/kubernetes/kubernetes/pull/140860), merged 2026-07-23, adds storage-to-cache latency visibility. RelayForge activity reads should therefore expose `headSeq`, `viewSeq`, and staleness—not only a friendly status string.

### Fit decision

Adopt the UID/version/generation/observed-generation vocabulary and the typed expired-cursor behavior. Do not model the event store as a Kubernetes watch cache: the cache is disposable delivery state, not canonical audit history, and Kubernetes controller-written `status` can itself be stale. RelayForge's activity view remains computed, with freshness metadata.

## Adjacent reference: Restate

### Source and tests inspected

- [`crates/worker/src/partition/state_machine/lifecycle/event.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/state_machine/lifecycle/event.rs)
- [`crates/worker/src/partition/state_machine/lifecycle/purge_journal.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/state_machine/lifecycle/purge_journal.rs) and inline tests
- [`crates/worker/src/partition/state_machine/lifecycle/restart_as_new.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/state_machine/lifecycle/restart_as_new.rs)
- [`crates/storage-api/src/journal_table_v2/mod.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/storage-api/src/journal_table_v2/mod.rs) and partition-store implementation/tests
- [`crates/worker/src/partition/processor/dedup.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/processor/dedup.rs)
- [`crates/worker/src/partition/leadership/durability_tracker.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/worker/src/partition/leadership/durability_tracker.rs)
- [`crates/partition-store/src/snapshots.rs`](https://github.com/restatedev/restate/blob/f26577320b8be42b7a754d20932e881f06988876/crates/partition-store/src/snapshots.rs) and snapshot/reconciliation tests

Journal entries receive total order relative to entry index and applied log sequence number. Producer epoch/sequence deduplication fences replay. Snapshot metadata records the applied sequence, permitting recovery to resume from a proven boundary.

Most useful is `purge_journal`: journal-detail retention and invocation-completion retention are separate. A completed journal may be purged while completion output/idempotency remains, so duplicate invocation still returns the prior result; only a later terminal purge removes the invocation. `restart_as_new` explicitly carries a validated prefix/metadata into the next invocation instead of pretending a destructive rewrite preserved history.

[PR #5145](https://github.com/restatedev/restate/pull/5145), merged 2026-08-06, moved restart-as-new replay behavior behind durable state-machine feature state rather than current mutable configuration; otherwise old history could replay differently after a config change. [PR #5091](https://github.com/restatedev/restate/pull/5091) keeps the latest prefix-truncation cursor rather than losing the operative boundary, while [PR #5076](https://github.com/restatedev/restate/pull/5076) bounds an appender channel by bytes rather than merely record count.

### Fit and legal decision

The retention split and durable reducer-feature version are the best implementation ideas found for these subproblems. Restate's replicated RocksDB/log architecture is inappropriate for RelayForge, and the repository is currently BSL-1.1. Reuse classification is strictly `IDEA_ONLY`: do not copy code, tests, comments, schema, or distinctive structure.

## Adjacent reference: Inngest

### Source and tests inspected

- [`pkg/execution/history/lifecycle.go`](https://github.com/inngest/inngest/blob/ce19803e185b791121352a77601216abc25ee7be/pkg/execution/history/lifecycle.go) and [`history.go`](https://github.com/inngest/inngest/blob/ce19803e185b791121352a77601216abc25ee7be/pkg/execution/history/history.go)
- [`pkg/cqrs/manager/cqrs.go`](https://github.com/inngest/inngest/blob/ce19803e185b791121352a77601216abc25ee7be/pkg/cqrs/manager/cqrs.go), SQLite/Postgres history schemas, and queries
- [`pkg/execution/state/state.go`](https://github.com/inngest/inngest/blob/ce19803e185b791121352a77601216abc25ee7be/pkg/execution/state/state.go) and state-v2 interfaces/tests
- [`tests/execution/state_store/consume_pause_idempotency_test.go`](https://github.com/inngest/inngest/blob/ce19803e185b791121352a77601216abc25ee7be/tests/execution/state_store/consume_pause_idempotency_test.go)
- [`tests/execution/executor/finalize_duplicate_test.go`](https://github.com/inngest/inngest/blob/ce19803e185b791121352a77601216abc25ee7be/tests/execution/executor/finalize_duplicate_test.go)
- [`docs/POSTGRES_RETENTION.md`](https://github.com/inngest/inngest/blob/ce19803e185b791121352a77601216abc25ee7be/docs/POSTGRES_RETENTION.md), [`docs/DEVSERVER_ARCHITECTURE.md`](https://github.com/inngest/inngest/blob/ce19803e185b791121352a77601216abc25ee7be/docs/DEVSERVER_ARCHITECTURE.md), and DB-adapter design plans

History listeners mint ULIDs and write history to drivers, but errors are logged/swallowed: this stream is observability, not execution authority. SQL history is generally ordered by creation time and lacks a canonical per-run numeric sequence. The state store has stronger run/step idempotency than the history stream. Tests prove a retried pause consume does not double-append stack state, concurrent finalization emits one finish, and a failed finalize path releases a claim for retry without duplicating successful effects.

`POSTGRES_RETENTION.md` contains a valuable operational constraint: age alone is unsafe. Only terminal anchors are eligible, children are deleted in bounded batches before anchors, and unfinished runs must remain. Self-hosted history is otherwise not automatically truncated.

[PR #4668](https://github.com/inngest/inngest/pull/4668), merged 2026-07-27, fixes a race where asynchronous workflow creation lagged checkpointing. [PR #4672](https://github.com/inngest/inngest/pull/4672) isolates lifecycle-listener panic/failure because those listeners are observability side effects.

### Fit and legal decision

Use the terminal-anchor retention warning and duplicate-finalization test ideas. Do not use best-effort lifecycle history as control-plane authority. The current SSPL/future-Apache terms are not permissive enough for direct or modified copying; classification is `IDEA_ONLY` / `NOT_USED`.

## SQLite Node adapter check

SQLite is the chosen storage model, so the Node binding was checked rather than silently assumed.

[`WiseLibs/better-sqlite3@dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb`](https://github.com/WiseLibs/better-sqlite3/tree/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb) is MIT and actively maintained. [`lib/methods/transaction.js`](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/lib/methods/transaction.js) implements synchronous `BEGIN`/`COMMIT`/`ROLLBACK`, savepoints for nested transactions, and immediate/exclusive variants. [`test/30.database.transaction.js`](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/test/30.database.transaction.js) covers isolation, exception rollback, nested savepoint rollback, and constraint failure. [`test/31.database.checkpoint.js`](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/test/31.database.checkpoint.js) exercises WAL checkpoints, and the integrity suite covers busy/blocked operation states.

The current v13 line requires Node >=22 and is incompatible with RelayForge's declared `>=20` engine. The upstream `v12.12.0` tag is MIT and declares Node 20 support, but a pre-install registry check on 2026-08-09 proved that npm does **not** publish `12.12.0`. The newest published compatible version is `better-sqlite3@12.11.1` (`4cbc39ca582fecb6b51dd920dfdd338ba4b72230`), whose npm metadata declares Node 20/22/23/24/25/26 and MIT. P1 must pin that exact package plus `@types/better-sqlite3@9.6.0`, or separately raise RelayForge's engine to >=22 and re-audit v13 packaging. It must not install an unconstrained latest version or a Git tag masquerading as a registry artifact. The binding supplies transactions; RelayForge remains responsible for schema, pragmas, reducer determinism, corruption handling, backup/recovery, and fault-injection tests.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Untrivial Agent Orchestrator | SQLite session facts + transactional `change_log`; provider raw-event/projection transaction; cleanup/controller generations; pure derived status | Best local-daemon and coding-agent fit; strong transaction, identity, generation, and tested status precedence | Change log is CDC, not complete canonical history; no explicit retained floor / gap contract found | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; independently implement transaction/generation concepts, no source copy |
| AgentWrapper/agent-orchestrator | Same Git objects and source as Untrivial pin | Confirms rename/continuity | Not an independent comparator | Apache-2.0 | `NOT_USED` as duplicate reference |
| Temporal | Canonical workflow history, sequential event IDs, mutable-state rebuild, transaction lineage, staged retention | Strongest correctness and recovery model; history can reconstruct projections/tasks | Distributed branching/sharding/replication and Continue-As-New are far beyond local P1 | MIT | `ARCHITECTURAL_INSPIRATION` |
| Kubernetes | UID/resourceVersion/generation/observedGeneration; bounded watch history and typed expiration; derived controller status | Strongest cursor-floor and view-freshness semantics | Watch cache is disposable, not audit authority; persisted status can be stale | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| Restate | Ordered journal/LSN, producer epoch/sequence dedupe, snapshots, split journal/completion retention | Strongest two-tier retention and deterministic replay-feature design | Replicated state-machine architecture is excessive; current license blocks reuse | BSL-1.1 then future Apache-2.0 | `IDEA_ONLY` |
| Inngest | Run/step idempotency, duplicate finalization tests, terminal-anchor retention guidance | Useful idempotency/failure tests and operational GC warning | Lifecycle history is best-effort observability; no canonical per-run seq; self-hosted retention manual | SSPLv1 then future per-version Apache-2.0 | `IDEA_ONLY`; history design `NOT_USED` |
| better-sqlite3 | Synchronous SQLite transactions/savepoints, WAL/checkpoint and integrity tests | Simple serialized Node daemon writer; MIT; v12 supports Node 20 | Native dependency; latest v13 requires Node 22; binding does not define durability policy | MIT | `NOT_USED` for source copying; separately adopted as the exact runtime dependency `12.11.1` |
| RelayForge money ledger | Pinned identity, generation, durable publication proof, fail-closed migration/recovery tests | Strongest existing project-local crash/corruption discipline | Money-specific file/WAL protocol is complex and not a general event store | RelayForge-local MIT | `PORTED_IMPLEMENTATION` only for local invariants/test seams; keep accounting code separate |

### Reference quality score

Scores apply only to this audit's subproblems, not overall project quality. Each is out of the requested 100-point rubric: correctness 25, test quality 20, failure handling 15, architecture 15, maintainability 10, activity 5, performance 5, license suitability 5.

| Candidate | Correctness | Tests | Failure | Architecture | Maintainability | Activity | Performance | License | Total | Fit note |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Temporal | 25 | 20 | 15 | 15 | 8 | 5 | 5 | 5 | 98 | Best semantics, high integration complexity |
| Kubernetes primitives | 24 | 20 | 15 | 15 | 8 | 5 | 5 | 5 | 97 | Best versions/floors, not canonical history |
| Agent Orchestrator | 22 | 18 | 13 | 14 | 9 | 5 | 4 | 5 | 90 | Best practical local-daemon fit |
| Restate | 24 | 18 | 14 | 15 | 8 | 5 | 5 | 0 | 89 | Excellent ideas, current reuse blocked |
| Inngest | 17 | 16 | 10 | 11 | 8 | 5 | 4 | 0 | 71 | Good state tests; history is non-authoritative |
| RelayForge current board | 8 | 5 | 3 | 6 | 6 | 2 | 3 | 5 | 38 | Simple UX, unsafe authority/compaction |

## Consequential design comparisons

### Canonical history versus fact store plus CDC

| Approach | What is authoritative | Recovery behavior | RelayForge decision |
|---|---|---|---|
| Current board | Three independently appended JSONL streams plus fold order | Malformed rows vanish; compaction destroys evidence | Reject |
| Agent Orchestrator | Fact rows are durable; change log invalidates/catches clients up; selected provider streams archive raw events | Reconcile facts; provider projection transaction can roll back atomically | Adopt SQLite transaction shape, strengthen event table to canonical history |
| Temporal | Ordered history is canonical; mutable state is reconstructable | Replay history / rebuild mutable state | Adopt authority hierarchy and replay equivalence |
| Inngest lifecycle history | State store is authority; lifecycle history is best-effort observability | Listener failures are isolated/swallowed | Explicitly reject for P1 authority |

RelayForge events must be canonical, not a disposable notification stream. Task/run projections exist for indexed reads and command preconditions, but their digest must be reproducible from the latest verified snapshot plus canonical events. Live SSE/WebSocket notification is only a wake-up optimization.

### Event identity and ordering

| Reference | Identity | Order/fence | RelayForge choice |
|---|---|---|---|
| Agent Orchestrator conversation | unique provider event ID | database sequence + controller generation | Stable source identity and task/run generations |
| Temporal | workflow/run identity + event ID | sequential event ID, version and transaction lineage | Per-run canonical `seq`, explicit expected version, reducer version |
| Kubernetes | UID | resourceVersion + generation/observedGeneration | Separate immutable identity, mutation position, and desired generation |
| Restate | invocation plus journal index | LSN and producer epoch/sequence | Stable retry ID and writer epoch; no code reuse |

RelayForge must never use wall-clock timestamps for ordering or a task name/PID as identity. A caller supplies a stable `eventId` for retry. The store assigns `seq` in the committing transaction. `occurredAt` is descriptive; `recordedAt` is audit metadata. Each command carries `runEpoch`, `taskGeneration`, and `expectedVersion`; stale values fail without appending.

### Retention and compaction

| Reference | Safe property | Missing/different property | RelayForge choice |
|---|---|---|---|
| Current board | Small files after rewrite | Races writers and loses history/attempts | Remove rewrite |
| Temporal | Completed-execution retention and tested branch scavenging | No arbitrary active-prefix deletion | Never compact active runs |
| Kubernetes | Explicit retained floor; expired cursor forces relist | Cache is not canonical | Adopt floor/typed expiration |
| Restate | Journal detail expires separately from completion/idempotency result | BSL and distributed FSM | Preserve terminal outcome/dedupe anchor beyond detail retention |
| Inngest | Status-gated terminal anchors; unfinished runs protected; batch children first | Mostly operational guidance, self-hosted manual | Adopt eligibility and bounded batches |

P1 creates verified snapshots but retains all canonical events. A later GC may delete only a terminal prefix whose terminal fact is stable, whose snapshot is verified, whose horizon has passed, and whose durable consumers have advanced. Dedupe identities and terminal result/failure summary outlive verbose detail. The store records a monotonically increasing `floorSeq`; a cursor below it expires.

### Derived activity

Agent Orchestrator's pure precedence tests are the best direct fit. Kubernetes adds the missing freshness dimension. RelayForge should compute activity from precise facts—claim, latest attempt, runtime observation, review/verification, PR/CI, dependency state—and a single supplied `now`. It should return `{ status, reason, observedGeneration, viewSeq, headSeq, stale }`. It must not persist a writable `working | blocked | done` umbrella truth that can disagree with underlying facts.

## Chosen design

### Best implementation discovered

The strongest design is a synthesis: Agent Orchestrator for the practical
single-daemon SQLite transaction shape and pure status precedence; Temporal for
canonical history and projection rebuild; Kubernetes for generation,
freshness, cursor floors, and typed expiry; and RelayForge's existing money
ledger for fail-closed local corruption/recovery discipline.

### Why

No reference alone satisfies the local control-plane boundary. Agent
Orchestrator's change log is not complete canonical history, Temporal's
distributed machinery is excessive, Kubernetes watch state is a disposable
cache, and the existing RelayForge ledger is intentionally money-specific.
Their proven strengths compose without importing their mismatched machinery.

### What RelayForge will reuse

`ARCHITECTURAL_INSPIRATION` from Agent Orchestrator, Temporal, and Kubernetes;
`IDEA_ONLY` retention lessons from Restate/Inngest; and local
`PORTED_IMPLEMENTATION` only for RelayForge-owned identity/migration test
invariants. Better-sqlite3 is a runtime dependency, while its source reuse is
`NOT_USED`. No upstream source or tests are copied.

### What RelayForge will change

Events become the canonical per-run history rather than a CDC side channel;
projections are rebuildable and digest-checked; all writes are generation- and
expected-version-fenced; cursor floors are explicit; retention initially keeps
all events; and one parent daemon owns the only writable handle.

### How RelayForge will improve it

RelayForge combines local inspectability with deterministic replay, typed
corruption/recovery, exact retry identity, atomic event/projection/cursor
effects, pure freshness-bearing views, and crash/fault characterization on the
committed implementation without adopting distributed scheduler complexity.

### Authority and ownership

One control-plane daemon owns the writable database handle. Agents, provider adapters, dashboard processes, and CLI clients send typed commands to the daemon; they do not append files or open SQLite for writes. A transitional single-process CLI may instantiate the same store only while holding the existing exclusive run lease and after proving no daemon owns it.

Each run stores its authority under its existing run directory, for example `.loop/runs/<project>/<runId>/control.db`, keeping lifecycle, permissions, backup, and migration scope aligned with the current run. A future global index may contain discovery/read models only; it must not become a second authority for run facts.

On open:

1. validate the run directory using the existing safe-state path rules;
2. open the exact database leaf without silently creating it when an initialized manifest says it must exist;
3. configure `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=FULL`, and disable unreviewed extension loading;
4. acquire daemon/single-writer ownership;
5. verify `application_id`, schema version, required physical tables/indexes/triggers, and run identity/epoch;
6. run `quick_check`; schedule a full `integrity_check` at controlled recovery/maintenance points;
7. recover or fail `RECOVERY_REQUIRED`; never replace state with defaults.

`synchronous=NORMAL` is sufficient for Agent Orchestrator's rebuildable UI facts, but RelayForge P1 declares these events authoritative across power loss, so it intentionally chooses `FULL`. Performance can be revisited only with durability fault evidence.

### Logical schema

The exact SQL may evolve during implementation, but these invariants are required:

```text
store_meta(
  store_id UNIQUE, run_id UNIQUE, run_epoch, schema_version,
  reducer_version, head_seq, floor_seq, created_at
)

runs(
  run_id PRIMARY KEY, run_epoch, version, desired_generation,
  precise lifecycle/stop/verification facts, updated_seq
)

tasks(
  run_id, task_id, immutable task spec fields, version, task_generation,
  claimant_role, attempt_count, precise latest facts, updated_seq,
  PRIMARY KEY(run_id, task_id)
)

events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  run_id, run_epoch, task_id NULL,
  task_generation NULL, aggregate_version,
  actor_kind, actor_id, event_type,
  source_kind NULL, source_epoch NULL, source_event_id NULL,
  payload_json, payload_sha256,
  occurred_at, recorded_at,
  UNIQUE(source_kind, source_epoch, source_event_id)
)

snapshots(
  run_id, snapshot_seq, schema_version, reducer_version,
  state_json, state_sha256, projection_sha256, created_at,
  verified_at,
  PRIMARY KEY(run_id, snapshot_seq)
)

consumer_cursors(
  consumer_id, run_id, last_seq, generation, updated_at,
  PRIMARY KEY(consumer_id, run_id)
)

migrations(
  version PRIMARY KEY, name, code_sha256, applied_at,
  physical_schema_sha256
)

legacy_imports(
  import_id PRIMARY KEY, run_id, source_manifest_json,
  source_sha256, imported_head_seq, receipt_sha256, completed_at
)
```

Task definitions can be either a `task_created` event projected into `tasks` or a row plus a trigger-created event, but there must be exactly one atomic authority. The recommended path is command → canonical event insert → deterministic reducer → projection upsert in one `BEGIN IMMEDIATE` transaction. SQL constraints protect uniqueness; the reducer protects domain transitions. A database trigger may assert bookkeeping, but business semantics should remain in a versioned, directly unit-tested TypeScript reducer.

### Append contract

`append(command)` follows this order inside one serialized transaction:

1. load and validate `store_id`, `run_id`, `run_epoch`, aggregate version, and task generation;
2. canonicalize the event payload and compute its digest;
3. query `event_id` (and external source tuple when present):
   - absent: continue;
   - present with the identical immutable envelope/digest: return the original `seq` and projection result as an idempotent retry;
   - present with any mismatch: fail `EVENT_ID_CONFLICT` and append nothing;
4. validate the explicit state transition and claimant/attempt ownership;
5. insert the canonical event, obtaining `seq`;
6. apply the pure reducer to update task/run projections and version/`updated_seq`;
7. update a durable consumer cursor in this same transaction if and only if this command performs that consumer's side effect;
8. commit; only after commit notify live subscribers.

Terminal state is monotonic within a task generation. Reopen is an explicit event that increments `task_generation`; it is not a backwards status assignment. An ambiguous runtime probe produces an observation such as `runtime_probe_failed`, never `runtime_exited`. A current PID without process-start/runtime-launch identity is insufficient evidence.

### Event and reducer versioning

Every event type has a versioned, closed schema. Unknown type/version stops replay with `UNSUPPORTED_EVENT_VERSION`; it is never skipped. Reducer behavior that affects past event interpretation is bound to durable `reducer_version` / feature facts. Current configuration cannot retroactively change replay, following Restate's #5145 lesson.

Migrations may add new projection columns or transform events only through an explicit, backed-up, receipted migration. The startup verifier checks the physical schema and critical index/trigger definitions even when the migration row exists, following Agent Orchestrator #3491.

### Pure activity/read model

The authoritative reducer returns precise facts, not an operator label. `deriveActivity(facts, now)` is a total, side-effect-free function with an explicit precedence table. A recommended high-level precedence is:

1. `recovery_required` / corrupt or unsupported authority;
2. terminal rejected/cancelled/failed/done facts for the current generation;
3. verification or review failure requiring action;
4. explicit input/review wait;
5. runtime confirmed active / attempt executing;
6. claimed/queued/blocked-on-dependencies;
7. idle/no-signal/unknown observation.

The exact labels remain a UI contract and need product approval, but each result includes a stable reason code, `observedGeneration`, `viewSeq`, `headSeq`, and `stale = observedGeneration < desiredGeneration || viewSeq < headSeq`. Time-derived `idle` uses one injected `now` for the entire query; it is not written back as a fact. Stack/run status folds child views with a tested precedence, never last-arrival wins.

### Snapshots, retention, and cursor contract

`createSnapshot(runId)` runs with a consistent read transaction at head `N`, reduces canonical history (or verified prior snapshot plus suffix), serializes normalized state, records schema/reducer versions and hashes, and verifies its projection digest before setting `verified_at`. A snapshot without verification is unusable for replay or GC.

P1 behavior:

- snapshots are an optimization and corruption diagnostic;
- all canonical events are retained;
- presentation-only verbose logs may have their own bounded storage, but no control fact exists only there;
- `compactBoard()` is removed/disabled; no files are rewritten beneath writers.

Future prefix GC, behind a feature flag and separate phase audit, must prove all of:

- the run is terminal and not reopened;
- terminal/final verification facts and the dedupe/result anchor remain;
- retention horizon has passed;
- a verified snapshot at `N` exists and replay of its suffix matches current projections;
- every durable consumer cursor is at least `N` or has been explicitly retired by generation;
- deletion and `floor_seq=N+1` update occur in one transaction, in bounded batches;
- a backup/restore and crash-point suite passes.

`readEvents(afterSeq)` returns ordered events through a transactionally captured head. If `afterSeq < floorSeq - 1`, it returns typed `CURSOR_EXPIRED` with `floorSeq`, `headSeq`, and a snapshot/relist token. It never silently starts at the floor. Live subscribers are lossy wake-ups; sequence gaps always trigger durable catch-up.

### Crash recovery

Startup recovery is deterministic:

1. prove store/run identity and physical schema;
2. let SQLite recover a committed WAL; do not infer success from WAL-file presence;
3. run integrity checks and validate `head_seq`, event sequence continuity above `floor_seq`, event digests, snapshot hashes, and projection updated-sequences;
4. replay latest verified snapshot plus suffix with the bound reducer version;
5. compare replay digest to materialized projection digest;
6. rebuild projections transactionally if history is valid and projections disagree;
7. reconcile external runtime/worktree/PR observations through new generation-fenced events;
8. if identity, history, schema, or external observation is ambiguous, set the daemon's *operational mode* to `RECOVERY_REQUIRED` without mutating canonical facts.

Do not persist `recovery_required` into a database that failed integrity. The daemon can expose the failure from a separate run-owner diagnostic receipt/log. Never delete/recreate the authority automatically.

## Legacy JSONL migration

Migration must be explicit and one-way. It is not part of ordinary `initBoard()` or `loadLoopState()`.

1. Acquire the run lease and prove there are no active agents/daemon writers.
2. Pin and inventory the exact legacy leaves plus loop-state file: device/inode, size, mode, and SHA-256.
3. Parse line-by-line with byte offsets and closed schemas. Only an invalid, unterminated **final** fragment may be classified `TORN_FINAL_RECORD`; any malformed interior line, unknown event kind/version, duplicate conflicting task/event, or impossible transition is `RECOVERY_REQUIRED`.
4. Preserve legacy physical order as the import order. Generate stable migration identities from `SHA-256(store/run identity, leaf kind, byte offset, exact raw record)`, so a resumed import cannot duplicate events.
5. Import tasks/events/messages and valid loop-state facts in one transaction; record source manifest/digests and the committed head in `legacy_imports`.
6. Reduce the imported events and verify projection digest. If old `compactBoard()` already erased attempt/claim history, record an explicit `legacy_lossy_history` diagnostic. Do not invent attempts.
7. Commit and sync the database, then write/prove a durable migration receipt using the existing state-file discipline.
8. Archive legacy leaves only after the committed database and receipt are reopened and verified. Do not destroy the source; use a deterministic read-only archive name.
9. A repeated migration with identical sources returns the prior receipt. A changed source digest, foreign run/epoch, or partially published archive fails closed.

Malformed `state.json` is never replaced with defaults. If the JSONL board is valid but state is not, import what can be proven and leave the run requiring explicit recovery for the missing facts.

## Failure and recovery test matrix

The following are implementation gates, not optional suggestions.

| Area | Test / fault | Required result |
|---|---|---|
| Identity | Retry exact same `eventId` and immutable envelope 100 times | One canonical event/side effect; every retry returns original sequence/result |
| Identity | Same `eventId`, different payload/actor/generation | `EVENT_ID_CONFLICT`; no mutation |
| External identity | Duplicate provider/SCM `(source, epoch, eventId)` | Projects once; mismatched duplicate fails |
| Ordering | Many writers present out-of-order `occurredAt` | Fold order is committed `seq`; timestamps do not reorder authority |
| Concurrency | 64 processes/clients claim one task | Exactly one valid claim; losers receive version/generation conflict; zero phantom claims |
| Fencing | Old daemon/run epoch writes after restart | Rejected before event insert |
| Fencing | Old attempt/task generation reports completion after reopen | Rejected; current generation unchanged |
| Transitions | Non-claimant advances claimed task; terminal regresses without reopen | Rejected atomically |
| Transaction | Inject throw after event insert but before projection | Neither event nor projection commits |
| Transaction | Kill process before commit, during commit, and immediately after commit acknowledgement | Recovery exposes neither side or both sides; never split state |
| Durability | Hard-kill/reboot harness after acknowledged commit | Acknowledged event survives according to `synchronous=FULL` contract |
| DB busy | Hold writer transaction beyond normal overlap | Bounded wait then typed busy/retry result; no unbounded hang or partial mutation |
| Corruption | Unknown event type/version or broken digest in canonical interior | Replay stops `RECOVERY_REQUIRED`; never skips |
| Corruption | Projection altered while history remains valid | Startup detects digest mismatch and rebuilds projection transactionally |
| Corruption | Canonical history/SQLite integrity failure | No automatic recreation/reset; recovery tooling required |
| Schema | Migration ledger says applied but index/column/trigger missing | Physical verifier refuses open or repairs only through explicit migration reconciliation |
| Snapshot | Replay from genesis vs verified snapshot plus suffix | Byte-normalized state/projection digests equal |
| Snapshot | Kill at each snapshot write/verify boundary | Old verified snapshot remains usable or new one is fully verified; unverified row never used for GC |
| Snapshot | Reducer version differs | Typed unsupported/rebuild requirement; current config never silently reinterprets old events |
| Retention | Attempt prefix deletion on active/unfinished run | Refused without deleting anything |
| Retention | Terminal run before horizon / consumer behind | Refused without moving floor |
| Retention | Eligible terminal run, crash during bounded delete | Transaction rolls back or atomically advances prefix/floor; no gap without floor metadata |
| Cursor | Cursor at `floor-1`, floor, head, and beyond head | Correct empty/range behavior at valid boundaries |
| Cursor | Cursor older than `floor-1` | Typed `CURSOR_EXPIRED` with relist/snapshot metadata; no partial suffix |
| Subscriber | Subscriber throws, stalls, disconnects, reconnects, or misses notifications | Writer commit unaffected; durable catch-up by seq produces complete ordered events |
| Derived view | Same facts and injected `now` across process/restart | Identical status, reason, freshness, and transition time |
| Derived view | desired generation advances without new observation | `stale=true`; old condition never presented as current |
| Derived view | runtime probe fails versus proves process exit | Failure yields `unknown/probe_failed`; only identity-proven exit yields exited/failed activity |
| Derived view | terminal/review/CI/input/runtime/dependency facts overlap | Explicit precedence table yields one deterministic reason; stack worst-wins is stable |
| Legacy parse | Invalid final unterminated fragment | May classify/recover only that fragment; source receipt records it |
| Legacy parse | Invalid interior line followed by valid lines | Fail closed; do not import a plausible suffix |
| Legacy identity | Duplicate task/event same content versus conflict | Exact duplicate follows documented idempotency; conflict refuses migration |
| Legacy migration | Crash at source inventory, DB import, receipt, archive, and reopen-proof points | Retry is idempotent; never empty/resets state; source retained until proof |
| Legacy migration | Two concurrent migrators | One receipt/import; loser observes completed migration or conflict |
| Compatibility | Existing dashboard/task APIs over new store | Same intended happy-path UX, but illegal/ambiguous legacy behavior becomes typed error |
| Property | Generate valid event traces, snapshots at every prefix | Full fold equals snapshot+suffix; versions/attempt counts/claim ownership preserved |
| Property | Mutate one field/order/identity in traces | Invariant violation detected; never accepted via timestamp/order coincidence |

The end-to-end recovery suite should use real child processes and `SIGKILL`, following `resume.test.ts` and the ledger migration crash harness. Pure mocks are insufficient for WAL ownership, lock release, or daemon restart.

## Scoped P1 implementation packet

This packet is deliberately small enough for one control-plane phase while closing the unsafe authority path.

### P1.1 — Characterize and freeze current behavior

- Add characterization fixtures for existing board order, attempts, messages, dashboard views, and loop-state recovery.
- Add failing demonstrations for malformed interior JSONL skip, duplicate task overwrite, non-claimant transition, terminal regression, compaction history loss, compactor/writer race, and malformed loop-state reset.
- Do not encode those failures as desired behavior; name them as migration hazards.

Exit gate: the legacy corpus is reproducible and its lossy states are explicitly identified.

### P1.2 — Introduce store contract and pure reducer

- Add versioned event envelopes, typed errors, stable ID/digest canonicalization, explicit transition table, run/task generations, and a total pure reducer.
- Define `ControlStore` operations for append, get/fold facts, snapshot, event-range/cursor, projection verification, and recovery diagnostics.
- Move dashboard activity derivation behind a pure `deriveActivity(facts, now)` API with freshness metadata.

Exit gate: reducer property tests, precedence tests, exact/conflicting duplicate tests, and full-fold/snapshot-suffix equivalence pass without database I/O.

### P1.3 — SQLite authority

- Pin the published `better-sqlite3@12.11.1` and `@types/better-sqlite3@9.6.0` for Node 20 compatibility, or perform a separate engine-upgrade decision before using v13.
- Create schema/migration/physical-verification code and a daemon-owned single-writer store.
- Implement `BEGIN IMMEDIATE` append transaction, source/event uniqueness, projection update, cursor coupling, WAL/FULL pragmas, integrity checks, typed recovery mode, and post-commit live notification.
- Reuse the ledger's fault-injection style and run identity/generation invariants through shared abstractions, not imports of accounting-specific record logic.

Exit gate: transaction, concurrency, hard-kill, schema-reconciliation, corruption, and subscriber tests in the matrix pass.

### P1.4 — Legacy importer and cutover

- Build the strict byte-offset importer and durable receipt/archive protocol.
- Route compatibility `addTask` / `addEvent` / `addMessage` calls through the daemon/store; stop direct JSONL appends.
- Make `loadLoopState()` read the new authority; corruption enters recovery mode, never writes defaults.
- Disable/remove `compactBoard()` and teach dashboard reads to use snapshot/range APIs.

Exit gate: migration fault matrix passes, legacy files remain recoverable, and no product path directly appends/replaces the old authority leaves.

### P1.5 — Snapshots and operational recovery

- Implement create/verify/rebuild projections from snapshots, event range cursors, typed expiration plumbing, `headSeq/viewSeq` telemetry, inspect/export/rebuild commands, and operator recovery diagnostics.
- Retain every canonical event in P1. Add metrics for DB/WAL bytes, event head/floor, snapshot age, projection lag, busy time, replay time, and recovery failures.

Exit gate: committed-head restart tests, projection rebuild, cursor reconnect, backup/restore drill, and the complete P1 suite pass on the committed head.

### Explicitly deferred

- Canonical prefix deletion/GC. Design is specified, but enabling it requires a separate retention implementation audit and all eligibility/crash tests.
- Distributed/multi-daemon writes, consensus, remote database, cross-machine replication, or Temporal-style branches.
- UI redesign beyond consuming pure activity and displaying staleness/recovery errors.

## Improvement over each major source

- Over Agent Orchestrator: make the P1 event stream canonical/replayable and define a retained floor plus typed cursor expiration, rather than relying only on partial CDC.
- Over Temporal for this deployment: retain history-as-authority while removing distributed shard/branch complexity; keep the event/fact transaction local and inspectable.
- Over Kubernetes: keep generation/freshness and expired-cursor semantics while making status pure and history authoritative, not a cache/controller-written truth.
- Over Restate: independently implement the useful retention split under RelayForge's MIT project without copying BSL material, and initially choose the safer no-prefix-GC default.
- Over current RelayForge: match the money ledger's fail-closed recovery discipline for all control facts while using one coherent transaction store instead of three unrelated JSONL leaves.

## Legal/provenance ledger entries required at implementation time

This research artifact is not a substitute for `docs/upstream-sources.md`. When P1 product work begins, add entries with exact pins and the classifications below:

| Subsystem | Reference | Files studied | Classification | Attribution action |
|---|---|---|---|---|
| SQLite fact/event transaction and derived status | Untrivial Agent Orchestrator `f65c48e...` | `db.go`, migrations 0001/0030/0033/0066/0069/0072, conversation store/tests, CDC, status/tests | `ARCHITECTURAL_INSPIRATION` | Record Apache-2.0 reference and independent RelayForge changes; preserve notice only if code is later copied (currently prohibited by design) |
| Canonical history and rebuild | Temporal `023cb7d...` | history architecture, builder/store, mutable-state rebuild and tests, retention/scavenger | `ARCHITECTURAL_INSPIRATION` | Record MIT reference; no source copy |
| Cursor floor and generation/freshness | Kubernetes `94c1367...` | metav1 types/conditions, watch cache/history, etcd watcher, deployment sync/tests | `ARCHITECTURAL_INSPIRATION` | Record Apache-2.0 reference; no source copy |
| Retention split/replay feature facts | Restate `f265773...` | lifecycle journal/purge/restart, dedup, durability tracker, snapshots/tests | `IDEA_ONLY` | State BSL-1.1 explicitly; no code/test/comment copy |
| Retention operational constraints/idempotency tests | Inngest `ce19803...` | lifecycle history, state tests, finalize duplicate tests, retention doc | `IDEA_ONLY` | State SSPL/future-Apache terms explicitly; no code/test/comment copy |
| Node SQLite adapter | published better-sqlite3 `v12.11.1` / `4cbc39ca582fecb6b51dd920dfdd338ba4b72230`; later unpublished `v12.12.0` also inspected | transaction implementation/tests, checkpoint/integrity tests, package metadata, npm publication state, LICENSE | `NOT_USED` for source copying | Lock the exact compatible runtime dependency and retain its license through normal dependency notices; RelayForge owns schema and durability behavior |
| Fail-closed identity/migration test patterns | RelayForge ledger at `66b6082...` | ledger/runtime and transaction suite | `PORTED_IMPLEMENTATION` within same MIT project | Record as internal provenance in change description; do not couple event code to accounting schema |

No surveyed external source is approved for `DIRECT_COPY`, `MODIFIED_COPY`, or line-for-line `PORTED_IMPLEMENTATION`. If implementation later copies any code, stop and amend the license audit and ledger before commit.

## Go/no-go checklist

P1 coding may begin from this audit only if the implementation follows these non-negotiable gates:

- canonical events, projections, and cursor side effects share a SQLite transaction;
- event/source identity, per-run sequence, expected version, and run/task generations are explicit;
- the daemon is the only normal writer;
- unknown/corrupt state fails closed and never resets;
- activity is a pure view with observed generation and sequence freshness;
- `compactBoard()` is not carried forward;
- P1 retains canonical events; future GC has a floor and typed expiration;
- legacy migration is strict, receipted, one-way, resumable, and loss is disclosed;
- the complete failure/recovery matrix passes, then the committed head is tested again;
- `docs/upstream-sources.md` is updated during implementation with exact provenance and license classification.

With those constraints, the selected design is stronger than any single surveyed implementation for RelayForge's actual deployment: Temporal-style replay authority, Agent-Orchestrator-style local transactional facts, Kubernetes-style freshness and cursor expiry, Restate-style retention separation, and RelayForge-ledger-style fail-closed crash discipline—implemented as one control-store model rather than a collection of copied components.
