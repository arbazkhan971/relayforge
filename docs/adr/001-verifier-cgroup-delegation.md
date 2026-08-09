# ADR 001: verifier-owned nested cgroup-v2 delegation

- Status: Accepted; implementation not yet landed
- Date: 2026-08-09
- Decision owners: RelayForge maintainers
- Research gate: [Phase 00.2 verifier cgroup delegation audit](../reference/phase-00-2-verifier-cgroup-delegation-audit.md)

## Context

RelayForge already launches provider calls in fresh inode-identified cgroup-v2
scopes and refuses real execution when that strong scope is unavailable. Its
Bubblewrap verifier jail mounts `/` read-only, so tests inside the verifier
cannot create the nested scopes required to exercise provider settlement.

Making `/sys/fs/cgroup` generically writable would break the trust boundary. A
safe verifier must see only its own bounded scope, as the root of a private
cgroup namespace, while the RelayForge parent retains policy, cleanup, journal,
lease, and settlement authority.

## Decision

P0(2) introduces a verifier-only cgroup-jail capability. On a supported Linux
host, the parent creates one fresh outer settlement scope, fixes structural
limits, pins it by directory FD and device/inode, starts a trusted launcher
inside it, journals the exact identity before release, and executes Bubblewrap
with a strict private cgroup namespace and an FD bind of that exact scope at
`/sys/fs/cgroup`.

The jailed verifier may create organizational child and grandchild cgroups,
move its own descendants among them, inspect population, recursively kill them,
and remove them. It may not see a parent/sibling hierarchy, change the root's
parent-owned policy, raise structural limits, receive `CAP_SYS_ADMIN`, or select
the host source path.

P0(2) does not promise domain-controller delegation. Bubblewrap's monitor may
occupy the namespace root, so enabling a domain controller there may correctly
fail under the no-internal-process rule. CPU, memory, swap, pids, cpuset, and I/O
controller policy remain parent-owned. A later controller-delegation design
must use a supervisor/payload topology and a separate ADR.

## Non-negotiable capability contract

The production API is one discriminated capability, not independent booleans:

```text
VerifierCgroupJailCapability =
  | {
      available: false
      reasonCode: VerifierCgroupUnavailableReason
      detail: string
    }
  | {
      available: true
      cgroupVersion: 2
      mountPoint: "/sys/fs/cgroup"
      mountDevice: string
      mountOptions: string[]
      nsdelegate: true
      strictCgroupNamespace: true
      fdBind: true
      strongOuterScope: true
      delegationFiles: string[]
      maxDescendants: 256
      maxDepth: 16
    }
```

`VerifierCgroupUnavailableReason` is the closed enum:

```text
NOT_LINUX
CGROUP_V2_UNAVAILABLE
CGROUP_MOUNT_UNSAFE
STRONG_SCOPE_UNAVAILABLE
NSDELEGATE_MISSING
CGROUP_KILL_MISSING
STRUCTURAL_LIMITS_MISSING
DELEGATION_FILES_UNAVAILABLE
DELEGATION_OWNERSHIP_UNAVAILABLE
BWRAP_UNAVAILABLE
BWRAP_IDENTITY_UNSAFE
BWRAP_CGROUP_NAMESPACE_UNAVAILABLE
BWRAP_FD_BIND_UNAVAILABLE
BWRAP_NAMESPACE_SET_UNAVAILABLE
BEHAVIORAL_PROBE_FAILED
```

The real probe must:

1. parse `/proc/self/mountinfo` correctly, including escaped fields and multiple
   mounts, and identify the cgroup2 superblock containing the process's exact
   `0::` membership;
2. require a writable cgroup-v2 mount with `nsdelegate`, `nosuid`, `nodev`, and
   `noexec`; it must not try to add or change mount options;
3. require the current strong scope contract plus `cgroup.kill`,
   `cgroup.events`, `cgroup.max.descendants`, and `cgroup.max.depth`;
