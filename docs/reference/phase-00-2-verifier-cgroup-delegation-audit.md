# Phase 00.2 reference audit: verifier cgroup delegation

## Scope and gate verdict

This audit is the research gate for P0(2) in
[`ROADMAP-AO-PARITY.md`](../../ROADMAP-AO-PARITY.md). It asks how RelayForge can
let a Bubblewrap-confined verifier create nested cgroup-v2 scopes without
exposing the host hierarchy, weakening the existing process-settlement proof,
or silently dropping containment on an unsupported host.

The research gate and its ADR-governed implementation are complete. The
required real-Linux invocation passed the capability, exact-limit, production
session, recovery, and nested-suite characterization described below. Platform
guards remain only for ordinary unsupported-host jobs; the required job ran the
corresponding suites with zero capability skips.

The result is a synthesis, not a port. No coding-agent sandbox surveyed safely
delegates a bounded writable cgroup subtree through Bubblewrap end to end.
Containerd and runc have the strongest completed adjacent implementation;
systemd and the Linux ABI define the strongest ownership boundary; Kubernetes
KEP 5474 supplies the missing exhaustion threat model; and OpenSandbox/cplt
provide the strongest launch-gate and non-vacuous sandbox-test lessons.

## Research method and pinned corpus

The audit inspected implementation source, tests, design documents, relevant
issues and pull requests, current history, repository licenses, NOTICE files,
and sampled file headers. README claims and command help text were not treated
as behavioral evidence. Pins make the findings reproducible even when an
upstream branch moves.

## Reference Matrix

