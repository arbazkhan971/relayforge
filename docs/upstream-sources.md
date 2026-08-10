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

Source-tree evidence packet: `.workflow/ultracode/relayforge-complete/results/audit-streaming-framer-performance.md`
(intentionally not included in the npm package).

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

## Phase 01 — durable control-plane facts and derived activity

Packaged phase decision: [Phase 01 control-plane audit](reference/phase-01-control-plane-audit.md).

### Transactional local coding-agent state

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited commit: `f65c48e296e20a816221a4003c75a5f0387967ec`
- Files studied: SQLite initialization/migrations, conversation and cleanup
  stores/tests, CDC poller/change-log/SSE tests, domain session facts, pure
  status derivation/tests, lifecycle integration tests, and architecture plans.
- Issues/PRs studied: #2928, #3472, #3475, #3491, #3710, #3711.
- License: Apache-2.0; no root NOTICE or incompatible sampled file header found.
- Reuse: `ARCHITECTURAL_INSPIRATION`. RelayForge independently implements a
  canonical event history plus transactional projections, generation fencing,
  and pure views; no Go/SQL/test/comment text is copied.

### Canonical history and rebuild

Reference: [temporalio/temporal](https://github.com/temporalio/temporal)

- Audited commit: `023cb7d861b6cc0e139564b2faaf10c106a7f37d`.
- Files studied: history architecture/lifecycle, event store/builder/factory,
  mutable-state rebuilder/tests, persistence history manager/tests, deletion,
  scavenging, and history cleanup integration tests; PRs #2532 and #11353.
- License: MIT with Temporal/Uber copyright notices; unrelated separately
  licensed subtrees are not used.
- Reuse: `ARCHITECTURAL_INSPIRATION` for history-as-authority and verified
  projection rebuild. Distributed sharding/branches/replication are `NOT_USED`.

### Generation, freshness, and cursor expiration

Reference: [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes)

- Audited commit: `94c136764292cc5fac976c0de6587daaea56410f`.
- Files studied: metadata identity/version/generation, condition helpers/tests,
  watch-cache history/storage, etcd watcher/tests, deployment sync/status
  tests, issue #138774, and PR #140860.
- License: Apache-2.0 with relevant Apache file headers.
- Reuse: `ARCHITECTURAL_INSPIRATION` for immutable identity, observed
  generation, sequence freshness, and typed expired-cursor/relist behavior.

### Retention and idempotency references with restricted current terms

- [restatedev/restate](https://github.com/restatedev/restate), commit
  `f26577320b8be42b7a754d20932e881f06988876`: journal lifecycle/purge,
  restart-as-new, deduplication, durability tracking, snapshots/tests, and PRs
  #5076/#5091/#5145 were studied. Current BSL-1.1 terms are not approved for
  reuse. Classification: `IDEA_ONLY`; no code, tests, comments, schema, or
  distinctive structure may be copied.
- [inngest/inngest](https://github.com/inngest/inngest), commit
  `ce19803e185b791121352a77601216abc25ee7be`: lifecycle history, state
  interfaces/tests, duplicate-finalization and pause-idempotency tests,
  retention guidance, and PRs #4668/#4672 were studied. Current SSPL/future
  Apache terms are not permissive for this implementation. Classification:
  `IDEA_ONLY` / history design `NOT_USED`.

### Node SQLite adapter

Reference: [WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

- Compatibility pin audited: published `v12.11.1` at
  `4cbc39ca582fecb6b51dd920dfdd338ba4b72230` (Node 20 supported); later
  `v12.12.0` tag `38f111acfacced350ac17e62944ba9a4dbd176e5`
  was inspected but is not published to npm; current v13 head
  `dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb` requires Node 22.
- Transaction/savepoint, WAL checkpoint, integrity tests, package metadata,
  and license were inspected.
- License: MIT; no NOTICE found.
- Reuse decision: exact published `better-sqlite3@12.11.1` and
  `@types/better-sqlite3@9.6.0` are approved as `DIRECT_DEPENDENCY` entries when
  the SQLite store lands. No library source is copied; RelayForge owns schema,
  durability pragmas, reducer, recovery, and migration behavior.

### Loopback daemon, REST, and durable SSE

Research artifacts:

- source-tree detail packet
  `.workflow/ultracode/relayforge-complete/results/audit-p1-loopback-transport.md`
  (not packaged)
- [combined P1 phase decision](reference/phase-01-control-plane-audit.md)

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited commit: `f65c48e296e20a816221a4003c75a5f0387967ec`.
- Files/tests studied: daemon configuration/server/run-file/stale handling,
  frontend attach logic, CDC event/poller/broadcaster, SSE controller/tests,
  renderer event transport/tests, CLI docs and daemon architecture.
- History/issues/PRs studied: daemon skeleton `59a654a`, durable SSE
  `a9b08cd`, attach behavior `cbd2a1b`, PRs #2185 and #2847.
- Evidence used: literal loopback bind, bind-before-run-file, run-file/health
  agreement, thin CLI, subscribe-before-replay, durable sequence, overlap
  deduplication, slow-stream close and browser reconnect/refetch.
- RelayForge changes: crash-released lifetime lease; PID start-token check;
  durably published private run-file; GET/HEAD-only DTOs; floor/expiry and
  replay-byte contract; shared bounded redaction; typed recovery failures.
- License: Apache-2.0; root license, copyright 2026 Untrivial; no root NOTICE at
  the audited pin.
- Reuse: `ARCHITECTURAL_INSPIRATION`; no Go/TypeScript source, tests, comments,
  schema or distinctive layout copied.

Reference: [kurrent-io/kcap-cli](https://github.com/kurrent-io/kcap-cli)

- Audited commit: `b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7`.
- Files/tests studied: daemon lifetime/start locks, lock paths, process-start
  token, commands and lock contention/reacquire/stale/incarnation/wait tests.
- History/issues/PRs studied: issue #457; PRs #147, #243 and #347.
- Evidence used: stable lock inode, kernel crash release, fresh instance,
  PID-plus-start identity, serialized starts and read-only doctor semantics.
- License: Kurrent License v1, not approved as a copying basis.
- Reuse: `IDEA_ONLY`; zero source, test, comment, naming or layout copying.

Reference: [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes)

- Audited commit: `94c136764292cc5fac976c0de6587daaea56410f`.
- Files/tests studied: retry watcher, watch-cache history, cache watcher and
  their focused retry/expiry/slow-consumer tests.
- Issues/PRs studied: issues #90058 and #102718; PR #91822.
- Evidence used: monotonically advancing cursor, explicit history expiry and
  relist, bounded history/channels, and closing unresponsive watchers.
- License: Apache-2.0.
- Reuse: `ARCHITECTURAL_INSPIRATION`; no Kubernetes types, status text, cache
  implementation or test text copied.

Reference: [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)

- Audited commit: `3e731cda8b073d058d8970ae8ffbfdc58021faba`.
- Files/tests studied: ACP event bus/tests, serve SSE route/cursor parser/tests,
  daemon TypeScript SDK parser/transport/tests and serve command.
- Issues/PRs studied: issues #3803 and #4175; PR #4236.
- Evidence used: strict cursor and epoch, synchronous subscription, replay
  event/byte/frame/subscriber bounds, explicit resync and slow-client eviction.
- RelayForge change: use durable run epoch/sequence rather than an in-memory
  ring as authority.
- License: Apache-2.0 with sampled SPDX/Qwen copyright headers.
- Reuse: `ARCHITECTURAL_INSPIRATION`; no event-bus/parser code or constants
  copied.

Supporting reference: [daintreehq/daintree](https://github.com/daintreehq/daintree)

- Audited commit: `a5c2dae192f18378e80b97d378f6015f8eda45d7`.
- Files/tests studied: MCP HTTP lifecycle, readiness probe, bounded tool-call
  result and focused tests.
- Evidence used: exact loopback Host/Origin admission, bounded readiness and
  UTF-8 output ceilings.
- Gap: Electron-owned lifecycle and protocol SSE are not durable run replay.
- License: Apache-2.0.
- Reuse: `SUPPORTING_REFERENCE`; no code copied.

## Phase 02 — parent-owned durable session steering

Research artifacts:

- source-tree detail packet
  `.workflow/ultracode/relayforge-complete/results/audit-p2-session-steering.md`
  (not packaged)
- [combined P2 decision](reference/phase-02-session-steering-audit.md)

### Durable prompt admission and boundary inclusion

Reference: [anomalyco/opencode](https://github.com/anomalyco/opencode)

- Audited commit: `38e10eb1408feb700021b8e8766fb0ab41bf84e2`.
- Files/tests studied: session input/schema/projector, runner boundary, three
  inbox/event migrations, context design, prompt/runner/server API tests.
- History/issues/PRs studied: PR #33443 / commit `f48f24e`; discussion #32157.
- Evidence used: stable ID exact-retry conflict, durable admitted inbox,
  sequence cutoff, atomic prompt projection, later-arrival exclusion,
  concurrency, replay and failure-preservation tests.
- RelayForge changes: parent-only authority; run/session/task/attempt generation;
  blocked/exited refusal; immutable attempt prompt bytes/hash; no live turn;
  truthful `included` rather than provider cognition.
- License: MIT; no root NOTICE or incompatible relevant header found.
- Reuse: `ARCHITECTURAL_INSPIRATION`; no source, schema, tests or comments copied.

### Coding-agent activity and refusal

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited commit: `f65c48e296e20a816221a4003c75a5f0387967ec`.
- Files/tests studied: activity/status domain, session guard, lifecycle/session
  manager, tmux adapter, architecture and focused state/race tests.
- History/issues/PRs studied: issue #2342; PR #2357 / commit `e867496`.
- Evidence used: distinct waiting/blocked/exited states, final fail-closed
  recheck, and characterization of terminal submission/dialog races.
- Rejected implementation: chunked tmux input, sleep/Enter retries, or any
  active-turn mutation.
- License: Apache-2.0.
- Reuse: `ARCHITECTURAL_INSPIRATION`; terminal delivery code `NOT_USED`.

### Workflow command lifecycle

Reference: [temporalio/temporal](https://github.com/temporalio/temporal)

- Audited commit: `023cb7d861b6cc0e139564b2faaf10c106a7f37d`.
- Files/tests studied: Signal/Update API and state machine, workflow-update
  design, history and end-to-end update/signal tests.
- History/issues/PRs studied: PRs #4313, #6513, #6485 and #9614; issue #5833.
- Evidence used: request-ID deduplication, boundary scheduling, staged durable
  terminology, completed-target refusal and explicit admission-not-processing.
- RelayForge improvement: persist admission, refusal, withdrawal and inclusion
  rather than relying on a process-local pre-acceptance registry.
- License: MIT.
- Reuse: `ARCHITECTURAL_INSPIRATION`; distributed/speculative machinery not used.

### Bounded coding-agent envelope and CAS

Reference: [google/scion](https://github.com/google/scion)

- Audited commit: `91c26b343a26b7697f9432de5792cd7372b391a6`.
- Files/tests studied: message types/format, prompt buffer, store models,
  broker-dispatch CAS/store/tests, broker/handlers/reconcile and message designs.
- History/issues studied: commits `559df61`, `43aaabb`, `5851bf9`, `06f4fec`,
  `eeee331`; issue #370 and PR #305.
- Evidence used: complete scoped identity, character/encoded-byte bounds,
  compare-and-swap, stuck-queue detection/expiry and cross-project regression.
- Rejected implementation: marking dispatched before external effect,
  in-memory debounce, agent authors/broadcasts and tmux delivery.
- License: Apache-2.0 with Google file headers; no root NOTICE found.
- Reuse: `ARCHITECTURAL_INSPIRATION` for envelope/bounds/tests only.

### Pending/progress/cancel operator UX

Reference: [daintreehq/daintree](https://github.com/daintreehq/daintree)

- Audited commit: `eb989c7613db8ff9dc948775291f56e42c5ada3a`.
- Files/tests studied: context-injection hook, terminal-input action/targeting,
  activity controller/display mapping and architecture/recovery notes.
- History/issues studied: commits `02d91bd`, `51070e6`, `723716b`, `b1dd773`;
  issues #11346 and #10034.
- Evidence used: explicit target, visible pending/progress/cancel state and
  subscribe-then-immediate-recheck race handling.
- RelayForge changes: durable P1 queue, exact generation target, pure activity,
  future prompt inclusion and read-only dashboard.
- License: Apache-2.0 plus root NOTICE/trademark restrictions.
- Reuse: `ARCHITECTURAL_INSPIRATION` for UX only; no code or assets copied.

### Staged role/context references

- [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude), commit
  `f2e75c1263a2d5f09cdc4bb3dfe3635c635ff296`: workflow skill, topology,
  prompt/resume/tests/design inspected. AGPL-3.0. `IDEA_ONLY` for staged
  workflow language; code/tests `NOT_USED`.
- [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev), commit
  `4fb2db0ea90375ce1059f44fe03ffbd191a7a169`: structured role messages,
  graph edges, WebSocket handler/tests and execution docs inspected.
  Apache-2.0. `IDEA_ONLY`; transient agent-authored messaging is not used.

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

### RelayForge implementation record

- Reuse classification for all entries below:
  `ARCHITECTURAL_INSPIRATION` or `IDEA_ONLY`; no `DIRECT_COPY`,
  `MODIFIED_COPY`, or `PORTED_IMPLEMENTATION`.
- Independently implemented files:
  - `src/cgroup-delegation.ts`
  - `src/cgroup-delegation-linux.ts`
  - integration hooks in `src/scope.ts`, `src/orchestrator.ts`,
    `src/sandbox.ts`, and `src/doctor.ts`
  - focused core, Linux, transport, recovery, and sandbox tests
- RelayForge improvements over the strongest adjacent implementations:
  parent-owned structural limits with exact readback and exhaustion tests;
  runtime-identity-keyed behavioral capability; canonical shell/stat/bwrap/Node
  identity revalidation; nonce-authenticated FD3/4/5 launch; versioned
  device/inode/PID/startticks recovery evidence; deduplicated settlement; and
  real nested provider/settlement suite execution through the shared bounded
  verifier transport.
- Required-host evidence (2026-08-09): exact behavior and limit suite 21/21;
  nested transport/launch/settlement 46/46; nested
  streaming/fallback/receipt/resume/cost/ledger/containment 193/193; zero
  capability skips.

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

## Phase 03 — trusted SCM publication and feedback

The full comparison and source/test/history evidence is recorded in
[the Phase 03 audit](reference/phase-03-scm-feedback-audit.md). P3 approves no
direct, modified or ported upstream source.

### Continuous SCM observation and feedback deduplication

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited commit: `f65c48e296e20a816221a4003c75a5f0387967ec`
- Files studied:
  - `backend/internal/ports/scm_observations.go`
  - `backend/internal/ports/scm_actions.go`
  - `backend/internal/domain/pr.go`
  - `backend/internal/observe/scm/observer.go`
  - `backend/internal/adapters/scm/github/provider.go`
  - `backend/internal/adapters/scm/github/observer_provider.go`
  - `backend/internal/adapters/scm/github/merge_action.go`
  - `backend/internal/lifecycle/reactions.go`
  - `backend/internal/lifecycle/manager.go`
  - `backend/internal/storage/sqlite/store/pr_facts.go`
  - `backend/internal/storage/sqlite/store/pr_store.go`
  - PR/check/review SQLite queries and migrations
- Tests studied:
  - `backend/internal/observe/scm/observer_test.go`
  - `backend/internal/integration/scm_observer_test.go`
  - `backend/internal/adapters/scm/github/provider_test.go`
  - `backend/internal/adapters/scm/github/merge_action_test.go`
  - SCM sections of `backend/internal/lifecycle/manager_test.go`
  - `backend/internal/storage/sqlite/store/pr_facts_test.go`
- Issues/history studied: PR/commit `#3619` / `3f7b528` (complete check
  fingerprint/pagination); issue/PR `#2656` / `#2678` (forced max-age refresh);
  PR `#2799` (retain independent feedback on conflict-read error); foreign-PR
  attribution around `#3262`; review-injection policy PR `#3709`
- Evidence used: explicit fetch authority, independent semantic fact buckets,
  guards plus forced freshness, failed-check fingerprints/log tails, partial
  review merging, persisted reaction signatures, fork/stack identity, expected-
  head mutation and fail-closed readiness
- License: Apache-2.0; root license inspected, no separate root NOTICE observed
- Reuse: `ARCHITECTURAL_INSPIRATION`

No Go, SQL, migration, test, message or UI source was copied.

`AgentWrapper/agent-orchestrator` redirected to the same repository, commit and
tree. It is `NOT_USED` as a distinct reference and does not count as another
implementation.

### Idempotent PR publication and explicit review-feedback work

Reference: [doordash-oss/agentic-orchestrator](https://github.com/doordash-oss/agentic-orchestrator)

- Audited commit: `101ca9a416371c4d9db0935cf4aef73f77551366`
- Files studied:
  - `internal/github/client.go`, `rest.go`, and `graphql.go`
  - `internal/git/publish.go` and `review.go`
  - `internal/orchestrator/publish.go`
  - `internal/server/review_feedback_fetch.go`
  - `internal/feature/review_feedback_store.go`
  - `internal/feature/review_feedback_outcomes.go`
  - review-feedback child workflow and desktop integration
- Tests studied: corresponding GitHub/Git publish/review tests, feature child/
  store/outcome tests, server fetch tests, E2E review-feedback journey and desktop
  publish/review recovery journeys
- History studied: initial public import `b5082af`, draft publication `947c241`,
  pipelined child workflows `4dbd261`, current desktop commit `101ca9a`
- Evidence used: credentials per host, typed API, Link pagination, 422 existing-PR
  recovery, default base branch, every review surface, durable addressed IDs,
  deterministic recoverable review child and publication UX
- Rejected behavior: unbounded pagination, ordinary unleased push, substring-
  based existing-PR recovery without RelayForge's durable exact intent
- License: Apache-2.0; root `NOTICE.txt` and DoorDash file headers inspected
- Reuse: `ARCHITECTURAL_INSPIRATION`

No Go, test, prompt, UI or workflow source was copied.

### GitHub check aggregation and client semantics

Reference: [cli/cli](https://github.com/cli/cli)

- Audited commit: `9fc0f70e0ef97446de9166febce546e955675bc3`
- Files/tests studied:
  - `pkg/cmd/pr/checks/checks.go`, `aggregate.go`, `output.go`
  - `pkg/cmd/pr/checks/checks_test.go`, `output_test.go`
  - `pkg/cmd/pr/create/create.go`, `create_test.go`
  - `pkg/cmd/pr/review/review.go`, `review_test.go`
- History studied: watch/exit behavior `8253280`; workflow/event dedup fixes
  `dea1af1` and `d46f47e`; cancellation bucket `decbbd2`; all-cancelled summary
  `cce391b`; identical head/base refusal `9daa22e`; fork-base behavior `2b5c3b5`
- Evidence used: complete check-rollup pagination, newest-run dedup keys,
  pass/fail/pending/skipping/cancel semantics, required-only behavior and PR
  head/base/fork characterization
- Gap: an ephemeral presentation client, not a durable observer or controller
- License: MIT, Copyright GitHub, Inc. 2019
- Reuse: `ARCHITECTURAL_INSPIRATION`

No Go source, GraphQL text, tests, fixtures or output text was copied.

## Phase 04 — capability adapter registry and structured transports

The source/test/history comparison and subsystem decisions are recorded in the
[Phase 04 adapter-registry audit](reference/phase-04-adapter-registry-audit.md).
P4 approves no direct or modified source copy. Descriptors remain unable to
spawn or mint authority; the existing contained transport and settlement replay
remain the sole execution/evidence path.

### Registry and role decomposition

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited commit: `f65c48e296e20a816221a4003c75a5f0387967ec`
- Files/tests studied: root/agent/chatdriver registries, agent/reviewer ports,
  OpenCode and Pi reviewers, ACP/native-ACP/OpenCode-ACP/Codex-app-server
  drivers, backend architecture documentation, registry/driver/live tests.
- History/issues/PRs studied: #3484, #3386, #3358 and #3709.
- Evidence used: separate worker/reviewer contracts, optional capabilities,
  exact installed-binary reuse, stable constructors, and cross-registry tests.
- License: Apache-2.0; no root NOTICE found at the pin.
- Reuse: `ARCHITECTURAL_INSPIRATION`; no Go/TypeScript source, test text,
  prompts, configuration, or comments copied.

`AgentWrapper/agent-orchestrator` resolved to this exact commit and tree. It is
`NOT_USED` as a distinct reference and does not count as another implementation.

### OpenCode native ACP

Reference: [anomalyco/opencode](https://github.com/anomalyco/opencode)

- Audited commit: `38e10eb1408feb700021b8e8766fb0ab41bf84e2`;
  package `opencode` 1.18.15.
- Files/tests studied: ACP CLI/service/event/session/permission/usage source and
  the relevant `packages/opencode/test/acp/*.test.ts` suites.
- History/issues/PRs studied: issue #22795; PRs #40422, #40450 and #41312.
- Evidence used: provider-owned ACP v1 stdio, session/cancel/permission
  semantics, update draining, detailed usage/context/cost with omission, and
  the need to prove its internal loopback in the real network jail.
- License: MIT, Copyright 2025 opencode; no NOTICE found.
- Reuse: `ARCHITECTURAL_INSPIRATION`. RelayForge will independently implement
  the descriptor and keep absent accounting unknown.

### ACP compatibility contract

Reference: [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)

- Audited commit: `1fc9d6ce50263b08e8d52847138ec249209b06f2`;
  stable wire v1, schema artifact 1.20.0.
- Files/tests/design studied: v1 schema/meta/changelog and initialization,
  prompt, cancellation, usage, permission and transport documents; v2
  migration/lifecycle RFDs; schema generation/tests.
- Evidence used: negotiated wire version distinct from artifact version,
  capability absence semantics, cancellation draining/races, optional usage,
  and the explicit statement that protocol roots/permissions are not a sandbox.
- License: Apache-2.0; no root NOTICE found.
- Reuse: `ARCHITECTURAL_INSPIRATION`. Any SDK use is a future dependency
  decision, not approved source copying. ACP is a transport kind, not a
  provider adapter.

### Codex app-server mapping and cancellation

Reference: [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)

- Audited commit: `145ebba5d2030b4aa6d19cbb89d190b7b498d454`;
  package `@agentclientprotocol/codex-acp` 1.1.14.
- Files/tests studied: JSON-RPC connection/app-server client, ACP client/server,
  event/approval/mode/token/rate/quota mappers, generated types, and the broad
  `src/__tests__/CodexACPAgent` fixture/E2E suite.
- History studied: PR #377 and its canonical-workspace regression tests.
- Evidence used: provider event mapping, accounting provenance, typed read-only
  policy, and pre-start/permission/active/late-start cancellation races.
- Rejected behavior: bundled/download fallback and shell-based explicit-path
  spawn; the trusted RelayForge launcher retains executable authority.
- License: Apache-2.0, Copyright 2025 JetBrains; no NOTICE found.
- Reuse: `ARCHITECTURAL_INSPIRATION`; no TypeScript, generated type, test, or
  fixture content copied.

### Pi native RPC

Reference: [badlogic/pi-mono](https://github.com/badlogic/pi-mono)

- Audited commit: `936aff00918de1187f085f123c2812d8f2d67745`;
  package `@earendil-works/pi-coding-agent` 0.84.1.
- Files/tests studied: RPC types/mode/client/JSONL source, session statistics,
  CLI isolation flags, and JSONL/prompt-response/process-exit/regression tests.
- History studied: PR #7394 and commits `8eda4f5` and `0524d68`.
- Evidence used: strict LF framing, request IDs, prompt/steer/follow-up/abort,
  cumulative statistics, child-failure rejection, and ambient-feature disable
  controls.
- Rejected behavior: the reference client's fixed startup delay. RelayForge
  requires exact semver plus live `get_state` and `get_session_stats` behavior.
- License: MIT, Copyright 2025 Mario Zechner; no NOTICE found.
- Reuse: `PORTED_IMPLEMENTATION` only for an independently written public
  wire-compatible dialect. No upstream code, test, fixture, or comments copied.

### Public lifecycle and conformance corpus

Reference: [openclaw/acpx](https://github.com/openclaw/acpx)

- Audited commit: `5ef9b5849e137310a1c6f6e06d82ca606c2d8fb3`;
  package `acpx` 0.13.0.
- Files/tests studied: registry, ACP process/client, public runtime contract,
  events/probe, lifecycle/turn manager, conformance profile, 21 JSON cases,
  runner, and registry/runtime/permission/cancel/process tests.
- History/issues/PRs studied: commits `5ef9b58` and `77715c8`, PR #407, and
  OpenClaw issues #28708, #51345 and #48136.
- Evidence used: bounded live events separated from a post-cleanup terminal
  Promise, real behavioral probing, accounting omission, data-driven cases,
  and bridge/identity failure taxonomy.
- Rejected behavior: alpha/draft cancellation divergence, optional real tests,
  network package fallback, and command overrides.
- License: MIT, Copyright 2025 OpenClaw Team; no NOTICE found.
- Reuse: `ARCHITECTURAL_INSPIRATION`; conformance cases will be independently
  authored rather than copied.

### Deferred ACP candidate

Reference: [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)

- Audited commit: `f3ba99f545e97cff48ecb6af7ea1ea7971d8a6e4`;
  package `@qwen-code/qwen-code` 0.21.8.
- Files/tests studied: native ACP agent/session/events/permissions/history/
  worktree source and tests, ACP bridge/process registry/NDJSON/transcript
  replay, stream-JSON adapters, and CLI/sandbox integrations.
- History studied: PRs #8790 and #8762 plus environment/trust fixes.
- Evidence used: a strong future ACP target and usage as a typed side channel,
  not model-visible transcript material.
- License: Apache-2.0 with sampled file SPDX headers; no root NOTICE found.
- Reuse: `IDEA_ONLY` for P4. Qwen is deferred until OpenCode native ACP and Pi
  native RPC prove the registry is transport-neutral.

### Grok Build native ACP addendum

Reference: [xai-org/grok-build](https://github.com/xai-org/grok-build)

- Audited public source commit:
  `8a14c91d88875a831a38b3a066b1683116bcb31c`, 2026-08-09; canonical
  Apache-2.0 repository with `third_party/NOTICE`.
- Separately characterized installed runtime: stable `1.0.0`, build
  `3cd0d0cbce`. The installed build identity is not represented as the public
  mirror HEAD and is content-revalidated before launch.
- Files/tests studied: CLI/agent parser, ACP server/session implementation,
  config precedence, telemetry/trace/feedback/update paths, hermetic ACP test
  support, built-binary/EOF/permission/session/auth tests and changelogs.
- Evidence used: canonical persistent `grok agent --no-leader stdio`, ACP v1,
  bounded session `systemPromptOverride`, native cancellation, private state
  roots and first-party privacy-disable profile.
- Required hardening: API-key-only auth; private empty HOME/GROK_HOME; fixed
  updater/web-tool/subagent/memory/telemetry/trace/feedback disables; no
  leader/serve/headless/plugin/trust/yolo/endpoint/raw controls; and explicit
  behavioral configuration/network-tool/no-upload evidence.
- Adjacent references inspected: current Grok plugin stdio/permission/readonly/
  cancellation issues, an independent privacy-hard-off fork, Hermes Agent and
  Agent Shell ACP integrations, the existing AO/OpenCode/ACP/acpx P4 corpus,
  and both user-requested RelayForge branches.
- Reuse: `ARCHITECTURAL_INSPIRATION`; RelayForge's descriptor, evidence
  evaluator, invocation mapping and ACP fixtures are independently authored.
  No Rust, tests, comments, prompts or third-party vendored source was copied.

Full findings: [Grok Build P4 addendum](reference/phase-04-grok-build-addendum.md).

The implemented P4 registry retained these reuse classifications; the later
Grok egress research is recorded in its append-only section below. No
descriptor loads executable third-party code, spawns a provider, or bypasses
the single contained transport/settlement authority.

## Phase 05 live observability and control room — 2026-08-09

The complete source/test comparison and scoring are in the [Phase 05
audit](reference/phase-05-live-observability-audit.md), with the decision in
[ADR 006](adr/006-live-observability-control-room.md). No implementation was
copied during this research packet. The classes below constrain later work.

### AO transcript source integrity

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited commit: `f65c48e296e20a816221a4003c75a5f0387967ec`,
  2026-08-09.
- Files/tests studied: `backend/internal/observe/usage/ingestor.go`, coordinator,
  watcher and parser sources; integration/unit tests for replacement,
  same-inode rewrite, mutation during read, restart, quiescent tail, conflict,
  watcher rebuild and parser-state persistence.
- History/issues/PRs studied: PR #3709, issue #3309 and current issue/PR surface.
- Evidence used: pinned descriptor identity, source generation, byte cursor and
  checkpoint digest, post-read verification, bounded reads/discard, incomplete
  tail preservation and atomic cursor/event apply.
- License: Apache-2.0; no NOTICE observed.
- Reuse: `ARCHITECTURAL_INSPIRATION`. Independently implement
  the state machine around RelayForge types and P1 storage; never expose the raw
  source or its path.

### Typed indexed observation projection

Reference: [doordash-oss/agentic-orchestrator](https://github.com/doordash-oss/agentic-orchestrator)

- Audited commit: `101ca9a416371c4d9db0935cf4aef73f77551366`,
  2026-08-09.
- Files/tests studied: `internal/server/sse.go`, `session_model.go`, SSE,
  session-output, output-client and read-API contract tests.
- Evidence used: typed row-indexed output, re-emission of a mutable partial tail,
  metadata-only output activity, bounded/coalesced subscribers and
  snapshot/subscribe race tests.
- Rejected behavior: process-memory replay and unrestricted assistant display
  prose. RelayForge retains durable P1 SSE and a narrower parent-authored DTO.
- License: Apache-2.0 plus `NOTICE.txt`.
- Reuse: `ARCHITECTURAL_INSPIRATION`; any later copying requires explicit
  license and NOTICE handling.

### Activity UX and generation-fenced snapshots

Reference: [sstraus/tuicommander](https://github.com/sstraus/tuicommander)

- Audited commit: `ce097a40de6c3624b84b475b23be1bb95624bd7c`,
  2026-08-06, v1.7.2.
- Files/tests studied: `src/hooks/useAgentPolling.ts`, `src/stores/terminals.ts`,
  ActivityDashboard, Rust SSE route, polling/cap/last-activity tests.
- Evidence used: serialized/coalesced polling, captured session/revision fences,
  stable activity rows and bounded command blocks.
- Rejected behavior: live-only broadcast SSE and path/raw-terminal-rich fields.
- License: Apache-2.0; no NOTICE observed.
- Reuse: `ARCHITECTURAL_INSPIRATION`, limited to independently
  implemented UX and race concepts.

### Bounded lazy presentation ring

Reference: [coding-by-feng/ai-agent-session-center](https://github.com/coding-by-feng/ai-agent-session-center)

- Audited commit: `ff8e4b2122aff58db12b662060f2939d7fa2f8a3`,
  2026-08-03.
- Files/tests studied: both `server/ptyRing.ts` and `electron/ptyRing.ts`, their
  SSH/PTY consumers and `test/ptyRing.test.ts` parity suite.
- Evidence used: lazy geometric allocation to a hard cap, wrap, tail retention
  for a huge append, snapshot/reset and cross-copy parity.
- Rejected behavior: raw PTY storage or WebSocket delivery as public truth.
- License: MIT.
- Reuse: `ARCHITECTURAL_INSPIRATION`, adapted to sanitized typed
  records plus item/byte/sequence/loss accounting.

### Lifecycle fencing, coalescing and pressure visibility

Reference: [daintreehq/daintree](https://github.com/daintreehq/daintree)

- Audited commit: `a5c2dae192f18378e80b97d378f6015f8eda45d7`,
  2026-08-09.
- Files/tests studied: PTY lifecycle ledger, host backpressure, panel-status
  buffer, activity FSM/temperature, lifecycle-ledger and adversarial/property
  tests.
- Evidence used: launch generations, stale-exit rejection, bounded drop tallies,
  pause/suspend signals, frame coalescing and timestamp/exit guards.
- Rejected behavior: the large terminal-inference stack as lifecycle authority.
- License: Apache-2.0 plus NOTICE; Daintree name/logo terms also observed.
- Reuse: `ARCHITECTURAL_INSPIRATION`, and only for small,
  independently implemented lifecycle/pressure concepts.

### Event dedup supporting reference

Reference: [simple10/agents-observe](https://github.com/simple10/agents-observe)

- Audited commit: `bb2f6c382cafb4d8111fc3137bab376b3aee11ed`,
  2026-07-21.
- Files/tests studied: event signature/admission, SQLite uniqueness,
  WebSocket/CORS, transcript parsing and their unit/race tests.
- History studied: issue #22 and its loopback/origin fix history.
- Evidence used: canonical nested-key signature plus unique-index race handling
  for external observations without a stable upstream ID.
- Rejected behavior: live-only unbounded WebSocket and repeated full-file
  transcript parsing. RelayForge events are not time-bucket deduplicated.
- License: MIT.
- Reuse: `ARCHITECTURAL_INSPIRATION` for the narrow dedup concept.

### Headless terminal boundary reference

Reference: [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise)

- Audited commit: `104d1c27376bc37e6b93adfc3617254358346823`,
  2026-08-07.
- Files/tests studied: agent-shell session logger/service/manager/OSC parser and
  logger/manager/OSC tests.
- Evidence used: bounded headless rendering and the explicit recognition that
  terminal control sequences are forgeable.
- License: AGPL-3.0.
- Reuse: `IDEA_ONLY`. No code, tests, comments, generated structures or
  distinctive arrangement may be copied.

### Rejected transcript and terminal-authority candidates

References: [jayminwest/overstory](https://github.com/jayminwest/overstory) at
`ff38f3f76f084abcc34f519bcaa69580f6e53cf1` (MIT, archived) and
[nutthouse/tutti](https://github.com/nutthouse/tutti) at
`6b86cca7457364888032e6ff9c04f2a87fc14cb2` (MIT).

- Overstory files/tests studied: event tailer/store and tests. Its cursor moves
  to observed size before parsing, partial/malformed lines and errors are lost,
  and rotation/rewrite has no source generation. Primitive: `NOT_USED`.
- Tutti files studied: serve/dashboard/runtime/tmux sources. Timestamp-oriented
  streaming, raw terminal polling and output-pattern state are weaker than
  RelayForge's durable cursor and parent authority. Primitive: `NOT_USED`.

The eventual P5 implementation change must identify any actual copied portion
and satisfy its license/NOTICE obligations. Until then, all implementation is
expected to be independently written, and Stagewise remains strictly idea-only.

## Phase 06 multi-repository scheduling and integration — 2026-08-09

The complete source/test comparison, scoring, failure matrix, and selected
design are in the [Phase 06 audit](reference/phase-06-multi-repository-audit.md),
with the decision in [ADR 007](adr/007-multi-repository-execution.md). No
upstream source, test, fixture, comment, or generated structure was copied in
this research packet.

### Multi-repository worktree lifecycle

Reference: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)

- Audited commit: `f65c48e296e20a816221a4003c75a5f0387967ec`,
  2026-08-09.
- Files/tests/design studied: workspace and workspace-project ports, project and
  session-worktree domain, Git worktree adapter, session manager lifecycle,
  SQLite worktree store, architecture and lifecycle-persistence documents, and
  focused creation/rollback/preserve/restore/cleanup tests.
- Evidence used: root-plus-child worktree group, canonical source and safe
  relative paths, a branch name free across repositories, per-repo base SHA and
  durable inventory, reverse partial-creation cleanup, children-before-root
  teardown, and dirty/registry-drift preservation.
- Limit observed: the workspace layer does not implement a recoverable
  cross-repository target-ref transaction; the audited squash-root tree also
  supplies little explanatory blame history.
- License: Apache-2.0; no root NOTICE observed.
- Reuse: `ARCHITECTURAL_INSPIRATION`. RelayForge independently implements a
  group lifecycle with stronger repository identity, fencing, provisioning,
  and recovery.

`AgentWrapper/agent-orchestrator` resolved to the exact same commit and tree and
is `NOT_USED` as a second implementation.

### Recoverable local multi-repository integration

Reference: [doordash-oss/agentic-orchestrator](https://github.com/doordash-oss/agentic-orchestrator)

- Audited commit: `101ca9a416371c4d9db0935cf4aef73f77551366`,
  2026-08-09; 99 commits in the preceding 90 days.
- Files/tests studied: `internal/feature/transaction.go`,
  `internal/orchestrator/child_transaction.go`, `internal/git/ref_cas.go`,
  `internal/git/merge_candidate.go`, their focused tests, the three-repository
  integration test, and the transactional multi-repo E2E journey.
- History/PR studied: commit `4dbd261ad321852e330254922174f7c37f34e188`
  and PR #113. The current tests cover later-CAS compensation, crash after all
  ref changes but before journal completion, idempotent resume, conflicts,
  dirty parents, and external ref movement.
- Evidence used: durable ordered journal, detached candidate preparation with
  no target-ref movement, expected-old `git update-ref`, persist-after-each
  application, conditional reverse compensation, and attention rather than
  overwrite on external movement.
- License: Apache-2.0, DoorDash copyright headers, and `NOTICE.txt`.
- Reuse: `ARCHITECTURAL_INSPIRATION`; RelayForge independently ports the public
  behavior, not source expression. It adds P1 event history, sorted leases,
  generation fencing, full-vector verification, receipt digests, and typed
  recovery uncertainty.

### Per-repository identity, resume, and operator UX

Reference: [kdlbs/kandev](https://github.com/kdlbs/kandev)

- Audited commit: `bbdd4267768e3b683bb3799e900bc69e155d0659`,
  2026-08-09; 1,343 commits in the preceding 90 days.
- Files/tests studied: executor and multi-repo executor tests, worktree
  preparer and manager tests, GitHub multi-repo store/migrations, and per-repo
  environment/worktree/branch/PR persistence.
- History/PRs studied: #2138, #1905, #2007, #1568, and #1795 for deterministic
  parallel Git fan-out, resume losing secondary repos, junction-safe cleanup,
  stale repository identity, and review base mismatch.
- Evidence used: identity keyed by session/repository/branch, ordered task-repo
  rows, pre-launch repository-secret conflict, exact failing secondary repo,
  migration dedup, and partial-result operator ergonomics.
- License: AGPL-3.0; no root NOTICE found.
- Reuse: `IDEA_ONLY`. No Go/TypeScript source, schema, fixture, test, comment,
  or distinctive arrangement may be copied.

### Durable reconcile and fencing semantics

Reference: [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes)

- Audited commit: `94c136764292cc5fac976c0de6587daaea56410f`,
  2026-08-08.
- Files/tests studied: `client-go/util/workqueue/queue.go` and its tests;
  `client-go/tools/leaderelection/leaderelection.go` and its lease tests.
- Evidence used: dirty/processing sets guarantee one later reconcile for a key
  changed during processing. Leader-election source explicitly states that it
  does not provide fencing and warns about cancellation/release ordering.
- License: Apache-2.0 with project NOTICE.
- Reuse: `ARCHITECTURAL_INSPIRATION`. RelayForge persists the dirty/processing
  semantic and requires generation/token/version fences on every mutation; it
  does not copy the in-memory queue.

### Durable backlog, retry identity, and rebuild

Reference: [temporalio/temporal](https://github.com/temporalio/temporal)

- Audited commit: `023cb7d861b6cc0e139564b2faaf10c106a7f37d`,
  2026-08-07.
- Files/tests studied: matching task reader/writer, ack manager, backlog and
  physical task-queue tests, fairness tests, and history/rebuild contracts.
- History studied: fairness changes #7967/#8500, read-level race #5142,
  task-writer race #5892, and dropped-task observability #10759/#10642.
- Evidence used: durable backlog separated from dispatch/completion, ack level,
  stable retry identity, rebuild, fairness, and dropped-work observability.
- License: MIT; no root NOTICE found.
- Reuse: `ARCHITECTURAL_INSPIRATION`. RelayForge keeps its smaller local
  ControlStore and does not import Temporal matching machinery.

### Tokenized dequeue and plan validation

Reference: [hashicorp/nomad](https://github.com/hashicorp/nomad)

- Audited commit: `d78b9b59529a1503f013bb9f86f2e75c7cf889d4`,
  2026-08-07; 200 commits in the preceding 90 days.
- Files/tests studied: `nomad/eval_broker.go`, `eval_broker_test.go`,
  `plan_queue.go`, `plan_queue_test.go`, worker dequeue/ack/plan submission,
  file headers, and root license.
- Evidence used: random dequeue token, token-checked Ack/Nack, acknowledgement
  timeout, delivery limit, per-job serialization, priority, FIFO, optimistic
  plan then authoritative validation.
- Rejected behavior: leader-memory queue authority and worker Ack/Nack RPC
  errors that are logged and swallowed.
- License: BUSL-1.1, IBM copyright and SPDX headers.
- Reuse: `IDEA_ONLY`; no source/test copying. RelayForge persists admission,
  dispatch, completion, and retry as canonical events.

### Distributed attempt and watermark negative evidence

Reference: [dagucloud/dagu](https://github.com/dagucloud/dagu)

- Audited commit: `99863067370950e33a31969f77a07127ea09fe8f`,
  2026-08-09; 394 commits in the preceding 90 days.
- Files/tests studied: queue processor, distributed attempts, worker poller,
  zombie detector, watermark store, and their tests.
- Evidence used: reservations, attempt identity, claim acknowledgement,
  heartbeat, jitter, bounded concurrency, and repeated-stale observation.
- Rejected behavior: some lease read uncertainty is treated as inactive status,
  and corrupt/unknown watermark state can start fresh.
- License: GPL-3.0; sampled files state `GPL-3.0-or-later`.
- Reuse: `IDEA_ONLY` / negative evidence. Equivalent RelayForge uncertainty is
  fail-closed and recovery-required.

### Adjacent scheduler candidates

References: [AgentsMesh](https://github.com/AgentsMesh/AgentsMesh) at
`1f90b14194d03c353df4f281a05442afe93cae34` and
[GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion) at
`91c26b3`.

- AgentsMesh task scheduler, runner worktree and command-queue sources/tests
  were inspected. Its Business Source License 1.1 has no production grant and
  changes in 2030; reuse is `IDEA_ONLY` / `NOT_USED` for code.
- Scion scheduler source/tests were inspected for persistent one-shot timers,
  startup expiration, recurring jitter, and a global semaphore. Its
  missing-advisory-lock path can run unguarded; reuse is
  `ARCHITECTURAL_INSPIRATION` for bounded scheduling tests only under
  Apache-2.0.

The eventual P6 implementation must amend these entries if reuse differs. It
must not call a multi-ref or remote saga atomic, must never overwrite an
unproven external ref, and must rerun every real-Git/crash gate on committed
HEAD.

## Phase 02 implementation attribution addendum — 2026-08-09

This append-only addendum records the implemented operator/API packet. The
research classifications and audited pins in the earlier **Phase 02 —
parent-owned durable session steering** section remain authoritative.

- Implemented areas: strict steering domain and lifecycle reduction, derived
  seven-state activity, parent admission/withdrawal service, immutable prompt
  capture and recovery, read-only dashboard/monitor projections, and the
  private run-parent Unix command socket plus connect-only CLI.
- `anomalyco/opencode` at
  `38e10eb1408feb700021b8e8766fb0ab41bf84e2` remains
  `ARCHITECTURAL_INSPIRATION` under MIT for durable stable-ID admission and
  cutoff concepts. No source, schema, test, fixture, comment or expression was
  copied.
- `Untrivial-ai/agent-orchestrator` at
  `f65c48e296e20a816221a4003c75a5f0387967ec` remains
  `ARCHITECTURAL_INSPIRATION` under Apache-2.0 for activity/race evidence;
  terminal delivery remains `NOT_USED`.
- `temporalio/temporal` at
  `023cb7d861b6cc0e139564b2faaf10c106a7f37d` remains
  `ARCHITECTURAL_INSPIRATION` under MIT for stable request identity and staged
  terminology.
- `google/scion` at
  `91c26b343a26b7697f9432de5792cd7372b391a6` remains
  `ARCHITECTURAL_INSPIRATION` under Apache-2.0 for bounded-envelope/CAS test
  ideas.
- `daintreehq/daintree` at
  `eb989c7613db8ff9dc948775291f56e42c5ada3a` remains
  `ARCHITECTURAL_INSPIRATION` under Apache-2.0 plus its NOTICE/trademark terms
  for pending/progress/cancel UX only. Its terminal-input implementation and
  assets are `NOT_USED`.
- `stellarlinkco/myclaude` at
  `f2e75c1263a2d5f09cdc4bb3dfe3635c635ff296` remains `IDEA_ONLY` under
  AGPL-3.0; `OpenBMB/ChatDev` at
  `4fb2db0ea90375ce1059f44fe03ffbd191a7a169` remains `IDEA_ONLY` under
  Apache-2.0. Their code and tests are `NOT_USED`.

All Phase 02 implementation in RelayForge is independently written. Reuse
classifications for this packet are: `DIRECT_COPY`: none; `MODIFIED_COPY`:
none; `PORTED_IMPLEMENTATION`: none; `ARCHITECTURAL_INSPIRATION` and
`IDEA_ONLY`: exactly as itemized above.

## User-requested parallel branch review — 2026-08-09

References: local product base `agent/loop-engineering-hardening` at
`73051d510c6473fa763bc7cd81921f65bec00eea`, and fetched remote branch
`claude/agent-orchestrator-ref-i63kd1` at
`f0914c092157b7d63ba98481ce313b2d53abcfe2` (common ancestor
`9848c99d7c4829f1d2534639f9a9bbb45c38df80`).

- Commits studied: `09725ff7485147b536ee86d56d0e88f406446a4b`
  (mission-control plan), `f9f54e9256278bf8ed4ee77794e87d21a9d86813`
  (daemon/state/SSE), and
  `f0914c092157b7d63ba98481ce313b2d53abcfe2` (SCM feedback router).
- Source studied with `git show`: `src/daemon/{state,lifecycle,server,client,
  github,poller,router}.ts`, the daemon CLI/config diff, and
  `docs/mission-control-plan.md`.
- Tests studied: `tests/daemon-{state,server,router}.test.ts`. The useful
  characterizations are derived-status precedence, a failed liveness probe as
  unknown rather than immediate death, first creation winning, sticky
  termination, and no new feedback routing after a PR closes or merges.
- Rejected implementation: unbounded/raw JSONL reads, torn-line skipping with
  a line-count watermark, bearer tokens in query strings, mutation/kill HTTP
  routes, raw paths/tmux identifiers/log tails/review bodies, unbounded request
  bodies/SSE clients, PID-only lifecycle identity, direct `gh` polling, and
  separate routed-key plus board writes. Those boundaries are weaker than the
  landed run-scoped SQLite transactions, process-incarnation/lease/generation
  fences, GET/HEAD-only credential-rejecting API, durable cursor SSE metadata,
  bounded normalized SCM facts, and atomic P2 reaction identity.
- License: the branch carries this repository's MIT `LICENSE`; no additional
  NOTICE or file-level third-party header was found.
- Reuse: `NOT_USED` for code, tests, schemas, fixtures, comments and distinctive
  structure. The derived-status and unknown-on-probe behaviors were already
  independently implemented and remain retrospective
  `ARCHITECTURAL_INSPIRATION`/characterization checks only. No commit was
  cherry-picked or merged.

`agent/loop-engineering-hardening` is the active RelayForge implementation
base, not an external upstream. The reference audits use that exact commit as
their comparison baseline; completion remains contingent on the final
integrated working-tree and committed-HEAD gates.

## Phase 04 Grok egress containment addendum — 2026-08-09

The source, tests, recent history, open issues, license and NOTICE boundaries
below were inspected before RelayForge selected its parent-owned Grok egress
boundary. No upstream code, rule, fixture, test, configuration or comment was
copied. Full findings and rejected alternatives are in the
[Grok egress audit](reference/phase-04-grok-egress-addendum.md).

| Reference | Exact pin | Evidence inspected | License | Reuse |
|---|---|---|---|---|
| [evilsocket/opensnitch](https://github.com/evilsocket/opensnitch) | `a1353848ba1b660320e90cefea782c3fba272c00`, 2026-07-27 | `daemon/firewall/{iptables,nftables}`, `daemon/netfilter`, `daemon/main.go`, rule loader/operator tests, the root-only production NFQUEUE test, recent rule-race/network-rule history and issue #1644 | GPL-3.0 | `IDEA_ONLY`; only below-process/default-deny characterization is retained |
| [google/gvisor](https://github.com/google/gvisor) | `5ceb9a5fd5750d6c73dd166441f28306039300d0`, 2026-08-07 | `runsc/config/{flags,config}.go`, `runsc/boot/network.go`, loader/config/boot posture tests, recent network-namespace history and issue #13796 | Apache-2.0 with the per-file MIT/BSD notices recorded in `LICENSE` | `ARCHITECTURAL_INSPIRATION` for explicit none/sandbox/host boundaries; no runtime dependency |
| [cilium/cilium](https://github.com/cilium/cilium) | `8c0423e970e62706bcd5dd3a57e1ffaee697439c`, 2026-08-08 | `pkg/policy/api/egress.go`, `pkg/fqdn`, default-deny/deny-precedence tests, `test/k8s/fqdn.go`, policy docs, recent FQDN history and issues #47768/#47128 | Apache-2.0 root; marked BPF files retain their stated GPL/BSD terms | `ARCHITECTURAL_INSPIRATION` for default-deny plus active rule tests; no cluster/eBPF code used |
| [rootless-containers/rootlesskit](https://github.com/rootless-containers/rootlesskit) | `508b336380f2eb37d7d8dbc0a9b4f98bc4956151`, 2026-08-04 | `docs/network.md`, `cmd/rootlesskit/main.go`, `pkg/network/{slirp4netns,pasta}`, `hack/integration-net.sh`, helper feature detection, current network/port issues and host-loopback fix PR #612 | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` for exact helper probing and namespace bypass tests; slirp/pasta are not treated as endpoint policy |

The independently implemented RelayForge decision is an unshared network
namespace whose sole approved route is a bounded parent-owned CONNECT proxy.
Availability requires one successful exact `api.x.ai:443` path plus active
denial of canary, direct IPv4/IPv6, DNS, host-loopback and alternate Unix-socket
paths. Privacy flags, proxy environment variables, `--unshare-net` alone and a
runner-supplied boolean are explicitly insufficient.

## Phase 07 RelayForge identity and release provenance — 2026-08-09

The release/rebrand audit inspected the following canonical sources at exact
pins. RelayForge's TypeScript/npm scripts, workflow tests and compatibility
fixtures were independently authored; no upstream source, workflow, test,
fixture or generated asset was copied.

| Reference | Exact pin / activity | Files, tests and history inspected | License / notice | Reuse |
|---|---|---|---|---|
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | `f65c48e296e20a816221a4003c75a5f0387967ec`; 453 commits/30d | npm shim/platform manifests, `packages/build-binaries.sh`, testing/feature/latest-guard workflows, CLI and desktop E2Es, desktop release docs, and the ACP packaging repair `3c8e7ce3`/PR #3660 | repository Apache-2.0; npm shim metadata MIT, so file provenance is evaluated separately | `ARCHITECTURAL_INSPIRATION` for exact-SHA/credential isolation and packed runtime proof; native wrapper not used |
| [mco-org/mco](https://github.com/mco-org/mco) | `9eff964825e4da234d8c8079c61fb010854ae44e`; 5 commits/30d | package/releasing/changelog files, gate/preview/publish workflows, packaging smoke, release-ref/version scripts and tests, Node installer/launcher tests, PR #122 | MIT; no NOTICE found | `ARCHITECTURAL_INSPIRATION` for confirmed-absence publication, safe retry and clean install; Python wrapper code not used |
| [daintreehq/daintree](https://github.com/daintreehq/daintree) | `eb989c7613db8ff9dc948775291f56e42c5ada3a`; 1,623 commits/30d | release docs/workflows, packaged-smoke implementation/tests, release-E2E dependency tests and issue #11117 gate regression | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` for artifact-level smoke and no-bypass workflow topology; Electron/signing/updater code not used |
| [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise) | `104d1c27376bc37e6b93adfc3617254358346823`; 180 commits/30d | prepare/auto/nightly/component release workflows, package/version files, release-note/update/compatibility tests and `1.28.0` history | AGPL-3.0 with package-local licenses | `IDEA_ONLY`; no source or tests used |
| [GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion) | `91c26b343a26b7697f9432de5792cd7372b391a6`; 421 commits/30d | build-release workflow, `hack/smoke_test.sh`, root/start/server-migrate tests and provision/migration compatibility tests | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` for behavioral legacy compatibility; Go/container packaging not used |
| [johannesjo/parallel-code](https://github.com/johannesjo/parallel-code) | `d000fff65989f4c9fe48e5814a9d7c807ae83ba6`; 64 commits/30d | package and release workflow plus `52d1057` auto-update metadata and tag history | MIT | `IDEA_ONLY`; its pleasant tag ergonomics did not replace the stronger artifact/publication gates |

The selected design combines MCO's exact-version registry semantics,
Daintree's artifact/workflow proof, Scion's compatibility characterization and
Agent Orchestrator's exact-artifact credential boundary. Stagewise and Parallel
Code remain idea-only. RelayForge introduces no updater, telemetry,
auto-merge, postinstall downloader or unrequested external publication.
