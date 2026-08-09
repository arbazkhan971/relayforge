# Phase 04 addendum: Grok egress containment

Date: 2026-08-09
RelayForge baseline: `73051d510c6473fa763bc7cd81921f65bec00eea`
Disposition: reference gate complete; Grok readiness remains fail-closed until a
parent-owned egress backend satisfies the active enforcement contract below

## Executive conclusion

Grok's privacy flags and private configuration root are necessary but do not
prove that an unapproved upload was denied. Four mature enforcement systems
were inspected at exact pins. They establish three useful patterns: intercept
traffic below the untrusted process, default-deny before admitting an allow,
and exercise the real rule with active allow and deny probes. None is a safe
drop-in dependency for RelayForge's local Node process boundary.

RelayForge must therefore treat Grok egress as a parent capability, not adapter
configuration. The supported execution design is a network jail whose only
route is a parent-owned CONNECT proxy. The proxy accepts only canonical
`api.x.ai:443`, rejects IP literals, alternate ports, wildcards and non-CONNECT
requests, and resolves the destination outside the provider jail. The jail
must also deny direct IP, DNS, host-loopback and alternate-proxy bypasses. Both
an approved inference connection and a denied canary connection are exercised
inside the same production jail before availability can be emitted.

Bubblewrap `--unshare-net` by itself is not this backend: it removes egress and
provides no path to a host proxy. Likewise, HTTP(S)_PROXY variables are routing
hints, not enforcement. A designated runner may provide a separately installed,
parent-owned jail/proxy helper, but RelayForge must pin and re-stat that helper,
bind its policy and active-probe receipts, and fail closed if it is absent or
replaced. Normal `doctor` and `run` use the same capability and evidence path;
the release collector does not get a privileged bypass.

## Questions asked

1. Which mature systems enforce per-process or per-workload outbound policy?
2. Is the rule enforced below the untrusted process, and is failure open or
   closed when the policy agent disappears?
3. Can an unprivileged local runtime obtain endpoint allowlisting without
   widening RelayForge's process or network authority?
4. Which upstream tests exercise real packet paths, deny precedence, network
   namespace isolation and bypass behavior?
5. Which recent changes and open issues show limits relevant to a release gate?
6. What can be reused under each license, and what remains idea-only?

## Method

