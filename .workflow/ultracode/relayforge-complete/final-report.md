# Final report and release handoff

**Status:** local-engineering-complete; native-release-receipts-open;
characterization done for all three (OpenCode, Pi, Grok). P0–P7 implementation
is committed and the local release-candidate matrix is green on runtime proof
commit `cf87abf`. Contained production characterization paths for OpenCode, Pi,
and Grok are implemented and fixture-backed; Pi and Grok are no longer
typed-unavailable. The campaign is complete for local engineering and handoff,
but not for publication: real same-runner OpenCode, Pi and Grok receipts have
**not** been collected. No tag, npm publication, GitHub Release or repository
rename has been performed.

Canonical tracker: [docs/implementation-status.md](../../../docs/implementation-status.md)

## Repository

| Item | Value |
| --- | --- |
| Branch | `agent/loop-engineering-hardening` |
| Current HEAD concept | docs-only final handover after runtime proof (use `git rev-parse HEAD`); changes no runtime code after `cf87abf` |
| Runtime proof commit | `cf87abfee5426178e8883c176b66032631ada9ca` (`cf87abf`) — exact required-cgroup smoke, packed artifact, and real-browser proof |
| Characterization / fix commits | `ee93223`, `de23f74` (Pi), `82c6b32`, `a8433de` (Grok), `1d365fc`, `b940624`, `cf87abf` |
| Product integration | `5880b008d81c20f746f728ef83d736306d546d81` |
| Stabilization | `3b6f78f2b89f0b4430e9f24cd535d3efa29e6e26`, `a0a877fcf4d67445a56656a88b653e7141082313` |
| Verified release-smoke baseline | `198aa44a192848fe6df1b6f4033e5f6bffc62d89` |
| Package candidate | `relayforge@1.0.0-rc.1` |
| Last pre-product remote handoff | `860688c55207be051431d470b44b038025a12e5c` |
| Tag / publish / release / rename | **Not performed** |
| Native receipts | **Not collected** |

## Capability result

| Area | Result |
| --- | --- |
| P0 provisioning | **99/99** |
| P0.2 delegated cgroup | required-host **21/21**; nested **46/46** + **193/193** |
| P1 control plane | implemented; focused **210/210** |
| P2 steering | real CLI E2E **1/1**; adjacent **25/25**; exact cgroup/no-leak |
| P3 SCM | product-integrated; focused **155/155** |
| P4 adapters | registry/routes integrated; OpenCode, Pi, and Grok contained production characterization **implemented and fixture-backed** (Pi/Grok no longer typed-unavailable); real same-runner release receipts **not collected**; ordinary natives refuse before mutation; publish fail-closed |
| P5 control room | implemented; focused **125/125** |
| P6 multi-repository | product-integrated; authority **21/21**; orchestration **12/12**; product/recovery/verifier **6/6**; publication/SCM/integration **13/13** |
| P7 local release proof | committed required-cgroup aggregate, source smoke, exact packed artifact and real Chrome lifecycle green on runtime proof `cf87abf`; final handover is docs-only after that |

## Final local verification

| Gate | Result |
| --- | --- |
| Required-cgroup aggregate | **171** files / **1,957** tests; TypeScript/build green (runtime proof `cf87abf`) |
| Environment | Node **v20.20.2**; npm **10.8.2**; Linux **6.17.0-1021-gcp**; Bubblewrap **0.9.0** |
| Focused adapter/egress matrix | **127/127** (OpenCode/Pi/Grok characterization and related coverage) |
| Source smoke | green on runtime proof `cf87abf`; exact contained-success marker; `done`; feature only on run branch; checkout unchanged |
| Preview tarball | `relayforge-1.0.0-rc.1.tgz`; **1,645,603** bytes; SHA-256 `92020efe10080fe617151a1af093f41c0bd953d43d1aa3fbeeb51df7919147ff` (on `cf87abf`) |
| Packed smoke | clean install/native binding, public ESM/types, closed exports, canonical + legacy config, control lifecycle and Markdown links |
| Browser | Chrome **150.0.7871.128**; DOM rendered; lifecycle **connected → degraded → recovered**; service replaced |

## Remaining boundary

The final handover is docs-only after the fully tested runtime proof commit
`cf87abf` and changes no runtime code. A publishable release still requires
distinct real OpenCode/Pi/Grok receipt collection on the designated runner
(exact installed binary, live credential, and release workflow). Pi and Grok
contained production characterization is implemented and fixture-backed; real
external evidence remains **pending** and has **not** been collected. Missing
evidence remains a hard refusal.

Only an authorized operator may tag, publish npm, create a GitHub Release or
rename the repository after those external gates pass.
