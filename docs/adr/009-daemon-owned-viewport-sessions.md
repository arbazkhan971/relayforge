# ADR 009: daemon-owned viewport sessions (durable terminal ownership)

- Status: Accepted and implemented (Phase 0-2 of docs/herdr-runtime-parity.md)
- Date: 2026-08-12
- Decision owners: RelayForge maintainers
- Research gate: [Herdr runtime parity roadmap](../herdr-runtime-parity.md)

## Context

RelayForge's control plane (ADR 002) already gives the parent durable truth for
run facts, and its tmux viewport (membership-tagged sessions, exact-identity
client) gives humans a terminal to watch agents. What neither owns is a durable
record of "which terminal session belongs to which run/role and what state it is
in" that a CLI client can resolve after any other client dies. Today the tmux
client re-derives membership from tmux tags at command time; `relayforge attach`
only accepts an exact session name and cannot target a role.

Herdr's core claim is that a server owns the terminals, every UI is only a
client, and the work survives client death. RelayForge already has the durable
parent (the daemon/run parent) — it needs the *terminal-ownership fact layer*.

## Decision

The run parent (or control daemon) is the sole WRITER of durable viewport-session
facts; CLI clients are only READERS plus callers of exact-identity tmux verbs.

- New durable record type: `ViewportSession` (runId, role, sessionName, socket?,
  pid?, ownerPid, createdAt, lastActiveAt, state
  `running|blocked|done|idle|exited`), stored per run under
  `.loop/runs/<project>/<runId>/viewports/` as atomic JSON files
  (`src/viewport-registry.ts`).
- Writers: `recordOpenedViewport` (after `relayforge tmux new` succeeds),
  `markRunViewportsExited` (after `tmux kill`), `pruneRegistryViewports`
  (`tmux prune`, exited facts older than 7 days). All writes are best-effort
  bookkeeping and NEVER change tmux exit semantics.
- Readers: `resolveAttach` (`relayforge attach` resolves a role argument through
  durable facts; a session-shaped or unknown argument is attached verbatim as an
  exact tmux name; failure degrades to the legacy default team session).
- The registry never spawns, kills, or grants containment — those remain the
  tmux client and the sandbox/cgroup machinery.

## Consequences

- Durable viewport facts survive any client's death; re-attach resolves from
  state, not from tags observed at command time (Phase 2 landed).
- tmux remains optional and fail-closed when unavailable; nothing about the
  containment or settlement path changes.
- Remote attach (Phase 3) can resolve targets from these same durable facts
  over ssh without touching tmux internals on the client side.
- A damaged or missing fact file never crashes a client: JSON storage reads
  fail to an empty list.
- Future writers (daemon, run parent with provider pids) can enrich records
  with pid when the parent knows it; attachTargets then reports live targets.
