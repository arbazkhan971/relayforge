# Phase 5 reference audit: live observability and control room

Date: 2026-08-09

Decision owner: Phase 5 research packet

Scope: research and implementation design only; this audit changes no product code

## Executive decision

RelayForge should build its control room on the durable P1 read model and SSE
invalidation channel, not on a terminal mirror. The public output timeline must
contain closed, versioned, parent-owned or provider-normalized facts. Raw
transcripts, terminal bytes, tmux identifiers, filesystem paths, prompts, tool
output, command arguments, and model prose never enter its public DTOs.

The selected synthesis is deliberately per-subproblem:

1. retain RelayForge's SQLite authority, `(runEpoch, seq)` cursors, loopback
   HTTP rules, metadata-only SSE, redaction and response caps;
2. use AO's pinned-descriptor, source-generation, checkpoint and quiescent-tail
   model when a provider can only supply an append-only transcript;
3. use a Session Center-style lazy, fixed-capacity byte ring only as a
   non-authoritative sanitized presentation cache;
4. use TUICommander's stable activity spine and request/generation fencing,
   with Daintree's late-exit fencing, coalescing and explicit drop-pressure UX;
5. expose a bounded, indexed sequence of typed observation records, informed by
   DoorDash Agentic Orchestrator's structured transcript projection, while
   excluding its display prose and in-memory-only replay limitations.

No reference is adopted wholesale. Stagewise is `IDEA_ONLY` because it is
AGPL-3.0. Overstory's partial-tail behavior and Tutti's terminal-derived state
are explicit negative examples.

## Question and non-negotiable constraints

The question was not “which dashboard looks best?” It was: how can an operator
observe many live agents, recover after restart or source replacement, and
understand loss/staleness without creating a second authority or leaking raw
agent material?

The answer must preserve these already-landed contracts:

- P1 SQLite events and projections are the sole durable control-plane truth.
- P1 HTTP remains loopback-only, GET/HEAD-only, origin/host checked,
  credential-rejecting, schema-closed and byte-capped.
- P1 SSE is a replayable notification channel, not a second state payload.
- P2 steering lifecycle is parent-owned. Terminal text can never prove that a
  prompt was accepted, delivered, consumed or settled.
- `src/streaming.ts` fans one accepted provider frame to a bounded display tail
  and the authoritative normalizer; only `NormalizedTurn` may settle work.
- Source and runtime generations fence observations. An old process, file or
  request cannot update a replacement.
- “No records,” “not yet known,” “temporarily unreadable,” “truncated,” “source
  replaced,” and “stale projection” are distinct operator-visible states.

## Method

The audit inspected implementation, tests, history, open/closed issue and PR
state, and license files at immutable commits. README text was not accepted as
implementation evidence. Current GitHub repository state was checked on
2026-08-09; activity counts are deliberately not treated as quality scores.

Prerequisite RelayForge evidence was read in full: the global
`.workflow/ultracode/relayforge-complete/plan.md`, P1 durable-state and loopback-
transport audits, P2 session-steering audit, public Phase 01/02 reference
audits, and ADR 002/003. The current control, dashboard, streaming, normalizer,
tmux/monitor sources and their protocol/reducer/view/server/SSE/stream-authority
tests were then inspected directly.

Quality scoring is P5-specific: correctness 25, test depth 20, failure/recovery
15, architecture fit 15, maintainability 10, current activity 5, performance
and bounds 5, license/reuse clarity 5. A high score does not override a legal or
architecture rejection.

Reuse labels in this audit are normative:

- `ARCHITECTURAL_INSPIRATION`: behavior and test boundaries may inform an
  independently written RelayForge implementation. If code is actually copied
  later, reclassify it and satisfy the named license and notice obligations in
  that implementation change.
- `IDEA_ONLY`: learn from externally visible behavior only; do not copy code,
  tests, comments, generated structures or distinctive arrangement.
- `NOT_USED`: do not use the named primitive, even if another part of the same
  repository remains useful.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| RelayForge local baseline `73051d5` plus P1 | Canonical control events/projections, durable SSE, strict DTO/redaction, streaming normalizers, dashboard/monitor, and their tests | Strongest authority, replay, settlement, and privacy boundary; direct integration target | Before P5, no normalized observation projection or transcript source-generation ingestion | MIT | `NOT_USED` as an upstream; extend the local implementation |
