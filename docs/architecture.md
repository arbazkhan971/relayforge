# Architecture

Loop Orchestrator is a small Node.js CLI (Node >= 20) built around a parent-owned autonomy loop:

- Config: `loop.config.yaml` defines one or more projects, each with providers, roles, and loops. Execution works on a single repository (`workingDir`) at a time.
- Parent orchestrator: owns all coordination state — the board, run state, and cost ledger. Agents never write it; they make a code change and report in their final message, and the parent decides.
- Prompt generation: each role receives a run-specific prompt file under `.loop/runs/<project>/<run-id>/prompts`.
- Git-worktree isolation: execution runs in loop-owned worktrees outside the repo (mandatory, always on), never touching the user's checkout. A worktree is not a host sandbox — untrusted verifier commands additionally run in an OS sandbox.
- Viewport: tmux is an optional viewport (`loop tmux new`, `loop logs`, dashboard panes); `loop monitor` needs no tmux at all. The loop runs fully headless without it. Every tmux call goes through one owned boundary (`src/tmux-client.ts`): argv-only (never a shell), exact `=name` targets, and `@loop-*` ownership metadata that is verified before a session is adopted, captured, or killed — so Loop can never take over or reap a session a human created. The user-facing workflow (`src/tmux-workflow.ts`: `pre`/`new`/`show`/`kill`/`prune`) is a pure function of an injected tmux boundary plus host facts (installed, enabled, nested, TTY), which is why the whole matrix is tested deterministically. No third-party tmux library is used: the npm `tmux` package is a deprecated placeholder and `node-tmux` is a stale wrapper, neither offering exact targeting, ownership, or an injectable boundary.
- Dashboard: a local, loopback-only HTTP server reads board/session status and redacted pane logs.

## Flow

1. `loop run "<goal>"` loads and validates config (schema + semantics).
2. The selected project and loop are resolved and a run id is assigned.
3. The existing `PROJECT-INTELLIGENCE.md` (written by `loop learn`) is read, role prompts are written, and the planner decomposes the goal into board tasks. `loop run` never writes project intelligence into the checkout — `loop learn` is the only command that writes that file.
4. Without `--execute`, the run is a true dry-run: no provider process is launched (not even the planner) and git is never touched — the board is driven for observability only.
5. With `--execute`, the loop requires a clean git working tree, creates an integration worktree on branch `loop/<project>/<run-id>/integration`, and for each dependency-satisfied task spawns a headless provider child in a throwaway attempt worktree.
6. Completion needs the child's exit code **and** structured output; an independent reviewer reviews the attempt's complete base-SHA patch; a deterministic verifier (the loop's `verify:` list, else auto-detected test then build) runs in order as the final gate — inside an OS sandbox with no network, no inherited secrets, and no host writes.
7. Accepted attempts merge into the integration branch and are re-verified. At the end, accepted work is left on `loop/<project>/<run-id>/integration` for a human to review and merge — nothing is auto-merged to `main`.

A real `--execute` run is `done` (exit 0) only when every task is accepted and the final ordered verifier is green; all accepted but no green verifier is `unverified` (exit non-zero). A successful dry-run ends in status `planned` (exit 0). Rejected, escalated, cancelled, stopped, unverified, or budget-exhausted runs all exit non-zero. Agents run only through the safe engine (`loop run --execute`); `loop start` is viewport-only and launches no agents.

## Provider Strategy

Providers are intentionally thin. The orchestrator does not need private SDK access. It runs terminal tools already authenticated on the machine:

- `claude`
- `codex`
- `gemini`
- any custom command

Models are unpinned by default for Codex and Gemini (the provider CLI uses its own default); a Claude provider defaults to the `opus` alias (Opus is the primary executor), and `model:` overrides any provider. No unsafe provider flags are needed: Claude runs under `--permission-mode acceptEdits` (reviewers `plan`), Codex under `exec --sandbox workspace-write` (reviewers `read-only`) with effort via `-c model_reasoning_effort=...`, and untrusted verifier commands run in a separate OS sandbox. This keeps setup simple and makes the tool useful across different agent CLIs.

## Provider routing

Claude Opus (`claude -p` reading the prompt from **stdin**, model alias `opus`, every role's prompt begins `/goal` at byte 0, `--output-format stream-json --verbose --no-session-persistence`) is the **primary** implementation executor. A Codex/GPT provider is used as a **fallback only** on an explicitly-classified Claude usage/rate/quota limit — never on auth, model, generic, or test failures, which the primary must own. A cooldown is persisted per provider; once it expires, Opus is retried automatically. When both the `claude` and `codex` CLIs are installed, `loop init` auto-configures this chain (an `opus` claude provider plus a `gpt` codex provider with `fallbackFor: opus`); when only one CLI is installed it emits a single provider. Providers may set `fallbackFor: <providerKey>` and `cooldownSeconds`.
