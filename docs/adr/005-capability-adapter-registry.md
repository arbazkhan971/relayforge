# ADR 005: Capability adapter registry with a single execution authority

- Status: Accepted; registry implemented. OpenCode production collector adversarially green (21/21, focused 69/69) with explicit paid-probe authorization; real provider receipt requires designated-runner credentials; Pi/Grok production characterization unavailable; ordinary OpenCode runs fail-closed until same-job evidence is injected before mutation — see [implementation-status.md](../implementation-status.md)
- Date: 2026-08-09
- Decision owners: RelayForge maintainers
- Research: [Phase 04 reference audit](../reference/phase-04-adapter-registry-audit.md)

## Context

At decision time, RelayForge supported provider-specific command construction
and normalization, but those switches could drift and did not express behavioral
compatibility, capabilities, structured sessions, protocol cancellation, or
accounting provenance. A registry was needed without allowing each adapter to
become a second process launcher or settlement authority.

The existing path already resolves a provider, binds prompt bytes and budget,
launches through the sandbox and cgroup gate, bounds stdout once, writes and
fsyncs a private transcript, handles timeout/cancellation, and replays the
versioned grammar in the settlement kernel. That path remains authoritative.

## Decision

RelayForge will use a compile-time registry of immutable shipped adapter
descriptors. A descriptor is a pure description of provider identity,
compatibility, fixed invocation policy, prompt/control serialization, bounded
frame decoding, normalization, capabilities, cancellation, accounting
provenance, and worker/reviewer role requirements.

### Provider, adapter, and protocol identity

Provider ID, adapter ID, native session ID, and transport kind are distinct
types. ACP is a protocol kind, not a provider adapter. Stable ACP v1 is the
initial ACP contract; v2 receives separate types, fixtures, and a future
explicit gate. Schema/SDK artifact versions do not substitute for the
negotiated wire version.

The first new real descriptors are:

- OpenCode through canonical `opencode acp` over native ACP v1 stdio; and
- Pi through canonical `pi --mode rpc` over its native JSONL RPC protocol.

Qwen Code is deferred until OpenCode and Pi prove the registry supports both
ACP and non-ACP transports. Existing Claude, Codex, Gemini, and custom behavior
must remain compatible during extraction.

### Descriptor authority

A descriptor may not:

- import or invoke process-spawn, shell, package-download, sandbox, scope,
  ledger, budget, fallback, or settlement APIs;
- provide a shell command, raw command string, `npx` fallback, executable
  plugin, or runtime-downloaded code;
- choose a weaker launcher, filesystem/network policy, transcript path, output
  bound, timeout, cancellation escalation, or recovery path; or
- mint cost, quota, explicit-limit, fallback, containment, or settlement
  authority.

Configuration may select a shipped descriptor and controlled values. The
`custom` provider remains data-only and gains no executable extension or
cost/fallback authority.

### Single execution and evidence path

The existing parent-owned contained transport and settlement machinery remain
the sole path for every adapter. Only that path may canonicalize/revalidate a
runtime, journal and gate launch, spawn, deliver prompt/control frames, bound
output, write/fsync/reread the transcript, time out, cancel, reap the exact
cgroup, and settle accounting or fallback.

The live parser and settlement kernel must use the same recorded adapter
contract, wire, and normalizer versions. Each accepted frame retains exact
index, byte offset, byte length, and hash. An event iterator ending or a child
exiting is not a terminal verdict.

### Compatibility and capabilities

Availability is an evidence-bearing discriminated union, not a boolean. A
successful probe binds:

- canonical executable and trusted-helper identities;
- observed executable version and supported range;
- a bounded behavioral handshake;
- negotiated/native wire contract and required capabilities;
- role-specific read-only/cancellation/accounting support;
- adapter/normalizer versions and probe time; and
- every consulted configuration value in the cache identity.

The trusted launcher re-stats the executable and helpers before each launch.
Missing, changed, or incompatible evidence produces one stable unavailable
reason before prompt execution. `--help`, version text, or an executable's
standalone success cannot prove adapter compatibility.

OpenCode availability requires a real ACP initialize/session/prompt path inside
the unchanged network-isolated jail, including its internal loopback service.
Pi availability requires supported semver plus live bounded `get_state` and
`get_session_stats` RPC exchanges; a startup sleep is prohibited.

### Prompt, output, and accounting

The descriptor serializes exact prompt/control bytes before reservation so the
durable call identity can bind them. Native structured stdin protocols are
used where available; task or system content is not placed in argv.

Decoders are bounded, total, deterministic, request/session-correlated, and
replayable. Unknown non-terminal events may be retained as bounded diagnostics
but cannot affect terminal, cost, limit, or fallback state. Missing, duplicate,
foreign, or unknown terminals, protocol drift, malformed correlation, or
events outside the allowed drain boundary make the turn uncertain.