| Untrivial Agent Orchestrator `f65c48e` | Descriptor-pinned usage transcript ingestor, coordinator/watcher/parser, atomic checkpoints, and mutation/restart tests | Best transcript source-integrity and quiescent-tail implementation | Broader observation plane and public data model do not fit RelayForge's privacy/authority boundary | Apache-2.0; no NOTICE observed | `ARCHITECTURAL_INSPIRATION` |
| DoorDash Agentic Orchestrator `101ca9a` | Typed indexed session output, mutable-tail replacement, SSE/read contracts, and tests | Best typed/indexed output challenger | Replay is memory-oriented and public prose is broader than RelayForge permits | Apache-2.0 plus `NOTICE.txt` | `ARCHITECTURAL_INSPIRATION` |
| TUICommander `ce097a4` | Generation-fenced polling, terminal store, activity dashboard, SSE routes, caps, and tests | Best stable multi-agent activity UX and client generation fences | Live-only SSE and raw/path-rich fields cannot be authority or public DTOs | Apache-2.0; no NOTICE observed | `ARCHITECTURAL_INSPIRATION` |
| AI Agent Session Center `ff8e4b2` | Lazy fixed-capacity PTY ring in server/Electron copies with shared parity tests | Best small bounded presentation-ring primitive | Raw PTY consumers and duplicate implementations; ring is not durable truth | MIT | `ARCHITECTURAL_INSPIRATION` |
| Daintree `a5c2dae` | Lifecycle ledger, PTY backpressure, status buffer, activity FSM, and adversarial/property tests | Best lifecycle-race, coalescing, and pressure/drop visibility | Large terminal-inference stack; some status derives from terminal behavior | Apache-2.0 plus NOTICE/trademark terms | `ARCHITECTURAL_INSPIRATION` |
| Agents Observe `bb2f6c3` | Canonical event signatures, SQLite admission, WebSocket/CORS, transcript parsing, and race tests | Useful duplicate-admission characterization | Live-only WebSocket and full-file parsing are weaker; source generation/replay insufficient | MIT | `ARCHITECTURAL_INSPIRATION` for narrow dedup behavior |
| Stagewise `104d1c2` | Agent-shell logger/service/manager/OSC parser and focused tests | Useful headless-terminal and bounding comparison | AGPL boundary; OSC/terminal text is forgeable and cannot establish authority | AGPL-3.0 | `IDEA_ONLY` |
| Overstory `ff38f3f` | Event tailer/store and tests | Small direct tailing comparator | Archived; advances cursor before parsing and loses partial/malformed/error evidence | MIT | `NOT_USED` |
| Tutti `6b86cca` | Serve/dashboard/runtime/tmux sources | Useful negative comparison for terminal-oriented control rooms | Timestamp cursor, raw terminal polling, and output-pattern state are weaker | MIT | `NOT_USED` |

### Source, test, history, issue, and activity inventory

