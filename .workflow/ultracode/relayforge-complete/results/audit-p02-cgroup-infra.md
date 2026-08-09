# P0(2) Reference Audit: delegated cgroup-v2 verifier jail

Date: 2026-08-09

Scope: safe delegation of a per-verifier cgroup-v2 subtree into a Bubblewrap jail, nested child cgroups, process enrollment, cleanup/recovery, and behavior when the required kernel/runtime capability is unavailable.

This audit inspected source, tests, design documentation, current history, and relevant issue/PR discussions. README claims were not treated as implementation evidence. No upstream code was copied.

## Executive conclusion

RelayForge should delegate exactly one fresh, uniquely named outer cgroup to each verifier. The verifier transport must enter that cgroup before Bubblewrap creates a **private cgroup namespace**, and Bubblewrap must bind the already-open outer-cgroup directory FD at the canonical `/sys/fs/cgroup` path. The host must set and read back `cgroup.max.descendants` and `cgroup.max.depth` before spawn. With the host cgroup2 mount using `nsdelegate`, the verifier can manage descendants but cannot relax limits or mutate controller files at its namespace root.

The safe composition is therefore:

1. prove the complete capability tuple, including cgroup v2, a strong RelayForge-owned outer scope, `nsdelegate`, strict Bubblewrap cgroup-namespace support, FD-based bind support, delegation files, and a behavioral isolation probe;
2. create a fresh outer scope and journal its name plus inode identity;
3. set and read back bounded depth/descendant limits;
4. open the exact scope with `O_PATH|O_DIRECTORY|O_NOFOLLOW`, verify its device/inode against the journal, and retain/explicitly inherit the FD;
5. enroll the launcher process in the scope and durably record enrollment before `exec`;
6. run Bubblewrap with strict `--unshare-cgroup --bind-fd <fd> /sys/fs/cgroup`;
7. allow the verifier to create and enroll workers only below `/sys/fs/cgroup`;
8. on settlement, use recursive `cgroup.kill`, wait for `populated 0`, post-order remove descendants with bounded retry/rescan, and prove both cgroup inode disappearance and process-group death.

Do **not** bind the host's complete `/sys/fs/cgroup`, bind a scope at its original host path, use `--unshare-cgroup-try`, depend only on `chown`, or silently run a weaker verifier when the capability is absent. Those variants lose namespace-root protection, expose siblings, are susceptible to path replacement, or make enforcement depend on kernel/runtime accidents.

P0(2) should promise organizational nested cgroups and containment, not unrestricted delegation of domain controllers. Bubblewrap's monitor remains in the namespace-root cgroup, so the cgroup-v2 no-internal-process rule can legitimately prevent enabling domain controllers there. Full controller delegation requires a later supervisor/payload-sibling design and different namespace/attachment ordering.

## Reference Matrix

