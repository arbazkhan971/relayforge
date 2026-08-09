# RelayForge build roadmap (Loop Orchestrator predecessor)

## Status and ordering

This document is the historical ordered migration plan from Loop Orchestrator to
RelayForge, based on [the original Agent Orchestrator comparison](docs/reference/ao-gap-analysis.md)
and a source-level ecosystem audit before every phase—not a live feature
checklist. For **current** release capability, evidence counts, blockers, and
resume order, use **[docs/implementation-status.md](docs/implementation-status.md)**.

Untrivial's Agent Orchestrator remains the primary baseline, but no repository
is presumed best at every subsystem. RelayForge's fail-closed containment,
parent-owned board/ledger, clean-tree gate, and no auto-merge-to-`main` rules are
non-negotiable throughout.

Every implementation phase began with a Reference Matrix covering the primary
reference plus at least three independent relevant repositories when they
existed. Audits inspected source, tests, design records, history, bug fixes, and
licensing before code began. Reuse is tracked in
[the upstream-source ledger](docs/upstream-sources.md), and ecosystem rescans
are recorded in [the ecosystem watch](docs/ecosystem-watch.md).

Pillars were ordered **P0 → P6** because live control features must not outrun
the worktree/toolchain and safety foundations. **Current status (handoff):**

| Pillar | Outcome | Current status |
| --- | --- | --- |
| P0 | Self-hosting DX: dependency provisioning and verifier-scope design | **Implemented** — provisioning **99/99**; P0.2 required-host **21/21**, nested **46/46** + **193/193** |
| P1 | Persistent loopback daemon and derived control-plane views | **Implemented** — SQLite control plane, loopback HTTP/SSE, dashboard, cutover (focused **210/210**) |
| P2 | Safe parent-owned session steering | **Implemented** — CLI live steering E2E **1/1** + adjacent **25/25**, exact cgroup/no-leak proof |
| P3 | Trusted SCM feedback loop | **Product-integrated** (focused **155/155**) for explicit SCM/P6 publication config: recoverable publication, parent polling, durable observations, and reaction-to-P2 steering |
| P4 | Harness adapter registry | **Implemented** (release receipts open) — registry product-integrated; OpenCode characterization exists with hardened fixture/required-host tests but real release receipt needs designated runner + exact binary + live credential; Pi/Grok still typed unavailable (no release receipt); ordinary OpenCode/Pi/Grok refuse before mutation; publish path fail-closed until distinct same-runner receipts |
| P5 | Live observability through P1’s event transport | **Implemented** — control room / transcript path (focused **125/125**) |
| P6 | Multi-repository execution + product docs/ADRs | **Product-integrated** — strict config/validation, CLI run route, ControlStore facts/views, authority, DAG/scheduler, worktree groups, contained transport/settlement, publication bridge, read isolation, crash recovery, real product E2Es (authority **21/21**, orchestration **12/12**, product/recovery/verifier **6/6**, publication/SCM/integration **13/13**) |
| P7 | Identity / packaging / browser / release proof | Local committed gates **green** (aggregate **171** / **1,927**, contained source smoke, exact preview tarball, packed Chrome **150.0.7871.128**); publish remains fail-closed until real same-runner native receipts; **no** tag/publish/rename |

Product integration landed at `5880b008d81c20f746f728ef83d736306d546d81`;
the verified release-smoke baseline is `198aa44a192848fe6df1b6f4033e5f6bffc62d89`.

## Wave 0 — complete (historical)

At decision time this wave contained three P0 items:

1. **Gap analysis and roadmap — landed.** Publish the source-cited AO comparison
   and this ordered roadmap. It describes the board as append-oriented with
   parent-side event compaction, and distinguishes direct uncertain settlement
   from kernel-evaluated completed calls. Drafted by the SME team over four
   independently reviewed attempts; finalized by the operator with the
   reviewer's line-level corrections applied.
2. **P0(1): worktree dependency provisioning — shipped and verified (99/99).**
   The required multi-repository reference audit and legal ledger are complete.
   A first-class, offline-safe copy/provisioning flow plus doctor reporting
   gates integration, attempt, and isolated-review worktrees. It must not
   hardlink a human checkout’s `node_modules`, must leave a working local
   toolchain, and must prove inode isolation with a deterministic test.
