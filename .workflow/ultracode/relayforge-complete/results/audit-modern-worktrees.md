# Modern worktree implementation audit

Audited 2026-08-09. No reference checkout was modified.

## Reference matrix

| Repository | Audited commit | Strongest relevant behavior | Material weakness | License | Reuse |
| --- | --- | --- | --- | --- | --- |
| `agent-worktree` | `eb309652` | Safe branch reuse, reflink file copy, no-follow walk, submodule and wrapper UX, focused tests | Skips every symlink (breaking npm `.bin`), trusts unsandboxed hooks, non-atomic metadata, cleanup can hide failures | MIT | `PORTED_IMPLEMENTATION` |
| `overstory` | `ff38f3f7` | Post-create validation, rollback, nested-child guard, doctor/reconciliation | Archived; forceful cleanup and PID-reuse risk; tracked-file validation rejects valid empty repos | MIT | `ARCHITECTURAL_INSPIRATION` with selective ports |
| `awslabs/cli-agent-orchestrator` | `38527f47` | Bounded Git subprocesses, nested path identity, duplicated environment validation and allowlisting | Worktrees are an early Phase-1 feature; destructive forced removal; no setup or reconcile lifecycle | Apache-2.0 plus NOTICE | `PORTED_IMPLEMENTATION` for bounded runners/environment policy |
| `agtx` | `ce617fab` | Canonical-project/config-hash trust gate | Deletes branches on retry, follows some nested links, setup has no timeout, cleanup errors are hidden | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |

Approximate subsystem quality scores were `agent-worktree` 82/100,
Overstory 80/100 (before its archival discount), AWS CAO 68/100, and agtx
60/100. Stars were not used in the selection.

## Source and test evidence

### agent-worktree

- Safe create/remove semantics: `src/git/worktree.rs:10-43`.
- Setup, copy and hook flow: `src/cli/commands/lifecycle/new.rs:48-257`.
- Architecture and operator contracts: `ARCHITECTURE.md:105-133`,
  `:146-219`, `:223-295`, and `:323-371`.
- Copy, symlink, hook, submodule and hooksPath tests:
  `tests/cmd_new.rs:207-466` and `tests/cmd_hooks.rs:13-117`.
- Reflink and symlink hardening commits: `4f26dc8`, `ea7dd1b`, and
  `7b7c880`.

The walker does not follow links and skips all symlink entries. This is safer
than copying unchecked links, but cannot meet RelayForge's working local
toolchain requirement because package-manager `.bin` entries are normally
relative symlinks. RelayForge must improve it by admitting only links whose
lexical and physical targets remain inside the copied tree, then revalidating
the staged destination.

### Overstory

- Create, validate, rollback and porcelain parsing:
  `src/worktree/manager.ts:38-248`.
- Cleanup and reconciliation: `src/commands/worktree.ts:28-325`.
- Doctor categories and consistency model: `src/commands/doctor.ts:29-261`
  and `src/doctor/consistency.ts:38-280`.
- Regression tests: `src/worktree/manager.test.ts:63-204`, `:520-660`, and
  `src/doctor/consistency.test.ts:134-542`.
- Relevant fixes: `ae3b363`, `caee979`, `15f17fb`, `1158a88`, and
  `df4d04b`.

Its post-create validation should inspire RelayForge, but validation must use
canonical Git registration, branch, HEAD and common-directory identity—not the
presence of a tracked file, because empty commits are legitimate.

### AWS CLI Agent Orchestrator

- Thirty-second Git runner and error normalization:
  `src/cli_agent_orchestrator/services/worktree_service.py:35-69`.
- Git-authoritative state and nested identity:
  `worktree_service.py:189-258`.
- Teardown identity check:
  `src/cli_agent_orchestrator/services/terminal_service.py:1546-1574`.
- Client/server environment validation and minimal inheritance:
  `src/cli_agent_orchestrator/cli/commands/launch.py:38-90`, `:297-303`,
  and `src/cli_agent_orchestrator/clients/tmux.py:291-388`.
- Real worktree and wrong-terminal-CWD regressions:
  `test/services/test_worktree_service.py:72-301` and
  `test/services/test_terminal_service_full.py:1853-2009`.
- Worktree phase commit `bb2f4c5`, tied to issue #100 and PR #495.

### agtx

- Create, copy, setup and cleanup: `src/git/worktree.rs:24-350`.
- Canonical config-hash trust store: `src/config/mod.rs:649-719`.
- Setup/copy/traversal tests: `tests/git_tests.rs:138-166`, `:219-249`,
  `:300-466`, and `:577-680`.
- Trust hardening commit `875dfaf`.

## Chosen synthesis

Use agent-worktree's narrow copy sandbox and reflink-first behavior as the
baseline; independently implement internal-only symlink preservation so local
tool shims work. Use Overstory's validation/reconciliation lessons and AWS
CAO's bounded-process and environment boundary patterns. Setup hooks, when later
introduced, require agtx-style canonical config trust plus timeouts,
cancellation, structured redacted output, and a direct-argv mode.

RelayForge will additionally use durable intent/events, operation generations,
leases, safe non-force removal, atomic metadata, and explicit repair state. Git
porcelain remains observed truth, while RelayForge state records intent and
reconciliation—not a competing fiction.

## Phase-0 characterization coverage

1. Reject POSIX and Windows absolute paths, traversal, root/control paths,
   source/ancestor escapes, nested external links and broken destination links.
2. Preserve an internal relative `.bin` symlink and executable target while
   proving every copied regular file has a distinct source inode.
3. Publish only a complete staged tree; clean partial staging after injected
   clone/copy failure and preserve a prior valid destination.
4. Fail closed before any provider or verifier call on a missing, unsafe or
   failed configured source.
5. Doctor reports absent/unsafe/non-directory source without mutating disk.
6. Later lifecycle phases add crash-boundary, branch-occupancy, dirty cleanup,
   Git-registration and reconciliation matrices from these references.

## Legal notes

- `agent-worktree` and Overstory are MIT; substantial ports must retain their
  copyright and license notices.
- agtx is Apache-2.0. AWS CAO is Apache-2.0 and carries an Amazon NOTICE that
  must accompany applicable direct reuse.
- No code was copied during this audit.
