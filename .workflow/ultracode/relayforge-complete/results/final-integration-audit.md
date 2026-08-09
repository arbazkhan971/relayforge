# Independent final integration audit

Audit snapshot: 2026-08-09T15:29:12Z

Committed baseline: `73051d510c6473fa763bc7cd81921f65bec00eea`

Working branch: `agent/loop-engineering-hardening`, seven commits ahead of its
remote and materially dirty. The `v1.0.0-rc.1` tag was absent at this snapshot.
Other agents were still integrating P3/P5 and P4/release work, so the items
explicitly labelled **active integration** below must be re-audited after those
lanes return. This audit made no product or documentation changes.

## Release-candidate verdict

**Not release eligible.** Two additional P6 product blockers remain outside the
active P3/P4/P5 integration lanes: the product sandbox exposes undeclared
repositories for read, and the production multi-repository worker cannot recover
the documented crash window after dispatch acknowledgement. The active lanes also
have product-wiring and release-workflow gaps at this snapshot. Finally, no
committed-HEAD/full-suite/build/real-host/browser evidence exists for the integrated
tree yet.

## Severity-ranked closure findings

### BLOCKER RF-RC-01 — P6 repository capability is write-scoped, not read-scoped

This is a core multi-repository capability failure, not a general cybersecurity
request.

Exact promised boundary:

- `docs/adr/007-multi-repository-execution.md:90-92` says a third repository is
  **neither mounted nor included**.
- The same ADR's mandatory gate at `:196-199` requires a non-skipping E2E in
  which a child changes exactly two repositories and cannot observe a third.
- The phase audit's architectural gate at
  `.workflow/ultracode/relayforge-complete/results/audit-p6-multi-repository.md:494-505`
  requires the provider to be restricted to the declared repository capability
  set (`:499`) and every process call to use the contained transport (`:501-502`).
- Its required real-child test at `:562-564` repeats the exact two-authorized,
  third-unobservable, recoverable-landing promise.

Actual product behavior:

- `src/sandbox.ts:228-239` begins every Bubblewrap provider jail with
  `--ro-bind / /`. The later binds only make selected paths writable; they do not
  restrict reads.
- `src/orchestrator.ts:1120-1134` accepts only writable roots. It has no read
  capability set or mount allowlist.
- `src/multirepo/runtime.ts:100-123` supplies the first worktree as `cwd` and the
  remaining member paths as extra **writable** roots. An undeclared sibling
  repository, the repository parent, and unrelated host files remain visible
  read-only through the root bind. A prompt instruction at `:102-105` is not an
  enforcement boundary.

Current tests do not prove the product promise:

- `tests/sandbox.test.ts:24-36` positively locks in `--ro-bind / /` and checks
  only that an undeclared path is not writable.
- `tests/multirepo-orchestration.test.ts:182-208` uses a test-only Node
  `--experimental-permission` fake worker rather than RelayForge's product
  sandbox.
- `tests/multirepo-product.test.ts:100-108` calls `setTrustedRunner(true)` and
  creates only the two authorized repositories, so it bypasses the OS boundary
  and has no negative third-repository assertion.

Narrow closure design:

1. Give provider execution a first-class read/write mount-capability policy.
   Construct an isolated/minimal root, then bind only audited runtime executable
   and dependency roots read-only, exact authorized worktrees with their role's
   access, exact private adapter/auth state, and the minimum runtime system files.
   Do not mount `/`, a repository parent, or the operator home as a general
   read-only source. Keep verifier mounts separately scoped.
2. If a provider CLI cannot run under that explicit policy, report the capability
   unavailable before reservation; do not silently widen the mount set.
3. Add deterministic argv tests rejecting `/`, the repository parent, `$HOME`,
   `.ssh`, and every unlisted repository as bind sources.
4. Add a required Linux product E2E using real Bubblewrap with no
   `setTrustedRunner`: create two authorized repositories plus a sibling third
   repository and credential sentinel; prove the child can edit both authorized
   trees, receives `ENOENT`/`EACCES` for the third tree and sentinel, cannot
   enumerate their parent, then prove exact cgroup settlement/reap and the
   verified vector landing.

