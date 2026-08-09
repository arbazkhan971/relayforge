# RelayForge implementation status and handoff

Last updated: 2026-08-09 UTC

This is the operational handoff for the RelayForge completion campaign. It is
deliberately honest about unfinished release gates. Product behavior and safety
claims remain governed by the code, tests, ADRs, and phase reference audits.

## Repository state

- Working branch: `agent/loop-engineering-hardening`
- Remote checkpoint: `origin/agent/loop-engineering-hardening`
- Last pushed commit: `73051d510c6473fa763bc7cd81921f65bec00eea`
- Package candidate: `relayforge@1.0.0-rc.1`
- The large P0-P7 integration is still an uncommitted working-tree change. Do
  not treat the pushed SHA above as the completed RelayForge release candidate.
- Superset is explicitly excluded. A final zero-result case-insensitive source,
  documentation, and workflow scan is required before the RC commit.

## Phase status

| Phase | Capability | Status | Current evidence |
| --- | --- | --- | --- |
| P0 | Worktree provisioning and baseline streaming repair | Implemented | Provision matrix 99/99; six-million-frame path reduced from about 24.2 s to about 3.2 s in direct characterization |
| P0.2 | Delegated verifier cgroup jail | Implemented | Required-host 21/21; nested production-jail suites 46/46 and 193/193 with zero skips |
| P1 | Durable SQLite control plane, loopback HTTP/SSE, dashboard, migration, cutover | Implemented | Control plane, store, protocol, service, dashboard, and cutover focused suites green; prior aggregate 210/210 |
| P2 | Parent-owned future-boundary steering | Implemented | Real CLI run/steer/provider journey 1/1 on bwrap+cgroup; adjacent steering/authority 25/25 |
| P3 | SCM publication, CI/review observation, reaction bridge | Implemented | P3 focused aggregate 155/155; publication bridge is included in the P6 restart gates |
| P4 | Capability adapter registry and native OpenCode/Pi/Grok adapters | In progress | Registry/codecs/routes are implemented. OpenCode production collection reached 52/52, but an adversarial review found evidence-binding defects that must be fixed before shipment. Pi and Grok production collection still fail closed. |
| P5 | Transcript ingestion, live control room, reconnect/degraded handling | Implemented | P5 focused aggregate 125/125; observation failures are non-authoritative and capacity is released |
| P6 | Multi-repository scheduling, isolation, recovery, integration, publication | Implemented, final aggregate pending | Authority 21/21; orchestration 12/12; product recovery/verifier 6/6; publication/SCM/integration 13/13; independent four-file rerun 38/38 |
| P7 | RelayForge identity, packaging, workflow, browser/release proof | In progress | Identity/package/release foundations are green. Strong-runner and packed Chrome gates are being completed. |

## Completed architectural guarantees

- Canonical run facts live in a run-scoped SQLite event history with explicit
  projections, sequence and generation fences, transactional compare-and-swap,
  snapshots, integrity checks, and crash recovery.
- Agent execution uses isolated worktrees, parent-owned sandboxing, exact
  process/cgroup settlement, bounded transcripts, and deterministic replay.
- Verifier cgroup delegation is behaviorally proved on capable Linux hosts; it
  fails closed on unsupported hosts.
- Steering is accepted only by the live parent and enters a later immutable
  attempt prompt. It never uses terminal key injection or direct SQLite writes.
- SCM polling/publication and repair reactions are durable facts. Publication is
  completed before the scheduler records terminal task completion and resumes
  after crashes without repeating the worker or remote effect.
- Multi-repository workers see only their declared repository vector and exact
  provider state. An undeclared third repository, host credentials, parent
  directories, and unrelated provider state are not mounted.
- Multi-repository integration authority uses staged, fsynced claims, exact
  receipt/inode validation, retryable whole-directory withdrawal, and
  dead-owner recovery.
- Observability is derived and non-authoritative: ingestion or presentation
  failure cannot change provider, task, verification, or settlement truth.
