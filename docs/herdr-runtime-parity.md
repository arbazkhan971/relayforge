# RelayForge runtime parity: daemon-owned agent terminals (Herdr-class runtime)

Status: **Phases 0, 1 and 2 land with 1.0.0-rc.1+1** — roadmap, durable
viewport-session registry, and CLI-as-client wiring are implemented and green
(`src/viewport-registry.ts`, `src/viewport-wiring.ts`, CLI attach/tmux wiring,
and their test suites). Phase 3 (remote/SSH + macOS dev-mode) is the next slice
and is gated on the Linux runner and a dedicated safety ADR.

This document is the ordered plan to give RelayForge Herdr-class runtime capability:
a parent daemon that OWNS agent terminal sessions, so work survives client death,
sessions re-attach from any tty, and per-agent semantic state is a first-class
durable fact. It mirrors the project's wave discipline (ADRs, tests + docs in the
same diff, fail-closed guards) and depends on the already-landed P1 control plane
and P2 activity derivation.

## Why: runtime vs manager apps

[Herdr](https://herdr.dev) argues the market split is "apps that manage a herd"
(Superset, Conductor, Emdash — quit the app and the work dies with it) versus "a
runtime where agents live" (a background server owns the PTYs; every UI — TUI,
CLI, ssh — is only a client). RelayForge today sits between the two:

| Capability | RelayForge today | Herdr | Superset |
| --- | --- | --- | --- |
| Kind of thing | headless orchestrator + control daemon + optional tmux viewport | runtime + clients | desktop manager app |
| Work survives its UI/client dying | yes (headless by default; durable SQLite facts) | yes (server owns PTYs) | no (work dies with the app) |
| Daemon owns agent terminal sessions | membership tags on tmux sessions, CLI-created | server-owned sessions, durable | app-owned |
| Re-attach from any tty | `relayforge attach` (same host, tmux) | yes (any tty, ssh) | no |
| Semantic per-agent state | P2 derivation active/idle/waiting-input/blocked/exited (durable) | working/blocked/done/idle | workspace status |
| Direct attach to ONE agent | not exposed as durable fact | yes | — |
| Runs inside existing terminal | yes (tmux + loopback browser) | yes | replaces it |

RelayForge's control plane (P1: durable SQLite, loopback REST/SSE, ownership
leases) is already the "server owns the state" half. What is missing is the
*terminal ownership* half: durable, daemon-owned viewport-session records that
clients resolve for attach/monitor instead of re-inventing membership from tmux
tags, plus direct per-agent attach.

## Phases

### Phase 0 — ADR + this roadmap (complete in this change)

Goal: decide the ownership contract and sequence the work.

