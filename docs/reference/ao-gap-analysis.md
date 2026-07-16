# Agent Orchestrator comparison and parity gaps

## Scope and method

This is a capability comparison, not an implementation recipe. Agent Orchestrator
(AO) is an Apache-2.0 reference consulted from the read-only snapshot at
`/home/arbaz/loop-ao/reference/agent-orchestrator`; it informed the questions in
this document, but none of its code, comments, or prose is reproduced here.

Each statement about Loop Orchestrator below is tied to a current source file in
this checkout. “Gap” means that the cited implementation does not provide the
named AO-style capability today; it does not mean that AO’s design should be
ported without an ADR. In particular, containment, parent ownership, clean-tree
gates, and settlement evidence remain Loop Orchestrator requirements.

| Area | Current Loop Orchestrator evidence | AO reference evidence | Parity direction |
| --- | --- | --- | --- |
| Durable coordination | Parent-side JSONL task, event, and message journals; folded task views | SQLite records, lifecycle writer, and change-data-capture fan-out | Preserve an append-oriented board and add derived views/events deliberately |
| Display state | Task state is folded from board events; dashboard derives a small agent-card state | Durable session facts are transformed into display state at read time | Make a documented, pure activity-state projection available to every control surface |
| Control plane | One-shot CLI plus a loopback dashboard HTTP server | Long-lived daemon, REST, SSE, terminal WebSocket | Introduce a loopback-only `loop serve` control plane before live features |
| Session interaction | Context is injected when dispatching an attempt; tmux is a viewport | Running sessions accept messages and distinguish input-needed from blocked | Add a parent-owned queue and safe steering semantics |
| Source-control feedback | Git/worktree helpers and review/repair flow exist, but no PR observer loop | SCM observer polls PR, checks, and review facts and notifies lifecycle | Add a trusted-parent PR observer that creates normal repair work |
| Harnesses | Provider branches are implemented in one module | Worker and reviewer adapters are registered behind contracts | Extract and test a registry before increasing provider coverage |
| Observability | Polling dashboard and terminal captures | CDC/SSE updates and multiplexed terminal streams | Upgrade transport while retaining loopback and redaction guarantees |
| Safety/accounting | Sandboxed, scoped execution and evidence-gated authoritative settlement | Isolated workspaces and runtime management | Keep Loop’s stricter safety model when designing parity features |

## 1. Persistence and board ownership

