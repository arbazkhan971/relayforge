# Operating an autonomous RelayForge team

RelayForge turns a goal into bounded plan, implementation, review and
verification attempts. The parent process owns coordination and acceptance;
agents contribute code and structured results but cannot declare durable
success, alter settlement, or steer a running sibling.

## Quick start

```bash
relayforge init
relayforge validate
relayforge doctor
relayforge learn
relayforge run "Add a dark-mode toggle"
relayforge run "Add a dark-mode toggle" --execute
```

The first `run` is dry. It creates no provider process and spends no provider
budget. `learn` is the only command that writes
`PROJECT-INTELLIGENCE.md`; it records detected languages, frameworks,
entrypoints and real package/build/test commands for later role prompts.

Use another terminal for observation:

```bash
relayforge monitor --run <run-id>
relayforge serve
```

Tmux is an optional viewport, not the runtime or control authority. The
loopback service and SSE surface are read-only and expose normalized records,
not raw provider terminal streams.

## Configure the team

Each project names provider routes and roles. A role chooses an existing
provider key and may select one of the built-in SME disciplines: product,
architecture, frontend/backend/full-stack, mobile, data/ML, integration, QA,
test automation, SRE, performance, accessibility, security, DevOps, platform,
DBA, release, refactoring, review, writing, i18n, observability, or generic
engineering.

A loop identifies its planner/orchestrator and independent reviewer, verifier
commands, repair and iteration bounds, parallelism, cadence, budget mode, and
stop policy. The reviewer must be distinct when the project has multiple roles.
Provider preference in an SME definition is only a starter hint; the role's
configured provider is authoritative.

See [configuration.md](configuration.md) for the strict schema and native
adapter readiness rules.

## One attempt

An executing attempt follows this sequence:

1. The parent claims a dependency-ready task and records the attempt identity.
2. Steering eligible at the immutable cutoff is either included in the new
   prompt or durably refused; an earlier running attempt is never mutated.
3. The selected adapter and exact compatibility/role evidence are bound before
   reservation.
4. A contained provider works in its disposable physical worktree. Output is
   framed once into bounded presentation and normalization paths.
5. A successful structured terminal is necessary but not sufficient.
6. Deterministic verifiers run in the no-network verifier sandbox.
7. A distinct read-only reviewer accepts or rejects the content-bound patch.
8. Accepted content is applied by compare-and-swap to the integration head and
   reverified where required.
9. Transcript replay and empty-scope proof settle the reservation exactly once.

A repair starts a new attempt with the prior failure evidence. It does not
revive a dead process or overwrite an immutable prompt. Repeated failures reach
the configured repair/iteration bound and escalate rather than loop forever.

## Durable status

The post-cutover SQLite event history is authoritative; board, activity,
steering, SCM and observation views are derived projections. Display state is
not written back as truth. The useful operator rule is:

```text
observe durable facts -> update projection -> derive status
```

A dry run ends `planned`. An executing run reaches `done` only if every task is
accepted and the final ordered verifier is green. Blocked, stopped, cancelled,
budget-exhausted, escalated, unverified, recovery-required and uncertain
outcomes are non-success.

## Steering

Create and admit a command to the active run/epoch:

```bash
relayforge --json steer new-id
relayforge steer admit \
  --project <project-name> \
  --run <run-id> \
  --run-epoch <run-epoch> \
  --command-id <command-id> \
  --task-id <task-id> \
  --task-generation <task-generation> \
  --session-id <session-id> \
  --session-generation <session-generation> \
  --not-before-attempt <attempt-generation> \
  --body "Address the regression in the next attempt"
```

Copy `commandId` from the JSON response and reuse it only for an exact retry.
Withdrawal uses the same command id, run and run epoch; it takes no generation
arguments. Admission is not delivery:

```text
admitted != included != delivered != read != obeyed
```

The parent selects pending commands deterministically at the next attempt
boundary. Commands are bounded, generation-fenced and durable. HTTP, tmux and
terminal keystrokes are not steering paths.

## Provider choices

RelayForge ships seven closed adapter types:

- Claude, Codex, Gemini and custom legacy contracts;
- OpenCode 1.18.15 over ACP v1;
- Pi 0.84.1 over native RPC JSONL; and
- Grok Build stable 1.0.0 build `3cd0d0cbce` over ACP v1.

OpenCode, Pi and Grok are available only with exact parent-contained evidence.
Grok additionally requires API-key-only private configuration plus exact
network/tool and no-unapproved-upload proof. A CLI install, login or version
string never substitutes for the release characterization gate.

## Observation and incident handling

`relayforge monitor`, the control-room dashboard and REST/SSE clients consume
bounded normalized projections. Inspect typed diagnostics when a source is
stale, a cursor expires, projection identity differs, a transcript is
uncertain, or scope cleanup cannot be proven. Do not fall back to a raw
terminal scrape and treat it as authority.

Safe recovery principles:

- resume under the exact run lease and epoch;
- preserve dirty/unclassified worktrees;
- never guess a replacement PID, adapter grammar, session or repository;
- rerun native compatibility probes after executable/config changes;
- retain worst-case reservation on unknown settlement; and
- drain parent-owned steering/control lifecycles before releasing authority.

## SCM and multi-repository status

Durable SCM facts and bounded publication, observation, reconciliation and
evidence components are wired into the run parent. Explicit SCM/P6 publication
config drives recoverable PR publication, background polling, and feedback
dispatch into P2; unconfigured runs perform no remote publication.

Multi-repository registry, identity, DAG, scheduling, worktree-group,
candidate/CAS/compensation, combined verification, local integration,
publication saga and canonical-journal coordination are product-integrated
through strict configuration and the actual CLI run path. Invalid or
incomplete repository groups fail before partial execution.