### BLOCKER RF-RC-02 — production P6 cannot recover an acknowledged worker settlement

`src/multirepo/orchestration.ts:1477-1555` correctly treats an existing durable
dispatch identity with no canonical `multirepo.worker_settled` fact as a recovery
case. It calls `worker.recover()` at `:1497-1505`; an absent result permanently
marks the lease uncertain and raises `WORKER_RECOVERY_REQUIRED`.

The product worker, however, implements `recover()` as unconditional
`undefined` at `src/multirepo/runtime.ts:142-145`. A crash after the central
provider/ledger/transcript settlement has become durable but before
`appendCanonical(...worker_settled...)` at
`src/multirepo/orchestration.ts:1539-1549` therefore cannot finish after restart.
This contradicts the P6 crash/reconcile gate at
`audit-p6-multi-repository.md:525-527`, the recoverable-transaction E2E at
`:562-564`, and arbitrary crash/retry requirements at `:568-570`.

`tests/multirepo-orchestration.test.ts:331-359` does not characterize product
restart: its settlement survives only in a local `remembered` variable and its
fake `recover()` returns that object.

Narrow closure design and tests:

1. Before the worker returns, durably record a parent-authored recovery receipt
   bound to run/epoch, task and generation, attempt, lease token, exact process
   incarnation, settlement call ID, transcript digest, protocol result, and
   trusted scope-empty/reap evidence.
2. Implement production `recover()` by reopening and revalidating the exact
   ledger settlement, transcript, process identity/scope result, and receipt;
   reconstruct only the closed settlement shape already accepted by
   `settlementShapeValid`. Any mismatch remains recovery-required.
3. Add a real subprocess crash-injection E2E: kill the parent after durable
   provider settlement and before the canonical worker fact, start a fresh
   process, prove exactly one provider launch, recover the same settlement, and
   complete integration. Cover truncation, wrong task/generation/lease,
   transcript replacement, missing scope proof, and live/unknown predecessor as
   refusal cases.

### BLOCKER RF-RC-03 — release workflow cannot produce its non-preview artifact (**active P4/release integration**)

At this snapshot `.github/workflows/release.yml:40-53` runs only the OpenCode and
Pi required-adapter tests; it neither runs Grok nor creates a canonical
same-runner receipt bundle. The artifact job at `:54-71` runs
`release-artifact.mjs` without `--native-adapter-receipts` on a different runner.
That deterministically conflicts with `scripts/release-artifact.mjs:220-238`,
which refuses every non-preview artifact without exact-HEAD, same-runner,
distinct OpenCode/Pi/Grok receipts. The receipt validation itself is sound at
`:56-85`; the workflow has no producer/handoff.

Close by producing all three receipts in one required contained-adapter job,
binding the bundle to the checked-out commit and runner/cgroup identity, uploading
it as an artifact, downloading it without lossy reserialization, checking owner,
mode, digest and commit again, and passing its absolute path to the artifact
builder. Extend `tests/release-workflow.test.ts` with failure cases for a missing
Grok job, different-runner receipts, missing handoff, wrong commit, permissive
mode, and an artifact job that omits the bundle. This lane was already assigned;
do not duplicate it, but do not call the release workflow green until the
integrated workflow test and a real designated-runner run pass.

### HIGH RF-RC-04 — native OpenCode/Pi/Grok routes have no ordinary-CLI evidence producer (**active P4 integration**)

The structured Grok/OpenCode/Pi routing and central settlement path are present:
`src/orchestrator.ts:2777-2906` constructs exact protocol traffic and
`:2947-3037` uses the common containment/transport/settlement kernel. The route
correctly refuses without exact evidence in `exactNativeAvailability` at
`:2647-2700`.

