# Agent Orchestrator worktree audit

Audited 2026-08-09 at commit
`f65c48e296e20a816221a4003c75a5f0387967ec`.

## Identity and legal status

`https://github.com/AgentWrapper/agent-orchestrator` redirects to
`https://github.com/Untrivial-ai/agent-orchestrator`. Both local checkouts have
the same GitHub repository ID, commit, and tree. The former therefore does not
count as an independent reference. Commit `6c966bc` records the repository
transfer.

The distribution is Apache-2.0, copyright 2026 Untrivial. It contains no NOTICE
file and no file-level copyright headers. Ported or modified code must retain the
license obligations, exact provenance, and modification notices.

## Evidence inspected

- Worktree domain and adapter:
  `backend/internal/adapters/workspace/gitworktree/workspace.go`,
  `commands.go`, and their integration, preserve, force-destroy, removal, and
  path-safety tests.
- Lifecycle and recovery: `backend/internal/session_manager/manager.go`,
  `backend/internal/observe/reaper`, tmux runtime sources and tests.
- Provisioning: `backend/internal/domain/projectconfig.go`,
  `backend/internal/session_manager/provision_test.go`, and spawn wiring.
- Diagnostics: `backend/internal/cli/doctor.go`, its unit tests and E2E test.
- Architecture, current history, issue #2319, issue #3475, and PRs #2183,
  #2259, #2794, #3098, and #3491.
- Focused Go suites for worktrees, CLI, session manager, and reaper passed.
  The tmux suite exposed a reproducible upstream defect when user tmux indices
  begin at 1: restart hard-codes pane `:0.0`.

## Strong patterns

- Physical root normalization and traversal/component validation.
- Typed unsafe, dirty, lock, checked-out, missing-ref, and preserve errors.
- Safe destroy is distinct from force destroy.
- A stale target registration is recovered with one target-specific
  `git worktree add --force`; repository-wide pruning is avoided.
- Failed `add -b` branch side effects are detected before retrying the existing
  branch form.
- Preservation uses a temporary Git index and a dedicated ref without changing
  the user's real index or stash.
- Boot recovery treats a failed liveness probe as inconclusive and uses a
  mass-death circuit breaker for shared runtime failures.
- Runtime prerequisites are checked before creating durable session state.

## Weak patterns

- Lifecycle strings lack a transition table, leases, generations, and an event
  journal; several cleanup operations are best-effort without durable repair
  state.
- Git error classification is based on English stderr.
- Preservation apply conflates content conflicts with operational failures.
- Multi-repository preservation and teardown are not atomic.
- Provisioning is only sequential symlink creation and raw shell commands: no
  timeout, cache, lock, checksum, structured result, rollback, or safe secret
  policy. Missing symlink sources are silently ignored and existing targets are
  not verified.
- Doctor only stats the database and does not reconcile Git, store, runtime, or
  provision state.
- The tmux restart command assumes window/pane index zero.

## Reuse decision

| Area | Classification | RelayForge decision |
| --- | --- | --- |
| Worktree lifecycle | `PORTED_IMPLEMENTATION` | Independently port conservative recovery behavior into explicit reconciled state machines. |
| Temp-index preservation | `PORTED_IMPLEMENTATION` | Adopt the behavior with stronger failure classes and generation/CAS markers. |
| Windows removal retry | `MODIFIED_COPY` candidate | Only after exact file provenance and attribution are recorded. |
| Reaper/recovery | `ARCHITECTURAL_INSPIRATION` | Add leases, event history, durable repair state, and deterministic reconciliation. |
| Doctor | `IDEA_ONLY` | Retain stable text/JSON semantics but substantially expand checks. |
| Provisioning | `NOT_USED` | Build a safe, versioned, observable provisioning mechanism instead. |
| Tests | `ARCHITECTURAL_INSPIRATION` | Independently reproduce behavioral coverage. |
| AgentWrapper alias | `NOT_USED` | Record only as the legacy repository URL. |

## RelayForge improvements required

1. Explicit lifecycle state machines, append-only events, generations, and
   task/worktree leases.
2. Deterministic reconciliation and durable repair state.
3. Distinct content-conflict and operational-failure outcomes.
4. Atomic multi-repository workspace generations and rollback.
5. Fail-closed, inode-isolated, cached and observable dependency provisioning.
6. Store/worktree/runtime/provision reconciliation in doctor.
7. Stable tmux pane discovery or RelayForge-owned index configuration.