| Repository | Relevant implementation and evidence | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| `systemd/systemd` @ `06cb8fbe618604f43c9a9a638e6fc3df920daa0c` | `docs/CGROUP_DELEGATION.md`; `man/systemd.resource-control.xml`; `src/shared/cgroup-setup.c`; `src/core/execute.c`; `src/core/exec-invoke.c`; `test/units/TEST-19-CGROUP.delegate.sh`; `test/units/TEST-07-PID1.protect-control-groups.sh`; fixes `f8f67eab70737549325a718d66c589847043516a`, `056bc106e1e344f98cdfa86fdf62e6fed72958c9` | Strongest delegation boundary, single-writer model, subgroup/process placement, real integration tests, and hard-earned restart/namespace-ordering behavior | Implements a service manager, not a verifier-specific jail; its lifecycle and policy cannot be transplanted wholesale | LGPL-2.1-or-later (SPDX/file licensing) | `ARCHITECTURAL_INSPIRATION` |
| `opencontainers/runtime-spec` @ `6999a89a76a0329f440d5740497bedb9dd431297` | `config-linux.md` cgroup ownership contract; ownership change `f4ef3914439ef595fd00c6d0b81753e3463626a3`; absent-delegate-file correction `600a8bd6d65d9f687310e6f3030c78b4fe946309` | Clearest portable contract for when ownership delegation is safe and which files may be changed | A specification, not a lifecycle/recovery implementation; ownership alone is insufficient confinement | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| `opencontainers/runc` @ `0c87c02ff02123f1bc2cd1b3f850f94e5b8de983` | `libcontainer/specconv/spec_linux.go`; vendored `opencontainers/cgroups/systemd/v2.go`; `libcontainer/rootfs_linux.go`; `libcontainer/process_linux.go`; `libcontainer/init_linux.go`; `tests/integration/cgroup_delegation.bats`; `tests/integration/cgroups.bats`; `tests/integration/exec.bats`; issues #2356, #3387, #5089; fixes `94133fab970c2ff9011cc9531b7415934b9fcd61`, `1d030fab7dd856c0709e102b61bd1792e85d13d3`, `6c07a37a585db26a3117683456c9c06f97dc7485`, `1fdbab8107c61876eb69f88730497d250d67e0e6` | Best executable ownership matrix, exact-cgroup mount technique, actual-init-location recovery, and kill fallback | Container-runtime assumptions are broader than RelayForge needs; vendored helper is not a complete crash-recovery protocol | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; reproduce behavior with independent tests |
| `containerd/containerd` @ `35f120ed0ae803d16bf92f76f7fe0a2654822e25` | `internal/cri/opts/spec_linux_opts.go`; `internal/cri/config/config.go`; `integration/container_cgroup_writable_linux_test.go`; PR #11131 / `7c380b9b5057ba869f884d1d979a2db45ffc8245`; host-option fix PR #12952 / `248b1a665b548f32cede407e0fde464371ad4e58` | Useful deployed adjacent implementation and a concrete shared-cgroup-namespace mount-option bug/test | Runtime-wide switch; original gate only checks cgroup v2; test proves `mkdir` but not `nsdelegate`, limits, sibling hiding, or namespace-root protection | Apache-2.0 | `NOT_USED`; retain its bug as a RelayForge regression scenario |
| `opencontainers/cgroups` @ `783139a1555b1fbe9941f1c478651cd7d8718519` | `utils.go` `RemovePath`; `utils_test.go`; `fs2/create.go` | Useful recursive removal/retry and rootless/no-internal-process handling patterns | Cleanup retry coverage is comparatively thin; a fixed roughly one-second retry is not sufficient proof of settlement | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| `containers/bubblewrap` @ `2f55bae38468d0c50cf5df87b1e481e882b63acb` | `bubblewrap.c`; bind operation implementation; `tests/test-run.sh`; FD-bind change `a253257cd298892da43e15201d83f9a02c9b58b5`; cgroup-try fix `5a76f51dc683ec84215836bcb958f3884b3c528e` | Best existing jail primitive here: strict cgroup namespace plus late FD-bound exact subtree; bind implementation verifies inode identity after the mount | It deliberately supplies mechanisms, not delegation policy; cgroup namespace test coverage is sparse | LGPL-2.0-or-later | `NOT_USED` for source; invoke the external program and independently test the composition |
| `kubernetes/enhancements` @ `51353583266ccece601bb590f9f7d2e5e335b39e` | KEP 5474, `keps/sig-node/5474-enable-writable-cgroups`, introduced at `54fe87a97ad84eaf88a77481836c0dd33e8f96c3` / PR #5475 | Strongest threat analysis for writable nested cgroups: explicit opt-in/capability, `nsdelegate`, exhaustion limits, and node-level empirical failure data | As of the inspected revision it is implementable/alpha-targeted, not completed implementation; exact defaults and test checklist remain open | Apache-2.0 | `IDEA_ONLY`; do not represent the KEP as proven implementation |
| `kubernetes/kubernetes` @ `94c136764292cc5fac976c0de6587daaea56410f` | Runtime-feature publication and rejection patterns in `pkg/kubelet/nodestatus/setters.go`, `pkg/kubelet/kuberuntime/helpers.go`, `pkg/kubelet/lifecycle/predicate.go` plus corresponding tests | Mature pattern for structured runtime capability publication and explicit rejection/events | No KEP-5474 `CgroupOptions` implementation or matching tests were found at this revision | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` for capability/error reporting only |
| Linux kernel @ `06cf61899d6498b33e4b7c87d99d5bd471ccc375` | `Documentation/admin-guide/cgroup-v2.rst`; `kernel/cgroup/cgroup.c`; `tools/testing/selftests/cgroup/test_core.c`; `tools/testing/selftests/cgroup/cgroup_util.c` | Normative semantics for `nsdelegate`, namespace roots, no-internal-process, limits, recursive kill, and error behavior; kernel selftests validate namespace boundaries | Not an application architecture; GPL code is not reusable in RelayForge | GPL-2.0-only | `IDEA_ONLY`; implement to documented ABI |

Activity was checked with `git log` or the GitHub commit API, not inferred from star counts. systemd, runc, runtime-spec, containerd, opencontainers/cgroups, Kubernetes, and Linux all had 2026 activity at the inspected heads; Bubblewrap's inspected head was dated 2026-06-02. These are active enough to be current references, while commit pinning keeps the audit reproducible.

Licenses were checked from systemd's `LICENSE.LGPL2.1` and the SPDX headers on every cited systemd file, Bubblewrap's `LICENSE` and `bubblewrap.c` SPDX header, each Apache project's root `LICENSE`, and the Linux source SPDX/license declarations. File-level checks did not reveal a conflicting license on cited implementation files. No `NOTICE` or copyright content was imported because the reuse decisions below do not copy source or tests.

### Pinned source and history locators

- systemd: [`CGROUP_DELEGATION.md`](https://github.com/systemd/systemd/blob/06cb8fbe618604f43c9a9a638e6fc3df920daa0c/docs/CGROUP_DELEGATION.md), [`cgroup-setup.c`](https://github.com/systemd/systemd/blob/06cb8fbe618604f43c9a9a638e6fc3df920daa0c/src/shared/cgroup-setup.c), [`TEST-19-CGROUP.delegate.sh`](https://github.com/systemd/systemd/blob/06cb8fbe618604f43c9a9a638e6fc3df920daa0c/test/units/TEST-19-CGROUP.delegate.sh), [namespace-ordering fix](https://github.com/systemd/systemd/commit/f8f67eab70737549325a718d66c589847043516a), and [restart `EBUSY` fix](https://github.com/systemd/systemd/commit/056bc106e1e344f98cdfa86fdf62e6fed72958c9).
- runtime-spec: [cgroup ownership contract](https://github.com/opencontainers/runtime-spec/blob/6999a89a76a0329f440d5740497bedb9dd431297/config-linux.md#control-groups) and [ownership semantics change](https://github.com/opencontainers/runtime-spec/commit/f4ef3914439ef595fd00c6d0b81753e3463626a3).
- runc: [`cgroup_delegation.bats`](https://github.com/opencontainers/runc/blob/0c87c02ff02123f1bc2cd1b3f850f94e5b8de983/tests/integration/cgroup_delegation.bats), [`process_linux.go`](https://github.com/opencontainers/runc/blob/0c87c02ff02123f1bc2cd1b3f850f94e5b8de983/libcontainer/process_linux.go), [issue #5089](https://github.com/opencontainers/runc/issues/5089), and [its init-cgroup characterization test](https://github.com/opencontainers/runc/commit/1fdbab8107c61876eb69f88730497d250d67e0e6).
- containerd: [current writable-cgroup mount code](https://github.com/containerd/containerd/blob/35f120ed0ae803d16bf92f76f7fe0a2654822e25/internal/cri/opts/spec_linux_opts.go), [current integration test](https://github.com/containerd/containerd/blob/35f120ed0ae803d16bf92f76f7fe0a2654822e25/integration/container_cgroup_writable_linux_test.go), [original PR #11131](https://github.com/containerd/containerd/pull/11131), and [shared-superblock option fix PR #12952](https://github.com/containerd/containerd/pull/12952).
- opencontainers/cgroups: [`utils.go`](https://github.com/opencontainers/cgroups/blob/783139a1555b1fbe9941f1c478651cd7d8718519/utils.go) and [`utils_test.go`](https://github.com/opencontainers/cgroups/blob/783139a1555b1fbe9941f1c478651cd7d8718519/utils_test.go).
- Bubblewrap: [`bubblewrap.c`](https://github.com/containers/bubblewrap/blob/2f55bae38468d0c50cf5df87b1e481e882b63acb/bubblewrap.c), [`test-run.sh`](https://github.com/containers/bubblewrap/blob/2f55bae38468d0c50cf5df87b1e481e882b63acb/tests/test-run.sh), and [FD-bind change](https://github.com/containers/bubblewrap/commit/a253257cd298892da43e15201d83f9a02c9b58b5).
- Kubernetes: [KEP 5474 at the audited revision](https://github.com/kubernetes/enhancements/tree/51353583266ccece601bb590f9f7d2e5e335b39e/keps/sig-node/5474-enable-writable-cgroups), [KEP PR #5475](https://github.com/kubernetes/enhancements/pull/5475), [open origin issue #121190](https://github.com/kubernetes/kubernetes/issues/121190), and [closed containerd request #10924](https://github.com/containerd/containerd/issues/10924).
- Linux: [cgroup-v2 documentation](https://github.com/torvalds/linux/blob/06cf61899d6498b33e4b7c87d99d5bd471ccc375/Documentation/admin-guide/cgroup-v2.rst), [`cgroup.c`](https://github.com/torvalds/linux/blob/06cf61899d6498b33e4b7c87d99d5bd471ccc375/kernel/cgroup/cgroup.c), and [`test_core.c`](https://github.com/torvalds/linux/blob/06cf61899d6498b33e4b7c87d99d5bd471ccc375/tools/testing/selftests/cgroup/test_core.c).

## Evidence from implementation, tests, and bug history

### 1. systemd: delegation is an ownership boundary, not a writable directory

`docs/CGROUP_DELEGATION.md` defines a single-writer model: systemd owns the service/scope boundary and the delegated manager owns only descendants. It expressly warns against creating raw subtrees under arbitrary systemd-managed cgroups. A service or scope must be explicitly delegated. Resource controls at the boundary stay with the host manager.

`src/shared/cgroup-setup.c` implements this boundary in `cg_set_access()`. The fatal ownership operations cover the cgroup directory and the delegation-critical `cgroup.procs` and `cgroup.subtree_control`; optional interface files such as `cgroup.threads`, `memory.oom.group`, and `memory.reclaim` tolerate absence. Its separate `cg_set_access_recursive()` deliberately changes every file in an existing subtree, and the source comment limits that operation to subgroups created below the true delegation boundary. RelayForge should not recursively chown the policy-bearing outer root.

`man/systemd.resource-control.xml` documents `Delegate=` and `DelegateSubgroup=`. `src/core/execute.c` places a service's main process in the configured delegation subgroup while control processes use a separate `.control` subgroup. This reflects the cgroup-v2 no-internal-process constraint and separates manager/supervisor work from payload work.

The integration suite is stronger evidence than the documentation:

- `test/units/TEST-19-CGROUP.delegate.sh` checks controller delegation, the kernel's `/sys/kernel/cgroup/delegate` list, unprivileged delegated scopes, removal of subgroups owned by another UID, `DelegateSubgroup=` ownership (including limit files), and actual membership through `/proc/self/cgroup`.
- `test/units/TEST-07-PID1.protect-control-groups.sh` exercises protected cgroup mounts, `nsdelegate`, and cgroup-namespace-root behavior.

Two recent fixes are directly relevant:

- `f8f67eab70737549325a718d66c589847043516a` (systemd PR #36815) corrected `DelegateSubgroup` plus cgroup-namespace ordering. Moving the process into the subgroup **before** unsharing the cgroup namespace made that subgroup the namespace root. The fix attaches to the main cgroup, creates the namespace, and moves into the subgroup afterward. RelayForge must create its namespace while enrolled in the intended outer boundary; it must not accidentally make a child/payload leaf the boundary.
- `056bc106e1e344f98cdfa86fdf62e6fed72958c9` (systemd PR #41304, issue #41278) addresses restart failure when a delegated payload leaves controllers enabled at the root. A subsequent `clone3(CLONE_INTO_CGROUP)` can return `EBUSY` because domain controllers and an internal process conflict. The final change clears the stale controller state at a deliberate lifecycle boundary rather than silently falling back to the wrong cgroup. RelayForge should never reuse a dirty verifier cgroup; fresh unique roots plus fail-closed recovery are simpler and safer.

**RelayForge implication:** borrow systemd's boundary/descendant ownership and ordering, not its global service-manager machinery. One actor owns each level. A stale or foreign outer root is not reusable.

### 2. runtime-spec and runc: ownership is conditional on a private cgroup namespace

The runtime-spec's `config-linux.md` ownership section applies only to cgroup v2 and pairs three conditions: a new cgroup namespace, a writable cgroup mount, and ownership of only the cgroup directory plus files named in `/sys/kernel/cgroup/delegate` (with the well-known `cgroup.procs`, `cgroup.subtree_control`, `cgroup.threads` fallback). It does not endorse chowning all controller files.

That contract was introduced by runtime-spec change `f4ef3914439ef595fd00c6d0b81753e3463626a3` (PR #1123). Change `600a8bd6d65d9f687310e6f3030c78b4fe946309` (PR #1137, motivated by runc issue #3387) corrected the assumption that every delegated file exists in every cgroup. An absent `memory.oom.group`, for example, is not necessarily a broken kernel. Ignore specifically `ENOENT`; do not swallow unrelated permission or I/O errors.

runc enforces the matrix in `libcontainer/specconv/spec_linux.go`: it sets a cgroup owner only when the container has both a private cgroup namespace and a writable cgroupfs. `tests/integration/cgroup_delegation.bats` protects the cases:

- writable plus private cgroup namespace: ownership delegation occurs;
- read-only plus private namespace: no delegation;
- writable plus inherited host cgroup namespace: no delegation.

The vendored systemd cgroup manager in `vendor/github.com/opencontainers/cgroups/systemd/v2.go` changes the directory and delegation-listed files and tolerates only expected missing files. This is a useful characterization target, not a reason to import the vendored code.

`libcontainer/rootfs_linux.go` mounts a new cgroup2 filesystem when possible, or bind-mounts the exact cgroup path to emulate the cgroup-namespace view. That exact-subtree view is the behavior RelayForge needs. `tests/integration/cgroups.bats` also demonstrates the no-internal-process transition: create a child, move init into it, and only then enable a domain controller in the parent.

runc issue #2356 records why nested domain controllers fail when the cgroup root remains populated. This is not a permissions defect. It is a structural cgroup-v2 rule. P0(2) should not claim domain-controller delegation while Bubblewrap's monitor stays in the boundary root.

runc issue #5089 and its associated current `libcontainer/process_linux.go` behavior expose a path-lifetime trap. A container init allowed to manipulate a writable cgroup hierarchy without a private cgroup namespace could move itself; systemd could remove the configured original cgroup, making later `exec` fail. runc now derives the actual init cgroup for relevant fallback paths. RelayForge should maintain inode-backed identity and refuse stale configured paths rather than assuming a name still denotes the same scope.

The implementation chain is pinned in history: `94133fab970c2ff9011cc9531b7415934b9fcd61` factors actual init membership out of `/proc/<pid>/cgroup`, `1d030fab7dd856c0709e102b61bd1792e85d13d3` applies the fallback to v2 attachment, `6c07a37a585db26a3117683456c9c06f97dc7485` applies it to `CLONE_INTO_CGROUP` FD preparation, and `1fdbab8107c61876eb69f88730497d250d67e0e6` adds the integration characterization. The production fallback is right for runc compatibility; RelayForge's security boundary should instead fail on identity drift.

`libcontainer/init_linux.go` attempts `cgroup.kill` and retains a signal/enumeration fallback. RelayForge has a stronger contract available on its supported cgroup-v2 hosts: require `cgroup.kill` for strong scope capability and use it as the recursive kill primitive, while still using process-group proof as a second independent settlement condition.

### 3. opencontainers/cgroups: recursive removal is retryable, but removal is not proof

`utils.go` `RemovePath()` recursively removes child cgroups and retries an `EBUSY` removal ten times with exponential delay beginning at 1 ms. It treats `ENOENT` as success and reads the directory to distinguish a non-existent path from a read-only/mount-related failure. `utils_test.go` covers the read-only/non-existent edge introduced around issue #4518, but does not comprehensively exercise concurrent forks, namespace-held mount references, or a deep changing tree.

**RelayForge implication:** use post-order recursive removal with bounded rescan/retry, but define success independently: `cgroup.events` must report `populated 0`, the expected inode must be gone, and the process group must be absent. `rmdir` success alone is not process-settlement proof, and a short fixed retry cannot turn `EACCES`, foreign ownership, or persistent `EBUSY` into success.

### 4. Bubblewrap: strict cgroup namespace plus FD-bound exact subtree

`bubblewrap.c` treats `--unshare-cgroup` as a strict request and adds `CLONE_NEWCGROUP`; unsupported kernels fail the launch. `--unshare-cgroup-try` is explicitly opportunistic and may skip isolation. Commit `5a76f51dc683ec84215836bcb958f3884b3c528e` fixed a bug where the try form manipulated the clone flag without correctly recording the option state. For a security boundary, RelayForge must never use the try form.

The audited Bubblewrap head itself, `2f55bae38468d0c50cf5df87b1e481e882b63acb`, adds `--not-a-security-boundary`, which permits selected setup failures to fail open for callers that only want filesystem layout. Its name and commit rationale are an explicit warning: RelayForge must reject this flag in the verifier command just as it rejects the cgroup `-try` form.

Bubblewrap creates the requested namespaces before `setup_newroot`, so the process must already be enrolled in the intended outer cgroup when Bubblewrap creates the cgroup namespace.

The bind implementation is fail-closed by default. Commit `a253257cd298892da43e15201d83f9a02c9b58b5` added `--bind-fd`/`--ro-bind-fd`: Bubblewrap inherits an already-open path FD, resolves it late, mounts it, and compares device/inode identity after the operation to detect a replacement race. `tests/test-run.sh` protects the positive FD-bind path, although no meaningful cgroup-namespace test matrix was found. RelayForge therefore needs its own adversarial integration tests.

A local behavioral experiment on the current host confirmed the mechanics:

- the host cgroup2 mount is writable and includes `nsdelegate`;
- `bwrap --unshare-cgroup` changes `/proc/self/cgroup` to `0::/`;
- binding the **whole** `/sys/fs/cgroup` inside that namespace still exposed host siblings such as `user.slice` and `system.slice`—this is unsafe;
- binding the exact pre-opened outer scope, including with `--bind-fd`, at `/sys/fs/cgroup` exposed only that scope view and allowed a nested child to be created;
- the mounted namespace-root inode matched the pre-opened outer-scope inode;
- even a same-value write to namespace-root `cgroup.max.descendants` was rejected under `nsdelegate`, while writing the child's limit file succeeded.

The experiment used only disposable temporary cgroups and removed them afterward. It validates the key security property: the host fixes the namespace-root limits, the delegate manages only descendants, and no sibling hierarchy needs to be revealed.

### 5. containerd: writable is not the same as safely delegated

containerd implemented writable cgroup mounts in PR #11131, merged as `7c380b9b5057ba869f884d1d979a2db45ffc8245` for containerd 2.1. `internal/cri/config/config.go` exposes a runtime-wide `CgroupWritable`; `internal/cri/opts/spec_linux_opts.go` changes the OCI `/sys/fs/cgroup` mount from `ro` to `rw`; and `internal/cri/server/container_create.go` selects that mount option. The configuration validation rejects cgroup v1.

The added `integration/container_cgroup_writable_linux_test.go` starts real containerd/CRI containers with the flag off and on and checks that `mkdir /sys/fs/cgroup/dummy-group` fails read-only or succeeds. That is valuable integration coverage, but it does not assert a private cgroup namespace, `nsdelegate`, namespace-root write denial, sibling invisibility, maximum depth/descendants, ownership, cleanup, or capability-scoped opt-in.

Current history provides an even stronger warning. PR #12952, merged as `248b1a665b548f32cede407e0fde464371ad4e58`, fixed privileged containers that share the host cgroup namespace. Mounting cgroup2 there with a different option set acted on the shared cgroup2 VFS superblock and could strip host `nsdelegate` and `memory_recursiveprot`. Implementation commit `f84ddfa4fbb9741633bf722ceea943ded2205b15` propagates those host options, and test commit `0eef29a1a92474f9dfb9c21e70790b25221cabdc` verifies that a privileged-container run does not alter them.

**RelayForge implication:** a private cgroup namespace is non-negotiable. Do not borrow containerd's runtime-wide writable toggle or treat a successful child `mkdir` as sufficient isolation evidence. The incident also justifies a regression test proving that a verifier run never changes the host cgroup2 mount's option set.

### 6. Linux: the ABI that the composition depends on

`Documentation/admin-guide/cgroup-v2.rst` is the normative source for these behaviors:

- `nsdelegate` is a cgroup2 mount option controlled from the initial cgroup namespace.
- With a cgroup namespace plus `nsdelegate`, writes to the namespace root are restricted except for files listed in `/sys/kernel/cgroup/delegate`; the mount namespace hides paths outside the namespace root.
- Domain controllers can be enabled only when the relevant parent satisfies the no-internal-process rule. Processes must be moved to children first.
- `cgroup.max.descendants` and `cgroup.max.depth` are hierarchical structural limits; their kernel defaults are effectively unlimited.
- `cgroup.kill` recursively kills the subtree and is designed to handle concurrent forks and migration races better than userspace PID enumeration.

`kernel/cgroup/cgroup.c` initializes the depth/descendant maxima to `INT_MAX`, checks ancestors when creating descendants, and returns `EAGAIN` when a structural maximum would be exceeded. Leaving defaults in place is therefore not safe.

`tools/testing/selftests/cgroup/test_core.c` includes `nsdelegate` and namespace containment cases and skips them explicitly when the mount lacks the capability. `tools/testing/selftests/cgroup/cgroup_util.c` detects the mount option. RelayForge should differ only in product semantics: a missing safety prerequisite is a structured unavailable result and, for verifier-required execution, a pre-spawn refusal—not a silent test skip or weaker production fallback.

### 7. Kubernetes KEP 5474: exhaustion is a node-level security problem

KEP 5474 is in `kubernetes/enhancements/keps/sig-node/5474-enable-writable-cgroups`. At the inspected head it is `implementable`, with alpha targeted for v1.37. It is important design evidence, but it is not yet a source implementation to reuse. Searches of Kubernetes source at `94c136764292cc5fac976c0de6587daaea56410f` found neither the proposed `CgroupOptions` implementation nor matching tests.

The KEP requires explicit opt-in, cgroup v2, a private cgroup namespace, an `nsdelegate` host mount, and a runtime-reported capability. It calls for explicit failure if the requested behavior is unsupported. Review discussion also favors a cgroup namespace as the security contract rather than a collection of file-permission tricks.

Its most valuable evidence is the exhaustion experiment: a container constrained to roughly 128 MiB created about 42,000 sibling cgroups. Container-reported memory rose only modestly, while host slab consumption grew by hundreds of MiB, node available memory collapsed, inotify watch limits were exhausted, and the node became unhealthy. Cgroup metadata is charged and constrained at a different boundary from the attacking process's apparent container memory.

The KEP consequently requires non-default `cgroup.max.descendants` and `cgroup.max.depth` values at the delegated root and proposes tests for unsupported runtimes, escape prevention, and limits. It does not yet settle exact defaults. RelayForge should choose conservative constants in an ADR, expose them to doctor/telemetry, and test the actual `EAGAIN` boundary. Initial engineering values of **256 descendants and depth 16** are reasonable for P0(2), but remain a deliberate RelayForge product choice rather than a number established by Kubernetes.

Kubernetes does already supply a useful adjacent pattern. `pkg/kubelet/nodestatus/setters.go` publishes runtime-reported features, `pkg/kubelet/kuberuntime/helpers.go` translates runtime capabilities, and `pkg/kubelet/lifecycle/predicate.go` explicitly rejects workloads requiring unsupported declared features, with test and event coverage. RelayForge should similarly publish a structured verifier-delegation capability and an actionable refusal reason.

## Best implementation by subproblem

| Subproblem | Strongest reference | RelayForge synthesis |
|---|---|---|
| Host boundary and ownership | systemd | A systemd-created delegated scope is the outer trust boundary. Host owns root policy; verifier owns descendants. Never create arbitrary peer cgroups or reuse a dirty scope. |
| Safe file ownership contract | runtime-spec + runc | If ownership changes are necessary, restrict them to the directory and kernel delegation allowlist, and only with private cgroup namespace plus writable exact-subtree mount. Strong RelayForge scope setup should normally own this before jail launch. |
| Namespace/mount mechanism | Bubblewrap plus runc exact-path mounting | Strict cgroup namespace; exact scope bound from a pre-opened FD to `/sys/fs/cgroup`; never whole hierarchy or original host path. |
| Kernel enforcement semantics | Linux documentation/selftests | Require `nsdelegate`; host sets root structural limits; delegate cannot relax namespace-root policy; child operations remain available. |
| Exhaustion defense and unavailable behavior | Kubernetes KEP 5474 plus existing kubelet feature gating | Explicit capability tuple, fixed structural limits, fail before spawn when requested isolation cannot be provided, and publish operator-visible reasons. |
| Subgroup/process placement | systemd plus runc | Namespace is created at the intended boundary. Separate supervisor/payload siblings are required before promising domain controllers. P0 only promises organizational descendants. |
| Recursive kill/removal | Linux `cgroup.kill`, systemd lifecycle, opencontainers/cgroups retry | Kill recursively; wait for `populated 0`; post-order rescan/remove with bounded retry; verify inode disappearance and PGID death; do not equate cleanup errors with absence. |
| Stale path/recovery | runc issue #5089 plus RelayForge's existing strong-scope journal | Persist inode identity, revalidate before destructive action, never adopt a same-name replacement, and leave unresolved foreign state blocked for operator action. |

## Chosen RelayForge design

### Capability contract

Represent verifier delegation as a single structured capability rather than scattered booleans:

```text
VerifierCgroupJailCapability
  available: boolean
  reasonCode: enum
  detail: string
  cgroupVersion: 2
  mountPoint: /sys/fs/cgroup
  nsdelegate: true
  strictCgroupNamespace: true
  fdBind: true
  strongOuterScope: true
  delegationFiles: string[]
  maxDescendants: 256
  maxDepth: 16