No production code currently assigns `RunContext.adapterAvailability`; the only
assignments are test injection in `tests/adapter-native-routing.test.ts:111,151`.
`runDoctor` accepts externally supplied evidence at `src/doctor.ts:63-68`, but
ordinary `runDoctorWithControl` drops it at `:356-365`, and the CLI calls that
zero-evidence path at `src/cli.ts:181-195`. README accurately admits the route is
unusable at `README.md:178-184`.

Close the already-active collector lane with a parent-contained, exact-runtime
probe before reservation; bind evidence to executable identity, controlled
configuration, nonce/freshness and role policy; feed the same immutable evidence
to doctor and the run context; add ordinary-CLI fixture journeys for each native
adapter plus changed-executable/config/stale-evidence refusals. Grok `--yolo` must
remain rejected as product configuration; the supported Grok route should use
the audited ACP invocation, not a permission-bypass flag.

### HIGH RF-RC-05 — P3 SCM lifecycle is component-complete but not a product journey (**active Hegel integration**)

`createParentScmLifecycle` exists at `src/scm/lifecycle.ts:558`, but no production
caller exists; current callers are tests. Multi-repository publication is
explicitly rejected before mutation by `src/config/validate.ts:198-202` and
`src/multirepo/runtime.ts:274-278`, and the P6 factory dependency construction at
`src/multirepo/runtime.ts:300-316` supplies no publication adapter.

The P3 audit explicitly assigns configuration/lifecycle/REST-SSE/doctor/CLI
integration at `audit-p3-scm-feedback.md:550-562` and requires the complete bare
remote + fake bounded GitHub feedback/repair/restart journey at `:538-548`.
Finish the already-active P3 lane and run that product-level journey; component
tests alone do not satisfy P3 E/F.

### HIGH RF-RC-06 — P5 projection exists, but product transcript ingestion/terminal control room is disconnected (**active Hegel integration**)

`createParentTranscriptObservationCoordinator` is defined only in
`src/observability/parent-coordinator.ts:126-267`; no product caller currently
creates one. The loop's parent authority hook in `src/cli.ts:473-506` starts
steering and P6 only. The ordinary monitor builds `{ boardDir, session, panes,
intervalMs }` at `src/cli.ts:557-596` and never supplies the optional normalized
`controlRoom` model accepted by `src/monitor.ts:39-47`; it therefore renders the
unknown/absent branch at `src/monitor.ts:101-110`.

The REST read-model adapter exists (`src/control/service.ts:258-263,337-344`), but
without parent transcript ingestion it has no normal provider observation stream.
Finish the assigned integration with lifecycle-bound transcript coordinators,
restart/source-replacement/privacy tests, browser and terminal parity, and an
ordinary executing-run E2E. Raw terminal capture must remain non-authoritative.

### HIGH RF-RC-07 — the root package exports mutation authority (**active P4/P7 API integration**)

The closed subpath map in `package.json:20-47` blocks internal path guessing, but
the root barrel still exports `runAutonomyLoop` (`src/index.ts:8-15`),
`ControlStore`/`openControlStore` (`:18-34`), the full steering surface (`:59`),
and broad adapter implementation modules (`:60-73`).
`tests/package-exports.test.ts:36-67` currently requires several of those
mutation-capable symbols, so it proves a broad allowlist rather than a safe
embedding boundary. This is consequential because P7 promises reviewed,
allowlisted public exports and inaccessible authority internals
(`audit-p7-release-rebrand.md:270-275`).

Complete the active API review by exporting operator-facing clients, immutable
types and read models from the root/subpaths, while keeping store construction,
run-parent execution, append/lease/settlement and raw adapter internals private.
If a trusted embedding API is intentionally supported, expose a narrow facade
that obtains normal ownership/lease/capability checks and document that trust
contract. Add negative packed-package and declaration tests for every mutation
authority name, not just unexported file paths.

### HIGH RF-RC-08 — the integrated object has not passed the release authority gate

The working tree is materially dirty and `v1.0.0-rc.1` is absent. The plan's
definition of done requires typecheck, full tests and build on committed HEAD,
real loopback/browser/CLI/Git/worktree smokes, truthful documentation, and no
material verification remainder (`plan.md:47-61`). P7 requires the same exact
commit/tag/artifact/real-host chain at `audit-p7-release-rebrand.md:279-299` and
its exit gate at `:358-364`.

