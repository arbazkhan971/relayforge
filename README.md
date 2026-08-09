<p align="center">
  <img src="https://raw.githubusercontent.com/arbazkhan971/loop-orchestrator/main/assets/logo.svg" alt="Loop Orchestrator logo" width="760">
</p>

<h1 align="center">Loop Orchestrator</h1>

<p align="center">
  <strong>Open-source autonomous AI agent teams for Claude Code, Codex, Gemini CLI, and custom terminal coding agents — headless by default, with an optional tmux viewport.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/loop-orchestrator"><img src="https://img.shields.io/npm/v/loop-orchestrator?color=0ea5e9&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/loop-orchestrator"><img src="https://img.shields.io/npm/dm/loop-orchestrator?color=14b8a6" alt="npm downloads"></a>
  <a href="https://github.com/arbazkhan971/loop-orchestrator/actions"><img src="https://img.shields.io/github/actions/workflow/status/arbazkhan971/loop-orchestrator/ci.yml?branch=main&label=ci" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-facc15" alt="MIT license"></a>
</p>

Loop Orchestrator runs a persistent AI software engineering team — a planner, implementers, and an independent reviewer — that decomposes a goal, delivers it in isolated git worktrees, and leaves the accepted work on a run branch for you to review and merge. The team runs fully headless; tmux is an optional viewport for watching agents live. Each role gets a project brief, a provider, an SME discipline prompt, safety rules, and a repeatable operating loop.

Use it as a lightweight open-source alternative to hard-coded agent scripts when you want **multi-agent coding workflows**, **terminal AI teams**, **Claude Code orchestration**, **Codex automation**, **Gemini CLI scouting**, and **headless background execution** (with an optional tmux viewport).

## ⚡ Autonomous SME Team (3 commands)

Point it at a repo, give it a goal, and watch a project-trained team of subject-matter experts deliver it — a Product Manager decomposes the goal, an Architect shapes it, and Frontend / Backend / QA / CT / Security SMEs (each on its best-fit provider) implement, test, and review, coordinating through a shared blackboard the parent orchestrator owns.

```bash
loop learn                         # train the team on your codebase → PROJECT-INTELLIGENCE.md
loop run "add rate limiting to the /login endpoint"   # decompose → assign → drive the loop
loop monitor                       # single-screen mission control: board + every agent, live
```

How it works:

- **Trained on your project.** `loop learn` scans the repo and writes `PROJECT-INTELLIGENCE.md` (stack, frameworks, layout, and the *real* test/build/lint commands). Every SME is grounded in it, so agents never invent commands.
- **27 built-in SME roles.** Architect, Product Manager, Frontend, Backend, Full-stack, QA, CT/Test-Automation, DevOps, SRE, Security, DBA, Performance, Accessibility, Mobile, Data, ML, and more — each with a deep, discipline-specific system prompt and a best-fit provider (`loop roles` lists them). Set `sme: backend` on a role and it inherits the expert prompt.
- **Real autonomy, not one-shot.** A planner agent decomposes the goal into assigned tasks. The **parent orchestrator** owns the shared JSONL blackboard (`.loop/runs/<project>/<run-id>/board/`) — agents never write coordination state themselves; they make their code change and report in their final message, and the parent decides. The loop dispatches each task to the right SME, detects completion from the agent's exit code **and** structured output, then runs your project's verifier (test, falling back to build) as a gate before an independent reviewer decides accept/reject.
- **tmux is an optional viewport; agents run headless.** The loop runs fully headless with no tmux dependency; when tmux is present each SME gets a tiled pane so you can watch the whole team on one screen. Control flow spawns a fresh headless `claude -p` / `codex exec` / `gemini -p` child per task — reliable completion detection, no screen-scraping.
- **Safe by default.** `loop run` without `--execute` is a true dry-run: it launches **no** provider process (not even the planner) and never touches git — it just drives the board for observability. Add `--execute` to actually launch the agents against a clean git working tree.

**Verified, self-healing, parallel** — the part that separates a real team from a demo:

- **Independent critic.** A reviewer SME (a *different* role/provider than the implementer) runs read-only over the attempt's **complete base-SHA patch** (committed, staged, unstaged, and untracked content) against the acceptance criteria and can **reject** — no rubber-stamping. Reviewer output is strict and structured; malformed output fails closed (rejected). Rejections go back with reasons.
- **Self-healing.** Failed tasks are retried with the captured error injected into the next attempt, up to `maxRepairs`, then escalated to a human instead of stranded.
- **Regression-gated.** HEAD is snapshotted before each task; a change that turns a green suite red is reverted. Test/CI files are hashed so an agent can't weaken its own grader to pass (reward-hacking guard). Verifier commands run in an explicit order (the loop's `verify:` list, else auto-detected test then build), and their timing output is normalized so a passing run never looks flaky.
- **True parallelism.** Each attempt works in its own throwaway **git worktree** on its own branch, so SMEs run concurrently (`maxParallel`) without clobbering each other; accepted work merges into the run's integration branch through the critic gate — never into your checkout.
- **Offline-ready worktrees.** A loop can declare local dependency trees such as `node_modules` plus required executable markers. The parent copies them into integration, attempt, and review worktrees with distinct inodes and constrained internal links, and blocks every provider/verifier until the complete tree is ready—no package install, network, setup script, hardlink, or writable symlink to your checkout.
- **Budgeted.** Per-task spend is tracked to `.loop/runs/<project>/<run-id>/board/costs.jsonl` (reported as **unknown** when a provider returns no cost, never silently zero); budgets are checked before every planner/worker/reviewer call and the run stops at `budgetUsd`. Under a positive `budgetUsd` the run **fails closed** when providers report unknown cost more than `allowUnknownCostCalls` times (default 0). A real `--execute` run is **done** (exit 0) only when every task is accepted *and* the final ordered verifier is green; if every task is accepted but there is no green verifier the run is **unverified** (exit non-zero). A successful **dry-run** ends in status **planned** (exit 0). Rejected, escalated, cancelled, stopped, unverified, or budget-exhausted runs all exit non-zero.

**Proven end-to-end.** A real run of two engineer SMEs (Claude) implementing two functions *in parallel in isolated git worktrees*, reviewed by an independent QA critic:

```
$ loop run "Add subtract(a,b) and multiply(a,b) to math.js, each with a test" --execute
🛰  Run … · sandbox — decomposed into 3 tasks across 4 SMEs
  [done] t1 (be) Accepted by qa. Merged to loop/sandbox/<run>/integration. math.js exports subtract(a, b) …
  [done] t2 (be) Accepted by qa. Merged to loop/sandbox/<run>/integration. math.js exports multiply(a, b) …
# both attempts merged to the run branch → node --test → 5/5 pass → $0.56 (budget $2.00)
# accepted work is left on loop/sandbox/<run>/integration for you to review and merge — nothing is auto-merged to main
```

See [docs/autonomous-team.md](docs/autonomous-team.md) for the full guide.

### Live dashboard

`loop dashboard` opens a local **mission control** that answers, at a glance, *is it working, where is it stuck, and what's it costing*:

- **KPI bar** — progress %, agents active, in-progress/blocked counts, retries, estimated time left, and **spend vs budget** (turns amber/red as you approach the cap).
- **Needs-attention strip** — every blocked / rejected / escalated task with the *reason* (e.g. "webhook signature check failing"), so you know what to fix.
- **Agent swimlanes** — each SME's current task, live idle timer (goes amber/red when stuck), spend, and an expandable peek at its terminal output.
- **Dependency-aware task board** — kanban by status with dependency chips and **critical-path** markers, so you see what's actually gating completion.
- **Activity timeline** — the live event + inter-agent message feed (handoffs, rejections, merges).

It polls JSON endpoints every 2.5s — zero build step, just `loop dashboard`. The server binds to `127.0.0.1` (loopback only), validates run/session ids against path traversal, only exposes project-owned tmux sessions, and redacts environment variables and secrets from `/api/config` and logs. (`loop monitor` is the single-screen terminal version.)