| Reference | Immutable pin / observed activity | Implementation and test evidence inspected | History, issues and PR evidence | License / reuse | P5 verdict |
| --- | --- | --- | --- | --- | --- |
| RelayForge | `73051d510c6473fa763bc7cd81921f65bec00eea` plus the in-flight P1 tree audited 2026-08-09 | `src/control/{protocol,events,reducer,views,server,sse}.ts`, `src/dashboard/render.ts`, `src/{streaming,normalize,monitor,tmux}.ts`; `tests/control-{protocol,reducer,views,server,sse}.test.ts`, `tests/streaming-authority.test.ts` | P1/P2 audits and ADRs 002/003; current integration ownership in the Ultracode plan | MIT; project authority | Keep durable store, normalized settlement, security boundary and SSE; replace raw-monitor concepts |
| [Untrivial AO](https://github.com/Untrivial-ai/agent-orchestrator) | `f65c48e296e20a816221a4003c75a5f0387967ec`, 2026-08-09 | [`ingestor.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/observe/usage/ingestor.go), `coordinator.go`, `watcher.go`; [`ingestor_integration_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/observe/usage/ingestor_integration_test.go), coordinator/watcher/parser tests | [PR #3709](https://github.com/Untrivial-ai/agent-orchestrator/pull/3709) and [terminal issue #3309](https://github.com/Untrivial-ai/agent-orchestrator/issues/3309); active issue/PR history checked | Apache-2.0, no NOTICE observed; `ARCHITECTURAL_INSPIRATION` | Primary source-integrity reference; do not import AO's whole observation plane |
| [DoorDash Agentic Orchestrator](https://github.com/doordash-oss/agentic-orchestrator) | `101ca9a416371c4d9db0935cf4aef73f77551366`, 2026-08-09 | [`sse.go`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/server/sse.go), [`session_model.go`](https://github.com/doordash-oss/agentic-orchestrator/blob/101ca9a416371c4d9db0935cf4aef73f77551366/internal/server/session_model.go); `sse_test.go`, `session_output_test.go`, `read_api_contract_test.go`, client output-stream tests | Current source/history and repository issue/PR surfaces checked; late challenger found by P5 rescan | Apache-2.0 plus `NOTICE.txt`; `ARCHITECTURAL_INSPIRATION` | Best typed/indexed output challenger; RelayForge's durable SSE remains stronger |
| [TUICommander](https://github.com/sstraus/tuicommander) | `ce097a40de6c3624b84b475b23be1bb95624bd7c`, 2026-08-06, v1.7.2 | [`useAgentPolling.ts`](https://github.com/sstraus/tuicommander/blob/ce097a40de6c3624b84b475b23be1bb95624bd7c/src/hooks/useAgentPolling.ts), `stores/terminals.ts`, `ActivityDashboard.tsx`, `sse_routes.rs`; `useAgentPolling.test.ts`, `commandBlocksCap.test.ts`, `terminals-lastDataAt.test.ts` | Current issue/PR surface and recent release history checked | Apache-2.0, no NOTICE observed; `ARCHITECTURAL_INSPIRATION` | Primary activity UX and client generation-fence reference; reject its live-only SSE and raw fields |
| [AI Agent Session Center](https://github.com/coding-by-feng/ai-agent-session-center) | `ff8e4b2122aff58db12b662060f2939d7fa2f8a3`, 2026-08-03 | [`server/ptyRing.ts`](https://github.com/coding-by-feng/ai-agent-session-center/blob/ff8e4b2122aff58db12b662060f2939d7fa2f8a3/server/ptyRing.ts), `electron/ptyRing.ts`, SSH/PTY consumers; [`test/ptyRing.test.ts`](https://github.com/coding-by-feng/ai-agent-session-center/blob/ff8e4b2122aff58db12b662060f2939d7fa2f8a3/test/ptyRing.test.ts) runs parity suites against both copies | Current source/history and issue/PR surface checked | MIT; `ARCHITECTURAL_INSPIRATION` | Primary bounded lazy-ring reference; cache sanitized records only, never authority or raw PTY bytes |
| [Daintree](https://github.com/daintreehq/daintree) | `a5c2dae192f18378e80b97d378f6015f8eda45d7`, 2026-08-09 | [`lifecycleLedger.ts`](https://github.com/daintreehq/daintree/blob/a5c2dae192f18378e80b97d378f6015f8eda45d7/electron/services/pty/lifecycleLedger.ts), `pty-host/backpressure.ts`, `panelStatusBuffer.ts`, `AgentActivityTemperature.ts`; lifecycle-ledger, backpressure adversarial, buffer and FSM/property tests | Active history and issue/PR surface checked | Apache-2.0 plus `NOTICE`; Daintree name/logo excluded; `ARCHITECTURAL_INSPIRATION` | Best terminal lifecycle/backpressure evidence; borrow small concepts, not its complex terminal inference stack |
| [Agents Observe](https://github.com/simple10/agents-observe) | `bb2f6c382cafb4d8111fc3137bab376b3aee11ed`, 2026-07-21 | [`event-signature.ts`](https://github.com/simple10/agents-observe/blob/bb2f6c382cafb4d8111fc3137bab376b3aee11ed/app/server/src/utils/event-signature.ts), `routes/events.ts`, `websocket.ts`, `cors.ts`, transcript parser; events/signature/SQLite/websocket-origin tests | [issue #22](https://github.com/simple10/agents-observe/issues/22) and fix history inspected; issue/PR surface current | MIT; `ARCHITECTURAL_INSPIRATION` | Useful canonical dedup race tests; reject live-only unbounded WebSocket and full-file transcript loop |
| [Stagewise](https://github.com/stagewise-io/stagewise) | `104d1c27376bc37e6b93adfc3617254358346823`, 2026-08-07 | [`session-logger.ts`](https://github.com/stagewise-io/stagewise/blob/104d1c27376bc37e6b93adfc3617254358346823/packages/agent-shell/src/engine/session-logger.ts), `shell-service.ts`, `session-manager.ts`, `osc-parser.ts`; logger/manager/OSC tests | Current source/history and issue/PR surface checked | AGPL-3.0; `IDEA_ONLY` | Useful headless-terminal and bounded-output ideas; no code, tests or structure may be copied |
| [Overstory](https://github.com/jayminwest/overstory) | `ff38f3f76f084abcc34f519bcaa69580f6e53cf1`, 2026-05-28; repository archived | [`tailer.ts`](https://github.com/jayminwest/overstory/blob/ff38f3f76f084abcc34f519bcaa69580f6e53cf1/src/events/tailer.ts), `tailer.test.ts`, event store | Archive state and issue/PR surface checked | MIT; primitive `NOT_USED` | Cursor advances before parse; partial/malformed data and read errors are silently lost |
| [Tutti](https://github.com/nutthouse/tutti) | `6b86cca7457364888032e6ff9c04f2a87fc14cb2`, 2026-07-20 | `src/cli/serve.rs`, `src/dashboard.rs`, `src/runtime/mod.rs`, tmux/session sources | Current source/history and issue/PR surface checked; additional P5 discovery candidate | MIT; terminal/state primitive `NOT_USED` | Timestamp SSE cursor, raw terminal polling and output-pattern authority are weaker than RelayForge |

Current repository state was queried from GitHub on 2026-08-09 after the pinned
source inspection:

| Reference | Last push observed (UTC) | Archived | Open issues | Open PRs |
| --- | --- | --- | ---: | ---: |
| Untrivial AO | 2026-08-09 11:03 | no | 340 | 261 |
| DoorDash Agentic Orchestrator | 2026-08-09 07:51 | no | 3 | 12 |
| TUICommander | 2026-08-06 15:25 | no | 1 | 0 |
| AI Agent Session Center | 2026-08-03 08:41 | no | 2 | 0 |
| Daintree | 2026-08-09 10:50 | no | 9 | 2 |
| Agents Observe | 2026-07-22 06:40 | no | 2 | 2 |
| Stagewise | 2026-08-08 11:21 | no | 17 | 16 |
| Overstory | 2026-05-28 17:12 | **yes** | 16 | 8 |
| Tutti | 2026-07-28 01:53 | no | 14 | 4 |

These counts are a dated activity check, not a durability or quality claim.

### P5 fit scores

| Reference | Correct 25 | Tests 20 | Recovery 15 | Fit 15 | Maintain 10 | Active 5 | Bounds 5 | Legal 5 | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| RelayForge P1/stream foundation | 24 | 20 | 14 | 15 | 9 | 5 | 5 | 5 | **97** |
| Untrivial AO usage ingestor | 25 | 20 | 15 | 14 | 8 | 5 | 4 | 5 | **96** |
| DoorDash Agentic Orchestrator | 24 | 20 | 14 | 14 | 8 | 5 | 4 | 5 | **94** |
| Daintree selected primitives | 23 | 20 | 14 | 11 | 6 | 5 | 4 | 5 | **88** |
| TUICommander selected primitives | 22 | 18 | 12 | 13 | 8 | 5 | 4 | 5 | **87** |
| AI Agent Session Center ring | 23 | 20 | 12 | 11 | 7 | 5 | 5 | 5 | **88** |
| Agents Observe selected primitives | 20 | 18 | 9 | 10 | 7 | 4 | 3 | 5 | **76** |
| Stagewise selected primitives | 22 | 18 | 12 | 11 | 8 | 5 | 5 | 0 | **81** |
| Overstory tailer | 14 | 11 | 3 | 7 | 7 | 0 | 3 | 5 | **50** |
| Tutti control-room primitives | 17 | 13 | 7 | 7 | 7 | 4 | 3 | 5 | **63** |

Scores describe only the inspected P5 subproblem. Session Center's ring can
therefore outscore a broader repository without endorsing its raw WebSocket
surface. Stagewise's zero legal-fit score is an intentional hard stop.

## Per-subproblem winners and rejected alternatives

| Subproblem | Winner | Adopt | Explicitly do not adopt |
| --- | --- | --- | --- |
| Durable truth and restart continuity | RelayForge P1 | SQLite event/projection authority; durable epoch/sequence | New dashboard database, memory-only truth, PTY reconstruction |
| Provider-normalized settlement | RelayForge streaming/normalizer | One accepted frame, typed `NormalizedTurn`, bounded display fanout | Status or authority inferred from text, prompt, spinner or shell state |
| Transcript-only source integrity | AO usage ingestor | Pinned open descriptor, descriptor identity, source generation, byte cursor, checkpoint digest, atomic apply, quiescent partial tail | Path-following after open, cursor-by-size alone, Overstory's advance-before-parse |
| Typed output projection | DoorDash Agentic Orchestrator, narrowed by RelayForge | Indexed typed rows, mutable-tail replacement, metadata-only activity | Raw provider bytes or unrestricted “safe display text” |
| Bounded presentation memory | Session Center | Lazy allocation to hard cap, wrap/oversize/reset/parity tests | Unbounded arrays; treating eviction as durable loss-free history |
| Multi-agent activity UX | TUICommander | Stable row spine, attention buckets, last fact/time, polling coalescing | Reordering on every byte, raw terminal intent/task labels |
| Generation/race fencing | TUICommander + Daintree | Captured session/revision/generation on requests; reject late exit/snapshot | ID-only updates; old response overwrites replacement |
| Backpressure visibility | Daintree | Bounded drop counters, pause/suspend state, coalesced repaint, load-bearing signals | Silent drop, unlimited queues, hiding loss behind “connected” |
| Network delivery | RelayForge P1 | Durable SSE cursor, subscribe-before-head, replay bounds, drain timeout, snapshot/refetch | TUICommander/Agents Observe live-only streams; DoorDash memory-only replay |
| Duplicate external observations | Agents Observe | Canonical content signature plus database uniqueness/race test, only where upstream lacks stable identity | Five-second buckets as identity for RelayForge's own durable events |
| Terminal rendering exploration | Stagewise, `IDEA_ONLY` | Independently consider headless rendering only for an explicit local attach tool | Browser exposure, OSC as trust, AGPL code/tests/structure |

## Source evidence and conclusions

### AO: the strongest transcript-only ingestion primitive

AO persists a versioned usage-source context, opens the file and derives
identity from the descriptor, not merely its path. Identity changes, shrink,
missing pre-cursor checkpoint or digest mismatch replace the source generation.
It rechecks descriptor identity, size, modification state and cursor digest
after reading; a concurrent rewrite is not committed as if it were stable.

Parsing is bounded (8 MiB chunk, 1 MiB record in the audited source). An
incomplete tail remains pending without advancing the committed cursor. A
valid unterminated final object is accepted only after quiescence; a malformed
tail is classified only after two quiet observations. Oversized records enter a
bounded discard path. Cursor/parser state and emitted events commit atomically,
with bounded conflict retry.

The integration suite exercises parser-state persistence, invalid-state
non-advance, replacement across clocks, same-descriptor mutation, post-read
rewrite, retirement, same-inode pre-cursor rewrite, watcher discovery/rebuild,
late sources, restart/finalization, quiescent final tails, late append and
conflicting events. This is materially safer than “read from last size.”

RelayForge should port the state machine independently around its own event
store and normalized schema. The raw source is internal evidence and must be
discarded after normalization/redaction. AO issue #3309 reinforces that live
terminal rendering is fragile; it does not weaken the ingestion primitive.

### Session Center: a small, well-tested memory primitive

Both server and Electron copies of `ptyRing` start with a 64 KiB slab, double
until a fixed capacity, avoid wrapping before reaching that capacity, retain
the tail of a single oversized chunk, append in O(1), and produce a linear
snapshot. One shared test suite verifies allocation, exact-boundary growth,
wrap, huge chunks, reset and cross-copy parity.

RelayForge should use this behavior for a cache of already-sanitized encoded
records. It must add item count as well as byte count, track
`firstAvailableSeq`, `lastSeq`, `truncated` and cumulative drop count, and be
rebuildable from SQLite. Raw PTY usage in the reference is not adopted.

### TUICommander and Daintree: operator truth under races and load

TUICommander's poller serializes/coalesces polls and captures session ID plus
shell-state revision. A missing-session snapshot marks exit only if the same
generation is still current; older snapshots cannot overwrite newer PTY state.
Its activity dashboard keeps a stable visual spine and moves entries primarily
between attention groups rather than on every activity tick. The command block
array is capped and `lastDataAt` updates are batched.

Its Rust SSE route is live `broadcast`: IDs are assigned at delivery, lag is a
message rather than durable replay, and there is no `Last-Event-ID` recovery.
Payload fields also include terminal/path material. RelayForge keeps none of
that transport or schema.

Daintree gives each reused terminal identifier a launch generation. Host crash
and respawn create a new generation; late old exits and input replays are
rejected. Backpressure is explicit: per-terminal and total pending limits,
pause/suspend state, deduplicated status, bounded drop tallies and tests for
cleanup races and disabled metrics. Its panel buffer coalesces one frame of
high-rate activity while timestamp and exit guards prevent stale revival.

These are good UX and race primitives, but Daintree's terminal-analysis stack is
large and heuristical. RelayForge uses parent events to decide state; terminal
temperature may at most animate a non-authoritative “recent output” indicator.

### DoorDash: strong indexed records, weaker durability boundary

The late-discovered DoorDash source is the best challenger to the chosen output
shape. Its SSE assigns epoch/sequence IDs, keeps a 4,096-event memory ring,
handles `Last-Event-ID`, bounds per-subscriber FIFO/coalescing, sets a write
deadline, heartbeats, throttles output activity, and tests the
snapshot/subscribe race. Its output endpoint maps transcript elements into
typed row-indexed messages and deliberately re-emits the current tail row
because a partial can become final without increasing length.

RelayForge should adopt typed index/replacement semantics and metadata-only
activity. It should not adopt memory-only replay or unrestricted assistant
display prose. P1's SQLite replay, cursor expiry and strict public allowlist are
stronger and remain authoritative.

### Agents Observe: narrow dedup value, transport rejection

Agents Observe canonicalizes nested key order and hashes event envelopes with a
time bucket. Admission checks for duplicates and also handles the database
unique-index race; duplicates are neither rebroadcast nor re-evaluated for
flags. Its tests cover reordered payloads and concurrent ingestion.

Its WebSocket registry is live only, with no replay cursor, bounded retained
history or demonstrated slow-sender policy. The transcript stats path reparses
whole files and skips malformed partials. Historical issue #22 documented an
unauthenticated `0.0.0.0` exposure; current source defaults to loopback and has
origin tests, but RelayForge's reject-credentials/Host/Origin model is stronger.

Use content signatures only for observations that truly arrive without a
stable upstream identity. RelayForge events already have epoch/sequence IDs and
must not be time-bucket deduplicated.

### Stagewise, Overstory and Tutti

Stagewise uses a headless xterm model, bounded scrollback/output buffers,
dirty-only snapshots and trusted-token OSC regions. Its own parser comments and
tests recognize that terminal controls can be forged; it validates sensitive
context against parent process evidence. This supports RelayForge's decision to
keep raw terminal content outside the control room. AGPL-3.0 makes all Stagewise
implementation and test material `IDEA_ONLY`.

Overstory records the observed file size as its cursor before line parsing,
skips malformed/partial lines and swallows read errors. Rotation, truncation and
same-inode rewrite are not recovered. Its archive status compounds, but does not
cause, the rejection.

Tutti polls raw tmux output and contains runtime status inference based on
terminal patterns. Its SSE cursor is timestamp-oriented. It offers no advantage
over RelayForge's normalized provider stream, generation facts or durable
cursor, so those primitives are rejected.

## Chosen design

### Best implementation discovered

The best design is a synthesis: RelayForge P1 for durable authority and
metadata-only SSE; Agent Orchestrator for transcript source integrity; Session
Center for the bounded presentation ring; TUICommander and Daintree for stable
activity UX, generation fencing, and pressure visibility; DoorDash for typed
indexed records; and Agents Observe for narrow duplicate characterization.

### Why

No external reference preserves all required properties. AO has the strongest
ingestor but a broader observation plane; Session Center's ring is raw and
non-durable; TUICommander/Daintree infer too much from terminals; DoorDash
replay is memory-oriented; and Agents Observe lacks robust source generations.
RelayForge's existing store/SSE/privacy boundary is therefore the required
authority into which the selected primitives must be adapted.

### What RelayForge will reuse

Only `ARCHITECTURAL_INSPIRATION` for pinned-source ingestion, typed row
projection, fixed-capacity rings, generation-fenced client updates, stable
activity layout, pressure/drop visibility, and duplicate race tests;
`IDEA_ONLY` from Stagewise. Overstory and Tutti primitives are `NOT_USED`.
No code, tests, schemas, comments, or distinctive structure are copied.

### What RelayForge will change

All records use a closed normalized schema and canonical P1 transaction;
source cursor/parser/generation commits atomically with accepted records; SSE
carries metadata only; presentation memory is rebuildable; clients show
freshness/degradation; and raw paths, prompts, transcripts, terminal bytes,
commands, arbitrary prose, and provider JSON never cross the public boundary.

### How RelayForge will improve it

RelayForge adds durable source-generation recovery for rotation/truncation/
replacement, exact generation and head fencing, bounded public query bytes,
privacy-safe control-room reuse across terminal/browser clients, explicit loss
and stale state, restart-safe ingestion, and the rule that observation can
describe progress but can never establish lifecycle or settlement authority.

### Authority and data flow

```text
provider structured stream ──► RawFramer ──► provider normalizer ──► NormalizedTurn
                                      │
                                      └──► bounded local display tail (never authority)

transcript-only provider ──► pinned source-generation ingestor ──► normalized records

parent/runtime/steering/SCM/artifact facts ───────────────────────► P1 transaction
                                                                    │
                                               durable event + projection + observation
                                                                    │
                       GET snapshot/page ◄── P1 read model ──► metadata-only SSE wakeup
```

An observation can describe progress but cannot settle the task. Settlement
still requires the existing normalized terminal/final result and parent-owned
artifact/verification facts. The browser is a read-only projection consumer.

### Internal normalized record

The implementation packet should define a closed `ObservationRecordV1` with:

- `schemaVersion: 1`, `runEpoch`, durable `seq`, `recordId`;
- `runId`, optional `taskId`, `agentId`, `runtimeGeneration`,
  `attemptGeneration`, `sourceGeneration`;
- `observedAt`, `recordedAt`, `category`, `phase`, `severity`, stable `code`;
- a category-specific closed `details` union containing only bounded scalars,
  enums, counts and approved identifiers;
- `sourceIntegrity` (`live`, `quiescent_final`, `recovered`, `replaced`,
  `degraded`, `unknown`) and optional loss counters;
- an optional, parent-authored, redacted and byte-capped `summary`.

Forbidden even internally after the normalization boundary: absolute or
relative transcript paths, cwd, tmux/socket/pane/session-native identifiers,
environment values, command arguments, prompts, raw final answer, raw tool
input/output, arbitrary provider JSON and terminal bytes. If investigation
requires those materials, an explicit local attach workflow remains outside
the HTTP control plane and cannot update authority.

### Public DTO and endpoint behavior

`ObservationPageV1` is a closed page containing records, `snapshotSeq`,
`firstAvailableSeq`, `nextAfter`, `truncated`, `droppedRecords`, projection
freshness and source-health summaries. It accepts an epoch-qualified cursor and
bounded `limit`; malformed, future, wrong-epoch and expired cursors use the P1
error vocabulary. JSON encoding is capped by encoded UTF-8 bytes, not character
count. `HEAD` performs the same authentication/validation/cap path without a
body.

SSE never carries records. A committed observation emits the existing
metadata-only `control.changed` notification. On reconnect, the client first
subscribes, obtains/revalidates the current head, then fetches the snapshot or
page. Replay expiry, restart or local cache loss triggers a bounded resnapshot.

### Presentation cache and UI

The cache is lazy and capped by both encoded bytes and item count. One oversized
record is never retained beyond its already-enforced DTO cap. Eviction drops
oldest records and sets explicit loss metadata; the cache can always be rebuilt
from the durable read model. Cache state does not affect task state.

The control room keeps stable run/agent rows. Attention buckets are driven by
the seven parent-projected activity states (`idle`, `waiting_input`,
`dispatching`, `active`, `settling`, `blocked`, `exited`) and exact P2/SCM/
verification facts. Each row shows last fact and timestamp, generation/source
health, staleness, queue/steering state, output truncation and backpressure.
Recent output can change a pulse, never the authoritative label.

## Architecture consistency gate

Every P5 implementation PR must answer **yes** to all gates:

| Gate | Required proof | Automatic rejection |
| --- | --- | --- |
| One authority | Observation commit and projection share the P1 SQLite transaction/event sequence | Separate dashboard DB, browser truth, memory-only lifecycle |
| Normalized authority | Settlement remains `NormalizedTurn` plus parent-owned facts | Regex/terminal/LLM prose changes task state |
| Generation safety | Update key carries run epoch and applicable runtime/attempt/source generations; stale writes are tested | ID-only update or late exit revives replacement |
| Network boundary | Existing loopback Host/Origin, GET/HEAD, credential rejection and body/header caps are reused | WebSocket/raw PTY/new unauthenticated listener/browser mutation |
| Durable streaming | Existing metadata-only SSE and resnapshot contract are reused | Observation payload in SSE, timestamp cursor, live-only broadcast |
| Schema/privacy | Closed v1 allowlist, write-time redaction, UTF-8 caps and forbidden-field tests | Generic JSON, paths, prompts, terminal bytes or command args |
| Truthful degradation | Unknown/stale/replaced/truncated/dropped/unreadable are distinct and visible | Empty list or “connected” masks loss |
| Ownership | P5 leaf files are exclusive; P1 integration is performed later by the single integration owner | Parallel edits to current P1 control/dashboard files |
| Legal | Each borrowed implementation is recorded with license/NOTICE; Stagewise stays idea-only | Copied AGPL material or unrecorded notice-bearing code |

P3/P4 SCM, accounting, policy and adapter facts may be projected only from their
durable owning events as those phases land. P5 must not recreate their clients,
pollers or truth tables.

## Failure, recovery and adversarial matrix

| Scenario | Required behavior | Recovery / visible evidence | Mandatory test |
| --- | --- | --- | --- |
| Append ends mid-record | Do not advance committed cursor past complete boundary | `sourceIntegrity=live`, pending bytes bounded | append remainder produces exactly one record |
| Valid final record lacks newline | Accept only after configured quiescence | `quiescent_final` with observation count | active append is not prematurely finalized |
| Malformed stable tail | Wait two quiet observations, then classify/drop bounded record | degraded code and byte/count loss, cursor advances deliberately | malformed vs later-completed tail |
| Rotate/path replacement | Keep old pinned descriptor stable; discover new identity as new generation | `replaced`, generation increment | rename/create and old-FD late read |
| Truncate or same-inode rewrite | Check size plus pre-cursor digest/identity | replace source generation, never splice histories | clocks unchanged and pre-cursor rewrite |
| File mutates during read | Post-read verification rejects commit | bounded retry; no duplicate event | mutation after read and after verification window |
| Watcher duplicate/miss/rebuild | Discovery is only a hint; coordinator reconciliation is idempotent | rescan metric and no duplicate source | watcher restart, symlink root, late source |
| Crash between parse and cursor update | Event(s), parser state and cursor commit atomically | restart replays or observes all-or-none | injected transaction failure |
| Parser schema/version drift | Reject unknown persisted parser state without cursor advance | explicit incompatible-source health | upgrade/downgrade state fixture |
| Record/chunk exceeds cap | Bounded discard without memory growth | dropped byte/record counters | huge single record and Unicode byte boundary |
| Secret/path/raw prompt sentinel | Reject or redact before durable/public write | redaction counter; sentinel absent from DB/JSON/SSE | nested/encoded/adversarial key corpus |
| Duplicate external event | Stable ID or canonical signature plus unique constraint | one durable record/notification | reordered keys and concurrent insert |
| Out-of-order/stale generation | Reject update before projection | stale-generation metric | late snapshot, late output, late exit |
| Cache wraps | Drop oldest whole records only | first available, last, truncated and count exact | exact boundary and multiple wraps |
| Single item larger than cache | DTO cap rejects it before cache append | explicit oversize error/drop | huge item never causes over-cap allocation |
| High-rate activity | Coalesce paints/metadata notifications, not durable facts needed for correctness | last durable seq and coalesced-count metric | reentrant update and frame burst |
| Slow SSE subscriber | Enforce replay/frame/subscriber/drain caps | disconnect/resync using P1 reason code | stalled socket and shutdown deadline |
| SSE cursor expired/future/wrong epoch | Reject/resync exactly per P1 contract | full bounded snapshot/page | restart and compaction boundaries |
| Subscribe/snapshot race | Subscribe before validating/fetching current head | no missed committed sequence | commit between subscribe and snapshot |
| Projection head lags event head | State remains explicitly stale | head tuple and retry guidance | lag injected at every endpoint |
| Store/source temporarily unavailable | Preserve last known fact but mark stale/degraded | retry with bounded backoff; health record | permission/read error then recovery |
| Terminal prints fake success/wait/input | Display bytes never change authority | parent state unchanged | adversarial escape/prose fixtures |
| No output yet / provider unsupported | Unknown is not idle or successful | capability/source state shown | absent channel vs valid empty channel |
| Browser refresh/cache loss | Rebuild from durable page | stable ordering and exact truncation | reload at each cursor boundary |
| Read response exceeds cap | Fail closed before writing partial JSON | P1 typed cap error; `HEAD` parity | multibyte and boundary cases |

## Meaningful improvement over current RelayForge

This design is not a cosmetic rewrite. It adds:

1. a typed, provider-neutral observation timeline instead of raw terminal tail;
2. restart-safe transcript ingestion with source identity and generation health;
3. bounded memory with operator-visible loss rather than silent eviction;
4. stable multi-agent attention grouping with race-fenced snapshots;
5. indexed partial-to-final replacement without exposing model prose;
6. explicit source, projection, cursor and subscriber degradation states;
7. durable historical continuity through the existing P1 store and SSE;
8. backpressure/drop telemetry that remains visible under load;
9. a single privacy allowlist shared by CLI and web renderers;
10. removal of terminal text from lifecycle, steering and settlement authority.

## File-exclusive implementation packets

These packets are intentionally leaf-first. No P5 worker may edit the in-flight
P1 integration set: `src/control/{protocol,events,reducer,views,server,sse}.ts`,
`src/control/index.ts`, `src/dashboard/render.ts`, `src/monitor.ts`, or their
existing control/dashboard tests. Central integration is deferred to the one
P1/P5 integration owner after ownership is released.

### P5-A — normalized schema and public allowlist

Exclusive files:

- `src/observability/types.ts`
- `src/observability/public.ts`
- `tests/observability-types.test.ts`
- `tests/observability-public.test.ts`

Deliver closed v1 internal/public unions, exact generation tuple, enum/code
vocabularies, byte caps, redaction, forbidden-key recursion and compile/runtime
exhaustiveness. Fixtures must prove that paths, tmux/native IDs, prompts,
commands, environment, arbitrary JSON and raw text do not serialize.

### P5-B — transcript source-generation ingestor

Exclusive files:

- `src/observability/source-context.ts`
- `src/observability/transcript-ingestor.ts`
- `tests/observability-transcript-ingestor.test.ts`
- `tests/fixtures/observability-transcripts/`

Deliver descriptor-pinned identity, monotonic source generation, byte cursor,
checkpoint digest, versioned parser state, bounded chunk/record/discard,
post-read verification, quiescent finalization and a transaction callback that
atomically applies normalized records plus source state. The callback interface
must not import P1 concrete store code.

### P5-C — bounded sanitized presentation ring

Exclusive files:

- `src/observability/presentation-ring.ts`
- `tests/observability-presentation-ring.test.ts`

Deliver lazy allocation, item+byte limits, whole-record eviction, huge-input
handling, UTF-8 accounting, snapshot/reset, loss metadata and property/fuzz-like
boundary tests. Accept `PublicObservationV1`, never `Buffer` from a PTY.

### P5-D — pure control-room projection/query

Exclusive files:

- `src/control-room/projection.ts`
- `src/control-room/query.ts`
- `tests/control-room-projection.test.ts`
- `tests/control-room-query.test.ts`

Deliver pure reduction of already-owned facts into stable rows and bounded
observation pages. Prove generation rejection, deterministic ordering, partial
tail replacement, unknown/stale/loss states and page cursor boundaries. No DB,
network, tmux or provider imports.

### P5-E — read-only client and stable view model

Exclusive files:

- `src/control-room/client.ts`
- `src/control-room/view-model.ts`
- `src/control-room/render.ts`
- `tests/control-room-client.test.ts`
- `tests/control-room-view-model.test.ts`
- `tests/control-room-render.test.ts`

Deliver strict response parsing, subscribe-before-head/refetch behavior, epoch
and generation fences, degraded polling, stable row spine/attention buckets,
and accessible text for unknown, stale, replaced, truncated and dropped states.
No browser mutation, raw HTML injection, terminal emulator or EventSource
payload authority.

### P5-F — terminal/CLI renderer over the same public model

Exclusive files:

- `src/control-room/terminal-view.ts`
- `tests/control-room-terminal-view.test.ts`

Deliver a non-interactive renderer of `ControlRoomViewModelV1`, fixed width/
height and Unicode-safe caps, deterministic snapshots, and parity of degraded
states with the browser. It must not call tmux capture methods or parse terminal
output.

### P5-G — deferred single-owner integration

Only after P1 ownership releases, one integration owner may amend central
protocol/event/reducer/view/server/dashboard registration and their tests. That
change must:

- register observation events and projection in the existing P1 transaction;
- add the closed paginated GET/HEAD route under existing guards/caps;
- publish only existing metadata-only `control.changed` notifications;
- replace diagnostic/raw-tail rendering with the shared public model;
- run all P1/P2/P5 suites plus privacy sentinel, restart and adversarial cases;
- update this audit and the upstream ledger if any actual code is borrowed.

This packet is non-parallel by design. It owns every overlapping central file
for its merge window; no leaf worker may “help” by pre-editing those files.

## Acceptance evidence for implementation

P5 is complete only when the eventual implementation demonstrates:

- deterministic rebuild after process restart and source replacement;
- no lost/misclassified partial transcript at all matrix boundaries;
- no stale generation can update a live row;
- byte/item/record/replay/subscriber/response caps under adversarial load;
- raw privacy sentinels absent from durable records, GET/HEAD, SSE and renderers;
- SSE disconnect/replay/resnapshot parity with P1;
- browser and terminal render the same parent-owned states;
- no product path acquires a second state authority or write endpoint;
- all reused code, if any, has a specific license/notice diff entry.

## Audit validation record

All nine external pins and 75 cited local source/test/license/NOTICE paths were
checked with Git object lookup against the named clones. The source study
included the actual test files and license/NOTICE files listed above. GitHub
push, issue/PR and archive state was checked on 2026-08-09. The documentation
change is subject to `git diff --check` and an owned-file-only status/diff audit
before handoff; no product source is part of this P5 research packet.