After all integration lanes and RF-RC-01/02 close: review the final diff, commit,
run the complete gate on that immutable object, run required cgroup and all three
native adapters without skip on designated Linux hosts, run real Git/worktree,
CLI/control-service and browser/SSE journeys, generate and install the exact
packed tarball, then create the matching tag only through the reviewed release
process. Do not transfer pre-commit test results to the final commit.

### MEDIUM RF-RC-09 — shipped documentation contradicts product source and includes non-working commands

- `README.md:45-46,303-310`, `docs/safety.md:124-131`, and
  `docs/architecture.md:216-234` say P6 is not wired/config-enabled. In this tree,
  `src/cli.ts:503-506` does start the P6 product authority and semantic validation
  accepts the supported local-integration subset.
- README's steering example uses nonexistent `--generation` and `--text` flags at
  `README.md:235-249`; `docs/autonomous-team.md:90-102` repeats them. The actual
  CLI requires task/session IDs and generations, a not-before attempt, and
  `--body` at `src/cli.ts:309-348`.
- Any P3/P4/P5 claims must be rewritten only after their active product wiring
  lands; the current native-unavailable statement at `README.md:181-184` is still
  truthful at this snapshot.

Update docs from final source behavior, then add a documentation-contract test
that executes or validates copied CLI examples and checks major capability claims
against configuration and export behavior. P7's own failure matrix requires this
at `audit-p7-release-rebrand.md:321-324`.

### MEDIUM RF-RC-10 — workflow bookkeeping is stale and still contains unresolved wording

- `.workflow/ultracode/relayforge-complete/state.json:4-30` records only work
  through P1, leaves P0.2/P1 running, and reports an old 832-test checkpoint.
- `.workflow/ultracode/relayforge-complete/orchestration.md:21-46` still marks old
  P0.1 packets running and only lists later phases as future work.
- `.workflow/ultracode/relayforge-complete/final-report.md:1-5` still says the run
  is in progress.
- `results/audit-p02-agent-sandboxes.md:312-318` retains a material
  “Verification still needed” list even though much of its evidence appears to
  have been resolved in `docs/adr/001-verifier-cgroup-delegation.md:41-69` and
  `:191-220`. The definition of done explicitly permits no material item under
  that heading.

Reconcile these files only after the final gates: mark exact packet outcomes,
link each formerly open verification item to its evidence or leave the release
ineligible, record the final commit/host/tool versions/test totals, and state all
external operator actions honestly.

## User-requested reference work already complete

- The requested parallel comparison with
  `claude/agent-orchestrator-ref-i63kd1` is recorded with exact pins, source,
  tests, history, license and `NOT_USED` decision in
  `docs/upstream-sources.md:1451-1489` and
  `docs/ecosystem-watch.md:223-233`.
- Grok has a first-class closed descriptor, ACP protocol implementation, privacy
  policy and release-evidence model. “Supported end to end” remains contingent on
  RF-RC-03/04 and a real exact-build required-host pass. User-invoked Grok
  `--yolo` research is recorded as read-only reference assistance; product
  permission bypass remains correctly rejected.

## Read-only checks performed for this audit

- `git diff --check` — passed at the snapshot.
- `npm run typecheck -- --pretty false` — passed at the snapshot.
- Focused Vitest selection covering P6 product authority, run-parent authority,
  native routing/evidence, SCM product policy/view, observability/control room,
  package exports, and release workflow/artifact policy — passed.

These focused results are useful diagnostics only. They are not the required full
suite/build, committed-HEAD, real-host, real-Git or browser release evidence.

## Required closure order

1. Finish and independently re-audit the active P3/P5 and P4/release/API lanes.
2. Fix RF-RC-01's read-capability mount boundary and add the real three-repository
   containment/landing gate.
3. Fix RF-RC-02's durable worker recovery and pass the real parent-crash/restart
   gate with exactly one launch.