Loop’s board is **append-oriented**, not immutable history. `tasks.jsonl`,
`events.jsonl`, and `messages.jsonl` are appended as the normal coordination
path, and `foldBoard` turns tasks plus events into current task views
([`src/board.ts`](../../src/board.ts#L16-L214)). The parent orchestrator may also
compact `events.jsonl`: it folds the current state and atomically replaces that
event file while holding an advisory lock; SMEs do not invoke the compactor
([`src/board.ts`](../../src/board.ts#L289-L322)). The board directory and journals
are created with ownership, mode, regular-file, and symlink checks
([`src/board.ts`](../../src/board.ts#L100-L145)).

AO persists session, PR, check, review, and change-log records in SQLite, then
uses database changes as the source of event delivery
([`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L340-L418),
[`backend/internal/storage/sqlite`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/storage/sqlite)).
Its lifecycle manager is documented as the canonical mutation path for session
facts ([`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L480-L581)).

**Gap and guardrail.** Loop has durable parent-owned file state but no database
change log, service-owned lifecycle reducer, or retained event-stream API. P1
should first decide whether a derived JSONL event view is sufficient; adding a
database dependency is not implied. Any new write path must retain parent board
ownership, and compaction must remain an explicit part of the persistence
semantics rather than being described as append-only history.

## 2. Status derivation

`foldBoard` initializes each task as open, applies claims and later events, and
counts failures for bounded repairs ([`src/board.ts`](../../src/board.ts#L175-L238)).
The dashboard derives its overview, graph, attention list, and four-value agent
card state from board events/views and cost reads; those functions are pure reads
that are safe for the current polling model
([`src/dashboard/data.ts`](../../src/dashboard/data.ts#L15-L18),
[`src/dashboard/data.ts`](../../src/dashboard/data.ts#L196-L233)).

AO explicitly separates stored facts from presentation state. Its architecture
documents the observation-to-update-to-derivation pipeline and says display
status is computed rather than stored
([`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L21-L45),
[`backend/internal/domain/status.go`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/domain/status.go)).

**Gap and guardrail.** Loop has task-status projection, not a shared
per-session lifecycle projection such as active, idle, waiting, blocked, or
exited. P1/P2 should add a pure derived function over board/ledger facts, with
no stored display status and no agent authority to manufacture a lifecycle fact.

## 3. Daemon and control plane

Loop’s dashboard starts an unauthenticated Node HTTP server only on
`127.0.0.1`, exposes JSON endpoints and a static page, and redacts configuration
before returning it ([`src/dashboard/server.ts`](../../src/dashboard/server.ts#L16-L18),
[`src/dashboard/server.ts`](../../src/dashboard/server.ts#L160-L250)). The page
fetches updates every 2.5 seconds ([`src/dashboard/render.ts`](../../src/dashboard/render.ts#L248-L250)).
The monitor similarly redraws from a timer ([`src/monitor.ts`](../../src/monitor.ts#L138-L145)).

AO places REST controllers, SSE delivery, and terminal WebSocket handling in a
long-running local HTTP daemon
([`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L48-L120),
[`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L682-L765)).
Its CLI is intentionally a client of that daemon rather than a direct storage or
runtime caller ([`docs/cli/README.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/cli/README.md#L1-L18)).

**Gap and guardrail.** The existing dashboard server is not a persistent run
control plane and has no REST/SSE contract for board mutations or lifecycle
events. P1 should create a loopback-only daemon boundary and make the CLI a
client of it gradually. It must preserve the dashboard’s redaction behavior and
must not make its unauthenticated listener externally reachable.

## 4. Session steering and terminal access

Loop records free-form board messages and builds task context from messages
addressed to a role plus dependency results
([`src/board.ts`](../../src/board.ts#L67-L73),
[`src/board.ts`](../../src/board.ts#L249-L273)), and injects that context into
the prompt only when an attempt is dispatched
([`src/orchestrator.ts`](../../src/orchestrator.ts#L2143-L2151)). That is
dispatch-time context, not a delivery protocol for a process already running. Loop also owns tmux names
and client/workflow helpers for its optional viewport
([`src/tmux.ts`](../../src/tmux.ts), [`src/tmux-client.ts`](../../src/tmux-client.ts),
[`src/tmux-workflow.ts`](../../src/tmux-workflow.ts)).

AO maps `ao send` to a session route, and its architecture describes feedback
being nudged back through the agent/runtime boundary
([`docs/cli/README.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/cli/README.md#L37-L78),
[`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L311-L336)).
Its terminal multiplexing design covers attach/detach and a browser-facing
transport ([`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L766-L836),
[`backend/internal/terminal`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/terminal)).

**Gap and guardrail.** P2 should turn a parent-authored board queue into
instructions injected at the next safe prompt boundary, rather than giving
agents write access to the board or indiscriminately writing to a terminal. Its
derived state must distinguish waiting for input from blocked, and steering must
refuse the latter until its semantics are defined.

## 5. SCM feedback

Loop creates and removes isolated git worktrees through source-controlled
helpers ([`src/worktree.ts`](../../src/worktree.ts)). The orchestration path has
review/repair stages, but its current CLI and source layout do not expose a
`loop pr` observer command or a continuously polling SCM observer
([`src/cli.ts`](../../src/cli.ts), [`src/orchestrator.ts`](../../src/orchestrator.ts)).

AO has a provider-neutral SCM observer contract with PR listing, check reads,
failed-check log tails, and review-thread reads
([`backend/internal/observe/scm/observer.go`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/observe/scm/observer.go#L27-L65)).
It starts a polling loop and persists meaningful observations before lifecycle
notification ([`backend/internal/observe/scm/observer.go`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/observe/scm/observer.go#L166-L187),
[`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L583-L680)).

**Gap and guardrail.** P3 should place GitHub/network access in the trusted
parent observer, persist only validated observation facts, and turn failures or
comments into ordinary repair tasks. Provider sandboxes must never acquire SCM
credentials through this feature.

## 6. Provider and reviewer adapter registry

Loop supports configured provider types and constructs provider commands in
one module ([`src/providers.ts`](../../src/providers.ts)). The orchestrator calls
that command construction before launching a contained child
([`src/orchestrator.ts`](../../src/orchestrator.ts#L1930-L1986)). This is concrete
provider support, but not yet a separately registered adapter contract with
conformance coverage for spawn, output normalization, usage, limit
classification, and read-only mode.

AO builds a stable worker registry from concrete adapter constructors and also
maintains a distinct reviewer resolver
([`backend/internal/adapters/agent/registry/registry.go`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/adapters/agent/registry/registry.go#L37-L108),
[`backend/internal/adapters/reviewer/registry.go`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/adapters/reviewer/registry.go#L1-L61)).
The backend structure guide describes adapter ownership and rules for adding a
new one ([`docs/backend-code-structure.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/backend-code-structure.md#L595-L643),
[`docs/backend-code-structure.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/backend-code-structure.md#L850-L870)).

**Gap and guardrail.** P4 should extract Loop’s existing behavior behind a
strict TypeScript registry without widening launch authority. Every adapter must
still use the same sandbox, scope, transcript, and settlement path; a registry
cannot become an escape hatch for arbitrary host commands.

## 7. Observability and dashboard

Loop already renders board progress, cost totals, attention items, role cards,
and a mixed event/message timeline from local state
([`src/dashboard/data.ts`](../../src/dashboard/data.ts#L105-L150),
[`src/dashboard/data.ts`](../../src/dashboard/data.ts#L235-L285)). Its HTTP
server binds loopback-only with project-scoped run state
([`src/dashboard/server.ts`](../../src/dashboard/server.ts#L75-L110)) and
captures only tmux panes the project provably owns — by stamped identity, never
by name substring ([`src/dashboard/server.ts`](../../src/dashboard/server.ts#L228-L236)).

AO’s CDC poller feeds a broadcaster, which fans out updates to SSE and other
subscribers ([`backend/internal/cdc/poller.go`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/cdc/poller.go),
[`backend/internal/cdc/broadcast.go`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/cdc/broadcast.go)).
The reference architecture joins those updates with terminal multiplexing
([`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L400-L418),
[`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L766-L836)).

**Gap and guardrail.** P5 can replace polling with SSE only after P1 defines
event identity, replay, and disconnect behavior. A session inspector can expose
derived data and already-redacted transcript tails, but it must remain
dependency-free, loopback-only, and should keep a polling fallback.

## 8. Containment and settlement: where Loop deliberately differs

AO documents isolated workspaces, a runtime layer, and process observation
([`docs/architecture.md`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/docs/architecture.md#L48-L120),
[`backend/internal/adapters/workspace/gitworktree/workspace.go`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/adapters/workspace/gitworktree/workspace.go),
[`backend/internal/observe/reaper`](../../../../../../../../../home/arbaz/loop-ao/reference/agent-orchestrator/backend/internal/observe/reaper)). That is useful
inspiration for lifecycle boundaries, but it is not a reason to relax Loop’s
execution proofs.

Loop builds OS-sandboxed provider commands in `src/sandbox.ts` and requires a
strong scope backend for real execution rather than accepting an environment
toggle ([`src/sandbox.ts`](../../src/sandbox.ts),
[`src/scope.ts`](../../src/scope.ts#L73-L100)). A scope is enrolled before the
provider executes and is durably recorded before its gate releases the provider:
the launch handshake keeps the child blocked on a gate fd — alive, inside the
scope, having exec'd nothing — until the scope's exact identity is fsynced to
the run's scope journal ([`src/scope.ts`](../../src/scope.ts#L253-L301),
[`src/orchestrator.ts`](../../src/orchestrator.ts#L1274-L1363),
[`src/orchestrator.ts`](../../src/orchestrator.ts#L2960-L2997)). Worktree
isolation is likewise implemented locally ([`src/worktree.ts`](../../src/worktree.ts)).

Loop also has an accounting property absent from the AO comparison target.
Failure paths that never produce a normalized verdict (spawn refusals, transport
faults) settle directly as uncertain: the full reservation is retained and no
fallback is authorized ([`src/ledger.ts`](../../src/ledger.ts#L1173-L1186),
[`src/orchestrator.ts`](../../src/orchestrator.ts#L1967-L1976)). Every
*completed* call with a normalized verdict, by contrast, is sent through the
settlement kernel ([`src/orchestrator.ts`](../../src/orchestrator.ts#L2009-L2024)),
which re-reads the durable transcript, replays framing/provider normalization,
and re-probes the containment scope — and which can itself settle a completed
call as uncertain when the evidence does not hold up
([`src/settlement-kernel.ts`](../../src/settlement-kernel.ts#L223-L299)). Only
evidence-backed outcomes receive authority — a trusted success may lower cost,
and only a re-derived canonical rejection buys a trusted fallback
([`src/settlement-kernel.ts`](../../src/settlement-kernel.ts#L44-L90),
[`src/ledger.ts`](../../src/ledger.ts#L1218-L1242)).

**Decision rule for every parity pillar.** When an AO-inspired control-plane,
session, SCM, or adapter feature conflicts with Loop’s fail-closed sandbox,
parent-owned board, clean-tree, scope, or settlement requirements, Loop’s rule
wins. The relevant future ADR must describe the preserved invariant and the
test that proves it.

## Source index

Loop evidence above is limited to `src/board.ts`, `src/dashboard/data.ts`,
`src/dashboard/render.ts`, `src/dashboard/server.ts`, `src/cli.ts`,
`src/monitor.ts`, `src/orchestrator.ts`, `src/providers.ts`, `src/sandbox.ts`,
`src/scope.ts`, `src/settlement-kernel.ts`, `src/ledger.ts`, `src/tmux*.ts`, and
`src/worktree.ts`. AO evidence is limited to the cited paths below the vendored
Apache-2.0 snapshot. This index is intentionally not a claim that either product
has capabilities beyond the sections above.
