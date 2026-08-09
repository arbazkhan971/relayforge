# Upstream Sources

This ledger records source-level research and any reuse in RelayForge. “Studied”
does not imply copied. Reuse classifications are:

- `DIRECT_COPY`
- `MODIFIED_COPY`
- `PORTED_IMPLEMENTATION`
- `ARCHITECTURAL_INSPIRATION`
- `IDEA_ONLY`
- `NOT_USED`

If a later change copies or closely ports more than this ledger records, update
the entry in the same change, retain the upstream notices, and mark modified
files as required by the applicable license.

## Baseline streaming-framer performance correction

Audit: [RawFramer tiny-frame allocation audit](../.workflow/ultracode/relayforge-complete/results/audit-streaming-framer-performance.md)

RelayForge's existing exact raw-byte ceiling, source-copy ownership, synchronous
borrowed-frame lifetime, and whole-stream fatal-authority rules remain the local
contract. The change only retains one inactive 64-KiB-or-smaller slab for reuse
after the synchronous callback returns.

- [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator),
  commit `f65c48e296e20a816221a4003c75a5f0387967ec`: browser-runtime JSONL
  bridge, terminal attachment/manager, bounded terminal queues, tests, and
  relevant history were studied. License Apache-2.0. Reuse:
  `ARCHITECTURAL_INSPIRATION` for explicit overload/ownership policy only.
