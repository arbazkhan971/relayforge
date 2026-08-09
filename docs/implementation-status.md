# RelayForge implementation status and handoff

Last updated: 2026-08-09 UTC

This is the operational handoff for the RelayForge completion campaign. It is
deliberately honest about unfinished release gates. Product behavior and safety
claims remain governed by the code, tests, ADRs, and phase reference audits.

**Canonical shareable handoff tracker.** Use this document as the single resume
surface for release blockers versus operator-only external actions.

## Repository state

| Item | Value |
| --- | --- |
| Working branch | `agent/loop-engineering-hardening` |
| Remote checkpoint | `origin/agent/loop-engineering-hardening` |
| Last pushed handoff commit | `860688c55207be051431d470b44b038025a12e5c` (`860688c` — `docs: add RelayForge implementation handoff`) |
| Package candidate identity | `relayforge@1.0.0-rc.1` |
| Integration commit on committed HEAD | **Not created** — large integration source tree is dirty/uncommitted beyond `860688c`; no final integration SHA exists yet |
| Tag / npm publish / GitHub release / repository rename | **None performed** |
| Real native provider receipts | **None collected** (OpenCode/Pi/Grok release receipts remain open) |

Do not treat `860688c` as the completed release-candidate product tree. It is
only the last pushed documentation handoff checkpoint on the branch. Final
committed-HEAD gates remain pending until the integration commit lands and is
re-proved clean.

## Phase status

| Phase | Capability | Status | Current evidence |
| --- | --- | --- | --- |
| P0 | Worktree provisioning and baseline streaming repair | Implemented | Provision matrix **99/99**; six-million-frame path reduced from about 24.2 s to about 3.2 s in direct characterization |
| P0.2 | Delegated verifier cgroup jail | Implemented | Required-host **21/21**; nested production-jail suites **46/46** and **193/193** with zero skips; exact cgroup/no-leak characterization on the required host |
| P1 | Durable SQLite control plane, loopback HTTP/SSE, dashboard, migration, cutover | Implemented | Control plane, store, protocol, service, dashboard, and cutover focused suites green; prior focused aggregate **210/210** |
| P2 | Parent-owned future-boundary steering | Implemented | Actual CLI live steering E2E **1/1** on bwrap+cgroup with exact cgroup/no-leak proof; adjacent steering/authority **25/25** |
| P3 | SCM publication, CI/review observation, reaction bridge | **Product-integrated** | P3 focused aggregate **155/155**; explicit SCM/P6 publication config drives recoverable publication, parent polling, durable observations, and reaction-to-P2 steering. Unconfigured runs perform no remote publication |
| P4 | Capability adapter registry and native OpenCode/Pi/Grok adapters | Implemented (release receipts open) | Registry, codecs, routes, and fail-closed native policy are product-integrated. OpenCode production characterization exists with hardened fixture/required-host tests; a real release receipt still needs the designated runner, exact installed binary, and live credential. Pi and Grok production characterizations remain **typed unavailable** and emit **no** release receipt. Ordinary OpenCode/Pi/Grok product execution currently **refuses before run/control/worktree mutation** because product evidence injection is intentionally not supported yet. The publishable release workflow requires distinct same-runner OpenCode, Pi, and Grok receipts and remains **fail-closed** |
| P5 | Transcript ingestion, live control room, reconnect/degraded handling | Implemented | P5 focused aggregate **125/125**; observation failures are non-authoritative and capacity is released |
| P6 | Multi-repository scheduling, isolation, recovery, integration, publication | **Product-integrated** | Strict config/validation, actual CLI run route, canonical ControlStore facts/views, exact repository-set authority, DAG and scheduler, all-or-nothing worktree group, worker/verification through the canonical contained transport and settlement path, vector integration, publication bridge, exact read isolation, durable crash recovery, and real product E2Es. Focused counts: authority **21/21**; orchestration **12/12**; product/recovery/verifier **6/6**; publication/SCM/integration **13/13** |
| P7 | RelayForge identity, packaging, workflow, browser/release proof | Local gates green; release commit pending | Identity/package/release foundations present. Required-cgroup dirty-tree aggregate, source smoke, exact preview tarball, and packed real-browser gate are **GREEN** (see below). Release readiness is **not** complete until the integration commit and full committed-HEAD rerun/push |

## Dirty-tree verification evidence (not committed-HEAD)

These results were recorded on the **current dirty integration tree**, not on a
clean committed HEAD. They prove material completeness of the uncommitted work
but do **not** substitute for the final committed-HEAD matrix.