Usage, cache, context, cost, rate, and quota facts retain their native source.
Absent or malformed values remain unknown, never zero. Generic error text,
model prose, and ACP usage ratios cannot authorize paid fallback. Only an exact
provider/version grammar may produce candidate `explicitLimit` evidence, and
the settlement kernel must re-derive it from the durable transcript.

### Cancellation and lifecycle

Cancellation records four distinct facts:

1. RelayForge accepted the cancellation request.
2. The protocol-native cancel/abort was sent exactly once.
3. A correlated cancelled terminal or normal completion won the bounded race.
4. The parent proved the exact process scope empty.

Normal completion already made durable may win a cancellation race. If native
cancellation or terminal delivery stalls, the central transport escalates to
the existing scope reaper. An adapter may not invoke its own kill fallback. A
surviving or unproven scope makes settlement uncertain.

### Reviewer read-only behavior

Reviewer availability is the conjunction of the existing outer read-only
filesystem/network sandbox and a proven provider-native inner policy when one
exists. ACP permission callbacks are workflow controls, not containment.
User-controlled arguments cannot relax either layer.

OpenCode receives a parent-controlled deny-mutation permission configuration.
Pi starts with ambient built-ins, extensions, skills, prompts, themes, and
context disabled and adds only a RelayForge-owned read-only tool surface. Both
remain inside the normal outer sandbox; failure to prove the inner requirement
makes the reviewer role unavailable rather than write-capable.

## Required contract shape

Each descriptor records:

- stable ID and RelayForge contract version;
- transport kind and runtime identity;
- supported executable/wire versions and behavioral probe;
- fixed arguments, controlled option slots, allowed environment names, and
  prompt transport;
- capability evidence including models, sessions, cancellation, accounting,
  steering, attachments, and inner read-only behavior;
- bounded codec and stable normalizer version; and
- explicit worker/reviewer role policy and refusal reasons.

The public call surface exposes bounded normalized events separately from one
terminal result Promise. The Promise settles only after transcript durability,
process lifecycle, and exact scope cleanup have settled. Iterator EOF alone is
never success.

## Architecture consistency gate

No adapter may land unless tests prove:

- descriptors are pure and cannot spawn or mint authority;
- compatibility is behavioral and executable identity is revalidated;
- prompt bytes and all parser versions are durably bound;
- live and replay parsers select the same exact terminal evidence;
- output, frame, transcript, and diagnostic bounds remain global;
- missing accounting and capabilities remain explicit unknowns;
- reviewer restrictions preserve the outer sandbox;
- cancel, timeout, fault, and crash paths await one deduplicated exact-scope
  settlement; and
- legacy and recovery paths never guess an adapter or parser version.

## Verification gate

P4 requires four test layers:

1. Pure registry/descriptor invariants and duplicate/unknown rejection.
2. Independently authored dialect fixtures for framing, correlation, terminal,
   usage, limit near misses, cancellation races, and protocol drift.
3. Shared production-transport tests for prompt delivery, bounds, transcript
   faults/replay, timeout/cancel, budget behavior, read-only denial, and no
   surviving descendants.
4. Designated real-host OpenCode and Pi jobs.

Ordinary cross-platform tests may accept one exact typed unavailable reason.
Test-only required-capability gates must fail unless the real executable,
behavioral handshake, contained no-write prompt, truthful usage/unknown state,
cooperative cancellation, reviewer write denial, and empty scope are proved.
OpenCode's job may not weaken network isolation for loopback; Pi's job may not
replace its handshake with a timer.

P4 is complete only when current provider behavior remains compatible, focused
and full tests/typecheck/build pass, every live terminal replays from the
durable transcript, and final reuse classifications are recorded.

## Consequences

Benefits:

- adding a provider cannot silently add a weaker launcher or evidence path;
- compatibility and missing capabilities become visible, stable facts;
- ACP and non-ACP providers share lifecycle guarantees without conflating
  provider-specific usage or limit semantics;
- cancellation and recovery remain deterministic across upgrades; and
- OpenCode and Pi test both protocol reuse and transport independence.

Costs:

- each supported version needs characterization fixtures and real-host probes;
- a provider may remain unavailable when its internal assumptions conflict
  with containment;
- versioned parsers and durable identities require explicit migrations; and
- provider-native inner controls supplement but never replace OS containment.

## Rejected alternatives

- treating ACP as one universal provider adapter;
- exposing arbitrary executable adapters or JavaScript plugins;
- letting a descriptor call `spawn`, a shell, `npx`, or a package downloader;
- scraping OpenCode's TUI or falling back from ACP to `opencode run`;
- using Pi's fixed startup sleep as readiness evidence;
- selecting Qwen as the second adapter before proving a non-ACP transport;
- treating provider permissions, worktree roots, or additional directories as
  a sandbox;
- inferring zero cost or quota limits from absent fields or strings; and
- accepting protocol completion before transcript durability and scope
  settlement.
