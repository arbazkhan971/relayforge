# Setup-workflow audit

Audited 2026-08-09. None of these projects implements dependency copying, and
none supersedes `agent-worktree` for that primitive.

| Repository | Commit | Relevant behavior | License | Reuse |
| --- | --- | --- | --- | --- |
| `stagewise-io/stagewise` | `104d1c2737` | Post-mount setup runner with bounded output, timeout, state and UI | AGPL-3.0 | `IDEA_ONLY` |
| `stellarlinkco/myclaude` | `f2e75c1263` | Minimal worktree creation and phase routing | AGPL-3.0 | `IDEA_ONLY` |
| `OpenBMB/ChatDev` | `4fb2db0ea9` | Agent-driven `uv` environment commands and bounded workflow loops | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` / `IDEA_ONLY` |

## Stagewise

The runner in
`apps/browser/src/backend/services/toolbox/services/mount-manager/worktree-setup-runner.ts`
deduplicates active runs, records explicit lifecycle state, applies a 20-minute
timeout, retains bounded output tails, throttles UI updates, supports POSIX and
Windows shells, and protects against late close events after timeout. Its test
file covers missing/fallback scripts, environment resolution, spawn, success,
failure, timeout, teardown and late events. Relevant fixes include `04eb7061`,
`1a2baa04`, `6533536e`, `04dfbe78`, `361ef7fc`, and `6de8e865`; PRs #1217,
#1267, and #1353 explain tradeoffs.

It is not a readiness gate: the mounted workspace is usable while setup runs.
It follows setup-script links, executes repository-controlled shell content,
deliberately forwards credential variables, kills only the direct child, keeps
state only in memory, and leaves a partial worktree mounted after failure.
RelayForge may reproduce lifecycle-result and late-event tests independently,
but will not copy AGPL code or run credential-bearing repository scripts in
Phase 00.

## MyClaude

`codeagent-wrapper/internal/worktree/worktree.go` is a small `git worktree add
-b` wrapper with clock/random/command seams and basic unit/real-Git tests. The
`/do` skill routes subsequent phases through `DO_WORKTREE_DIR`.

It has no dependency setup, fails open to the main checkout when creation
fails, accepts the worktree environment path without containment or Git identity
checks, has no timeout/cleanup/reconciliation, and can review from `.` rather
than the implementation worktree. Only the deterministic seams and stable
per-task identity are useful as ideas. `go test ./internal/worktree` passed.

## ChatDev

`functions/function_calling/uv_related.py` confines script paths to a session
workspace, validates package argv, avoids a shell, and imposes a 120-second
subprocess timeout. The workflow has bounded review/test loops and cooperative
cancellation checkpoints. Its adjacent provisioning is nevertheless networked,
agent-controlled `uv add`, inherits the full host environment, has no focused
tests, durable receipt, rollback, process-tree cancellation, or deterministic
resolution. `tests/test_server_main_reload.py` passed 20 tests; another focused
suite could not collect because the optional FastAPI dependency was absent.

## RelayForge conclusion

Keep Phase-00 provisioning as a parent-owned, offline copy before any agent,
reviewer, verifier, terminal, or mount consumer can use the worktree. Borrow
only Stagewise's explicit terminal states/bounded diagnostics/late-event race
tests, MyClaude's injected seams, and ChatDev's direct-argv principle for later
hook execution. Do not introduce repository scripts, credential inheritance,
or package installation in the initial gate.