4. Make the release receipt workflow executable, then pass real OpenCode, Pi,
   Grok and delegated-cgroup gates on exact integrated HEAD.
5. Align docs and workflow state with final behavior; eliminate every material
   “verification still needed” item.
6. Commit once, run the entire definition-of-done matrix on that immutable
   object, build/install/test the exact tarball, and only then produce the RC tag
   and final evidence report.

---

# RF-RC resolution ledger

Resolution checkpoint: 2026-08-09T16:54:15Z

The audit above is preserved as the dated 2026-08-09T15:29:12Z historical
snapshot. This append-only ledger records what changed afterward. A
`RESOLVED_AT_CHECKPOINT` status means the original product defect has direct
working-tree source and focused-test evidence; it does **not** transfer that
evidence to a future commit or release artifact. `OPEN` means at least one
release-blocking condition still lacks evidence. The repository remains
materially dirty at baseline `73051d510c6473fa763bc7cd81921f65bec00eea`, the
`v1.0.0-rc.1` tag is still absent, and the final aggregate and committed-HEAD
gates have not run.

| Finding | Checkpoint status | Resolution disposition |
| --- | --- | --- |
| RF-RC-01 | `RESOLVED_AT_CHECKPOINT` | Empty-root provider and verifier filesystem capabilities now hide undeclared repositories and host/process paths. Final aggregate and committed-HEAD reruns remain pending. |
| RF-RC-02 | `RESOLVED_AT_CHECKPOINT` | Product recovery now reconstructs only ledger-attested, exact-fence settlement receipts and the real two-window SIGKILL journey resumes with one provider launch. Final aggregate and committed-HEAD reruns remain pending. |
| RF-RC-03 | `OPEN` | The same-runner three-adapter workflow and receipt-bundle topology are implemented and focused tests pass, but the production collector facade and real native receipts do not exist yet. |
| RF-RC-04 | `OPEN` | Envelope, runtime and route primitives exist, but ordinary production collection and real OpenCode/Pi/Grok contained evidence remain unproved. |
| RF-RC-05 | `RESOLVED_AT_CHECKPOINT` | P3 is now parent-owned product lifecycle: bounded config/credentials, publication bridge, automatic polling, reaction-to-P2, restart and crash reconciliation are wired. |
| RF-RC-06 | `RESOLVED_AT_CHECKPOINT` | P5 transcript ingestion, durable observations/SSE and normalized terminal monitor are now connected to ordinary provider execution and parent teardown. |
| RF-RC-07 | `RESOLVED_AT_CHECKPOINT` | The root facade is authority-free and the packed export map rejects mutation internals; immutable packed-link validation is also present. Final packed/aggregate rerun remains pending. |
| RF-RC-08 | `OPEN` | No immutable committed-HEAD aggregate, required-host, tarball-install, browser or tag evidence exists. |
| RF-RC-09 | `OPEN` | Steering examples and packed relative links are resolved, but the final capability-claim truth pass has not completed on a release object. |
| RF-RC-10 | `OPEN` | Reference-audit structure and the P0.2 verification remainder are resolved; campaign state, orchestration and final-report bookkeeping still describe the earlier in-progress checkpoint. |

## RF-RC-01 resolution evidence — P6 filesystem capability

**Status: `RESOLVED_AT_CHECKPOINT`.**

- `src/sandbox.ts:489-516` selects the closed allowlist path for a
  capability-scoped provider call. `buildAllowlistedBwrapArgs` at
  `src/sandbox.ts:559-643` begins with an empty `--tmpfs /`, validates exact
  readable/writable/runtime/socket identities, rejects a mount that would expose
  an inaccessible descendant, creates only skeleton parents, isolates
  PID/IPC/UTS/cgroup namespaces, and never adds `--ro-bind / /`.
- `src/multirepo/runtime.ts:185-207` binds the exact authorized worktrees,
  separately named Git metadata/runtime roots and the complete configured
  repository set as inaccessible before provider exec. The ordinary broad-root
  sandbox remains available only to non-P6 callers; it is no longer the P6
  capability boundary.
