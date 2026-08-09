# RelayForge implementation status and release handoff

Last updated: 2026-08-09 UTC

This is the canonical resume surface for the RelayForge completion campaign.
It separates locally verified release engineering from evidence that can only be
collected on the designated native-adapter runner. Product behavior and safety
claims remain governed by the code, tests, ADRs, and phase reference audits.

## Executive status

RelayForge engineering is approximately **9/10 complete**. P0 through P7 are
implemented and the local committed release-candidate path is green, including
packed artifact and real-browser proof collected on runtime proof commit
`cf87abf`. Docs-only HEAD `44aad79` follows that fully tested runtime commit;
no code changed after the proof. Contained production characterization paths
for OpenCode, Pi, and Grok are implemented and fixture-backed; Pi and Grok are
no longer typed-unavailable locally. The branch is not publishable yet because
the fail-closed release workflow requires three real, same-runner native-adapter
receipts; those receipts have not been collected and still require the
designated cgroup runner, exact installed binaries, live credentials, and the
publishable release workflow.

No tag, npm publication, GitHub Release, or repository rename has been
performed. Those remain explicit operator actions, not implied follow-ons from
this handoff.

## Repository state

| Item | Value |
| --- | --- |
| Working branch | `agent/loop-engineering-hardening` |
| Current HEAD | `44aad790069310e7884b6178900eba91ecc311c9` (`docs: record current artifact and browser proof`) |
| Runtime proof commit | `cf87abfee5426178e8883c176b66032631ada9ca` (`docs: record final cgroup smoke handoff`) — exact required-cgroup smoke, packed artifact, and real-browser proof were built from this parent commit |
| Current commits | `ee93223889c39354f03af330782434b313155097` (harden contained native evidence binding), `de23f74b9da4497842b143922fab4354e64206fd` (contained Pi production characterization), `82c6b32c67c8247deada9cc60cd05a58ed7107cd` (serialized package export typecheck), `a8433debf27a54ce5979c95ff5eadec87ab0311c` (contained Grok production characterization), `1d365fc67f94ee231d010a495baf188ded3f1f8b` (release handover after native characterization), `b94062430c82bed2236c86ec79855e814fe724d4` (drain verifier cgroup close race), `cf87abfee5426178e8883c176b66032631ada9ca` (final cgroup smoke handoff / runtime proof), `44aad790069310e7884b6178900eba91ecc311c9` (docs: record current artifact and browser proof) |
| Product integration commit | `5880b008d81c20f746f728ef83d736306d546d81` (`feat: complete RelayForge control plane integration`) |
| Stabilization commits | `3b6f78f2b89f0b4430e9f24cd535d3efa29e6e26`, `a0a877fcf4d67445a56656a88b653e7141082313` |
| Packed/browser smoke checkpoint | `cf87abfee5426178e8883c176b66032631ada9ca` (exact preview run on the runtime proof commit; docs-only `44aad79` follows with no code change) |
| Previous remote handoff checkpoint | `860688c55207be051431d470b44b038025a12e5c` |
| Package candidate | `relayforge@1.0.0-rc.1` |
| Tag / npm publish / GitHub Release / repository rename | **Not performed** |
| Real native-adapter receipts | **Not collected** |

The previous remote checkpoint contains the earlier documentation handoff. The
closing branch push carries this document and the verified commits; after
fetching, use `git rev-parse HEAD` rather than treating `860688c` as the product
tree. Docs-only commit `44aad79` follows the fully tested runtime commit
`cf87abf`; no code changed after the proof. Required-cgroup source smoke, packed
artifact preview, and real-browser gates remain exact for parent `cf87abf`.

## Phase status

