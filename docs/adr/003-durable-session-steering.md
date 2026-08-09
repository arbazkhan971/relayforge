# ADR 003: parent-owned durable session steering

- Status: Accepted and implemented (CLI live steering E2E 1/1; adjacent 25/25; exact cgroup/no-leak proof — see [implementation-status.md](../implementation-status.md))
- Date: 2026-08-09
- Decision owners: RelayForge maintainers
- Research gate: [Phase 02 session-steering audit](../reference/phase-02-session-steering-audit.md)

## Context

Operators need to add bounded direction while a coding task evolves. Writing to
a PTY/tmux pane is not a safe or truthful control mechanism: a prompt may be a
draft, an approval dialog or a shell; state can change after a guard; an
acknowledged write does not prove provider receipt. At decision time,
RelayForge's generic board messages also lacked durable identity, generation,
lifecycle and one-shot prompt inclusion.

## Decision

RelayForge represents steering as a parent-authored canonical P1 command. A
command may be included only while preparing one immutable future initial or
repair attempt prompt. P2 deliberately has no live-turn or terminal delivery
implementation (future-boundary only).

Admission proves only that a command is durably pending or durably refused.
Inclusion proves only that the exact command ID is bound to the persisted prompt
bytes/hash for a named attempt. RelayForge never labels that fact delivered,
read, processed or obeyed.

## Authority and identity

The daemon is the sole writer and assigns the authenticated parent principal.
Permitted provenance kinds are `operator`, `review_gate`, `verifier` and
`control_plane`; provenance is not itself authorization. Provider output,
repository content, review comments and legacy messages remain evidence.

Every request supplies a stable command ID and exact run/session/task plus
generation target. Exact retry is idempotent. Reusing an ID with any changed
immutable field conflicts. Provider children receive no writer capability or
control credential.

## Activity

The P1 reducer derives exactly `idle`, `waiting_input`, `dispatching`, `active`,
`settling`, `blocked` or `exited`, with observed/head sequence and generation.
Blocked and exited targets refuse admission. Active/dispatching/settling may
admit only for a later attempt; no command can reach the current process.
`waiting_input` denotes a controller-owned prompt boundary, not a terminal
heuristic.

## Command lifecycle

The durable projection is one of pending, included, refused, withdrawn,
superseded or expired. Terminal states never regress. Included commands are not
silently replayed into later attempts; new intent uses a new linked ID.

Commands are ordered by canonical admission sequence and ID. Bodies/evidence
and boundary aggregates have exact schema and byte/count limits. A boundary
takes a deterministic complete prefix and leaves the suffix pending; it never
truncates or coalesces command identities.

## Prompt preparation

Initial and repair attempts call one shared transaction boundary. It revalidates
lease, generation, task lineage and activity; captures a head-sequence cutoff;
selects eligible pending commands; renders the complete versioned prompt;
durably binds exact private bytes, length, hash, attempt generation, cutoff and
ordered command IDs; appends prompt/inclusion facts atomically; then verifies
the artifact and launches from those exact bytes.

An arrival after cutoff cannot modify the prepared prompt. A missing/replaced/
corrupt artifact blocks recovery. A prepared attempt is resumed under the same
identity or explicitly abandoned; uncertain external spawn never triggers a
blind duplicate.

## Interfaces and presentation

The CLI/daemon admission and pending-command withdrawal paths are parent
mutations, not unauthenticated dashboard endpoints. Dashboard and monitor remain
read-only and display activity, sequence freshness, pending counts/age/next
boundary, bounded redacted previews, refusal reasons and attempt/hash linkage.
They use only `Pending`, `Included`, `Refused`, `Withdrawn`, `Superseded` and
`Expired` terminology.

Tmux remains an output viewport. P2 code must contain no `send-keys`, PTY stdin,
shell paste or generic active-turn steering dependency.

## Migration

Historical `messages.jsonl` rows are retained as context/audit only. They are
never treated as commands because authorship, generation and prior inclusion
cannot be proven. Parent review/verifier call sites create new durable commands;
generic `gatherContext()` cannot render the steering block.

## Consequences

Positive:

- parent intent survives crash and retries without duplication;
- command legality and attempt inclusion are deterministic and auditable;
- the provider launch consumes the same bytes the store records;
- blocked/exited refusal and generation fencing eliminate blind injection;
- operator UI remains truthful about what RelayForge can prove.

Costs:

- steering waits for a safe future prompt boundary;
- prompt artifact publication and spawn reconciliation add explicit recovery
  states;
- P2 depends on P1's atomic event/projection and artifact primitives;
- active-turn interactive steering is intentionally unavailable.

Rejected alternatives:

- tmux/PTY typing after a state check;
- sleep/retry/Enter nudges;
- in-memory queue or debounce as authority;
- agent-authored/broadcast messages;
- mutating an already-prepared prompt;
- interpreting an external write attempt as delivery;
- auto-importing legacy board messages as commands.

## Verification gate

Acceptance requires the complete phase audit matrix: schema and authority,
idempotency/conflict/concurrency, activity and race cases, deterministic
selection, prompt artifact/hash, crash/spawn recovery, terminal reconciliation,
projection replay, truthful/redacted views, no-terminal static/runtime proof,
real adapter exact-prompt tests, full suite/build and committed-head rerun.
