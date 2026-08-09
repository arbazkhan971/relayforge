# Integration log

## Discovery

The workspace contained no literal RelayForge source or rename document. Two
independent explorers identified `/home/arbaz/loop-orchestrator` as the only
substantive implementation matching the requested control-plane domain. The
parent verified its roadmap, source/test tree, clean status, and baseline commands.

The current tree is preserved. Existing user commits and branches are not reset or
rewritten. A prunable historical worktree registration and rejected attempt
branches remain evidence and are not deleted.

## Phase 00 synthesis

- Configuration uses strict structured specs:
  `{ path, requiredExecutables? }`; missing configured sources block readiness.
- Integration, isolated attempt, and isolated review worktrees cross the same
  synchronous barrier. A non-isolated review fallback may only reuse an already
  provisioned attempt.
- Copy uses an explicit no-follow walker, pinned source descriptors, exclusive
  staging files, ordinary-mode preservation, inode separation, and relative
  internal-only links. Recursive `cpSync`, hardlinks, dependency-root symlinks,
  package installation, repository scripts, and network access are rejected.
- Publication uses a private same-filesystem transaction area with deterministic
  staging/backup recovery. No consumer runs while a final destination name is
  absent during replacement.
- The initial phase intentionally does not add a package-manager cache/install
  mode. Later content-addressed caching requires its own audit and policy model.

Reference matrix, legal ledger, ecosystem scan, implementation, doctor/config
wiring, and integration/attempt/review E2E coverage are complete. Focused
provisioning verification passes 99/99.

## Baseline failure diagnosis

Both discovery failures passed alone. The 6M-line stream failure was nevertheless
a real product performance defect: `RawFramer` allocated and discarded a 64 KiB
slab for every two-byte frame, producing roughly 366 GiB of allocator churn.
After a source/test/license audit of AO, Codex, Tokio, split2, and Node, RelayForge
now retains one inactive small slab and leases it until the synchronous callback
returns. Allocation characterization is O(1), direct framing is about 7.65x
faster, and the unchanged real-child six-million-frame regression takes 8.75s
with 34.35 MiB RSS growth. The shorter allocator-heavy test also removed the
contention that made the sibling CLI traversal test exceed its unchanged bound.

## P0.2 checkpoint

- The primary and competing coding-agent sandboxes plus systemd, Linux, OCI,
  runc, containerd, Kubernetes KEP 5474, and Bubblewrap were audited at exact
  pins, including tests, failure history, and licenses.
- ADR 001 fixes a verifier-only organizational cgroup boundary with
  `max.descendants=256`, `max.depth=16`, strict namespaces, an exact FD bind,
  pre-exec gate, versioned device/inode/PID-start identity, and fail-closed
  recovery. Domain-controller delegation remains explicitly out of scope.
- The pure policy/protocol kernel is implemented with 33 focused tests covering
  all 15 unavailable reasons, mount/delegation parsing, limits, identity,
  journal/status/gate grammar, state transitions, cleanup, and recovery.
- The host exposes the required cgroup-v2 and Bubblewrap primitives. The real
  behavioral probe, launcher/wiring, and non-skipping nested-suite acceptance
  remain active; no product path advertises availability yet.

## Checkpoint verification

`npm run typecheck`, `npm run build`, and the complete suite pass. The full suite
contains 60 files and 832 tests with zero failures; timeouts and assertions were
not weakened.
