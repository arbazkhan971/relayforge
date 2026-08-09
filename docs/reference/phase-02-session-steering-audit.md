# Phase 02 reference audit: durable session steering

Date: 2026-08-09
Status: research gate passed; P2 implemented (CLI live steering E2E 1/1; adjacent 25/25; exact cgroup/no-leak proof) — see [implementation-status.md](../implementation-status.md). At decision time, implementation waited for the P1 public store contract.
Local baseline: `997763e3d5e019b737ab704e69ec11a34c7c3592`

The complete source/test/history/license evidence is recorded in the source-tree
packet `.workflow/ultracode/relayforge-complete/results/audit-p2-session-steering.md`,
which is intentionally not included in the npm package. This document is the
packaged phase-level decision and required Reference Matrix; the
[upstream ledger](../upstream-sources.md) preserves its pins and legal decisions.

## Scope

P2 adds parent-authored instructions that are durably admitted and may be
included in one exact future initial/repair attempt prompt. It does not type
into a terminal, mutate an active provider turn, permit agent-authored control,
broadcast, or claim that an included instruction was delivered, read,
understood, or obeyed.

The implementation must use P1's canonical sequence, serialized writer,
generation fences, transactional projections, immutable prompt artifact and
cursor/freshness model. If those are unavailable, P2 stops rather than adding a
parallel queue.

## Audit method

The mandatory Agent Orchestrator source was inspected first. GitHub searches
then covered coding-agent steering, durable prompt inboxes, workflow
signals/updates, message queues, activity state, context injection and broker
delivery. Tests, migrations, design material, recent history, issues/PRs,
license, NOTICE and relevant file headers were examined at immutable pins.