| Phase | Capability | Status | Evidence |
| --- | --- | --- | --- |
| P0 | Worktree provisioning and streaming repair | Implemented | Provision matrix **99/99**; six-million-frame direct characterization improved from about 24.2 s to about 3.2 s |
| P0.2 | Delegated verifier cgroup jail | Implemented | Required-host **21/21**; production-jail **46/46** and **193/193**, zero skips, exact settlement/no-leak proof; close-membership drain regression **60/60** focused |
| P1 | Durable SQLite control plane, HTTP/SSE, dashboard, migration and cutover | Implemented | Focused control-plane aggregate **210/210** |
| P2 | Parent-owned future-boundary steering | Implemented | Actual CLI live E2E **1/1** on bwrap+cgroup; adjacent steering/authority **25/25**; exact process/cgroup cleanup |
| P3 | SCM publication, CI/review observation and reaction bridge | Product-integrated | Focused **155/155**; explicit SCM/P6 publication config drives recoverable publication, parent polling, durable observations and reaction-to-P2; unconfigured runs make no remote publication |
| P4 | Capability adapter registry and OpenCode/Pi/Grok adapters | Implemented; native release receipts open | Registry, codecs, bounded routes and fail-closed policy are integrated. OpenCode, Pi, and Grok contained production characterization paths are implemented and fixture-backed; focused adapter/egress matrix **127/127** green. Real same-runner receipts still require exact binaries, live credentials, designated cgroup runner, and the release workflow. Ordinary structured-native execution refuses before run/control/worktree mutation when product evidence is absent |
| P5 | Transcript ingestion and live control room | Implemented | Focused **125/125**; observations remain non-authoritative; reconnect degrades and recovers explicitly |
| P6 | Multi-repository scheduling, isolation, recovery, integration and publication | Product-integrated | Authority **21/21**; orchestration **12/12**; product/recovery/verifier **6/6**; publication/SCM/integration **13/13**; real isolation and SIGKILL recovery paths |
| P7 | RelayForge identity, package, workflow and browser/release proof | Local committed gates green on runtime proof commit | Required-cgroup aggregate, source smoke, typecheck/build, packed artifact preview, and real Chrome lifecycle green on runtime proof `cf87abf`; docs-only HEAD `44aad79` records that proof with no code change; publish remains blocked on real same-runner native receipts |

## Committed release-candidate verification

These are committed-tree results, not a dirty-worktree preview.

| Gate | Result |
| --- | --- |
| Required-cgroup aggregate | **GREEN** — **171** test files, **1,957** tests, TypeScript and build green |
| Environment | Node **v20.20.2**, npm **10.8.2**, Linux **6.17.0-1021-gcp**, Bubblewrap **0.9.0** |
| Focused adapter/egress matrix | **GREEN** — **127/127** (OpenCode/Pi/Grok characterization, egress, collector, and related adapter coverage) |
| Close-membership drain regression | **GREEN** — **60/60** focused (verifier cgroup close-race drain fix on `b940624`) |
| Required-cgroup source smoke | **GREEN on runtime proof `cf87abf`** — two consecutive runs passed with exact marker `SMOKE PASS (contained host — verified delivery on the run branch)`; status `done`; final verifier green; feature only on the run branch; original checkout unchanged |
| Exact preview tarball | **GREEN on runtime proof `cf87abf`** — artifact commit `cf87abfee5426178e8883c176b66032631ada9ca`; tarball `relayforge-1.0.0-rc.1.tgz`; sha256 `92020efe10080fe617151a1af093f41c0bd953d43d1aa3fbeeb51df7919147ff`; **1,645,603** bytes |
| Packed deep smoke | **GREEN on runtime proof `cf87abf`** — release-artifact preview clean-install/deep smoke/native binding/public API/link closure passed (`better-sqlite3` native load, public ESM/external TypeScript, forbidden authority exports, canonical init/dry-run, legacy config plus existing `.loop` adoption, control start/status/stop, packed Markdown link closure) |
| Packed real-browser gate | **GREEN on runtime proof `cf87abf`** — Google Chrome **150.0.7871.128**; DOM rendered; lifecycle **connected → degraded → recovered**; `serviceReplaced` **true** |
| Workspace hygiene | Generated preview moved outside the repository; no test process, disposable worktree, cgroup, socket, or temporary release artifact retained in the source tree |

Release testing found and fixed five concrete issues before the prior packed
checkpoint, plus the close-membership drain race fixed on `b940624`:

1. implementation-only `better-sqlite3` types leaked into public declarations;
2. packed smoke synchronously waited on `serve stop` while owning the child it
   needed to reap;
3. legacy adoption tried to recreate an init-owned `.loop` directory; and
4. source smoke generated nondeterministic verifier output despite requesting
   two stable runs; and
5. the required-cgroup aggregate allowed the exact 256-descendant limit test to
   run beside another strong-backend file, so the sibling could correctly
   receive `EAGAIN`; required-host validation is now serialized while ordinary
   development keeps two workers; and
6. verifier cgroup close-membership drain raced on teardown; focused drain
   regression is **60/60** on `b940624`.