4. load `/sys/kernel/cgroup/delegate`; only `ENOENT` permits the documented
   fallback `cgroup.procs`, `cgroup.subtree_control`, and `cgroup.threads`;
5. prove strict Bubblewrap user, PID, IPC, UTS, network, and cgroup namespaces,
   capability drop, and `--bind-fd` behavior; resolve one canonical executable,
   require it and its ancestors not to be writable by the effective UID, and
   record its device/inode/mtime; command help is insufficient;
6. create a disposable strong scope, set/read both structural limits, pin it,
   run the actual Bubblewrap composition, and prove inside the jail that:
   - `/proc/self/cgroup` is exactly `0::/`;
   - `/sys/fs/cgroup` has the pinned device/inode;
   - a child cgroup can be created and removed;
   - a namespace-root structural-limit write is denied;
   - parent and sibling cgroups are absent;
   - the source FD is absent from the payload's `/proc/self/fd`;
7. fully settle and remove the disposable scope and prove the host cgroup2 mount
   option set is byte-for-byte unchanged.

The result may be cached only by real runtime identity: kernel release, cgroup
mount ID/device/options, Bubblewrap executable device/inode/mtime, and effective
UID/user-namespace mapping. Injected test probes are never globally cached.
Every launch re-stats the canonical Bubblewrap executable before spawn. An
identity or writability change invalidates the cache and refuses that launch
until the complete behavioral probe succeeds again.

## Scope identity and journal contract

New verifier scopes use a versioned identity:

```text
cgroup2v2:<dev-decimal>:<ino-decimal>:<loop-name>:<pid-decimal>:<startticks-decimal>
```

- `loop-name` matches `loop-[0-9a-f]{16}` and is created with exclusive
  `mkdir`; an existing name is never adopted.
- `dev` and `ino` come from `fstat` of the pinned directory FD.
- `pid` is the detached trusted launcher/process-group leader.
- `startticks` is field 22 of `/proc/<pid>/stat`, captured before release.

The settlement receipt and MAC bind this complete v2 identity. The reader may
continue to parse legacy `cgroup2:<ino>:<name>:<pid>` records for conservative
recovery, but new verifier runs never mint them. A legacy record cannot be
upgraded by guessing a device or start time.

Before release, `.loop_scopes` receives one JSONL record and is fsynced. The
formatted example below is serialized on one physical line:

```json
{
  "v": 2,
  "kind": "verifier-cgroup",
  "runId": "<strict id>",
  "attemptId": "<strict id>",
  "leaseId": "<strict id>",
  "scopeId": "cgroup2v2:<dev>:<ino>:<name>:<pid>:<startticks>",
  "maxDescendants": 256,
  "maxDepth": 16
}
```

The record is parent-authored. IDs come from the active run/attempt/lease, not
the verifier. Invalid or truncated JSON is retained as unresolved evidence.
Rewriting the journal after cleanup uses the existing durable temp-file,
fsync, rename, and parent-directory-fsync discipline.

## Structural limits and ownership

The P0(2) constants are:

```text
cgroup.max.descendants = 256
cgroup.max.depth       = 16
```

The parent writes ASCII decimal plus newline through the pinned scope FD before
spawn, reads each file back, trims only ASCII whitespace, parses a canonical
unsigned decimal, and requires exact equality. `max`, overflow, a partial
write, or a readback mismatch refuses launch. These values are RelayForge
initial engineering limits, not Kubernetes defaults. Raising either value
requires workload evidence and an ADR amendment.

The root may inherit resource ceilings from its parent/systemd manager; P0(2)
does not relax them or activate new domain controllers. The verifier cannot
assume that `memory`, `cpu`, `pids`, `io`, or `cpuset` is enabled. An `EBUSY`
from `cgroup.subtree_control` at a populated root is an expected unsupported
operation, not a reason to swallow the error or move the boundary.

