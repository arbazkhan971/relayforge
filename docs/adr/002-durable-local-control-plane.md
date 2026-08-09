# ADR 002: durable local control plane

- Status: Accepted and implemented (P1 focused suites green; final committed-HEAD aggregate still pending — see [implementation-status.md](../implementation-status.md))
- Date: 2026-08-09
- Decision owners: RelayForge maintainers
- Research gate: [Phase 01 control-plane audit](../reference/phase-01-control-plane-audit.md)

## Context

At decision time, RelayForge reduced permissive append-only JSONL board files
and ran a one-shot polling dashboard. That was insufficient for crash recovery,
idempotent mutations, deterministic derived activity, a single daemon writer,
or replayable clients. A display must also never turn a corrupt read into a
plausible empty board.

P1 needs one coherent decision spanning persistence, ownership, REST and SSE.
Choosing those separately would create competing counters, lifetimes and error
semantics.

## Decision

RelayForge will use one run-scoped SQLite database as the canonical event
history and transactional projection store. One foreground `loop serve` process
owns the ordinary writer and the read-only loopback API. A separate stable
SQLite lease database holds a `BEGIN IMMEDIATE` transaction for the process
lifetime and proves exclusive service ownership.

The exact Node dependency is the published `better-sqlite3@12.11.1` plus
`@types/better-sqlite3@9.6.0`. It is the shared adapter
for both run stores and the service lease. No second SQLite library or
unconstrained latest version is allowed in P1. Upstream's later `v12.12.0` Git
tag was audited but is not published to npm and is therefore not a package pin.

## Canonical history

Canonical events are append-only in P1. Sequence assignment and projection
updates occur in one transaction. An event has:

- immutable `eventId` and monotonically assigned run-local `seq`;
- immutable `runId` and random `runEpoch`;
- task ID and task generation when task-scoped;
- closed event type and schema version;
- expected aggregate version for compare-and-swap fencing;
- parent timestamp and bounded validated payload.

An identical event-ID retry with identical canonical content is an idempotent
success returning the original sequence. Reuse with different content is
corruption. A stale expected version or generation is a typed conflict and
appends nothing.

SQLite foreign keys are enabled. Run stores use WAL, `synchronous=FULL` and a
bounded busy timeout. Migrations are ordered, transactional and checksummed.
Unknown/newer schemas, failed integrity checks or impossible history refuse
ordinary operation.

## Projections and activity

Projection rows are disposable outputs of canonical history. A verified
snapshot may accelerate rebuild only when schema, run epoch, checksum and event
head agree. Otherwise the reducer rebuilds and verifies from the canonical
stream.

Activity is returned by a pure `deriveActivity(facts, now)` boundary. It
includes a closed state/reason plus observed task generation, `viewSeq`,
`headSeq` and stale flag. Presentation state is never persisted as fact.

The store publishes a post-commit coalescing wake. The wake is not an event and
may be lost; consumers always query durable ranges.

## Retention and migration

P1 deletes no canonical events. The store still exposes `floorSeq` and typed
`CURSOR_EXPIRED` semantics. Later retention requires a new reviewed decision
but cannot change the transport contract.

Legacy JSONL migration is one-shot, strict and receipted. The receipt binds the
source identity/digest/counts and resulting epoch/head. Repeating an identical
migration is idempotent; changing the source after receipt or finding malformed
interior history fails closed. There is no “skip malformed and continue” or
“reset to empty” path.

## Service ownership and discovery

The service derives one stable configuration identity from canonical config and
root locators. Under its private control directory it keeps:

- a stable lease database, never unlinked; and
- a maximum-8-KiB private `serve.json`, atomically and durably published.

The run-file contains only schema/service tags, random instance ID, stable
config ID, PID, process-start token, literal host, port and start time. It is
discovery evidence, not a lock.

An attach succeeds only when the lease is held and the private run-file and
bounded `/api/v1/health` response agree on service/config/instance/PID. A stop
additionally verifies the live process-start token before signaling. PID
existence alone is never authority.

Startup acquires the lease, validates stores, binds exactly
`127.0.0.1:<configured-port>`, publishes the run-file, then marks ready.
Shutdown marks not-ready, closes streams/listener with bounded drain, closes
stores, removes only a still-owned run-file instance, and releases the lease
last. Crash releases the lease; a successor safely replaces stale discovery.

## Public API

All API routes are under `/api/v1`, permit `GET` and `HEAD` only, and expose
explicit versioned DTOs for health, status, runs, run, board, activity, curated
diagnostics and run-scoped events. Direct run/agent/SCM/config/settlement
mutation remains outside HTTP.

Every request enforces literal-loopback Host, same loopback Origin when present,
strict bounded IDs/query/header/URL values, exact project/run/session ownership,
no-store and hardening headers. Responses are built from allowlisted fields,
then passed through the shared bounded cycle-aware redactor, serialized once and
checked against an endpoint UTF-8 byte ceiling. Internal errors and paths never
enter public errors. Recovery-required is a typed unavailable response, not an
empty success.

## Durable SSE

An ordinary SSE frame ID is the canonical event `seq`; its identity is
`(runEpoch, seq)`. Control and heartbeat frames have no ID and never advance the
cursor.

The stream:

1. validates ownership, epoch and strict cursor;
2. registers a one-slot wake before reading head;
3. captures floor/head and rejects expired or impossible cursors;
4. preflights the complete replay against event/frame/byte limits;
5. replays durable ranges in sequence and catches up again after every wake;
6. awaits socket drain only for a fixed bound; and
7. unregisters and releases every slot/listener/timer exactly once.

Replay/live overlap is discarded by sequence. Coalesced wakes cannot lose
authority because the stream rereads to current durable head. Epoch mismatch,
expired cursor, unknown event mapping, replay budget exhaustion or slow client
causes explicit resync/control plus close, never a partial successful suffix.

## Consequences

Positive:

- one cursor and one authority span storage, projections, REST and SSE;
- crash recovery and duplicate mutation semantics become testable and
  deterministic;
- clients remain thin and can always resnapshot after uncertainty;
- service ownership is released by the kernel/SQLite on crash rather than by
  stale-marker heuristics;
- HTTP remains a narrow local observation surface.

Costs:

- a pinned native dependency is added;
- JSONL migration and projection rebuild need substantial failure tests;
- foreground service lifecycle and a stable lease DB must be supported on each
  advertised platform or fail closed;
- SQLite is restricted to a proven local filesystem; network-filesystem lock
  semantics are not claimed.

Rejected alternatives:

- retain JSONL as canonical authority and tail it for SSE;
- persist display activity directly;
- use a memory event counter/ring as the resume cursor;
- treat a PID/run-file or port bind as the service lease;
- expose raw internal/config objects and rely on regex redaction;
- return empty views on read errors;
- add remote bind/auth or HTTP mutations in P1;
- background-fork the service without a separate supervision/logging design.

## Verification gate

Acceptance requires strict migration/recovery/idempotency/reducer tests;
simultaneous-start and SIGKILL service tests; redaction and exact-boundary
canaries across REST/SSE/errors; replay race, expiry, restart, slow-client and
subscriber-bound tests; real `serve status` and board-to-SSE end-to-end tests;
then typecheck, complete test suite, build and clean committed-head rerun.