- OpenCode, Pi, and Grok descriptors share the same bounded transport,
  transcript, cancellation, and settlement path. No descriptor can spawn or
  mint authority.
- RelayForge intentionally does not expose Grok persistent auto-approval
  (`--yolo`/`--always-approve`). Worker permissions are parent-mediated,
  one-request `allow_once`; reviewer permissions are denied.

## Open release blockers

1. **OpenCode evidence hardening and product preflight**
   - Bind the exact clean checkout HEAD to the requested commit before and after
     collection.
   - Make collector, same-job consumer, and receipt extractor derive the same
     controlled configuration hash.
   - Derive prompt, streaming, accounting, no-write, reviewer-denial, and replay
     checks from specific observed facts rather than aggregate labels.
   - Pin one executable identity across version probe and every turn; reject
     substitution.
   - Load verified availability into ordinary `relayforge run --execute` before
     any canonical run/worktree mutation. Any paid probe needs explicit operator
     authorization and accounting.
2. **Pi production characterization**
   - Prove exact version, state/stats, prompt, reviewer helper denial,
     cooperative abort, transcript replay, terminal settlement, and ordinary
     post-availability route.
3. **Grok production characterization**
   - Complete the same gates plus private configuration and the exact xAI-only
     egress policy.
   - Make proxy shutdown attempt-all and replacement-safe; never leak tunnels or
     unlink a foreign/replaced socket.
   - Bind decision, socket, cleanup, and active-probe evidence into the durable
     call settlement and recovery record.
4. **Release verification**
   - Run the full strong-backend slice and contained-success source smoke on the
     same required cgroup runner.
   - Run the real P2 CLI steering journey there with fallback forbidden.
   - Install the exact tarball and pass a real headless-Chrome dashboard
     connected/degraded/recovered journey.
   - Collect and immediately consume real OpenCode, Pi, and Grok evidence on the
     designated private runner. This workstation lacks OpenCode/Pi and provider
     credentials, so those receipts cannot honestly be produced here.
5. **Final reconciliation**
   - Update public capability prose, phase status headers, campaign state,
     integration log, roadmap, and final report to the final source and counts.
   - Commit the complete tree and rerun every required gate on that committed
     HEAD. Only then is an RC tag eligible.

## Required final gate

Run from a clean committed checkout:

```bash
git diff --check
rg -n -i 'superset' . --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**'
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
```

The Superset command must return no matches. On the designated Linux runner,
also require the cgroup gate, full strong-backend validation, the P2 production
journey, all three native collector/consumer gates, packed browser smoke, exact
tarball verification, and clean-install smoke. Do not convert missing tools,
credentials, or containment into skips.

## Reference and design index

- [Architecture](architecture.md)
- [Safety model](safety.md)
- [Configuration](configuration.md)
- [Publishing and release gates](publishing.md)
- [Upstream source and legal ledger](upstream-sources.md)
- [Ecosystem watch](ecosystem-watch.md)
- [P1 control-plane audit](reference/phase-01-control-plane-audit.md)
- [P2 steering audit](reference/phase-02-session-steering-audit.md)
- [P3 SCM audit](reference/phase-03-scm-feedback-audit.md)
- [P4 adapter audit](reference/phase-04-adapter-registry-audit.md)
- [P5 observability audit](reference/phase-05-live-observability-audit.md)
- [P6 multi-repository audit](reference/phase-06-multi-repository-audit.md)
- [P7 release audit](reference/phase-07-release-audit.md)

## Resume order

1. Finish and adversarially review P4 OpenCode evidence and ordinary-run
   preflight.
2. Implement Pi, then Grok production characterization through the same path.
3. Finish P7 strong-runner and packed-browser gates.
4. Run focused regressions, then the complete uncommitted-tree matrix.
5. Reconcile this tracker and all release documentation.
6. Create one reviewed integration commit, rerun the entire matrix on committed
   HEAD, push the branch, and publish/tag only with explicit operator authority.
