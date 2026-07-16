# Mission-Control Plan: Daemon, Feedback Routing, Live Terminals

Goal: elevate Loop Orchestrator from a CLI+tmux orchestrator into a full
meta-harness "mission control" at the level of
[AgentWrapper/agent-orchestrator](https://github.com/AgentWrapper/agent-orchestrator),
while keeping the existing autonomy engine (SME roles, blackboard, critic gate,
worktrees, budgets) intact.

## What the reference does (studied 2026-07-16)

agent-orchestrator is a Go daemon + Electron/React meta-harness IDE. The
load-bearing ideas from its architecture docs:

1. **OBSERVE → UPDATE → DERIVE.** The daemon observes external facts (terminal
   activity, PR state, CI checks), stores only durable minimal facts, and
   *derives* display status at read time. Display status is never persisted.
2. **Sessions are durable entities** with `activity_state`
   (`active | idle | waiting_input | blocked | exited`) and `is_terminated`,
   plus PR fact tables (`pr`, `pr_checks`, `pr_review_threads`). Status
   derivation precedence: termination → input/blocked → PR pipeline states
   (ci_failed, merge conflict, approval) → activity.
3. **One git worktree per session**; never force-delete dirty worktrees —
   user data safety supersedes cleanup convenience.
4. **Change-data-capture event flow**: every write appends to a change log;
   a poller with a watermark fans events out to subscribers (terminal fanout,
   SSE clients, cache invalidation). The UI gets Server-Sent Events, not polls.
5. **Thin CLI, fat daemon**: the CLI is an HTTP client over a loopback-only
   daemon (`ao start/stop/status/doctor`, `ao project add/ls/get/rm`,
   `ao spawn`, `ao session ls/get/kill/restore/rename/cleanup/claim-pr`,
   `ao send`, `ao preview`). Daemon binds 127.0.0.1 only; all state lives
   under one app directory.
6. **Termination requires confluence**: runtime dead AND process dead AND no
   recent activity — a failed probe alone never kills a session.
7. **The feedback loop is the product**: the daemon routes CI failures, review
   comments, and merge conflicts back to the owning session automatically.

## How we adapt it (Node/TS, zero-build, no heavyweight deps)

Our board (`src/board.ts`) already stores append-only JSONL facts and folds
them at read time — the same philosophy. We extend that pattern instead of
adopting SQLite/Electron:

- **Persistence**: append-only JSONL under `.loop/daemon/` (sessions.jsonl,
  events.jsonl) — the change log *is* the store; folding derives state.
- **Events to UI**: Server-Sent Events from `node:http` (no `ws` dependency).
- **UI**: the existing zero-build dashboard grows a session-centric layout;
  terminals stream over SSE, keystrokes go up as POSTs.

## Model ownership (for `loop run` execution)

- Backend/daemon epics (1, 2, terminal bridge of 3): `gpt-5.6-luna`, effort `xhigh`.
- UI epics (3 browser terminal, 4): `gpt-5.6-sol`, effort `xhigh`.
- Independent QA critic pinned to a different provider (claude) — no
  same-family self-review.

## Epics

### Epic 1 — Persistent daemon (`loop daemon`)
- `src/daemon/state.ts`: session registry as append-only JSONL + fold
  (reuses the board pattern). Session = { id, project, run, role, goal,
  worktree, branch, provider, tmuxSession, activityState, isTerminated,
  prRef?, createdAt }. Display status derived at read time, never stored.
- `src/daemon/server.ts`: loopback-only `node:http` server (default port
  4319), bearer token at `.loop/daemon/token` (0600). Routes:
  `GET /readyz`, `GET /api/projects`, `POST /api/projects`,
  `GET /api/sessions`, `POST /api/sessions/:id/kill`, `GET /api/events` (SSE),
  `POST /shutdown`.
- CLI (thin client only): `loop daemon [start|stop|status]`,
  `loop project add|list`, `loop session list|kill`.
- `loop run --execute` registers its SME sessions with the daemon when one is
  running (graceful no-op otherwise).
- Rules adopted verbatim: 127.0.0.1 bind only; termination requires
  confluence (tmux session gone AND no board activity within grace window);
  never force-delete dirty worktrees.

### Epic 2 — Feedback router (PR/CI/review → session)
- `src/daemon/github.ts`: poll `gh` CLI (or REST w/ token) per session
  branch/PR; store facts: checks, unresolved review threads, mergeability.
- `src/daemon/router.ts`: pure decision function `route(facts, sessions) →
  board tasks` — fixture-tested. CI failure → repair task w/ log tail;
  unresolved review thread → task w/ file/line context; merge conflict →
  rebase task. Reuses existing self-healing/maxRepairs machinery.
- Routed events appear on the timeline and in `loop monitor`.

### Epic 3 — Live terminal attach
- `GET /api/terminal/:session/stream` (SSE): tmux capture-pane diffing at
  ~500ms; `POST /api/terminal/:session/keys` (token + explicit `takeControl`
  flag) sends keys via tmux send-keys.
- Dashboard Inspector gains a live terminal view + "send instruction" box.

### Epic 4 — Session-centric dashboard + browser preview
- IA matches the reference: left sidebar projects, center session list
  (status, model, branch, PR, spend, idle timer), right Inspector with
  terminal / PR & CI / review / preview tabs.
- Preview tab: iframe of a configurable per-project localhost URL.
- KPI bar, needs-attention strip, timeline are kept and folded into the
  sessions view. Slow data stays on JSON polls; events/terminals use SSE.

### Epic 5 — CLI parity & docs
- `loop pr status`, `loop session attach` (prints tmux attach hint), docs
  (`docs/daemon.md` with the API surface), README, CHANGELOG, minor bump.

## Hard constraints

- TypeScript strict; **no new runtime dependencies** (node:http SSE instead
  of ws; no React — the dashboard stays zero-build plain JS).
- Vitest coverage for: state fold/derivation, router decisions (fixture
  GitHub payloads), SSE protocol framing. Existing suite stays green.
- Daemon security: loopback bind, bearer token, terminal writes require the
  token + explicit take-control.
- Never weaken test/CI files to pass gates (reward-hacking guard stays on).

## Acceptance (end-to-end)

1. `loop daemon start` → `loop run "<goal>" --execute` shows the SME sessions
   in `loop session list` and the dashboard sidebar; killing the CLI does not
   kill the daemon or sessions.
2. Typing into the browser terminal reaches the agent's tmux pane.
3. A fixture failing-CI payload produces a routed repair task assigned to the
   owning session.
4. Browser preview renders a project dev server in the Inspector.
5. `budgetUsd` respected; over-budget stops and escalates.
