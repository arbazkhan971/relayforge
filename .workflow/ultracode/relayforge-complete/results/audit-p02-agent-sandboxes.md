# P0.2 Reference Audit — safe nested cgroup-v2 delegation through a bwrap verifier jail

**Audit date:** 2026-08-09
**Decision status:** implementation may proceed only with the fail-closed design and test gate below
**Product code changed by this packet:** none

## Executive verdict

No coding-agent sandbox surveyed implements safe, verifier-owned, writable cgroup-v2 subtree delegation into a Bubblewrap jail end to end.

- **Best finished cgroup delegation implementation:** containerd plus runc. Containerd creates a private cgroup namespace for non-privileged cgroup-v2 containers, mounts cgroupfs read-write when explicitly configured, and has a real integration test that creates a child cgroup. Runc limits ownership changes to the safe conjunction “private cgroup namespace + writable cgroupfs,” chowns only the kernel-declared delegation files, mounts only the container subtree on fallback, and tests the ownership matrix.
- **Best safety design:** Kubernetes KEP-5474. It requires cgroup v2, `nsdelegate`, explicit opt-in, runtime capability advertisement, explicit failure, and parent-owned `cgroup.max.descendants`/`cgroup.max.depth`. Its exhaustion experiment proves that `memory.max` alone is insufficient. The KEP is implementable/alpha design, not a completed production implementation; containerd tracking issue #12252 is still open.
- **Best bwrap launch/test mechanics:** OpenSandbox’s authenticated, blocked native workload gate and bounded JSON-status parser; cplt’s production-parity capability probe and CI “required sandbox” mode. Neither exposes writable cgroups.
- **Primary baseline:** Untrivial Agent Orchestrator current `main` has no cgroup or bwrap implementation. Open PR #3550 improves process ownership with transient systemd scopes, but explicitly defers resource limits and durable recovery and does not request delegation.
- **Negative evidence:** cplt deliberately refuses to rebind `/sys/fs/cgroup`; tsk disables CPU/memory limits for nested containers; Scion applies outer Docker/Podman/Kubernetes limits only; SRT nests PID/user/mount namespaces but has no cgroup implementation. `bwrap --unshare-cgroup` creates only a cgroup namespace view—it does not allocate, own, bound, mount, or clean a delegated subtree.

RelayForge should therefore **synthesize**, not copy: runc/containerd delegation semantics + KEP-5474 exhaustion bounds + OpenSandbox’s fail-closed launch handshake + cplt’s non-skipping behavioral probes + RelayForge’s existing inode-pinned settlement/reconciliation model.

## Research method and pinned corpus

Actual source, tests, design material, Git history, relevant issues/PRs, repository license, file headers, and current activity were inspected. Exact-code searches were used to disprove cgroup support; README claims were not treated as implementation evidence.

| Repository | Pin inspected | Latest commit at audit | License / notices | Activity assessment |
|---|---|---|---|---|
| Untrivial-ai/agent-orchestrator | `f65c48e296e20a816221a4003c75a5f0387967ec` plus open PR #3550 head `bd7baa54e829c3426cdeefe345b8252d1c8ed746` | 2026-08-09 | Apache-2.0; `LICENSE`; no relevant file header/NOTICE found | Very active |
| GoogleCloudPlatform/scion | `91c26b343a26b7697f9432de5792cd7372b391a6` | 2026-08-08 | Apache-2.0; Google file headers; no NOTICE found | Very active |
| navikt/cplt | `4c056bcfbf43c9a1261f7bd823d0973efaefeeb8` | 2026-08-03 | MIT, Copyright 2025 Nav; no NOTICE found | Active |
| dtormoen/tsk | `bc0c0c6cb72920e69bcbc93b7ac08d9e20c3a55a` | 2026-07-28 | MIT, Copyright 2025 Danny Tormoen; no NOTICE found | Active |
| alibaba/OpenSandbox | `47d85df848f957f5e7b3231e435ef9333a57537c` | 2026-08-06 | Apache-2.0; relevant files Copyright 2026 Alibaba Group Holding Ltd.; no repository NOTICE found | Very active |
| anthropic-experimental/sandbox-runtime | `121c6ac86df7c958aaf953d27116e74848c31318` | 2026-08-07 | Apache-2.0; no NOTICE found | Very active |
| containerd/containerd | `35f120ed0ae803d16bf92f76f7fe0a2654822e25` | 2026-08-08 | Apache-2.0; containerd/Docker file headers; `NOTICE` | Very active |
| opencontainers/runc | `0c87c02ff02123f1bc2cd1b3f850f94e5b8de983` | 2026-07-29 | Apache-2.0; `NOTICE` credits Docker | Very active |
| kubernetes/enhancements | `51353583266ccece601bb590f9f7d2e5e335b39e` | 2026-08-08 | Apache-2.0 | Very active; KEP not implemented |
| containers/bubblewrap | `2f55bae38468d0c50cf5df87b1e481e882b63acb` | 2026-04-28 | LGPL-2.0-or-later (`bubblewrap.c` SPDX/header; `COPYING`), Copyright 2016 Alexander Larsson | Active |