The release-workflow test now rejects the nondeterministic verifier tokens, and
required-cgroup source smoke on runtime proof `cf87abf` proved the strong
contained branch with two consecutive `SMOKE PASS` runs and a green final
verifier. Exact packed artifact and real-browser proof were collected from that
parent commit (artifact commit `cf87abfee5426178e8883c176b66032631ada9ca`,
tarball digest above). Docs-only commit `44aad79` follows the fully tested
runtime commit; no code changed after the proof. Local preview gates no longer
block publish; only the real same-runner native-adapter receipts remain open.

## Native-adapter release boundary

The product and release workflow fail closed here. Do not weaken this boundary
or invent evidence.

- **OpenCode:** the contained production characterization path is implemented
  and hardened by fixture-backed tests. A real release receipt still requires
  the designated cgroup runner, the exact inspected executable, a live
  credential, and the release workflow.
- **Pi:** the contained production characterization path is implemented and
  fixture-backed; Pi is no longer typed-unavailable locally. Real external
  evidence remains pending and still requires the designated cgroup runner,
  exact binary, live credential, and release workflow.
- **Grok:** the contained production characterization path is implemented and
  fixture-backed; Grok is no longer typed-unavailable locally. Real external
  evidence remains pending and still requires the designated cgroup runner,
  exact binary, live credential, and release workflow. RelayForge does not
  expose persistent auto-approval; worker permissions remain parent-mediated
  and one-request only.
- The publishable workflow requires distinct same-runner OpenCode, Pi and Grok
  receipts bound to the exact checkout, runtime identities, containment,
  settlement and artifact. Missing evidence is a hard release refusal, never a
  skip.

This boundary means the local package is a verified preview candidate, not an
authorized npm/GitHub release.

## Completed architectural guarantees

- Canonical run facts live in run-scoped SQLite event history with projections,
  sequence/generation fences, transactional compare-and-swap, snapshots,
  integrity checks and recovery (`src/control/`).
- Provider and verifier execution use isolated worktrees, parent-owned
  filesystem capability allowlists, Bubblewrap, delegated cgroup v2,
  authenticated launch and settlement, bounded transcripts and deterministic
  replay.
- Steering appends only through the live parent and enters a future immutable
  prompt; it never injects terminal input or writes SQLite directly
  (`src/steering/`, ADR 003).
- SCM publication/observation/reaction is durable parent behavior, with
  credentials retained by the parent and no inferred remote plan (`src/scm/`,
  ADR 004).
- Multi-repository work is product-integrated through strict config, exact
  repository-set authority, a DAG scheduler, all-or-nothing worktree groups,
  canonical contained worker/verifier transport, vector integration,
  publication reconciliation and crash recovery (`src/multirepo/`, ADR 007).
- Observability is bounded and non-authoritative; ingestion or presentation
  failure cannot change provider, task, verification or settlement truth
  (`src/observability/`, `src/control-room/`, ADR 006).
- Adapter descriptors are pure data and cannot spawn, widen containment or mint
  settlement authority (`src/adapters/`, ADR 005).

## Handoff sequence

1. Fetch or push `agent/loop-engineering-hardening` as appropriate and verify
   the remote branch contains HEAD `44aad79` (docs-only after runtime proof
   `cf87abf`) and the current characterization, fix, smoke, and docs-handoff
   commits (`ee93223`, `de23f74`, `82c6b32`, `a8433de`, `1d365fc`, `b940624`,
   `cf87abf`, `44aad79`).
2. On the designated Linux runner, install/pin the exact OpenCode, Pi and Grok
   runtimes and credentials without sharing one provider's secret with another.
3. Run the same-job collector/consumer path for all three adapters. Preserve
   only the digest-bound receipt bundle; never upload raw evidence or secrets.
4. Run the publishable artifact workflow. It must repeat the cgroup/strong
   backend gates and bind the three real same-runner receipts to the exact
   tarball (local packed/browser preview is already green on runtime proof
   `cf87abf`; docs-only `44aad79` did not change code after that proof).
5. Only with explicit operator authorization after every gate is green: create
   an RC tag, publish npm, create a GitHub Release, or rename the repository.

For a local recheck from the pushed branch:

```bash
git status --short
git diff --check
npm ci
RELAYFORGE_TEST_REQUIRE_CGROUP=1 npm run validate
RELAYFORGE_TEST_REQUIRE_CGROUP=1 npm run smoke
node scripts/release-artifact.mjs --preview --output .preview-final
node scripts/smoke-packed-dashboard.mjs \
  --tarball .preview-final/relayforge-1.0.0-rc.1.tgz
```

Do not convert an unavailable runtime, missing credential or absent containment
capability into a successful result.

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