- `tests/multirepo-sandbox.test.ts:53-280` characterizes the empty-root argv,
  real two-writable-repository child, absent third repository/host secret/parent
  listing/host process handles, the exact nested Git-metadata exception,
  provider-private state and identity-pinned Unix relay.
- Exact owning-lane gate:
  `npx vitest run tests/multirepo-sandbox.test.ts tests/multirepo-worker-recovery.test.ts --reporter=verbose`
  passed **15/15**. The real verifier/product gate
  `npx vitest run tests/multirepo-verifier-authority.test.ts tests/multirepo-product-recovery.test.ts --reporter=verbose`
  passed **5/5**. In that second gate,
  `tests/multirepo-verifier-authority.test.ts:61-104` mounts exactly two verifier
  roots under the real cgroup-backed jail and proves the third absent.

This closes the original read-isolation defect. It is not the final release
proof: these exact gates, the aggregate suite and build must be rerun on
committed HEAD and the packed artifact.

## RF-RC-02 resolution evidence — P6 durable worker recovery

**Status: `RESOLVED_AT_CHECKPOINT`.**

- `src/multirepo/worker-recovery.ts:331-373` binds the receipt to run/epoch,
  task and generation, attempt, lease, repository set, exact process identity,
  route/call, ledger epoch, transcript inode/hash/bytes, terminal record,
  protocol-result digest and trusted scope-reap evidence.
- `src/multirepo/worker-recovery.ts:572-640` reopens only the exact
  MAC/ledger-attested settlement, refuses a live or indeterminate predecessor,
  durably reconciles receipt publication, and revalidates the transcript after
  the receipt becomes visible. `src/multirepo/runtime.ts:152-229` uses this store
  for both live `record` and restart `recover`; the former unconditional
  `undefined` product recovery path is gone.
- `tests/multirepo-worker-recovery.test.ts:165-313` covers reopen,
  settlement-before-receipt reconstruction, all three receipt-publication crash
  points, truncation/replacement/in-place mutation, missing scope proof,
  task/generation/lease replay, foreign/symlink/hardlink artifacts and
  live/unknown predecessor refusal.
- The **15/15** leaf command above covers those deterministic cases.
  `tests/multirepo-product-recovery.test.ts:351-367`, within the separate **5/5**
  real gate, sends real SIGKILL at both ledger-settlement-before-receipt and
  receipt-before-canonical windows, restarts from disk, proves exactly one
  provider reserve/settle/launch, preserves the third repository, and lands the
  recovered two-repository vector.

This closes the product recovery defect at the working-tree checkpoint. The
same final aggregate/committed-HEAD qualification caveat as RF-RC-01 applies.

## RF-RC-03 resolution evidence — release workflow and collector

**Status: `OPEN`.** The workflow topology is resolved, but its production input
is not.

- `.github/workflows/release.yml:40-139` now keeps the cgroup proof and all
  OpenCode/Pi/Grok collect-consume-receipt steps on the artifact runner, uses a
  private nonce/workspace, keeps the three credentials in separate steps,
  passes a digest-only bundle to `release-artifact.mjs`, deletes evidence, and
  uploads the tested artifact.
- The owning P4 checkpoint reports the combined
  `release-artifact`/`release-policy`/`release-workflow` suite **23/23**. The
  actual `npm pack --dry-run --json --ignore-scripts` inventory also passed
  `validatePackedMarkdownLinks` for **30 packed Markdown documents and 57
  relative targets**. `tests/release-artifact-policy.test.ts:159-179` contains
  the escape, missing-file, noncanonical-target and unsupported-scheme negative
  cases.
- The blocker remains concrete: `scripts/collect-contained-adapter-evidence.mjs:6`
  imports `dist/adapters/contained-evidence-production.js`, while no matching
  production source/facade exists at this checkpoint. Therefore the workflow
  cannot collect a real receipt. No production native evidence has run for any
  adapter: OpenCode and Pi are absent locally; Grok lacks the required paid
  credential. No real designated-runner artifact exists.

