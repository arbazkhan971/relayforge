# Final report and release handoff

**Status:** P0–P7 implementation is committed and the local release-candidate
matrix is green. The campaign is complete for local engineering and handoff,
but not for publication: the release workflow still requires real same-runner
OpenCode, Pi and Grok receipts. No tag, npm publication, GitHub Release or
repository rename has been performed.

Canonical tracker: [docs/implementation-status.md](../../../docs/implementation-status.md)

## Repository

| Item | Value |
| --- | --- |
| Branch | `agent/loop-engineering-hardening` |
| Product integration | `5880b008d81c20f746f728ef83d736306d546d81` |
| Stabilization | `3b6f78f2b89f0b4430e9f24cd535d3efa29e6e26`, `a0a877fcf4d67445a56656a88b653e7141082313` |
| Verified release-smoke baseline | `198aa44a192848fe6df1b6f4033e5f6bffc62d89` |
| Package candidate | `relayforge@1.0.0-rc.1` |
| Last pre-product remote handoff | `860688c55207be051431d470b44b038025a12e5c` |
| Tag / publish / release / rename | None |
| Native receipts | None |

## Capability result

| Area | Result |
| --- | --- |
| P0 provisioning | **99/99** |
| P0.2 delegated cgroup | required-host **21/21**; nested **46/46** + **193/193** |
| P1 control plane | implemented; focused **210/210** |
| P2 steering | real CLI E2E **1/1**; adjacent **25/25**; exact cgroup/no-leak |
| P3 SCM | product-integrated; focused **155/155** |
| P4 adapters | registry/routes integrated; OpenCode release receipt needs designated exact runtime + credential; Pi/Grok production characterization typed unavailable; publish fail-closed |
| P5 control room | implemented; focused **125/125** |
| P6 multi-repository | product-integrated; authority **21/21**; orchestration **12/12**; product/recovery/verifier **6/6**; publication/SCM/integration **13/13** |
| P7 local release proof | committed required-cgroup aggregate, source smoke, exact packed artifact and real Chrome lifecycle green |

## Final local verification

| Gate | Result |
| --- | --- |
| Required-cgroup aggregate | **171** files / **1,927** tests; TypeScript/build green |
| Environment | Node **v20.20.2**; npm **10.8.2**; Linux **6.17.0-1021-gcp**; Bubblewrap **0.9.0** |
| Source smoke | exact contained-success marker; `done`; feature only on run branch; checkout unchanged |
| Preview tarball | `relayforge-1.0.0-rc.1.tgz`; **1,628,899** bytes; SHA-256 `bb51e456f099b24859569e7ad09d218bfc4da281ae3eae541f82836f1db6ec35` |
| Packed smoke | clean install/native binding, public ESM/types, closed exports, canonical + legacy config, control lifecycle and Markdown links |
| Browser | Chrome **150.0.7871.128**; DOM rendered; connected → degraded → recovered; service replaced |

## Remaining boundary

The closing branch push makes this handoff available to other engineers. A
publishable release additionally requires distinct real OpenCode/Pi/Grok
receipt collection on the designated runner. Pi and Grok currently return a
typed unavailable result and emit no receipt; OpenCode requires the exact
installed executable and a live credential. Missing evidence remains a hard
refusal.

Only an authorized operator may tag, publish npm, create a GitHub Release or
rename the repository after those external gates pass.