```

The production probe should verify behavior, not just help text or file presence:

- parse mountinfo and prove the exact cgroup2 mount and `nsdelegate`;
- require the strong systemd-backed scope API and its persistent identity journal;
- require `cgroup.kill`, `cgroup.events`, `cgroup.max.descendants`, and `cgroup.max.depth`;
- verify the installed Bubblewrap supports strict `--unshare-cgroup` and `--bind-fd`;
- create one disposable probe scope, set/read limits, enter it, and launch an isolated probe;
- in the probe, require `/proc/self/cgroup` to be `0::/`, root device/inode to match the pre-opened scope, a nested child to be creatable, host siblings to be invisible, and a namespace-root limit write to fail;
- fully settle and remove the probe.

Cache this result per real OS/runtime identity, while keeping the probe injectable in tests. A version/help-text check alone cannot prove that the host mount has `nsdelegate` or that the composed namespace/mount behaves safely.

### Launch ordering and API boundary

Use one centralized headless transport pipeline. Its internal primitive should be conceptually:

```text
openStrongScope()
  -> setAndReadBackStructuralLimits()
  -> openAndVerifyScopeFd(O_PATH|O_DIRECTORY|O_NOFOLLOW)
  -> commandFactory(scopeSandboxHandle)
  -> enrollLauncher()
  -> fsyncEnrollmentJournal()
  -> execBubblewrap()
  -> stream/transcript/settlement/cleanup