Deliverables:
- `docs/herdr-runtime-parity.md` (this file).
- ADR **009: daemon-owned viewport sessions** — the daemon (or a run parent) is
  the sole writer of durable viewport-session facts; clients only READ them and
  call exact-identity tmux verbs; no client-derived authority. (ADR to land with
  Phase 1's registry.)

Guardrails: no client-side invention of session facts; tmux stays optional and
require-fail-closed when unavailable; no new runtime dependency beyond Node
built-ins (the tmux client stays in-tree).

Definition of done: roadmap reviewed; ADR accepted; delivery slices identified.

### Phase 1 — durable viewport-session registry (lands with 1.0.0-rc.1+1)

Goal: a pure, injectable, durable registry of viewport sessions, keyed by
run/role, so "the daemon owns the terminals" is a PROVABLE fact that survives any
client's death and re-attach resolves from durable state.

Deliverables:
- `src/viewport-registry.ts` — `ViewportSession` (runId, role, sessionName,
  socket?, pid?, ownerPid, createdAt, lastActiveAt, state
  `running|blocked|done|idle|exited`), `ViewportRegistry` with a `Storage`
  interface (in-memory default + `JsonViewportStorage` atomic per-run files),
  `record` (idempotent latest-wins), `updateState`, `resolve(runId, role)`,
  `list(runId)`, `attachTargets(runId)`, `pruneByAge(maxAgeMs, clock)`,
  `remove`. Strict id bounds, 10k-record cap, no new deps.
- `tests/viewport-registry.test.ts` — green unit suite (idempotency, transitions,
  resolve, ordering, prune w/ fake clock, validation, JSON round-trip).
- ADR 009 acceptance record.

Guardrails: registry never spawns or kills anything — it only records durable
facts; writers are the run parent/daemon; state is a closed union; records are
bounded and validated.

DoD: `npx vitest run tests/viewport-registry.test.ts` green; typecheck/build
green; ADR accepted.

### Phase 2 — daemon-owned wiring (attach/monitor/tmux) — implemented

Goal: make the CLI a CLIENT of the registry.

Status: **implemented** — `src/viewport-wiring.ts` + wiring in `src/cli.ts`
(`attach` resolves role/session through durable facts with legacy fallback;
`tmux new` records; `tmux kill` marks exited; `tmux prune` prunes stale facts;
all bookkeeping is best-effort and never changes tmux exit semantics).

Deliverables:
- `relayforge attach [session]` resolves attach targets through the registry
  (falling back to exact-name tmux when no record exists — unchanged legacy
  path), and supports `attach <role>` (direct per-agent attach).
- `relayforge tmux new/show/kill/prune` write/read registry records (create →
  `record(running)`; `show`/`monitor` → read + `updateState`; kill/prune →
  `remove`/`exited`), driven by the same injectable `TmuxClient`.
- `relayforge monitor` surfaces registry `state` per pane (P2 derivation remains
  authoritative for run semantics; registry state is the terminal-ownership
  view, non-authoritative presentation).

Guardrails: tmux membership tags remain the transport-level truth; registry is
presentation/ownership bookkeeping and cannot grant containment; no steering via
the terminal path.

DoD: CLI subprocess tests for attach-by-role and restart-resolution (simulated
client death between record and attach) pass on hosts with tmux; unit paths green
without tmux.

### Phase 3 — runtime independence (remote + machines + platform walls)

Goal: "close the lid, keep working" and any-tty attach.

Deliverables:
- Remote box flow: run the control daemon + viewport sessions on a Linux box;
  `relayforge attach` reaches it over ssh with a bounded tunnel (contributor
  runbook `docs/linux-runner-runbook.md` + `scripts/check-relayforge-runner.mjs`
  land in this phase).
- Platform walls: the product currently fails closed on macOS for **every**
  `run` (ledger anchor needs `/proc/self/fd`; process scope needs cgroup v2) —
  documented in `docs/implementation-status.md`. A loudly-flagged
  `relayforge dev` host mode (weakened ledger anchoring + no process-scope
  claim, ineligible for release receipts) is the prerequisite for Herdr-style
  macOS work; it must stay explicitly non-publishable.

Guardrails: remote attach never forwards provider credentials outside the
parent-owned boundary; remote host must satisfy the release-runner checkset for
any execute; macOS dev-mode receipts are never treated as release evidence.

DoD: attach-over-ssh E2E on the Linux runner; macOS dev-mode dry-run works;
release gates still refuse macOS dev-mode.

## Out of scope (fail-closed / explicit no)

- No terminal input injection or steering through the viewport (P2 steering
  remains future-boundary-only, ADR 003).
- No generic cgroup/sandbox delegation, no environment escape hatches.
- No new third-party PTY dependency: tmux stays the PTY owner; we own the
  durable records and exact-identity client.
- No cloud sync of session content; no MCP server (post-1.0 evaluation).
- Sub-agent execution tooling note: pi's SDK/RPC sub-agent mechanism is proven
  locally, but the current free Hetzner model endpoint (GLM-5.2-NVFP4 /
  DeepSeek-V4-Flash-0731) cannot sustain tool-using sessions (3–9 min hangs on
  established connections with zero streaming). Swarm execution is blocked on a
  tool-call-capable endpoint — do not schedule swarm tasks until that changes.
