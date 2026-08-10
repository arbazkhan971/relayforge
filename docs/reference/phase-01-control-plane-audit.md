# Phase 01 reference audit: durable local control plane

Date: 2026-08-09
Status: research and implementation gates passed; P1 implemented (focused 210/210) and included in the green committed release-candidate aggregate — see [implementation-status.md](../implementation-status.md).
Local baseline: `997763e3d5e019b737ab704e69ec11a34c7c3592`

This audit records the required source-level comparison before RelayForge P1
implementation. It combines two independently researched source-tree packets:

- `.workflow/ultracode/relayforge-complete/results/audit-p1-durable-state.md`
- `.workflow/ultracode/relayforge-complete/results/audit-p1-loopback-transport.md`

Those detailed working packets are intentionally outside the npm package. Their
pins, license decisions, and reuse classifications are preserved in the
[packaged upstream ledger](../upstream-sources.md).

Both packets inspect actual source, focused tests, architecture material,
recent history, relevant issues and pull requests, and license/NOTICE material
at immutable pins. This phase does not treat README claims as implementation
evidence. The detailed packets are part of this audit and remain the evidence
index; this file is the coherent phase decision.

## Scope and non-negotiable local rules

P1 supplies one daemon-owned local state boundary, deterministic derived views,
a foreground `loop serve` lifecycle, versioned read-only REST, and durable SSE
replay. It does not add remote access, HTTP mutations, background daemonization,
terminal injection, event deletion, or a second source of truth.

The following existing RelayForge rules remain authoritative:

- only the trusted parent writes canonical state;
- facts and event history are persisted, presentation status is derived;
- recovery uncertainty is visible and fail-closed, never an empty successful
  view;
- the listener is the IPv4 loopback literal `127.0.0.1` and unauthenticated;
- public data is an explicit allowlisted DTO followed by bounded redaction;
- SSE is notification transport, never authority; its cursor is the durable
  event cursor;
- direct run cancellation and every other mutation remain outside HTTP.

## Audit method

Repositories were selected by subproblem rather than star count. The primary
Agent Orchestrator implementation was studied first. Searches then covered
coding-agent daemons, durable execution, event sourcing, SQLite state, local
service ownership, replayable SSE, list/watch systems, and loopback developer
tools. AgentWrapper's URL was independently checked and resolves to the same
repository/tree as Untrivial; it is not counted twice.

For each promoted reference the audit inspected implementation and tests before
forming a design conclusion. Restricted-license projects were used only for
generic ideas and are explicitly excluded from source/test copying.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Untrivial-ai/agent-orchestrator `f65c48e` | SQLite migrations/stores, CDC sequence, status reducer, daemon run-file/health, REST/SSE and reconnecting client | Closest complete coding-agent control plane; strong integration coverage and active bug-fix history | PID/run-file is not a lifetime lease; mutable/broad API; no general SSE floor or byte budget | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| temporalio/temporal `023cb7d` | Canonical workflow history, rebuild, persistence and cleanup tests | Strongest history-as-authority and projection-rebuild model | Distributed machinery and branch semantics are far beyond a local P1 | MIT | `ARCHITECTURAL_INSPIRATION` |
| kubernetes/kubernetes `94c1367` | generation/resourceVersion, conditions, watch-cache history, retry watcher and expiry tests | Strongest freshness stamp and explicit expired-cursor/relist contract | Distributed API/cache machinery is unnecessary locally | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| WiseLibs/better-sqlite3 published `v12.11.1` / `4cbc39c` | synchronous Node SQLite binding, transactions/savepoints/WAL and integrity coverage | Small serialized-writer fit, Node 20 support, mature test surface | Native dependency; later audited v12.12.0 tag is not published; RelayForge must own schema/recovery/migration semantics | MIT | `DIRECT_DEPENDENCY` at exact published `12.11.1` |
| kurrent-io/kcap-cli `b90b59e` | stable lifetime lock, instance/PID-start identity, serialized starts and doctor tests | Strongest crash-released local-owner model | Non-standard Kurrent License; no code reuse basis | Kurrent License v1 | `IDEA_ONLY`; zero copying |
| QwenLM/qwen-code `3e731cd` | bounded SSE bus, strict cursor/epoch parsing, replay/byte/subscriber/slow-client tests | Best focused local SSE resource bounds and explicit resync behavior | In-memory epoch is not durable authority; broader mutating service | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| daintreehq/daintree `a5c2dae` | loopback Host/Origin gate, readiness timeout, byte-capped results | Strong admission and output-bound supporting evidence | Electron owns lifetime; MCP SSE is not durable replay | Apache-2.0 | `SUPPORTING_REFERENCE` |
| restatedev/restate `f265773` | journal lifecycle, durability, purge and snapshots | Valuable retention and durable-execution failure ideas | Current BSL-1.1 terms are not approved for implementation reuse | BSL-1.1 | `IDEA_ONLY` |
| inngest/inngest `ce19803` | lifecycle history, idempotency and retention tests | Useful duplicate-finalization negative cases | SSPL/current terms are not suitable here | SSPL | `IDEA_ONLY` / `NOT_USED` |

