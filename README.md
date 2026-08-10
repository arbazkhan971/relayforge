# RelayForge

<p align="center">
  <img src="assets/logo.svg" alt="RelayForge" width="420">
</p>

<p align="center">
  <b>Safe multi-agent coding loops</b> — plan → implement → review → verify,<br/>
  each step in an isolated git worktree with real OS containment.
</p>

<p align="center">
  <a href="https://github.com/arbazkhan971/relayforge/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/arbazkhan971/relayforge/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-20.x%20%7C%20%E2%89%A522-339933">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Status" src="https://img.shields.io/badge/status-1.0.0--rc.1-orange">
</p>

```bash
# from this repo (npm package is not published yet)
npm ci && npm run build && npm link

cd /path/to/your-git-project   # must be a clean git repo for --execute
relayforge init --provider claude   # or: codex | gemini
relayforge doctor
relayforge run "Ship a small verified change"            # dry-run (default)
relayforge run "Ship a small verified change" --execute  # actually launch agents
```

---

## Why RelayForge

Most “agent team” tools are shell scripts around chat CLIs. RelayForge is a **parent-owned control plane**:

| Guarantee | What it means |
| --- | --- |
| Dry-run by default | Nothing spends tokens until you pass `--execute` |
| Isolated worktrees | Each attempt gets its own git worktree; review is a separate boundary |
| Containment | Linux Bubblewrap + cgroup scopes; fail closed if the host can’t prove them |
| Durable state | Run facts live in SQLite under `.loop/` — restartable, auditable |
| Independent review | Reviewer role is not the same process as the implementer |
| Deterministic verify | Your `verify:` commands (e.g. `npm test`) gate acceptance |

---

## Setup (from source)

npm is **not** on the registry yet. Install from GitHub:

### 1. Prerequisites

- **Node.js** 20.x or ≥22  
- **Git**  
- At least one agent CLI you use day-to-day: **`claude`**, **`codex`**, or **`gemini`**  
- **Linux** recommended for full safety (Bubblewrap + user cgroup). macOS works with weaker containment.

```bash
node -v && git --version
command -v claude || command -v codex || command -v gemini
```

### 2. Install RelayForge on your PATH

```bash
git clone https://github.com/arbazkhan971/relayforge.git
cd relayforge
npm ci
npm run build
npm link          # exposes: relayforge, loop, loop-orchestrator
relayforge --version
```

### 3. Init a project

```bash
cd /path/to/your-app
git status         # should be clean before --execute

relayforge init --provider claude   # writes relayforge.config.yaml + starters
relayforge validate
relayforge doctor                   # host, sandbox, providers — fix anything red
```

`doctor` should report Node/Git OK, a valid config, and at least one ready provider. On Linux you also want `sandbox: bwrap` and a strong process-scope when available.

### 4. First run

```bash
# Optional: project memory for agents
relayforge learn

# Plan only — no agents launched
relayforge run "Add a /health endpoint and a unit test"

# When the plan looks right, spend tokens
relayforge run "Add a /health endpoint and a unit test" --execute
```

### 5. Watch the run (optional)

```bash
# Local dashboard + read-only API (loopback only)
relayforge serve

# Optional tmux panes for agent sessions
relayforge tmux new
relayforge monitor
```

---

## Daily commands

```text
relayforge doctor              # is this machine / project ready?
relayforge validate            # config schema + semantics
relayforge run "<goal>"        # dry-run plan
relayforge run "<goal>" --execute
relayforge serve               # dashboard on 127.0.0.1
relayforge status              # owned sessions
relayforge stop <run-id>       # cancel a run
relayforge --help
```

---

## Providers that work today

| Type | CLI on PATH | Notes |
| --- | --- | --- |
| `claude` | `claude` | Best default for most people |
| `codex` | `codex` | ChatGPT / Codex login |
| `gemini` | `gemini` | Gemini CLI auth |
| `custom` | your binary | You own the contract |
| `opencode` / `pi` / `grok` | exact pins | **Ordinary `run --execute` refuses** until product evidence injection exists |

Day one: use **Claude, Codex, or Gemini**. Ignore OpenCode/Pi/Grok until release receipts land.

---

## What you get after `init`

- `relayforge.config.yaml` — strict team / loop / verify config  
- `brief.md` — project brief for agents  
- `.loop/` — durable runs, prompts, locks (do not rename)  

Compatibility: existing `loop.config.yaml` and `.loop/` still work. Binary aliases `loop` and `loop-orchestrator` call the same program as `relayforge`.

---

## Screenshots (live product)

Captured from a **running** `relayforge serve` after a real dry-run (connected control plane, task board, activity), and from the shipped example app.

### Control dashboard — connected after dry-run

<p align="center">
  <img src="assets/dashboard.png" alt="RelayForge control dashboard: connected, 100% progress, task board Done, live activity" width="900">
</p>

Shows: green **connected** state, KPI strip (progress 100%, run **succeeded**), task board with the planned task in **DONE**, and a live activity timeline.

### Example app — `examples/todo-app`

<p align="center">
  <img src="assets/todo-app.png" alt="RelayForge Todo example with seeded tasks" width="520">
</p>

```bash
cd examples/todo-app && npm start   # http://localhost:3000
```

---

## Docs

| Doc | For |
| --- | --- |
| [Configuration](docs/configuration.md) | Full config reference |
| [Safety](docs/safety.md) | Containment and fail-closed rules |
| [Session steering](docs/session-steering.md) | Future-boundary steering (not terminal injection) |
| [Architecture](docs/architecture.md) | How the control plane works |
| [Implementation status](docs/implementation-status.md) | What’s green vs release-blocked |
| [Publishing](docs/publishing.md) | RC / npm gates (operators) |

---

## Current boundaries (honest)

- **Single-repo loops** with Claude/Codex/Gemini are the supported product path.  
- **Multi-repo** is integrated but needs explicit config.  
- **OpenCode / Pi / Grok** characterization exists; ordinary execute still fails closed.  
- **Not on npm yet** — install from this GitHub repo until `1.0.0-rc.1` is published.  
- No auto-merge to `main`, no invented remote PRs without explicit SCM config.

---

## License

MIT — see [LICENSE](LICENSE).

<p align="center">
  <img src="assets/icon.svg" alt="" width="48"><br/>
  <sub>github.com/arbazkhan971/relayforge</sub>
</p>
