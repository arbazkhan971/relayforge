# Phase 05 live observability and control-room audit

Audited 2026-08-09. This is a source-and-test audit, not a README comparison.
Every external reference is pinned to an immutable commit. The detailed
implementation packet is in the workflow audit; this document records the
public decision and evidence.

**Implementation status (handoff):** P5 implemented (focused 125/125). The
exact packed candidate also passed the real Chrome connected → degraded →
recovered lifecycle. See [implementation-status.md](../implementation-status.md).

## Chosen design

RelayForge exposes a bounded timeline of structured, normalized facts over the
P1 durable read model. It does not expose raw transcripts, tmux or PTY output,
paths, prompts, command arguments, tool content or arbitrary model prose.
Terminal text cannot establish task, steering, verification or settlement
authority.

The selected design combines:

- RelayForge's existing SQLite event/projection authority, epoch/sequence
  cursors, loopback HTTP guards, strict DTOs, redaction and durable
  metadata-only SSE;
- AO's descriptor-pinned incremental transcript ingestion, source generations,
  checkpoint verification and quiescent partial-tail handling for providers
  that lack a structured live stream;
- AI Agent Session Center's lazy fixed-capacity ring, adapted to cache only
  sanitized public records and to report eviction;
- TUICommander's stable activity layout and request-generation fences;
- Daintree's late-exit generation fencing, coalescing and explicit
  backpressure/drop visibility;
- DoorDash Agentic Orchestrator's typed, indexed, replaceable output rows,
  narrowed to RelayForge's parent-authored allowlist.

Stagewise informed headless-terminal and bounding analysis but is AGPL-3.0 and
therefore `IDEA_ONLY`. Overstory's tailer and Tutti's terminal-derived state are
rejected.

## Reference matrix