RF-RC-03 stays open until the parent-contained production collector is wired,
all three real receipts are created and consumed on one designated runner, and
the exact committed artifact passes the release policy.

## RF-RC-04 resolution evidence — native adapter availability

**Status: `OPEN`.**

- `src/adapters/contained-evidence-collector.ts:26-173` defines the narrow
  no-spawn authority contract, runtime revalidation, bounded private receipt and
  sentinel exclusion. The native route continues to accept only supplied
  `RunContext.adapterAvailability` (`src/orchestrator.ts:228` and
  `:2733`), so malformed or absent evidence still fails closed.
- There is still no ordinary production caller that implements the missing
  contained probe authority, emits the file, consumes it into doctor and run
  context, and proves the same provider route/settlement lifecycle. Generic
  envelope and collector-finalizer tests cannot substitute for that call.
- The owning P4 checkpoint explicitly records no real OpenCode, Pi or Grok
  receipt; the Grok egress primitive fixture is useful characterization only.

Close only with the production collector/factory, ordinary CLI and doctor
journeys, exact-runtime freshness/config/nonce binding, and all three real
required-host executions. No credential or paid-provider success is inferred.

## RF-RC-05 resolution evidence — P3 product SCM lifecycle

**Status: `RESOLVED_AT_CHECKPOINT`.**

- `src/cli.ts:524-595` creates one parent-owned SCM authority beside steering,
  control service and transcript authority, drains it before borrowed store
  shutdown, and gives P6 a publication adapter only when publication is exactly
  configured.
- `src/scm/product-authority.ts:211-343` materializes bounded credential-host
  runtimes, canonical lifecycle owners and the P6 publication/cross-link bridge.
  `:345-474` owns polling, store wakes, close/drain, immediate restart
  reconciliation and monotonic cadence independent of wall-clock jumps.
- `tests/scm-lifecycle.test.ts:182-258` uses a bare remote plus bounded fake
  GitHub transport to prove intent/ref leasing, one PR, restart, push-before-fact
  and ambiguous-PR reconciliation without duplicate effects.
  `tests/scm-product-authority.test.ts:246-330` proves automatic published-artifact
  polling, stable reaction-to-P2 admission, restart and exact cadence boundary.
  `tests/scm-multirepo-bridge.test.ts:131-165` proves P6 ordering while P3 alone
  owns remote effects and fails closed on cross-link/identity drift.

The original “component-only, no product caller” finding is closed. Final
committed-HEAD aggregation remains RF-RC-08 rather than reopening P3.

## RF-RC-06 resolution evidence — P5 product ingestion and control room

**Status: `RESOLVED_AT_CHECKPOINT`.**

- `src/cli.ts:515-585` owns the transcript runtime for the same borrowed
  ControlStore lifetime and exposes only its observation handle to the parent
  run. `src/orchestrator.ts:3077-3131` opens on the real transcript, treats
  progress/finalize as non-vetoing derived observation, and finalizes once on
  both success and transport throw.
- `src/observability/runtime-authority.ts:165-185` exposes only bounded status;
  per-call ingestion/finalization failures degrade observation without leaking
  capacity or rewriting provider truth.
- `src/cli.ts:681-708` attaches the normalized, read-only control-room client to
  the terminal monitor without reopening a run store. The loopback transport at
  `src/control-room/control-service-transport.ts:127-249` emits metadata-only
  wakes, reports asynchronous loss, uses capped reconnect backoff and invalidates
  stopped connection generations.
- `tests/observability-runtime-authority.test.ts:87-230` runs a real child and
  proves canonical redacted observations plus SSE wakes, then repeatedly injects
  failures and proves zero active-source leak. The parent-coordinator restart,
  rotation and truncation cases are at
  `tests/observability-parent-coordinator.test.ts:97-191`; the real server
  drop/restart/stale-callback case is at
  `tests/control-room-control-service-transport.test.ts:121-163`.

The original disconnected-ingestion and terminal-monitor finding is closed.
Final committed-HEAD aggregation remains RF-RC-08.