The four canonical repositories were cloned on 2026-08-09 and inspected at the
pins below. For each, the root license, enforcement/configuration source,
production or integration tests, and recent path history were read locally.
Current upstream issue/PR views were checked on the canonical GitHub
repositories. No code, fixtures, rules, or configuration were copied.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| [evilsocket/opensnitch](https://github.com/evilsocket/opensnitch) `a1353848ba1b660320e90cefea782c3fba272c00` | NFQUEUE/iptables/nftables enforcement, verdict path, rule/operator tests, root-only production test, race/network-rule history, and issue #1644 | Strongest inspected proof that below-process explicit verdicts can enforce policy | Host-wide privileged firewall authority; optional queue bypass is fail-open; concurrent default-action ambiguity | GPL-3.0 | `IDEA_ONLY`; no GPL source, rules, or tests copied |
| [google/gvisor](https://github.com/google/gvisor) `5ceb9a5fd5750d6c73dd166441f28306039300d0` | `none`/sandbox/host network modes, loader/boot posture tests, recent namespace history, and egress-sidecar issue #13796 | Strongest explicit runtime network-boundary taxonomy | Endpoint allowlisting is not a shipped local primitive; proposed sidecar remains open | Apache-2.0 with recorded per-file MIT/BSD notices | `ARCHITECTURAL_INSPIRATION` |
| [cilium/cilium](https://github.com/cilium/cilium) `8c0423e970e62706bcd5dd3a57e1ffaee697439c` | Default-deny/FQDN policy, deny-precedence tests, live Kubernetes tests, recent history, and issues #47768/#47128 | Most mature inspected endpoint/FQDN policy model | Requires cluster/eBPF authority; documented DNS/FQDN edge cases cannot prove a small local boundary | Apache-2.0 root with marked GPL/BSD BPF files | `ARCHITECTURAL_INSPIRATION`; no cluster/eBPF code copied |
| [rootless-containers/rootlesskit](https://github.com/rootless-containers/rootlesskit) `508b336380f2eb37d7d8dbc0a9b4f98bc4956151` | User/network namespaces, slirp/pasta helper probing, integration tests, current network issues, and host-loopback fix PR #612 | Strong practical unprivileged namespace/helper characterization | Slirp/pasta still allow general Internet egress and provide no exact hostname policy | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; helper behavior only |

## Source and test findings

### OpenSnitch

OpenSnitch inserts OUTPUT conntrack rules that queue new/related traffic to
NFQUEUE, matches process/destination rules, and issues accept/drop/reject
verdicts. Its root-only `TestProductionRules` exercises the production iptables
rule and a real TCP connection. This is substantially stronger evidence than a
provider environment switch. It is not a RelayForge dependency: the firewall
daemon owns system netfilter state, the inspected production test uses
`--queue-bypass`, the disconnected-client defaults are configurable, and
current issue #1644 describes concurrent unknown connections receiving a
default action while another decision is pending.

### gVisor

gVisor explicitly distinguishes sandbox, host, none and plugin network types.
`NetworkNone` installs loopback only; sandbox mode uses the internal netstack;
host mode redirects syscalls to the host stack. `--pause-external-networking`
is validated only for sandbox networking. These are good authority boundaries,
but the repository does not ship the exact local destination policy needed by
RelayForge. Current issue #13796 proposes an nftables egress-firewall sidecar,
confirming that endpoint filtering is an additional layer rather than an
inherent result of `network=sandbox`.

### Cilium

Cilium's policy model combines default-deny, explicit egress allow/deny,
identity/CIDR selectors and DNS-proxy-driven `toFQDNs` allow rules. Unit and
Kubernetes tests cover rule validation, deny precedence, repository resolution
and live FQDN policy. The documentation states that deny policies do not
support specifically denying `toFQDNs`; current issues include a hostname
served through an in-cluster gateway escaping the expected `toFQDNs` policy
and cache/proxy failure modes. Cilium is a cluster eBPF/agent solution, not a
small unprivileged per-child helper.

### RootlessKit

RootlessKit creates a user/network namespace and delegates connectivity to
slirp4netns, pasta, VPNKit or related drivers. It detects helper capabilities
before launch and can demand helper sandbox/seccomp support. Its docs and
integration tests explain and exercise the `--disable-host-loopback` boundary;
the July 2026 pasta fix closed a concrete bypass where that option had not
actually blocked host loopback. This supports exact helper probing and active
bypass tests, but neither slirp4netns nor pasta becomes destination-restricted
merely because it is in a separate network namespace.

## Chosen design

### Best implementation discovered

No single reference implements the required local boundary. OpenSnitch is
strongest for below-process verdict enforcement, gVisor for explicit network
isolation modes, Cilium for default-deny/FQDN policy, and RootlessKit for
unprivileged namespace/helper characterization.

### Why

Every candidate carries mismatched authority or a bypass: host firewall state,
a missing endpoint primitive, cluster/eBPF dependence, or unrestricted
user-mode egress. The RelayForge requirement is smaller and stricter: one
provider namespace whose only usable route is a parent-owned exact CONNECT
proxy, verified by active allow and deny probes.

### What RelayForge will reuse

`ARCHITECTURAL_INSPIRATION` for explicit network modes, default deny, exact
helper probing, and adversarial bypass tests; `IDEA_ONLY` for OpenSnitch's
below-process verdict concept. No source, firewall rules, fixtures, tests, or
configuration are copied.

### What RelayForge will change

Policy is per-child and parent-owned, not host-wide or cluster-wide. The jail
has no general DNS/Internet path; the proxy accepts only `api.x.ai:443`; helper
and policy identities are revalidated; direct IP, IPv6, DNS, host-loopback,
alternate proxy, and Unix-socket bypasses are actively denied.

### How RelayForge will improve it

Availability binds exact helper identity, policy digest, positive and negative
probe receipts, adapter call identity, normalized replay, cancellation cleanup,
and terminal settlement. Ambiguity or cleanup failure cannot produce contained
evidence, and descriptors/codecs cannot launch the boundary or mint proof.

### Enforcement contract

The parent-owned egress capability is eligible only when all of these facts are
observed and content-bound:

1. the provider process is in a distinct network namespace whose only usable
   route terminates at the parent proxy;
2. the proxy/helper executables and configuration are physical runtime
   evidence, are re-statted before launch and after collection, and match the
   launch identity;
3. the CONNECT policy is an exact set containing only `api.x.ai:443`; it rejects
   IP literals, suffix/prefix lookalikes, alternate ports, HTTP forwarding,
   proxy chaining and user endpoint overrides;
4. direct IPv4/IPv6, DNS, host gateway/loopback and a second proxy path are
   denied below the provider process, independent of Grok argv/environment;
5. one approved endpoint probe succeeds through the proxy while fixed denied
   hostname and direct-IP probes fail in the same jail; neither result is
   supplied as a caller boolean;
6. ordinary completion and correlated cancellation reap the provider, proxy,
   helper and network namespace under the production parent scope; and
7. the availability and contained-evidence hashes bind the policy digest,
   helper identities, active probe transcript digests, adapter call identity,
   normalized replay and durable terminal settlement.

The proxy is not a TLS man-in-the-middle. It authorizes the CONNECT authority,
then tunnels bytes; TLS still terminates at xAI. DNS is resolved outside the
jail so the provider cannot select an arbitrary resolved IP. Any ambiguous
hostname, DNS rebinding inconsistency, proxy/helper replacement, missing IPv6
deny, failed canary, policy-log overflow or cleanup failure makes Grok
unavailable and emits no release evidence.

## Rejected alternatives

- Grok telemetry/trace flags, a private GROK_HOME, or a unified-log line as the
  sole `unapprovedUploadDenied` proof;
- `HTTP_PROXY`/`HTTPS_PROXY` without a network path that blocks direct sockets;
- bubblewrap `--unshare-net` without an approved proxy route;
- RootlessKit/slirp/pasta with unrestricted default Internet egress;
- host-wide OpenSnitch/nftables mutation from RelayForge;
- a Cilium dependency or Kubernetes-only release gate;
- accepting a runner-provided boolean, unsigned log line or precomputed static
  environment value as egress authority; and
- letting the adapter descriptor, codec or provider builder launch the helper
  or mint its own safety evidence.