```

The command factory receives an opaque sandbox handle containing the inherited FD and verified identity, not the host scope path as caller-controlled text. This preserves existing bounded streaming, transcript, timeout, signal, and settlement semantics and avoids double lifecycle/disposal.

Before `exec`, the shell/launcher writes its own PID to the outer scope, emits the enrollment acknowledgement, and waits until RelayForge has durably recorded it. Only then may it `exec` Bubblewrap. Bubblewrap creates the cgroup namespace while already enrolled in the intended outer root. A failed enrollment or journal fsync must prevent exec.

Bubblewrap argv must contain exactly the strict composition:

```text
--unshare-cgroup
--bind-fd <inherited-scope-fd> /sys/fs/cgroup
```

It must not contain `--unshare-cgroup-try`, `--not-a-security-boundary`, a host cgroup path bind, or a full `/sys/fs/cgroup` bind. `/sys/fs/cgroup` becomes the only cgroup view in the new mount namespace. The general filesystem root remains read-only according to the existing verifier sandbox policy.

### Nested children

The verifier may create children and grandchildren below `/sys/fs/cgroup`, move its spawned workers into them through `cgroup.procs`, and remove them when empty. It cannot modify the host-set namespace-root structural limits under `nsdelegate`.

P0(2) should explicitly document that domain controller enabling at the namespace root can fail while Bubblewrap's monitor remains there. If later phases require per-child `memory.max`, `cpu.max`, or other domain-controller policy, adopt a supervisor sibling plus payload subtree:

```text
outer delegated boundary
├── .supervisor
└── payload
    └── verifier-created descendants
