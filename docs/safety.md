# Safety

Two layers contain execution: an **isolated git worktree** so your checkout is never touched, and an **OS sandbox** for untrusted verifier commands. A git worktree is *not* a host sandbox — it only isolates the working tree and branch — so Loop Orchestrator does not treat it as a security boundary for running untrusted commands.

## The isolation model

- Execution requires a **git repository with a clean working tree**. The loop refuses otherwise with an actionable message.
- Execution **never** modifies, resets, cleans, checks out, or merges into your checked-out branch or working tree. Your checkout is left completely untouched.
- Work happens in loop-owned git worktrees **outside** the repo (isolation is always on and mandatory):
  - a dedicated **integration branch** `loop/<project>/<run-id>/integration`, branched from the base commit, accumulates accepted work and is re-verified;
  - each task attempt runs in its own **throwaway attempt worktree/branch**, discarded on reject.
- At the end, accepted work is **left on the run branch** for a human to review and merge (`git log loop/<project>/<run-id>/integration`, then open a PR). Nothing is auto-merged to `main`.

## Provider permissions

- Providers run without host permission bypass by default. Claude implementers use `--permission-mode acceptEdits` and reviewers `--permission-mode plan` (read-only). Codex uses `exec --sandbox workspace-write` (implementer) / `--sandbox read-only` (reviewer), with reasoning effort via `-c model_reasoning_effort=<minimal|low|medium|high>` — never `--full-auto` or `--effort`. Gemini and custom providers make no provider-native safety claim; their containment is the OS sandbox.
- `dangerouslySkipPermissions` (Claude) is an explicit opt-in, **no longer added by default**, discouraged, and **requires an OS sandbox** — if none is available the run fails closed rather than running Claude with `--dangerously-skip-permissions`. `loop init` emits it off. Codex's `yolo` is **not supported** and is **rejected** by `loop validate` (it had no effect); Codex is contained by `exec --sandbox` plus the OS sandbox.

## The OS sandbox for provider and verifier commands

**Every** physical provider turn (planner, implementer, reviewer) **and** every verifier command runs inside an **OS sandbox** — Linux `bwrap` (bubblewrap) or macOS `sandbox-exec` — with:

- **no network** for verifiers (agents keep network to reach the model API),
- **no inherited secrets** (the environment is scrubbed to a small allowlist; host tokens/CI secrets never reach an agent or its shelled-out commands), and
- **no host writes** outside the disposable checkout.

If **no launchable** sandbox mechanism is available, a `loop run --execute` **fails closed before the planner** — no provider or verifier ever launches, the run ends `blocked`, and it can never reach `done`. There is **no** production environment variable that lifts this: containment or nothing. `loop doctor` reports (and fails) when no sandbox is launchable.

> **Honest limitation (this release).** The official `@anthropic-ai/sandbox-runtime` library is **not** integrated yet — there is no `srt` CLI. On a host where `bwrap` cannot launch (e.g. a nested container without unprivileged user namespaces) and no macOS `sandbox-exec` exists, `loop run --execute` fails closed. Tests exercise the loop via an **imported** trusted-runner injection (never an env var); production has no way to reach that path, so it cannot obtain `done` without a real boundary.

## Trust and correctness

- Agents **cannot** write the authoritative board, run state, or cost ledger — the parent orchestrator owns all coordination state. Agents just make their code change and report in a final message; the parent decides.
- Acceptance requires an **independent reviewer** (read-only, strict structured output — malformed output fails closed as a rejection) plus a **deterministic verifier** that runs commands in an explicit order.
- A change that turns a green suite red is reverted, and test/CI files are hashed to detect an agent weakening its own grader (reward-hacking guard).
- A real `--execute` run is **done** (exit 0) only when every task is accepted *and* the final ordered verifier is green; if every task is accepted but there is no green verifier the run is **unverified** (exit non-zero). A successful dry-run ends in status **planned** (exit 0). Rejected, escalated, cancelled, stopped, unverified, and budget-exhausted runs all exit non-zero.
- `loop stop <run>` cancels the running loop (a parent-owned cancellation flag) and kills its tmux sessions. Only sessions **this** project+run created are killed — they are matched by stamped `@loop-*` ownership metadata, never by a name substring, so a session you opened yourself (or another project's) is never reaped. The same rule governs `loop tmux kill` and `loop tmux prune`.

## Recommended Guardrails

- Dry-run (`loop run` without `--execute`) until the plan and config look right.
- Keep production branches protected and review the run branch before merging.
- Require PR review for database migrations, auth, billing, and security changes.
- Use read-only or staging databases during end-to-end testing.
- Avoid secrets in `loop.config.yaml`; prefer environment variables. `loop auth configure --write` stores auth metadata only, not secret values.
- Instruct agents never to modify test files or CI config to make checks pass, and to avoid destructive operations in every role prompt.

## Dashboard safety

The dashboard is unauthenticated, so it binds to `127.0.0.1` (loopback only), validates run/session ids against path traversal, only exposes tmux sessions **this project owns** — decided by the session's stamped `@loop-*` identity, not by a name substring, so a project called `demo` can no longer list or screen-scrape a session belonging to `demo-api` — and redacts environment variables and secrets from `/api/config` and logs.

## Database Safety

For local and staging testing:

- Use disposable seed data.
- Block writes to production databases from local environments.
- Prefer feature-specific test accounts.
- Require explicit human approval for migrations and backfills.

## Public Repo Hygiene

Do not commit:

- Private repository names
- Customer names
- Access tokens
- Internal URLs
- Real production credentials