<p align="center">
  <img src="https://raw.githubusercontent.com/arbazkhan971/loop-orchestrator/main/assets/dashboard.png" alt="Loop Orchestrator mission-control dashboard: KPIs, needs-attention, agent swimlanes, dependency-aware task board, and live activity timeline" width="900">
</p>

### Example: a todo app the team built

[`examples/todo-app`](examples/todo-app) is a real, zero-dependency todo app (Node `node:http` API + vanilla-JS UI + `node:test` tests) **built by the SME team** via `loop run` — a Backend SME wrote the store and API in an isolated worktree, a Frontend SME built the UI, and a QA critic reviewed each diff before it was integrated onto the run branch. The `loop.config.yaml` and `brief.md` that produced it are included so you can reproduce it.

<p align="center">
  <img src="https://raw.githubusercontent.com/arbazkhan971/loop-orchestrator/main/assets/todo-app.png" alt="The todo app built by the autonomous SME team" width="540">
</p>

## Why This Exists

Most agent workflows are either one-off prompts or hard-coded scripts. Loop Orchestrator gives you a portable repo-level control plane:

- Headless role-based agents for long-running work (with an optional tmux viewport)
- Per-role provider selection (Codex/Gemini unpinned by default; Claude defaults to the `opus` alias)
- Execution isolated in a git worktree (your checkout is never touched) plus an OS sandbox for untrusted verifier commands
- Project briefs, SME discipline prompts, and guardrails
- Dry-run mode for safe planning, execute mode for launching agents
- Local dashboard for session status and logs
- Generic YAML config that works across teams and projects

## Who It Is For

- Solo developers running multiple coding agents in parallel
- Engineering leads assigning planner, frontend, backend, QA, and release roles
- Teams using Claude Code, Codex, Gemini CLI, or custom terminal agents
- Developers who want headless agent runs that keep going on a VM after disconnecting
- Open-source maintainers who want repeatable AI code review and release workflows

## What You Can Build

- Autonomous AI software engineering team (headless, with an optional tmux viewport)
- Multi-agent coding workflow inside a single repo
- Automated PR planning, implementation, QA, and release review loops
- Long-running background agent sessions on a devbox or VM
- Configurable coding-agent dashboard for local teams

## Keywords

AI agents, agent orchestrator, tmux orchestrator, Claude Code, Codex, OpenAI Codex, Gemini CLI, multi-agent coding, agentic coding, autonomous coding agents, terminal agents, software engineering agents, AI devtools, developer tools, workflow automation, GitHub automation, code review agents, LLM agents.

## Prerequisites

Install the tools you want Loop Orchestrator to control:

```bash
# Node >= 20 is required (run `loop doctor` to check your environment).

# Optional: tmux is only the live viewport — the loop runs fully headless without it.
brew install tmux

# Optional providers. Install and log in to whichever ones you use.
claude
codex
gemini
```

**For `loop run --execute` (not needed for dry-runs):** the loop contains every provider and verifier in an **OS sandbox** and a **strong process scope**, and it **fails closed** if it cannot launch both — so real execution needs a host that provides them:

- **Linux:** `bwrap` (bubblewrap) with **unprivileged user namespaces**, on a kernel where `bwrap --unshare-net` can create a network namespace (nested/locked-down containers often forbid this), plus **cgroup v2 delegation** for the process scope. A `systemd` user session gives you the latter — e.g. run under `systemd-run --user --scope loop run … --execute`.
- **macOS:** `sandbox-exec` (built in).

`loop doctor` reports both facts with the exact fix; on a host without them, dry-runs still work but `--execute` ends `blocked` and never reaches `done`.

You can use subscription/OAuth CLI login or API keys. Loop Orchestrator detects local CLI state and API-key env vars, but it never stores secret values in config.

## Install

```bash
npm install -g loop-orchestrator
loop --version
```

For local development:

```bash
npm install
npm run build
npm link
```

## Step-by-Step Setup

### 1. Open Your Project

Run Loop Orchestrator from the git repo you want the team to work in. Execution needs a git repository with a **clean working tree**, and works on **one repository at a time** (set `workingDir`). Multi-repository execution is not supported in this release.

```bash
cd /path/to/your/repo
```

### 2. Initialize Config

```bash
loop init
```

`loop init` auto-detects an installed provider CLI (preference order `claude`, `codex`, `gemini`) and wires a lean starter team to it; pass `--provider claude|codex|gemini|custom` to override, and `--force` to overwrite existing files. It creates:

- `loop.config.yaml`: one project with a provider, a **lean 3-role team** (planner, implementer, reviewer, all on one provider), and a delivery loop
- `brief.md`: project brief sent to every role
- `.loop/`: generated prompts and run metadata
- a `.gitignore` entry for `.loop/` and `PROJECT-INTELLIGENCE.md`

The starter includes **no unsafe provider flags**. Claude implementers run with `--permission-mode acceptEdits` and reviewers with `--permission-mode plan` (read-only); Codex runs with `--sandbox workspace-write` / `--sandbox read-only`. `--dangerously-skip-permissions` / `--yolo` are opt-in only, discouraged, and require an OS sandbox (they fail closed otherwise). When both the `claude` and `codex` CLIs are installed, `loop init` also auto-wires a routing chain — a primary `opus` Claude provider plus a `gpt` Codex provider (`fallbackFor: opus`) — so Codex covers a Claude usage/rate limit and Opus is retried after a cooldown (see [Safety Model](#safety-model)).

### 3. Check Your Environment

```bash
loop doctor
```

`loop doctor` verifies Node >= 20, git, tmux (optional), a clean git target, config schema + semantics, configured offline-provision sources/tool markers, provider readiness, **and the two containment prerequisites that gate `--execute`** — a launchable OS sandbox (with network isolation) and a strong process scope — each with an actionable fix. The two containment checks are `warn`-free: they `fail` (and `loop run --execute` fails closed) whenever containment cannot be launched (see [Safety Model](#safety-model)). Provision inspection is read-only; a dry-run needs neither containment prerequisite.

### 4. Detect Local Provider Auth

```bash
loop auth status
loop auth configure --write
```

This checks your machine for the `claude`, `codex`, and `gemini` (or `agy`) CLIs and API env vars such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and writes only auth metadata (mode, command, env-var name) into `loop.config.yaml` — never secret values:

```yaml
projects:
  - name: demo-product
    providers:
      agent:
        type: claude
        auth:
          mode: subscription
          configured: true
```

### 5. Edit Your Project Brief

Open `brief.md` and describe the product, coding rules, test expectations, release rules, and any hard constraints.

Example:

```markdown
# Project Brief

Build changes in small, reviewable steps.
Read PROJECT-INTELLIGENCE.md first and reuse existing patterns and commands.
Never modify test files or CI config to make checks pass.
Do not run destructive database commands.
```

### 6. Train the Team

```bash
loop learn
```

`loop learn` scans the repo and writes `PROJECT-INTELLIGENCE.md` (stack, layout, and the real test/build/lint commands), which is injected into every role's prompt. `loop learn` is the **only** command that writes this file; `loop run` reads it but never writes project intelligence into your checkout, so run `loop learn` first (and re-run it after a big stack change).

### 7. Validate Config

```bash
loop validate
```

`loop validate` runs schema validation **plus** semantic validation: duplicate names are rejected, every role→provider and loop→role reference must resolve, the reviewer must differ from the orchestrator (so review is independent), and multi-repository configs are rejected.

### 8. Dry-Run First

```bash
loop run "add rate limiting to the /login endpoint"
```

Without `--execute` this is a **true dry-run**: it launches no provider process (not even the planner) and never touches git — it just decomposes the goal and drives the board so you can inspect the plan in the monitor or dashboard.

### 9. Execute

```bash
loop run "add rate limiting to the /login endpoint" --execute
```

`--execute` requires a clean git working tree. Work happens in loop-owned git worktrees **outside** your repo; your checked-out branch and working tree are never touched. Accepted work is left on the run branch `loop/<project>/<run-id>/integration` for you to review and merge:

```bash
git log loop/<project>/<run-id>/integration   # then open a PR — nothing is auto-merged to main
```

### 10. Watch It Live

```bash
loop monitor              # single-screen terminal mission control (needs no tmux at all)
loop tmux new             # open the run's tmux viewport and attach (idempotent — safe to re-run)
loop dashboard            # local web dashboard on 127.0.0.1
```

### 11. Check Logs and Stop Runs

```bash
loop tmux show            # Loop-owned sessions: liveness, panes, and (with --capture) recent output
loop logs <session>       # capture recent tmux pane output
loop stop <run-id>        # cancel the running loop and kill its tmux sessions
```

### If a run is interrupted, just run it again

A run is **resumable**. If the process is killed — you close the laptop, the VM reboots, CI evicts the
job — re-run the same command with the same `--run <id>` and it picks up where it left off:

```bash
loop run "<goal>" --run issue-123 --execute   # ...killed mid-flight
loop run "<goal>" --run issue-123 --execute   # resumes: no replan, no lost work
```

It does **not** start over. The board is the source of truth, so the goal is not decomposed again and
accepted tasks stay accepted; the attempt that was in flight when the process died is reclaimed and
repaired (it counts as one attempt, so a crash that keeps repeating escalates to a human instead of
relaunching forever); the stale run lease left by the dead process is reclaimed; and spend is not
forgotten — a call that died before it could report its cost stays on the books at its worst case,
never as `$0`.

### The tmux viewport (`loop tmux`)

tmux is an **optional viewport** — the loop always runs headless, and `loop monitor` works without it.
When you do want to watch the team live, one verb group covers the whole lifecycle:

```bash
loop tmux pre             # pre-flight: exactly what `new` would do — creates and changes NOTHING
loop tmux new             # create-or-attach this run's viewport (idempotent; run it twice, get one session)
loop tmux show --capture  # owned sessions + liveness + panes + recent output
loop tmux kill -r bug-42  # kill only THIS run's Loop-owned sessions
loop tmux prune           # reap stale viewports (all panes dead, or the run is gone)
```

It does the fiddly parts for you:

- **Already inside tmux?** It runs `switch-client` instead of nesting an `attach-session`.
- **Piped, or in CI?** It creates the session detached and prints the exact `tmux attach` command
  instead of dying with `open terminal failed`.
- **Session name already taken by one of *your* sessions?** It refuses (exit 3) and never adopts or
  kills a session Loop did not create. Loop-owned sessions carry `@loop-*` identity metadata; anything
  without that stamp is off limits — to `kill`, `prune`, `show`, and the dashboard alike.
- **Two invocations at once?** They converge on exactly one session (the loser of the race adopts it).

Exit codes are stable, so scripts can gate on them — and `pre` returns the code `new` *would* return:

| code | meaning |
| --- | --- |
| 0 | ok / would work |
| 1 | error (bad id, bad flag, tmux failure) |
| 2 | tmux not installed, or the viewport is switched off |
| 3 | a foreign (non-Loop) session holds the name |
| 4 | nothing found (no run, no session) |

Turn the viewport off entirely with `defaults.viewport: false` in `loop.config.yaml`, or `LOOP_TMUX=off`
for a single invocation (the env var can only ever *disable* it). `loop doctor` reports both facts.

## Core Commands

```bash
loop init                 # create loop.config.yaml + brief.md wired to an installed provider
loop doctor               # check Node>=20, git, tmux, clean git target, config, providers
loop learn                # scan the repo → PROJECT-INTELLIGENCE.md (trains the team)
loop roles                # list the built-in SME disciplines
loop run "<goal>"         # decompose a goal and drive the autonomy loop (dry-run by default)
loop run "<goal>" --execute  # ...and actually launch the agent CLIs against a clean git tree
loop monitor              # single-screen mission control (defaults to the latest run; no tmux needed)
loop tmux pre             # pre-flight the viewport: what `loop tmux new` would do (changes nothing)
loop tmux new             # create-or-attach the run's tmux viewport (idempotent)
loop tmux show            # list Loop-owned sessions: liveness, panes, recent output
loop tmux kill -r bug-42  # kill only that run's Loop-owned sessions
loop tmux prune           # reap stale viewports (dead panes, or the run is gone)
loop attach               # attach to a run's EXISTING viewport (does not create one — use `loop tmux new` for that)
loop auth status          # inspect local provider CLI/API-key readiness
loop auth configure --write # write detected local auth mode into config
loop validate             # validate config (schema + semantic references)
loop start --run bug-42   # open a prompt-only tmux viewport (launches no agents; use `loop run --execute` to run them)
loop status               # list loop tmux sessions
loop logs <session>       # capture recent tmux pane output
loop stop bug-42          # cancel the run and kill its tmux sessions
loop dashboard            # open the local (loopback-only) web dashboard
```

Global flags: `-c, --config <path>`, `--json`, `--version`.

## Common Workflows

### One Repo

```bash
cd ~/work/backend-api
loop init
loop auth configure --write
loop validate
loop doctor
loop run "fix the login redirect bug" --execute
```

### One Repo at a Time

Multi-repository execution is not supported in this release. Run the team against a single repo by setting `workingDir` in `loop.config.yaml`, and start a separate run per repository:

```yaml
projects:
  - name: backend-api
    workingDir: .        # the loop works one repo at a time
```

### VM Setup

Install once on the VM user that will run the agents:

```bash
npm install -g loop-orchestrator
claude
codex
gemini
```

Then:

```bash
cd ~/work/backend-api
loop init
loop auth configure --write
loop run "overnight refactor batch" --execute
```

The run drives fully headless, so it keeps going if your laptop disconnects; attach a viewport any time with `loop attach`.

### Update Package

```bash
npm install -g loop-orchestrator@latest
loop --version
```

## Example Providers

Providers live under each project. Codex and Gemini are unpinned by default (the CLI uses its own default); a Claude provider defaults to the `opus` alias unless you set `model:` (so the primary implementer is Opus, per the routing design). No unsafe flags are required: Claude runs under `--permission-mode acceptEdits` (reviewers `plan`), Codex under `--sandbox workspace-write` (reviewers `read-only`), and untrusted verifier commands run in a separate OS sandbox:

```yaml
projects:
  - name: demo-product
    providers:
      anthropic:
        type: claude
        auth:
          mode: subscription
          configured: true
      openai:
        type: codex
        effort: medium
        auth:
          mode: subscription
          configured: true
```

## Local Auth Setup

Loop Orchestrator can inspect your machine and write provider auth hints into config:

```bash
loop auth status
loop auth configure --write
```

It detects:

- Claude CLI from `claude`, or API env vars `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`
- Codex CLI from `codex`, or API env var `OPENAI_API_KEY`
- Gemini CLI from `gemini` or `agy`, or env vars `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`

The command stores only metadata such as auth mode, command name, and env var name. It does not write secret values into `loop.config.yaml`.

Roles are defined under each project and reference a provider key plus an optional `sme:` discipline that seeds their expert prompt:

```yaml
projects:
  - name: demo-product
    roles:
      - name: planner
        title: Planner / Orchestrator
        provider: agent
        sme: architect
      - name: implementer
        title: Implementer
        provider: agent
        sme: fullstack
      - name: reviewer
        title: Independent Reviewer
        provider: agent
        sme: code-reviewer
```

## Safety Model

Two layers contain execution: an **isolated git worktree** (so your checkout is never touched) plus an **OS sandbox** for untrusted verifier commands. A git worktree is *not* a host sandbox — it only isolates the working tree and branch — so untrusted commands get real OS-level containment on top.

- Execution requires a git repository with a **clean working tree**; the loop refuses otherwise with an actionable message.
- Execution **never** modifies, resets, cleans, checks out, or merges into your checked-out branch or working tree. Your checkout is left completely untouched.
- Work happens in loop-owned git worktrees **outside** the repo: a dedicated integration branch `loop/<project>/<run-id>/integration` (branched from the base commit) accumulates accepted work, and each task attempt runs in its own throwaway worktree/branch. Isolation is always on and mandatory.
- Configured dependency provisioning is parent-owned and offline. It copies only physically contained regular files and safe relative internal links into a privately staged tree, proves copied files do not share source inodes, then publishes before the checkout becomes runnable. Missing/unsafe sources, external links, special files, copy failures, or missing required executables fail closed before execution.
- Providers run without permission bypass by default: Claude implementers use `--permission-mode acceptEdits` and reviewers `--permission-mode plan` (read-only); Codex uses `exec --sandbox workspace-write` / `--sandbox read-only`. `dangerouslySkipPermissions` / `yolo` are opt-in only, discouraged, and require an OS sandbox (they fail closed if none is available). `loop init` emits them off.
- **Every** provider turn (planner/implementer/reviewer) **and** every verifier command runs in an **OS sandbox** (Linux `bwrap` or macOS `sandbox-exec`) with **no inherited secrets** (the environment is scrubbed to a small allowlist), **no host writes** outside the disposable checkout, and **no network** for verifiers. Verifier network isolation is a **precondition, not best-effort**: on a host where the sandbox cannot remove the network (e.g. a nested container that forbids a new network namespace), `loop run --execute` **fails closed** rather than running an AI-chosen verifier online. Likewise, if no launchable sandbox exists at all, a `loop run --execute` **fails closed before the planner** — nothing launches, the run ends `blocked`, and it can never reach `done`. There is **no** environment variable that bypasses this. Separately, the parent's own `git` calls (merge/checkout/worktree) are hardened so no repo/global git *config* — e.g. a `core.hooksPath` an agent might plant — can execute code on the host, and agents are never given writable git configuration. (The `@anthropic-ai/sandbox-runtime` library is not integrated in this release; see `docs/safety.md`.)
- Agents cannot write the authoritative board/state/cost; the parent orchestrator owns all coordination state and decides via independent review plus a deterministic verifier.
- At the end, accepted work is left on the run branch for a human to review and merge. Nothing is auto-merged to `main`.

Recommended defaults:

- Dry-run (`loop run` without `--execute`) until the plan and config look right.
- Keep production branches protected and review the run branch before merging.
- Never let agents modify test files or CI config to make checks pass (the reward-hacking guard hashes them, but say so in the brief too).
- Avoid destructive database commands in all prompts.

## Dashboard

```bash
loop dashboard --port 4318
```

The dashboard binds to `127.0.0.1` (loopback only) and shows active project-owned sessions, the board, and recent tmux output — with environment variables and secrets redacted, and run/session ids validated against path traversal.

## Troubleshooting

### `No loop.config.yaml found`

Run:

```bash
loop init
loop auth status
```

### `tmux: command not found`, or `loop tmux new` exits 2

tmux is optional — the loop runs fully headless without it, and `loop monitor` needs no tmux at all.
Exit code 2 means the viewport is unusable, and `loop tmux pre` says which of the two reasons applies:
tmux is not installed, or the viewport is switched off (`LOOP_TMUX=off` / `defaults.viewport: false`).
Install it only if you want the live viewport (`loop tmux new`, `loop logs`, the dashboard panes):

```bash
brew install tmux
```

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y tmux
```

### Provider Not Detected

Install and log in to the provider CLI, then rerun:

```bash
loop auth status
loop auth configure --write
```

### Start Fresh for a Run

```bash
loop stop issue-123
loop run "<goal>" --run issue-123 --execute
```

### Inspect Generated Prompts

Prompts are written under:

```text
.loop/runs/<project>/<run-id>/prompts/
```

## License

MIT