```

That later launcher must preserve the systemd-discovered ordering: create the cgroup namespace at the intended boundary before moving the relevant payload to the leaf, and keep the controller-bearing parent free of internal processes. Do not fake controller availability by swallowing `EBUSY`.

### Cleanup and recovery

Cleanup is an explicit state machine, not a `finally { rmdir }`:

```text
ACTIVE
  -> KILL_REQUESTED       (write cgroup.kill)
  -> DRAINING             (wait cgroup.events populated=0)
  -> REMOVING_DESCENDANTS (post-order rescan/rmdir with bounded retry)
  -> PROVING              (expected inode absent and PGID ESRCH)
  -> SETTLED

Any identity/permission/persistent-I/O failure -> UNRESOLVED_BLOCKED
```

Close the inherited bind FD as soon as the child no longer needs it; otherwise RelayForge itself can prolong a mount reference. Namespace teardown can transiently produce `EBUSY`/`ENOTEMPTY`, so removal should rescan and retry within a bounded deadline. Treat `ENOENT` as success only after identity-aware proof. Treat `EACCES`, `EIO`, unreadable state, a foreign inode, or persistent busy state as unresolved. Never recursively attack a path whose current inode does not match the journal.

Crash recovery loads the unique scope name, original device/inode, and enrolled process metadata from the durable journal. It revalidates the inode before `cgroup.kill` or deletion. A same-name foreign replacement is left untouched and reported as blocked. A dirty prior verifier root is never adopted for a new run.

### Unavailable-capability behavior

Use reason codes such as:

- `NOT_LINUX`
- `CGROUP_V2_UNAVAILABLE`
- `STRONG_SCOPE_UNAVAILABLE`
- `NSDELEGATE_MISSING`
- `CGROUP_KILL_MISSING`
- `STRUCTURAL_LIMITS_MISSING`
- `BWRAP_CGROUP_NAMESPACE_UNAVAILABLE`
- `BWRAP_FD_BIND_UNAVAILABLE`
- `BEHAVIORAL_PROBE_FAILED`

Expose these through doctor output, derived state, and an event with actionable detail. Once P0 removes test skip guards and requires this feature, a real verifier run must refuse **before spawning the verifier** if any required capability is missing. There is no permissive environment override and no silent path to `--unshare-cgroup-try` or path binding. Test-only trusted-runner/import seams may remain injectable but must not be reachable as a production downgrade.

## Traps in the four rejected local attempts

The rejected changes `4620946`, `dab1765`, `4e6b547`, and `5d9d6b3` were inspected with `git show`. None added the behavioral/integration tests required for a security boundary.

Common problems across the attempts:

- They bind a scope directory at its original host path inside Bubblewrap and do not create a cgroup namespace. This supplies a writable directory, not delegated namespace semantics. The verifier can see a host-shaped cgroup path and does not receive namespace-root `nsdelegate` protection.
- They do not verify `nsdelegate`, structural limit files, or fixed `cgroup.max.descendants`/`cgroup.max.depth`. A verifier can exhaust host cgroup metadata even if its own memory is constrained.
- They pass a path rather than a pinned directory FD. Lexical strict-child and existence checks do not prevent replacement between validation and mount.
- They do not prove a fresh, unspawned, RelayForge-owned scope with persistent inode identity. A valid-looking path can refer to stale or foreign state.
- Simply adding `--unshare-cgroup` to the same-path design would still be inconsistent: `/proc/self/cgroup` becomes `/`, while the writable mount remains at a host-derived path. The exact scope must be mounted at canonical `/sys/fs/cgroup` inside the new cgroup namespace.
- Binding the whole `/sys/fs/cgroup` is not a repair. The local probe showed that it reveals host sibling cgroups.
- They do not define cleanup for arbitrary nested children, namespace-held mount references, `EBUSY`, or crash recovery.
- They preserve weak/unavailable behavior even though P0(2) is intended to remove skip guards. Capability absence must become an explicit refusal, not a composition with weaker guarantees.

The `4e6b547` and `5d9d6b3` variants additionally duplicate transport execution and accumulate child output in manual unbounded `Buffer[]` arrays. That bypasses the existing streaming, transcript, settlement, and failure behavior. The `4620946` and `dab1765` variants are closer to the centralized transport but introduce caller-provided lifecycle/double-disposal awkwardness. The safer API is scope-first internal construction followed by a command factory using an opaque, verified sandbox handle.

## Required RelayForge tests

### Characterization and capability tests

- Parse real and fixture mountinfo, including escaped paths and multiple mounts; reject cgroup v1, the wrong mountpoint, and missing `nsdelegate`.
- Treat optional absent delegation files as `ENOENT`; propagate `EACCES`, `EIO`, and unexpected types.
- Prove installed Bubblewrap strict cgroup namespace and FD-bind behavior; help text alone is insufficient.
- Validate the full capability tuple and each unavailable reason without spawning the verifier.

### Launch/isolation tests

- Assert argv contains strict `--unshare-cgroup` and one FD bind to `/sys/fs/cgroup`; assert absence of `-try`, `--not-a-security-boundary`, host path binds, and whole-hierarchy binds.
- Set and read back both structural limits before spawn; any write/read mismatch prevents spawn.
- Recycle the path after opening and prove device/inode mismatch fails closed.
- Inside the jail, assert `/proc/self/cgroup` is `0::/`, the root inode matches the opened scope, sibling host cgroups are invisible, and only the exact delegated tree is available.
- Snapshot the host cgroup2 mount options before/after the run and prove the verifier composition cannot remove `nsdelegate` or other host options.
- Assert namespace-root structural-limit writes fail while child-limit writes succeed.
- Create child and grandchild cgroups, enroll a helper, and observe membership.
- Reach the configured depth and descendant limits and assert creation fails with the expected kernel error (`EAGAIN`).
- Preserve enrollment ordering: enrollment failure means no exec; journal fsync failure means no exec.
- Verify inherited FD closure in parent/error/success paths.

### Lifecycle/failure tests

- Kill a worker that forks while cleanup runs and prove recursive `cgroup.kill` drains it.
- Exercise nested non-empty trees, namespace teardown delay, `EBUSY`, `ENOTEMPTY`, and rescan/retry.
- Treat `ENOENT` idempotently, but leave permission errors and unreadable state unresolved.
- Crash after scope creation, after enrollment, and after Bubblewrap spawn; recover only the exact journaled inode.
- Replace a recorded path with a foreign inode and prove recovery neither kills nor removes it.
- Prove settlement requires both scope disappearance and process-group absence.
- Run all formerly skipped verifier scope tests through the actual Bubblewrap composition. Remove a skip guard only after its real integration test is green.
- Add an explicit controller test documenting P0 behavior: organizational children work; enabling a domain controller at a populated boundary is expected to fail rather than be silently ignored.

## Legal and attribution decision

No code or tests were copied from any reference.

- systemd and Bubblewrap are LGPL projects: use their architecture and invoke Bubblewrap as an external runtime dependency; do not paste implementation code.
- Linux kernel code/selftests are GPL-2.0-only: use only documented ABI semantics and independently authored tests.
- runtime-spec, runc, containerd, opencontainers/cgroups, Kubernetes, and Kubernetes enhancements are Apache-2.0. Direct reuse could be legally possible with notice preservation, but it is unnecessary here. The selected decision is independent implementation informed by behavior and architecture.
- KEP 5474 is research/design evidence, not a finished upstream implementation. RelayForge must not claim Kubernetes compatibility or tested parity based on the KEP alone.

For `docs/upstream-sources.md`, record this subsystem as `ARCHITECTURAL_INSPIRATION` for systemd, runtime-spec, runc, opencontainers/cgroups, and Kubernetes runtime-feature patterns; `IDEA_ONLY` for Linux ABI and KEP 5474; and `NOT_USED` for containerd and Bubblewrap source while noting Bubblewrap's external runtime use. List the commit pins and files from the matrix above.

## Open decisions and confidence

- **Structural-limit constants:** 256 descendants and depth 16 are conservative starting values, not an upstream standard. Ratify them in an ADR with RelayForge workload evidence and make them observable. The verifier must never be able to raise them.
- **Domain controllers:** explicitly deferred from P0(2) unless the launcher is redesigned with supervisor/payload separation and new integration tests.
- **Systemd availability:** the overall P0 strong-scope gate already determines whether a suitable delegated outer scope exists. This audit does not authorize a raw-cgroup fallback.

Confidence is high for kernel/Bubblewrap composition, namespace-root protection, launch ordering, exhaustion defense, and fail-closed behavior because those conclusions agree across Linux documentation/selftests, systemd and runc production fixes, runtime-spec constraints, the Kubernetes experiment, and local behavioral verification. Confidence is medium on exact cleanup retry timings and structural-limit values; both need RelayForge-specific stress data, while their safety invariants are clear.