| Reference | Pin / activity | Source and tests inspected | License and legal class | Decision |
| --- | --- | --- | --- | --- |
| RelayForge | `73051d510c6473fa763bc7cd81921f65bec00eea` plus active P1 tree | control protocol/events/reducer/views/server/SSE, dashboard renderer, streaming/normalizer and corresponding tests | MIT; project authority | Keep P1 transport/store and structured settlement |
| [Untrivial AO](https://github.com/Untrivial-ai/agent-orchestrator) | `f65c48e296e20a816221a4003c75a5f0387967ec`, 2026-08-09 | [`ingestor.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/observe/usage/ingestor.go), coordinator/watcher/parser and integration/unit tests | Apache-2.0; `ARCHITECTURAL_INSPIRATION` | Winner: transcript source integrity |
| [DoorDash Agentic Orchestrator](https://github.com/doordash-oss/agentic-orchestrator) | `101ca9a416371c4d9db0935cf4aef73f77551366`, 2026-08-09 | `internal/server/sse.go`, `session_model.go`, SSE/output/read-contract tests | Apache-2.0 plus NOTICE; `ARCHITECTURAL_INSPIRATION` | Winner: typed/indexed output shape; do not use memory replay as authority |
| [TUICommander](https://github.com/sstraus/tuicommander) | `ce097a40de6c3624b84b475b23be1bb95624bd7c`, 2026-08-06 | `useAgentPolling.ts`, terminal store, ActivityDashboard, Rust SSE; poll/cap/activity tests | Apache-2.0; `ARCHITECTURAL_INSPIRATION` | Winner: stable operator UX and client generation fences |
| [AI Agent Session Center](https://github.com/coding-by-feng/ai-agent-session-center) | `ff8e4b2122aff58db12b662060f2939d7fa2f8a3`, 2026-08-03 | server/Electron `ptyRing.ts`, consumers and shared parity suite | MIT; `ARCHITECTURAL_INSPIRATION` | Winner: bounded lazy presentation ring |
| [Daintree](https://github.com/daintreehq/daintree) | `a5c2dae192f18378e80b97d378f6015f8eda45d7`, 2026-08-09 | lifecycle ledger, PTY backpressure, panel status buffer, activity FSM and adversarial/property tests | Apache-2.0 plus NOTICE/trademark terms; `ARCHITECTURAL_INSPIRATION` | Winner: lifecycle race and load visibility concepts |
| [Agents Observe](https://github.com/simple10/agents-observe) | `bb2f6c382cafb4d8111fc3137bab376b3aee11ed`, 2026-07-21 | event signature/admission, SQLite, WebSocket/CORS, transcript parser and tests | MIT; `ARCHITECTURAL_INSPIRATION` | Use narrow dedup idea; reject live-only WebSocket/full-file parsing |
| [Stagewise](https://github.com/stagewise-io/stagewise) | `104d1c27376bc37e6b93adfc3617254358346823`, 2026-08-07 | agent-shell logger/service/session manager/OSC parser and tests | AGPL-3.0; `IDEA_ONLY` | No code, tests, comments or structure copied |
| [Overstory](https://github.com/jayminwest/overstory) | `ff38f3f76f084abcc34f519bcaa69580f6e53cf1`, 2026-05-28; archived | event tailer/store and tests | MIT; `NOT_USED` | Advances before parsing and loses partial/error evidence |
| [Tutti](https://github.com/nutthouse/tutti) | `6b86cca7457364888032e6ff9c04f2a87fc14cb2`, 2026-07-20 | serve/dashboard/runtime/tmux sources | MIT; `NOT_USED` | Raw terminal polling and output-pattern authority are weaker |

Repository history, current activity, issue/PR surfaces and licenses were
checked on the audit date. Relevant histories included [AO PR
#3709](https://github.com/Untrivial-ai/agent-orchestrator/pull/3709), [AO issue
#3309](https://github.com/Untrivial-ai/agent-orchestrator/issues/3309) and
[Agents Observe issue #22](https://github.com/simple10/agents-observe/issues/22).
The exact open issue/PR counts observed were AO 340/261, DoorDash 3/12,
TUICommander 1/0, Session Center 2/0, Daintree 9/2, Agents Observe 2/2,
Stagewise 17/16, Overstory 16/8 and Tutti 14/4. Overstory was the only archived
repository. Counts are dated activity evidence, not quality evidence.

### Quality scores

P5-fit score weights are correctness 25, tests 20, failure/recovery 15,
architecture fit 15, maintainability 10, current activity 5, performance/bounds
5 and legal clarity 5.

| Reference | Score / 100 | Limiting factor |
| --- | ---: | --- |
| RelayForge P1/stream foundation | 97 | At decision time: P5 output projection not yet implemented (now landed; see handoff tracker) |
| AO usage ingestor | 96 | Needs independent mapping into RelayForge types/store |
| DoorDash Agentic Orchestrator | 94 | Replay is memory-only; public prose is broader than allowed |
| Session Center ring | 88 | Excellent small primitive, but raw-PTY consumers are out of scope |
| Daintree selected primitives | 88 | Large, complex terminal-inference system |
| TUICommander selected primitives | 87 | Live-only SSE and raw/path-rich payloads |
| Stagewise selected primitives | 81 | Hard `IDEA_ONLY` legal boundary |
| Agents Observe selected primitives | 76 | Live-only WebSocket and weaker transcript loop |
| Tutti control-room primitives | 63 | Timestamp/raw-terminal state |
| Overstory tailer | 50 | Partial/error loss and no generation recovery |

## Why the winners won

AO verifies an open descriptor's identity before and after a bounded read. A
replacement, shrink, checkpoint mismatch or same-inode pre-cursor rewrite
creates a new source generation. Cursor, parser state and emitted events commit
atomically. An incomplete tail does not advance the cursor; a final valid
unterminated object requires quiescence and a malformed tail requires two quiet
observations before classification. Tests cover mutation during read, restart,
rotation, watcher rebuild, late append, parser-version failure and conflicts.

Session Center's ring starts small, grows to a hard cap, wraps only after
capacity, retains the tail of a huge append, and uses one suite against both
copies. RelayForge adds item limits, encoded-byte accounting, sequence range,
`truncated` and dropped-record counts. The ring is rebuildable cache, not truth.

TUICommander serializes polls and captures session/revision so an old response
or missing-session snapshot cannot overwrite a replacement. Its stable activity
spine is better operator UX than constant byte-driven reordering. Daintree adds
launch-generation fencing for late exit, bounded drop tallies, pressure state
and frame-coalesced updates. RelayForge uses those lifecycle ideas without their
terminal heuristics.

DoorDash proves the usefulness of typed row indices and re-emitting a mutable
tail row when partial output becomes final. Its bounded/coalesced SSE is good,
but remains in memory. RelayForge keeps P1's durable cursor and sends only a
change notification; clients fetch strict observation pages.

## Public contract

The internal `ObservationRecordV1` is keyed by durable `(runEpoch, seq)` plus
run/task/agent identity and applicable runtime, attempt and source generations.
It contains closed category/phase/severity/code unions, timestamps,
source-integrity state, bounded counts, and at most a parent-authored redacted
summary.

The public `ObservationPageV1` contains a bounded record page,
`snapshotSeq`, `firstAvailableSeq`, `nextAfter`, `truncated`, `droppedRecords`,
projection freshness and source-health summaries. Wrong-epoch, future, malformed
and expired cursors use the P1 error vocabulary. Response limits count encoded
UTF-8 bytes. `HEAD` follows the same validation/cap path.

Forbidden fields include transcript/cwd paths, terminal/tmux/socket/native
session IDs, environment, command arguments, prompts, raw answers, tool
input/output, arbitrary provider JSON and terminal bytes. An explicit local
attach tool may exist outside the web API, but it cannot provide authority.

SSE remains `control.changed` metadata. The browser subscribes before
head/snapshot validation, then fetches the page. Replay expiry, daemon restart
or local cache loss produces a bounded resnapshot.

## Architecture gate

An implementation is rejected if any answer below is “no”:

- Does it commit through P1 SQLite and the same durable event sequence?
- Does only `NormalizedTurn` plus parent-owned facts decide lifecycle and
  settlement?
- Does every update carry and validate applicable generations?
- Does it reuse P1 loopback Host/Origin, credential rejection, GET/HEAD and
  size-limit behavior?
- Does SSE remain durable, epoch-qualified and payload-free?
- Are DTOs closed, redacted at write, UTF-8 byte-capped and tested against
  forbidden fields?
- Are unknown, stale, replaced, truncated, dropped and unreadable distinct?
- Are Stagewise implementation artifacts excluded and all other actual reuse
  recorded with license/NOTICE obligations?
- Are current P1 integration files edited only by the designated integration
  owner after leaf work completes?

P3/P4 SCM, policy, accounting and adapter status enter the view only through
their owning durable events. P5 does not duplicate those pollers or authorities.

## Required adversarial coverage

| Boundary | Required recovery and evidence |
| --- | --- |
| Partial append / final without newline / malformed quiet tail | Preserve pending bytes; quiescent finalization; explicit degraded/drop classification |
| Rename, truncate, same-inode rewrite, mutation during read | New source generation or rejected commit; no spliced/duplicate history |
| Watcher miss/rebuild and process restart | Idempotent reconciliation from persisted context |
| Parse succeeds but commit fails | Atomic all-or-none records, parser state and cursor |
| Oversized/multibyte/secret-bearing record | Hard encoded-byte cap; redact/reject before durability; visible loss count |
| Duplicate/concurrent external event | Stable identity or canonical signature plus unique constraint |
| Late snapshot/output/exit | Generation rejection; replacement remains authoritative |
| Ring wrap or huge append | Whole-record oldest eviction; exact range/truncation/drop metadata |
| High event rate / slow subscriber | Coalesced paints/notifications, bounded queues, disconnect/resync |
| Expired/future/wrong-epoch SSE cursor | Typed P1 error followed by bounded snapshot |
| Subscribe/snapshot race | Subscribe first; no missed committed sequence |
| Projection/source/store degradation | Preserve last known record but label stale/degraded and retry boundedly |
| Fake success/wait/prompt in terminal text | No lifecycle or authority change |
| Unsupported or no output channel | Show unknown/unsupported, never idle/success |
| Browser refresh | Deterministic rebuild from durable page |

## Implementation packet boundary

Leaf work is file-exclusive:

1. normalized schema/allowlist in `src/observability/{types,public}.ts` and new
   matching tests;
2. source context/ingestor in
   `src/observability/{source-context,transcript-ingestor}.ts`, new fixtures and
   tests;
3. sanitized ring in `src/observability/presentation-ring.ts` and its tests;
4. pure projections/query in `src/control-room/{projection,query}.ts` and tests;
5. read-only client/view model/renderer in
   `src/control-room/{client,view-model,render}.ts` and tests;
6. terminal renderer in `src/control-room/terminal-view.ts` and tests.

The later single-owner integration packet alone may edit current P1 control
protocol/event/reducer/view/server/SSE/dashboard/monitor files. It registers the
new projection and GET/HEAD page, emits only metadata invalidations, replaces
raw-tail UI, and runs P1/P2/P5 restart/privacy/adversarial suites.

This design improves RelayForge materially: it adds provider-neutral historical
observations, source-generation recovery, explicit loss/backpressure, stable
multi-agent attention UX and restart continuity while removing terminal text
from the authority and public privacy boundary.