### Quality assessment by subproblem

| Subproblem | Strongest implementation found | RelayForge conclusion |
|---|---|---|
| Coding-agent end-to-end control plane | Agent Orchestrator | Keep its thin-client and observation/reducer boundaries, strengthen ownership, cursor expiry, DTO scope, and recovery visibility |
| Canonical durable workflow history | Temporal | Use immutable run-scoped event history and verified projection rebuild without distributed branches/shards |
| Generation and cursor semantics | Kubernetes | Carry generation/view/head/floor explicitly; expired history causes resnapshot, never a plausible suffix |
| Node local persistence | better-sqlite3 12.11.1 | One published pinned dependency and one shared adapter; no competing SQLite wrapper |
| Local service ownership | kcap | Stable crash-released lifetime lease plus random instance and process-incarnation agreement; independently implement |
| SSE bounds | Qwen Code | Enforce cursor, epoch, event, frame, byte, client and drain bounds with explicit resync/eviction |
| Loopback request admission | Daintree | Require exact Host and same-origin values as a defense-in-depth local gate |

The optional weighted quality exercise in the detailed audits confirms there is
no single best repository. Agent Orchestrator wins relevance and integration;
Temporal wins canonical-history correctness; Kubernetes wins cursor recovery;
kcap wins owner lifetime; Qwen wins bounded SSE. License suitability prevents
kcap, Restate, and Inngest source reuse regardless of technical interest.

## Chosen design

Best implementation discovered: a synthesis of Agent Orchestrator's daemon and
CDC shape, Temporal's canonical history, Kubernetes' freshness/cursor contract,
kcap's lifetime-owner semantics, and Qwen's stream bounds.

Why: each reference is strongest at a different required boundary. Porting any
one wholesale would either weaken RelayForge's authority model or import large
unneeded machinery.

What RelayForge will reuse:

- the exact published MIT `better-sqlite3@12.11.1` package as a dependency;
- architecture and test ideas from the permissive references, independently
  expressed in RelayForge types and tests;
- existing local state-file, ownership, confinement, doctor, dashboard and
  reducer primitives where they meet the new contract.

What RelayForge will change:

- replace permissive JSONL folding with a strictly validated SQLite canonical
  event stream plus transactional projections;
- replace run-file/PID inference with a held lifetime lease plus exact
  run-file/health/process-incarnation agreement;
- narrow the HTTP surface to versioned `GET`/`HEAD` DTOs;
- bind SSE IDs directly to `(runEpoch, seq)`, with floor/head/view freshness and
  typed resync;
- make read corruption/recovery-required observable rather than returning an
  empty board;
- keep mutation and settlement authority entirely outside the listener.

How RelayForge improves the surveyed implementations:

- one event identity drives persistence, projections, REST freshness and SSE;
- stable retry/event IDs and run/task generation fence stale writers;
- verified snapshots are optimizations, never independent authority;
- wake-before-head catch-up makes coalesced/lost notifications harmless;
- exact replay/frame/byte/client/drain caps prevent a local reader from
  blocking the writer;
- allowlisting precedes a shared cycle-aware bounded redactor;
- a crash-released owner lease prevents both stale-marker lockout and duplicate
  daemons;
- strict receipted JSONL migration fails on malformed interior history instead
  of silently resetting or skipping it.

## Durable state decision

Each run owns a SQLite database. The daemon is the sole ordinary writer. The
canonical table is append-only in P1 and assigns monotonic `seq` inside the same
transaction that updates projections. Every event carries immutable event ID,
run ID/epoch, task identity/generation where applicable, expected version,
type/schema version, timestamp and bounded validated payload.