| Gate | Result |
| --- | --- |
| Required-cgroup aggregate | **GREEN** — **171** test files, **1,925** tests passed, then a clean TypeScript build |
| Environment | Node **v20.20.2**, npm **10.8.2**, Linux **6.17.0-1021-gcp**, bwrap **0.9.0** |
| Required-cgroup source smoke | **GREEN** — printed exact strong-path marker `SMOKE PASS (contained host — verified delivery on the run branch)`; execute completed, feature stayed on the run branch, original checkout unchanged |
| Exact preview artifact | **GREEN** — deterministic `relayforge-1.0.0-rc.1.tgz`, **1,626,928** bytes, SHA-256 `618ef91fd72c6a551ce21cd11ad753b5a11458ea5a2468ca75e80328db720b84` |
| Exact preview deep smoke | **GREEN** — clean lifecycle-script install, better-sqlite3 native binding load, public ESM and external TypeScript consumer, forbidden authority exports, canonical init/dry run, legacy `loop.config` plus existing `.loop` adoption in place, control service start/status/stop, packed Markdown link closure, unchanged checkouts |
| Packed real-browser gate | **GREEN** on Google Chrome **150.0.7871.128** — bounded result: `schemaVersion` 1, `packageName` relayforge, `version` 1.0.0-rc.1, `fixtureRun` browserfixture, DOM rendered, lifecycle **connected → degraded → recovered**, `serviceReplaced` true |

### Preview defects found and fixed (dirty tree)

The exact preview surfaced two release-artifact defects that were fixed in the
integration tree before the green preview/browser results above:

1. Implementation-only `better-sqlite3` types no longer leak into public
   declarations.
2. The smoke harness asynchronously runs `serve stop` so it can reap the owned
   service child.
3. The legacy `.loop` fixture now adopts the directory init may already create.

## Completed architectural guarantees (landed in source)

These capabilities exist in the current source tree. They are not “planned”:

- Canonical run facts live in a run-scoped SQLite event history with explicit
  projections, sequence and generation fences, transactional compare-and-swap,
  snapshots, integrity checks, and crash recovery (`src/control/`).
- Agent execution uses isolated worktrees, parent-owned sandboxing, exact
  process/cgroup settlement, bounded transcripts, and deterministic replay.
- Verifier cgroup delegation is behaviorally proved on capable Linux hosts; it
  fails closed on unsupported hosts (`src/cgroup-delegation*.ts`, ADR 001).
- Steering is accepted only by the live parent and enters a later immutable
  attempt prompt. It never uses terminal key injection or direct SQLite writes
  (`src/steering/`, ADR 003). Actual CLI live steering E2E is **1/1** with
  adjacent **25/25** and exact cgroup/no-leak proof on the required path.
- SCM publication, observation, reconciliation, and reaction bridging are
  durable parent-owned runtime behavior (`src/scm/`, ADR 004). Explicit SCM/P6
  publication config drives recoverable branch/PR publication and background
  polling; unconfigured runs perform no remote publication.
- Multi-repository scheduling, isolation, recovery, integration, and publication
  are **product-integrated**: strict config/validation, actual CLI run route,
  canonical ControlStore facts/views, exact repository-set authority, DAG and
  scheduler, all-or-nothing worktree group, worker/verification through the
  canonical contained transport and settlement path, vector integration,
  publication bridge, exact read isolation, durable crash recovery, and real
  product E2Es (`src/multirepo/`, ADR 007).
- Observability / control room is derived and non-authoritative: ingestion or
  presentation failure cannot change provider, task, verification, or settlement
  truth (`src/observability/`, `src/control-room/`, ADR 006).
- Adapter registry and native OpenCode/Pi/Grok descriptors share the same bounded
  transport, transcript, cancellation, and settlement path. No descriptor can
  spawn or mint authority (`src/adapters/`, ADR 005).
- RelayForge intentionally does not expose Grok persistent auto-approval
  (`--yolo`/`--always-approve`). Worker permissions are parent-mediated,
  one-request `allow_once`; reviewer permissions are denied.

## Release blockers vs external actions

### Release blockers (must clear before an RC is honest)

1. **Integration commit does not exist yet**
   - Large P0–P7 product integration remains dirty/uncommitted beyond
     `860688c`.
   - No final integration SHA exists. Final committed-HEAD gates cannot be
     claimed until one reviewed integration commit lands and is re-proved.
2. **Native adapter release receipts (fail-closed publish path)**
   - **OpenCode:** production characterization exists and has hardened
     fixture/required-host tests, but a real release receipt needs the
     designated runner, exact installed binary, and live credential.
   - **Pi:** production characterization is still **typed unavailable** and
     emits **no** release receipt.
   - **Grok:** production characterization is still **typed unavailable** and
     emits **no** release receipt.
   - Ordinary OpenCode/Pi/Grok product execution currently **refuses before**
     run/control/worktree mutation because product evidence injection is
     intentionally not supported yet.
   - The publishable release workflow requires **distinct same-runner**
     OpenCode, Pi, and Grok receipts, so it remains **fail-closed**.
