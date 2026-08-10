# Integration log

## Discovery

The workspace contained no literal RelayForge source or rename document. Two
independent explorers identified this repository (`loop-orchestrator` product
tree) as the only substantive implementation matching the requested
control-plane domain. The parent verified its roadmap, source/test tree, and
baseline commands.

The current tree is preserved. Existing user commits and branches are not reset
or rewritten. A prunable historical worktree registration and rejected attempt
branches remain evidence and are not deleted.

**Handoff checkpoint:** branch `agent/loop-engineering-hardening`; product
integration commit `5880b008d81c20f746f728ef83d736306d546d81` and verified
release-smoke baseline `198aa44a192848fe6df1b6f4033e5f6bffc62d89`. Runtime proof
commit `cf87abfee5426178e8883c176b66032631ada9ca` (`cf87abf`) holds exact
required-cgroup smoke, packed artifact, and real-browser proof; the final
handover is docs-only after that and changes no runtime code. The previous
remote documentation handoff was `860688c55207be051431d470b44b038025a12e5c`.
Live tracker:
[docs/implementation-status.md](../../../docs/implementation-status.md).

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
provisioning verification passes **99/99**.

## Baseline failure diagnosis

Both discovery failures passed alone. The 6M-line stream failure was nevertheless
a real product performance defect: `RawFramer` allocated and discarded a 64 KiB
slab for every two-byte frame, producing roughly 366 GiB of allocator churn.
After a source/test/license audit of AO, Codex, Tokio, split2, and Node,
RelayForge now retains one inactive small slab and leases it until the
synchronous callback returns. Allocation characterization is O(1), direct
framing is about 7.65x faster, and the unchanged real-child six-million-frame
regression takes 8.75s with 34.35 MiB RSS growth. The shorter allocator-heavy
test also removed the contention that made the sibling CLI traversal test exceed
its unchanged bound.

## P0.2 checkpoint

- The primary and competing coding-agent sandboxes plus systemd, Linux, OCI,
  runc, containerd, Kubernetes KEP 5474, and Bubblewrap were audited at exact
  pins, including tests, failure history, and licenses.
- ADR 001 fixes a verifier-only organizational cgroup boundary with
  `max.descendants=256`, `max.depth=16`, strict namespaces, an exact FD bind,
  pre-exec gate, versioned device/inode/PID-start identity, and fail-closed
  recovery. Domain-controller delegation remains explicitly out of scope.
- The pure policy/protocol kernel is implemented with focused tests covering
  unavailable reasons, mount/delegation parsing, limits, identity,
  journal/status/gate grammar, state transitions, cleanup, and recovery.
- The real Linux adapter, authenticated FD3/4/5 launcher, runtime-identity cache,
  shared bounded verifier transport, v2 journal/recovery, doctor reporting and
  `/sys` writable-root denial are integrated. Availability is published only
  after the disposable behavioral probe passes.
- Required-host characterization passed **21/21**. The production jail ran
  **46/46** transport/launch/settlement tests and **193/193** streaming,
  fallback, receipt, resume, cost, ledger and containment tests with zero skips.
  Exact descendant/depth boundaries fail with `EAGAIN`; no process or cgroup
  leaked.

## P1–P6 product checkpoints (committed and product-integrated)

| Phase | Status | Evidence |
| --- | --- | --- |
| P1 durable control plane | implemented | focused **210/210** |
| P2 session steering | implemented | CLI live E2E **1/1**; adjacent **25/25**; exact cgroup/no-leak proof |
| P3 SCM machinery | product-integrated | focused **155/155**; explicit SCM/P6 publication config drives recoverable publication, parent polling, and reaction-to-P2 |
| P4 adapter registry | implemented (release receipts open) | OpenCode, Pi, and Grok contained production characterization paths are **implemented and fixture-backed** (Pi/Grok no longer typed-unavailable); focused adapter/egress matrix **127/127**; real same-runner release receipts **not collected** and still require designated runner + exact binary + live credential; ordinary OpenCode/Pi/Grok **refuse before** run/control/worktree mutation; publish path **fail-closed** until distinct same-runner receipts |
| P5 control room | implemented | focused **125/125** |
| P6 multi-repository | **product-integrated** | strict config/validation, actual CLI run route, canonical ControlStore facts/views, exact repository-set authority, DAG and scheduler, all-or-nothing worktree group, worker/verification through canonical contained transport and settlement, vector integration, publication bridge, exact read isolation, durable crash recovery, real product E2Es; authority **21/21**; orchestration **12/12**; product/recovery/verifier **6/6**; publication/SCM/integration **13/13** |

## P7 / release checkpoint (local committed gates green on runtime proof `cf87abf`)

- Identity and package candidate `relayforge@1.0.0-rc.1` foundations are present.
- Characterization / fix chain: `ee93223`, `de23f74` (Pi), `82c6b32`,
  `a8433de` (Grok), `1d365fc`, `b940624`, `cf87abf`; final handover is docs-only
  after the runtime proof and changes no runtime code.
- **Required-cgroup aggregate: GREEN** — **171** test files, **1,957** tests
  passed, then clean TypeScript build. Environment: Node
  **v20.20.2**, npm **10.8.2**, Linux **6.17.0-1021-gcp**, bwrap **0.9.0**.
- **Required-cgroup source smoke: GREEN on runtime proof `cf87abf`** — exact
  marker `SMOKE PASS (contained host — verified delivery on the run branch)`;
  execute completed; feature stayed on the run branch; original checkout
  unchanged.
- **Exact preview artifact: GREEN on runtime proof `cf87abf`** — deterministic
  `relayforge-1.0.0-rc.1.tgz`, **1,645,603** bytes, SHA-256
  `92020efe10080fe617151a1af093f41c0bd953d43d1aa3fbeeb51df7919147ff`. Deep
  smoke: clean lifecycle-script install, better-sqlite3 native binding load,
  public ESM and external TypeScript consumer, forbidden authority exports,
  canonical init/dry run, legacy `loop.config` plus existing `.loop` adoption,
  control service start/status/stop, packed Markdown link closure, unchanged
  checkouts.
- **Packed real-browser gate: GREEN on runtime proof `cf87abf`** on Google
  Chrome **150.0.7871.128** — schemaVersion 1, packageName relayforge, version
  1.0.0-rc.1, fixtureRun browserfixture, DOM rendered, lifecycle
  **connected → degraded → recovered**, serviceReplaced true.
- Preview defects fixed: implementation-only better-sqlite3 types no longer leak
  into public declarations; smoke harness asynchronously runs `serve stop` to
  reap the owned service child; legacy `.loop` fixture adopts the directory init
  may already create; close-membership drain race fixed on `b940624`
  (focused **60/60**).
- Product integration and the committed local rerun are complete. Status:
  local-engineering-complete; native-release-receipts-open; characterization
  done for all three.
- **No** tag, npm publish, GitHub release, repository rename, or real native
  receipt has been performed (receipts **not collected**).

## Verification note

Historical Wave-0 full-suite checkpoint (832/832 across 60 files) is not the
current P0–P7 claim. The current local result is the committed required-cgroup
aggregate **171** / **1,957** plus clean build, source smoke, exact tarball and
Chrome lifecycle on runtime proof `cf87abf`. Publication still requires real
native same-runner receipts (not collected). Resume from
[docs/implementation-status.md](../../../docs/implementation-status.md).
