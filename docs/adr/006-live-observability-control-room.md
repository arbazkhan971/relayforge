# ADR 006: Durable normalized live observability

- Status: Accepted and implemented (P5 focused 125/125) — see [implementation-status.md](../implementation-status.md)
- Date: 2026-08-09
- Owners: RelayForge control-plane and observability maintainers
- Supersedes: raw terminal-tail concepts in the legacy dashboard/monitor only;
  it does not supersede ADR 002 or ADR 003
- Evidence: [Phase 05 reference audit](../reference/phase-05-live-observability-audit.md)

## Context

Operators need to see what many agents are doing, which agents need attention,
whether observations are current and whether output was lost. RelayForge already
has two very different data paths:

- P1 supplies durable events/projections, epoch/sequence cursors, guarded
  loopback GET/HEAD endpoints and replayable metadata-only SSE.
- Provider streaming supplies bounded display data and authoritative normalized
  turns; only the normalized result can settle a task.

Legacy terminal capture is unsuitable as a control-room contract. It can expose
prompts, source paths, commands, tool output, secrets and terminal identifiers.
It is ephemeral, difficult to recover across process/file replacement, and can
be forged by the child. Inferring “waiting,” “success” or “complete” from
terminal prose would conflict with parent-owned P1/P2 state.

The reference audit found no single upstream with the complete answer. AO has
the strongest incremental transcript source-integrity state machine. Session
Center has the strongest focused lazy bounded ring. TUICommander and Daintree
have strong operator-layout, generation-fence and pressure behaviors. DoorDash
Agentic Orchestrator has strong typed/indexed output rows. RelayForge already has
the stronger durable transport, privacy boundary and settlement authority.

## Decision

RelayForge implements a durable, normalized observation timeline as a P1
projection and renders a read-only control room from its closed public DTO.

### Authority

Only parent/runtime events and provider-normalized structured records may create
observations. Observations describe progress; they do not settle work.
`NormalizedTurn`, parent-owned verification/artifact facts and the existing
lifecycle reducer remain authoritative.

Terminal text, raw transcript material, prompts, model answers, commands and
tool output cannot change task, steering, verification, cost or settlement
state. An explicit local terminal attach is outside the HTTP API and remains
non-authoritative.

### Transcript-only providers

Where no live structured provider stream exists, an internal adapter may tail a
transcript using an AO-style state machine:

- pin an open descriptor and derive identity from it;
- persist source generation, byte cursor, pre-cursor checkpoint digest and
  versioned parser state;
- verify identity/content before and after each bounded read;
- replace the generation on identity change, shrink or checkpoint mismatch;
- retain incomplete tails without cursor advance;
- classify valid unterminated finals and malformed tails only after defined
  quiescent observations;
- atomically commit normalized records, cursor and parser state.

The adapter discards raw material at the normalization/redaction boundary.
Paths and provider-native/terminal identities never enter public DTOs.

### Record and page contract

`ObservationRecordV1` is a closed union with durable `(runEpoch, seq)`, approved
RelayForge identifiers, applicable runtime/attempt/source generations,
timestamps, category/phase/severity/code, bounded scalar details,
source-integrity state, loss counters and an optional byte-capped parent-authored
summary.

`ObservationPageV1` includes bounded records, `snapshotSeq`,
`firstAvailableSeq`, `nextAfter`, `truncated`, `droppedRecords`, projection
freshness and source health. Cursors are epoch-qualified. Future, malformed,
wrong-epoch and expired cursors reuse P1 errors. Limits use encoded UTF-8 bytes.
`HEAD` shares GET's validation and cap path.

The schema explicitly excludes transcript/cwd paths, tmux/socket/pane/native
session identifiers, environment values, command arguments, prompts, raw
answer/tool content, terminal bytes and arbitrary provider JSON.

### Cache and delivery

A lazy sanitized presentation ring is capped by both item count and encoded
bytes. It evicts oldest whole records and exposes first/last sequence,
truncation and dropped-record counts. It is a rebuildable performance cache,
never a source of truth.

P1 SSE remains the only browser notification transport. It carries only the
existing change metadata. The client subscribes before head/snapshot
validation, then fetches strict observation pages. Expiry, restart or cache loss
causes a bounded resnapshot. P5 adds no WebSocket, raw stream or browser write
endpoint.

### Operator experience

The control room keeps a stable run/agent spine and uses parent-projected
activity states for attention groups. Each row shows last structured fact and
time, applicable generations, source/projection freshness, steering/verification
state and explicit truncation/backpressure. High-rate updates may be paint- or
notification-coalesced, but correctness-relevant durable facts are not dropped.
Recent output may animate a pulse but cannot determine the row's authoritative
status.