| Repository | Pin and relevant implementation | Strength | Weakness for P0(2) | License | Reuse decision |
| --- | --- | --- | --- | --- | --- |
| [Untrivial Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec) plus [PR #3550](https://github.com/Untrivial-ai/agent-orchestrator/pull/3550) at `bd7baa54e829c3426cdeefe345b8252d1c8ed746` | Transient systemd user scopes, exact unit-state waits, `KillMode=control-group`, and a `setsid` canary | Best primary-baseline process-ownership proposal and explicit unsupported-backend rejection | Unmerged; no `Delegate=yes`, writable private cgroup view, structural bounds, or durable restart reconciliation; its proposed ADR excludes resource limits and recovery | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| [Google Scion](https://github.com/GoogleCloudPlatform/scion/tree/91c26b343a26b7697f9432de5792cd7372b391a6) | Docker/Podman CPU and memory flags; Kubernetes resource/security contexts and tests | Strong outer-runtime resource policy and real incident-driven defaults | No child delegation; outer caps only; rootless/cgroup-v1 capability gap remains | Apache-2.0 with Google file headers | `ARCHITECTURAL_INSPIRATION` |
| [navikt/cplt](https://github.com/navikt/cplt/tree/4c056bcfbf43c9a1261f7bd823d0973efaefeeb8) | Bubblewrap cgroup/user/PID namespaces; production-derived capability probe; required-sandbox CI | Strongest coding-agent Bubblewrap characterization and anti-skip discipline | Deliberately refuses writable rules under `/sys`; private view remains read-only | MIT, Copyright 2025 Nav | `ARCHITECTURAL_INSPIRATION` |
| [dtormoen/tsk](https://github.com/dtormoen/tsk/tree/bc0c0c6cb72920e69bcbc93b7ac08d9e20c3a55a) | Nested Docker/Podman build flow and controller probe | Genuine nested-build smoke coverage | Disables CPU/memory limits when nested and has a permissive unknown-controller fallback | MIT, Copyright 2025 Danny Tormoen | `IDEA_ONLY` as a negative example |
| [Alibaba OpenSandbox](https://github.com/alibaba/OpenSandbox/tree/47d85df848f957f5e7b3231e435ef9333a57537c) | Strict Bubblewrap cgroup namespace, blocked pre-exec gate, credential/inode identity checks, bounded JSON-status parser | Strongest coding-agent launch/identity sequencing | Creates only a namespace view; no writable delegation, bounds, or nested cleanup | Apache-2.0 with Alibaba file headers | `ARCHITECTURAL_INSPIRATION` |
| [Anthropic sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime/tree/121c6ac86df7c958aaf953d27116e74848c31318) | Outer Bubblewrap plus inner user/PID/mount namespaces and capability-drop ordering | Valuable nested-namespace and retained-root-capability regression history | No cgroup namespace or writable cgroup implementation | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| [systemd](https://github.com/systemd/systemd/tree/06cb8fbe618604f43c9a9a638e6fc3df920daa0c) | `CGROUP_DELEGATION.md`, `Delegate=`, `DelegateSubgroup=`, access helpers, and real delegation/protected-mount tests | Strongest single-writer boundary, process placement, and lifecycle history | Service-manager architecture is much broader than RelayForge; cannot be transplanted | LGPL-2.1-or-later | `ARCHITECTURAL_INSPIRATION` |
| [OCI runtime-spec](https://github.com/opencontainers/runtime-spec/tree/6999a89a76a0329f440d5740497bedb9dd431297) | `config-linux.md` ownership contract | Clearest portable rule: private cgroup namespace plus writable mount, directory and kernel delegation files only | Specification, not lifecycle or recovery | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| [runc](https://github.com/opencontainers/runc/tree/0c87c02ff02123f1bc2cd1b3f850f94e5b8de983) | Ownership predicate, exact-subtree mount fallback, delegation allowlist, integration ownership matrix, init-location recovery | Strongest working low-level ownership and mount primitive | Container-runtime assumptions; no structural exhaustion bounds; cleanup policy is not RelayForge settlement | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` |
| [containerd](https://github.com/containerd/containerd/tree/35f120ed0ae803d16bf92f76f7fe0a2654822e25) | Private cgroup namespace, writable cgroup mount, real child-creation integration test, host mount-option regression fix | Strongest completed end-to-end adjacent integration | Runtime-wide switch; original gate checks v2 only; no `nsdelegate`, structural-bound, escape, or recovery proof | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` |
| [opencontainers/cgroups](https://github.com/opencontainers/cgroups/tree/783139a1555b1fbe9941f1c478651cd7d8718519) | Recursive post-order removal and `EBUSY` retry | Useful cleanup behavior | Short retry and thin concurrent-tree coverage are not settlement proof | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| [Kubernetes enhancements, KEP 5474](https://github.com/kubernetes/enhancements/tree/51353583266ccece601bb590f9f7d2e5e335b39e/keps/sig-node/5474-enable-writable-cgroups) | Explicit opt-in/capability, cgroup v2, `nsdelegate`, parent-owned depth/descendant bounds, exhaustion experiment | Strongest writable-cgroup threat model and test plan | `implementable`, not a completed implementation at the audited pin; exact defaults remain a product decision | Apache-2.0 | `IDEA_ONLY` for design evidence |
| [Kubernetes](https://github.com/kubernetes/kubernetes/tree/94c136764292cc5fac976c0de6587daaea56410f) | Runtime-feature publication and explicit unsupported-workload rejection | Mature structured capability and event pattern | No KEP-5474 implementation or matching tests at this pin | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| [Bubblewrap](https://github.com/containers/bubblewrap/tree/2f55bae38468d0c50cf5df87b1e481e882b63acb) | Strict `--unshare-cgroup` and FD-bound bind mount | Correct namespace and late exact-FD mount primitives | Supplies mechanism only: no allocation, ownership, bounds, policy, or reconciliation | LGPL-2.0-or-later | `IDEA_ONLY` for the CLI/ABI contract; invoke the executable |
| [Linux kernel](https://github.com/torvalds/linux/tree/06cf61899d6498b33e4b7c87d99d5bd471ccc375) | cgroup-v2 documentation, implementation, and `nsdelegate`/namespace selftests | Normative enforcement and error semantics | Kernel code is not an application architecture and is GPL-2.0-only | GPL-2.0-only | `IDEA_ONLY`; use documented ABI behavior only |

## Source, test, history, and issue evidence

### Primary and coding-agent baselines

Agent Orchestrator current `main` contains no first-party `cgroup` or
Bubblewrap implementation. [Issue
#2523](https://github.com/Untrivial-ai/agent-orchestrator/issues/2523) records a
roughly 31 GB grep incident, 5–12 GB orphan development servers, and a
reproduction in which `pkill -s` misses a `setsid` descendant. Open PR #3550
adds `backend/internal/adapters/runtime/tmux/systemd_containment.go`, its unit
tests, a real Linux `setsid` canary in `tmux_integration_test.go`, and proposed
ADR `docs/adr/0002-worker-process-containment.md`. It validates the systemd user
manager before launch and waits for exact scope activation/release, but it does
not request delegation and explicitly defers limits and durable cleanup.

Scion's `pkg/runtime/docker.go`, `podman.go`, and `k8s_runtime.go` correctly map
outer resource policy and hardening. `pkg/config/resource_defaults.go` ties its
two-CPU default to an observed 550% CPU/13.5-second-latency incident. Its tests
cover runtime flags and Kubernetes security context, but exact searches found
no `cgroup.subtree_control`, `cgroup.max.depth`, `cgroup.max.descendants`, or
`nsdelegate`. Merged PR #894 (`298ff87bea60756f8caab28367dab485f63423af`)
is strong outer-limit evidence, not nested delegation evidence.

cplt's `src/sandbox_bubblewrap.rs` emits private namespaces but explicitly
excludes all writable rules below `/sys`. Unit test
`bwrap_managed_subtrees_are_not_rebound` proves that even a requested writable
`/sys/fs/cgroup` is not rebound. Issue #113 discovered that every Bubblewrap
test had silently skipped in CI while production ordering was broken. Commit
`66b033a0b999a5f5f45faa0763115a598b2ffc8e` added the production-derived probe
and `.github/workflows/ci.yaml` now runs with `CPLT_TEST_REQUIRE_SANDBOX=1`.
That failure mode makes a non-skipping P0(2) job mandatory.

tsk's `src/docker/mod.rs` disables memory and CPU quota when `is_nested()` is
true or its hard-coded controller probe fails. Commit
`4f5c66c9fe6186b78bb1646ddbd56141993ae86b` made that downgrade explicit.
Its DIND test proves usability but not isolation. RelayForge must preserve this
as a negative regression: a missing controller or namespace can never turn
limits off and make a verifier green.

OpenSandbox's `components/execd/pkg/isolation/bwrap.go`, `bwrap_linux.go`, and
`lifecycle_linux.go` combine `--unshare-cgroup`, a blocked native workload gate,
`SCM_CREDENTIALS`, `/proc` identity, socket/namespace inode checks, and a
64-KiB/1,024-record bounded status stream. `lifecycle_linux_test.go` covers
malformed, duplicate, missing, oversized, and credential-mismatch cases.
Commits `f024c45c83ffce9e693d7f2f4ab312b256712c52`,
`abeb9147a3d9c1cbb65b6cb5f2ce95b6bd4d21fe`, and
`98db3933138bdb651c560d09ff745717739de17a` show the namespace, gate, and
enforcement sequence. It never allocates or delegates a writable subtree.

Anthropic sandbox-runtime has no cgroup implementation at the audited pin.
`src/sandbox/linux-sandbox-utils.ts` and
`test/sandbox/pid-namespace-isolation.test.ts` do, however, document the outer
Bubblewrap/inner-namespace ordering and the need to force
`--unshare-user --cap-drop ALL` after a root-parent retained-capability bug.
Merged PR #390 and open PR #418 make capability absence inside the final jail a
required P0(2) assertion.

### Mature infrastructure and normative ABI

systemd's `docs/CGROUP_DELEGATION.md` defines the decisive single-writer model:
the service manager owns the delegated root, and the delegate owns descendants.
`src/shared/cgroup-setup.c`, `man/systemd.resource-control.xml`,
`TEST-19-CGROUP.delegate.sh`, and
`TEST-07-PID1.protect-control-groups.sh` cover directory/delegation-file
ownership, `DelegateSubgroup=`, protected mounts, and `nsdelegate`. Commit
`f8f67eab70737549325a718d66c589847043516a` fixed namespace/subgroup ordering:
creating the cgroup namespace after moving to a leaf accidentally made the leaf
the namespace root. Commit `056bc106e1e344f98cdfa86fdf62e6fed72958c9`
fixed restart `EBUSY` caused by stale controller state. RelayForge must create
the namespace at the intended outer boundary and never reuse a dirty root.

OCI runtime-spec `config-linux.md`, change
`f4ef3914439ef595fd00c6d0b81753e3463626a3`, and correction
`600a8bd6d65d9f687310e6f3030c78b4fe946309` require the safe conjunction of a
private cgroup namespace and writable mount. Ownership changes are limited to
the directory and files named by `/sys/kernel/cgroup/delegate`; only `ENOENT`
is optional. runc implements that predicate in
`libcontainer/specconv/spec_linux.go`, exact-subtree fallback mounting in
`libcontainer/rootfs_linux.go`, and the ownership matrix in
`tests/integration/cgroup_delegation.bats`. Issue #5089 and commits
`94133fab970c2ff9011cc9531b7415934b9fcd61`,
`1d030fab7dd856c0709e102b61bd1792e85d13d3`,
`6c07a37a585db26a3117683456c9c06f97dc7485`, and
`1fdbab8107c61876eb69f88730497d250d67e0e6` demonstrate why a configured path
must not be assumed to retain its original process or inode identity.

Containerd's `internal/cri/server/container_create.go`,
`internal/cri/opts/spec_linux_opts.go`, and
`integration/container_cgroup_writable_linux_test.go` are the strongest
completed adjacent integration: cgroup v2 plus a private cgroup namespace can
be configured writable and a real child cgroup can be created. PR #11131
(`7c380b9b5057ba869f884d1d979a2db45ffc8245`) introduced it. PR #12952
(`248b1a665b548f32cede407e0fde464371ad4e58`) fixed a more important shared
superblock bug: remounting with different options in a shared cgroup namespace
could strip host `nsdelegate` and `memory_recursiveprot`. RelayForge therefore
must snapshot mount options before/after every success and failure path.

`opencontainers/cgroups/utils.go` supplies a useful post-order removal and
bounded `EBUSY` retry pattern, but `utils_test.go` does not cover a changing deep
tree or namespace-held mount references. Removal is an attempt; RelayForge's
proof still requires kernel `populated 0`, disappearance of the expected inode,
and a dead process group.

Bubblewrap `bubblewrap.c` treats `--unshare-cgroup` as strict and
`--unshare-cgroup-try` as opportunistic. Commit
`a253257cd298892da43e15201d83f9a02c9b58b5` added `--bind-fd` with post-mount
device/inode verification. Commit
`5a76f51dc683ec84215836bcb958f3884b3c528e` fixed state handling in the try
form. The audited head also adds `--not-a-security-boundary`, whose semantics
explicitly disqualify it here. Bubblewrap creates namespaces before setting up
the new root, so its launcher must already be enrolled at the chosen boundary.

Linux `Documentation/admin-guide/cgroup-v2.rst`, `kernel/cgroup/cgroup.c`, and
`tools/testing/selftests/cgroup/test_core.c` establish the ABI: `nsdelegate`
protects namespace-root policy, paths above the namespace root are hidden,
domain controllers obey the no-internal-process rule, structural maxima default
to `INT_MAX`, limit exhaustion returns `EAGAIN`, and `cgroup.kill` recursively
kills descendants. These are behavioral requirements; no GPL kernel source or
selftest code will be copied.

KEP 5474 supplies the missing exhaustion evidence. A roughly 128-MiB container
created about 42,000 cgroups while its own memory rose modestly, but node slab
grew by hundreds of MiB, available memory collapsed, inotify pressure reached
100%, and the node became NotReady. The KEP therefore requires parent-owned
`cgroup.max.descendants` and `cgroup.max.depth`, `nsdelegate`, explicit runtime
capability, and pre-launch rejection. At the audited pin the KEP is
`implementable`, with its initial alpha slipping, and containerd tracking issue
#12252 remains open. It is threat-model evidence, not production parity.

## Current RelayForge baseline and precise gap

Before P0(2), RelayForge already had stronger outer settlement semantics than
the primary reference:

- `src/scope.ts` creates a unique `loop-<hex>` child below the process's
  delegated cgroup, records its inode, enrolls a pre-exec trampoline, gates the
  provider until `.loop_scopes` is appended and fsynced, uses recursive
  `cgroup.kill`, waits for `cgroup.events`, removes descendants bottom-up, and
  requires both cgroup removal and process-group death.
- `src/orchestrator.ts` centralizes bounded streaming, transcript durability,
  timeout/cancellation, owned-scope tracking, and settlement evidence. It
  already refuses real providers when a strong scope is unavailable.
- `src/sandbox.ts` gives Bubblewrap a read-only `/`, private `/tmp`, optional
  network namespace, and narrow writable checkout binds. It neither creates a
  cgroup namespace nor exposes a writable exact subtree.
- `runOneVerify` used synchronous verifier execution outside the centralized
  scoped transport. The P0(2) implementation replaced it with async ordered
  verification through that same bounded transport and a verifier-specific
  typed cgroup backend; no second output/timeout authority remains.

The missing feature is not a generic writable path. It is a verifier-only
composition that preserves the outer inode-pinned settlement object while
showing that exact object as the root of a private cgroup namespace.

## Explicit comparison

| Question | Finding | Consequence |
| --- | --- | --- |
| Does the primary AO baseline do this better? | No. Its relevant systemd work is open, non-delegating, and explicitly excludes limits/recovery. | Retain its exact-state/systemd lifetime lessons only. |
| Does another coding-agent sandbox do this better? | No. cplt is read-only, OpenSandbox creates only a namespace view, tsk drops limits, Scion applies outer limits, and SRT has no cgroup implementation. | Do not adopt an agent sandbox wholesale. |
| Does mature infrastructure do the primitive better? | Yes. runc/containerd implement private writable cgroup mounts and safe ownership conditions. | Independently reproduce the behavior and add the missing product policy. |
| Is the strongest safety design already shipped? | No. KEP 5474 has the best threat model but was not implemented at the inspected Kubernetes/containerd pins. | Treat it as design evidence, not compatibility proof. |
| Is `--unshare-cgroup` alone delegation? | No. It creates a namespace view only. | Require a fresh bounded subtree, exact FD bind, `nsdelegate`, ownership and lifecycle. |

## Chosen design

> **Decision:** For P0(2), each real verifier gets one fresh RelayForge-owned
> cgroup-v2 settlement scope. A trusted pre-exec launcher enrolls at that scope,
> the parent durably records its device/inode and process identity, and strict
> Bubblewrap creates a private cgroup namespace while already enrolled there.
> Bubblewrap mounts only a pre-opened FD for that exact scope at
> `/sys/fs/cgroup`. The parent writes and reads back
> `cgroup.max.descendants=256` and `cgroup.max.depth=16` before spawn. The jail
> may create organizational descendants but cannot mutate root policy, see
> parents/siblings, or receive a production downgrade when any capability is
> unavailable. Parent-owned cleanup and settlement continue to use the original
> outer object. Domain-controller delegation is not part of P0(2).

The normative FD, gate, state-machine, failure, recovery, and cleanup contract
is in ADR 001. A typed verifier capability must be the only API that enables
the writable cgroup view. `SandboxPolicy.extraWritable`, caller-provided host
paths, `--unshare-cgroup-try`, a whole-hierarchy bind, and an environment escape
hatch are all forbidden.

### Why P0(2) stops at organizational descendants

Bubblewrap's monitor can remain in the namespace-root cgroup. Under cgroup v2's
no-internal-process rule, that can make domain-controller activation at the
root return `EBUSY`. P0(2) needs nested scopes for provider/settlement
containment, not a general container-runtime resource API, so it promises
child/grandchild creation, membership, recursive kill, and removal only. It
must test the `EBUSY` behavior rather than swallow it.

A future controller-delegation ADR would require a supervisor/payload topology,
namespace creation at the outer boundary before movement to the payload leaf,
controller-mask policy, and new limit enforcement tests. That work is not an
implicit extension of this decision.

## How RelayForge improves the references

- Over AO, it retains an exact durable object across crashes and applies
  structural exhaustion bounds rather than stopping at process ownership.
- Over containerd/runc, it uses a per-verifier typed capability instead of a
  runtime-wide switch, rejects missing `nsdelegate`, hides siblings, pins the
  source by FD, and binds cleanup to lease/inode settlement evidence.
- Over KEP 5474, it defines a concrete local launch and recovery protocol with
  fixed initial structural values and operator-visible failures.
- Over OpenSandbox/cplt, it combines authenticated pre-exec sequencing and a
  mandatory real-sandbox job with an actually writable, bounded descendant
  hierarchy.
- Over the current RelayForge tree, it reuses the centralized transport and
  strong-scope proof instead of creating a second unbounded synchronous
  verifier runner.

## Architectural consistency gate

Implementation review must reject a change unless all of these are true:

1. The verifier is routed through the existing centralized headless transport;
   no second spawn/output-buffer/timeout/settlement implementation is added.
2. `ProcessScope` remains the parent-owned settlement authority. The sandbox
   receives an opaque FD-bearing handle, never a caller-controlled cgroup path.
3. The journal/scope-identity migration adds device plus inode and remains
   compatible with existing settlement MACs or includes an explicit versioned
   migration. A same-name replacement is never adopted.
4. Writable cgroups require a verifier-specific typed capability. Generic
   `extraWritable` cannot name `/sys` or a cgroup mount.
5. Capability probing is behavioral and injectable. Production has no env var,
   permissive flag, path-bind fallback, raw-cgroup fallback, or test trusted
   runner reachable through CLI/config.
6. `doctor`, derived run state, and an event expose a stable reason code and
   actionable detail without leaking the hidden host cgroup path to the jail.
7. Existing network, read-only-root, environment-scrubbing, transcript,
   cancellation, lease, and settlement guarantees remain unchanged.
8. Each scope skip/debt marker is removed only with its real verifier-jail test
   in the same reviewed change. A job designated to prove P0(2) fails if the
   advertised capability is absent; it never reports a skip as green.

The rejected local attempts `4620946`, `dab1765`, `4e6b547`, and `5d9d6b3`
violate this gate: they bind host paths without a private cgroup namespace or
FD pin, omit `nsdelegate` and structural bounds, do not handle nested cleanup
or crash recovery, and in two cases duplicate transport with unbounded
`Buffer[]` accumulation.

## Required characterization and adversarial tests

### Pure and capability tests

1. Parse real and fixture mountinfo, including escaped fields and multiple
   mounts; reject cgroup v1, the wrong mount, and absent `nsdelegate`.
2. Read `/sys/kernel/cgroup/delegate`; accept the documented fallback only when
   that file is `ENOENT`, reject invalid/duplicate names, and propagate
   `EACCES`, `EIO`, and unexpected types.
3. Prove strict Bubblewrap cgroup namespace and FD-bind behavior with a
   disposable scope; version/help output alone is insufficient.
4. Exercise every typed unavailable reason and prove refusal occurs before the
   verifier or any untrusted command spawns.
5. Assert the builder can emit the verifier cgroup fragment only from the typed
   capability and can never make `/sys` writable through a generic bind.

### Launch, namespace, and ownership tests

1. Assert exactly one strict `--unshare-cgroup` and one FD bind to
   `/sys/fs/cgroup`; reject `-try`, `--not-a-security-boundary`, source paths,
   and whole-hierarchy binds.
2. Fail before spawn on a structural-limit write/read mismatch, scope-FD
   device/inode mismatch, symlink, mount swap, recycled path, malformed status,
   duplicate status, wrong nonce/PID, gate EOF, or journal fsync failure.
3. Inside the real jail, prove `/proc/self/cgroup` is `0::/`, the namespace-root
   device/inode matches the opened scope, parents/siblings and the host source
   path are invisible, and `CAP_SYS_ADMIN` is absent.
4. Prove only the directory and kernel-delegation allowlist are writable as
   intended. Root structural/resource writes and controller weakening fail;
   child and grandchild creation, membership, and removal succeed.
5. Snapshot host cgroup2 mount options before and after success and every
   injected failure. `nsdelegate`, `memory_recursiveprot`, and all other
   existing options must remain unchanged.
6. Prove all inherited scope/status/gate FD duplicates close on success,
   refusal, spawn error, timeout, cancellation, and parent death; the verifier
   must not see them in `/proc/self/fd`.

### Limits, lifecycle, and recovery tests

1. Create exactly to the configured descendant and depth boundaries and assert
   the next `mkdir` fails with `EAGAIN`; do not merely assert that some error
   occurred. Keep a node-health canary throughout the exhaustion test.
2. Document P0 behavior: organizational descendants work, while enabling a
   domain controller at a populated boundary may fail with `EBUSY` and is never
   treated as enabled.
3. Exercise normal exit, `setsid`, double-fork, orphan, stopped task, fork bomb,
   nested child creation during cleanup, and namespace-held `EBUSY`/`ENOTEMPTY`.
   Each ends in `SETTLED` or a durable `UNRESOLVED_BLOCKED`, never an optimistic
   proof.
4. Race `cgroup.kill` with forks/migration, wait for `populated 0`, rescan and
   remove deepest-first, and require both expected-inode disappearance and
   process-group `ESRCH`.
5. Crash after allocation, limit write, FD pin, spawn, enrollment, journal
   fsync, Bubblewrap exec, and verifier exec. Restart under the run lease,
   reclaim only a matching device/inode, and retain corrupt/foreign records.
6. Recreate a recorded name with a foreign inode and prove recovery neither
   writes `cgroup.kill` nor removes it. An unreadable tree, `EACCES`, `EIO`, or
   persistent busy state remains blocked and operator-visible.
7. Run the actual nested provider and settlement suites that motivated P0(2),
   not just a `mkdir` smoke. Test rootless delegated systemd, rootful CI,
   missing controller, nested container, cgroup v1, missing cgroup namespace,
   and Bubblewrap without FD bind.

Acceptance order is:

```text
REFERENCE -> CHARACTERIZATION -> INTEGRATE -> UNIT -> REAL LINUX ->
FAILURE -> NESTED PROVIDER/SETTLEMENT -> RECOVERY -> REGRESSION ->
COMMIT -> TEST COMMITTED HEAD
```

## Legal conclusion

No upstream source, test, comment, or documentation text was copied. P0(2) will
be independently implemented from behavior and documented ABI contracts.
systemd and Bubblewrap are LGPL; Bubblewrap is invoked as an external program,
and their implementation source is not imported. Linux source/selftests are
GPL-2.0-only and are used solely as normative behavioral evidence. The OCI,
runc, containerd, opencontainers/cgroups, Kubernetes, AO, Scion, OpenSandbox,
and SRT references are Apache-2.0; cplt and tsk are MIT. Their current
classifications remain `ARCHITECTURAL_INSPIRATION` or `IDEA_ONLY`.

Any future substantial copy or close port must update
[`docs/upstream-sources.md`](../upstream-sources.md) before the code lands,
identify exact source files and commits, preserve required copyright/license
headers and NOTICE material, and receive a separate license review.

## Implementation evidence and remaining matrix work

The initial required host (Linux `6.17.0-1021-gcp`, cgroup2 device `0:29`,
canonical `/usr/bin/bwrap`) proved every namespace/FD/placement assertion,
unchanged mount options, authenticated gated launch, v2 recovery, and exact
structural enforcement: 256 descendants and depth 16 succeeded and the next
creation at each boundary returned `EAGAIN`. The production jail then ran the
actual nested RelayForge suites: 46/46 transport/launch/settlement tests and
193/193 streaming/fallback/receipt/resume/cost/ledger/containment tests passed
with zero capability skips.

This closes the implementation gate for the characterized host. Release CI
should retain the required-capability invocation and expand the matrix across
supported kernel/Bubblewrap versions. A future matrix failure is a typed
unsupported result or an ADR amendment; it never authorizes path binding,
opportunistic namespaces, disabled limits, or unsandboxed verification.
