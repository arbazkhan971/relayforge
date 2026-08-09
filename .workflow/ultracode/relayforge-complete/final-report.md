# Final report (interim handoff)

**Status:** campaign not complete for RC publication. P0–P6 implementation is
materially complete on the dirty integration tree; P7 local preview/browser/source
gates are green on that dirty tree. Release readiness is **not** complete until
the integration commit and full committed-HEAD rerun/push, plus real native
receipts. This is an honest interim handoff — **not** a claim that the
definition of done is satisfied.

Live tracker: [docs/implementation-status.md](../../../docs/implementation-status.md)

## Repository

| Item | Value |
| --- | --- |
| Branch | `agent/loop-engineering-hardening` |
| Last pushed handoff commit | `860688c55207be051431d470b44b038025a12e5c` (`docs: add RelayForge implementation handoff`) |
| Package candidate | `relayforge@1.0.0-rc.1` |
| Integration commit of full P0–P7 tree | **not created** (dirty shared worktree beyond handoff; no final integration SHA) |
| Tag / npm publish / GitHub release / repo rename | **none performed** |
| Real native provider receipts | **none collected** |

## Capability summary (source evidence)

| Area | Claim |
| --- | --- |
| P0 provisioning | **99/99** |
| P0.2 cgroup jail | required-host **21/21**; nested **46/46** + **193/193**; exact cgroup/no-leak |
| P1 control plane | implemented; focused **210/210** |
| P2 steering | CLI live E2E **1/1**; adjacent **25/25**; exact cgroup/no-leak |
| P3 SCM | product-integrated for explicit SCM/P6 publication config; focused **155/155**; recoverable publication, parent polling, reaction-to-P2 |
| P4 adapters | product-integrated; OpenCode characterization exists with hardened fixture/required-host tests; real release receipt needs designated runner + exact binary + live credential; Pi/Grok **typed unavailable** (no release receipt); ordinary OpenCode/Pi/Grok **refuse before** mutation; publish path **fail-closed** until distinct same-runner receipts |
| P5 control room | implemented; focused **125/125** |
| P6 multi-repo | **product-integrated** (not library-only); authority **21/21**; orchestration **12/12**; product/recovery/verifier **6/6**; publication/SCM/integration **13/13** |
| P7 release proof | dirty-tree gates **green** (see below); final committed-HEAD aggregate **pending** |

## Dirty-tree verification (not committed HEAD)

| Gate | Result |
| --- | --- |
| Required-cgroup aggregate | **GREEN** — **171** test files, **1,925** tests passed, clean TypeScript build |
| Environment | Node **v20.20.2**, npm **10.8.2**, Linux **6.17.0-1021-gcp**, bwrap **0.9.0** |
| Source smoke | **GREEN** — `SMOKE PASS (contained host — verified delivery on the run branch)`; execute completed; feature on run branch; checkout unchanged |
| Exact preview tarball | **GREEN** — `relayforge-1.0.0-rc.1.tgz`, **1,626,928** bytes, SHA-256 `618ef91fd72c6a551ce21cd11ad753b5a11458ea5a2468ca75e80328db720b84` |
| Packed Chrome gate | **GREEN** — Chrome **150.0.7871.128**; schemaVersion 1; packageName relayforge; version 1.0.0-rc.1; fixtureRun browserfixture; DOM rendered; connected → degraded → recovered; serviceReplaced true |

Preview defects fixed before the green results above: better-sqlite3 types no
longer leak into public declarations; smoke harness asynchronously runs
`serve stop` to reap the owned service child; legacy `.loop` fixture adopts the
directory init may already create.

## Remaining verification gaps

### Release blockers

1. **Integration commit** — inspect/stage dirty tree; create one reviewed commit
   of the complete product tree (no final integration SHA yet).
2. **Committed-HEAD re-proof** — full aggregate, source smoke, focused strong
   gates, exact preview + Chrome, clean-tree scans; then push.
3. **Native release receipts** — separately implement and collect real Pi, Grok,
   and OpenCode same-runner receipts (designated runner, exact installed binary,
   live credential where required) **before any** tag or publish. Ordinary
   product execution currently refuses before mutation; publish workflow remains
   fail-closed without those three receipts.

### External actions (operator only)

- Tag, npm publish, GitHub Release, repository rename — **none performed**; not
  implied by dirty-tree readiness.
- Real native receipts — **none performed**.

## Resume

Exact order and commands: [docs/implementation-status.md](../../../docs/implementation-status.md)
(section **Exact remaining-action sequence** and **Required final gate**).

When the definition of done is actually satisfied, replace this interim report
with committed-HEAD verification evidence, a final integration SHA, and real
native receipts. Until then, do not invent success for committed-HEAD aggregates,
publication, or native release receipts.