3. **Final committed-HEAD aggregate / push**
   - After the integration commit: rerun full aggregate, source smoke, focused
     strong gates, exact preview + Chrome, and clean-tree scans on that clean
     HEAD; then push.

### External actions (operator authority only; not release-engineering code work)

These have **not** been performed and are not implied by source readiness:

- `git tag` for an RC or release
- `npm publish` of `relayforge`
- GitHub Release creation
- Repository rename (product identity may be RelayForge in source without any
  remote rename)
- Real native provider receipt collection on the designated runner

Publishing steps remain in [publishing.md](publishing.md) and require explicit
operator authority after committed-HEAD gates are green **and** distinct
same-runner OpenCode/Pi/Grok receipts exist.

## Required final gate

Run from a **clean committed** checkout of the integration commit (not a dirty
shared worktree):

```bash
git status --short   # must be clean for the RC claim
git diff --check
# Case-insensitive excluded-product-name scan across source/docs/workflows
# (must return zero matches; see publishing runbook for the exact pattern)
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
```

On the designated Linux runner, also require:

- cgroup required-host gate (no skip conversion)
- full strong-backend validation / contained-success source smoke
- real P2 CLI live steering journey with fallback forbidden
- OpenCode/Pi/Grok collector/consumer with real designated-runner receipts
  (exact installed binary + live credential where required)
- packed real-browser gate (already green on dirty tree; must re-prove on
  committed HEAD)
- exact tarball verification and clean-install smoke (already green on dirty
  tree; must re-prove on committed HEAD)

Do not convert missing tools, credentials, or containment into skips.

## Reference and design index

- [Architecture](architecture.md)
- [Safety model](safety.md)
- [Configuration](configuration.md)
- [Session steering](session-steering.md)
- [Publishing and release gates](publishing.md)
- [Upstream source and legal ledger](upstream-sources.md)
- [Ecosystem watch](ecosystem-watch.md)
- [P0 provisioning audit](reference/phase-00-worktree-provisioning-audit.md)
- [P0.2 cgroup audit](reference/phase-00-2-verifier-cgroup-delegation-audit.md)
- [P1 control-plane audit](reference/phase-01-control-plane-audit.md)
- [P2 steering audit](reference/phase-02-session-steering-audit.md)
- [P3 SCM audit](reference/phase-03-scm-feedback-audit.md)
- [P4 adapter audit](reference/phase-04-adapter-registry-audit.md)
- [P5 observability audit](reference/phase-05-live-observability-audit.md)
- [P6 multi-repository audit](reference/phase-06-multi-repository-audit.md)
- [P7 release audit](reference/phase-07-release-audit.md)

## Exact remaining-action sequence

1. **Do not** tag, publish, rename, or invent native receipts.
2. **Inspect/stage** the dirty integration tree for one reviewed integration
   commit of the complete product tree on `agent/loop-engineering-hardening`.
3. **Create the integration commit** (no final integration SHA exists yet).
4. **Rerun the full committed-HEAD matrix** on that clean HEAD:
   - required-cgroup aggregate (expect parity with dirty-tree **171** files /
     **1,925** tests + clean TypeScript build)
   - required-cgroup source smoke (strong-path marker)
   - focused strong gates as needed
   - exact preview tarball + deep smoke
   - packed real-browser Chrome gate
   - clean-tree / excluded-name scans
5. **Push** the branch with the integration commit.
6. **Separately**, implement and collect real **Pi**, **Grok**, and **OpenCode**
   same-runner release receipts (designated runner, exact installed binary, live
   credential where required) **before any** tag or npm publish.
7. Only with explicit operator authority after steps 4–6: tag, npm publish,
   GitHub Release, or repository rename.

### Focused verification commands (optional before full suite)

Do not treat these as a substitute for the committed-HEAD aggregate:

```bash
# P2 live steering E2E (required-host / bwrap+cgroup path)
npx vitest run tests/steering-cli-run-e2e.test.ts

# P6 product-integrated slices (as previously recorded)
npx vitest run tests/multirepo-authority.test.ts \
  tests/multirepo-orchestration.test.ts \
  tests/multirepo-product-recovery.test.ts \
  tests/multirepo-product.test.ts \
  tests/multirepo-verifier-authority.test.ts \
  tests/multirepo-publication.test.ts \
  tests/multirepo-integration.test.ts \
  tests/scm-multirepo-bridge.test.ts

# OpenCode collector / focused adapter path (real receipt only on designated
# runner with exact binary + live credential; never invent receipts)
npx vitest run tests/adapter-collector.test.ts tests/adapter-opencode.test.ts
```
