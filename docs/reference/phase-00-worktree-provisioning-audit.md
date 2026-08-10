# Phase 00 reference audit: worktree dependency provisioning

## Scope and audit gate

This audit was completed before implementing RelayForge's first self-hosting
slice: offline dependency provisioning for isolated Git worktrees. It answers a
narrow question: how can a parent process make an existing local toolchain
available inside integration, attempt, and review worktrees without letting an
agent modify the human checkout, observing a partial copy, or reaching outside
the configured repository?

The audit used source, tests, architecture/design documents, licenses, current
history, and relevant bug-fix history at the commits listed below. Repository
stars were not used as a selection criterion. The legacy
`AgentWrapper/agent-orchestrator` URL resolves to the same GitHub repository ID,
commit, and tree as `Untrivial-ai/agent-orchestrator`; it is an alias following
a repository transfer, not an independent reference.

No upstream code was copied while preparing this audit.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
| --- | --- | --- | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec) | Worktree adapter, temp-index preservation, spawn rollback, boot reconciliation, project symlinks/hooks, doctor | Best conservative Git recovery and preservation coverage; active on audit day | Provisioning is unbounded raw shell/symlink setup with weak validation; lifecycle lacks leases/events | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; provisioning itself `NOT_USED` |
| `AgentWrapper/agent-orchestrator` | Exact redirect/alias of the row above | Historical name only | Not an independent implementation | Apache-2.0 | `NOT_USED` as a separate source |
| [johannesjo/parallel-code](https://github.com/johannesjo/parallel-code/tree/d000fff65989f4c9fe48e5814a9d7c807ae83ba6) | Worktree/import UX, ignored-root discovery, dependency symlinks, retryable cleanup | Lightweight operator experience and imported-worktree ownership | Shares mutable `node_modules`/possibly `.env`; no durable reconciliation or lease | MIT | `IDEA_ONLY` for UX; shared dependency strategy `NOT_USED` |
| [daintreehq/daintree](https://github.com/daintreehq/daintree/tree/eb989c7613db8ff9dc948775291f56e42c5ada3a) | Serialized/coalesced creation, realpath containment, setup lifecycle, topology monitor, retry UX | Best local lifecycle and concurrency tests | Creation becomes visible before setup completes; trusted shell hooks; coupled service | Apache-2.0 plus NOTICE/trademark terms | `ARCHITECTURAL_INSPIRATION` |
| [GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion/tree/91c26b343a26b7697f9432de5792cd7372b391a6) | Shared clone/worktree provisioning, advisory locks, sentinels, sharer registry, container guards, doctor | Best distributed/container provisioning model | Provision/delete race; readiness sentinel lacks full topology validation; unsandboxed hooks | Apache-2.0 with file headers | `ARCHITECTURAL_INSPIRATION` |
| [nekocode/agent-worktree](https://github.com/nekocode/agent-worktree/tree/eb309652dc1d2cc0db4a30267038fd75c8ae927a) | Safe file-pattern copy, reflink fallback, worktree CRUD, submodules, wrapper/status UX | Best narrow copy sandbox and focused setup tests | Skips every symlink, breaking package-manager `.bin`; hooks untrusted/unbounded; non-atomic metadata | MIT | `ARCHITECTURAL_INSPIRATION`; independently implement the behavior |
| [jayminwest/overstory](https://github.com/jayminwest/overstory/tree/ff38f3f76f084abcc34f519bcaa69580f6e53cf1) | Post-create validation/rollback and doctor reconciliation | Best local consistency/recovery model after Daintree | Archived; force cleanup and PID-reuse risks; rejects valid empty repos in one check | MIT | `ARCHITECTURAL_INSPIRATION` |
| [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator/tree/38527f47515d4aa97c306ba188607beee9272ed1) | Bounded Git runner, nested path identity, minimal environment forwarding | Best bounded subprocess/environment boundary in this group | Worktrees are an early feature; forced removal; no setup/reconcile state | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` for Phase 00; possible later port |
| [fynnfluegge/agtx](https://github.com/fynnfluegge/agtx/tree/ce617fabcd3b7d84dabbff8c2ba72fed5231b2aa) | Config copy/setup scripts and canonical-project config-hash trust | Useful trust-on-config-change concept | Branch deletion on retry, nested-link weakness, no hook timeout, hidden cleanup errors | Apache-2.0 | `IDEA_ONLY` for later hook trust |
| [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise/tree/104d1c2737) | Post-mount setup-runner state, timeout, bounded tails and platform UX | Best setup lifecycle tests and operator visibility in the secondary set | Not a readiness gate; follows script links; forwards credentials; direct-child kill only | AGPL-3.0 | `IDEA_ONLY` |
| [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude/tree/f2e75c1263) | Minimal worktree creation and phase routing | Simple injected clock/random/command seams | Fails open, trusts raw worktree env path, no setup/cleanup/reconcile | AGPL-3.0 | `IDEA_ONLY` |
| [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev/tree/4fb2db0ea9) | Bounded argv-based `uv` workspace commands | Avoids shell interpolation and bounds direct subprocess time | Networked, nondeterministic, full environment, agent-controlled, no focused provisioning tests | Apache-2.0 | `IDEA_ONLY`; copy path `NOT_USED` |

## Source, test, and bug-fix evidence

### Agent Orchestrator baseline

The primary reference physically normalizes managed roots, distinguishes safe
and forced destruction, recovers a target-specific stale registration without a
repository-wide prune, and preserves dirty work through a temporary Git index
and dedicated ref. The relevant implementation is under
`backend/internal/adapters/workspace/gitworktree`; its real-Git integration,
preservation, forced-destroy, removal, and path tests cover dirty and locked
worktrees, sibling registration recovery, Windows retry, and preservation
conflicts.

Its project setup path in `backend/internal/session_manager/manager.go` is not a
suitable dependency implementation: it creates configured symlinks and runs
sequential `sh -c`/`cmd /c` commands without a timeout, cache, checksum,
structured result, rollback, or target verification. Missing sources are
silently skipped. RelayForge will not reuse that path.

[PR #3098](https://github.com/Untrivial-ai/agent-orchestrator/pull/3098)
documents why broad prune/remove recovery can erase sibling registrations and
why a failed `worktree add -b` may leave a branch. [Issue
#3475](https://github.com/Untrivial-ai/agent-orchestrator/issues/3475) and [PR
#3491](https://github.com/Untrivial-ai/agent-orchestrator/pull/3491) document a
shared tmux failure being misclassified as mass per-session death. These become
RelayForge recovery tests in the later lifecycle phase.

### Copy mechanics

`agent-worktree` validates copy patterns, walks without following links, skips
symlink entries, prefers filesystem reflinks, removes broken destination links,
and tests traversal plus external/in-repository symlinks in
`src/cli/commands/lifecycle/new.rs` and `tests/cmd_new.rs`. Commits `4f26dc8`,
`ea7dd1b`, and `7b7c880` capture the reflink and symlink hardening sequence.

That is the strongest starting behavior, but skipping every link fails
RelayForge's local-toolchain requirement: npm-compatible `.bin` tools are
normally relative links into the same dependency tree. RelayForge will preserve
only a relative link whose lexical target and final physical source target both
remain inside the configured source tree. It will repeat the containment check
against the staged destination before publication.

### Creation, readiness, and recovery

Daintree coalesces duplicate creates, serializes mutations per repository,
recovers after a rejected queue entry, validates canonical containment, marks
pending topology around `git worktree add`, monitors the resulting checkout,
and exposes retryable setup failures. Its creation, deletion, lifecycle, and
resource tests cover concurrency, delayed visibility, path escape, teardown
ordering, process termination, log scrubbing, and retry.

The important correction is architectural: the worktree create result is
returned before asynchronous setup completes. RelayForge instead treats
`CREATED` and `PROVISIONING` as non-runnable states. A provider, reviewer, or
verifier may run only after synchronous Phase-00 provisioning succeeds; the
later daemon phase will persist the full `CREATING → CREATED → PROVISIONING →
READY` state machine.

Scion adds advisory locking, idempotent shared-clone/per-agent sequencing,
atomic sentinel/registry writes, host/container path guards, layered context,
and broad doctor coverage. Its source and tests under `pkg/provision`,
`pkg/agent`, `pkg/util`, and `cmd/doctor.go` expose a remaining provision/delete
race because deletion does not hold the provisioning lock. RelayForge will use
one lease domain for both operations rather than copying that split.

Overstory validates creation and rolls back failed topology, then reconciles
session, Git, filesystem, terminal, PID, and structural facts in doctor. The
validation lesson is retained, but RelayForge will compare canonical
registration, expected branch/HEAD, and common Git directory; it will not use
“contains a tracked file,” which incorrectly rejects legitimate empty commits.

### Setup runners and adjacent environment workflows

Stagewise has the strongest setup-runner lifecycle tests in the secondary set:
explicit running/succeeded/failed results, bounded output tails, timeout,
teardown interruption, Windows/POSIX variants, and guards against late events.
It is unsuitable as an implementation source here because setup starts after
mount, follows script links, deliberately receives credentials, kills only the
direct child, and is AGPL-3.0. MyClaude provides only a minimal, fail-open
worktree wrapper and is also AGPL-3.0. ChatDev's `uv` commands use direct argv
and a timeout, but installation is networked, environment-inheriting,
nondeterministic, and controlled by an agent rather than a workflow state.

None implements a safer dependency copy than `agent-worktree`. RelayForge will
independently reproduce Stagewise-style terminal-state and late-completion tests
without adopting automatic repository scripts in Phase 00.

## Worktree strategy comparison

| Strategy | Benefit | Disqualifying risk or limitation | RelayForge decision |
| --- | --- | --- | --- |
| Symlink dependency root (Parallel Code) | Instant and disk-cheap | Agent writes reach the human checkout; `.env` may expose secrets | Reject |
| Hardlink farm | Fast and disk-cheap | In-place writes share source inodes and poison sibling trees | Reject |
| Run package installer in each worktree | Familiar and reconstructible | Network/non-determinism, credentials, scripts, and latency | Not part of offline Phase 00 |
| Skip every symlink (agent-worktree) | Simple no-follow boundary | Breaks executable shims and some package layouts | Adapt, with constrained internal links |
| Reflink then byte-copy fallback | Isolated writes with good CoW performance | Requires validation and safe partial-copy handling | Choose |
| Return create before setup (Daintree) | Responsive UI | A consumer can observe/use an unready checkout | Reject; gate on `READY` |

## Chosen design

Best implementation discovered for each subproblem:

- narrow file-copy mechanics: `agent-worktree`;
- local lifecycle/concurrency: Daintree;
- distributed provisioning and diagnostics: Scion;
- conservative Git recovery/preservation: Agent Orchestrator;
- post-create consistency checks: Overstory;
- bounded environment/process policy: AWS CLI Agent Orchestrator.

Why: no repository dominates all of correctness, recovery, operator UX,
isolation, and distributed execution. The selected behaviors compose around
RelayForge's parent-owned state and fail-closed launch boundary without
importing an upstream framework.

What RelayForge will reuse:

1. Canonical relative-path validation and an explicit no-follow recursive walk.
2. Pinned-descriptor file copying with reflink-or-byte-copy behavior.
3. Parent-private same-filesystem staging, backup/restore publication and
   explicit structured results.
4. Source/destination physical containment checks.
5. Read-only diagnostics with actionable output.
6. A readiness gate before any planner, worker, reviewer, or verifier executes.

What RelayForge will change:

1. Use structured `{ path, requiredExecutables }` specifications and reject
   empty/root, `.git`, `.loop`, NUL, control bytes, traversal, POSIX absolute, Windows
   rooted/drive/UNC, and any physically escaping source or destination.
2. Preserve only validated relative internal symlinks; reject absolute,
   dangling, or escaping links.
3. Revalidate the staged tree and prove regular files do not share source
   inodes before publication; reject sockets, FIFOs and devices.
4. Treat an explicitly configured missing/non-directory source or any copy
   failure as a blocking error, not a warning.
5. Reconcile deterministic staging/backup crash states, preserve a prior
   destination on ordinary failure, and emit a bounded parent-side event.
6. Make doctor inspect the configured source without mutating it.

How RelayForge improves it:

- It combines the safety of skipping external links with a working local
  package-manager toolchain.
- It makes readiness an execution precondition rather than a UI convention.
- It validates both lexical and physical containment on both sides of the copy.
- It tests source mutation isolation, ancestor-link escapes, control paths,
  injected partial-copy failure, executable `.bin` links, and fail-before-spawn
  wiring.
- It leaves a clean migration path to durable provisioning generations, locks,
  caching, and reconciliation in the daemon architecture.

## Required characterization tests

1. Copy ordinary files with distinct `(dev, ino)` identity, mutate the target,
   and prove the origin is unchanged.
2. Preserve an executable internal `.bin` link and execute/read its target.
3. Reject POSIX, drive, UNC, and single-leading-backslash rooted paths plus all
   `..` separator variants.
4. Reject root, `.git`, `.loop`, nested control paths, NUL, and duplicate paths.
5. Reject a configured source whose ancestor is a symlink outside the origin.
6. Reject absolute, dangling, lexically escaping, and physically escaping
   nested links; accept only relative internal links.
7. Reject a destination with a symlinked ancestor and never modify the link
   target.
8. On clone and plain-copy failure, publish no partial tree and preserve a prior
   valid destination.
9. Missing/non-directory configured sources produce typed blocking outcomes.
10. Integration, attempt, and review worktrees are provisioned before their
    first planner/provider/reviewer/verifier use.
11. Doctor reports every source as ready, missing, unsafe, or invalid with a
    concrete fix and performs no write.

## Legal conclusion

Phase 00 will be independently implemented from documented behaviors and tests.
No direct or modified copy is planned. The attribution ledger records every
source even when its implementation is rejected. Any later substantial port
must be reclassified before it lands and must carry the applicable MIT notice,
Apache-2.0 modification/attribution terms, and repository NOTICE where present.