“No output,” “unsupported,” “unknown,” “stale,” “source replaced,” “truncated,”
“dropped” and “unreadable” are separate states. The UI never converts missing
evidence into idle or success.

### Legal boundary

- AO, TUICommander and Daintree are Apache-2.0
  `ARCHITECTURAL_INSPIRATION`; actual copied code requires reclassification,
  recorded attribution and any applicable NOTICE handling.
- DoorDash Agentic Orchestrator is Apache-2.0 with NOTICE and is
  `ARCHITECTURAL_INSPIRATION`; copying requires reclassification plus license
  and notice compliance.
- Session Center and Agents Observe are MIT `ARCHITECTURAL_INSPIRATION`;
  copied portions require reclassification and preservation of their license
  notice.
- Stagewise is AGPL-3.0 and `IDEA_ONLY`: no code, tests, comments, generated
  structures or distinctive arrangement may be copied.
- Overstory's tailer and Tutti's terminal-derived authority are `NOT_USED` even
  though their licenses would otherwise permit reuse.

All RelayForge implementation should be independently written. The eventual
implementation PR must update the upstream ledger if actual reuse differs from
this decision.

## Architecture gate

P5 code may merge only if it proves:

1. P1 SQLite/event sequence is the sole durable authority.
2. Settlement and lifecycle remain normalized/parent-owned.
3. Epoch plus every applicable generation fences updates and late exits.
4. Existing loopback Host/Origin, credential rejection, GET/HEAD and byte caps
   guard every new route.
5. SSE remains durable, metadata-only and resnapshot-based.
6. Public and durable schemas are closed, write-redacted and forbidden-field
   tested.
7. Loss, replacement, staleness and unknown states are observable.
8. P3/P4 facts are consumed from their owners rather than re-polled or
   re-derived.
9. File ownership prevents parallel P5 edits to active P1 integration files.
10. Actual code reuse has license/NOTICE evidence; Stagewise remains idea-only.

## Consequences

Positive consequences:

- the control room survives daemon/browser restart and transcript rotation;
- every view has a durable cursor and truthful freshness/loss state;
- browser and terminal views can share one privacy-reviewed read model;
- provider-specific streams normalize into one typed timeline;
- high-rate activity stays bounded without becoming false authority;
- legacy raw terminal capture can be removed from web observability.

Costs and limitations:

- transcript-only adapters need provider-specific parsers and a careful
  descriptor/checkpoint state machine;
- source-generation and partial-tail recovery add state and adversarial tests;
- strict summaries show less detail than a terminal mirror by design;
- deep debugging still requires an explicit local attach or provider-native
  tooling outside the web control plane;
- a later single-owner integration change is required after active P1 file
  ownership is released.

## Alternatives rejected

### Stream raw PTY/transcript output to the browser

Rejected because it leaks sensitive material, cannot establish authority,
creates unbounded/backpressure risk and is not reliably restartable.

### Infer lifecycle from terminal patterns

Rejected because child-controlled output can forge states and conflicts with
P1/P2 parent-owned facts. TUICommander, Daintree and Tutti demonstrate useful
UI heuristics, not an acceptable RelayForge authority boundary.

### Add a live-only WebSocket/SSE service

Rejected because TUICommander and Agents Observe cannot recover missed history,
and DoorDash's replay remains process-memory-bound. RelayForge P1 already has a
durable epoch/sequence channel with explicit resnapshot.

### Use a byte ring as truth

Rejected because eviction is expected. The Session Center primitive is adopted
only as a sanitized cache over durable storage.

### Follow file size as a transcript cursor

Rejected because rotation, truncation, same-inode rewrite, partial records and
read/commit races lose or splice observations. Overstory is the negative case;
AO's descriptor/generation/checkpoint model is selected.

### Copy Stagewise's headless terminal implementation

Rejected on both architecture and legal grounds. Raw terminal rendering is not
the public contract, and Stagewise is AGPL-3.0. Only independently derived
high-level bounding lessons may be considered.

## Implementation ownership

P5 starts in new leaf files under `src/observability/` and `src/control-room/`
with new tests. Current P1 protocol/event/reducer/view/server/SSE/dashboard and
legacy monitor files remain untouched by parallel P5 work. After those owners
release them, one integration owner will register the projection and GET/HEAD
page, connect metadata-only invalidation, replace raw-tail render paths and run
the combined restart, privacy, cursor and adversarial suites.
