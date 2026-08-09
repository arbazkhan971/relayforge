# P2 durable session-steering reference audit

Date: 2026-08-09

RelayForge pin inspected: `997763e3d5e019b737ab704e69ec11a34c7c3592`

Scope: parent-authored durable steering, pure session activity, queued delivery at dispatch/repair prompt boundaries, refusal for blocked or exited sessions, recovery, and monitor/dashboard presentation. Research/design only: this audit changes no product source, tests, public documentation, dependency manifest, or attribution ledger. It is not a security review.

## Executive decision

RelayForge must not implement session steering as terminal input. A steering instruction is a parent-authored, durable control-plane command that may be **included in one exact future attempt prompt** after the control plane has revalidated the task, session generation, and pure activity state. A successful API call means “admitted durably,” not “sent to an agent.” Inclusion means only that the command ID was transactionally bound to the immutable prompt bytes and hash for a named attempt before launch. RelayForge must never claim that a provider read, understood, or obeyed it.

The current board-message mechanism does not meet that contract. `BoardMessage` has no stable identity, sequence, schema version, session generation, attempt target, lifecycle, or delivery fact. `gatherContext()` selects a timestamp-ordered suffix and can replay the same message on every repair. There is no durable acknowledgement, deterministic boundary capture, idempotency rule, or refusal when a session becomes blocked or exits. The optional tmux integration is correctly display-only and must remain so.

The answer to the mandatory question **“Is there another open-source implementation that does this better?” is yes, by subproblem rather than overall**:

- [OpenCode](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2) has the strongest implementation found for durable input admission and atomic promotion at a provider-turn boundary. Its event-sourced inbox, stable IDs, captured sequence cutoff, atomic prompt projection, recovery, and concurrency tests are the closest match to RelayForge P2.
- [Temporal](https://github.com/temporalio/temporal/tree/023cb7d861b6cc0e139564b2faaf10c106a7f37d) has the strongest mature lifecycle vocabulary: deduplicated admission, workflow-task-boundary handling, acceptance/rejection/completion, and restart behavior. Its admitted Update registry is partly process-local before acceptance, which RelayForge can improve by making every admitted/refused fact durable in the P1 store.
- [Untrivial Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec) has the best coding-agent activity and refusal semantics: it distinguishes `waiting_input` from `blocked`, rechecks state immediately before a write, fences generation, and fails closed on store errors. Its actual delivery is still chunked tmux typing, with documented races and “HTTP 200 but prompt remained a draft” bugs; RelayForge must not adopt that delivery mechanism.
- [Google Scion](https://github.com/google/scion/tree/91c26b343a26b7697f9432de5792cd7372b391a6) has the most useful coding-agent message envelope, bounded payload, CAS dispatch, target-scope, and stuck-queue tests. Its current “dispatched” state is claimed before broker delivery and its prompt buffer is in memory and writes to tmux, so RelayForge must use more precise facts and a durable prompt manifest.
- [Daintree](https://github.com/daintreehq/daintree/tree/eb989c7613db8ff9dc948775291f56e42c5ada3a) has the strongest operator UX among the inspected desktop tools: pending/progress/cancel state, explicit terminal targeting, subscribe-plus-recheck race handling, and activity presentation. The queue is renderer-memory state and ultimately injects a terminal, so its implementation is unsuitable for authority or recovery.

MyClaude and ChatDev contribute workflow/role ideas, but neither supplies a durable, parent-only, crash-safe steering boundary. Their code is not a basis for P2.

The coherent design is therefore:

1. Build on P1's daemon-owned `ControlStore`, canonical event sequence, aggregate generations, and one serialized writer.
2. Admit only parent-authorized `steer_next_boundary` commands into a bounded durable inbox. An agent/provider cannot author, forward, broadcast, or acknowledge authority.
3. Derive `idle | waiting_input | dispatching | active | settling | blocked | exited` from durable facts. Never persist a manually writable umbrella activity field.
4. At an initial dispatch or repair boundary, transactionally capture eligible commands at a sequence cutoff, render them into exact immutable prompt bytes, persist the prompt artifact/hash and attempt binding, and only then launch the provider from those bytes.
5. Refuse admission or capture for blocked/exited/wrong-generation/terminal-task targets. A state change during capture wins in the same transaction; there is no check-then-terminal-write race.
6. Show operators `Pending`, `Included in attempt N`, `Refused`, `Withdrawn`, `Superseded`, or `Expired`. Never show `Sent`, `Delivered`, `Read`, or `Processed` unless a future protocol can prove such a distinct fact.

No direct or modified upstream code is approved by this audit. All reuse is `ARCHITECTURAL_INSPIRATION` or `IDEA_ONLY`, with independent RelayForge types and tests.

## Scope and architectural gates

P2 covers:

1. command identity, schema, source authority, target generation, ordering, lifecycle, and bounded payload;
2. pure activity projection and the states in which admission/capture is legal;
3. deterministic inclusion at the initial dispatch and later repair-attempt prompt boundaries;
4. crash/restart behavior before capture, after capture, around launch, and after provider exit;
5. monitor/dashboard representation and operator withdrawal of a still-pending command;
6. migration away from treating arbitrary board messages as executable parent intent.

P2 does **not** add terminal injection, provider live-turn steering, keystroke automation, agent-authored commands, process signals, broad broadcast, an unauthenticated dashboard mutation endpoint, or a general task-cancellation protocol. Cancellation/interruption changes execution ownership and deserves a later, separately audited control command. Independent new work remains a `BoardTask`, not a steering message.

The architectural consistency gate is satisfied only if the implementation:

- uses the P1 canonical event history and generation fences;
- creates explicit, immutable command and prompt-manifest facts;
- keeps activity and presentation pure and replayable;
- permits only the parent control plane to create authority;
- has no PTY/tmux delivery path;
- survives daemon death without losing, duplicating, or silently consuming an admitted command;
- never converts an uncertain external effect into a false “delivered” fact;
- exposes exact sequence and attempt linkage for observability and deterministic verification.

## Audit method, discovery, and exact pins

Every repository below was cloned under `/home/arbaz/.relayforge-references`, pinned by commit, and inspected with source search, targeted file reads, `git log`, `git show`, tests, design documents, and relevant issue/PR history. License, NOTICE, and relevant file headers were checked before deciding reuse. README claims were used only to locate code, never as proof of behavior.

Fresh GitHub searches included `coding agent orchestration`, `Claude Code orchestration`, `Codex orchestration`, `multi agent coding`, `coding agent worktree`, `coding agent steering queue`, `agent message queue`, `durable prompt inbox`, and `workflow signal update`. GitHub topics and recently updated candidates were compared. OpenCode emerged from that rescan as materially stronger than the initial corpus for this subsystem; it is included as a primary adjacent reference. Repositories surfaced but not selected as strongest evidence included `badlogic/pi-mono`, `agent-message-queue`, StrongDM's Attractor specification, Kimaki, and agtx. They did not displace OpenCode's durable source/tests, Temporal's workflow lifecycle, or the coding-agent-specific references below.

| Repository | Exact pin inspected | Last pinned activity | License and header finding |
|---|---|---|---|
| RelayForge / `loop-orchestrator` | `997763e3d5e019b737ab704e69ec11a34c7c3592` | 2026-08-09, phase-zero hardening | MIT, root `LICENSE`; no reuse issue because this is the local codebase |
| Untrivial-ai/agent-orchestrator | `f65c48e296e20a816221a4003c75a5f0387967ec` | 2026-08-09, PR #3709 | Apache-2.0, root `LICENSE`; no root `NOTICE` found; relevant files have no extra incompatible header |
| anomalyco/opencode | `38e10eb1408feb700021b8e8766fb0ab41bf84e2` | 2026-08-08, PR #41312 | MIT, root `LICENSE`; no root `NOTICE` found; relevant TypeScript files have no additional header |
| temporalio/temporal | `023cb7d861b6cc0e139564b2faaf10c106a7f37d` | 2026-08-07, PR #11442 | MIT, root `LICENSE`; relevant Go files have no additional incompatible header |
| google/scion | `91c26b343a26b7697f9432de5792cd7372b391a6` | 2026-08-08, PR #1089 | Apache-2.0, root `LICENSE`; Google Apache file headers; no root `NOTICE` found |
| daintreehq/daintree | `eb989c7613db8ff9dc948775291f56e42c5ada3a` | 2026-08-08, PR #11723 | Apache-2.0; root `NOTICE` credits Daintree 2025–2026 and separately restricts names/logos; relevant source has project copyright headers |
| stellarlinkco/myclaude | `f2e75c1263a2d5f09cdc4bb3dfe3635c635ff296` | 2026-05-04 | AGPL-3.0, root `LICENSE`; no root `NOTICE` found |
| OpenBMB/ChatDev | `4fb2db0ea90375ce1059f44fe03ffbd191a7a169` | 2026-07-24, PR #639 | Apache-2.0, root `LICENSE`; no root `NOTICE` found; relevant Python files have no extra header |

The similarly named AgentWrapper repository was not counted as an independent P2 implementation because the initial audit corpus already established that it currently resolves to the same objects/history as Untrivial Agent Orchestrator. Counting aliases as separate references would manufacture diversity.

## RelayForge current-state audit

### Source and tests inspected

- [`src/board.ts`](../../../../src/board.ts): `BoardMessage`, append/fold, and `gatherContext()`.
- [`src/orchestrator.ts`](../../../../src/orchestrator.ts): task claim, initial/repair prompt construction, provider turn, crash reclaim, review feedback, merge conflicts, post-merge verification, and parent messages.
- [`src/prompts.ts`](../../../../src/prompts.ts): the parent-authority prompt that tells workers not to manage the board and treats their final response as a report.
- [`src/tmux.ts`](../../../../src/tmux.ts): optional viewport-only tmux integration and its explicit prohibition on `send-keys`.
- [`src/dashboard/data.ts`](../../../../src/dashboard/data.ts), [`src/dashboard/server.ts`](../../../../src/dashboard/server.ts), and [`src/monitor.ts`](../../../../src/monitor.ts): current four-state cards, timeline folding, loopback read-only HTTP, redaction, and terminal tails.
- [`tests/board.test.ts`](../../../../tests/board.test.ts), [`tests/sota.test.ts`](../../../../tests/sota.test.ts), and [`tests/dashboard-data.test.ts`](../../../../tests/dashboard-data.test.ts): the present board-context and activity coverage.
- [`docs/reference/ao-gap-analysis.md`](../../../../docs/reference/ao-gap-analysis.md): existing RelayForge P2 intent and boundary language.

### What exists today

`BoardMessage` contains only `ts`, `from`, `to`, optional `taskId`, and `body`. `addMessage()` appends a JSONL record directly. There is no command ID, aggregate sequence, request/idempotency key, schema version, run/session/attempt generation, source authority, immutable body digest, state, refusal reason, withdrawal, expiry, or inclusion receipt.

`gatherContext(boardDir, role, task, limit = 8)` filters messages addressed to the role or `*`, combines them with dependency information, and takes a recent suffix. This is acceptable as best-effort informational context, but not as command delivery:

- the same record can be included in every retry because no consumption/inclusion fact exists;
- caller timestamps influence order and there is no canonical sequence;
- a global count limit lets unrelated older/newer context displace instructions;
- wildcard messages have no target materialization or per-session acknowledgement;
- no session/attempt generation prevents stale intent crossing a restart or new task;
- agent-authored and parent-authored messages use the same representation.

The actual authority model is stricter than the original board comment: `src/prompts.ts` tells workers they do not manage the board and their output is a report to the parent. P2 must preserve that real model. It must not turn the generic `from` string into an authentication decision or let a worker manufacture a record that looks parent-authored.

`dispatchTask()` claims a task, calls `gatherContext()`, renders one `taskText`, and invokes one routed provider turn. Review rejection, merge conflict, post-merge verification, integration advancement, and acceptance append parent messages; a later repair attempt happens to see a suffix of them. That gives P2 a narrow, safe integration point: the control plane can prepare a future attempt prompt before `runRoutedTurn()`. There is no need to mutate a currently running provider session.

Crash reclaim turns an abandoned active attempt into a retryable blocked fact. P2 must explicitly reconcile any pending command with that attempt generation; it must not assume that provider exit implies the prompt was read.

`src/tmux.ts` is already correct for the intended trust boundary. It describes tmux as a viewport and never uses `send-keys`. `showInPane()` displays output; it is not an input channel. P2 acceptance tests must preserve this invariant.

The dashboard currently derives only `working | review-pending | blocked | idle` from task status. It has no attempt/session generation, no `waiting_input` versus `blocked`, no steering queue, and no inclusion/refusal facts. The HTTP server is loopback and read-only, with GET/HEAD only; the monitor is also read-only. P2 should first add truthful observation. Any mutation command should go through the daemon's parent control API/CLI, not an ad hoc dashboard POST.

Current tests cover basic board folding, first claim, addressed/upstream context gathering, and the four dashboard card states. They do not cover idempotency, divergent duplicate IDs, stable ordering, generation targeting, concurrent capture, cutoff races, blocked/exited refusal, crash points, exact prompt hashing, replays, or stale operator views.

The gap analysis already records the correct design intent: queue parent-authored context into the next safe prompt boundary; do not grant board write access or write indiscriminately to a terminal; distinguish waiting for a safe input point from truly blocked and refuse the latter. This audit turns that intent into a source-evidenced contract.

## Mandatory primary reference: Untrivial Agent Orchestrator

### Source, tests, and design inspected

- [`backend/internal/domain/activity.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/domain/activity.go) and [`status.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/domain/status.go).
- [`backend/internal/sessionguard/guard.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/sessionguard/guard.go) and [`guard_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/sessionguard/guard_test.go).
- [`backend/internal/ports/agent.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/ports/agent.go).
- [`backend/internal/lifecycle/manager.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/lifecycle/manager.go), lifecycle tests, and reaction tests.
- [`backend/internal/session_manager/manager.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/session_manager/manager.go) and session-manager tests, especially prompt/start failure paths.
- [`backend/internal/adapters/runtime/tmux/tmux.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/adapters/runtime/tmux/tmux.go) and [`tmux_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/adapters/runtime/tmux/tmux_test.go).
- [`docs/architecture.md`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/docs/architecture.md).

### Strongest ideas

Agent Orchestrator explicitly models `active`, `idle`, `waiting_input`, `blocked`, and `exited`. `waiting_input` means an idle prompt is available for an ordinary instruction; `blocked` means a permission/approval or other decision is required. Both can render as “needs input,” but their control legality differs. That distinction is essential: RelayForge's `waiting_input` will mean “a safe next attempt prompt can be prepared,” whereas `blocked` remains a hard refusal.

The session guard re-reads current state immediately before terminal mutation. It rejects a missing, terminated, exited, or blocked session and fails closed if the store read fails. For coordination messages it also rejects waiting-input/active combinations that lack an active-turn-steering capability. Tests cover the state matrix and a change between an earlier observation and the final guard.

These are strong *admission/refusal and test* semantics. They are not a delivery implementation RelayForge should copy.

### Bug history and rejected mechanism

Commit [`e8674961f234dbfdfe4ab901cc55dc03573e7b56`](https://github.com/Untrivial-ai/agent-orchestrator/commit/e8674961f234dbfdfe4ab901cc55dc03573e7b56) ([PR #2357](https://github.com/Untrivial-ai/agent-orchestrator/pull/2357), 2026-07-11) fixed [issue #2342](https://github.com/Untrivial-ai/agent-orchestrator/issues/2342): multiline text could be typed into a terminal, the final Enter could be swallowed, and the API could return success while the prompt remained an unsubmitted draft. The fix adds a 300 ms settle and up to three Enter nudges separated by two seconds. The same change guards blocked/exited state and converts after-start prompt failure into a spawn failure.

The runtime adapter still types literal chunks and Enter into tmux. Its own source acknowledges a non-atomic window in which an interactive dialog can appear during paste. A pane whose agent exited may now be a shell. A guard can narrow but cannot eliminate the time-of-check/time-of-use gap between a durable state read and external keystrokes.

RelayForge therefore adopts:

- separate `waiting_input` and `blocked` activity;
- a final state/generation check at the mutation transaction;
- fail-closed store behavior;
- blocked/exited and stale-generation characterization tests.

RelayForge rejects:

- tmux/PTY input;
- sleep-and-nudge submission;
- a capability flag that permits mutation of a live provider turn;
- interpreting “write attempted” as delivered or processed.

Reuse classification: `ARCHITECTURAL_INSPIRATION`. No code or test is copied.

## Strongest direct reference: OpenCode durable input promotion

### Source, schema, tests, and design inspected

- [`CONTEXT.md`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/CONTEXT.md): definitions for safe provider-turn boundary, admitted prompt, and prompt promotion.
- [`packages/core/src/session/input.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/session/input.ts): admission, stable ID conflict handling, pending selection, sequence cutoff, steering/queue policy, and prompt publication.
- [`packages/core/src/session/sql.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/session/sql.ts): durable inbox fields, admitted/promoted sequences, uniqueness, and pending index.
- [`packages/core/src/session/projector.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/session/projector.ts): event projection and atomic consumption into user-visible history.
- [`packages/core/src/session/runner/llm.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/session/runner/llm.ts): boundary cutoff capture, promotion ordering, context preparation, provider call, and continuation.
- Migrations [`20260603141458_session_input_inbox.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/database/migration/20260603141458_session_input_inbox.ts), [`20260604172448_event_sourced_session_input.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/database/migration/20260604172448_event_sourced_session_input.ts), and [`20260622202450_simplify_session_input.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/database/migration/20260622202450_simplify_session_input.ts).
- [`packages/core/test/session-prompt.test.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/test/session-prompt.test.ts), [`session-runner.test.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/test/session-runner.test.ts), and [`packages/opencode/test/server/httpapi-session.test.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/server/httpapi-session.test.ts).

### Why this is the best implementation found

OpenCode gives an input a stable ID and records a durable `PromptAdmitted` fact before execution. An exact retry with the same ID and payload is idempotent; the same ID with a different prompt or delivery mode conflicts. Its inbox stores `admitted_seq`, optional `promoted_seq`, and delivery mode. A runner captures the current event sequence at a provider-turn boundary, promotes only pending steering items at or before that cutoff in stable admission order, and leaves later arrivals pending. Queued items are promoted one at a time only when continuation is otherwise idle.

Promotion publishes a durable `Prompted` event. The projector atomically marks the inbox row promoted and appends the user message to model-visible history. Context initialization happens before promotion, so an unavailable initial context does not consume an input. The process-local drain loop is explicitly not treated as durable identity; recovery comes from inbox/history/provider/tool facts.

The tests are unusually complete:

- omitted IDs create distinct inputs; an explicit ID makes an exact retry idempotent;
- divergent same-ID prompt or delivery conflicts;
- concurrent exact admission yields one durable admission;
- concurrent promotion yields one `Prompted` fact;
- the captured cutoff excludes a later steer;
- replay rebuilds pending input;
- IDs cannot be ambiguously reused across sessions;
- interruption preserves queue/steer input for resume;
- steering precedes ordinary queued input and FIFO is deterministic;
- multiple steers join the next provider turn;
- provider failure, crash/tool reconciliation, first queued wake, promotion rollback, and post-commit listener failure do not strand the durable input.

[PR #33443](https://github.com/anomalyco/opencode/pull/33443), represented by commit [`f48f24ec4e1e26cc32c4d4953497fe2734c61ee1`](https://github.com/anomalyco/opencode/commit/f48f24ec4e1e26cc32c4d4953497fe2734c61ee1) (2026-06-22), explains the current simplification: retain a durable admitted inbox, atomically consume it into the ordinary prompt event/history, and recover pending work through projection. The PR reports 145 focused tests. [Issue/PR discussion #32157](https://github.com/anomalyco/opencode/issues/32157) separately distinguishes queue, steer, and break and notes that target relationships must survive compaction.

### RelayForge adaptation and improvement

OpenCode is a session-centric interactive coding runtime. Its default prompt delivery is steering, users/plugins can author input, and its runner can continue a live tool/model loop. It does not enforce RelayForge's parent-only authority, blocked/exited admission rule, task/run/attempt generations, or immutable one-shot attempt-prompt artifact. “Prompted” proves projection into model-visible history, not provider cognition.

RelayForge will independently adapt the following architecture:

- durable admission before execution;
- stable ID plus exact-payload idempotency/conflict;
- canonical sequence cutoff captured at a safe boundary;
- deterministic promotion under transaction/CAS;
- later arrivals remain pending;
- projection/replay and failure-injection tests.

RelayForge will materially improve it for this domain by:

- accepting authority only from the parent control plane;
- binding every command to run, session, task, and minimum attempt generation;
- refusing blocked/exited/terminal/stale targets durably;
- atomically binding selected commands to exact persisted prompt bytes, prompt hash, and an attempt generation before provider launch;
- avoiding live-turn or terminal mutation entirely;
- using the truthful terminal fact `included`, not `delivered` or a broad `promoted` interpretation;
- preserving target/attempt relationships through P1 snapshots and any future compaction.

Reuse classification: `ARCHITECTURAL_INSPIRATION`. Although MIT permits copying, direct reuse would import incompatible session assumptions and naming; independent implementation better preserves RelayForge's domain model.

## Adjacent reference: Temporal Signals and Updates

### Source, tests, and design inspected

- [`docs/architecture/workflow-update.md`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/docs/architecture/workflow-update.md).
- [`service/history/api/signalworkflow/api.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/api/signalworkflow/api.go).
- [`service/history/api/updateworkflow/api.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/api/updateworkflow/api.go) and [`update_workflow_util.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/api/update_workflow_util.go).
- [`service/history/workflow/update/update.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/workflow/update/update.go), [`state.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/workflow/update/state.go), and update unit tests.
- [`service/history/history_engine_test.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/service/history/history_engine_test.go), [`tests/update_workflow_test.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/tests/update_workflow_test.go), and [`tests/signal_workflow_test.go`](https://github.com/temporalio/temporal/blob/023cb7d861b6cc0e139564b2faaf10c106a7f37d/tests/signal_workflow_test.go).

### Strongest ideas and limitations

A Signal is a durable fire-and-forget history event with request-ID deduplication that schedules a workflow task. A caller cannot infer that workflow code processed it. A completed workflow rejects a new signal, while an already-recorded duplicate can still resolve idempotently. This is close to RelayForge's “admitted, not read” rule.

An Update has a richer staged lifecycle: created, provisionally admitted, admitted, sent, provisionally accepted, accepted, completed, or aborted. Update ID deduplicates retries; callers may wait for accepted or completed; workflow code can reject an Update; handling occurs at a workflow-task boundary. Tests cover duplicate handling, rejection, completion, and lifecycle behavior.

The design document also identifies an important limitation: before acceptance, admitted or rejected Update state can reside in an in-memory registry. Registry loss aborts/retries it, and a rejected Update is not necessarily durable/deduplicable. Temporal has deliberately documented this rather than overstating guarantees.

Relevant bug history reinforces the lifecycle requirements:

- commit [`58e247bf82063407b1d37be5f92b40b6e2bac837`](https://github.com/temporalio/temporal/commit/58e247bf82063407b1d37be5f92b40b6e2bac837) / [PR #4313](https://github.com/temporalio/temporal/pull/4313) prevents a workflow from closing while undelivered Updates remain;
- commit [`a06fe2df803e669081bd5cc4a978597414111a67`](https://github.com/temporalio/temporal/commit/a06fe2df803e669081bd5cc4a978597414111a67) / [PR #6513](https://github.com/temporalio/temporal/pull/6513) fixes completed-Update deduplication during reapply ([issue #5833](https://github.com/temporalio/temporal/issues/5833));
- commit [`bdef727f255ecc3e72f5baa2ee3a4a34213fa713`](https://github.com/temporalio/temporal/commit/bdef727f255ecc3e72f5baa2ee3a4a34213fa713) / [PR #6485](https://github.com/temporalio/temporal/pull/6485) aborts an admitted Update with a retryable error at Continue-As-New so it can be retried instead of being silently lost;
- commit [`f1fe14b1f5ff0d9b59d74cf80a98d7c3fd0db651`](https://github.com/temporalio/temporal/commit/f1fe14b1f5ff0d9b59d74cf80a98d7c3fd0db651) / [PR #9614](https://github.com/temporalio/temporal/pull/9614) adds Update callbacks and labels speculative Update handling as high risk, with extensive tests.

RelayForge adopts request-ID dedupe, staged facts, boundary handling, completed-target refusal, and the rule that admission is not processing. It improves the fit by persisting admission, refusal, withdrawal, and inclusion in the P1 authority rather than depending on a process-local pre-acceptance registry. RelayForge does not import Temporal's speculative workflow task, callback, distributed shard, or Continue-As-New machinery.

Reuse classification: `ARCHITECTURAL_INSPIRATION`. No code or tests are copied.

## Adjacent reference: Google Scion messages and broker dispatch

### Source, tests, and design inspected

- [`pkg/messages/types.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/messages/types.go), [`format.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/messages/format.go), and their tests.
- [`pkg/agent/msgbuffer.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/agent/msgbuffer.go) and tests.
- [`pkg/store/models.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/store/models.go) and [`store.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/store/store.go).
- [`pkg/store/entadapter/brokerdispatch_store.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/store/entadapter/brokerdispatch_store.go) and [`broker_dispatch_store_test.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/store/entadapter/broker_dispatch_store_test.go).
- [`pkg/hub/messagebroker.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/hub/messagebroker.go), [`messagebroker_test.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/hub/messagebroker_test.go), [`handlers_messages.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/hub/handlers_messages.go), delivery tests, and [`reconcile.go`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/pkg/hub/reconcile.go).
- [`.design/messages-evolution.md`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/.design/messages-evolution.md), [`.design/hosted/messages-format-update.md`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/.design/hosted/messages-format-update.md), [`.design/message-broker-plugins.md`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/.design/message-broker-plugins.md), and [`.design/message-cmd.md`](https://github.com/google/scion/blob/91c26b343a26b7697f9432de5792cd7372b391a6/.design/message-cmd.md).

### Strongest ideas

Scion uses a versioned structured envelope with message type, sender/recipient identities, urgency, broadcast, status, attachments, metadata, channel/thread, and visibility. It enforces both a 2,000-rune content bound and a 64 KiB encoded bound. Broker rows have stable identity and `pending | dispatched | failed` status. Storage exposes compare-and-swap dispatch, pending enumeration, and stuck-message counting/expiry. Tests protect CAS deduplication, per-broker target, phase refusal, payload validation, and expiration of stuck pending items.

The history exposes valuable bugs:

- commit [`559df6106bfb49f41c058d3d5b9024b58ccaba60`](https://github.com/google/scion/commit/559df6106bfb49f41c058d3d5b9024b58ccaba60) fixed cross-project delivery when two projects shared an agent slug; identity must include the project/scope, not just a display name;
- commit [`43aaabbf1f487c3310dd9ae81f8e3c030d2e71ac`](https://github.com/google/scion/commit/43aaabbf1f487c3310dd9ae81f8e3c030d2e71ac) / [issue #370](https://github.com/google/scion/issues/370) fixed stuck pending messages that were detected but never cleared, accumulating and logging forever; pending now expires after 24 hours;
- commit [`5851bf92ef9e59180cf43d8bf366e422cdaf4c00`](https://github.com/google/scion/commit/5851bf92ef9e59180cf43d8bf366e422cdaf4c00) adds the character limit;
- commit [`06f4fecd10b985185c47a05d3b3640c2875cbb38`](https://github.com/google/scion/commit/06f4fecd10b985185c47a05d3b3640c2875cbb38) adds short buffering after rapid tmux-message contention;
- commit [`eeee331635217af6cb9751c9ac0f97c998099e38`](https://github.com/google/scion/commit/eeee331635217af6cb9751c9ac0f97c998099e38) / [PR #305](https://github.com/google/scion/pull/305) adds durable multi-node dispatch records.

### Current semantic gap

The delivery path constructs some message rows as `dispatched` before the broker has actually delivered them; failure later changes the row to failed. `deliverMessage` notes that the CAS may already have marked the item before the external write. The reconcile function's commentary refers to pending-message work, but at the inspected pin the function drains lifecycle dispatches and does not establish a complete prompt-delivery recovery loop. `MessageBuffer` is a process-local two-second debounce that joins text and ultimately writes to tmux; errors are logged and `Close()` flushes. Agents may author messages and broadcasts.

RelayForge adopts the stable bounded envelope, complete target scope, CAS/stuck-queue tests, and expiry/withdrawal UX. It changes `dispatched` into the provable `included` fact, rejects broadcast in P2, requires parent authority, uses no in-memory coalescing as durable state, and includes session/task/attempt generation in identity.

Reuse classification: `ARCHITECTURAL_INSPIRATION`. No code or tests are copied.

## Adjacent reference: Daintree context injection and desktop UX

### Source, tests, and design inspected

- [`src/hooks/useContextInjection.ts`](https://github.com/daintreehq/daintree/blob/eb989c7613db8ff9dc948775291f56e42c5ada3a/src/hooks/useContextInjection.ts) and tests.
- [`src/services/actions/definitions/terminalInputActions.ts`](https://github.com/daintreehq/daintree/blob/eb989c7613db8ff9dc948775291f56e42c5ada3a/src/services/actions/definitions/terminalInputActions.ts), terminal-target binding, and action tests.
- [`src/services/terminal/TerminalAgentStateController.ts`](https://github.com/daintreehq/daintree/blob/eb989c7613db8ff9dc948775291f56e42c5ada3a/src/services/terminal/TerminalAgentStateController.ts) and tests.
- [`src/utils/terminalAgentDisplayState.ts`](https://github.com/daintreehq/daintree/blob/eb989c7613db8ff9dc948775291f56e42c5ada3a/src/utils/terminalAgentDisplayState.ts) and tests.
- [`shared/types/agent.ts`](https://github.com/daintreehq/daintree/blob/eb989c7613db8ff9dc948775291f56e42c5ada3a/shared/types/agent.ts).
- [`docs/architecture/agent-activity-monitoring.md`](https://github.com/daintreehq/daintree/blob/eb989c7613db8ff9dc948775291f56e42c5ada3a/docs/architecture/agent-activity-monitoring.md), [`agent-state-tracking-strategy.md`](https://github.com/daintreehq/daintree/blob/eb989c7613db8ff9dc948775291f56e42c5ada3a/docs/architecture/agent-state-tracking-strategy.md), [`mcp-server.md`](https://github.com/daintreehq/daintree/blob/eb989c7613db8ff9dc948775291f56e42c5ada3a/docs/architecture/mcp-server.md), and crash-recovery design notes.

### Strongest ideas and rejected mechanism

Daintree presents injection as a pending operation with progress and cancellation. It waits for `idle | waiting`, subscribes to activity, immediately rechecks to close the subscribe race, then refetches the session and performs a second state check before input. Each operation has an ID. Recent history has repeatedly hardened exact targeting and cancellation:

- commit [`02d91bde3ba1e4b232bde908b0b15e577254f778`](https://github.com/daintreehq/daintree/commit/02d91bde3ba1e4b232bde908b0b15e577254f778) (2026-07-31) fixes [issue #11346](https://github.com/daintreehq/daintree/issues/11346) by requiring an explicit terminal ID; roughly twenty actions could previously act on whichever terminal was focused;
- commit [`51070e64d264411b4644b313115d08188124bce7`](https://github.com/daintreehq/daintree/commit/51070e64d264411b4644b313115d08188124bce7) permits cancellation during availability checking;
- commit [`723716bff99332fa7905c8db29e208f3378ce68e`](https://github.com/daintreehq/daintree/commit/723716bff99332fa7905c8db29e208f3378ce68e) / [issue #10034](https://github.com/daintreehq/daintree/issues/10034) improves pending progress/cancel UI;
- commit [`b1dd773ef8e5c7251caf1eff967ae50123b14223`](https://github.com/daintreehq/daintree/commit/b1dd773ef8e5c7251caf1eff967ae50123b14223) hardens activity indicators.

This is the best operator-facing interaction found. However, the pending injection is global renderer memory, only one injection can be pending, a renderer restart loses it, and the final effect is still terminal input. Activity (`idle | working | waiting | directing | completed | exited`) comes partly from passive PTY heuristics and does not distinguish an approval block from a safe instruction boundary.

RelayForge adopts the visible pending/wait/cancel/progress experience, exact target display, and subscribe/recheck lesson. It replaces the in-memory queue with P1 durable facts, the focused terminal with run/session/task/generation identity, heuristic authority with pure event projection, and terminal injection with future prompt preparation.

Because Daintree carries a NOTICE and trademark/name restrictions, any future code reuse would require attribution and careful separation of branding. This audit approves only `ARCHITECTURAL_INSPIRATION`; no code or UI asset is copied.

## Workflow and role references: MyClaude and ChatDev

### MyClaude

Inspected:

- [`skills/do/SKILL.md`](https://github.com/stellarlinkco/myclaude/blob/f2e75c1263a2d5f09cdc4bb3dfe3635c635ff296/skills/do/SKILL.md);
- `codeagent-wrapper/internal/application/runtaskset/`, `internal/domain/task/topology.go` and tests;
- `internal/executor/prompt.go`, resume/parallel tests;
- `codeagent-wrapper/docs/aec/codeagent-wrapper-async-execution-refactor-aec.md`.

MyClaude has a structured understand/clarify/design/implement/review workflow, role decomposition, dependency topology, provider-specific prompts, and explicit new-versus-resume invocation. It does not implement a durable live-steering inbox, stable command lifecycle, state/generation refusal, or safe atomic prompt promotion. Its AGPL-3.0 license also makes code incorporation inappropriate without a project-wide licensing decision.

Reuse classification: `IDEA_ONLY` for staged workflow language; code and tests are `NOT_USED`.

### ChatDev

Inspected:

- [`entity/messages.py`](https://github.com/OpenBMB/ChatDev/blob/4fb2db0ea90375ce1059f44fe03ffbd191a7a169/entity/messages.py);
- [`runtime/edge/conditions/base.py`](https://github.com/OpenBMB/ChatDev/blob/4fb2db0ea90375ce1059f44fe03ffbd191a7a169/runtime/edge/conditions/base.py);
- [`server/services/message_handler.py`](https://github.com/OpenBMB/ChatDev/blob/4fb2db0ea90375ce1059f44fe03ffbd191a7a169/server/services/message_handler.py) and [`tests/test_websocket_send_message_sync.py`](https://github.com/OpenBMB/ChatDev/blob/4fb2db0ea90375ce1059f44fe03ffbd191a7a169/tests/test_websocket_send_message_sync.py);
- [`docs/user_guide/en/execution_logic.md`](https://github.com/OpenBMB/ChatDev/blob/4fb2db0ea90375ce1059f44fe03ffbd191a7a169/docs/user_guide/en/execution_logic.md) and [`dynamic_execution.md`](https://github.com/OpenBMB/ChatDev/blob/4fb2db0ea90375ce1059f44fe03ffbd191a7a169/docs/user_guide/en/dynamic_execution.md).

ChatDev provides structured role/content/attachment messages, role conversion across graph edges, and loop/review decomposition. Its server-side reconnect work at commit `64bb16a884caaec0d2253dcf3f8befe5e493cf7e` uses a bounded transient ring buffer, useful for display continuity but not a durable authority. Tests emphasize memory/websocket behavior rather than durable steering, idempotency, crash recovery, or safe provider boundaries. Agents participate in the communication protocol, so it also lacks parent-only control authority.

Reuse classification: `IDEA_ONLY` for role-labelled informational context; no source/test copying.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| RelayForge current | `BoardMessage`, `gatherContext`, one-shot dispatch/repair prompts, viewport-only tmux | Already has a naturally safe future-attempt boundary and correct no-`send-keys` rule | Generic JSONL messages lack IDs, authority, generations, lifecycle, cutoff, inclusion receipt, and recovery | MIT | Refactor local behavior; preserve viewport invariant |
| Untrivial Agent Orchestrator | Activity domain, session guard, lifecycle/session manager, tmux adapter | Best coding-agent distinction of waiting versus blocked; fail-closed final recheck; extensive state tests | Delivery is non-atomic terminal typing; documented 200/draft and interactive-dialog races | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` for activity/refusal/tests; terminal code `NOT_USED` |
| OpenCode | Event-sourced session input inbox and atomic prompt promotion | Best durable admission/promotion implementation and concurrency/restart test suite; exact ID conflicts; sequence cutoff | Interactive/user-authored/live-loop domain; no RelayForge parent authority or blocked/exited generation contract | MIT | `ARCHITECTURAL_INSPIRATION`; independently adapt inbox/cutoff/atomic-promotion model |
| Temporal | Signals, Updates, workflow-task boundary | Mature staged lifecycle, dedupe, reject/complete semantics, closed-target refusal | Some pre-acceptance Update state is process-local; distributed machinery is oversized | MIT | `ARCHITECTURAL_INSPIRATION` for lifecycle and boundary language |
| Google Scion | Versioned message envelope, broker dispatch store, CAS and stuck queue | Strong bounds, target scope, CAS/expiry tests, coding-agent relevance | “Dispatched” can precede delivery; in-memory debounce and tmux; agent authors/broadcasts | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` for envelope/bounds/tests; delivery code `NOT_USED` |
| Daintree | Context-injection hook, explicit target, activity controller, progress/cancel UI | Best lightweight operator UX and subscribe-plus-recheck discipline | Renderer-memory singleton queue, PTY heuristics, terminal injection, no blocked distinction | Apache-2.0 plus NOTICE/trademark terms | `ARCHITECTURAL_INSPIRATION` for UX only |
| MyClaude | Staged feature workflow, task topology, new/resume prompts | Useful role/routing and phase decomposition | No durable session-steering protocol; AGPL coupling risk | AGPL-3.0 | `IDEA_ONLY`; code/tests `NOT_USED` |
| ChatDev | Role messages, graph edges, loops, reconnect buffer | Useful communication/review research vocabulary | Agent-authored conversational model; transient buffer; sparse durability tests | Apache-2.0 | `IDEA_ONLY` |

### Reference quality by P2 subproblem

Scores are comparative audit judgments on a 100-point scale using correctness 25, test quality 20, failure handling 15, architecture 15, maintainability 10, recent activity 5, performance 5, and license suitability 5. A low subsystem score does not judge the entire project.

| Candidate | Durable admission/promotion | Activity/refusal | Failure/recovery tests | Operator UX | Legal fit | Overall P2 fit |
|---|---:|---:|---:|---:|---:|---:|
| OpenCode | 25/25 | 8/15 | 18/20 | 6/10 | 5/5 | 87/100 |
| Agent Orchestrator | 10/25 | 15/15 | 16/20 | 7/10 | 5/5 | 78/100 |
| Temporal | 22/25 | 9/15 | 19/20 | 2/10 | 5/5 | 82/100 |
| Scion | 17/25 | 7/15 | 14/20 | 6/10 | 5/5 | 76/100 |
| Daintree | 5/25 | 9/15 | 11/20 | 10/10 | 4/5 | 65/100 |
| MyClaude | 2/25 | 3/15 | 6/20 | 5/10 | 1/5 | 42/100 |
| ChatDev | 2/25 | 3/15 | 5/20 | 5/10 | 5/5 | 44/100 |

These scores support best-of-breed synthesis; they do not justify importing a whole architecture.

## Consequential design comparisons

### Input delivery strategy

| Strategy | Evidence | Failure mode | RelayForge decision |
|---|---|---|---|
| Type into tmux after guard | Agent Orchestrator | State changes after check; dialogs/shell receive input; Enter may not submit; external write acknowledgement is ambiguous | Reject |
| Wait for PTY idle then inject | Daintree | Heuristic idle, renderer queue loss, focus/target bugs, restart ambiguity | Reject |
| In-memory debounce then broker/terminal | Scion | Crash loses buffer; coalescing alters identity; “dispatched” precedes effect | Reject |
| Promote durable inbox at provider-turn boundary | OpenCode | Correct local pattern; still needs authority and task/generation adaptation | Adopt architecture |
| Append signal/update for next workflow task | Temporal | Strong lifecycle; some admitted Update state process-local | Adopt semantics, make all P2 facts durable |
| Render into immutable next attempt prompt | RelayForge synthesis | No live mutation; later arrival waits; requires prompt artifact and retry recovery | Chosen implementation |

### Activity strategy

| Repository | Model | RelayForge finding |
|---|---|---|
| Current RelayForge | Four task-card labels inferred from task status | Too coarse; no session/attempt boundary or settling state |
| Agent Orchestrator | Explicit activity facts and derived status; waiting differs from blocked | Strongest terminology, but RelayForge should derive it entirely from P1 events |
| Daintree | PTY/provider heuristics and UI display mapping | Strong UI, insufficient authority |
| Temporal | Workflow state plus pending workflow-task/update lifecycle | Strong boundary semantics, too distributed for local activity |
| Chosen | Pure fold to seven mutually exclusive states with `observedSeq` and generation | Truthful, replayable, and directly controls admission/capture |

### Command lifecycle terminology

| Term | What it proves | Use? |
|---|---|---|
| `pending` | Command was admitted and is not terminal or bound to a prompt | Yes |
| `included` | Command ID is bound to persisted exact prompt bytes/hash for a named attempt | Yes |
| `refused` | Parent control plane durably rejected target/state/policy before inclusion | Yes |
| `withdrawn` | Parent withdrew a still-pending command through CAS | Yes |
| `superseded` | A new parent command explicitly replaced a pending command | Yes |
| `expired` | A still-pending command crossed its explicit expiry policy | Yes, optional expiry only |
| `sent` / `dispatched` | Usually only means an external write was attempted or claimed | No |
| `delivered` / `read` / `processed` | Would require evidence RelayForge does not possess | No |

## Chosen design

### Best implementation discovered

Best direct implementation: OpenCode's durable `PromptAdmitted` inbox plus sequence-cutoff, atomic `Prompted` projection.

Why: it is the only inspected coding-agent implementation whose source and tests jointly prove durable input identity, exact-retry idempotency, divergent conflicts, concurrent single promotion, late-arrival exclusion, replay, and crash/failure preservation at a provider boundary.

What RelayForge will reuse: the architectural split between admission and boundary inclusion; stable IDs; payload-conflict detection; canonical ordering; captured cutoff; atomic consumption/projection; replay-oriented tests.

What RelayForge will change: authority is parent-only; the target includes run/session/task/attempt generations; the only P2 delivery kind is `steer_next_boundary`; blocked/exited/terminal targets are refused; promotion binds an immutable attempt prompt artifact rather than a live interactive history; and terminal injection is impossible.

How RelayForge improves it: all admission/refusal/inclusion facts are P1-durable; the external launch consumes exact persisted bytes; recovery can prove which attempt contained which commands; dashboards use truthful terminology and view sequences; and P2 never equates projection with cognition.

### Control-plane authority

The daemon is the sole writer. A steering request may originate from:

- an authenticated local operator action (`operator`);
- a parent review gate that has parsed and validated review evidence (`review_gate`);
- a parent verifier that has transformed deterministic verification output into a bounded instruction (`verifier`);
- a parent orchestration rule (`control_plane`).

`source_kind` records provenance; it does not grant authority by itself. The daemon attaches the authenticated `parent_principal` and request ID. Agent text, provider tool output, repository content, review comments, and legacy `BoardMessage.from` values are evidence only. They cannot call the writer, choose their own principal, or create a command. A review gate must create a new parent event referencing the untrusted evidence ID rather than reclassifying the evidence as authority.

Provider child processes receive no database writer, daemon control socket credential, or environment token that can admit steering. Their stdout/final response remains a report. P2 has no agent-to-agent broadcast and no `*` target.

### Durable command schema

The logical schema below sits on the P1 canonical event/fact transaction. Exact SQL layout may follow the P1 implementation, but every semantic field is required.

```text
SteeringCommandV1
  schema_version: 1
  command_id: UUIDv7                         // caller retry identity
  run_id: RunId
  run_generation: uint64                    // fences replaced/reopened runs
  session_id: SessionId
  session_generation: uint64                // fences replacement provider sessions
  task_id: TaskId
  not_before_attempt_generation: uint64      // earliest eligible future prompt
  kind: "steer_next_boundary"
  source_kind: "operator" | "review_gate" | "verifier" | "control_plane"
  parent_principal: PrincipalId              // assigned by daemon, not request body
  evidence_refs: ordered list<EventId>       // provenance only
  body: normalized UTF-8 string
  body_sha256: lowercase SHA-256
  admitted_seq: EventSeq
  created_at: control-plane timestamp        // display/expiry, never ordering
  expires_at: optional timestamp
  supersedes_command_id: optional CommandId
```

Identity is `command_id`, globally unique within the control store. An exact retry must match every immutable semantic field and body digest and returns the original result. Same ID with any divergent field is `COMMAND_ID_CONFLICT`. A caller omitting an ID is rejected; unlike an interactive chat, control commands must be retriable by identity.

Ordering is `(admitted_seq, command_id)`, never timestamp. `created_at` is diagnostic. Body normalization is limited to rejecting invalid Unicode/noncharacters and normalizing line endings to `\n`; do not apply lossy whitespace or Unicode normalization that could disguise a conflict. Persist exact normalized bytes and the digest.

Bounds are part of the versioned contract, not UI suggestions:

- body: non-empty, at most 8,192 Unicode scalar values and 16 KiB UTF-8;
- evidence references: at most 32, each a valid existing fact visible to the parent;
- at most 32 commands and 64 KiB of complete rendered steering block per prompt boundary;
- unknown schema versions, unknown kinds, unknown source kinds, missing target components, and unrecognized fields fail validation.

A single command that cannot fit the per-command bound is refused at admission. Boundary overflow does not partially truncate a command; take the deterministic longest eligible prefix that fits both boundary limits and leave the rest pending. Persist the renderer/schema version with the prompt manifest.

### Command lifecycle and canonical events

The P1 event history is canonical. At minimum P2 adds:

- `steering_command_admitted` with immutable payload/digest and target;
- `steering_command_refused` with request ID, supplied target/digest, stable reason code, and observed generation/activity when the store is available;
- `steering_command_withdrawn` for a pending command;
- `steering_command_superseded` linking old and new pending commands;
- `steering_command_expired` for explicit expiry;
- `attempt_prompt_prepared` with attempt ID/generation, renderer/schema version, exact artifact locator, byte length, SHA-256, capture cutoff, and ordered command IDs;
- `steering_command_included` for each selected command, referencing the same attempt and prompt hash;
- `attempt_launch_started`, `attempt_provider_started`, `attempt_provider_exited`, and reconciliation facts needed by the P1 activity reducer.

The command projection is exactly one of:

```text
pending
included(attempt_id, attempt_generation, prompt_sha256, included_seq)
refused(reason_code, observed_seq)
withdrawn(withdrawn_seq)
superseded(by_command_id, superseded_seq)
expired(expired_seq)
```

All except `pending` are terminal for that command ID. “Included” is not later rewritten to “delivered.” If a prepared attempt is explicitly abandoned before launch, recovery emits an attempt-abandoned fact and a separate parent decision may clone/re-admit the still-relevant intent under a new command ID referencing the old one. It must not erase the original inclusion fact or quietly move one command between prompts.

Admission refusal should be durable and idempotent when the store is operating, so retries return the same reason and operators can audit it. If the store is unavailable/corrupt, return `CONTROL_STORE_UNAVAILABLE`/indeterminate and write nothing elsewhere; never fabricate a refusal receipt in memory.

### Pure activity projection

Activity is a pure fold of P1 canonical facts at `(run_id, session_id, session_generation, observed_seq)`. It is not a mutable column that an adapter or UI can set.

| Activity | Durable fact interpretation | Steering admission/capture |
|---|---|---|
| `idle` | No live task/attempt is assigned to this session generation | Refuse unless the request names an already-admitted runnable task and the daemon is creating its initial boundary; otherwise independent work is a task |
| `waiting_input` | A task is live, no provider child is active, and the controller is at a proven initial or repair prompt-preparation boundary | Admit and eligible for this boundary, subject to cutoff |
| `dispatching` | Prompt manifest is prepared and launch/recovery is in progress | Admit for the next attempt generation; never mutate this already-prepared prompt |
| `active` | Provider start is durably recorded and no exit fact is recorded for that launch | Admit for next attempt; never deliver to the current provider process |
| `settling` | Provider exit is recorded and the parent is reconciling output/review/verification | Admit for next attempt; not eligible until reconciliation creates a boundary |
| `blocked` | An explicit control-plane/manual decision blocks further attempts | Refuse `SESSION_BLOCKED` |
| `exited` | This session generation is terminal and has no successor boundary | Refuse `SESSION_EXITED` |

`waiting_input` does not mean that an interactive terminal happens to show a prompt. It means the daemon holds the correct controller lease and may transactionally prepare the next immutable attempt prompt. `blocked` is not a form of waiting; it requires an explicit unblock/reopen event before any new command can be admitted.

The reducer validates legal transitions and generation lineage. It must retain `unknown/probe_failed` external observations as facts without projecting them to exited or waiting. It exposes `observedSeq`, `headSeq`, and session generation so a dashboard can show staleness. Property tests must prove replay determinism and snapshot-plus-suffix equivalence.

### Admission decision

Under the P1 serialized writer/transaction:

1. authenticate the parent principal outside the untrusted request body;
2. validate schema/bounds and compute the exact immutable payload digest;
3. resolve an existing `command_id`: return exact original result or conflict;
4. load run/session/task facts and derive activity at the transaction head;
5. verify run and session generation, task ownership, nonterminal task, and minimum attempt generation;
6. refuse `blocked`, `exited`, wrong/missing generation, terminal task, mismatched session/task, expired-at-admission, unsupported kind/source, or supersession of a non-pending command;
7. append admission/refusal and update its projection in one transaction;
8. return the canonical sequence and status after commit.

Admission while `dispatching`, `active`, or `settling` is allowed only because the command is explicitly queued for a *future attempt generation*. It has no path to the live process. A request that demands current-turn mutation is refused as `UNSUPPORTED_DELIVERY_MODE` rather than silently deferred.

### Safe prompt-boundary protocol

Initial dispatch and each repair attempt use the same protocol:

1. Acquire/validate the P1 controller lease and generation. Begin the serialized write transaction.
2. Recompute activity and target lineage from canonical facts. Capture `cutoff_seq = headSeq` inside the transaction.
3. Select eligible `pending` commands whose `admitted_seq <= cutoff_seq`, target generations match, and `not_before_attempt_generation <= next_attempt_generation`, ordered by `(admitted_seq, command_id)`.
4. Apply the deterministic count/byte budget. Do not split, truncate, reorder, or coalesce command identities.
5. Render an explicit parent steering section. Each item contains its command ID, source kind, evidence references, and body. It is clearly separated from repository/provider text. Existing dependency summaries and ordinary board context are rendered elsewhere and are not authority.
6. Render the complete exact attempt prompt, allocate the immutable attempt ID/generation, and durably persist the exact bytes as a run-scoped artifact with restrictive permissions, length, SHA-256, renderer/schema version, cutoff, and ordered command IDs.
7. In the same transaction append `attempt_prompt_prepared` plus every `steering_command_included` and update projections. Commit using the P1 durability policy.
8. After commit, re-open/read the artifact through the P1 pinned-path/identity mechanism, verify its byte length and SHA-256, bind the launch ledger to that prompt hash, and launch the provider using those exact bytes.
9. Commands admitted after the cutoff, beyond the budget, or for a later generation remain pending. The prepared prompt is immutable; no late command can be spliced in.

This boundary is intentionally stricter than OpenCode's live runner and Agent Orchestrator's terminal guard. There is no operation between step 7 and provider launch that edits prompt contents. Tmux remains a display sink only.

### Repair, success, and reconciliation behavior

Repair creation is the normal steering boundary. Parent review/verifier feedback first becomes evidence. The parent decides whether to admit a bounded steering command. When the task becomes retryable and the next attempt generation is allocated, the command may be included.

If an attempt succeeds while commands remain pending, the daemon must not silently mark them processed or drop them. It either:

- refuses them as `TASK_TERMINAL_BEFORE_INCLUSION` in a reconciliation transaction; or
- if a deterministic parent rule opens a distinct follow-up task, admits new commands targeted to that task with new IDs and evidence links.

If an attempt fails, inclusion remains a historical fact. The control plane may derive a new repair command that references the old included command and observed failure, but it never reuses the old ID. This avoids duplicate hidden replay and preserves exactly which instructions were present in each attempt.

### Crash/restart protocol

| Crash point | Durable state | Required recovery |
|---|---|---|
| Before admission commit | No command or a complete prior exact result | Retry by same ID; never infer success from request receipt |
| After admission commit, before boundary | Command is pending | Rebuild queue by P1 replay/projection; preserve order and target |
| During selection/render before transaction commit | No manifest/inclusion is visible | Roll back; commands remain pending |
| After manifest/inclusion commit, before artifact verification | Included plus prompt artifact/hash exists | Verify exact artifact. If missing/corrupt, block recovery; never rerender different bytes under same attempt |
| After verified manifest, before provider spawn | Attempt is prepared, no start fact | Resume launch from exact bytes under the same attempt ownership, or explicitly abandon; never select a second prompt concurrently |
| Spawn may have occurred, start fact absent | External effect is uncertain | Reconcile process identity/launch ID. Do not automatically spawn a duplicate and do not claim delivery |
| Provider start recorded, daemon dies | Attempt active | Recover using P1 launch/session identity; command remains only `included` |
| Provider exits, before parent reconciliation | Exit fact or observable uncertain process state | Record/reconcile exit, enter `settling`, process output once with a durable cursor |
| Task terminates with pending commands | Pending commands remain visible | Durably refuse them with terminal reason; never garbage-collect silently |

The prompt artifact and command facts are one logical transaction, but file/database publication may require the P1 artifact protocol. If SQLite cannot atomically contain prompt bytes, use write-and-sync temporary artifact, transactionally bind its immutable content identity, rename/publish under the P1 safe-file protocol, and make incomplete publication a blocking recovery condition. Never write a replacement at the same logical attempt name with different bytes.

### Monitor and dashboard contract

The dashboard remains observational in P2. Its data endpoint should expose:

- run/session/task IDs and generations;
- exact activity, `observedSeq`, `headSeq`, and staleness;
- queued count, oldest pending age, next eligible attempt generation, and boundary reason;
- each command's ID, source kind, admitted sequence/time, bounded redacted preview, status, and stable reason code;
- for included commands, attempt ID/generation, prompt SHA-256, inclusion sequence, and provider-start/exit facts without implying cognition;
- for refused/withdrawn/superseded/expired commands, terminal sequence and linked replacement where applicable.

Agent cards should display `Idle`, `Waiting for next prompt`, `Preparing attempt`, `Active`, `Reconciling`, `Blocked`, or `Exited`. Pending badges must not be shown as needing immediate terminal input. A detail panel should say, for example, “Pending; eligible for repair attempt 4” or “Included in attempt 4; prompt `sha256:…`.”

Use the existing redaction utilities for previews and never return the full prompt artifact through the general dashboard endpoint. Cursor-based polling or SSE should carry P1 event sequence; reconnect resumes from a cursor or gets P1's typed expiration/relist response. Daintree-inspired cancellation becomes a daemon/CLI `withdraw pending command` operation with compare-and-swap; the dashboard may link to it later but must not grow an unauthenticated write route.

The terminal pane remains output-only. A static/call-graph regression test must reject `send-keys`, PTY stdin writes, or a generic “active turn steerer” dependency in P2 paths.

### Legacy board-message migration

Do not auto-import historical `messages.jsonl` rows as commands. They lack stable IDs, authenticated authorship, session/attempt generation, and proof that they were not already included. Reclassifying `from: parent` would be an authority escalation and could replay old review text.

Migration is behavioral:

1. Preserve historical messages as display/audit and ordinary dependency context only.
2. Change parent review/conflict/verifier call sites to admit new `SteeringCommandV1` records through the daemon service.
3. Stop using `gatherContext()` as executable steering delivery. It may continue to render bounded informational context under a non-authoritative heading.
4. At first P2 startup, record a schema/migration fact stating that pre-P2 messages are non-command evidence. Do not synthesize inclusion/refusal status.
5. Add source/static tests proving no generic board message enters the parent steering block.

## Legal reuse and future attribution ledger entry

This audit copied no upstream code, test, UI asset, prose, or schema. Source links and behavioral summaries are research evidence. When P2 is implemented, `docs/upstream-sources.md` must receive entries before the implementation commit using these classifications:

| Subsystem | Reference | Files studied | Classification | Required attribution action |
|---|---|---|---|---|
| Durable input admission/promotion | anomalyco/opencode | session input, SQL/projector, runner, migrations, prompt/runner/API tests, `CONTEXT.md` | `ARCHITECTURAL_INSPIRATION` | Record MIT source/pin and independent RelayForge changes; no copied copyright block required because no code copied |
| Activity/refusal | Untrivial-ai/agent-orchestrator | domain activity/status, session guard, lifecycle/session manager, tmux adapter/tests | `ARCHITECTURAL_INSPIRATION` | Record Apache-2.0 source/pin and explicitly note terminal delivery not used |
| Workflow command lifecycle | temporalio/temporal | Signals/Updates API, state machine, design/tests | `ARCHITECTURAL_INSPIRATION` | Record MIT source/pin and durable-admission improvement |
| Envelope/bounds/CAS tests | google/scion | messages, store/broker, buffer, reconcile, design/tests | `ARCHITECTURAL_INSPIRATION` | Record Apache-2.0 source/pin and changed delivery terminology |
| Pending/progress/cancel UX | daintreehq/daintree | context injection, explicit target, activity/display, docs/tests | `ARCHITECTURAL_INSPIRATION` | Record Apache-2.0 source/pin; preserve NOTICE if any future direct reuse occurs; do not use names/logos |
| Staged role workflow | stellarlinkco/myclaude | workflow skill, topology, prompt/resume/tests/design | `IDEA_ONLY`, code `NOT_USED` | Record AGPL-3.0 and no code/test reuse if the idea materially influences prompts |
| Role-labelled context | OpenBMB/ChatDev | messages, graph edges, websocket handler/tests/docs | `IDEA_ONLY` | Record Apache-2.0 source/pin only if materially used |

If implementation later takes even a small distinctive function, query, test vector, or UI asset from upstream, this classification must be changed to `DIRECT_COPY`, `MODIFIED_COPY`, or `PORTED_IMPLEMENTATION`, with file-level provenance and required license/NOTICE handling. This audit does not grant that permission.

## Failure, recovery, concurrency, and adversarial test matrix

The mandatory sequence is characterization test → integration → unit/integration/failure/real-world/regression tests → commit → test committed HEAD. Upstream tests are design inspiration only and must be independently written.

| Area | Required test | Expected invariant |
|---|---|---|
| Schema | Reject empty body, invalid UTF-8/Unicode policy, oversized scalars/bytes, too many evidence refs, unknown version/kind/source/field | No admission event or partial projection |
| Canonical body | CRLF normalization and digest are stable; meaningful whitespace remains distinct | Exact retry is deterministic without lossy rewriting |
| Parent authority | Operator/review/verifier/control-plane path receives daemon-assigned principal | Request cannot self-declare authority |
| Agent authority | Provider stdout/final report containing a command-shaped object | Remains evidence/text; no command admitted |
| Child capability | Provider environment/process attempts to reach writer API/store | No writer capability is present; no state change |
| Legacy authority | `BoardMessage {from:"parent"}` or wildcard message | Never enters the steering command projection/block |
| Exact retry | Same command ID and exact immutable payload submitted repeatedly and after restart | One admission, identical response/sequence |
| Divergent retry | Same ID with changed body, target, source, expiry, evidence, or delivery kind | Stable `COMMAND_ID_CONFLICT`; original unchanged |
| Concurrent retry | Many threads/process requests admit same exact ID | One admission event/projection |
| Global identity | Same ID used against another run/session | Conflict, never a second command |
| Sequence ordering | Timestamps equal, reversed, or skewed | Order remains `(admitted_seq, command_id)` |
| Wrong target | Missing/wrong run, session, task, generation, or task ownership | Durable refusal with stable reason |
| Terminal task | Command targets completed/cancelled task | Durable `TASK_TERMINAL` refusal |
| Blocked admission | Activity derives `blocked` | Durable `SESSION_BLOCKED`; no pending row |
| Exited admission | Activity derives `exited` | Durable `SESSION_EXITED`; no pending row |
| Unknown/probe failure | Runtime observation is indeterminate | No projection to waiting/exited; admission/capture fails closed as appropriate |
| Waiting admission | Activity is proven `waiting_input` | Admitted and eligible at next cutoff |
| Active admission | Provider is active | Admitted for next attempt only; current provider input unchanged |
| Dispatching admission | Manifest already committed | New command remains pending for later generation |
| Settling admission | Parent reconciling output | Pending; no inclusion until next repair boundary |
| Idle admission | No task versus named runnable task initial boundary | Independent text refused; properly targeted initial-task command allowed by explicit rule |
| State race | Session changes waiting → blocked/exited before capture transaction | Command is refused/terminalized; not included |
| Generation race | Session/task generation advances before capture | Old command refused as stale; no cross-generation leakage |
| Cutoff race | Admit a command immediately after boundary captures head | It remains pending and is absent from exact prompt |
| Deterministic selection | More than one pending command | Stable sequence order independent of query plan/time |
| Boundary budget | More than 32/64 KiB aggregate | Longest complete eligible prefix included; no truncation; suffix pending |
| Concurrent dispatch | Two controllers/threads prepare same next attempt | Lease/CAS produces one attempt manifest and one inclusion per command |
| Withdrawal | Withdraw pending ID, repeat request, race with capture | Idempotent if already withdrawn; capture or withdrawal wins atomically; never both |
| Invalid withdrawal | Withdraw included/refused/expired/superseded ID | Stable terminal conflict; history unchanged |
| Supersession | New command supersedes pending old command | Atomic old terminal/new admitted linkage; no gap/dual inclusion |
| Expiry | Expire before boundary and race expiry with capture | Exactly one terminal outcome; time source injected/tested |
| Prompt separation | Malicious-looking body includes headings/delimiters/JSON/instructions | Exact escaped/bounded item remains inside parent steering block; no structural ambiguity |
| Prompt identity | Prepared prompt read after commit/restart | Exact byte length/hash and ordered IDs match manifest |
| Artifact replacement | Prompt path deleted/replaced/corrupted after prepare | Recovery blocks; never launches rerendered or wrong bytes |
| Crash before admission commit | Kill at each store I/O boundary | No partial command; same-ID retry works |
| Crash after admission commit | Restart before dispatch | Pending command reconstructed once |
| Crash during capture | Kill before/after each event/projection/artifact step | Either all pending or one complete manifest/inclusion; no partial consumption |
| Crash before spawn | Manifest committed, provider absent | Recover exact attempt or explicitly abandon; never create silent duplicate |
| Spawn uncertainty | Child may exist but start fact missing | Reconcile launch identity, do not blindly respawn |
| Crash while active | Daemon dies after provider start | Inclusion fact preserved; session recovery uses generation/launch ID |
| Provider failure | Provider call fails before useful output | Command remains historically included; never relabel delivered/processed |
| Parent listener failure | Notification/SSE listener throws after commit | Admission/inclusion remains canonical and replayable |
| Task succeeds with pending | Success commits before a pending command gets boundary | Pending becomes explicit terminal refusal or remains visibly unresolved until reconciliation; never dropped |
| Task fails with included | Repair follows a failed included attempt | Old command not silently replayed; new intent gets new ID/link |
| Projection | Full replay, snapshot+suffix, repeated replay, property-generated legal histories | Identical command/activity views and observed sequence |
| Invalid history | Impossible state transition, inclusion without prompt manifest, wrong hash/generation | Projection/recovery fails closed |
| Dashboard status | Each activity and command terminal state | Exact truthful labels; no Sent/Delivered/Read/Processed |
| Dashboard staleness | `viewSeq < headSeq`, cursor expired, reconnect | Staleness/cursor behavior explicit; relist on expiry |
| Dashboard redaction | Body/prompt includes known secrets/long data | Preview bounded/redacted; full artifact not returned |
| Dashboard disconnect | SSE/poll disconnect during admission/inclusion | Reconnect from sequence yields each fact once or relist |
| Tmux boundary | Static search/call graph and runtime spy | No `send-keys`, PTY stdin, shell paste, or active-turn steering from P2 |
| One-shot real world | Fake/provider adapters for Codex/Claude/Gemini/OpenCode route | Each receives the exact persisted prompt bytes at new attempt only |
| Committed HEAD | Clean build, unit/integration/fault suite after commit | Tested object equals the committed object handed off |

The adversarial rows above test trust boundaries as ordinary correctness, not as a cybersecurity scan. P2's purpose is reliable parent control, not offensive/defensive security work.

## Scoped implementation packets

P1's implementation may choose final module names; the responsibilities and transaction boundaries below are normative. Do not start a packet until its local reference/attribution entries and tests are prepared.

### P2.1 — Domain schema, events, and pure reducers

Deliver:

- `SteeringCommandV1`, stable reason codes, immutable payload digest, bounds, and exact retry comparison;
- canonical admission/refusal/withdrawal/supersession/expiry/inclusion and prompt-prepared events in the P1 store;
- a command projection and pure seven-state activity reducer with `observedSeq`/generation;
- legal transition validation and snapshot/replay support.

Likely touch points: new control-domain modules near the P1 store, P1 migrations/event registry, and focused schema/reducer/property tests. Do not modify tmux.

Acceptance: schema/idempotency/activity/replay rows in the matrix pass, and divergent duplicate or impossible history fails closed.

### P2.2 — Parent admission and withdrawal service

Deliver:

- daemon-only admission API/service and CLI command with request ID;
- principal/source assignment outside the request body;
- target/generation/activity validation under the serialized P1 transaction;
- exact retry response, durable refusal, pending-only withdrawal, and supersession;
- provider/worker execution with no writer capability.

Likely touch points: parent orchestration service/CLI, P1 store adapter, validation, and integration tests. Keep the dashboard server read-only.

Acceptance: authority, retry, race, wrong-target, blocked/exited, and store-unavailable tests pass.

### P2.3 — Immutable dispatch/repair prompt manifest

Deliver:

- one shared initial/repair boundary capture function;
- transaction-head cutoff, deterministic eligibility/budget selection, explicit parent steering renderer, and renderer version;
- exact run-scoped prompt artifact, length/hash, attempt ID/generation, ordered command IDs, and inclusion facts;
- provider launch from the verified persisted bytes only;
- migration of review rejection, conflict, verifier, and other parent feedback call sites away from generic board messages.

Likely touch points: `src/orchestrator.ts`, prompt renderer, P1 artifact helper/launch ledger, routed provider adapter, and dispatch/repair integration tests. `gatherContext()` remains informational and cannot populate the steering block.

Acceptance: cutoff, budget, concurrent dispatch, exact bytes/hash, provider-route, and no-terminal tests pass.

### P2.4 — Crash recovery and reconciliation

Deliver:

- startup reconstruction of pending/included commands and activity;
- prepared-but-not-started attempt reconciliation using launch identity;
- corrupt/missing/replaced prompt artifact refusal;
- deterministic task-terminal handling for pending commands;
- explicit attempt abandonment and new-ID re-admission policy, never hidden replay;
- fault-injection hooks at every commit/publication/spawn boundary.

Likely touch points: P1 startup reconciler, orchestrator resume/reclaim paths, provider launch bookkeeping, and hard-kill tests.

Acceptance: every crash row in the matrix passes in repeated and parallel runs; no test relies on sleeps for correctness.

### P2.5 — Monitor and dashboard views

Deliver:

- pure data projection for seven activity states and command lifecycle;
- queue count/age/next boundary, target generation, sequence freshness, bounded redacted previews, prompt hash/attempt links, and stable refusal reasons;
- cursor-aware read endpoint/SSE or poll fallback using P1 retained-floor rules;
- terminal pane remains output-only;
- CLI withdrawal UX for pending commands; dashboard stays read-only in this packet.

Likely touch points: `src/dashboard/data.ts`, `src/dashboard/server.ts`, render/static assets, `src/monitor.ts`, and dashboard/CLI tests.

Acceptance: status/freshness/redaction/reconnect/viewport tests pass and UI contains none of the prohibited delivery claims.

### P2.6 — Legacy characterization, attribution, and committed-head gate

Deliver:

- characterization tests showing old board messages remain evidence/context only;
- migration/schema fact and removal of executable dependence on `gatherContext()`;
- `docs/upstream-sources.md` entries with exact pins/files/classifications above;
- architecture/operator documentation for admitted versus included and waiting versus blocked;
- full test sequence on the final committed HEAD.

Acceptance: no historical message is auto-promoted; the attribution ledger is complete; `git diff --check`, lint/typecheck/build, targeted P2 suite, all existing tests, fault tests, and a real provider-adapter prompt-byte test pass on the committed object.

### Concrete parallel file-ownership split

Use this ownership map after P1 publishes its store/event interfaces. Each lane has one owner. New files are exclusive to the named lane; shared existing files have exactly one integration owner. Lanes must not make opportunistic edits outside their set. If P1 lands under different filenames, the P1 owner supplies a compatibility facade with the same responsibilities before these lanes start rather than letting every P2 lane edit storage internals.

| Lane | Exclusive production files | Exclusive test files | Permitted shared-file edit | Integration contract |
|---|---|---|---|---|
| P2-A domain | `src/steering/types.ts`, `src/steering/schema.ts`, `src/steering/activity.ts`, `src/steering/reducer.ts` | `tests/steering-schema.test.ts`, `tests/steering-activity.test.ts`, `tests/steering-replay.test.ts` | None | Exports closed event/payload types, validation, exact semantic digest comparison, pure command/activity folds; imports only P1 public event types |
| P2-B store/service | `src/steering/repository.ts`, `src/steering/service.ts` | `tests/steering-service.test.ts`, `tests/steering-concurrency.test.ts`, `tests/steering-authority.test.ts` | The P1 owner alone adds the steering migration/event registrations to its central store files after review | Implements admission/refusal/withdraw/supersede transactions against the P1 `ControlStore`; contains no renderer or provider code |
| P2-C prompt capture | `src/steering/prompt-block.ts`, `src/steering/prompt-manifest.ts`, `src/steering/capture.ts` | `tests/steering-prompt.test.ts`, `tests/steering-cutoff.test.ts`, `tests/steering-manifest.test.ts` | None | Exposes one `prepareAttemptPrompt(...)` operation returning exact immutable bytes/hash/attempt binding; no launch or orchestration edits |
| P2-D orchestrator integration | `src/steering/integration.ts` | `tests/steering-dispatch.test.ts`, `tests/steering-repair.test.ts`, `tests/steering-provider-boundary.test.ts` | Sole P2 owner of `src/orchestrator.ts` and `src/prompts.ts`; also owns necessary targeted edits in `tests/orchestrator.test.ts`, `tests/review.test.ts`, `tests/resume.test.ts`, and `tests/prompts.test.ts` | Replaces executable `gatherContext()` use with P2 capture at initial/repair attempts and launches exact persisted bytes; does not change P1 storage or dashboard |
| P2-E recovery | `src/steering/recovery.ts`, `src/steering/reconcile.ts` | `tests/steering-recovery.test.ts`, `tests/fixtures/steering-crash-run.ts`, `tests/fixtures/steering-provider.mjs` | None | Consumes P1 artifact/launch identity and P2 reducers; reconciles prepared/start/exit/terminal-task states without prompt rerender or hidden replay |
| P2-F dashboard/monitor | `src/dashboard/steering-data.ts` | `tests/dashboard-steering-data.test.ts`, `tests/dashboard-steering-server.test.ts`, `tests/dashboard-steering-render.test.ts` | Sole P2 owner of `src/dashboard/data.ts`, `src/dashboard/render.ts`, `src/dashboard/server.ts`, `src/monitor.ts` and their existing directly named tests | Read-only DTO/rendering, cursor freshness, redaction, and truthful lifecycle labels; no admission endpoint |
| P2-G CLI/export/docs gate | `src/steering/index.ts` | `tests/steering-cli.test.ts`, `tests/steering-package-exports.test.ts`, `tests/steering-no-terminal.test.ts` | Sole P2 owner of `src/cli.ts`, `src/index.ts`, `tests/cli.test.ts`, `tests/package-exports.test.ts`, `docs/upstream-sources.md`, and P2 public documentation | Wires daemon-only admit/withdraw commands after P2-B; owns final static no-terminal check, attribution ledger, full-suite and committed-HEAD verification |

Merge order is P1 public interface → P2-A → P2-B and P2-C in parallel → P2-E and P2-F in parallel → P2-D → P2-G. P2-F may start against reducer fixtures after P2-A and need not wait for orchestration. P2-E may start against a fake P1 launch/artifact adapter after P2-C. P2-D is intentionally the only P2 lane touching `src/orchestrator.ts`; this prevents prompt-boundary work from colliding with ongoing verifier/cgroup hardening already visible in that file. P2-G is the only lane touching barrel exports, CLI routing, and the upstream ledger, preventing end-of-phase merge churn.

The P1 owner retains exclusive ownership of its SQLite adapter, migration registry, canonical event table, lease, artifact publication primitive, and SSE engine. P2-B supplies the required steering migration/event declaration as a reviewed handoff patch or registration object; it does not fork or bypass the P1 transaction API. If the public P1 interface cannot atomically commit `attempt_prompt_prepared` plus all `steering_command_included` projections, P2-C/D remain blocked by the implementation stop condition below.

## Implementation stop conditions

P2 must stop rather than guess if:

- P1 does not yet expose a transaction that atomically appends canonical events and updates projections;
- P1 has no stable run/session/task generation or controller lease;
- exact prompt bytes cannot be durably bound to an attempt before launch;
- a proposed provider adapter requires terminal injection for steering;
- blocked/exited activity cannot be proven from durable facts;
- author identity would be inferred from agent-controlled text;
- a legacy message would need to be replayed without proof of prior inclusion;
- store corruption or artifact identity is uncertain.

These are architectural prerequisites, not reasons to weaken semantics.

## Final P2 gate

The reference audit is complete. Implementation is approved only for the scoped design above:

- parent-authored, bounded, stable-ID commands in the P1 durable authority;
- pure seven-state activity with hard blocked/exited refusal;
- immutable next-attempt prompt inclusion under one sequence cutoff and transaction;
- exact prompt artifact/hash and attempt-generation linkage before launch;
- crash/restart reconciliation that never silently consumes or replays intent;
- read-only, sequence-aware operator views with truthful `Pending`/`Included` terminology;
- no terminal/PTY injection, no live provider-turn mutation, no agent-authored authority, and no broad broadcast.

OpenCode is the strongest direct reference, Agent Orchestrator the strongest activity/refusal reference, Temporal the strongest workflow lifecycle reference, Scion the strongest bounded coding-agent envelope/CAS reference, and Daintree the strongest operator UX reference. RelayForge synthesizes those strengths into one event-history, explicit-state-machine, generation-fenced architecture and improves them with parent-only authority and immutable attempt-prompt proof.
