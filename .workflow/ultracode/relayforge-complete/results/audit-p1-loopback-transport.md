# P1 loopback control-plane transport reference audit

Date: 2026-08-09
RelayForge pin inspected: [`arbazkhan971/loop-orchestrator@997763e3d5e019b737ab704e69ec11a34c7c3592`](https://github.com/arbazkhan971/loop-orchestrator/tree/997763e3d5e019b737ab704e69ec11a34c7c3592)
Scope: lifecycle ownership, private run-file discovery, loopback-only read transport, redaction, SSE replay/reconnect, dashboard/CLI clients, diagnostics, and implementation partitioning. Research/design only: no product source, tests, documentation, dependency manifest, or attribution ledger was changed.

## Executive decision

RelayForge should ship one long-lived, foreground-by-default `loop serve` process per loaded configuration. It owns the control-store writer, dashboard, read-only REST API, and SSE broadcaster. It binds the IPv4 loopback literal `127.0.0.1` only. P1 must not add a remote bind option, a bearer-token mode, or any HTTP mutation. `loop stop` remains the parent-owned run cancellation path; it must not be routed through this listener.

Discovery requires three agreeing signals, none sufficient alone:

1. a crash-released lifetime lease held on a stable control file;
2. a private, bounded, atomically and durably published `serve.json` containing a fresh random `instanceId`, PID, process-incarnation token, bound port, stable configuration identity, and schema/service tags; and
3. a bounded loopback `/api/v1/health` response that echoes the non-secret identity fields exactly.

The lease is authority for single ownership. The run-file is discovery, not a lock. PID existence is only a diagnostic hint. A client attaches only when the lease is held and the run-file and health identities agree; `serve stop` additionally requires the recorded process-incarnation token to match the live process before sending a signal. A successor removes or replaces no stable lock inode, and removes `serve.json` only while it still owns the lease and only if the file still names its `instanceId`.

Use the P1 durable-state packet's run-scoped SQLite canonical event sequence directly. SSE identity is `(runEpoch, seq)`, where `seq` is the committed canonical event sequence; the transient broadcaster never mints another counter. The stream registers a bounded/coalescing wake-up before it captures the replay head, reads durable events through that head, maps them to allowlisted read-model notifications, then catches up again. A notification loss is harmless; a durable cursor gap, expired cursor, replay budget excess, or slow socket produces an explicit resync/close, never silent partial authority.

REST and SSE share one DTO and redaction layer. They expose run summaries, board views, pure derived activity, and bounded diagnostics—not configuration objects, environment values, raw canonical payloads, arbitrary files, prompts, transcripts, or unrestricted tmux output. Redaction is defense in depth after an allowlist; it is not permission to serialize an object graph and hope a regex removes every secret. Read failures return typed, generic errors rather than the current dashboard's plausible empty fallback.

The best reference is a composition, not a port:

- Agent Orchestrator supplies the closest end-to-end shape: loopback-only daemon, run-file plus health/ready attachment, thin CLI, durable replay before live SSE, reconnecting browser transport, and tests for replay/live overlap.
- kcap supplies the strongest lifetime-owner model: a kernel-released lock held for the process lifetime, stable lock inode, fresh instance identity, PID plus process-start token, serialized starts, and read-only doctor classification.
- Kubernetes supplies the strongest cursor contract: monotonically advancing version, explicit expired-history/relist behavior, bounded watch history, and termination of unresponsive watchers rather than blocking publishers.
- Qwen Code supplies the strongest small-daemon resource bounds: strict cursor parsing, epoch mismatch/resync, synchronous subscription before replay, event and byte budgets, subscriber caps, and deterministic slow-client eviction.

No upstream source, test, comment, schema, or distinctive structure should be copied. The design below is an independent RelayForge implementation governed by local invariants. kcap's non-standard Kurrent License makes its use strictly conceptual.

## Required local invariants and non-goals

The Wave 2 authority is [`ROADMAP-AO-PARITY.md`](../../../../ROADMAP-AO-PARITY.md), lines 84-98: add a loopback-only `loop serve` with a secure run-file/ownership handshake and doctor diagnostics; add read-only runs, board, activity, and redacted-diagnostics REST; make a CLI path consume the server end to end; and add reconnect/replay SSE with a board-update-to-client integration test. The daemon remains the parent-owned writer, the unauthenticated listener remains loopback-only, and display status remains derived rather than stored.

This audit treats the companion [`audit-p1-durable-state.md`](./audit-p1-durable-state.md) as the storage boundary: one serialized daemon writer, run-scoped canonical events, `runEpoch`, transactionally assigned `seq`, `headSeq`, `floorSeq`, pure activity with `viewSeq`, typed `CURSOR_EXPIRED`, and no P1 canonical-prefix deletion. Transport must consume that contract rather than invent a memory-only event identity.

Hard boundaries for P1:

- `loop serve` is a local control-plane process, not a remotely reachable service. No `0.0.0.0`, wildcard, LAN, Unix-account-sharing, proxy, TLS, or auth mode is included.
- The HTTP surface is `GET`/`HEAD` only. `POST`, `PUT`, `PATCH`, `DELETE`, upgrade/WebSocket, and `/shutdown` return `405` with `Allow: GET, HEAD` where the route exists.
- `loop run`, `loop stop`, agent input, claims, settlements, config writes, tmux creation/kill, and recovery repairs remain outside REST/SSE.
- This audit does not create a second mutation ingress. When `loop serve` is the orchestrator parent, its in-process typed control-store interface is the only writer; HTTP/dashboard handlers never open another writable handle. During the durable-state cutover, a compatibility CLI may own a store only under that packet's exclusive run lease and only after proving no control daemon owns it. Any future cross-process command IPC requires a separate protocol/authority decision.
- A loopback response is still data disclosure to local software. DTO allowlists, exact project/run/session ownership, byte bounds, no-store headers, strict Host/Origin handling, and redaction remain mandatory.
- SSE is delivery, not authority. Clients rebuild from REST/store projections after cursor expiry, server restart mismatch, or any detected uncertainty.
- P1 does not background-fork itself. `loop serve` runs in the foreground and handles SIGINT/SIGTERM; an operator may supervise it with the shell or an OS service manager. This avoids inventing log rotation, orphan reaping, and service installation in the same packet. `loop serve status` and `loop serve stop` provide discovery and bounded shutdown for a separately supervised instance.
- P1 does not enable event prefix GC. The floor/expiry protocol is implemented and tested now so later retention cannot silently change reconnect semantics.

## Audit method and exact reference set

The local source, tests, history, root license, roadmap, and companion durable-state audit were read. Each upstream was inspected at the exact immutable commit below, including implementation, focused tests, architecture/design text, relevant history and issue/PR discussion, and root license material.

| Repository | Exact pin inspected | Why selected | License finding | Reuse class |
|---|---|---|---|---|
| RelayForge | [`997763e3d5e019b737ab704e69ec11a34c7c3592`](https://github.com/arbazkhan971/loop-orchestrator/commit/997763e3d5e019b737ab704e69ec11a34c7c3592), 2026-08-09 | Local authority and integration target | MIT, copyright 2026 Loop Orchestrator contributors | `NOT_USED` as an upstream; local implementation baseline |
| Untrivial Agent Orchestrator | [`f65c48e296e20a816221a4003c75a5f0387967ec`](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec), 2026-08-09 | Closest complete local daemon + CLI + REST + durable SSE + browser reconnect implementation | Apache-2.0; root `LICENSE`, copyright appendix “Copyright 2026 Untrivial”; no root `NOTICE` at the pin | `ARCHITECTURAL_INSPIRATION` |
| kurrent-io/kcap-cli | [`b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7`](https://github.com/kurrent-io/kcap-cli/tree/b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7), 2026-08-08 | Strongest crash-released daemon ownership, process identity, serialized start, and doctor behavior | Kurrent License v1: source-available, non-sublicensable/non-transferable and hosted/managed-service restricted | `IDEA_ONLY`; zero copying |
| Kubernetes | [`94c136764292cc5fac976c0de6587daaea56410f`](https://github.com/kubernetes/kubernetes/tree/94c136764292cc5fac976c0de6587daaea56410f), 2026-08-08 | Mature list/watch cursor expiry, bounded history, retry classification, and slow-watcher policy | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| Qwen Code | [`3e731cda8b073d058d8970ae8ffbfdc58021faba`](https://github.com/QwenLM/qwen-code/tree/3e731cda8b073d058d8970ae8ffbfdc58021faba), 2026-08-09 | Best focused SSE queue/replay byte bounds, epoch reset, strict cursor parsing, and SDK framing tests | Apache-2.0; SPDX headers copyright 2025 Qwen Team | `ARCHITECTURAL_INSPIRATION` |
| Daintree, screened out as a primary | [`a5c2dae192f18378e80b97d378f6015f8eda45d7`](https://github.com/daintreehq/daintree/tree/a5c2dae192f18378e80b97d378f6015f8eda45d7) | Strong loopback Host/Origin validation and response byte caps, but Electron-owned MCP lifecycle and protocol SSE do not solve run-file discovery or durable replay | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| better-sqlite3, shared P1 runtime dependency | published [`v12.11.1 / 4cbc39ca582fecb6b51dd920dfdd338ba4b72230`](https://github.com/WiseLibs/better-sqlite3/tree/4cbc39ca582fecb6b51dd920dfdd338ba4b72230); later unpublished v12.12.0 was also inspected | Node 20-compatible adapter selected by the durable-state audit; provides the local SQLite engine used by the lifetime lease | MIT | `NOT_USED` for source copying; exact runtime dependency selected separately |

Daintree was not promoted into the strongest three because its `/sse` is MCP transport state, not a replayable durable activity feed, and Electron owns discovery/lifetime. Stagewise was not selected because its browser/dev-server integration is weaker evidence for run-file ownership and durable watch recovery than kcap, Kubernetes, or Qwen. The comparison set was chosen per subsystem quality, not repository popularity.

## RelayForge current-state evidence

### What is already correct

[`src/dashboard/server.ts`](../../../../src/dashboard/server.ts) hardcodes `DASHBOARD_HOST = "127.0.0.1"`, filters sessions by exact stamped `project` identity, accepts only `GET`/`HEAD`, validates run IDs, bounds timeline count to 500, redacts configuration and captured logs, returns `404` for unknown API paths, and sets `no-store`, `nosniff`, frame, referrer, and CSP headers. [`tests/dashboard-security.test.ts`](../../../../tests/dashboard-security.test.ts) pins traversal rejection, config/log secret masking, the project-name-prefix ownership regression, method rejection, invalid-run `400`, unknown API `404`, and response headers. [`tests/dashboard.test.ts`](../../../../tests/dashboard.test.ts) starts a real child, proves a loopback API response, rejects malformed/zero/out-of-range ports, and reports `EADDRINUSE` cleanly.

The private-state substrate is stronger than the dashboard uses. [`src/runtime.ts`](../../../../src/runtime.ts) provides `readStateFile()` checks for no-follow regular single-link private same-owner leaves and `writeStateFileDurable()` with exclusive private temp creation, file fsync, atomic rename, and directory fsync. [`src/flock.ts`](../../../../src/flock.ts) provides a Linux util-linux `flock` bridge and a real survival/conflict/release probe; [`tests/ledger-transaction.test.ts`](../../../../tests/ledger-transaction.test.ts) demonstrates much deeper crash and publication fault injection than the current dashboard suite. Those are local precedents for failure discipline, though the P1 service lease must have a cross-platform implementation or explicitly fail closed on an unsupported host.

[`src/doctor.ts`](../../../../src/doctor.ts) is side-effect-free inspection for the relevant checks, and [`tests/doctor.test.ts`](../../../../tests/doctor.test.ts) establishes that every non-OK result carries a substantive fix and overall failure matches the presence of a failing check. The new control-plane checks must preserve that contract.

### Gaps that P1 must close

[`src/dashboard/server.ts`](../../../../src/dashboard/server.ts) is a one-shot listener with no lifetime lease, run-file, instance identity, readiness state, bounded attach probe, shutdown ownership, or stale-file diagnosis. It exposes an entire recursively redacted project configuration at `/api/config`; allowlisting the necessary public fields is safer and smaller. Its `safe()` wrapper converts every read exception into a plausible empty board/timeline/overview, which hides corruption and recovery-required state from operators.

[`src/dashboard/render.ts`](../../../../src/dashboard/render.ts) performs five requests every 2.5 seconds forever. It has no durable cursor, replay, connection state, resync, abort cleanup, or bounded retry. [`src/monitor.ts`](../../../../src/monitor.ts) independently polls local board/tmux state every 1.5 seconds. [`src/cli.ts`](../../../../src/cli.ts) implements `status` by reading tmux directly and `stop` by writing cancellation state and killing exactly owned sessions; no CLI command proves run-file discovery and HTTP DTO compatibility end to end.

The current free-text redactor covers secret-shaped assignments and several token prefixes, and the config redactor masks `env` values and secret-shaped string keys. It does not define a response-wide depth/property/string/byte bound; Authorization/Cookie/URL-userinfo/query-secret/PEM/path cases; structured non-string secret values; cyclic values; or one shared final pass for REST errors, diagnostics, and SSE. Redaction tests use a few positive examples rather than a sentinel corpus across every output channel.

[`src/board.ts`](../../../../src/board.ts) supplies neither durable sequence nor replay floor today, and `compactBoard()` is not a usable SSE cursor boundary. The companion durable-state design replaces that authority. Transport work must depend on its event-range and pure-view interfaces, not tail the JSONL files or assign timestamps/counters in the HTTP process.

Relevant local history: [`af9e3976ff639d6605213bafc6aa8d9e8c3dcc26`](https://github.com/arbazkhan971/loop-orchestrator/commit/af9e3976ff639d6605213bafc6aa8d9e8c3dcc26) extracted the dashboard server factory; [`d077adae4c995127a657563bc2b6b6c66d8f02f7`](https://github.com/arbazkhan971/loop-orchestrator/commit/d077adae4c995127a657563bc2b6b6c66d8f02f7) added the mission-control UI; [`576770b89591a8421401c585eb236ce6cc6a10b2`](https://github.com/arbazkhan971/loop-orchestrator/commit/576770b89591a8421401c585eb236ce6cc6a10b2) hardened orchestration/dashboard behavior; and the pinned `997763e...` phase-zero work strengthened state/doctor foundations. P1 should evolve these seams rather than add a parallel, inconsistent server.

## Primary reference: Untrivial Agent Orchestrator

### Source and tests inspected

Lifecycle and discovery:

- [`backend/internal/config/config.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/config/config.go)
- [`backend/internal/httpd/server.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/httpd/server.go)
- [`backend/internal/runfile/runfile.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/runfile/runfile.go) and [`runfile_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/runfile/runfile_test.go)
- [`backend/internal/daemon/daemon.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/daemon/daemon.go) and [`stale.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/daemon/stale.go)
- [`frontend/src/shared/daemon-attach.ts`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/frontend/src/shared/daemon-attach.ts) and [`daemon-attach.test.ts`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/frontend/src/shared/daemon-attach.test.ts)
- [`backend/internal/daemon/supervisor`](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/daemon/supervisor)

Events and clients:

- [`backend/internal/httpd/events.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/httpd/events.go) and [`events_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/httpd/events_test.go)
- [`backend/internal/cdc/event.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/cdc/event.go), [`poller.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/cdc/poller.go), and [`broadcast.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/cdc/broadcast.go)
- [`frontend/src/renderer/lib/event-transport.ts`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/frontend/src/renderer/lib/event-transport.ts) and [`event-transport.test.ts`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/frontend/src/renderer/lib/event-transport.test.ts)
- [`docs/cli/README.md`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/docs/cli/README.md)

### Findings

AO hardcodes `127.0.0.1`; the daemon cannot configure a non-loopback host. It binds before publishing `running.json`, writes the run-file with sibling-temp replacement, probes `/healthz` and `/readyz`, and makes the CLI a thin daemon client rather than a second database/runtime implementation. The attach code rejects missing/malformed/dead-PID run-files, PID disagreement between file and health, foreign service identity, and not-ready instances. A direct expected-port probe is a backstop when the file is absent or stale.

The run-file has useful fields—PID, port, start time, owner, app run identity, and a non-secret browser-runtime locator—and `RemoveIfOwned` prevents one PID from removing a successor's file. Its tests cover overwrite, missing/idempotent removal, successor protection, and live/dead PID classification. However, the file directory is created `0750`, reads are ordinary pathname reads, publication does not fsync file/directory, removal identity is PID only, and `CheckStale` is process-existence based. AO compensates at the caller with a bounded loopback health/PID/service probe. It still has no lifetime filesystem owner lease, and PID-only cleanup remains weaker than a random instance plus exact incarnation.

AO's SSE controller registers the live subscriber before replay, uses durable `change_log.seq`, replays in batches of 512, holds a 1024 live channel, drops duplicate live/replay overlap by `seq <= sentSeq`, sanitizes CR/LF from event names, and cancels a slow stream rather than blocking the broadcaster. `after` or `Last-Event-ID` is parsed as a non-negative integer. Tests prove subscription precedes replay, invalid cursor rejection, event-name sanitation, overlap deduplication, and `Last-Event-ID: 7` resumption at sequence 8. The browser uses native `EventSource`, relies on browser resume while `CONNECTING`, explicitly retries a terminal `CLOSED` source, rebuilds on base-URL/port changes, and refetches the full view on every open.

The limitation is important: AO has a durable source but no general retained-floor/expired-cursor or replay-byte budget on this route. Its channel is bounded by frame count, not bytes. Its whole API includes mutations, and its health response may expose executable/working paths. RelayForge should adopt the race-free replay and thin-client shape, not AO's API breadth, health fields, or PID-only ownership.

Relevant evolution: [`59a654afeabf7665f1af1403f00bb7a528ba7a8c`](https://github.com/Untrivial-ai/agent-orchestrator/commit/59a654afeabf7665f1af1403f00bb7a528ba7a8c) introduced the HTTP daemon skeleton; [`a9b08cd368f8aa0e0b57d727d86e4a03ec1488ec`](https://github.com/Untrivial-ai/agent-orchestrator/commit/a9b08cd368f8aa0e0b57d727d86e4a03ec1488ec) added SSE replay; and [`cbd2a1babace8ab9a0f5145069463e370920a991`](https://github.com/Untrivial-ai/agent-orchestrator/commit/cbd2a1babace8ab9a0f5145069463e370920a991) added attach-to-existing behavior. [PR #2185](https://github.com/Untrivial-ai/agent-orchestrator/pull/2185) records the OS-native client-liveness link and its reconnect grace, and [PR #2847](https://github.com/Untrivial-ai/agent-orchestrator/pull/2847) separates persistent/headless daemon lifetime. These histories show why owner/liveness semantics must be explicit rather than inferred from “process exists.”

## Strong reference 1: kcap daemon ownership

### Source and tests inspected

- [`src/Capacitor.Cli.Daemon/DaemonLock.cs`](https://github.com/kurrent-io/kcap-cli/blob/b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7/src/Capacitor.Cli.Daemon/DaemonLock.cs)
- [`src/Capacitor.Cli.Core/DaemonLockPaths.cs`](https://github.com/kurrent-io/kcap-cli/blob/b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7/src/Capacitor.Cli.Core/DaemonLockPaths.cs)
- [`src/Capacitor.Cli.Core/ProcessStartToken.cs`](https://github.com/kurrent-io/kcap-cli/blob/b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7/src/Capacitor.Cli.Core/ProcessStartToken.cs)
- [`src/Capacitor.Cli/Commands/DaemonCommands.cs`](https://github.com/kurrent-io/kcap-cli/blob/b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7/src/Capacitor.Cli/Commands/DaemonCommands.cs)
- [`test/Capacitor.Cli.Tests.Unit/Daemon/DaemonLockTests.cs`](https://github.com/kurrent-io/kcap-cli/blob/b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7/test/Capacitor.Cli.Tests.Unit/Daemon/DaemonLockTests.cs), [`DaemonLockPriorInstanceIdTests.cs`](https://github.com/kurrent-io/kcap-cli/blob/b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7/test/Capacitor.Cli.Tests.Unit/Daemon/DaemonLockPriorInstanceIdTests.cs), and [`DaemonLockAwaitTests.cs`](https://github.com/kurrent-io/kcap-cli/blob/b90b59ee53baf854cb8c2afa48ae49c3ef0cb8a7/test/Capacitor.Cli.Tests.Unit/Daemon/DaemonLockAwaitTests.cs)

### Findings

kcap opens a stable per-name lock with exclusive OS sharing semantics and holds the handle for the daemon lifetime. The kernel releases it on normal exit, crash, SIGKILL, or power loss; stale file presence does not block. Startup reads the previous bounded lock content only after acquiring ownership, writes a fresh GUID instance ID, and records PID plus a platform process-start token. The token uses Linux boot ID plus `/proc/<pid>/stat` start ticks, a macOS boot/session identity plus process unique ID, or Windows start time. PID plus token distinguishes a recycled PID from the recorded incarnation.

A separate start lock serializes “inspect stale state then spawn” so two CLIs cannot both observe absence and launch. Shutdown deletes PID/version markers before releasing the lifetime lock and never deletes the stable lock path: unlinking a locked inode can let a concurrent opener lock a new inode at the same pathname. Doctor is read-only by default, attempts the lock to classify `HELD` versus `STALE`, and only cleans markers explicitly while holding the same lock. Tests cover same-name contention, different-name coexistence, re-acquisition after exit, lock-file persistence, successor PID protection, stale PID after unclean exit, bounded wait, and corrupt/indeterminate predecessor identity.

This directly exposes AO's missing primitive and RelayForge's required rule: a PID file is not a lease, and an `O_EXCL` artifact is not crash-released. [Issue #457](https://github.com/kurrent-io/kcap-cli/issues/457) provides a concrete negative case: a durable “active in another PID” owner marker survives SIGKILL and permanently prevents reconnect. Relevant implementation history includes [PR #147](https://github.com/kurrent-io/kcap-cli/pull/147) / commit [`a76fdfdd64eff99545f2ac4cdd1e1780c5a7240b`](https://github.com/kurrent-io/kcap-cli/commit/a76fdfdd64eff99545f2ac4cdd1e1780c5a7240b) for Linux PID identity, [PR #243](https://github.com/kurrent-io/kcap-cli/pull/243) / [`011f480f3e805d5413c6326f8db1e17b67fe2d6c`](https://github.com/kurrent-io/kcap-cli/commit/011f480f3e805d5413c6326f8db1e17b67fe2d6c) for silent daemon-death evidence, and [PR #347](https://github.com/kurrent-io/kcap-cli/pull/347) / [`f15c15227e02d589772e23514a07d0d5ff19c9cd`](https://github.com/kurrent-io/kcap-cli/commit/f15c15227e02d589772e23514a07d0d5ff19c9cd) for sequencing and fail-closed prior-instance handling.

Legal boundary: the Kurrent License v1 is not approved as a source-copy basis for RelayForge. Only the generic principles—crash-released lifetime lease, stable inode, exact process incarnation, serialized starts, and inspect-before-clean—are used. No kcap code, tests, comments, names, or file layout should be copied.

## Strong reference 2: Kubernetes watch and cursor recovery

### Source and tests inspected

- [`staging/src/k8s.io/client-go/tools/watch/retrywatcher.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/client-go/tools/watch/retrywatcher.go) and [`retrywatcher_test.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/client-go/tools/watch/retrywatcher_test.go)
- [`staging/src/k8s.io/apiserver/pkg/storage/cacher/watch_cache_history.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apiserver/pkg/storage/cacher/watch_cache_history.go) and [`watch_cache_test.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apiserver/pkg/storage/cacher/watch_cache_test.go)
- [`staging/src/k8s.io/apiserver/pkg/storage/cacher/cache_watcher.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apiserver/pkg/storage/cacher/cache_watcher.go) and [`cache_watcher_test.go`](https://github.com/kubernetes/kubernetes/blob/94c136764292cc5fac976c0de6587daaea56410f/staging/src/k8s.io/apiserver/pkg/storage/cacher/cache_watcher_test.go)

### Findings

`RetryWatcher` records the last delivered resource version and recreates a watch from that cursor after EOF/timeout/recoverable failures. It advances the cursor on data and bookmarks, does not forward bookmarks as domain changes, and applies a minimum non-sliding restart delay to prevent a hot loop. It stops on errors that would make continuing misleading, notably an in-stream `410 Gone` for history no longer available. Its own documentation states that a retry wrapper is not enough when the cache has lost the requested version; the client must relist.

The watch cache is a bounded cyclic history. It evicts the oldest event when full and rejects a cursor below the oldest retained boundary with typed `ResourceExpired`; it does not return a plausible suffix. Per-watcher input/result channels are bounded. An unresponsive watcher is closed rather than allowing publisher progress to block indefinitely; bookmark-aware draining exists only to preserve a useful resume point.

[Issue #90058](https://github.com/kubernetes/kubernetes/issues/90058) and [PR #91822](https://github.com/kubernetes/kubernetes/pull/91822) explain the move toward bounded dynamic history rather than one magic capacity. [Issue #102718](https://github.com/kubernetes/kubernetes/issues/102718) records a real list/watch loop caused by a too-old resource version and demonstrates that reconnect without an explicit relist path is not recovery.

RelayForge should adopt the observable contract, not Kubernetes machinery: a cursor has a retained floor; expired means full snapshot/relist; recoverable transport failures retry with delay; a slow client is disconnected; and a notifier never blocks a writer. Kubernetes' cache, selectors, distributed API semantics, and dynamic resizing are unnecessary for a single-host P1 whose canonical SQLite history is retained in full.

## Strong reference 3: Qwen Code bounded SSE

### Source and tests inspected

- [`packages/acp-bridge/src/eventBus.ts`](https://github.com/QwenLM/qwen-code/blob/3e731cda8b073d058d8970ae8ffbfdc58021faba/packages/acp-bridge/src/eventBus.ts) and [`eventBus.test.ts`](https://github.com/QwenLM/qwen-code/blob/3e731cda8b073d058d8970ae8ffbfdc58021faba/packages/acp-bridge/src/eventBus.test.ts)
- [`packages/cli/src/serve/routes/sse-events.ts`](https://github.com/QwenLM/qwen-code/blob/3e731cda8b073d058d8970ae8ffbfdc58021faba/packages/cli/src/serve/routes/sse-events.ts)
- [`packages/cli/src/serve/sse-last-event-id.ts`](https://github.com/QwenLM/qwen-code/blob/3e731cda8b073d058d8970ae8ffbfdc58021faba/packages/cli/src/serve/sse-last-event-id.ts) and [`sse-last-event-id.test.ts`](https://github.com/QwenLM/qwen-code/blob/3e731cda8b073d058d8970ae8ffbfdc58021faba/packages/cli/src/serve/sse-last-event-id.test.ts)
- [`packages/cli/src/commands/serve.ts`](https://github.com/QwenLM/qwen-code/blob/3e731cda8b073d058d8970ae8ffbfdc58021faba/packages/cli/src/commands/serve.ts)
- [`packages/sdk-typescript/src/daemon/sse.ts`](https://github.com/QwenLM/qwen-code/blob/3e731cda8b073d058d8970ae8ffbfdc58021faba/packages/sdk-typescript/src/daemon/sse.ts), [`RestSseTransport.ts`](https://github.com/QwenLM/qwen-code/blob/3e731cda8b073d058d8970ae8ffbfdc58021faba/packages/sdk-typescript/src/daemon/RestSseTransport.ts), and focused SDK tests

### Findings

Qwen's per-session event bus gives ordinary events monotonic IDs, keeps a bounded replay ring, registers a subscriber synchronously before replay, and gives each subscriber a bounded frame and byte queue. It caps subscribers and replay bytes. A slow subscriber receives an id-less terminal/control frame and is removed; synthetic private frames do not consume the shared event sequence. A reconnect whose epoch mismatches, cursor comes from an impossible future, ring has lost a prefix, seeded history is unavailable, or replay budget is exceeded receives `state_resync_required` instead of a false caught-up signal. Tests exercise monotonic IDs, replay/live order, ring and epoch reset, replay budget, frame/byte overflow, sibling subscriber survival, abort cleanup, and strict cap accounting.

The cursor parser accepts decimal digits only and rejects values beyond `Number.MAX_SAFE_INTEGER`; the epoch token is length/character bounded. The SDK parser handles LF/CRLF, comments, decoder tail, aborting a parked read, malformed frames, and an accumulated-buffer cap. `qwen serve` defaults to `127.0.0.1` and has a listener connection cap. [Issue #3803](https://github.com/QwenLM/qwen-code/issues/3803) is the daemon proposal and records Last-Event-ID/ring replay as a staged design; [issue #4175](https://github.com/QwenLM/qwen-code/issues/4175) tracks the production-readiness gaps; [PR #4236](https://github.com/QwenLM/qwen-code/pull/4236) records the loopback boot gate.

Qwen's in-memory epoch/ring is not RelayForge authority: a daemon restart resets it and forces a full reload. RelayForge already needs durable `runEpoch` and `seq`, so it should use those. Its events also carry richer session payloads and its API permits mutations/authenticated non-loopback use; neither belongs in P1. The useful transplant is policy—strict cursors, byte as well as frame bounds, synchronous registration, explicit resync, and cleanup—not code or constants.

## Supporting comparison: Daintree loopback HTTP

At [`a5c2dae...`](https://github.com/daintreehq/daintree/tree/a5c2dae192f18378e80b97d378f6015f8eda45d7), [`electron/services/mcp-server/httpLifecycle.ts`](https://github.com/daintreehq/daintree/blob/a5c2dae192f18378e80b97d378f6015f8eda45d7/electron/services/mcp-server/httpLifecycle.ts) binds `127.0.0.1`, checks exact loopback Host/Origin values, and enables DNS-rebinding protection in its SSE/HTTP transports. [`toolCallResult.ts`](https://github.com/daintreehq/daintree/blob/a5c2dae192f18378e80b97d378f6015f8eda45d7/electron/services/mcp-server/toolCallResult.ts) and [`toolCallResult.test.ts`](https://github.com/daintreehq/daintree/blob/a5c2dae192f18378e80b97d378f6015f8eda45d7/electron/services/mcp-server/__tests__/toolCallResult.test.ts) enforce exact byte caps on text/structured output. [`readinessProbe.ts`](https://github.com/daintreehq/daintree/blob/a5c2dae192f18378e80b97d378f6015f8eda45d7/electron/services/mcp-server/readinessProbe.ts) uses per-request and hard readiness timeouts.

Those are good confirmation for exact loopback admission and byte-bounded output. Daintree is not the lifecycle/replay authority here: the Electron main process owns the service, its legacy SSE is MCP session transport rather than durable version replay, and the surface is intentionally mutating/authenticated. It remains a supporting Apache-2.0 reference only.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| RelayForge `997763e` | Foreground dashboard, loopback guards, ownership filters, GET/HEAD routes, polling client, and local tests | Strong local safety baseline and integration target | No lifetime identity or durable replay; DTO and byte/socket bounds incomplete | MIT | `NOT_USED` as an upstream; preserve/refactor the local baseline |
| Untrivial Agent Orchestrator `f65c48e` | Long-lived daemon, run-file/health discovery, thin CLI, durable SQLite sequence, subscribe-before-replay, overlap dedupe, reconnect, and bounded live queues | Strongest complete coding-agent daemon/SSE lifecycle | Broad mutation API; run-file is not lifetime authority; no explicit byte/floor contract | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| kurrent-io/kcap-cli `b90b59e` | Crash-released OS lifetime lock, start serialization, PID/start-token identity, foreground/service modes, and doctor tests | Strongest daemon ownership and incarnation characterization | Source-available license; not a REST or durable replay design | Kurrent License v1 | `IDEA_ONLY`; zero copying |
| Kubernetes `94c1367` | Watch-cache cursor expiry, retry watcher, bounded history/channels, and slow-consumer policy | Strongest mature cursor-floor/resync semantics | Distributed resource API; cache is not RelayForge's canonical authority | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| Qwen Code `3e731c` | Loopback SSE with strict cursors, epoch/ring/budget resync, frame/byte/subscriber/socket/parser caps, and client tests | Strongest focused transport-bound and control-frame evidence | Memory ring and wider mutation/auth surface; no RelayForge run-file identity | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| Daintree `a5c2dae` | Loopback Host/Origin admission, readiness timeout, request/output byte caps, and focused tests | Strong narrow admission and output-bound evidence | Electron-owned MCP mutation lifecycle and protocol SSE are not durable run replay | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| better-sqlite3 `12.11.1` / `4cbc39c` | Synchronous SQLite transaction and local locking engine used by P1 | Exact Node 20-compatible published runtime dependency | Does not define RelayForge lifecycle, schema, durability, or recovery policy | MIT | `NOT_USED` for source copying; exact runtime dependency selected separately |

## Consequential design comparisons

### Run-file versus ownership

| Option | Crash behavior | Concurrent start | PID reuse | Decision |
|---|---|---|---|---|
| File presence / `O_EXCL` marker | Artifact survives crash and needs stale-breaking policy | Can serialize creation, but stale recovery introduces races | Commonly trusts PID | Reject as lifetime authority |
| PID plus health only (AO) | Stale file can be ignored after bounded probe | Same-port bind prevents many duplicates, but no stable per-config lease | Health/PID reduces but does not eliminate incarnation ambiguity | Useful discovery, insufficient owner proof |
| Held OS lock (kcap/local flock) | Kernel releases on close/process death | Exact; second holder cannot acquire | PID irrelevant to lease | Correct semantic model |
| Dedicated SQLite `BEGIN IMMEDIATE` lease | SQLite/OS releases write lock when connection dies; hot journal recovery is built in | Exactly one write transaction; contender gets `SQLITE_BUSY` | PID irrelevant to lease | Chosen cross-platform implementation using the already-selected P1 SQLite adapter |

The dedicated lease database is separate from every run store: `<root>/.loop/control/<configId>/serve-lock.sqlite`, rollback journal mode, stable path, never unlinked. Initialize and verify its tiny schema, set `busy_timeout=0`, then hold `BEGIN IMMEDIATE` for the service lifetime. The official [SQLite transaction documentation](https://www.sqlite.org/lang_transaction.html) specifies that only one write transaction may exist and `BEGIN IMMEDIATE` fails with `SQLITE_BUSY` when another writer exists; closing/crashing rolls the transaction back. The [SQLite locking documentation](https://www.sqlite.org/lockingv3.html) describes the OS-specific locking and rollback-journal recovery model. Use a local filesystem only—SQLite explicitly warns that advisory locking may be unreliable on network filesystems. If the adapter, lock semantics, file identity, or local-filesystem assumption cannot be proven, `loop serve` fails closed. The Linux-only proven [`src/flock.ts`](../../../../src/flock.ts) remains valid local precedent but should not become a silent non-Linux artifact-lock fallback.

### Raw objects versus public DTOs

| Option | Failure mode | Decision |
|---|---|---|
| Serialize project/store objects and recursively redact | New fields become public by default; regex misses types/forms; response can grow without bound | Reject |
| Allowlist DTO only | New internal fields remain private until intentionally mapped | Required first layer |
| Final bounded recursive redaction | Catches secret-shaped data accidentally placed in allowed free text/diagnostics | Required second layer |
| Return empty view on read error | Corruption looks like “no work,” preventing recovery | Reject; return typed error/recovery state |

### Memory event bus versus durable cursor

| Option | Restart | Missed notification | Retention | Decision |
|---|---|---|---|---|
| Poll-only dashboard | Eventually refreshes but has no freshness/replay contract | Invisible | N/A | Compatibility fallback only |
| Memory sequence/ring | Epoch reset forces full reload | Ring can replay briefly | Fixed in-memory horizon | Not authoritative |
| Durable event `seq` plus live wake-up | Same run epoch resumes across service restart | Durable query catches up | Explicit `floorSeq`; typed expiry | Chosen |

The live broadcaster carries only “there may be work after sequence N.” It may coalesce notifications into a one-slot dirty flag per subscriber. It never carries the sole copy of an event and never blocks the writer. This is smaller and stronger than queueing every event payload: after any wake, the stream reads the next durable range from `sentSeq`.

## Chosen design

### Best implementation discovered

Agent Orchestrator supplies the strongest end-to-end daemon/SSE shape; kcap the
strongest crash-released owner identity; Kubernetes the strongest durable
cursor-expiry behavior; Qwen the strongest focused bounds; and Daintree the
strongest narrow loopback admission checks.

### Why

Each implementation protects a different boundary. None proves RelayForge's
required conjunction of kernel-released lifetime ownership, private discovery,
GET/HEAD-only DTOs, canonical `(runEpoch, seq)` replay, explicit cursor floor,
encoded-byte bounds, and fail-closed process-incarnation signaling.

### What RelayForge will reuse

`ARCHITECTURAL_INSPIRATION` from Agent Orchestrator, Kubernetes, Qwen, and
Daintree; `IDEA_ONLY` ownership concepts from kcap. The local RelayForge
baseline is refactored in place. No upstream source, tests, constants, or
distinctive structure are copied.

### What RelayForge will change

The run-file becomes discovery only; a stable crash-released SQLite lease is
lifetime authority; public HTTP is versioned GET/HEAD only; DTOs are allowlisted
and byte-bounded; replay is durable with typed floor expiry; and slow clients
close without blocking the writer.

### How RelayForge will improve it

RelayForge binds lease, private run-file, health, process start token, run epoch,
and durable sequence; subscribes before capturing replay head; recovers missed
wakes from storage; exposes explicit resync; and shares redaction, connection,
replay, parser, response, and drain limits across server and clients.

### Service identity and paths

`configId = hex(sha256("relayforge-config-v1\0" + realConfigPath + "\0" + realRootDir))`. It is a locator/fencing identity, not a secret and not a digest of mutable config contents. A config edit must not create a second owner identity. The control directory is `<rootDir>/.loop/control/<configId>/`, created/tightened to `0700`, with every descendant component verified as a real same-owner directory and no-follow/pinned creation where the platform supports it. P1 files:

| File | Mode/bound | Purpose |
|---|---|---|
| `serve-lock.sqlite` plus SQLite journal auxiliaries | private; stable; never manually deleted | Lifetime owner lease only |
| `serve.json` | `0600`, regular, one link, same owner, maximum 8 KiB | Discovery handshake |

No token, environment value, config path, workspace path, prompt, tmux output, or store path is written to `serve.json`.

Run-file schema:

```json
{
  "schemaVersion": 1,
  "service": "relayforge-control",
  "instanceId": "32-byte-random-hex",
  "configId": "sha256-hex",
  "pid": 12345,
  "processStartToken": "platform-specific-private-token",
  "host": "127.0.0.1",
  "port": 4318,
  "startedAt": "RFC3339 UTC"
}
```

Unknown fields are rejected in P1 rather than preserved. Every integer/string has an exact type/range/length. `host` must equal the literal. `processStartToken` remains private to the file and stop client; health does not echo it.

### Commands

- `loop serve`: start in the foreground, print the loopback URL and instance prefix after readiness publication, and wait for SIGINT/SIGTERM.
- `loop serve status [--json]`: read and validate the private run-file, prove that the lifetime lease is held, perform a bounded health handshake, then consume `GET /api/v1/status` and render that exact DTO. This is the mandatory CLI-to-one-endpoint integration path.
- `loop serve stop`: perform the same discovery handshake, verify the live process-incarnation token, send the platform graceful termination signal, and wait at most 5 seconds for lease release/run-file disappearance. It never calls HTTP mutation, never signals on partial identity, and does not escalate to SIGKILL in P1.
- `loop dashboard`: compatibility alias that uses the same server/lifecycle and UI, not a second HTTP implementation. Its existing `--project` becomes the initial UI selection. A conflicting `--port` is deprecated; the configured `dashboardPort` is the one advertised owner endpoint.

Do not add detach/service installation in this packet. An OS service manager may run the same foreground command. A later detach packet must separately design log ownership/rotation, readiness handoff, and orphan recovery.

### Startup ordering

1. Load/validate configuration and derive stable `configId`; create and verify the private control directory and bounded existing run-file shape.
2. Open/verify the stable lease DB and attempt `BEGIN IMMEDIATE` with no wait.
3. If busy, read `serve.json` and probe `/api/v1/health` for at most 2 seconds with 200 ms retry. Report `already-ready`, `owner-starting`, or `owner-held-unhealthy`; do not steal, unlink, kill, or overwrite.
4. Once the lease is held, inspect any prior `serve.json`. It is stale evidence now. Record an in-memory unclean-predecessor diagnostic, but do not trust or signal its PID.
5. Open/verify all run stores read-only/read-write as the daemon's single writer, build DTO/read-model dependencies, create the HTTP server, and bind exactly `127.0.0.1:<configured dashboardPort>`. An occupied port is fatal and releases the lease; no ephemeral or “next free” fallback is allowed because discovery must be deterministic.
6. Generate `instanceId`, capture the exact process start token, and atomically/durably publish `serve.json` only after the listener is bound.
7. Flip in-memory readiness to true only after store validation/recovery checks and run-file publication. `/health` may answer during startup only after bind; `/status` and data routes return typed `503 NOT_READY` until ready.

There is no window in which a published run-file points to an unbound port. A crash before publication leaves only a released lease. A crash after publication leaves a stale run-file, but the released lease lets the successor prove ownership and replace it.

### Attach and signal handshake

Attachment is a bounded double-collect, not “read file, trust port.” The client reads and validates run-file snapshot A, performs a nonblocking lease probe that must report `SQLITE_BUSY`, fetches the advertised health response within the 2-second total budget, then rereads run-file snapshot B and repeats the nonblocking lease probe. A and B must be byte-equivalent canonical records, both probes must prove the lifetime transaction remains held, and health must exactly match `schemaVersion`, `service`, `instanceId`, `configId`, `pid`, `host`, `port`, and `startedAt`. Otherwise the client classifies the state and refuses attachment; the start command may retry only within its bounded publication window.

Before `loop serve stop` signals, it obtains the live platform process-start token and compares it to the private run-file token immediately after the final A/B/health check. It signals only that exact incarnation. A released lease, changed run-file, failed/ambiguous token lookup, or health mismatch is a refusal, never permission to kill or clean. This ordering prevents a successor publication or PID reuse between discovery and the destructive act from inheriting the predecessor's authority.

### Shutdown ordering

1. Mark not-ready and stop admitting new non-health requests/SSE clients.
2. Emit an id-less `control.closing` where the socket is writable, then close SSE and stop accepting connections.
3. Allow in-flight GET/HEAD responses up to 5 seconds; abort the rest.
4. Flush/close the control stores.
5. While the lifetime lease is still held, reread the bounded run-file and unlink it only if `service`, `configId`, and `instanceId` still match. Directory-fsync the removal where supported; a failure is logged but does not justify deleting another file.
6. Roll back/close the lease connection last, releasing ownership.

An uncaught startup/runtime failure follows the same best-effort cleanup, but correctness does not depend on it: process death releases the lease and a successor treats the run-file as stale.

## Read-only REST contract

All product routes are under `/api/v1`. Every response uses `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and the existing restrictive CSP for HTML. No CORS allow header is emitted. Requests require a loopback Host value matching the actual port; an `Origin`, when present, must be the same loopback origin. Unknown API routes return typed `404`; a known resource outside the loaded configuration returns `404`, not existence-leaking detail.

Canonical endpoints:

| Endpoint | Bounded response | Purpose |
|---|---|---|
| `GET /api/v1/health` | 4 KiB | `{schemaVersion, service, instanceId, configId, pid, status:"ok"|"starting", startedAt}`; no paths/process token |
| `GET /api/v1/status` | 256 KiB | Service readiness plus allowlisted project/latest-run/session summaries; consumed by `loop serve status` |
| `GET /api/v1/runs?project=&limit=&cursor=` | 1 MiB, default 25, max 100 | Stable run summaries ordered by durable identity/time with opaque bounded page cursor |
| `GET /api/v1/runs/:run?project=` | 256 KiB | Run facts and freshness cursor; no raw config/path/prompt |
| `GET /api/v1/runs/:run/board?project=` | 2 MiB | Allowlisted task board projection and `{runEpoch, viewSeq, headSeq, floorSeq, stale}` |
| `GET /api/v1/runs/:run/activity?project=&after=&limit=` | 2 MiB, default 100, max 500 | Pure derived activity rows, ordered by durable `seq`, with cursor/freshness metadata |
| `GET /api/v1/runs/:run/diagnostics?project=&session=&lines=` | 256 KiB, default 160, max 500 | Curated checks and bounded, redacted tail for an exact stamped owned session |
| `GET /api/v1/runs/:run/events?project=&runEpoch=&after=` | SSE bounds below | Durable view-change stream |

IDs use existing strict canonical validation before path resolution. Query strings, header values, and URL length are bounded before parsing. `limit`, `after`, `lines`, and port values use full-string decimal parsing and safe-integer/range checks—never `parseInt` prefix acceptance or `Number(...) || default`. Page cursors are versioned, length-bounded opaque values authenticated only for integrity if needed; invalid/foreign cursors return `400`, never silently restart at page one.

Success envelopes use stable versioned DTOs. Errors use a generic bounded shape:

```json
{"error":{"code":"CURSOR_EXPIRED","message":"The requested activity history is no longer retained.","requestId":"...","details":{"floorSeq":41,"headSeq":90,"snapshotSeq":40}}}
```

Only explicitly allowlisted numeric/enum recovery details appear. Internal exception strings, SQL, filesystem paths, config values, request header values, and captured output never enter HTTP errors. Store corruption/recovery-required is a typed `503`, not an empty successful board.

Server bounds chosen for P1 and asserted as constants:

- 64 total TCP connections and 32 concurrent SSE clients;
- 8 KiB request-target and 8 KiB cumulative relevant-header limit at the application gate;
- 5 second header/request admission timeout and 5 second graceful-drain timeout;
- exact endpoint response byte ceilings above, measured on final UTF-8 JSON before headers are sent;
- diagnostics maximum 500 lines and 256 KiB after redaction/truncation;
- no compression in P1, avoiding buffering and size ambiguity on a local small surface.

If a response cannot fit, return typed `413 RESPONSE_TOO_LARGE` before writing a partial JSON body. HEAD runs the same authorization/lookup/status logic and headers but writes no body.

## Redaction contract

Redaction order is fixed:

1. Build a route-specific DTO from explicit field names and primitive/closed child DTOs. Internal objects are never spread into output.
2. Normalize public IDs/enums/timestamps and replace path fields with purpose labels or project-relative display paths only where the schema explicitly permits them.
3. Run a shared bounded deep-redactor over every REST success, REST error detail, SSE data frame, and diagnostic log fragment.
4. Serialize once, measure exact UTF-8 bytes, and enforce the route cap.

The deep-redactor:

- masks every value, regardless of primitive type, beneath keys matching an anchored set for `authorization`, `cookie`, `apiKey`, `token`, `secret`, `password`/`passwd`, `credential`, `privateKey`, and `clientSecret`; every value under an `env` map is masked;
- replaces Authorization/Proxy-Authorization/Cookie header text, Bearer/Basic credentials, PEM private-key blocks, URL userinfo, secret-shaped URL query values, secret assignments, and known provider/GitHub/Slack token forms in free text;
- replaces the configured root, config path, home directory, worktree roots, run/store paths, and absolute platform paths in diagnostics with stable placeholders before truncation;
- is iterative/cycle-aware and caps depth, object keys, array length, individual strings, and total nodes; truncation inserts an explicit marker rather than silently dropping;
- never logs the rejected raw value. Diagnostic logs use a sanitized/truncated rendering.

SSE frames contain only an enumerated notification type and an allowlisted small payload such as `{project, run, taskId?, runEpoch, seq, headSeq, viewSeq}`. They never serialize the canonical event payload, message body, task description, prompt, transcript, provider response, config, or log tail. A client fetches the corresponding redacted REST view.

Mandatory redaction canaries seed a unique sentinel into every secret/config/env/path/prompt/message/transcript/log/error location, traverse every endpoint plus SSE replay and live frames, and assert the sentinel and its URL/base64/JSON-escaped forms are absent. Tests also prove legitimate public fields survive so “redact everything” cannot pass.

## SSE replay, reconnect, and backpressure

### Wire contract

The route is run-scoped. Every ordinary frame is:

```text
id: 42
event: control.changed
data: {"v":1,"type":"control.changed","project":"demo","run":"run-1","runEpoch":"...","seq":42,"headSeq":42,"viewSeq":42}

```

`id` is the decimal durable `seq`; `data.seq` must equal it. Event names come from a closed mapping, never durable/user text. JSON is one line with CR/LF escaped by serialization. Control frames such as `control.ready`, `control.resync-required`, `control.slow-client`, and `control.closing` have no `id`, so private transport state never burns or advances the durable cursor. Heartbeats are `: keep-alive\n\n` every 15 seconds and carry no cursor.

`runEpoch` is required whenever `after` or `Last-Event-ID` is present. The first connect after a REST snapshot uses `?runEpoch=<snapshot.runEpoch>&after=<snapshot.headSeq>`. On native EventSource reconnect, a valid `Last-Event-ID` header takes precedence over the original `after` query so automatic reconnect advances instead of replaying from the initial URL forever. A malformed present header is a typed control error; it does not fall back to the query. A newly constructed EventSource after terminal close includes the client's latest `(runEpoch, seq)` in the query because scripts cannot set the header.

A connect without a cursor captures current head, emits id-less `control.ready` with that cursor, and follows live changes; it does not dump all history by default. Explicit `after=0` requests history subject to the same replay budget.

### Race-free algorithm

1. Validate project/run ownership and strict cursor/epoch before sending SSE headers. Acquire one of 32 SSE slots.
2. Register a one-slot/coalescing live wake-up synchronously. The callback may set only `dirty=true` and wake the reader; it never blocks, serializes, reads the store, or queues payloads.
3. In a read transaction, load `{runEpoch, floorSeq, headSeq}` and validate the requested cursor. Epoch mismatch or `after < floorSeq - 1` produces an id-less `control.resync-required` with bounded reason/floor/head/snapshot metadata, then closes.
4. Preflight the entire range `(after, capturedHead]` with limits. A catch-up may contain at most 1,024 mapped notifications and 4 MiB serialized data; one individual frame may be at most 64 KiB. If the range exceeds any budget, emit `control.resync-required {reason:"replay-budget"}` before any delta and close.
5. Replay the complete bounded range in `seq` order. Await Node response `drain` when `write()` returns false, but for no more than 5 seconds. Track `sentSeq` only after the frame has been accepted by the response writer.
6. Clear/consume the dirty flag and repeat a durable range read after `sentSeq`. An event committed between subscription and head capture appears either in the captured range or the subsequent range; overlap is discarded by `seq <= sentSeq`. A lost/coalesced wake is harmless because every wake reads to current durable head.
7. When caught up, wait for wake, heartbeat deadline, abort, or server shutdown. A socket drain timeout emits a best-effort id-less `control.slow-client` and closes. It never stalls the store writer or other clients.
8. In `finally`, unregister the subscriber, cancel heartbeat/drain waits, release the SSE slot, and detach request/response listeners exactly once.

The endpoint maps every canonical event to either a closed allowlisted notification or an explicit cursor-only `control.changed`; it never advances `sentSeq` past an event it failed to classify. Unknown schema/event mapping is `control.resync-required {reason:"schema"}` plus close, not skip-and-continue.

### Browser client

The dashboard performs one consistent REST snapshot first, records its `(runEpoch, headSeq)`, renders, then opens EventSource from that cursor. For every ordinary SSE frame it validates schema, run/project/epoch, safe integer ID, `id === data.seq`, and strict increase (`seq > lastApplied`; canonical filtering means `+1` is not required). It debounces a REST refetch; SSE payloads are invalidations/freshness, not UI truth.

Native EventSource handles transient reconnect while `CONNECTING` and sends Last-Event-ID. On every `open`, including reconnect, the client refetches a snapshot before declaring itself caught up. `control.resync-required` closes the source, discards the local cursor/view cache, fetches a full snapshot, and opens a new URL. Terminal `CLOSED`, parse/identity mismatch, or base URL/instance change uses exponential retry with jitter (250 ms, 500 ms, 1 s, 2 s, maximum 5 s) and one timer only. Three consecutive failed openings enable the existing 2.5-second polling as a visible degraded fallback; a healthy SSE open disables it. Page unload/selection change closes the source, aborts fetches, and clears retry/debounce timers.

The client tracks the health `instanceId` separately from durable `runEpoch`: a service restart may change instance while the same run cursor remains replayable. It must not treat `instanceId` as event epoch.

### CLI client

`loop serve status` is the first end-to-end consumer. It resolves the run-file, proves the lease is held, validates `/health`, then GETs `/api/v1/status` through a client with connect/headers/body timeouts and the 256 KiB response cap. `--json` prints the exact stable DTO; human output is a pure renderer over the same object. There is no fallback to direct tmux when this command was asked to use the service: absent, stale, mismatched, not-ready, oversized, invalid JSON, and timed-out states remain distinguishable and actionable.

A later packet may move `loop monitor` to `/board` plus `/events`, but P1 should not mix that migration into the ownership proof. Existing `loop status` and direct monitor remain compatibility paths until explicitly deprecated.

## Doctor diagnostics

`loop doctor` adds read-only checks without starting, stopping, cleaning, binding, or migrating anything:

- `control-dir`: path confinement, real private directory, owner/mode, no unsafe file shapes;
- `serve-lease`: `absent/free`, `held`, or `probe-failed`; a successful nonblocking lease probe is rolled back/closed immediately and never deletes the DB;
- `serve-runfile`: absent, bounded valid schema/private leaf, or exact unsafe/malformed reason;
- `serve-owner`: lease/run-file relationship (`stopped`, `starting`, `ready`, `held-unhealthy`, `stale-runfile`, `identity-mismatch`);
- `serve-health`: 2-second loopback probe, exact service/config/instance/PID agreement, readiness, and response bound;
- `serve-cursor`: for ready stores, verify `floorSeq <= viewSeq <= headSeq`, run epoch agreement, and recovery-required state.

Every warn/fail includes a fix longer than the existing actionability threshold. Doctor never says “delete the lock file”; the stable lease DB is deliberately permanent. A stale run-file is repaired by the next successful owner or by an explicit future repair command that first acquires the lease. A held-but-unhealthy owner is not killed or stolen; the fix tells the operator how to inspect/stop the exact process. Human local doctor may display a rendered local path, while the HTTP diagnostics DTO never exposes it.

## Failure and recovery test matrix

All tests use temporary control/run roots and deterministic clocks/IDs. Real-process cases use child fixtures and bounded timeouts; they must prove process exit and cleanup in `finally`.

| Area | Fault/sequence | Required observation |
|---|---|---|
| Bind | Inspect actual address after listen | `127.0.0.1` exactly; connections to non-loopback interfaces fail; no host option exists |
| Methods | POST/PUT/PATCH/DELETE/upgrade against every route | No side effect; known route `405` + `Allow`; unknown API `404` |
| Lease | Two simultaneous `loop serve` children | Exactly one acquires owner lease/listens/publishes; loser identifies ready/starting owner and exits bounded |
| Lease crash | SIGKILL holder at startup, before run-file, after run-file, during requests | Lease becomes acquirable without deleting lock DB; successor starts; stale run-file never blocks |
| Stable inode | Attempt cleanup/restart while successor waits/acquires | Lease DB is never unlinked/replaced; never two holders on split path identities |
| Unsupported lock | Adapter missing, `SQLITE_BUSY` indeterminate, network/locking probe failure | Fail closed with actionable diagnostic; no artifact-lock fallback |
| Run-file shape | Missing, >8 KiB, torn JSON, unknown key, wrong service/schema/host/config, invalid port/PID/token, symlink/FIFO/directory/hardlink/permissive/foreign owner | Typed refusal; no unbounded read, bind, attach, signal, or overwrite of unsafe leaf |
| Publication | Crash/fault at temp write, file fsync, rename, directory fsync | Reader sees old complete file, new complete file, or explicit failure; never partial accepted handshake |
| Successor cleanup | Old instance shuts down after successor publication is injected | Old cleanup does not remove successor `serve.json` |
| PID reuse | Run-file PID exists but process token differs | Status refuses identity; stop sends no signal |
| Foreign port | Configured port serves wrong/malformed/oversized health | Start fails clearly and releases lease; never attaches/falls back to another port |
| Health | Run-file and response differ in instance/config/PID/service | `identity-mismatch`; no status/data request follows |
| Shutdown | SIGINT/SIGTERM with idle, active GET, active SSE, hung socket | Not-ready first, bounded 5-second drain, run-file removed while owned, lease released last |
| Store read | Missing run, recovery-required/corrupt store, projection read throws | 404 or typed 503; never a plausible empty 200 |
| Ownership | Same-name-prefix project/session and cross-run IDs | Exact stamped project/run ownership only; no diagnostics/log exposure |
| REST bounds | Overlong URL/header/query, unsafe integer, excessive page/lines, response just at/over cap | Exact boundary accepted; next byte/value typed rejection; no partial JSON |
| Redaction | Sentinel in config/env/key/value/Authorization/Cookie/PEM/URL/path/prompt/message/log/error and nested/cyclic/huge values | Absent from every REST success/error, diagnostic, SSE replay/live, and local sanitized log; allowed public fields remain |
| SSE first connect | Snapshot at head N, event commits before/after subscription/head capture | Every relevant event after N is eventually observed once in increasing cursor order |
| SSE overlap | Same sequence present in captured replay and live wake | One frame only; `sentSeq` never regresses |
| SSE reconnect | Drop after IDs at start/middle/end; reconnect through query and native Last-Event-ID | Complete suffix, no duplicate application, header advances beyond original query |
| Service restart | Restart service during one run | New `instanceId`, same `runEpoch`; reconnect from prior seq succeeds from durable store |
| Run epoch | Present cursor from a different/recreated run epoch | Id-less `control.resync-required`, close, full REST snapshot, fresh connection |
| Cursor expiry | Set `floorSeq` above requested cursor | No partial suffix; resync includes allowlisted floor/head/snapshot metadata |
| Replay budget | 1,024 events / 4 MiB / 64 KiB exact and plus one | Exact caps replay; plus one emits resync before any ordinary delta and closes |
| Slow client | Response never drains while writes continue | Writer/store commits and healthy clients proceed; slow stream closes within 5 seconds; subscriber/timers released |
| Subscriber bound | Open 32 then a 33rd SSE client | First 32 remain healthy; 33rd gets bounded `503`; no allocation/fanout leak |
| Wake loss | Coalesce/drop many live wake signals | Next durable catch-up reaches current head; no missing authority |
| Mapping failure | Unknown event/reducer schema after cursor | Resync/close without advancing past unknown sequence |
| Framing | Split LF/CRLF, comments, multibyte JSON, aborted parked read, malformed/oversized frame in test client | Correct parse or explicit bounded failure; cleanup always occurs |
| Dashboard | OPEN/CONNECTING/CLOSED, base/instance change, resync, three failed opens, recovery | One source/timer, refetch on open, bounded backoff, visible polling fallback, recovery disables fallback |
| CLI | Real child `loop serve`; `serve status --json` | CLI discovers/handshakes and renders the exact `/api/v1/status` DTO; no direct tmux/store read on this path |
| Doctor | Every stopped/stale/starting/ready/held-unhealthy/mismatch state | Correct check status; every non-OK has actionable fix; no filesystem/process/network mutation beyond bounded read/probe |
| Board integration | Commit a board event through the store writer | Derived board/activity endpoint advances `viewSeq`; SSE emits matching durable seq; test client refetches and observes the new derived view |

The integration suite must also verify that run mutation remains unavailable over HTTP and that an SSE/REST client cannot cause a control-store write merely by connecting, paging, disconnecting, or presenting a bad cursor.

## Immediately splittable implementation packet

The packet is dependency-ordered and gives each agent exclusive file ownership. Shared integration files are assigned once, not concurrently.

### Wave A — freeze contracts in parallel

**A1 Protocol/DTO/redaction owner**

- Own new `src/control/protocol.ts`, `src/control/redaction.ts`, and `tests/control-protocol.test.ts`.
- Define run-file, health, status, run/board/activity/diagnostic, SSE/control-frame, cursor, and error schemas; exact constants/bounds; allowlist mappers; shared final redaction and serialization-size gate.
- May import domain types but must not edit dashboard/server/CLI/store files.
- Exit gate: strict parse/boundary/redaction/cycle/sentinel tests pass and exported contract has no internal object spreads.

**A2 Lifetime lease/run-file owner**

- Own new `src/control/lease.ts`, `src/control/runfile.ts`, `src/control/process-identity.ts`, `tests/control-lease.test.ts`, `tests/control-runfile.test.ts`, and child fixtures under `tests/fixtures/control-*`.
- Implement private control paths, dedicated SQLite `BEGIN IMMEDIATE` lifetime lease, bounded strict run-file read, durable instance publication/removal-if-instance, config identity, process-incarnation probes, and read-only discovery classification.
- Coordinate only the exact published `better-sqlite3@12.11.1` import surface with the durable-state adapter owner; do not add a second SQLite wrapper/version.
- Exit gate: simultaneous children, SIGKILL recovery, publication faults, PID-reuse/no-signal, stable-path, and unsafe-leaf cases pass on supported CI platforms; unsupported locking fails closed.

**A3 Read-model adapter owner**

- Own new `src/control/views.ts` and `tests/control-views.test.ts`; may add exported pure helpers to `src/dashboard/data.ts` only after taking exclusive ownership of that file.
- Map the companion `ControlStore` read contract to allowlisted run/board/activity/status/diagnostic DTO inputs. Exact project/run/session ownership is resolved before diagnostic capture. No HTTP code.
- Exit gate: deterministic ordering/freshness, recovery-error propagation, cross-project/run refusal, and byte-sized fixture coverage pass.

### Wave B — server and SSE, after A contracts

**B1 HTTP lifecycle/router owner**

- Own new `src/control/server.ts`, `tests/control-server.test.ts`, and server child fixture wiring.
- Compose A1/A2/A3; implement exact loopback bind, Host/Origin/method gate, readiness, route/error envelopes, server connection/time bounds, response size enforcement, startup/shutdown ordering, and test injection seams.
- Do not implement SSE internals; mount the B2 handler through an interface.
- Exit gate: real bind/foreign port, methods, HEAD, health identity, endpoint/status/error bounds, and graceful drain tests pass.

**B2 Durable SSE owner**

- Own new `src/control/sse.ts` and `tests/control-sse.test.ts`.
- Depend on the durable store's `readEvents(after, throughHead, limits)` plus post-commit wake seam. Implement strict cursor precedence, wake-before-head replay, mapping, overlap dedupe, heartbeat, byte/frame/client/drain bounds, explicit resync, and cleanup.
- Never import JSONL board readers or mint an event counter/ring epoch.
- Exit gate: every SSE row in the failure matrix passes, including real response backpressure and service-restart durable replay.

### Wave C — clients and diagnostics in parallel, after B server contract

**C1 Dashboard client owner**

- Own `src/dashboard/render.ts` and dashboard renderer/client tests. Consume A1 DTOs and B1/B2 routes; implement snapshot-first render, EventSource state/retry/resync, refetch debounce, abort cleanup, and degraded polling fallback.
- Do not edit server or store.
- Exit gate: deterministic fake EventSource tests for CONNECTING/CLOSED/base-instance changes, resync, timer singularity, fallback/recovery, and DOM projection pass.

**C2 CLI/doctor client owner**

- Own new `src/control/client.ts`, `src/doctor.ts`, `tests/doctor.test.ts`, and new `tests/control-client.test.ts`.
- Implement bounded discovery/health/status HTTP client and read-only doctor checks/classification. Preserve the existing “every non-OK check has a fix” contract.
- Do not register commands in `src/cli.ts`; expose handlers for the integration owner.
- Exit gate: absent/stale/mismatch/not-ready/oversized/timeout/ready cases and all doctor states pass without mutation.

### Wave D — single integration owner

- Sole ownership of `src/cli.ts`, `src/dashboard/server.ts`, `tests/dashboard-server.test.ts`, `tests/dashboard-security.test.ts`, `tests/dashboard.test.ts`, and new `tests/control-plane.test.ts`.
- Register `loop serve`, `loop serve status`, and `loop serve stop`; make `loop dashboard` use the same server; mount versioned API/SSE; preserve compatibility where explicitly chosen; wire graceful signals; keep run `loop stop` local/parent-owned.
- Add the real-child CLI-to-`/api/v1/status` test and board-commit → derived view → SSE → client-refetch test. Update legacy dashboard tests to assert the new typed error/redaction behavior rather than weakening existing loopback/project/method/header checks.
- Run focused control/dashboard/doctor/board suites, then full `npm run typecheck`, `npm test`, `npm run build`, and real SIGKILL/restart and slow-SSE child tests with exact elapsed times/RSS where measured.

Wave D is the only packet allowed to resolve integration conflicts in shared CLI/dashboard files. A1/A2/A3 can start together; B1/B2 start after their interfaces land; C1/C2 start after routes stabilize; D integrates last. The durable-state implementation must land at least its store/event-range/wake interfaces before B2, but its storage internals can otherwise proceed independently.

## Legal and provenance decision

| Source | Legal classification | What may inform RelayForge | What must not happen |
|---|---|---|---|
| RelayForge MIT | `NOT_USED` as an upstream; local baseline | Reuse/refactor local dashboard, state-file, doctor, ownership, and test patterns | Do not weaken existing guardrails/tests |
| Agent Orchestrator Apache-2.0 | `ARCHITECTURAL_INSPIRATION` | End-to-end boundary, attach cross-check, replay-before-live, thin client, reconnect test scenarios | No verbatim code/comments/tests; if later copied, Apache notice/header/attribution review is mandatory |
| Kubernetes Apache-2.0 | `ARCHITECTURAL_INSPIRATION` | Cursor floor, expired/relist, retry classification, bounded watcher policy | No Kubernetes wire types/status text/cache implementation copying |
| Qwen Code Apache-2.0 | `ARCHITECTURAL_INSPIRATION` | Strict cursors, frame+byte+subscriber bounds, id-less control frames, epoch/resync and parser test ideas | No EventBus/queue/parser code or constants copied wholesale |
| Daintree Apache-2.0 | `ARCHITECTURAL_INSPIRATION` | Exact loopback Host/Origin checks, hard probe timeout, UTF-8 byte cap tests | No MCP auth/mutation/session transport import |
| kcap Kurrent License v1 | `IDEA_ONLY` | General lifetime-lock/stable-inode/process-incarnation/doctor principles | Zero source, test, comment, layout, or distinctive algorithm copying; no dependency or vendoring |
| better-sqlite3 v12.11.1 MIT | `NOT_USED` for source copying; runtime dependency | One exact published shared Node 20-compatible SQLite adapter for state and lifetime lease | Do not install unconstrained latest/v13 under Node 20 or rely on an unpublished tag; record dependency/license in implementation change |
| SQLite documentation/engine | `IDEA_ONLY`; public ABI/documentation reference | `BEGIN IMMEDIATE` one-writer semantics, rollback/hot-journal recovery, local-filesystem constraint | Do not claim reliable locking on network filesystems |

Implementation-time provenance should record the exact upstream pins, paths, concepts, license classifications, and zero-copy kcap boundary. This audit itself is not a license grant. The chosen code structure, names, constants, schemas, and tests must be independently authored from RelayForge requirements.

## Go/no-go checklist

Do not call P1 control-plane complete until all are true:

- exactly one service owner is proven by a crash-released stable lifetime lease; the run-file is never treated as the lock;
- attach requires lease-held plus exact private run-file/health agreement, and signal requires live process-incarnation agreement;
- startup publishes only after bind/store readiness, shutdown removes only its own instance before releasing the lease, and SIGKILL recovery is automatic;
- the only listener is literal `127.0.0.1`, port selection is deterministic, and HTTP has no mutation or remote/auth mode;
- all public objects are explicit bounded DTOs with final shared redaction; raw config, canonical payloads, paths, prompts, transcripts, and unrestricted logs are absent;
- read/recovery failures are typed and visible, never converted to plausible empty success;
- SSE IDs are the durable store's `(runEpoch, seq)`, live subscription precedes replay-head capture, and overlap/missed wakes are recovered through durable reads;
- cursor epoch mismatch, retained-floor expiry, unknown mapping, replay budget, and slow client all cause explicit resync/close without silent loss or writer blockage;
- dashboard refetches on every open, handles native and terminal reconnect, bounds retries, and exposes a polling fallback without running duplicate refresh loops;
- `loop serve status` consumes `/api/v1/status` through the full private discovery/health/client path; no direct-store/tmux fallback hides a server failure;
- doctor covers control directory, lease, run-file, owner/health, and cursor relations read-only, with an actionable fix for every non-OK state;
- the real board commit → durable seq → derived view → SSE notification → client refetch integration passes, as do simultaneous-start, SIGKILL, PID-reuse, redaction-canary, exact-boundary, reconnect, expired-cursor, slow-client, focused, typecheck, full test, and build gates.

With these constraints, RelayForge gets a coherent P1 control plane rather than four loosely related features: one owner identity governs lifecycle, one read-model/redaction contract governs REST and SSE, one durable cursor governs replay and restart, and both dashboard and CLI consume that same bounded local authority.
