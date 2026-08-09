# RelayForge build roadmap (Loop Orchestrator predecessor)

## Status and ordering

This is a forward-looking migration plan from Loop Orchestrator to RelayForge,
based on [the original Agent Orchestrator comparison](docs/reference/ao-gap-analysis.md)
and a source-level ecosystem audit before every phase—not a feature list.
Untrivial's Agent Orchestrator remains the primary baseline, but no repository
is presumed best at every subsystem. RelayForge's fail-closed containment,
parent-owned board/ledger, clean-tree gate, and no auto-merge-to-`main` rules are
non-negotiable throughout.

Every implementation phase now begins with a Reference Matrix covering the
primary reference plus at least three independent relevant repositories when
they exist. The audit must inspect source, tests, design records, current
history, important bug fixes, and licensing before code begins. Reuse is tracked
in [the upstream-source ledger](docs/upstream-sources.md), and ecosystem rescans
are recorded in [the ecosystem watch](docs/ecosystem-watch.md). Phase 00's gate
is [complete](docs/reference/phase-00-worktree-provisioning-audit.md).

Pillars are ordered **P0 → P6** because live control features must not outrun
the worktree/toolchain and safety foundations:

| Pillar | Outcome | Current status |
| --- | --- | --- |
| P0 | Self-hosting DX: dependency provisioning and verifier-scope design | P0(1) shipped and verified; P0(2) audit, ADR, and policy kernel complete; real Linux integration active |
| P1 | Persistent loopback daemon and derived control-plane views | Planned after P0 |
| P2 | Safe parent-owned session steering | Planned after P1 |
| P3 | Trusted SCM feedback loop | Planned after P2 |
| P4 | Harness adapter registry | Planned after P3 |
| P5 | Live observability through P1’s event transport | Planned after P4 |
| P6 | Product architecture, ADRs, and honest user docs | Planned after P5, with docs updated in every wave |

## Wave 0 — active

This wave contains three P0 items:

1. **Gap analysis and roadmap — landed (this commit).** Publish the source-cited
   AO comparison and this ordered roadmap. It describes the board as
   append-oriented with parent-side event compaction, and distinguishes direct
   uncertain settlement from kernel-evaluated completed calls. Drafted by the
   SME team over four independently reviewed attempts; finalized by the operator
   with the reviewer's line-level corrections applied. No source or test changes.
2. **P0(1): worktree dependency provisioning — shipped and verified.** The
   required multi-repository reference audit and legal ledger are complete. A
   first-class, offline-safe copy/provisioning flow plus `loop doctor` reporting
   now gates integration, attempt, and isolated-review worktrees.
   It must not hardlink a human checkout’s `node_modules`, must leave a working
   local toolchain, and must prove inode isolation with a deterministic test.
   (A first attempt was rejected for exactly those two failure modes — sharing
   inodes with the human checkout, and shipping without tests; both are now
   binding learned constraints in the run goal.)
3. **P0(2): verifier scope delegation and skip-guard removal — implementation
   active under accepted ADR 001.** The source-level ecosystem audit, explicit
   delegated-subtree boundary, closed capability model, FD/gate protocol,
   versioned identity/journal grammar, and cleanup/recovery decision kernel are
   complete. No skip or guard is removed until the real Bubblewrap/kernel
   behavior and nested suites pass; no broad scope has been delegated.

Current checkpoint evidence: `npm run typecheck` and `npm run build` pass; the
complete host suite passes 832/832 across 60 files. The formerly failing
six-million-frame transport regression now completes well within its unchanged
bound after a source-audited reusable-slab correction. Verifier-jail skips
remain honest until Wave 1's real Linux acceptance gate passes.

## Wave 1 — finish P0(2) only after an ADR (4 tasks)

1. **Complete.** ADR 001 delimits the verifier-owned pre-created cgroup subtree,
   nested-launch behavior, cleanup ownership, structural limits, and the
   failure mode when delegation is unavailable.
2. **Complete.** The pinned-FD launcher, behavioral probe, sandbox wiring,
   authenticated pre-exec handshake, durable v2 journal/recovery, operator
   diagnostics, and async bounded verifier transport are integrated.
3. **Complete on the required host.** The nested launch/settlement and provider
   evidence suites ran through the production verifier jail with zero capability
   skips. Cross-platform guards remain truthful on unsupported ordinary jobs.
4. Jail timing and exact structural limits were characterized: 256 descendants
   and depth 16 succeed and the next creation returns `EAGAIN`. Keep the required-
   capability CI job and expand its kernel/Bubblewrap matrix before release.