The local research clones were under `/home/arbaz/.relayforge-references`. Open PR and current containerd files were also inspected at the exact GitHub object IDs listed above.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Untrivial Agent Orchestrator | PR #3550 transient systemd user scope, exact unit state and cgroup-wide kill policy | Deterministic OS-owned lifetime; rejects unsupported backend; `setsid` canary | Unmerged; no `Delegate=yes`, private cgroup namespace, writable mount, controller/exhaustion bounds, or restart reconciliation | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| Scion | Docker/Podman `--memory`, `--memory-reservation`, `--cpus`; K8s resource/security contexts | Strong outer-runtime abstraction; real outage-driven default and many tests | No child-subtree delegation; known rootless/cgroup-v1 probe gap; outer caps only | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| cplt | bwrap PID/IPC/UTS/cgroup/user namespaces plus Landlock/seccomp re-entry | Best production-parity bwrap probe and mandatory CI capability execution | Explicitly skips `/sys`; test asserts `/sys/fs/cgroup` is not rebound; namespace view only | MIT | `ARCHITECTURAL_INSPIRATION` |
| tsk | Nested Podman/Docker build path, controller probe | Practical nested build ergonomics and real DIND smoke | Nested mode disables memory/CPU limits; hard-coded systemd paths and permissive unknown fallback; no delegation | MIT | `IDEA_ONLY` (negative example) |
| OpenSandbox | bwrap cgroup namespace; blocked native gate; authenticated child identity; bounded status parsing | Best fail-closed bwrap launch/identity sequencing | `--unshare-cgroup` only; generic binds can expose paths; no delegated ownership/limits/cleanup tests | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| Anthropic SRT | Outer bwrap plus inner user/PID/mount namespace and cap-drop ordering | Strong nested-namespace and root-capability bug history | No cgroup namespace, resource controls, or writable subtree at all | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| containerd | Runtime `cgroup_writable`; private cgroupns; rw cgroup mount; real mkdir integration test | Strongest completed end-to-end container integration | Runtime-wide toggle; v2 check only; no explicit `nsdelegate` rejection, depth/descendant bound, or boundary/escape tests | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; bug/behavior characterization only, with no source or test port |
| runc | Safe ownership predicate, kernel delegation allowlist, private-subtree mount fallback, integration matrix | Strongest low-level, working ownership/mount primitive | Container-runtime assumptions; no exhaustion bounds; tests stop at ownership rather than nested resource enforcement | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; RelayForge independently implemented the behavior and copied no source or tests |
| Kubernetes KEP-5474 | `nsdelegate`, explicit capability/API, fail closed, parent depth/descendant limits | Best threat model and test plan; measured node-exhaustion evidence | Design only; alpha slipped; runtime work incomplete | Apache-2.0 | `IDEA_ONLY`; Kubernetes capability/error code is separately `ARCHITECTURAL_INSPIRATION` |
| Bubblewrap | `--unshare-cgroup` / `CLONE_NEWCGROUP` | Correct private cgroup namespace primitive | Does not perform delegation, ownership, resource bounding, or lifecycle reconciliation; no cgroup-focused test found | LGPL-2.0-or-later | `IDEA_ONLY` for the external CLI/ABI; no source copied |

## Source, tests, design, and history evidence

### 1. Untrivial Agent Orchestrator — primary baseline

Current-main exact search at `f65c48e…` found no `cgroup`, `bubblewrap`, or `bwrap` implementation in `backend` or first-party docs. The repository has 340 Go test files, but none characterizes writable nested cgroups.

The relevant work is still open:

- Issue [#2523](https://github.com/Untrivial-ai/agent-orchestrator/issues/2523) records a ~31 GB grep incident and 5–12 GB orphan dev servers. A 2026-07-31 reproduction shows that `pkill -s` misses a descendant after `setsid`.
- Open PR [#3550](https://github.com/Untrivial-ai/agent-orchestrator/pull/3550), head `bd7baa54…`, adds `backend/internal/adapters/runtime/tmux/systemd_containment.go`. Lines 61–76 validate Linux, `systemd-run`, `systemctl`, and the user manager before tmux creation. Lines 83–99 wrap the pane with `systemd-run --user --scope --collect`, `KillMode=control-group`, stop grace, and SIGKILL. Lines 101–168 wait for exact active and released states.
- `backend/internal/adapters/runtime/tmux/systemd_containment_test.go` and `tmux_integration_test.go` add hermetic state/order coverage and a Linux `setsid` canary; PR metadata shows 214 and 191 added lines respectively.
- Proposed ADR `docs/adr/0002-worker-process-containment.md:24-36` explicitly excludes resource limits, durable cleanup facts, failed-stop persistence, Docker cleanup, and restart reconciliation.
- The latest maintainer comment (2026-08-08) reports Ubuntu CI green but a macOS/Windows config-test blocker; it says the containment control flow traced clean. That is useful honesty about platform validation, not merged evidence.

**Assessment:** AO’s exact scope identity and lifecycle are useful, but it does not do nested writable delegation better. A RelayForge transient-systemd implementation would still need `Delegate=yes`, safe subgroup layout, private cgroup namespace/mount setup, limits, and durable reconciliation.

### 2. Google Scion — strong outer limits, no inner delegation

Source:

- `pkg/runtime/docker.go:77-116` and `pkg/runtime/podman.go:187-221` map a `ResourceSpec` to memory, reservation, and CPU flags.
- Both carry a detailed TODO: rootless Podman on cgroup v1 rejects limits; current behavior fails start, and the missing fix is a host capability probe (`docker.go:79-93`, `podman.go:189-198`).
- `pkg/config/resource_defaults.go:19-47` documents why the default is two CPUs: a 2026-07-28 incident reached ~550% CPU and 13.5-second hub request latency. Memory is intentionally not defaulted because OOM often kills the harness rather than the build.
- `pkg/runtime/k8s_runtime.go:1195,1268,1319,1559-1560` constructs hardened Pod security context, drops all capabilities, and supports a RuntimeClass such as gVisor. `pkg/runtime/k8s_hardening_test.go:137-204,272-293` verifies the restrictions and RuntimeClass.
- Repository-wide search found no `cgroup.subtree_control`, `cgroup.max.depth`, `cgroup.max.descendants`, `nsdelegate`, or cgroup namespace implementation. Scion has 615 Go test files, but no nested writable-cgroup test.

History:

- Merged PR [#894](https://github.com/GoogleCloudPlatform/scion/pull/894), merge `298ff87bea60756f8caab28367dab485f63423af`, introduced resource defaults with 199 lines of focused tests. Its body calls out a Kubernetes field-merge regression risk rather than hiding it.

**Assessment:** Scion does outer resource-cap configuration better than the coding-agent references, but cannot help nested provider/settlement tests create child scopes.

### 3. navikt/cplt — strongest bwrap characterization, deliberately read-only cgroups

Source and tests at `4c056bc…`:

- `src/sandbox_bubblewrap.rs:195-213` emits `--unshare-pid`, IPC, UTS, cgroup, and user namespaces, a read-only host root, private proc/dev/tmp, and die-with-parent.
- `src/sandbox_bubblewrap.rs:220-237` excludes every writable rule under `/sys`; therefore a requested writable `/sys/fs/cgroup` is intentionally ignored.
- Unit test `bwrap_managed_subtrees_are_not_rebound`, `src/sandbox_bubblewrap.rs:693-715`, passes `/sys/fs/cgroup` as writable and asserts no bind occurs.
- `tests/integration_linux.rs:1211-1222` states the actual guarantee: private namespace views with host filesystem still visible read-only and Landlock/seccomp reapplied by re-entry.
- `tests/integration_linux.rs:1234-1249` makes missing bwrap fail rather than skip when `CPLT_TEST_REQUIRE_SANDBOX=1`; `.github/workflows/ci.yaml:246-253` enables that mode in CI.

Bug history:

- Issue [#113](https://github.com/navikt/cplt/issues/113) found that every bwrap test silently skipped in CI while the shipped order caused Landlock/seccomp to block bwrap’s own mount/unshare. The closeout reports 56 tests, zero skipped, and four latent bugs found.
- Commit `66b033a0b999a5f5f45faa0763115a598b2ffc8e` (2026-07-05) added the in-namespace re-entry helper, production-derived probe, userns corrections, system-subtree exclusions, and regression tests.
- Open issue [#126](https://github.com/navikt/cplt/issues/126) inventories remaining vacuous, skip-prone, wrong-reason, and flaky tests.

**Assessment:** cplt’s tests and production-parity probe are stronger than AO for bwrap, but it intentionally does not delegate writable cgroups.

### 4. dtormoen/tsk — nested operation by dropping resource controls

Source and tests at `bc0c0c6…`:

- `src/docker/mod.rs:82-100` probes controller names at two hard-coded user-systemd paths. If neither path is readable it assumes availability, so it is not a fail-closed general delegation probe.
- `src/docker/mod.rs:538-569` sets both memory and CPU quota to `None` whenever `is_nested()` is true, or when Podman’s controller probe fails.
- `src/docker/mod.rs:422-428` selects `BUILDAH_ISOLATION=chroot` because nested user namespaces/devpts fail.
- `tests/integration/projects/dind-build/tsk-integ-test.sh:1-25` genuinely builds and runs a nested image, but asserts no cgroup isolation or resource limit.

History:

- Commit `4f5c66c9fe6186b78bb1646ddbd56141993ae86b` (2026-03-21) explicitly “skip[s] Podman resource limits when cgroup controllers [are] unavailable” because crun rejects missing delegation.
- DIND fixes include `5c88a1f…` (nested chroot), `63f54e4…` (SELinux/resource increase), and `ee88f76…` (DIND integration test).
- GitHub issue search surfaced no cgroup/nested issue explaining a stronger design.

**Assessment:** tsk makes nested builds pleasant, but its solution is the opposite of P0.2: it removes limits. It is a useful negative regression case—RelayForge must never silently downgrade this way.

### 5. Alibaba OpenSandbox — best bwrap launch gate, no delegation

Source at `47d85df…`:

- `components/execd/pkg/isolation/bwrap.go:184-212` emits `--unshare-cgroup` alongside PID/UTS/IPC namespaces. Lines 60–105 mount `/` read-only and permit generic explicit binds, but no code allocates/chowns/bounds a cgroup subtree.
- `bwrap.go:127-157` uses `--block-fd` and `--json-status-fd`, restores trusted procfs after caller mounts, and executes a verified gate through an inherited FD.
- `bwrap_linux.go:170-269` constructs the native gate, setup/status pipes, and Unix socket pair before wrapping the command.
- `lifecycle_linux.go:114-181,208-285,327-374` validates bwrap status, authenticates `SCM_CREDENTIALS`, matches parent/namespace/socket inode, captures process start time, and only then permits `MarkReady`.
- `lifecycle_linux.go:541-627` bounds status documents to 64 KiB and 1,024 records and rejects malformed, duplicate, missing-child, and missing-exit streams.
- `lifecycle_linux_test.go:86-217` tests forward-compatible records plus malformed, oversized, too-many, duplicate, missing, and out-of-range cases; lines 219 onward exercise credentials and `/proc` identity before READY.

History:

- `f024c45c83ffce9e693d7f2f4ab312b256712c52` added cgroup namespace isolation, but only as a view.
- `abeb9147a3d9c1cbb65b6cb5f2ce95b6bd4d21fe` added the fail-closed gate; `98db3933138bdb651c560d09ff745717739de17a` activated lifecycle enforcement.

**Assessment:** OpenSandbox is the best reference for eliminating the PID/setup race before exposing a writable subtree. It does not perform cgroup delegation itself.

### 6. Anthropic sandbox-runtime — nested namespace/capability ordering only

At `121c6ac…`, exact search found no cgroup implementation. `src/sandbox/linux-sandbox-utils.ts:1635-1653` documents outer bwrap plus inner user/PID/mount namespace and PID-1 reaper. Lines 1921–1955 force `--unshare-user --cap-drop ALL` after a root-parent capability bug and explain the nested-userns requirement. `test/sandbox/pid-namespace-isolation.test.ts` exercises the actual nested PID behavior. Recent PR #390 fixed a root parent retaining caps; open PR #418 continues nested-userns/CAP_SETFCAP work.

**Assessment:** use its namespace/capability ordering as a review checklist; it has no writable cgroup solution.

### 7. containerd — strongest completed end-to-end writable mount

Current source at `35f120ed…`:

- `internal/cri/server/container_create.go:762-775` adds a private cgroup namespace on unified v2 for every non-privileged container, then selects `WithMountsCgroupWritable` when the runtime handler is configured.
- `internal/cri/opts/spec_linux_opts.go:70-104` changes the cgroup mount between `ro` and `rw` and uses `nosuid,noexec,nodev,relatime`. When there is no private cgroup namespace, lines 85–96 preserve host `nsdelegate` and `memory_recursiveprot` to avoid mutating the shared cgroup2 VFS superblock.
- `internal/cri/config/config.go:108-109,668-671` exposes `cgroup_writable` and rejects it outside cgroup v2.
- `integration/container_cgroup_writable_linux_test.go:36-139` starts a real containerd instance twice and proves `mkdir /sys/fs/cgroup/dummy-group` succeeds only in writable mode.
- `internal/cri/opts/spec_linux_test.go:54-120` tests preservation of host cgroup mount options across cgroup-namespace modes.

History/tradeoffs:

- Merged PR [#11131](https://github.com/containerd/containerd/pull/11131), merge `7c380b9b5057ba869f884d1d979a2db45ffc8245`, added the feature. Review required a real integration test. The control is a runtime configuration, not a per-container security-context decision.
- Commit `e6528332195d23bf98ba58124b4cd647223e6969` made the integration test non-parallel, showing real daemon/global-state interference.
- Merged PR [#12952](https://github.com/containerd/containerd/pull/12952), merge `248b1a665b548f32cede407e0fde464371ad4e58`, fixed a subtle host bug: mounting cgroup2 with a different option set while sharing the host cgroup namespace can strip `nsdelegate`/`memory_recursiveprot` from the host superblock. This is a mandatory RelayForge regression test.

**Assessment:** this does nested writable cgroups better than every coding-agent sandbox surveyed. It is not sufficient alone: it checks v2, not that `nsdelegate` is present; the switch affects a whole runtime handler; it sets no depth/descendant bound; and its integration test proves only `mkdir`, not root-ceiling immutability, parent/sibling escape denial, ownership allowlisting, controller operation, or cleanup.

### 8. runc — strongest low-level ownership and subtree-mount primitive

Current source at `0c87c02…`:

- `libcontainer/specconv/spec_linux.go:550-589` sets cgroup owner UID **only** when the container has a private cgroup namespace and cgroupfs is mounted writable. It maps the actual container process UID to the host UID.
- `libcontainer/rootfs_linux.go:399-433` first mounts cgroup2. On the userns fallback, if there is a cgroup namespace it bind-mounts only `c.cgroup2Path`, never the whole host hierarchy; rootless ENOENT is masked read-only.
- Vendored `github.com/opencontainers/cgroups/systemd/v2.go:368-413` chowns the directory and only names read from `/sys/kernel/cgroup/delegate`, falling back to `cgroup.procs`, `cgroup.subtree_control`, and `cgroup.threads` for old kernels.
- `tests/integration/cgroup_delegation.bats:29-60` covers the critical matrix: read-only + private namespace does not chown; writable + inherited namespace does not chown; writable + private namespace does chown.
- `tests/rootless.sh:107-121` enables available controllers, creates the subtree, and grants the directory/delegation files. The comment cites kernel delegation containment.
- `docs/cgroup-v2.md:42-68` explains systemd user delegation and notes that memory/pids are commonly delegated by default; CPU/cpuset/io need explicit `Delegate=` configuration.

History/tradeoffs:

- Merged PR [#3057](https://github.com/opencontainers/runc/pull/3057), merge `cdce2496358ca17ad82e165d20183c00ac68f7f4`, introduced the semantics after OCI runtime-spec #1123. Review forced an opt-in/safe predicate, private cgroup namespace, exact delegation-file allowlist, and real cgroup-v2 tests. It also documents the systemd-transient-unit ownership difficulty.
- Runc current history includes rootless/cgroup cleanup fixes; `tests/rootless.sh:123-127` records systemd removing empty paths and references issue #5003.

**Assessment:** strongest actual primitive. RelayForge should independently implement the behavior, not paste container-runtime code, because its verifier/bwrap lifecycle and durable ownership model differ.

### 9. Kubernetes KEP-5474 — strongest safety model, not yet shipped

At current enhancements pin `5135358…`, `keps/sig-node/5474-enable-writable-cgroups/README.md` provides the closest direct design:

- Lines 77–103 require explicit writable mode, cgroup v2, private subtrees, visibility/policy, and `nsdelegate`.
- Lines 131–159 require Linux/v2/runtime support and explicit failure, and make `nsdelegate` mandatory so namespace-root resource controls cannot be changed.
- Lines 137 and 149 require parent-owned `cgroup.max.descendants` and `cgroup.max.depth`.
- Lines 163–175 are decisive experimental evidence: a 128 MiB container created about 42,000 sibling cgroups; its own memory stayed 97→122 MiB while node slab grew 200→800+ MiB, available memory fell 14.3 GB→~20 MB, inotify pressure hit 100%, and the node became NotReady.
- Lines 259–267 deliberately keep descendant/depth limits parent-owned rather than exposing them via CRI.
- Lines 279–307 specify validation-before-launch and runtime capability support; lines 404–439 call for unit/integration/e2e coverage including read-only vs writable, v2 validation, runtime compatibility, mixed settings, and inability to escape parent limits.

State/history:

- PR [#5475](https://github.com/kubernetes/enhancements/pull/5475) merged the KEP at commit `54fe87a97ad84eaf88a77481836c0dd33e8f96c3` on 2026-06-16. Review discussion moved from ad hoc controller allowlists to cgroup namespaces + `nsdelegate` and debated cpuset, in-place resize, and pod/container ceilings.
- `kep.yaml` says `status: implementable`, `stage: alpha`, target v1.37, but open approved PR [#6260](https://github.com/kubernetes/enhancements/pull/6260) moves alpha to v1.38 because implementation missed the v1.37 freeze.
- containerd issue [#12252](https://github.com/containerd/containerd/issues/12252) remains open; on 2026-07-20 its shepherd said CRI dependency and writable-cgroup support still need updating.

**Assessment:** it is not evidence of a production-ready implementation. It is the mandatory safety baseline RelayForge can improve by adding durable lease identity/reconciliation and bwrap-specific launch sequencing.

### 10. Bubblewrap itself — namespace creation is not delegation

At `2f55bae…`, `bubblewrap.c:1629-1636` parses `--unshare-cgroup[-try]`; `bubblewrap.c:2750-2777` only checks `/proc/self/ns/cgroup` and adds `CLONE_NEWCGROUP`. No allocation, chown, `nsdelegate` check, subtree-control setup, resource ceiling, or reconciliation exists. No cgroup-specific Bubblewrap test was found. `bubblewrap.c:1-16` identifies the code as LGPL-2.0-or-later and Copyright 2016 Alexander Larsson, so RelayForge should invoke it rather than copy its C implementation.

## Current RelayForge baseline and precise gap

The existing code has unusually strong *outer* scope semantics:

- `src/scope.ts:333-373` behaviorally probes a delegated v2 subtree by creating/removing a child and checking `cgroup.procs`, `cgroup.kill`, and `cgroup.events`; failure is not downgraded.
- `src/scope.ts:710-860` creates a unique inode-pinned scope, gates exec until the child self-enrolls, uses recursive `cgroup.kill`, waits on `cgroup.events`, removes descendants bottom-up, and treats successful removal plus dead process group as evidence.
- `src/sandbox.ts:201-224` currently starts bwrap with read-only `/`, so `/sys/fs/cgroup` is read-only. It does not create a cgroup namespace or mount a delegated subtree.
- Multiple settlement suites explicitly document that they create real scopes but cannot create nested scopes inside the verifier jail because cgroupfs is read-only.

This means the missing feature is **not merely another writable bind**. The verifier must keep the settlement scope as the unforgeable outer owner while giving the jailed process a private view of only a bounded child subtree. The current proof, cleanup, and settlement authority must continue to refer to the outer inode-pinned object.

## Chosen design

### Best implementation discovered

**Working base:** containerd + runc.
**Safety completion:** Kubernetes KEP-5474.
**Race-free bwrap integration:** OpenSandbox lifecycle gate.
**Test execution discipline:** cplt required-capability CI mode.

No single upstream is adequate. This combination fits RelayForge’s event history, explicit state, task lease, policy, observability, crash recovery, and deterministic settlement better than adopting a container runtime wholesale.

### Why

Containerd and runc prove the writable private-subtree primitive; Kubernetes
documents the missing structural safety bounds; OpenSandbox provides the
strongest pre-exec identity gate; and cplt demonstrates that advertised Linux
capability must be a required CI condition. Each omits at least one RelayForge
authority or recovery requirement, so the synthesis is stronger than any one
implementation.

### What RelayForge will reuse

Only `ARCHITECTURAL_INSPIRATION` and `IDEA_ONLY` behavior: exact descendant
mounting, kernel delegation-file ownership, `nsdelegate`, structural limits,
authenticated pre-exec sequencing, and mandatory capability tests. Bubblewrap
is invoked as an external executable; no upstream source, tests, rules, or
configuration are copied.

### What RelayForge will change

The capability is verifier-only and parent-owned; identity is bound to a
durable lease, device/inode, process incarnation, and inherited directory FD;
limits are immutable; cleanup and restart reconciliation are explicit facts;
and domain-controller delegation is excluded from P0.2 rather than simulated.

### Required invariants

1. **Explicit verifier-only capability.** Writable cgroups are never a general `extraWritable` path and never enabled for ordinary provider turns. A typed policy capability authorizes it only for verifier-owned nested provider/settlement execution.
2. **Fail closed.** Require Linux, unified cgroup v2, a behavioral child-scope probe, private cgroup namespace support, exact `nsdelegate` on the cgroup2 mount, required controllers/files, and a working bwrap launch handshake. Any missing property refuses the verifier; no tsk-style limit removal and no Bubblewrap `-try` option.
3. **Outer ownership remains parent/verifier-owned.** The durable settlement scope keeps its unique name, inode, run/attempt/lease binding, and parent-held directory FD. Sandbox input never chooses a host cgroup path.
4. **Expose only a descendant.** Never bind host `/sys/fs/cgroup`. Mount only the lease’s delegated subtree as `/sys/fs/cgroup` inside a private cgroup namespace, with `rw,nosuid,nodev,noexec`; the source host path must not otherwise be visible.
5. **Empty delegation root.** Domain controllers cannot be enabled on a cgroup containing processes. The launch protocol must create a delegation root and a reserved workload leaf, establish the cgroup namespace while rooted at the delegation root, then move every bwrap/workload process to the leaf before releasing exec. A plain argv-only bwrap wrapper cannot prove this sequence; use a small trusted native/FD-gated launcher or equivalent parent-controlled handshake.
6. **Kernel allowlist ownership.** Chown the delegation directory and only the files named by `/sys/kernel/cgroup/delegate`; use the documented fallback only if the kernel file is absent. Do not chown `memory.max`, `cpu.max`, `pids.max`, cpuset limits, `cgroup.max.*`, `cgroup.kill`, or parent cleanup controls.
7. **Immutable outer ceilings.** Before release, the verifier writes its outer CPU/memory/swap/pids ceilings and conservative `cgroup.max.descendants`/`cgroup.max.depth`. The jailed process may subdivide resources but cannot raise those ceilings. Values must be policy/config facts and included in launch/settlement evidence.
8. **Controller activation is parent-controlled.** Enable only the intersection of policy-requested controllers, parent `cgroup.controllers`, and host delegation. Do not infer support from hard-coded systemd paths.
9. **No mount-option mutation.** Preserve host cgroup2 superblock options and prove the before/after option set is identical; containerd PR #12952 is the regression model. Refuse missing `nsdelegate` rather than attempting to add it from an untrusted/shared mount context.
10. **Parent-only teardown and recovery.** On terminal/cancel/timeout, freeze if supported, write outer `cgroup.kill`, wait for `populated 0`, remove deepest-first, and only then mint the existing reap proof. Persist the lease/root inode before READY and reconcile stale trees after restart. Never trust a sandbox-returned path or PID alone.
11. **Capability hygiene.** Drop `CAP_SYS_ADMIN` and other capabilities before executing the verifier. Cgroup creation/migration must work through delegated file ownership, not privilege. Keep current network and filesystem restrictions unchanged.
12. **Observable state.** Emit stable probe/failure codes (`not-v2`, `no-nsdelegate`, `controller-missing`, `delegate-file-denied`, `depth-limit`, `launch-gate-failed`, `cleanup-populated`, etc.) and record selected controllers/limits without leaking host paths to the jailed process.

### Recommended launch sequence

1. Parent opens the already-delegated self cgroup with directory-FD/no-symlink semantics; allocate a unique outer settlement scope and persist `{run, attempt, lease, name, inode}`.
2. Create the verifier delegation root plus reserved workload leaf; set controller mask, outer resource ceilings, `cgroup.max.descendants`, and `cgroup.max.depth` before any untrusted process exists.
3. Apply the kernel delegation-file ownership allowlist to the mapped sandbox host UID. Verify inode/mount identity after every ownership/mount operation.
4. Start bwrap behind an inherited-FD gate with `--unshare-cgroup`, PID/user/mount/network isolation, and status reporting. Authenticate child PID, parent PID, start time, cgroup namespace, and gate socket as OpenSandbox does.
5. While blocked, ensure all sandbox-side processes live in the reserved workload leaf and the delegation root is empty. Mount only the delegation subtree at jailed `/sys/fs/cgroup`; verify `/proc/self/cgroup` resolves to `/` or the reserved leaf under that private root and parent/sibling paths do not exist.
6. Run an in-jail behavior probe: create child, inspect delegation files, move a spawned child into it, observe populated transitions, kill/remove it, and prove root ceilings cannot be modified. Abort and clean if any assertion fails.
7. Release READY. Normal RelayForge provider/verifier execution and existing settlement evidence continue unchanged; the outer scope’s recursive state includes every nested cgroup.
8. Teardown/restart reconciliation uses the outer inode-pinned scope and lease. Nested names are untrusted details and removed bottom-up.

### How RelayForge will improve it

- Over containerd/runc: per-verifier typed capability instead of runtime-wide config; `nsdelegate` rejection; descendant/depth bounds; durable lease/inode reconciliation; bwrap-specific gate; stronger escape and cleanup tests.
- Over Kubernetes KEP: an implementable local control-plane contract now, with durable ownership and settlement evidence rather than pod-only lifecycle; exact fixed defaults can be validated under RelayForge workload tests.
- Over AO: durable cleanup/restart reconciliation and resource bounds, not only process containment.
- Over cplt/OpenSandbox: genuine writable descendant support while retaining required-capability CI and authenticated pre-exec sequencing.

## Mandatory characterization and regression tests before integration

### Pure/unit tests

- Builder never emits writable `/sys` from a generic path; delegation requires the typed verifier capability.
- Exact allowlist from `/sys/kernel/cgroup/delegate`, old-kernel fallback, duplicate/invalid names rejected, and no resource file chowned.
- Controller intersection and no-internal-process state transitions.
- Safe deterministic names; directory-FD traversal rejects absolute paths, `..`, symlinks, mount swaps, wrong device/inode, and recycled names.
- Stable failure classification for v1, missing `nsdelegate`, missing controller/file, read-only mount, and unsupported bwrap flags.

### Real Linux integration tests (must not silently skip in the required job)

- Positive: jailed verifier creates a child cgroup, moves a spawned process into it, sees `populated 1→0`, and removes it.
- Run the **actual nested provider/settlement suites** that motivated P0.2, not only a `mkdir` smoke.
- Negative root: cannot change delegation-root `memory.max`, `memory.swap.max`, `cpu.max`, `pids.max`, cpuset files, or `cgroup.max.*`; cannot disable parent policy controllers.
- Escape: parent and sibling cgroups are absent/inaccessible; host `/sys/fs/cgroup` source path is hidden; a PID outside the PID namespace cannot be moved; `CAP_SYS_ADMIN` is absent; remount attempts fail.
- Bounding: create cgroups until `cgroup.max.descendants` rejects exactly at the configured boundary; nesting fails at `cgroup.max.depth`; the node remains healthy.
- Organizational-boundary proof: verifier-created descendants remain under the immutable outer CPU/memory/pids ceilings. Per-descendant domain-controller limits are explicitly outside P0.2 and require the separate supervisor/payload design rather than a swallowed `EBUSY`.
- Cleanup: `setsid`, double-fork, orphan, fork bomb, child-created nested scopes, stopped tasks, and normal exit all leave the outer scope removed or an explicit unresolved durable fact—never a false settlement proof.
- Crash recovery: kill RelayForge at each gate boundary, restart, validate lease/inode, reclaim only its own stale tree, and never kill a recycled/foreign cgroup.
- Mount regression: snapshot host cgroup2 mount options before/after success and every failure; `nsdelegate` and `memory_recursiveprot` must never be stripped (containerd #12952).
- Race/adversarial: PID reuse, spoofed status frames, duplicate status, oversized stream, gate EOF, mount/source replacement, symlink race, concurrent verifier starts, and cleanup racing child creation.
- Capability matrix: rootless systemd user delegation, rootful CI, missing CPU controller, nested container, cgroup v1, no cgroup namespace, and bwrap without required flags. The required Linux job must fail if its advertised capability is missing, following cplt #113.

### Test acceptance rule

`REFERENCE → CHARACTERIZATION TEST → INTEGRATE → UNIT → INTEGRATION → FAILURE → REAL-WORLD NESTED PROVIDER/SETTLEMENT → RECOVERY → REGRESSION → COMMIT → TEST COMMITTED HEAD`.

No test may treat missing cgroup/bwrap support as green in the job designated to prove P0.2. Other platform jobs may report a typed unsupported result, but must verify that real execution fails closed.

## Legal and attribution decisions

No code was copied in this audit. All product reuse decisions are currently architectural/behavioral.

| Source | Classification now | If implementation ports code later |
|---|---|---|
| AO / Scion / OpenSandbox / SRT / containerd / runc / Kubernetes capability/error implementation | `ARCHITECTURAL_INSPIRATION` | Landed implementation is independent; preserve exact pins and zero-copy provenance. Any later copying requires a new ledger/license decision before the change. |
| Kubernetes KEP-5474 | `IDEA_ONLY` | Design/exhaustion evidence only; never represent it as completed upstream behavior. |
| cplt | `ARCHITECTURAL_INSPIRATION` | Required-capability test behavior only; no source or test copied. |
| tsk | `IDEA_ONLY` / negative behavior reference | No code planned |
| Bubblewrap | `IDEA_ONLY` for the external CLI/ABI | Do not copy LGPL C into RelayForge; normal process invocation does not make RelayForge a derivative |

The canonical `docs/upstream-sources.md` implementation record now names at minimum:

- “Verifier-owned nested cgroup delegation”: containerd `internal/cri/{server/container_create.go,opts/spec_linux_opts.go}` and integration test; runc `spec_linux.go`, `rootfs_linux.go`, delegation tests; Kubernetes KEP-5474.
- “Bwrap gated launch identity”: OpenSandbox `bwrap_linux.go`, `lifecycle_linux.go`, and lifecycle tests.
- “Mandatory sandbox capability CI”: cplt issue #113, commit `66b033a…`, CI and Linux integration guards.
- “Outer scope lifecycle baseline”: AO PR #3550/ADR and RelayForge’s pre-existing `src/scope.ts` behavior, while recording that no AO code was copied.

## Final comparison answer

**Does another coding-agent sandbox do safe nested writable cgroup delegation better? No.** OpenSandbox and cplt create isolated cgroup namespace views but not writable delegation; tsk drops limits when nested; Scion only configures outer runtime limits; SRT has no cgroup implementation; AO’s relevant work is an unmerged non-delegating systemd scope.

**Does another open-source infrastructure implementation do it better? Yes.** Containerd+runc have the strongest completed implementation of the actual writable-private-subtree primitive. Kubernetes KEP-5474 has the strongest safety design, particularly `nsdelegate` enforcement and descendant/depth bounds, but remains incomplete. RelayForge should implement the synthesis above and treat any argv-only `--unshare-cgroup` + writable bind solution as insufficient.

## Implementation verification resolution

| Former open item | Resolution and current evidence | Scoped future matrix |
|---|---|---|
| Bubblewrap flag/version support | Resolved for the required runner by physical executable identity plus the behavioral capability probe; help/version text alone is never readiness. On 2026-08-09 the canonical `/usr/bin/bwrap` composition passed strict cgroup namespace, FD bind, gated launch, status, and cleanup characterization on kernel `6.17.0-1021-gcp`. | Additional distributions and Bubblewrap builds may be added as separately required runners. An uncharacterized build remains a typed unsupported capability, never a weaker fallback. |
| Monitor/workload placement and root-empty assumption | Resolved by narrowing P0.2 to organizational descendants and proving the actual FD3/4/5 launcher, private namespace root, exact membership, child lifecycle, root-policy denial, and settlement. Domain-controller enablement at a populated boundary is explicitly not promised. | Domain-controller delegation requires the documented supervisor/payload topology, a separate ADR, and new real integration tests. |
| Structural-limit defaults | Resolved: ADR 001 ratifies `cgroup.max.descendants=256` and `cgroup.max.depth=16`; the required-host test created exactly each boundary and proved the next `mkdir` fails with `EAGAIN`. The actual nested suites fit within those limits. | Revisit only with measured RelayForge workload evidence and a reviewed ADR; the jailed process can never raise the limits. |
| Future kernel delegation files and domain/threaded controllers | Resolved for P0.2 by reading the kernel delegation allowlist, validating every admitted entry, behaviorally probing the composed jail, and failing closed on incompatible state. Domain-controller policy remains out of scope. | Add new delegation files only after parser/ownership characterization; add controller support only through the separate controller-delegation design. |
| Implementation language and launcher boundary | Resolved as an independently authored TypeScript parent/Linux adapter plus a fixed, identity-bound `/bin/sh` FD-gated launcher ABI. Canonical shell/stat/Bubblewrap/Node identities are cached by runtime identity and revalidated before spawn. | A native launcher is not required by the current characterized contract. Any future replacement requires equivalent identity, crash, spoofing, and cleanup gates. |

Required-host evidence recorded for this resolution is 21/21 capability and
limit tests, 46/46 nested transport/launch/settlement tests, and 193/193
streaming, fallback, receipt, resume, cost, ledger, and containment tests, with
zero capability skips. Broader platform coverage is an additive compatibility
matrix, not an unresolved release claim.