The mapped verifier UID must own the delegation directory and only the files
listed by `/sys/kernel/cgroup/delegate`. If existing ownership already grants
the required access, no ownership mutation occurs. Otherwise the parent may
change only that directory and allowlist before spawn. Optional allowlist files
may disappear with `ENOENT`; `EACCES`, `EIO`, wrong file type, symlink, or any
other error refuses launch. The parent never changes ownership of
`cgroup.max.*`, `cgroup.kill`, controller limit files, or resource policy files,
and never recursively chowns the tree.

## FD and gate ABI

The existing pre-exec gate is extended, not replaced. The trusted launcher has
this fixed descriptor ABI:

| Child FD | Direction | Contract |
| --- | --- | --- |
| 0 | parent to child | Verifier stdin or the transport's existing stdin policy |
| 1 | child to parent | Existing bounded stdout/transcript stream |
| 2 | child to parent | Existing bounded stderr/transcript stream |
| 3 | child to parent | Enrollment status; closed before Bubblewrap exec |
| 4 | parent to child | One-shot release gate; closed before Bubblewrap exec |
| 5 | inherited exact scope FD | `O_PATH|O_DIRECTORY|O_NOFOLLOW`; retained through exec only for Bubblewrap `--bind-fd 5`, never inherited by the verifier payload |

The parent retains its own duplicate of FD 5 until proof/cleanup completes. It
checks `fstat` before limit writes, before spawn, after enrollment, and before
every destructive operation. A mismatch enters `UNRESOLVED_BLOCKED`.

The launcher receives a parent-generated 128-bit nonce and performs, in order:

1. `fstat(5)` and compare the expected device/inode;
2. write its own decimal PID to `openat(5, "cgroup.procs")` without following a
   symlink;
3. read back `/proc/self/cgroup` and verify membership at the expected outer
   boundary;
4. write exactly one ASCII status record to FD 3:
   `ENROLLED <pid> <32-lowercase-hex-nonce>\n`, then close FD 3;
5. block on FD 4 and accept exactly `GO\n`; EOF, timeout, extra bytes, or any
   other token exits 126 without executing Bubblewrap;
6. close FD 4 and `execve` Bubblewrap with the fixed composition below.

Status is bounded to 128 bytes. The parent accepts exactly one newline-terminated
record, requires the spawned PID and nonce, validates `/proc/<pid>/stat`
startticks and cgroup membership, appends/fsyncs the journal, and only then
writes `GO\n`. Malformed, duplicate, oversized, early EOF, membership drift,
status timeout, journal append failure, or journal fsync failure closes the gate
without `GO`, recursively reaps the scope, and records a refused launch. The
enrollment/status deadline is 5 seconds.

FD 5 has close-on-exec set everywhere except the single exec into Bubblewrap.
The behavioral probe and integration test must prove Bubblewrap consumes/closes
it before the verifier payload. Any implementation unable to provide these FD
semantics cannot implement this ADR with a path bind instead.

## Exact Bubblewrap contract

For a real verifier, the cgroup/security fragment is mandatory and singular:

```text
--unshare-user
--unshare-pid
--unshare-ipc
--unshare-uts
--unshare-net
--unshare-cgroup
--cap-drop ALL
--bind-fd 5 /sys/fs/cgroup
```

It is applied after the existing `--ro-bind / /` establishes the read-only root
and before `--chdir` and `--`. The exact-scope FD bind is the last mount that
targets `/sys/fs/cgroup`. Generic writable-root processing rejects `/sys`,
`/sys/fs`, `/sys/fs/cgroup`, their descendants, and any symlink/alias resolving
there. The checkout and other existing approved writable roots remain separate.

The following are forbidden in a verifier argv:

```text
--unshare-cgroup-try
--not-a-security-boundary
--bind <host-cgroup-path> ...
--bind /sys/fs/cgroup /sys/fs/cgroup
--ro-bind-fd 5 /sys/fs/cgroup
--share-net
```

RelayForge does not mount or remount cgroup2. It binds the exact existing
subtree and verifies that the host superblock's option set is unchanged. The
jailed canonical cgroup path is only `/sys/fs/cgroup`; the host source path is
not exposed through argv, environment, cwd, procfs FDs, or diagnostics delivered
to the verifier.