SQLite opens with foreign keys enabled, a bounded busy timeout, WAL for run
stores, and `synchronous=FULL`. Schema migrations are ordered, transactional,
checksummed and fail closed on unknown/newer versions or failed integrity
checks. Projection rebuild reads canonical history and verifies the resulting
head. A snapshot is accepted only when its checksum, schema, epoch and event
head agree; otherwise RelayForge rebuilds from history.

P1 performs no canonical event deletion. It nevertheless exposes `floorSeq`
and returns typed cursor expiry so future reviewed retention cannot silently
alter the client contract. Legacy JSONL import is one-shot and receipted: input
identity, digest, counts and resulting head are durable; a torn final line may
be handled only by the documented terminal-line rule, while malformed interior
records, invalid types, impossible transitions or unsafe input shapes stop the
migration.

Derived activity is a pure function of persisted facts plus an injected `now`.
It returns the closed activity state and reason together with observed
generation, `viewSeq`, `headSeq` and staleness. Display activity is never written
back as a fact.

## Service and transport decision

`loop serve` is one foreground process for the loaded configuration. It holds a
transactional `BEGIN IMMEDIATE` lease in a dedicated stable rollback-journal
SQLite database for its lifetime; the stable lease path is never unlinked.
Discovery requires all of the following:

1. the lifetime lease is held;
2. a private, strictly bounded, durably published `serve.json` names a fresh
   instance, stable config identity, PID/start token, literal host and port;
3. `/api/v1/health` returns the same non-secret instance/config/PID identity.

The listener binds only `127.0.0.1` at the configured deterministic port. It
publishes discovery only after bind and store validation, becomes not-ready
before shutdown, drains for a bound, removes only its own run-file instance and
releases the lease last. A stale run-file is evidence, not authority. `serve
stop` signals only after live process-incarnation agreement and never escalates
to SIGKILL in P1.

REST exposes bounded health, status, runs, run, board, activity, curated
diagnostics and run-scoped events endpoints under `/api/v1`. No endpoint mutates
state. All routes enforce strict IDs/cursors, exact loopback Host and same
Origin, generic typed errors, no-store/hardening headers, explicit DTO mapping,
deep redaction and final UTF-8 byte caps. Recovery errors are typed `503`, not
empty `200`.

SSE registers a coalescing wake before capturing durable head, validates
`runEpoch` and cursor against floor/head, preflights the entire replay budget,
then reads ordered durable ranges. The broadcaster carries only a wake-up; it
never owns an event. Replay/live overlap is discarded by durable sequence.
Unknown event mapping, epoch mismatch, cursor expiry, replay overflow or a slow
socket produces an id-less resync/control frame and close without advancing the
client cursor. The dashboard snapshots first and refetches on open; status CLI
uses the same discovery/health and `/api/v1/status` path end to end.

## Failure cases promoted into RelayForge tests

Tests must cover, at minimum:

- concurrent starts, SIGKILL before/after run-file publication, stable lease
  inode, stale run-file, PID reuse and successor-safe cleanup;
- unknown/newer DB schema, integrity failure, transaction rollback, duplicate
  event retry, stale generation/version, corrupted projection and deterministic
  rebuild;
- strict legacy migration receipt, repeated migration, changed source,
  malformed interior record and terminal torn line;
- activity precedence, injected-clock boundaries, restart read, generation and
  view/head freshness;
- literal loopback bind, every disallowed method, Host/Origin mismatch,
  oversized request/response, unsafe IDs/cursors and cross-project ownership;
- secret/path canaries through every REST success/error, diagnostics, SSE
  replay/live and sanitized log channel;
- subscribe-before-head, replay/live overlap, dropped/coalesced wakes, restart
  resume, epoch mismatch, cursor expiry, exact/plus-one replay limits, mapping
  failure, slow client and subscriber exhaustion;
- real child `loop serve` to `loop serve status --json`, and canonical board
  event to projection to SSE invalidation to client refetch.

## Legal conclusion

No upstream source, test, comment, SQL schema or distinctive file layout is
copied by this design. `better-sqlite3@12.11.1` (plus its exact type package) is the only approved direct
dependency and remains MIT. Agent Orchestrator, Temporal, Kubernetes, Qwen and
Daintree are architecture/test inspiration. kcap, Restate and Inngest are
idea-only or unused under their current terms. Any later direct or modified copy
requires a same-change ledger amendment and applicable notices/headers.

## Gate result

The P1 research gate is complete. Implementation may proceed only against
[ADR 002](../adr/002-durable-local-control-plane.md) and the two detailed audit
packets. P1 is not complete until focused, failure, real-process, full-suite,
build and committed-head verification all pass.