3. **P0(2): verifier scope delegation — implemented under ADR 001.** Required-
   host characterization **21/21**; nested production-jail suites **46/46** and
   **193/193** with zero skips and exact cgroup/no-leak proof. Platform guards
   remain honest on unsupported ordinary hosts.

Historical checkpoint note (Wave 0 era): typecheck/build and an earlier full
host suite (832/832 across 60 files) passed after the streaming-slab repair.
That aggregate is not the current P0–P7 claim; see
[implementation-status.md](docs/implementation-status.md) for the committed
**171** files / **1,927** tests plus clean build result.

## Wave 1 — finish P0(2) only after an ADR (4 tasks) — complete

1. **Complete.** ADR 001 delimits the verifier-owned pre-created cgroup subtree,
   nested-launch behavior, cleanup ownership, structural limits, and the
   failure mode when delegation is unavailable.
2. **Complete.** The pinned-FD launcher, behavioral probe, sandbox wiring,
   authenticated pre-exec handshake, durable v2 journal/recovery, operator
   diagnostics, and async bounded verifier transport are integrated.
3. **Complete on the required host.** Nested launch/settlement and provider
   evidence suites ran through the production verifier jail with zero capability
   skips (**46/46**, **193/193**). Cross-platform guards remain truthful on
   unsupported ordinary jobs.
4. **Complete.** Jail timing and exact structural limits were characterized:
   256 descendants and depth 16 succeed and the next creation returns `EAGAIN`.

Guardrails: no generic cgroup delegation, no environment escape hatch, no
provider execution outside containment, and no weakening of settlement proof.

## Wave 2 — P1 daemon and control plane (5 tasks) — implemented

At decision time the tasks were:

1. ADR: retain JSONL plus compaction or introduce a store; specify event identity,
   retention, and recovery semantics. → **ADR 002 accepted and implemented.**
2. Define pure board/ledger-to-activity derivation with tests covering precedence
   and restart reads.
3. Add a loopback-only `relayforge serve` lifecycle with a secure run-file/ownership
   handshake and doctor diagnostics.
4. Add read-only REST endpoints for runs, board views, derived activity, and
   redacted diagnostics; make the CLI consume one endpoint end to end.
5. Add an SSE event stream with reconnect/replay behavior and an integration
   test for board update → derived view → client event.

**Current:** durable SQLite control plane is landed; focused aggregate **210/210**.

Guardrails: the daemon is the parent-owned writer; its unauthenticated listener
stays loopback-only; display state is derived, never persisted as fact.

## Wave 3 — P2 session steering (4 tasks) — implemented

At decision time the tasks were:

1. Define and validate a parent-authored steering-message schema, keyed by
   strict run/task/role IDs and durable queue sequence.
2. Extend the pure activity derivation to active, idle, waiting-input, blocked,
   and exited states without storing the presentation state.
3. Implement `relayforge steer` as a control-plane mutation that appends only
   through the parent-owned path (not terminal injection).
4. Integrate safe delivery at the next dispatch/repair prompt boundary and test
   that blocked sessions are never injected into; surface the state in monitor
   and dashboard.

**Current:** CLI live steering E2E **1/1** + adjacent **25/25** with exact
cgroup/no-leak proof. See [session-steering.md](docs/session-steering.md).

Guardrails: no direct agent board writes, no blind terminal injection, and no
instruction delivery that bypasses prompt/sandbox construction.

## Wave 4 — P3 SCM feedback (5 tasks) — implemented (library)

At decision time the tasks were:

1. ADR: trusted-parent network ownership, GitHub credential handling, rate limits,
   redaction, and observation retention. → **ADR 004 accepted and implemented.**
2. Recoverable branch/PR publication bound to one immutable integration OID.
3. Implement normalized PR/check/review observation facts and a polling
   scheduler with injectable clock and no sleeps-as-sync.
4. Parent-owned reaction bridge into future-attempt steering commands.
5. Test observer fact → repair queue → existing repair pipeline end to end.

**Current:** SCM machinery focused **155/155** and is wired into the run parent
for explicit SCM/P6 publication plans. Unconfigured runs perform no remote
publication; configured published PRs are polled and reactions enter P2.

Guardrails: only the trusted parent gets network credentials; agents receive
sanitized task context and continue to run in their normal sandbox/scope.