## State machine

One verifier scope follows exactly these states:

```text
PROBING
  -> ALLOCATED             fresh empty loop-<hex>; dev/ino known
  -> BOUNDED               both structural limits set and read back
  -> PINNED                parent O_PATH FD retained and revalidated
  -> SPAWNED_GATED         trusted launcher exists; verifier/bwrap do not
  -> ENROLLED              status, pid, startticks, membership verified
  -> JOURNALED             v2 record appended and fsynced
  -> RELEASED              parent wrote the only GO token
  -> ACTIVE                Bubblewrap/verifier transport is running
  -> KILL_REQUESTED        optional TERM grace ended; cgroup.kill requested
  -> DRAINING              waiting for cgroup.events populated 0
  -> REMOVING_DESCENDANTS  post-order rescan/rmdir
  -> PROVING               path identity absent and process group ESRCH
  -> SETTLED               proof minted; journal record discharged
```

Failure transitions are closed:

- A failure in `PROBING` refuses before allocation or spawn.
- A failure in `ALLOCATED`, `BOUNDED`, or `PINNED` closes FDs and removes only
  the still-empty matching scope; failure to remove is
  `UNRESOLVED_BLOCKED`.
- A failure in `SPAWNED_GATED`, `ENROLLED`, or `JOURNALED` closes FD 4 without
  `GO`, then enters `KILL_REQUESTED`. No verifier or Bubblewrap may execute.
- A transport failure after `RELEASED` is an uncertain verifier result and
  enters the same cleanup path; it never authorizes fallback until settlement
  proof exists.
- From any state, identity drift, unreadable state, `EACCES`, `EIO`, persistent
  `EBUSY`/`ENOTEMPTY`, malformed durable evidence, or cleanup deadline expiry
  transitions to `UNRESOLVED_BLOCKED`.
- `UNRESOLVED_BLOCKED` is terminal for automatic dispatch. It retains the
  journal record and requires recovery or operator action; it is never mapped
  to `SETTLED` by time, retry count, or best effort.

There is at most one in-flight cleanup promise per scope. Timeout,
cancellation, output/framing failure, normal close, and run teardown join that
promise rather than stacking kill sequences.

## Cleanup contract

Cleanup uses these fixed phases and deadlines:

1. If the live leader still has matching startticks, send `SIGTERM` to its
   process group and allow 5 seconds for cooperative exit. PID/starttime drift
   suppresses this courtesy signal; it does not affect cgroup kill.
2. Revalidate FD device/inode and the current path. If the path is absent,
   continue to proof. If it exists with another device/inode, do not touch it
   and enter `UNRESOLVED_BLOCKED`.
3. Write `1\n` to `cgroup.kill` through the pinned directory. `ENOENT` proceeds
   to identity-aware proof; any other write error is retained and cleanup may
   not settle unless later proof independently establishes absence.
4. Poll `cgroup.events` every 25 ms for at most 5 seconds and require a uniquely
   parsed `populated 0`. Missing/malformed/unreadable events are not emptiness.
5. Close the child-side mount-FD duplicate and wait for Bubblewrap namespace
   teardown. Post-order enumerate only directory entries beneath the pinned
   root and `rmdir` deepest-first. Rescan/retry for at most 5 seconds, using
   delays 1, 2, 4, 8, 16, 32, 64, then 100 ms capped. Never follow symlinks or
   cross a device boundary.
6. Prove the journaled path is absent without observing a replacement object,
   the pinned object's link state is consistent with removal, and the original
   process group returns `ESRCH`. Only then mint
   `cgroup2v2-empty:<scopeId>+pgid-empty:ESRCH:<pid>`.
7. Close the parent's pinned FD, durably discharge the journal record, and enter
   `SETTLED`.

`ENOENT` is idempotent success only during steps 3–6 when the earlier pinned
identity exists in durable evidence and the remaining proof conditions pass.
`rmdir` success by itself, a delivered signal, a dead leader, or elapsed time is
never settlement proof.

## Crash recovery contract

