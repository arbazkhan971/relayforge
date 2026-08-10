# Phase 04 reference addendum: Grok egress containment

Date: 2026-08-09

## Chosen design

RelayForge does not treat Grok privacy flags, a private configuration root, or
telemetry logs as proof that an unapproved upload was denied. Grok is available
only when the parent can place it in a network jail whose sole route is an
exact allowlisting CONNECT proxy, then actively prove both the allowed
`api.x.ai:443` path and blocked direct/canary paths inside that same jail.

The jail/proxy is a parent capability. Adapter descriptors, codecs and provider
builders cannot launch it or mint its evidence. A designated runner may provide
the required parent-owned helper, but its physical identity, policy, active
probe receipts and cleanup must be bound into the same contained availability,
replay and terminal-settlement evidence used by `doctor`, `run` and release.
Missing or replaced helpers, an unblocked IPv4/IPv6/DNS/host route, or a failed
deny probe makes Grok unavailable.

## Reference matrix

| Source | Pin | Finding | Use |
| --- | --- | --- | --- |
| [`evilsocket/opensnitch`](https://github.com/evilsocket/opensnitch) | `a1353848ba1b660320e90cefea782c3fba272c00` | Real NFQUEUE verdict enforcement; privileged host firewall and fail-open queue-bypass modes are unsuitable here | `IDEA_ONLY` (GPL-3.0; no code copied) |
| [`google/gvisor`](https://github.com/google/gvisor) | `5ceb9a5fd5750d6c73dd166441f28306039300d0` | Strong none/sandbox/host network boundaries; endpoint firewall remains a separate proposed sidecar | `ARCHITECTURAL_INSPIRATION` |
| [`cilium/cilium`](https://github.com/cilium/cilium) | `8c0423e970e62706bcd5dd3a57e1ffaee697439c` | Mature default-deny/FQDN policy and tests, but cluster/eBPF authority and documented FQDN limits | `ARCHITECTURAL_INSPIRATION` |
| [`rootless-containers/rootlesskit`](https://github.com/rootless-containers/rootlesskit) | `508b336380f2eb37d7d8dbc0a9b4f98bc4956151` | Useful unprivileged network namespace/helper probing; slirp/pasta alone still allow general Internet egress | `ARCHITECTURAL_INSPIRATION` |

Bubblewrap `--unshare-net` alone is also insufficient because it supplies no
approved proxy route. Proxy environment variables without direct-socket
blocking are routing hints, not enforcement.

Full source, tests, history, issue and license findings are recorded in the
source-tree packet
`.workflow/ultracode/relayforge-complete/results/audit-p4-grok-egress-addendum.md`,
which is intentionally not packaged. The packaged legal record is the
[upstream ledger](../upstream-sources.md).