## Wave 5 — P4 adapter registry (5 tasks) — implemented (release receipts open)

At decision time the tasks were:

1. ADR: adapter contract and compatibility/versioning rules. → **ADR 005.**
2. Extract the existing provider command, prompt transport, normalized-output,
   usage, limit, and read-only behaviors behind strict interfaces.
3. Add registry construction and conformance fixtures for worker and reviewer
   adapters without changing current provider behavior.
4. Move existing Claude, Codex, Gemini, and custom implementations through the
   registry with focused compatibility tests.
5. Add `opencode` plus further real adapters through the same contract.

**Current:** registry/codecs/routes are product-integrated. OpenCode production
characterization exists and has hardened fixture/required-host tests; a real
release receipt still needs the designated runner, exact installed binary, and
live credential. Pi and Grok production characterizations remain **typed
unavailable** and emit **no** release receipt. Ordinary OpenCode/Pi/Grok product
execution currently **refuses before** run/control/worktree mutation because
product evidence injection is intentionally not supported yet. The publishable
release workflow requires distinct same-runner OpenCode, Pi, and Grok receipts
and remains **fail-closed**.

Guardrails: adapters cannot choose an uncontained launcher or mint settlement
authority; all provider paths retain the existing evidence flow.

## Wave 6 — P5 live observability (4 tasks) — implemented

At decision time the tasks were:

1. Add a dashboard SSE client with ordering/reconnect handling and polling
   fallback, consuming P1’s derived views.
2. Define redacted, bounded transcript-tail events and a per-agent stream
   endpoint; test secret-shaped data never reaches the browser.
3. Add a dependency-free session inspector for task, attempt patch summary,
   verification output, review verdict, spend, and derived activity.
4. Integrate monitor/dashboard event rendering and perform a loopback-only
   browser/API smoke test.

**Current:** P5 focused aggregate **125/125**. Observation failures are
non-authoritative. Packed real-browser proof under P7 is **GREEN** on the
committed candidate (Chrome **150.0.7871.128**; lifecycle connected → degraded
→ recovered).

Guardrails: no build dependency for the dashboard, no network bind beyond
loopback, bounded data retention, and no raw credential/config exposure.

## Wave 7 — product documentation, multi-repo, release (historical plan) — locally complete; native release evidence open

At decision time Wave 7 covered product docs/ADRs. Multi-repository execution
(ADR 007) and RelayForge identity/release (ADR 008) were later sequenced as P6
and P7. **Current:**

- ADRs 001–008 exist; P0–P6 implementation is committed and locally verified.
  See [implementation-status.md](docs/implementation-status.md).
- Multi-repository is **product-integrated** (not library-only): authority
  **21/21**, orchestration **12/12**, product/recovery/verifier **6/6**,
  publication/SCM/integration **13/13**.
- P7 local preview/browser/source gates are **green** on committed source:
  required-cgroup aggregate **171** files / **1,927** tests + clean TypeScript
  build; source smoke strong-path marker; deterministic exact preview
  `relayforge-1.0.0-rc.1.tgz` with its digest recorded by the repository-only
  campaign state rather than self-embedded in packed Markdown; packed
  Chrome **150.0.7871.128** with DOM rendered and lifecycle connected →
  degraded → recovered (`serviceReplaced` true).
- Preview defects fixed: public declarations no longer leak implementation-only
  better-sqlite3 types; smoke harness asynchronously runs `serve stop` to reap
  the owned service child; legacy `.loop` fixture adopts the directory init may
  already create.
- **No** tag, npm publish, GitHub release, repository rename, or real native
  receipt has been performed.
- The integration commit and committed-source rerun are complete. The remaining
  shared handoff action is the branch push. Publication stays fail-closed until
  distinct same-runner OpenCode/Pi/Grok receipts exist.

## Slice discipline

Each numbered wave is intentionally 3–8 independently reviewable tasks. Every
implementation task must include tests and docs in the same diff, use the
project’s authoritative `npm run typecheck`, `npm test`, and `npm run build`
commands as applicable, and leave tests, CI configuration, and safety gates
unchanged except where a reviewed parity task explicitly restores a verified
scope test under the P0 ADR.

Live release handoff: [docs/implementation-status.md](docs/implementation-status.md).