OpenCode was discovered during this phase rescan and is materially stronger
than the initial corpus for durable input promotion. AgentWrapper resolves to
the same objects as Untrivial and is not counted as an independent reference.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| RelayForge current `997763e` | Board messages, context fold, one-shot initial/repair prompts, output-only tmux | Already has a naturally safe future-attempt boundary and no `send-keys` | Messages lack identity, authority, generation, lifecycle, cutoff, inclusion receipt and crash recovery | MIT | Refactor local behavior; keep viewport-only invariant |
| Untrivial-ai/agent-orchestrator `f65c48e` | Activity/status, session guard, lifecycle/session manager, tmux adapter and tests | Strongest coding-agent distinction between waiting and blocked; final fail-closed state recheck | Delivery remains chunked terminal typing with documented draft/dialog races | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; delivery implementation `NOT_USED` |
| anomalyco/opencode `38e10eb` | Event-sourced input inbox, stable ID, sequence cutoff, atomic prompt promotion, replay/concurrency tests | Strongest direct durable admission and boundary-promotion implementation | Interactive/user/plugin/live-loop model; lacks RelayForge parent authority and task generations | MIT | `ARCHITECTURAL_INSPIRATION`; independently adapt inbox/cutoff transaction |
| temporalio/temporal `023cb7d` | Signals, Updates, workflow-task boundary and lifecycle tests | Strongest mature admitted/accepted/rejected/completed and retry vocabulary | Some pre-acceptance Update state is process-local; distributed machinery oversized | MIT | `ARCHITECTURAL_INSPIRATION` |
| google/scion `91c26b3` | Versioned message envelope, bounded content, broker CAS, stuck-queue/expiry tests | Strong coding-agent target scope, payload bounds and failure tests | `dispatched` can precede external delivery; memory debounce and tmux path | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; delivery code `NOT_USED` |
| daintreehq/daintree `eb989c7` | Context-injection progress/cancel UX, exact terminal target, subscribe/recheck, activity UI | Best operator experience in inspected desktop tools | Renderer-memory singleton queue and terminal injection; activity partly heuristic | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` for UX only |
| stellarlinkco/myclaude `f2e75c1` | Staged feature workflow, topology and new/resume prompts | Useful role/phase decomposition | No durable steering; AGPL coupling | AGPL-3.0 | `IDEA_ONLY`; code/tests `NOT_USED` |
| OpenBMB/ChatDev `4fb2db0` | Role messages, workflow edges and transient reconnect buffer | Useful role-labelled context concepts | Agent-authored conversation and memory transport, not durable parent authority | Apache-2.0 | `IDEA_ONLY` |

## Chosen design

Best implementation discovered: OpenCode's durable input inbox, exact-retry
identity and sequence-cutoff prompt promotion.

Why: it is the only coding-agent reference whose implementation and tests
together prove durable admission, divergent same-ID conflict, concurrent single
promotion, late-arrival exclusion, projection replay and failure preservation
at a provider boundary.

What RelayForge will reuse: architectural ideas and test cases—stable IDs,
canonical admission order, captured cutoff, atomic selection/projection and
replay—not source or schema text.

What RelayForge will change:

- only the authenticated parent control plane can admit a command;
- targets bind run, session, task and attempt generations;
- blocked/exited/terminal/stale targets are durable refusals;
- the only P2 delivery kind is `steer_next_boundary`;
- selection binds command IDs to persisted exact prompt bytes/hash and one
  attempt before launch;
- no live session/terminal path exists;
- lifecycle terms describe provable facts only.

How RelayForge improves it: admission, refusal, withdrawal, supersession,
expiry and inclusion all live in P1 history; the provider consumes a verified
immutable prompt artifact; recovery knows exactly which attempt contained each
command; sequence-aware views never mislabel inclusion as cognition.

## Domain contract

A `SteeringCommandV1` has a caller-supplied stable ID, schema/kind, run/session/
task and generation target, minimum eligible attempt generation, daemon-assigned
parent principal and source kind, bounded evidence references, normalized exact
UTF-8 body/digest, admission sequence/time, optional expiry and optional pending
command it supersedes.

Body is nonempty, at most 8,192 Unicode scalar values and 16 KiB UTF-8. At most
32 evidence references are allowed. A boundary includes at most 32 commands and
64 KiB of complete steering block. Ordering is `(admittedSeq, commandId)`, never
timestamp. Line endings normalize to LF; meaningful whitespace and Unicode are
not otherwise changed.

An exact same-ID retry returns the canonical prior result. Any immutable-field
difference is `COMMAND_ID_CONFLICT`. Omitted IDs, unknown fields/version/kind/
source and command bodies outside the bounds fail before mutation.

The only lifecycle states are:

- `pending`;
- `included(attempt, generation, promptSha256, seq)`;
- `refused(reason, observedSeq)`;
- `withdrawn(seq)`;
- `superseded(byCommand, seq)`; and
- `expired(seq)`.

All except pending are terminal for that command ID. P2 does not use `sent`,
`dispatched`, `delivered`, `read` or `processed`.

## Pure activity and legality

Activity is derived from canonical facts at a run/session generation and
observed sequence:

| Activity | Meaning | Steering rule |
|---|---|---|
| `idle` | no live assignment | normally refuse; explicit runnable initial-task boundary may admit |
| `waiting_input` | proven initial/repair prompt-preparation boundary | admit and eligible at captured cutoff |
| `dispatching` | immutable prompt prepared, launch/recovery underway | admit for a later attempt; current prompt immutable |
| `active` | provider launch started and not exited | admit for a later attempt only |
| `settling` | provider exited and parent is reconciling | pending until a later repair boundary |
| `blocked` | explicit parent/manual block | refuse `SESSION_BLOCKED` |
| `exited` | session generation terminal | refuse `SESSION_EXITED` |

Unknown/probe-failed runtime evidence never becomes exited or waiting. Activity
includes observed/head sequence and generation so stale views are explicit.

## Prompt-boundary transaction

At each initial/repair boundary the parent:

1. validates controller lease and generation in the P1 writer transaction;
2. re-derives activity and lineage and captures transaction `headSeq` as cutoff;
3. selects eligible pending commands at/below cutoff in canonical order;
4. takes the longest complete prefix within count/byte limits;
5. renders a structurally separate, versioned parent steering block and the
   complete attempt prompt;
6. persists exact private prompt bytes plus length/hash/renderer/cutoff/ordered
   IDs and allocates immutable attempt identity;
7. atomically appends prompt-prepared and every inclusion/projection fact;
8. after commit, reopens and verifies the artifact identity/bytes/hash and
   launches the provider from exactly those bytes.

Later arrivals and over-budget suffixes remain pending. A prepared prompt is
never edited. If file/database publication cannot be made recoverable, the
boundary fails closed.

## Recovery and terminal behavior

Before admission commit a retry proves absence or returns the prior exact
result. After admission, replay reconstructs pending state. A crash during
capture leaves all pending or one complete manifest/inclusion transaction.
Prepared-but-not-started recovery reuses exact bytes under the same attempt or
explicitly abandons it; uncertain spawn identity never causes a blind duplicate.

Inclusion remains historical after provider failure. A retry instruction gets a
new command ID linked to prior evidence. When a task becomes terminal, pending
commands are durably refused or remain visibly unresolved until the explicit
reconciliation transaction; they are never silently dropped or called handled.

Legacy board messages remain informational evidence only. `from: "parent"` is
not authentication, historical records are never auto-promoted, and
`gatherContext()` cannot populate the steering block.

## Required characterization and failure coverage

The implementation matrix includes strict schema/body bounds; parent versus
agent authority; exact/divergent/concurrent/global ID reuse; wrong target and
every activity state; state/generation/cutoff races; deterministic budget
selection; concurrent dispatch; withdrawal/supersession/expiry races; prompt
delimiter and artifact replacement cases; kill points before/after admission,
capture, publication and spawn; replay/snapshot equivalence; invalid history;
truthful redacted UI and cursor recovery; static/runtime proof of no tmux/PTY
input; real fake-provider exact-byte checks; and full committed-head validation.

## Legal conclusion

No upstream source, SQL, test, UI asset, comments or schema is approved for
direct/modified copy. OpenCode, Agent Orchestrator, Temporal, Scion and Daintree
are architectural inspiration. MyClaude and ChatDev are idea-only/not-used as
specified. Any future direct reuse requires a same-change ledger amendment and
applicable headers/NOTICE handling.

## Gate result

The P2 research gate is complete. Implementation is governed by
[ADR 003](../adr/003-durable-session-steering.md) and may begin once P1 exposes
the required atomic store/event/artifact interfaces. P2 completion still
requires focused, failure, real-process/provider, full-suite and committed-head
verification.