Recovery runs after the process has acquired the exclusive run lease and
before any new provider/verifier dispatch:

1. Read every journal line. Retain and block on malformed, truncated, unknown,
   and legacy records that cannot be safely resolved.
2. Resolve the current strong-scope root from mountinfo and `/proc/self/cgroup`.
   Locate only the strict recorded `loop-<hex>` child.
3. If absent, require the recorded process group to be absent before discharging
   it as `gone`. Never signal a recovered PID merely because the number exists.
4. If present, compare device and inode to the v2 record. A mismatch is
   `foreign`: do not signal, kill, chown, recurse, or remove it.
5. For a match, run cleanup beginning at `KILL_REQUESTED` without adopting the
   tree for new work. Recovery uses `cgroup.kill`, not a possibly recycled PID.
6. Durably rewrite the journal with only unresolved records. A dirty old root is
   never reused, even if empty; it is removed and a new random root is created
   for a later run.

The unjournaled crash window is safe because the gate has not released an
untrusted process: parent death closes FD 4, the launcher exits without exec,
and only an empty randomly named cgroup can remain. The stale sweeper may remove
such an unreferenced empty scope after its existing age threshold, but it never
kills a populated or identity-conflicting scope.

## Platform and unavailable-capability behavior

- Linux with the complete behavioral capability: run using this contract.
- Linux missing any required property: return the stable reason code, emit a
  red doctor/event result, and refuse before verifier spawn.
- macOS, Windows, cgroup v1, nested environments without `nsdelegate`, and
  Bubblewrap builds lacking any required strict operation: typed unsupported
  and pre-spawn refusal.
- There is no production environment override, `-try` option, path-bind
  fallback, raw-cgroup fallback, controller-disable fallback, or execution
  outside containment.
- The import-only trusted-runner and injected OS adapters remain test seams.
  Production CLI/config cannot activate them. Tests for unsupported platforms
  assert the refusal rather than pretending to exercise delegation.
- The CI job designated `verifier-cgroup-required` (name may vary by CI
  provider) treats missing advertised capability as failure, not skip. Other
  platform jobs may pass only by asserting the exact unsupported result and
  proving no verifier spawned.

## Observability

Doctor and parent-owned events report capability availability, reason code,
structural limits, selected delegation files, state transitions, and cleanup
outcome. Details may include the host cgroup path for a trusted local operator,
but verifier prompts, argv, environment, transcripts exposed to agents, and
provider-visible events must contain only the opaque scope ID.

No settlement receipt is issued from verifier-authored output. The existing
parent-owned transport, scope, ledger, and settlement kernel remain the only
authorities.

## Consequences

This design permits the real nested provider/settlement suites to run inside
the verifier jail while preserving the outer settlement object. It also makes
Linux cgroup v2 plus strict Bubblewrap a hard requirement for real verifier
execution after P0(2); unsupported hosts fail honestly rather than running a
weaker gate.

The cost is Linux-specific FD/mount parsing, a stricter launcher ABI, versioned
journal migration, and real privileged-enough CI. Structural limits constrain
pathological or unusually deep test topologies. Domain-controller-based child
resource policy remains deferred.

## Implementation acceptance gates

Implementation cannot integrate until:

1. the supported Bubblewrap/kernel matrix proves the exact FD bind, namespace
   root, monitor/payload placement, root-write denial, sibling hiding, FD
   closure, and unchanged host mount options;
2. the actual formerly skipped nested provider/settlement suites fit within 256
   descendants and depth 16;
3. journal v2 migration, crash points at every state, foreign-inode recovery,
   and all cleanup error classes pass deterministically;
4. the required Linux job contains no capability skip and tests committed HEAD;
5. source, tests, and user/operator documentation land together. Removing a
   skip before its corresponding jailed test passes is prohibited.

If gate 1 or 2 fails, implementation stops and this ADR is amended. It does not
switch to path binding, whole-hierarchy exposure, opportunistic cgroup
namespaces, larger unmeasured limits, or controller disablement.