## RF-RC-07 resolution evidence — public package facade

**Status: `RESOLVED_AT_CHECKPOINT`.**

- `src/index.ts:1-93` now documents and implements an authority-free root:
  identity/config/data contracts, pure codecs, bounded projections and read-only
  clients remain public; execution, store ownership, mutation, launch,
  settlement and parent lifecycle factories do not.
- `tests/package-exports.test.ts:36-85` positively checks the safe facade and
  negatively checks the named execution/store/server/steering/SCM/observation/
  adapter/multi-repository authority symbols. `:120-140` requires internal deep
  imports to fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- The packed clean-consumer gate compiled approved imports and rejected named
  authority imports at the P4 checkpoint. The separate actual pack inventory
  and **30 documents / 57 relative links** proof recorded under RF-RC-03 closes
  the package-link portion of the final API audit.

These are working-tree/focused proofs. The root and declarations must still be
rebuilt and retested from the eventual committed tarball under RF-RC-08.

## RF-RC-08 resolution evidence — immutable release authority

**Status: `OPEN`.**

The working tree is still materially dirty at the original committed baseline,
and `v1.0.0-rc.1` is absent. No complete aggregate suite/build, required cgroup
and native-adapter matrix, real browser/control-service journey, deterministic
pack/install smoke or registry convergence has run on one immutable commit.
Focused P3/P5/P6/P7 checkpoints cannot be combined into committed-HEAD evidence.
The closure order in the historical audit remains mandatory after RF-RC-03/04
and the remaining bookkeeping/doc truth pass finish.

## RF-RC-09 resolution evidence — shipped documentation

**Status: `OPEN` with two resolved subitems.**

- Steering examples now use the executable `--body`/target-generation surface,
  and `tests/docs-cli-contract.test.ts:21-52` rejects the former
  `--generation`/`--text` examples.
- Packed relative links are resolved by the actual **30-document / 57-target**
  inventory proof and the strict package-manifest validator cited under
  RF-RC-03.
- A final capability-claim truth pass is still required after the active P4/P6
  integration settles. At this checkpoint, README and architecture/safety
  status prose still contains pre-wiring statements about SCM or P6. The ledger
  therefore does not promote RF-RC-09 to resolved merely because commands and
  links are correct.

## RF-RC-10 resolution evidence — workflow bookkeeping

**Status: `OPEN` with the reference-audit remainder resolved.**

- The deficient phase result audits now have the exact mandatory six-column
  Reference Matrix, explicit Chosen design labels and canonical reuse classes.
  `results/audit-p02-agent-sandboxes.md:337-349` replaces the old
  “Verification still needed” heading with an implementation-resolution matrix
  and records the 21/21 capability/limit, 46/46 nested
  transport/launch/settlement and 193/193 required-host evidence with zero
  skipped tests.
- `.workflow/ultracode/relayforge-complete/state.json:4-30` still ends at the
  early P0.2/P1 checkpoint, `orchestration.md:21-46` still calls P0.1 workers
  running and later phases future, and `final-report.md:1-5` still says the run
  is in progress. Those files must remain honest until RF-RC-08 has an exact
  immutable evidence object; they were intentionally not rewritten by this
  append-only audit update.

RF-RC-10 closes only when the parent records final packet outcomes, exact commit,
host/tool versions and aggregate totals after the release gate. Until then the
campaign cannot claim complete bookkeeping.

## Remaining release blockers at this checkpoint

1. Implement and integrate the production contained native-adapter collector;
   run OpenCode, Pi and Grok for real on the designated same runner and consume
   their exact receipts into the artifact (RF-RC-03/04).
2. Finish the shipped capability-claim truth pass and campaign bookkeeping
   without weakening the open evidence statements (RF-RC-09/10).
3. Commit the integrated tree once, then rerun the complete aggregate, P6
   **15/15 + 5/5**, required-host, browser, real Git/worktree, packed-install and
   release-policy matrix on that immutable HEAD before creating a tag
   (RF-RC-08).
