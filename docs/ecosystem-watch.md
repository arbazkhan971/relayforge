# Ecosystem Watch

RelayForge rescans the coding-agent ecosystem before every phase and performs a
broader rescan at phases 10, 20, 30, 40, 50, and the v1 release candidate. This
file records candidates; inclusion is not endorsement or permission to copy.

## Initial scan — 2026-08-09

Search themes included coding-agent orchestration, agent fleets, worktrees,
sandboxes, CI repair, schedulers, software factories, and autonomous software
engineering. Activity dates below are the audited local HEAD dates, not star
rankings.

| Repository | Latest audited activity | License observed | Why it remains on the watch list | Current action |
| --- | --- | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 2026-08-09 | Apache-2.0 | Primary practical fleet lifecycle, recovery, SCM, desktop reference | Audited for Phase 00; revisit every relevant phase |
| [GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion) | 2026-08-08 | Apache-2.0 | Containers, shared provisioning, memory/context and doctor | Audited for Phase 00; revisit sandbox/runtime phases |
| [daintreehq/daintree](https://github.com/daintreehq/daintree) | 2026-08-08 | Apache-2.0 + NOTICE | Strong local terminal/worktree/control-room UX | Audited for Phase 00; revisit desktop/control-room phase |
| [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise) | 2026-08-07 | AGPL-3.0 | Agentic IDE, preview integration, Git workflows, worktree setup runner | Architecture study only; revisit UI/preview phases |
| [johannesjo/parallel-code](https://github.com/johannesjo/parallel-code) | 2026-08-05 | MIT | Lightweight parallel UX and diff/merge ergonomics | Audited for Phase 00 |
| [fynnfluegge/agtx](https://github.com/fynnfluegge/agtx) | 2026-08-05 | Apache-2.0 | Worktree setup and config-hash trust | Audited for Phase 00 |
| [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | 2026-08-09 | Apache-2.0 + NOTICE | Active terminal/worktree orchestration and environment policy | Audited for Phase 00; revisit adapters/terminal phases |
| [nekocode/agent-worktree](https://github.com/nekocode/agent-worktree) | 2026-07-15 | MIT | Focused worktree wrapper, reflink copy, submodules, stable status | Audited for Phase 00 |
| [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude) | 2026-05-04 | AGPL-3.0 | Structured multi-provider development phases | Phase-00 setup audit complete; idea-only for planning/role phase |
| [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) | 2026-07-24 | Apache-2.0 | Hierarchical roles plus bounded agent-driven environment commands | Phase-00 adjacent setup audit complete; revisit planning research |
| [jayminwest/overstory](https://github.com/jayminwest/overstory) | 2026-05-28, archived | MIT | Valuable recovery/doctor bug history despite archival | Audited for Phase 00; do not treat as active baseline |
| [navikt/cplt](https://github.com/navikt/cplt) | 2026-08-03 | MIT | Strong Bubblewrap production-parity probe, nested namespaces, and required-sandbox CI discipline | Audited for Phase 00.2; revisit sandbox/runtime phases |
| [dtormoen/tsk](https://github.com/dtormoen/tsk) | 2026-07-28 | MIT | Practical nested container builds and useful limit-downgrade negative history | Audited for Phase 00.2; retain as a negative regression reference |
| [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox) | 2026-08-06 | Apache-2.0 | Authenticated blocked Bubblewrap launch, bounded status handling, and namespace identity | Audited for Phase 00.2; revisit sandbox/runtime and remote-execution phases |
| [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) | 2026-08-07 | Apache-2.0 | Nested namespace/capability ordering and coding-agent sandbox hardening history | Audited for Phase 00.2; revisit sandbox/runtime phases |
| `morapelker/hive` | Found in initial scan | Recheck before use | Active coding-agent fleet candidate | Triage in daemon/scheduler rescan |
| `stablyai/orca` | Found in initial scan | Recheck before use | Adjacent orchestration candidate | Triage in planner/adapter rescan |
| `mco-org/mco` | Found in initial scan | Recheck before use | Multi-agent coding orchestration candidate | Triage in planner/control-plane rescan |
| `h5i` | Found in initial scan | Recheck before use | Adjacent coding-agent infrastructure | Identify canonical repository before use |
| `Pane` | Found in initial scan | Recheck before use | Terminal/control-room candidate | Identify canonical repository before UI phase |

`AgentWrapper/agent-orchestrator` is intentionally absent as a second candidate:
GitHub redirects it to the Untrivial repository and both audited checkouts were
the same repository ID, commit, and tree.

## Phase 01 rescan — 2026-08-09

Search themes included coding-agent local daemons, durable workflow history,
SQLite projections, loopback control planes, SSE replay, watch cursor expiry,
service ownership and process-incarnation recovery. The complete comparison is
recorded in [the Phase 01 audit](reference/phase-01-control-plane-audit.md).

| Repository | Latest audited activity | License observed | Phase-01 relevance | Current action |
| --- | --- | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 2026-08-09, `f65c48e` | Apache-2.0 | Closest daemon/SQLite/CDC/REST/SSE/thin-client implementation | Primary architecture reference; independently strengthen ownership, bounds and expiry |
| [temporalio/temporal](https://github.com/temporalio/temporal) | 2026-08-09, `023cb7d` | MIT | Canonical history, rebuild and persistence recovery | Architecture inspiration; exclude distributed workflow machinery |
| [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | 2026-08-08, `94c1367` | Apache-2.0 | generation/resource version, expired watch and slow-consumer behavior | Adopt observable cursor contract, not cache machinery |
| [WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | published v12.11.1, `4cbc39c`; later unpublished v12.12.0 also inspected | MIT | Node 20-compatible transactional SQLite adapter | Exact published dependency; do not float to Node-22-only v13 or an unpublished tag |
| [kurrent-io/kcap-cli](https://github.com/kurrent-io/kcap-cli) | 2026-08-08, `b90b59e` | Kurrent License v1 | Strong lifetime owner/start serialization/process token | Idea only; zero copying |
| [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | 2026-08-09, `3e731cd` | Apache-2.0 | Best focused SSE frame/byte/replay/subscriber limits | Architecture/test inspiration; durable RelayForge cursor replaces memory ring |
| [daintreehq/daintree](https://github.com/daintreehq/daintree) | audited `a5c2dae` | Apache-2.0 | Loopback Host/Origin and bounded probe/output support | Supporting reference only |
| [restatedev/restate](https://github.com/restatedev/restate) | audited `f265773` | BSL-1.1 | durable journal/retention/snapshot ideas | Idea only under current terms |
| [inngest/inngest](https://github.com/inngest/inngest) | audited `ce19803` | SSPL | idempotency and retention negative cases | Idea only / not used |

New implementation candidates must still be rescanned before any later
subsystem adopts them; the P1 pins are not a permanent freshness claim.

## Phase 02 rescan — 2026-08-09

Search themes included coding-agent steering queues, durable prompt inboxes,
agent message brokers, workflow Signals/Updates, context injection, activity
states and prompt-boundary recovery. The complete result is in the
[Phase 02 audit](reference/phase-02-session-steering-audit.md).

| Repository | Latest audited activity | License observed | Phase-02 relevance | Current action |
| --- | --- | --- | --- | --- |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | 2026-08-08, `38e10eb` | MIT | Strongest durable input admission, cutoff and atomic promotion implementation | Primary P2 architecture reference; independently add parent authority/generations/artifact proof |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 2026-08-09, `f65c48e` | Apache-2.0 | Best coding-agent waiting/blocked/refusal semantics and bug history | Adopt state/refusal ideas; terminal delivery not used |
| [temporalio/temporal](https://github.com/temporalio/temporal) | 2026-08-07, `023cb7d` | MIT | Mature Signal/Update lifecycle and retry semantics | Architecture inspiration; make all RelayForge P2 facts durable |
| [google/scion](https://github.com/google/scion) | 2026-08-08, `91c26b3` | Apache-2.0 | Scoped envelope, bounds, broker CAS and stuck-queue tests | Adopt concepts/tests; reject pre-delivery dispatched and tmux paths |
| [daintreehq/daintree](https://github.com/daintreehq/daintree) | 2026-08-08, `eb989c7` | Apache-2.0 plus NOTICE | Strong pending/progress/cancel and exact-target UX | UX inspiration only |
| [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude) | 2026-05-04, `f2e75c1` | AGPL-3.0 | Staged workflow/role decomposition | Idea only; code not used |
| [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) | 2026-07-24, `4fb2db0` | Apache-2.0 | Role-labelled context and workflow communication concepts | Idea only; agent-authored transient transport not used |

Candidates such as `badlogic/pi-mono`, `agent-message-queue`, StrongDM's
Attractor specification, Kimaki and agtx were screened but did not displace the
strongest source/test evidence above. Reconsider them only for a concrete later
subproblem, with a fresh license/source audit.

## Phase 03 rescan — 2026-08-09

Search themes included coding-agent PR publication, CI repair, GitHub checks,
review feedback, remote-ref leases and idempotent pull-request creation. The full
result is in the [Phase 03 audit](reference/phase-03-scm-feedback-audit.md).

| Repository | Latest audited activity | License observed | Phase-03 relevance | Current action |
| --- | --- | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 2026-08-09, `f65c48e` | Apache-2.0 | Strongest durable continuous SCM observer, semantic dedup and feedback retry | Primary observation architecture; independently implement on P1/P2 |
| [doordash-oss/agentic-orchestrator](https://github.com/doordash-oss/agentic-orchestrator) | 2026-08-09, `101ca9a` | Apache-2.0 plus NOTICE | Strongest inspected idempotent PR-publish and explicit review-feedback child UX | Publication/review workflow inspiration; reject unbounded pagination and ordinary push |
| [cli/cli](https://github.com/cli/cli) | 2026-08-07, `9fc0f70` | MIT | Official-client check aggregation, dedup, state buckets and PR create tests | Normative GitHub behavior inspiration; add durability/bounds/generations |

`AgentWrapper/agent-orchestrator` again resolved to the exact Untrivial objects
and is not a separate candidate. P3 did not identify a single repository that is
best at local artifact integrity, remote publication, continuous observation and
repair reactions; RelayForge's chosen design deliberately assigns those
subproblems to different references while retaining one event/state model.

## Rescan protocol

For each new candidate, record the canonical URL, HEAD/date, license and NOTICE,
source/tests/design files inspected, important issues/PRs, subsystem quality,
and a reuse classification in `docs/upstream-sources.md`. A repository does not
enter a phase matrix on README claims alone.

## Phase 04 rescan — 2026-08-09

Search themes included adapter registries, ACP, app-server JSON-RPC, stream
JSON, structured prompt transport, usage/rate evidence, cancellation races,
read-only reviewers, and conformance tests. The full comparison is in the
[Phase 04 audit](reference/phase-04-adapter-registry-audit.md).

| Repository | Latest audited activity | License observed | Phase-04 relevance | Current action |
|---|---|---|---|---|
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 2026-08-09, `f65c48e` | Apache-2.0 | Strongest registry and worker/reviewer decomposition | Primary architecture reference; keep RelayForge's structured execution authority |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | 2026-08-08, `38e10eb`; 1.18.15 | MIT | Provider-owned native ACP with deep session/permission/usage tests | First new real adapter; prove loopback inside unchanged network jail |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | 2026-08-09, `1fc9d6c`; stable wire v1 | Apache-2.0 | Normative negotiation, capabilities, cancellation and schemas | Protocol kind only, never provider/containment/accounting authority; watch v2 separately |
| [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp) | 2026-08-07, `145ebba`; 1.1.14 | Apache-2.0 | Best current app-server mapper and cancellation-race corpus | Design inspiration; defer native Codex app-server migration |
| [badlogic/pi-mono](https://github.com/badlogic/pi-mono) | 2026-08-09, `936aff0`; 0.84.1 | MIT | Strongest independent non-ACP JSONL RPC and isolation controls | Second new real adapter; replace startup sleep with live state/stats probe |
| [openclaw/acpx](https://github.com/openclaw/acpx) | 2026-08-08, `5ef9b58`; 0.13.0 | MIT | Best public events/settled-result split and seed conformance corpus | Independently author stricter conformance; reject download/override paths |
| [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | 2026-08-09, `f3ba99f`; 0.21.8 | Apache-2.0 | Strong native ACP/stream-JSON and usage/history tests | Deferred next ACP conformance target after OpenCode + Pi |
| [xai-org/grok-build](https://github.com/xai-org/grok-build) | 2026-08-09, `8a14c91`; installed stable 1.0.0 build `3cd0d0cbce` characterized separately | Apache-2.0 plus `third_party/NOTICE` | Canonical Grok Build CLI with native persistent ACP v1 and deep hermetic/ACP tests | Add only behind private API-key config, fixed no-update/no-web/no-subagent/no-memory policy, explicit no-upload evidence, and the existing contained transport |

`AgentWrapper/agent-orchestrator` again resolved to the exact Untrivial commit
and tree and is not an independent candidate. Re-pin and rerun characterization
before changing any supported adapter range: every selected project is active,
ACP v2 is evolving separately, and standalone CLI health does not prove a
contained bridge. The next adapter scan should specifically reconsider Qwen and
current native Codex app-server behavior after the two required P4 adapters pass.
The Grok-specific source/privacy/adjacent-reference rescan and build/source
identity distinction are recorded in the [P4 Grok addendum](reference/phase-04-grok-build-addendum.md).

## Phase 05 rescan — 2026-08-09

Search themes included coding-agent control rooms, durable live observations,
incremental transcript tailing, file rotation/source identity, bounded terminal
buffers, multi-agent activity UX, SSE/WebSocket replay and slow subscribers.
The complete comparison is in the [Phase 05
audit](reference/phase-05-live-observability-audit.md).

| Repository | Latest audited activity | License observed | Phase-05 relevance | Current action |
| --- | --- | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 2026-08-09, `f65c48e` | Apache-2.0 | Strongest descriptor-pinned incremental transcript/source-generation recovery | Primary transcript-only ingestion reference; normalize and redact before P1 commit |
| [doordash-oss/agentic-orchestrator](https://github.com/doordash-oss/agentic-orchestrator) | 2026-08-09, `101ca9a` | Apache-2.0 plus NOTICE | Strong typed/indexed mutable-tail output and bounded live stream | Adopt narrowed row/activity concepts; keep RelayForge durable SSE |
| [sstraus/tuicommander](https://github.com/sstraus/tuicommander) | 2026-08-06, `ce097a4`, v1.7.2 | Apache-2.0 | Stable activity spine and request/session generation fences | UX/race reference; reject live-only SSE and raw/path payloads |
| [coding-by-feng/ai-agent-session-center](https://github.com/coding-by-feng/ai-agent-session-center) | 2026-08-03, `ff8e4b2` | MIT | Small, deeply tested lazy fixed-capacity byte ring | Adapt for sanitized presentation cache only |
| [daintreehq/daintree](https://github.com/daintreehq/daintree) | 2026-08-09, `a5c2dae` | Apache-2.0 plus NOTICE | Generation-safe terminal lifecycle, pressure/drop signals and coalesced activity | Borrow bounded UX/race concepts, not terminal inference complexity |
| [simple10/agents-observe](https://github.com/simple10/agents-observe) | 2026-07-21, `bb2f6c3` | MIT | Canonical event dedup and database-race tests | Supporting dedup reference; reject live-only WebSocket/full-file transcript loop |
| [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise) | 2026-08-07, `104d1c2` | AGPL-3.0 | Bounded headless terminal and explicit OSC trust caveat | `IDEA_ONLY`; no source/test/structure copying |
| [jayminwest/overstory](https://github.com/jayminwest/overstory) | 2026-05-28, `ff38f3f`; archived | MIT | Simple event-file tailer | Reject: partial/error loss and no source generation |
| [nutthouse/tutti](https://github.com/nutthouse/tutti) | 2026-07-20, `6b86cca` | MIT | Newly found terminal dashboard candidate | Reject for core: timestamp cursor, raw polling and terminal-derived authority |

No candidate displaced RelayForge P1 for durable truth, loopback HTTP or replay.
The next scan should re-pin all selected sources, watch AO source-ingestion
changes, and reconsider DoorDash's output contract if it gains durable replay.
Any new terminal dashboard is screened first for raw-secret exposure and
terminal-derived authority; visual polish alone is not a qualifying primitive.

## Phase 06 rescan — 2026-08-09

Search themes included multi-repository coding agents, agent worktree groups,
cross-repository branch integration, dependency DAGs, capability schedulers,
task leases, Ack/Nack queues, durable matching, and ref compare-and-swap. The
complete comparison is in the [Phase 06
audit](reference/phase-06-multi-repository-audit.md).

| Repository | Latest audited activity | License observed | Phase-06 relevance | Current action |
| --- | --- | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 2026-08-09, `f65c48e` | Apache-2.0 | Strongest inspected multi-repo worktree create/preserve/restore/cleanup lifecycle | Adapt group lifecycle; add independent repo identity, fencing and transactional integration |
| [doordash-oss/agentic-orchestrator](https://github.com/doordash-oss/agentic-orchestrator) | 2026-08-09, `101ca9a`; 99 commits/90d | Apache-2.0 plus NOTICE | Strongest detached-candidate, per-ref CAS, compensation and crash-resume implementation | Primary local-integration behavior reference; independently port onto P1 events |
| [kdlbs/kandev](https://github.com/kdlbs/kandev) | 2026-08-09, `bbdd426`; 1,343 commits/90d | AGPL-3.0 | Best per-repo task/worktree/branch/PR identity, migrations and resume bug corpus | `IDEA_ONLY`; independently reproduce regressions, never copy code/tests |
| [dagucloud/dagu](https://github.com/dagucloud/dagu) | 2026-08-09, `9986306`; 394 commits/90d | GPL-3.0-or-later | Claim/heartbeat/zombie/queue corpus and useful fail-open negative cases | `IDEA_ONLY`; RelayForge fails closed on lease/watermark uncertainty |
| [AgentsMesh/AgentsMesh](https://github.com/AgentsMesh/AgentsMesh) | 2026-08-03, `1f90b14`; 82 commits/90d | BUSL-1.1, no production grant, 2030 change date | Adjacent remote runner/task scheduler/worktree system | `IDEA_ONLY` / `NOT_USED` for code under current terms |
| [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | 2026-08-08, `94c1367` | Apache-2.0 | Best dirty/processing reconcile semantics and explicit leader-lease non-fencing warning | Persist the reconcile concept; fence every mutation separately |
| [temporalio/temporal](https://github.com/temporalio/temporal) | 2026-08-07, `023cb7d` | MIT | Strongest durable backlog/ack/retry/rebuild infrastructure reference | Architecture inspiration; retain smaller local ControlStore |
| [hashicorp/nomad](https://github.com/hashicorp/nomad) | 2026-08-07, `d78b9b5`; 200 commits/90d | BUSL-1.1 | Strong tokenized dequeue, Ack/Nack, priority/FIFO and delivery-limit tests | `IDEA_ONLY`; reject memory authority and best-effort acknowledgement |
| [GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion) | 2026-08-08, `91c26b3` | Apache-2.0 | Lightweight persistent scheduling, jitter and global concurrency | Test/UX inspiration; reject unguarded optional-lock path |

Newly surfaced coding-agent candidates such as `kbwo/ccmanager`, `21st-dev/1code`,
`morapelker/hive`, `standardagents/dmux`, and current Kandev should be rescanned
for later multi-project/control-room ergonomics, but none displaced DoorDash's
local transaction or AO's lifecycle in this source/test audit. The next P6 scan
must watch for real multi-ref crash tests, not merely a UI that lists several
repositories.

## v1 release-candidate rescan — 2026-08-09

The mandatory v1 release-candidate rescan covered npm publication, packed
artifact smoke, release-DAG gates, compatibility aliases, changelog/version
discipline, and the newly requested Grok Build adapter. Pins, recent history,
source, tests, issues or pull requests, license, and NOTICE files were checked;
README claims alone were not release evidence. The complete release comparison
is in the [Phase 07 audit](reference/phase-07-release-audit.md), and Grok's
protocol/privacy analysis is in the [P4 addendum](reference/phase-04-grok-build-addendum.md).

| Repository or branch | Audited pin and activity | License observed | RC relevance | Decision |
| --- | --- | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | `f65c48e296e20a816221a4003c75a5f0387967ec`; 453 commits/30d | Repository Apache-2.0; npm shim metadata MIT | Exact-SHA releases, guarded credentials, CLI/package E2E | `ARCHITECTURAL_INSPIRATION`; evaluate each file's provenance separately |
| [mco-org/mco](https://github.com/mco-org/mco) | `9eff964825e4da234d8c8079c61fb010854ae44e`; 5 commits/30d | MIT; no NOTICE found | Strongest npm idempotency, retry, clean-install and tag/version checks | `ARCHITECTURAL_INSPIRATION`; independently implement npm-only behavior |
| [daintreehq/daintree](https://github.com/daintreehq/daintree) | `eb989c7613db8ff9dc948775291f56e42c5ada3a`; 1,623 commits/30d | Apache-2.0 plus NOTICE | Strongest packed-artifact and release-topology proof | `ARCHITECTURAL_INSPIRATION`; exclude Electron/signing/updater scope |
| [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise) | `104d1c27376bc37e6b93adfc3617254358346823`; 180 commits/30d | AGPL-3.0 with package-local licenses | Prerelease/nightly and release-note UX | `IDEA_ONLY`; no source, tests, or structure copied |
| [GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion) | `91c26b343a26b7697f9432de5792cd7372b391a6`; 421 commits/30d | Apache-2.0 | Strongest CLI and persisted-state compatibility characterization | `ARCHITECTURAL_INSPIRATION`; preserve RelayForge's `.loop` compatibility in place |
| [johannesjo/parallel-code](https://github.com/johannesjo/parallel-code) | `d000fff65989f4c9fe48e5814a9d7c807ae83ba6`; 64 commits/30d | MIT | Compact tag/release operator flow | `IDEA_ONLY`; its artifact proof is weaker than the selected gates |
| [xai-org/grok-build](https://github.com/xai-org/grok-build) | `8a14c91d88875a831a38b3a066b1683116bcb31c`, 2026-08-09; 24 commits since 2026-07-10. Installed stable build `3cd0d0cbce` is separate runtime evidence | Apache-2.0 plus `third_party/NOTICE` | Canonical `grok agent --no-leader stdio` ACP v1 source, parser and hermetic tests | First-class only after the exact installed build passes parent-contained prompt/cancel/read-only/accounting/no-upload gates; source HEAD is never substituted for runtime proof |
| `origin/claude/agent-orchestrator-ref-i63kd1` | `f0914c092157b7d63ba98481ce313b2d53abcfe2`, 2026-07-16 | MIT | User-requested daemon/mission-control reference | `NOT_USED`; P1/P3/P5 durable SQLite, normalized DTO and authority boundaries supersede its JSON/live/raw design |
| active RelayForge implementation base | `73051d510c6473fa763bc7cd81921f65bec00eea`, 2026-08-09 audit baseline | MIT | User-requested comparison baseline for the parallel branch review | `USED` as the local implementation baseline, not an external adapter or source-reuse candidate |

No upstream code or tests were copied. External repository renaming, npm
publication, dist-tag promotion, release creation, and registry smoke remain
operator actions; this repository's gates prepare and verify artifacts but do
not claim those external mutations occurred.

The npm namespace check at 2026-08-09T14:48Z returned a confirmed E404 for
`npm view relayforge version dist.integrity --json`. That dated absence is
external-state evidence only—not ownership or a reservation—and the release
workflow must repeat its exact-version/integrity preflight at publication time.

## User-requested branch comparison — 2026-08-09

The remote branch `claude/agent-orchestrator-ref-i63kd1` was fetched at
`f0914c092157b7d63ba98481ce313b2d53abcfe2` and reviewed in parallel with the
active `agent/loop-engineering-hardening` base at
`73051d510c6473fa763bc7cd81921f65bec00eea`. Actual daemon/SCM source, all three
focused test files, its mission-control plan, commit history and MIT license
were inspected. Its derived-status and failure-as-unknown tests remain useful
characterizations, but its raw JSONL/SSE/token/mutation/router boundaries are
superseded by RelayForge P1/P3/P5. No code or test was copied or cherry-picked;
the detailed `NOT_USED` decision is recorded in `docs/upstream-sources.md`.