Guardrails: no generic cgroup delegation, no environment escape hatch, no
provider execution outside containment, and no weakening of settlement proof.

## Wave 2 — P1 daemon and control plane (5 tasks)

1. ADR: retain JSONL plus compaction or introduce a store; specify event identity,
   retention, and recovery semantics.
2. Define pure board/ledger-to-activity derivation with tests covering precedence
   and restart reads.
3. Add a loopback-only `loop serve` lifecycle with a secure run-file/ownership
   handshake and `loop doctor` diagnostics.
4. Add read-only REST endpoints for runs, board views, derived activity, and
   redacted diagnostics; make the CLI consume one endpoint end to end.
5. Add an SSE event stream with reconnect/replay behavior and an integration
   test for board update → derived view → client event.

Guardrails: the daemon is the parent-owned writer; its unauthenticated listener
stays loopback-only; display state is derived, never persisted as fact.

## Wave 3 — P2 session steering (4 tasks)

1. Define and validate a parent-authored steering-message schema, keyed by
   strict run/task/role IDs and durable queue sequence.
2. Extend the pure activity derivation to active, idle, waiting-input, blocked,
   and exited states without storing the presentation state.
3. Implement `loop steer <run> <task|role> <instruction>` as a control-plane
   mutation that appends only through the parent-owned board path.
4. Integrate safe delivery at the next dispatch/repair prompt boundary and test
   that blocked sessions are never injected into; surface the state in monitor
   and dashboard.

Guardrails: no direct agent board writes, no blind terminal injection, and no
instruction delivery that bypasses prompt/sandbox construction.

## Wave 4 — P3 SCM feedback (5 tasks)

1. ADR: trusted-parent network ownership, GitHub credential handling, rate limits,
   redaction, and observation retention.
2. Add `loop pr open <run>` against the integration branch with explicit user
   intent and testable `gh` abstraction.
3. Implement normalized PR/check/review observation facts and a polling
   scheduler with injectable clock and no sleeps-as-sync.
4. Add `loop pr watch <run>` that turns changed failed checks, review comments,
   and conflicts into idempotent repair tasks with redacted context.
5. Test observer fact → repair queue → existing repair pipeline end to end.

Guardrails: only the trusted parent gets network credentials; agents receive
sanitized task context and continue to run in their normal sandbox/scope.

## Wave 5 — P4 adapter registry (5 tasks)

1. ADR: adapter contract and compatibility/versioning rules.
2. Extract the existing provider command, prompt transport, normalized-output,
   usage, limit, and read-only behaviors behind strict interfaces.
3. Add registry construction and conformance fixtures for worker and reviewer
   adapters without changing current provider behavior.
4. Move existing Claude, Codex, Gemini, and custom implementations through the
   registry with focused compatibility tests.
5. Add `opencode` plus one further real adapter through the same contract and
   publish an adapter-authoring guide.

Guardrails: adapters cannot choose an uncontained launcher or mint settlement
authority; all provider paths retain the existing evidence flow.

## Wave 6 — P5 live observability (4 tasks)

1. Add a dashboard SSE client with ordering/reconnect handling and polling
   fallback, consuming P1’s derived views.
2. Define redacted, bounded transcript-tail events and a per-agent stream
   endpoint; test secret-shaped data never reaches the browser.
3. Add a dependency-free session inspector for task, attempt patch summary,
   verification output, review verdict, spend, and derived activity.
4. Integrate monitor/dashboard event rendering and perform a loopback-only
   browser/API smoke test.

Guardrails: no build dependency for the dashboard, no network bind beyond
loopback, bounded data retention, and no raw credential/config exposure.

## Wave 7 — P6 product documentation (5 tasks)

1. Write Loop’s own architecture document: observation, parent update paths,
   derivation, board compaction, settlement, and containment.
2. Complete ADRs for the P1 storage/event decision, P2 steering, P3 SCM, P4
   adapter contract, and P5 streaming/redaction decisions.
3. Publish the adapter-authoring guide and control-plane/API reference.
4. Update the AO comparison against the merged tree, retaining source citations
   and explicitly stating safety-model divergences.
5. Run a docs-claim audit against source and add release notes that distinguish
   shipped functionality from planned work.

## Slice discipline

Each numbered wave is intentionally 3–8 independently reviewable tasks. Every
implementation task must include tests and docs in the same diff, use the
project’s authoritative `npm run typecheck`, `npm test`, and `npm run build`
commands as applicable, and leave tests, CI configuration, and safety gates
unchanged except where a reviewed parity task explicitly restores a verified
scope test under the P0 ADR.