- [openai/codex](https://github.com/openai/codex), commit
  `646f7c0a91b8e327d263335da68ae8ef212895ce`: MCP process transport,
  `LineBuffer`, exact-boundary tests, and PR #31805 were studied. License
  Apache-2.0 with NOTICE. Reuse: `ARCHITECTURAL_INSPIRATION` for reusable
  byte capacity; no Rust code, tests, constants, comments, or fatal semantics
  were copied.
- [tokio-rs/tokio](https://github.com/tokio-rs/tokio), commit
  `ecd621dd2c1a5205a84f579225e1454b62af211c`: `LinesCodec`, `FramedRead`,
  codec tests, and oversize/EOF/scan bug-fix history were studied. License MIT.
  Reuse: `ARCHITECTURAL_INSPIRATION`; implementation independently written.
- [mcollina/split2](https://github.com/mcollina/split2), commit
  `ccbd1996e0fde327966e4c862d915ea28272d4ea`, and
  [Node.js](https://github.com/nodejs/node), commit
  `45ecaaddbeddcc317b1e794f1d82e45aeb5fbfbe`: source, tests, limits,
  backpressure, EOF history, and open concatenation/heap issues were studied as
  negative and adjacent references. Licenses ISC and Node's permissive terms.
  Reuse: `IDEA_ONLY` / `NOT_USED`.

No upstream expression was copied. RelayForge improves the surveyed designs for
this boundary by preserving exact input-byte authority and making the cached
slab unavailable during reentrant callbacks, with allocation-count, mutation,
throw, cap, RSS, and real-child regressions.

## Phase 00 — worktree dependency provisioning

Audit: [Phase 00 reference audit](reference/phase-00-worktree-provisioning-audit.md)

### Git worktree recovery and preservation

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited commit: `f65c48e296e20a816221a4003c75a5f0387967ec`
- Legacy alias: `AgentWrapper/agent-orchestrator` (same GitHub repository and
  tree; not counted twice)
- Files studied:
  - `backend/internal/adapters/workspace/gitworktree/workspace.go`
  - `backend/internal/adapters/workspace/gitworktree/commands.go`
  - worktree integration, preserve, force-destroy, removal, and path tests
  - `backend/internal/session_manager/manager.go`
  - `backend/internal/observe/reaper`
  - `backend/internal/cli/doctor.go` and tests
  - `docs/architecture.md`
- Issues/PRs studied: #2319, #2259, #2794, #3098, #3475, #3491
- License: Apache-2.0; copyright 2026 Untrivial; no NOTICE found
- Reuse: `ARCHITECTURAL_INSPIRATION`
- Provisioning implementation: `NOT_USED`
- RelayForge changes:
  - explicit readiness before dispatch;
  - later generations, leases, events, and deterministic reconciliation;
  - separate operational failure from content conflict;
  - safe internal-only links rather than unverified project symlinks.

No source, comments, tests, or documentation text was copied.

### Safe dependency-copy mechanics

Reference: [nekocode/agent-worktree](https://github.com/nekocode/agent-worktree)

- Audited commit: `eb309652dc1d2cc0db4a30267038fd75c8ae927a`
- Files studied:
  - `src/cli/commands/lifecycle/new.rs`
  - `src/git/worktree.rs`
  - `tests/cmd_new.rs`
  - `tests/cmd_hooks.rs`
  - `ARCHITECTURE.md`
- Bug-fix commits studied: `4f26dc8`, `ea7dd1b`, `7b7c880`, `e695058`
- License: MIT; copyright notice retained in the upstream distribution; no
  NOTICE or sampled file headers found
- Reuse: `ARCHITECTURAL_INSPIRATION`; behavior independently implemented
- RelayForge changes:
  - validates source and target physical containment;
  - preserves only relative links contained in the copied tree instead of
    skipping every link;
  - revalidates staging and source inode separation;
  - blocks execution on failure and adds doctor coverage;
  - uses an explicit pinned-descriptor walker rather than recursive upstream or
    Node copy helpers;
  - stages outside the agent-visible target, reconciles backup/staging state,
    and preserves an existing destination on ordinary failure.

No Rust source or test text was copied.

### Local lifecycle and operator UX

Reference: [daintreehq/daintree](https://github.com/daintreehq/daintree)

- Audited commit: `eb989c7613db8ff9dc948775291f56e42c5ada3a`
- Files studied:
  - `electron/workspace-host/WorkspaceService.ts`
  - `electron/workspace-host/worktreeUtils.ts`
  - `electron/workspace-host/WorktreeLifecycleService.ts`
  - create, delete, lifecycle, resource, monitor, and E2E tests
  - `src/hooks/useContextInjection.ts`
  - `docs/vision.md` and `docs/architecture/state-management.md`
- Bug-fix commits studied: `2f40ef9`, `928f036`, `41cd70e`, `260a99b`,
  `835c5b9`, `723716b`
- License: Apache-2.0; NOTICE present; separate trademark terms
- Reuse: `ARCHITECTURAL_INSPIRATION`
- RelayForge changes:
  - provisioning is a blocking lifecycle state rather than an asynchronous tail;
  - resource failures remain durable repair work;
  - future mutations use persisted operations and cross-process leases.

No code was copied and no Daintree names or marks are used.

### Distributed/container provisioning and doctor

Reference: [GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion)

- Audited commit: `91c26b343a26b7697f9432de5792cd7372b391a6`
- Files studied:
  - `pkg/util/git.go` and tests
  - `pkg/provision/provision.go`, `pkg/provision/sharers.go`, and tests
  - `pkg/agent/provision.go`, delete/recovery tests
  - `cmd/doctor.go` and `cmd/sciontool/commands/doctor.go`
  - `.design/worktree-per-agent-phase1-plan.md`
  - `.design/worktree-guards.md`
  - `.design/nfs-workspace.md`
  - `.design/project-prestart-hooks.md`
- Bug-fix commits studied: `b40cd05`, `5a61445`, `24b2609`, `b57426e`,
  `7c12c09`, `95ec9f6`, `fbc674c`
- License: Apache-2.0 with Google source-file copyright headers; no root NOTICE
  found at audit time
- Reuse: `ARCHITECTURAL_INSPIRATION`
- RelayForge changes:
  - readiness proves topology/configuration rather than sentinel existence;
  - provision and delete share one lease domain;
  - later registry generations are reconciled rather than silently skipped.

No Go source or tests were copied.

### Lightweight parallel worktree UX

Reference: [johannesjo/parallel-code](https://github.com/johannesjo/parallel-code)

- Audited commit: `d000fff65989f4c9fe48e5814a9d7c807ae83ba6`
- Files studied:
  - `electron/ipc/git.ts` and worktree/exclude tests
  - `electron/mcp/coordinator.ts`
  - `electron/mcp/preamble.ts`
  - `electron/ipc/tasks.ts`
  - `src/store/tasks.ts`
  - `docs/architecture-overview.html`
- Bug-fix commits studied: `054060b`, `146578b`, `c9fcfff`, `630249d`,
  `d25d586`, `0959901`
- License: MIT; no NOTICE or sampled source headers found
- Reuse: `IDEA_ONLY` for imported-worktree/retry UX
- Shared dependency and `.env` symlink strategy: `NOT_USED`
- RelayForge changes:
  - imported/user-owned worktrees will never be deleted implicitly;
  - mutable dependencies and secrets are isolated, not symlinked.

### Post-create validation and reconciliation

Reference: [jayminwest/overstory](https://github.com/jayminwest/overstory)

- Audited commit: `ff38f3f76f084abcc34f519bcaa69580f6e53cf1`
- Repository status: archived 2026-05-28
- Files studied:
  - `src/worktree/manager.ts` and tests
  - `src/commands/worktree.ts`
  - `src/commands/doctor.ts`
  - `src/doctor/consistency.ts` and tests
- Bug-fix commits studied: `ae3b363`, `895e523`, `caee979`, `15f17fb`,
  `1158a88`, `df4d04b`
- License: MIT; no NOTICE or sampled source headers found
- Reuse: `ARCHITECTURAL_INSPIRATION`
- RelayForge changes:
  - validate Git registration, branch, HEAD, and common directory while allowing
    empty repositories;
  - use generation-safe process identity and non-force cleanup;
  - retain repairable state when cleanup fails.

### Bounded Git and environment policy

Reference: [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator)

- Audited commit: `38527f47515d4aa97c306ba188607beee9272ed1`
- Files studied:
  - `src/cli_agent_orchestrator/services/worktree_service.py`
  - `src/cli_agent_orchestrator/services/terminal_service.py`
  - `src/cli_agent_orchestrator/clients/tmux.py`
  - `src/cli_agent_orchestrator/cli/commands/launch.py`
  - worktree, terminal, environment, and tmux tests
- Worktree phase commit: `bb2f4c5` (issue #100 / PR #495)
- License: Apache-2.0; Amazon NOTICE present
- Reuse in Phase 00: `ARCHITECTURAL_INSPIRATION`
- Possible later bounded-runner/environment port: not yet adopted
- RelayForge changes:
  - bounded subprocesses will preserve evidence and durable repair state;
  - environment policy will use secret references and restart-safe state.

### Configuration trust for future setup hooks

Reference: [fynnfluegge/agtx](https://github.com/fynnfluegge/agtx)

- Audited commit: `ce617fabcd3b7d84dabbff8c2ba72fed5231b2aa`
- Files studied: `src/git/worktree.rs`, `src/config/mod.rs`, and
  `tests/git_tests.rs`
- Hardening commit studied: `875dfaf`
- License: Apache-2.0; no NOTICE or sampled source headers found
- Reuse: `IDEA_ONLY`
- RelayForge changes: future hook trust state must be atomic, permission-safe,
  revocable, audited, bounded, and keyed to canonical project plus content hash.

No agtx code is used in Phase 00.

### Worktree setup lifecycle UX

Reference: [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise)

- Audited commit: `104d1c2737`
- Files studied:
  - `apps/browser/src/shared/worktree-setup.ts`
  - `apps/browser/src/backend/services/toolbox/services/mount-manager/worktree-setup-runner.ts`
  - `worktree-setup-runner.test.ts`
  - worktree setup settings and Git path action tests
  - agent-shell environment sanitization
- Bug-fix commits studied: `04eb7061`, `1a2baa04`, `6533536e`, `04dfbe78`,
  `361ef7fc`, `6de8e865`; PRs #1217, #1267, #1353
- License: AGPL-3.0; no NOTICE or sampled file headers found
- Reuse: `IDEA_ONLY`
- RelayForge changes: setup is a readiness gate; no automatic credential-bearing
  scripts; process-tree cancellation and durable results; independently written
  bounded-tail and late-event tests.

No Stagewise code is copied into this MIT-licensed project.

### Minimal phase worktree routing

Reference: [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude)

- Audited commit: `f2e75c1263`
- Files studied: `codeagent-wrapper/internal/worktree/worktree.go`, its tests,
  executor workdir routing, and `skills/do/SKILL.md`
- Relevant commits: `74e4d18`, `5853539`, `664d827`
- License: AGPL-3.0; no NOTICE or sampled file headers found
- Reuse: `IDEA_ONLY` for injected seams and stable per-task identity
- Rejected behavior: fail-open fallback, raw `DO_WORKTREE_DIR`, and review from
  an unverified directory.

No MyClaude code is copied into this MIT-licensed project.

### Agent-driven Python environment setup

Reference: [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev)

- Audited commit: `4fb2db0ea9`
- Files studied:
  - `functions/function_calling/uv_related.py`
  - `yaml_instance/ChatDev_v1.yaml`
  - workflow parallel executor, cancellation, and runtime builder
  - server reload regression issue #569/tests and dependency issue #642
- License: Apache-2.0; no NOTICE or sampled file headers found
- Reuse: `IDEA_ONLY` for direct argv and bounded loops
- Provisioning implementation: `NOT_USED` because it is networked,
  nondeterministic, agent-controlled, environment-inheriting, and lacks durable
  receipts/recovery.

No ChatDev code is copied.

## Phase 00.2 — verifier cgroup-v2 delegation

Audit: [Phase 00.2 reference audit](reference/phase-00-2-verifier-cgroup-delegation-audit.md)

Decision: [ADR 001](adr/001-verifier-cgroup-delegation.md)

All entries in this section are behavioral or architectural research. No
upstream source, test, comment, or documentation text was copied.

### Primary process-containment baseline

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited `main`: `f65c48e296e20a816221a4003c75a5f0387967ec`
- Audited open PR #3550 head:
  `bd7baa54e829c3426cdeefe345b8252d1c8ed746`
- Files/tests studied:
  - `backend/internal/adapters/runtime/tmux/systemd_containment.go`
  - `backend/internal/adapters/runtime/tmux/systemd_containment_test.go`
  - `backend/internal/adapters/runtime/tmux/tmux_integration_test.go`
  - proposed `docs/adr/0002-worker-process-containment.md`
- Issues/history studied: issue #2523; PR #3550 and its 2026-08-08
  maintainer/CI discussion
- Evidence used: exact systemd unit-state waits, cgroup-wide kill policy,
  pre-launch backend rejection, and a real `setsid` canary
- Gap: no `Delegate=yes`, writable private cgroup view, structural bounds, or
  durable restart reconciliation; work remains unmerged
- License: Apache-2.0; root `LICENSE`; no relevant NOTICE/header found
- Reuse: `ARCHITECTURAL_INSPIRATION`

No AO code was copied.

### Coding-agent outer-resource baseline

Reference: [GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion)

- Audited commit: `91c26b343a26b7697f9432de5792cd7372b391a6`
- Files/tests studied:
  - `pkg/runtime/docker.go`
  - `pkg/runtime/podman.go`
  - `pkg/config/resource_defaults.go`
  - `pkg/runtime/k8s_runtime.go`
  - `pkg/runtime/k8s_hardening_test.go`
- History studied: PR #894, merge
  `298ff87bea60756f8caab28367dab485f63423af`
- Evidence used: outer CPU/memory configuration, fail-on-runtime-error behavior,
  incident-driven defaults, and hardened Kubernetes runtime tests
- Gap: no cgroup namespace, `nsdelegate`, structural limits, or writable child
  delegation
- License: Apache-2.0 with Google file headers; no root NOTICE found
- Reuse: `ARCHITECTURAL_INSPIRATION`

### Required Bubblewrap capability tests

Reference: [navikt/cplt](https://github.com/navikt/cplt)

- Audited commit: `4c056bcfbf43c9a1261f7bd823d0973efaefeeb8`
- Files/tests studied:
  - `src/sandbox_bubblewrap.rs`
  - `tests/integration_linux.rs`
  - `.github/workflows/ci.yaml`
  - unit test `bwrap_managed_subtrees_are_not_rebound`
- Issues/history studied: issues #113 and #126; commit
  `66b033a0b999a5f5f45faa0763115a598b2ffc8e`
- Evidence used: production-derived launch probe and a CI mode in which a
  missing sandbox fails instead of skipping
- Rejected behavior: `/sys/fs/cgroup` intentionally remains read-only and is
  not rebound
- License: MIT, Copyright 2025 Nav; no NOTICE found
- Reuse: `ARCHITECTURAL_INSPIRATION`

### Nested-operation negative case

Reference: [dtormoen/tsk](https://github.com/dtormoen/tsk)

- Audited commit: `bc0c0c6cb72920e69bcbc93b7ac08d9e20c3a55a`
- Files/tests studied:
  - `src/docker/mod.rs`
  - `tests/integration/projects/dind-build/tsk-integ-test.sh`
- History studied: `4f5c66c9fe6186b78bb1646ddbd56141993ae86b`,
  `5c88a1f`, `63f54e4`, and `ee88f76`
- Evidence used: genuine nested build smoke coverage
- Rejected behavior: nested mode disables memory/CPU limits; controller
  uncertainty can be treated as availability
- License: MIT, Copyright 2025 Danny Tormoen; no NOTICE found
- Reuse: `IDEA_ONLY` as a negative regression reference

### Bubblewrap launch identity and gate

Reference: [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox)

- Audited commit: `47d85df848f957f5e7b3231e435ef9333a57537c`
- Files/tests studied:
  - `components/execd/pkg/isolation/bwrap.go`
  - `components/execd/pkg/isolation/bwrap_linux.go`
  - `components/execd/pkg/isolation/lifecycle_linux.go`
  - `components/execd/pkg/isolation/lifecycle_linux_test.go`
- History studied: `f024c45c83ffce9e693d7f2f4ab312b256712c52`,
  `abeb9147a3d9c1cbb65b6cb5f2ce95b6bd4d21fe`, and
  `98db3933138bdb651c560d09ff745717739de17a`
- Evidence used: blocked pre-exec gate, authenticated child identity, bounded
  status parsing, and malformed/duplicate/oversized status tests
- Gap: `--unshare-cgroup` supplies a namespace view only; no writable subtree,
  structural bounds, or cleanup/recovery contract
- License: Apache-2.0; relevant files Copyright 2026 Alibaba Group Holding
  Ltd.; no repository NOTICE found
- Reuse: `ARCHITECTURAL_INSPIRATION`

### Nested namespace and capability ordering

Reference: [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)

- Audited commit: `121c6ac86df7c958aaf953d27116e74848c31318`
- Files/tests studied:
  - `src/sandbox/linux-sandbox-utils.ts`
  - `test/sandbox/pid-namespace-isolation.test.ts`
- History/issues studied: merged PR #390 and open PR #418
- Evidence used: outer-Bubblewrap/inner-namespace ordering and explicit user
  namespace plus `CAP_DROP ALL` regression history
- Gap: no cgroup namespace, limits, or writable delegation implementation
- License: Apache-2.0; no NOTICE found
- Reuse: `ARCHITECTURAL_INSPIRATION`

### Delegation boundary and process placement

Reference: [systemd/systemd](https://github.com/systemd/systemd)

- Audited commit: `06cb8fbe618604f43c9a9a638e6fc3df920daa0c`
- Files/tests studied:
  - `docs/CGROUP_DELEGATION.md`
  - `man/systemd.resource-control.xml`
  - `src/shared/cgroup-setup.c`
  - `src/core/execute.c`
  - `src/core/exec-invoke.c`
  - `test/units/TEST-19-CGROUP.delegate.sh`
  - `test/units/TEST-07-PID1.protect-control-groups.sh`
- History/issues studied: namespace/subgroup-ordering fix
  `f8f67eab70737549325a718d66c589847043516a`; restart `EBUSY` fix
  `056bc106e1e344f98cdfa86fdf62e6fed72958c9` / issue #41278
- Evidence used: single-writer root/descendant ownership, `Delegate=`,
  `DelegateSubgroup=`, kernel allowlist tests, and namespace ordering
- License: LGPL-2.1-or-later; `LICENSE.LGPL2.1` and cited-file SPDX headers
- Reuse: `ARCHITECTURAL_INSPIRATION`

No systemd source or tests were copied.

### Portable ownership contract

Reference: [opencontainers/runtime-spec](https://github.com/opencontainers/runtime-spec)

- Audited commit: `6999a89a76a0329f440d5740497bedb9dd431297`
- File studied: `config-linux.md`, control-groups ownership section
- History studied: ownership change
  `f4ef3914439ef595fd00c6d0b81753e3463626a3`; absent-delegation-file
  correction `600a8bd6d65d9f687310e6f3030c78b4fe946309`
- Evidence used: ownership is safe only with a private cgroup namespace plus a
  writable cgroup mount, and is limited to the directory/kernel allowlist
- License: Apache-2.0
- Reuse: `ARCHITECTURAL_INSPIRATION`

### Exact-subtree mount and delegation implementation

Reference: [opencontainers/runc](https://github.com/opencontainers/runc)

- Audited commit: `0c87c02ff02123f1bc2cd1b3f850f94e5b8de983`
- Files/tests studied:
  - `libcontainer/specconv/spec_linux.go`
  - `libcontainer/rootfs_linux.go`
  - `libcontainer/process_linux.go`
  - `libcontainer/init_linux.go`
  - vendored `github.com/opencontainers/cgroups/systemd/v2.go`
  - `tests/integration/cgroup_delegation.bats`
  - `tests/integration/cgroups.bats`
  - `tests/integration/exec.bats`
  - `tests/rootless.sh`
- Issues/history studied: issues #2356, #3387, #5003, and #5089; PR #3057
  merge `cdce2496358ca17ad82e165d20183c00ac68f7f4`; commits
  `94133fab970c2ff9011cc9531b7415934b9fcd61`,
  `1d030fab7dd856c0709e102b61bd1792e85d13d3`,
  `6c07a37a585db26a3117683456c9c06f97dc7485`, and
  `1fdbab8107c61876eb69f88730497d250d67e0e6`
- Evidence used: safe ownership matrix, exact-subtree mount fallback,
  no-internal-process behavior, and actual-init cgroup identity history
- License: Apache-2.0; root NOTICE credits Docker
- Reuse: `ARCHITECTURAL_INSPIRATION`; behavior will be independently tested

### Writable cgroup integration and mount-option regression

Reference: [containerd/containerd](https://github.com/containerd/containerd)

- Audited commit: `35f120ed0ae803d16bf92f76f7fe0a2654822e25`
- Files/tests studied:
  - `internal/cri/server/container_create.go`
  - `internal/cri/opts/spec_linux_opts.go`
  - `internal/cri/opts/spec_linux_test.go`
  - `internal/cri/config/config.go`
  - `integration/container_cgroup_writable_linux_test.go`
- History studied: PR #11131 / merge
  `7c380b9b5057ba869f884d1d979a2db45ffc8245`; non-parallel test fix
  `e6528332195d23bf98ba58124b4cd647223e6969`; PR #12952 / merge
  `248b1a665b548f32cede407e0fde464371ad4e58`, implementation
  `f84ddfa4fbb9741633bf722ceea943ded2205b15`, and test
  `0eef29a1a92474f9dfb9c21e70790b25221cabdc`
- Evidence used: real writable/private cgroup integration and the requirement
  that verifier launch never mutate shared host `nsdelegate` or
  `memory_recursiveprot` mount options
- License: Apache-2.0; containerd/Docker file headers and root NOTICE
- Reuse: `ARCHITECTURAL_INSPIRATION`

### Recursive cgroup removal

Reference: [opencontainers/cgroups](https://github.com/opencontainers/cgroups)

- Audited commit: `783139a1555b1fbe9941f1c478651cd7d8718519`
- Files/tests studied: `utils.go`, `utils_test.go`, and `fs2/create.go`
- Issue/history studied: read-only/non-existent removal behavior around issue
  #4518
- Evidence used: post-order removal and bounded `EBUSY` retry
- Gap: removal/retry is not settlement proof and lacks changing-tree coverage
- License: Apache-2.0
- Reuse: `ARCHITECTURAL_INSPIRATION`

### Structural exhaustion and capability publication

References:

- [kubernetes/enhancements](https://github.com/kubernetes/enhancements) at
  `51353583266ccece601bb590f9f7d2e5e335b39e`
- [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) at
  `94c136764292cc5fac976c0de6587daaea56410f`

- Files/tests/design studied:
  - `keps/sig-node/5474-enable-writable-cgroups/README.md` and `kep.yaml`
  - Kubernetes `pkg/kubelet/nodestatus/setters.go`
  - `pkg/kubelet/kuberuntime/helpers.go`
  - `pkg/kubelet/lifecycle/predicate.go` and corresponding tests
- Issues/history studied: KEP PR #5475 / commit
  `54fe87a97ad84eaf88a77481836c0dd33e8f96c3`; approved PR #6260; origin
  issue kubernetes/kubernetes#121190; containerd issues #10924 and #12252
- Evidence used: empirical cgroup-metadata exhaustion, mandatory
  `cgroup.max.descendants`/`cgroup.max.depth`, `nsdelegate`, explicit runtime
  capability, and pre-launch refusal/event patterns
- Status caveat: KEP 5474 was `implementable`, not a completed implementation,
  and no matching Kubernetes source/tests were found at the audited pin
- License: Apache-2.0
- Reuse: KEP `IDEA_ONLY`; Kubernetes capability/error pattern
  `ARCHITECTURAL_INSPIRATION`

### Bubblewrap namespace and FD-bind ABI

Reference: [containers/bubblewrap](https://github.com/containers/bubblewrap)

- Audited commit: `2f55bae38468d0c50cf5df87b1e481e882b63acb`
- Files/tests studied: `bubblewrap.c` and `tests/test-run.sh`
- History studied: FD-bind change
  `a253257cd298892da43e15201d83f9a02c9b58b5`; cgroup-try state fix
  `5a76f51dc683ec84215836bcb958f3884b3c528e`
- Evidence used: strict `CLONE_NEWCGROUP` request and late FD-bound exact source
  with device/inode revalidation
- Rejected behavior: `--unshare-cgroup-try` and
  `--not-a-security-boundary`
- License: LGPL-2.0-or-later; `bubblewrap.c` SPDX/header and `COPYING`,
  Copyright 2016 Alexander Larsson
- Reuse: `IDEA_ONLY` for the external CLI/ABI contract; Bubblewrap is invoked
  as a separate executable and no C source is copied

### Normative cgroup-v2 ABI

Reference: [Linux kernel](https://github.com/torvalds/linux)

- Audited commit: `06cf61899d6498b33e4b7c87d99d5bd471ccc375`
- Files/tests studied:
  - `Documentation/admin-guide/cgroup-v2.rst`
  - `kernel/cgroup/cgroup.c`
  - `tools/testing/selftests/cgroup/test_core.c`
  - `tools/testing/selftests/cgroup/cgroup_util.c`
- Evidence used: `nsdelegate`, namespace-root write restrictions,
  no-internal-process, structural-limit `EAGAIN`, recursive `cgroup.kill`, and
  kernel selftest expectations
- License: GPL-2.0-only for cited source/selftests
- Reuse: `IDEA_ONLY`; documented ABI semantics only

No kernel code or selftest text was copied.
