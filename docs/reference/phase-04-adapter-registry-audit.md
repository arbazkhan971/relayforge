# Phase 04 reference audit: capability adapter registry

- Status: research gate complete; registry implemented. Contained production characterization for OpenCode, Pi, and Grok is implemented and fixture-backed (no longer typed-unavailable). Real same-runner release receipts are still not collected; ordinary execute refuses native adapters without evidence injection; publish stays fail-closed — see [implementation-status.md](../implementation-status.md)
- Date: 2026-08-09
- RelayForge baseline: `73051d510c6473fa763bc7cd81921f65bec00eea`
- Decision: [ADR 005](../adr/005-capability-adapter-registry.md)

## Scope and method

This audit covers adapter contracts, prompt transport, structured output,
usage/limit evidence, capability and version discovery, cancellation,
read-only behavior, and conformance testing. Untrivial Agent Orchestrator was
inspected first. Current competing implementations were then found through
GitHub code/repository searches for coding-agent adapter registries, ACP,
app-server JSON-RPC, stream JSON, cancellation, usage, rate limits, and
read-only reviewers.

The conclusions below come from source, tests, architecture/RFD material,
history, and issues/PRs rather than README claims. Pins were rechecked against
the local canonical clones on 2026-08-09. The similarly named
`AgentWrapper/agent-orchestrator` remote resolved to the exact Untrivial commit
and tree, so it is an alias, not an independent reference.

## Decision summary

RelayForge will add two genuinely different structured adapters:

1. **OpenCode through native ACP:** canonical `opencode acp`, ACP v1 over
   stdin/stdout, with no TUI scraping or `opencode run` fallback.
2. **Pi through native RPC:** canonical `pi --mode rpc`, strict JSONL with live
   state/statistics handshakes, with no readiness sleep.

Qwen Code is the strongest deferred ACP candidate. It follows OpenCode and Pi
because Pi first proves that the registry is transport-neutral rather than an
ACP wrapper.

ACP is a **protocol/transport kind**, not a provider adapter. An adapter
descriptor is immutable, shipped, and pure: it may describe an invocation,
codec, compatibility policy, and capabilities, but it may not spawn, select a
shell, download a package, execute third-party plugin code, or mint usage,
limit, fallback, budget, containment, or settlement authority. The existing
bounded contained transport, durable transcript, cgroup/sandbox launch, and
settlement replay remain the sole execution and authority path.

## Exact pins, activity, and legal review

| Repository | Audited object and activity | License / NOTICE | Reuse classification |
|---|---|---|---|
| [Untrivial Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec) | `f65c48e296e20a816221a4003c75a5f0387967ec`; 2026-08-09, review-feedback injection toggle (#3709) | Apache-2.0; no root NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| [OpenCode](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2) | `38e10eb1408feb700021b8e8766fb0ab41bf84e2`; 2026-08-08, unknown-config compatibility fix (#41312); `opencode` 1.18.15 | MIT, Copyright 2025 opencode; no NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol/tree/1fc9d6ce50263b08e8d52847138ec249209b06f2) | `1fc9d6ce50263b08e8d52847138ec249209b06f2`; 2026-08-09; stable wire v1, schema artifact 1.20.0 | Apache-2.0; no NOTICE found | `ARCHITECTURAL_INSPIRATION`; dependency only after normal dependency review |
| [codex-acp](https://github.com/agentclientprotocol/codex-acp/tree/145ebba5d2030b4aa6d19cbb89d190b7b498d454) | `145ebba5d2030b4aa6d19cbb89d190b7b498d454`; 2026-08-07, Windows cwd normalization (#377); package 1.1.14 | Apache-2.0, Copyright 2025 JetBrains; no NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| [Pi](https://github.com/badlogic/pi-mono/tree/936aff00918de1187f085f123c2812d8f2d67745) | `936aff00918de1187f085f123c2812d8f2d67745`; 2026-08-09; `@earendil-works/pi-coding-agent` 0.84.1 | MIT, Copyright 2025 Mario Zechner; no NOTICE found | `PORTED_IMPLEMENTATION` for independently implemented public wire behavior only; no source copied |
| [acpx](https://github.com/openclaw/acpx/tree/5ef9b5849e137310a1c6f6e06d82ca606c2d8fb3) | `5ef9b5849e137310a1c6f6e06d82ca606c2d8fb3`; 2026-08-08, terminal result waits for cleanup; package 0.13.0 | MIT, Copyright 2025 OpenClaw Team; no NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| [Qwen Code](https://github.com/QwenLM/qwen-code/tree/f3ba99f545e97cff48ecb6af7ea1ea7971d8a6e4) | `f3ba99f545e97cff48ecb6af7ea1ea7971d8a6e4`; 2026-08-09, usage transcript fix (#8790); package 0.21.8 | Apache-2.0 with sampled SPDX headers; no root NOTICE found | `IDEA_ONLY` in P4; deferred independent adapter |

No `DIRECT_COPY` or `MODIFIED_COPY` is approved. Characterization tests must
be independently authored from observed behavior. Any later source or fixture
copy requires a ledger update and a fresh license/copyright/NOTICE review
before the code is introduced.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Agent Orchestrator | Worker/reviewer ports, stable registries, native ACP, Codex app-server, OpenCode/Pi reviewers | Best registry decomposition and cross-adapter invariants; exact installed-binary reuse | Much of the worker surface is TUI-oriented; manifest version is not behavioral compatibility | Apache-2.0 | Adapt architecture |
| OpenCode | Native ACP service, session/events/permission/usage | Best provider-owned OpenCode surface and direct tests | Internal loopback must work in the real network jail; missing usage is unknown | MIT | Architecture and behavior inspiration |
| ACP specification | Versioned schemas, initialize negotiation, capabilities, cancellation, usage | Best wire compatibility and capability semantics | Not a launcher, containment boundary, or provider-limit authority | Apache-2.0 | Protocol architecture |
| codex-acp | Codex app-server-to-ACP mapping | Best app-server normalization and cancellation-race fixture depth | Bundled/download fallback and shell launch do not fit RelayForge | Apache-2.0 | Architecture/test inspiration |
| Pi | Native RPC JSONL, request IDs, stats, isolation flags | Best non-ACP structured CLI surface and strict framing | No negotiated readiness; inner read-only must be constructed | MIT | Independently port public wire behavior |
| acpx | Public event/result contract and data-driven ACP conformance | Best separation of live events from settled result; best seed corpus | Alpha/draft; optional real tests; network package fallback and overrides | MIT | Architecture/test inspiration |
| Qwen Code | Native ACP, stream JSON, usage/history/permission tests | Strongest deferred candidate; broad active coverage | High churn and overlaps OpenCode ACP plus existing Gemini family | Apache-2.0 | Idea only in P4 |

## Source, tests, and history evidence

### Untrivial Agent Orchestrator

Studied `backend/internal/adapters/registry.go`, agent and chatdriver registry
implementations/tests, `backend/internal/ports/agent.go` and `reviewer.go`, the
OpenCode/Pi reviewer adapters, ACP/native-ACP/OpenCode-ACP/Codex-app-server
drivers, and `docs/backend-code-structure.md`.

The useful boundary is the separation between worker, reviewer, and structured
chat drivers, with optional capability interfaces and stable constructor lists.
Registry tests enforce cross-provider invariants such as auth/model metadata,
ignored hook files, and non-selectable fakes. PRs
[#3484](https://github.com/Untrivial-ai/agent-orchestrator/pull/3484),
[#3386](https://github.com/Untrivial-ai/agent-orchestrator/pull/3386), and
[#3358](https://github.com/Untrivial-ai/agent-orchestrator/pull/3358) document
reviewer lifecycle, model-discovery caching, and auth-probe corrections. The
design is the registry winner, but interactive terminal assumptions do not
replace RelayForge's structured, replayable result contract.

### OpenCode native ACP

Studied `packages/opencode/src/cli/cmd/acp.ts` and the `acp/service.ts`,
`event.ts`, `session.ts`, `permission.ts`, and `usage.ts` implementations, plus
the relevant `packages/opencode/test/acp/*.test.ts` suites. The provider owns a
real newline-delimited ACP service over stdin/stdout, with structured sessions,
model/mode options, cancellation, serialized permissions, detailed token/cache
accounting, context, and cost. Missing accounting is omitted rather than
reported as zero.

PR [#40422](https://github.com/anomalyco/opencode/pull/40422) fixed terminal
ordering by draining updates before turn completion; PR
[#40450](https://github.com/anomalyco/opencode/pull/40450) added cache writes to
context use; issue [#22795](https://github.com/anomalyco/opencode/issues/22795)
shows why treating `opencode acp` as a port daemon tests the wrong contract.
The service starts an internal loopback application server, so availability
requires a real launch inside RelayForge's unchanged network-isolated jail.

### ACP specification

Studied root design material, `schema/v1/schema.json`, `schema/v1/meta.json`,
the v1 changelog and initialization/prompt/cancellation/usage/permission/
transport documents, plus v2 migration and lifecycle RFDs and schema tests.
Wire version is negotiated through `initialize.protocolVersion` and is distinct
from an SDK/schema artifact version. Stable ACP v1 is the initial contract;
optional features follow capabilities. V2 types and fixtures remain separate
and gated.

After v1 `session/cancel`, the client continues to accept final updates and
expects a cancelled terminal. A normal completion may win a cancellation race.
Additional-directory and permission features are explicitly not an OS sandbox.
ACP usage/context is informative; it does not prove a provider quota rejection.

### codex-acp

Studied `CodexJsonRpcConnection`, `CodexAppServerClient`, `CodexAcpClient`,
`CodexAcpServer`, event/approval handlers, agent modes, token/rate/quota
mappers, generated app-server v2 types, and the broad
`src/__tests__/CodexACPAgent` fixture/E2E suite. It is the best reference for
mapping current app-server messages and for cancellation before start, during
permission/start/execution, after an early response, and racing completion.
PR [#377](https://github.com/agentclientprotocol/codex-acp/pull/377) reinforces
that session identity includes canonical workspace semantics. Its executable
download/bundle fallbacks and shell-based Windows spawn are explicitly rejected.

### Pi native RPC

Studied `packages/coding-agent/src/modes/rpc/rpc-types.ts`, `rpc-mode.ts`,
`rpc-client.ts`, `jsonl.ts`, session statistics, CLI isolation options, and the
RPC JSONL, prompt-response, process-exit, regression, and general RPC tests. Pi
has distinct request/response IDs and events for prompt, steer, follow-up,
abort, state, session, model, queue, and statistics operations. Its LF framer
uses a streaming decoder, accepts terminal CR, and preserves non-LF Unicode
separators; child/stdin failure rejects pending requests.

PR [#7394](https://github.com/badlogic/pi-mono/pull/7394) made streaming
linear and added a regression. The reference client's fixed startup delay is
not readiness evidence. RelayForge requires a supported semver plus live,
bounded `get_state` and `get_session_stats` exchanges. Reviewer mode disables
ambient tools/extensions/skills/templates/themes/context and adds only an
independently implemented RelayForge read-only tool surface inside the normal
outer read-only sandbox.

### acpx

Studied `src/agent-registry.ts`, ACP client/process/JSON-RPC handling, the
public runtime contract/events/probe, lifecycle/turn manager,
`conformance/spec/v1.md`, its profile, 21 JSON cases, runner, and associated registry/runtime/
permission/cancellation/process tests. Its best idea is an `AsyncIterable` of
bounded live events plus a separate terminal Promise that resolves only after
persistence and cleanup. Commit `5ef9b58` added that settlement property;
`77715c8` hardened queue/process/argv/broken-pipe behavior; PR
[#407](https://github.com/openclaw/acpx/pull/407) fixed usage persistence.

RelayForge independently authors a stricter corpus. It does not adopt acpx's
network package fallback, command overrides, optional continue-on-error real
tests, or its draft cancellation language where that differs from ACP.
OpenClaw issues [#28708](https://github.com/openclaw/openclaw/issues/28708) and
[#51345](https://github.com/openclaw/openclaw/issues/51345) show direct provider
health does not prove a bridge; [#48136](https://github.com/openclaw/openclaw/issues/48136)
shows why provider, adapter, harness, and provider-session IDs need distinct
types.

### Qwen Code, deferred

Studied native ACP agent/session/emitter/permission/history/worktree code and
tests, `packages/acp-bridge/src`, process-registry/NDJSON/transcript handling,
stream-JSON adapters/tests, and CLI/sandbox ACP integration. It is a strong
future ACP conformance target. PR
[#8790](https://github.com/QwenLM/qwen-code/pull/8790) removes usage updates
from model-visible transcripts and PR
[#8762](https://github.com/QwenLM/qwen-code/pull/8762) prevents usage-event
flooding, supporting a typed side channel. Qwen remains deferred until the
OpenCode ACP and Pi RPC implementations prove the registry boundary.

## Subsystem winners

| Subproblem | Winner | RelayForge decision |
|---|---|---|
| Worker/reviewer and registry contracts | Agent Orchestrator | Shared evidence contract with role-specific invocation/read-only requirements |
| Public turn lifecycle | acpx | Bounded events plus one cleanup/settlement Promise; iterator EOF is never success |
| ACP compatibility | ACP specification | Stable v1 only initially; v2 separate and gated |
| Native OpenCode | OpenCode | Native `acp`; no scrape or `run` fallback |
| App-server mapping and fixture depth | codex-acp | Inspiration for a later separately gated Codex app-server path |
| Non-ACP JSONL RPC | Pi | Dedicated Pi dialect over the same bounded transport |
| Prompt transport | ACP / Pi RPC | Exact structured stdin bytes; no prompt in argv |
| Usage/context evidence | OpenCode, codex-acp, Pi | Optional facts with native provenance; missing remains unknown |
| Paid fallback/limit evidence | Existing RelayForge Claude grammar | Only exact provider/version evidence replayed from transcript can authorize fallback |
| Cancellation races | codex-acp | Separate request, protocol send, terminal race, and scope settlement |
| Reviewer inner controls | Codex typed policy / AO Pi policy | Inner policy plus immutable outer read-only containment |
| Registry invariants | Agent Orchestrator | Compile-time descriptors, duplicate rejection, required conformance metadata |
| Conformance corpus | acpx | Independently authored stricter corpus and required real jobs |
| Deferred ACP provider | Qwen Code | Add only after transport neutrality is proven |

## Chosen design

### Best implementation discovered

No repository wins the subsystem. RelayForge combines Agent Orchestrator's
registry/role decomposition, ACP negotiation, acpx lifecycle and conformance,
codex-acp cancellation/mapping, OpenCode native ACP, and Pi native RPC while
retaining RelayForge's stronger contained transport and settlement replay.

### Why

The synthesis lets protocols evolve without gaining process authority, lets
providers share a transport without sharing provider-specific limit semantics,
and keeps one deterministic evidence path for live and recovered execution.

### What RelayForge will reuse

- `ARCHITECTURAL_INSPIRATION`: immutable shipped registration, negotiated
  capabilities, event/result separation, identity correlation, cancellation
  states, accounting provenance, role policy, and data-driven conformance.
- `PORTED_IMPLEMENTATION`: only an independently written, wire-compatible Pi
  RPC dialect based on public behavior and types. No upstream source or fixture
  expression is approved for copying.

### What RelayForge will change

- Descriptors describe fixed recipes but cannot spawn, shell, download, or
  bypass the trusted launcher.
- Configuration selects shipped data/code and controlled values; it cannot
  register executable JavaScript or supply provider control flags.
- Behavioral probes publish typed evidence and exact unavailability reasons;
  version/help output cannot independently prove availability.
- Bounded total codecs and versioned normalizers are used both live and during
  settlement replay.
- Accounting stays optional and provenance-bearing. Generic errors, ACP usage
  ratios, or model prose cannot become limit evidence.
- Reviewer availability requires the normal outer sandbox and proven inner
  restrictions. Cancellation ends only after exact scope settlement.

### How RelayForge improves the references

1. One launcher/transcript/settlement authority path for every descriptor.
2. Durable binding of adapter, contract, wire, and normalizer versions.
3. Capability evidence that binds executable identity, supported semver,
   live behavior, negotiated wire version, and role requirements.
4. Unknown usage/cost/context remains unknown throughout state and UI.
5. Cooperative cancellation, terminal result, process exit, and empty cgroup
   remain distinct, bounded facts.
6. Designated real OpenCode and Pi jobs are mandatory rather than optional
   smoke tests.

## Architecture consistency gate

An implementation is rejected unless all answers are yes:

- Does the descriptor remain immutable, shipped, pure, and unable to call
  `spawn`, a shell, `npx`, a package downloader, or settlement/ledger APIs?
- Does the existing contained transport remain the only launcher, output
  bounder, transcript writer, timeout/cancel escalator, reaper, and settler?
- Are executable/helper identity and every consulted configuration value bound
  into a typed probe result, cache key, and pre-launch revalidation?
- Are exact prompt/control bytes known before reservation and bound to the
  durable call identity?
- Are frames bounded, total, correlated, versioned, and exactly replayable?
- Are capabilities and missing accounting explicit evidence rather than
  inferred defaults?
- Does provider-specific limit evidence remain outside the generic ACP/RPC
  layer and require settlement replay?
- Does reviewer mode preserve the generic writable-root denial, network policy,
  cgroup identity, and provider-native inner controls?
- Does every cancel/timeout/error path await one deduplicated, identity-safe
  settlement and reject surviving descendants?
- Do crash recovery and future migrations select the recorded parser version
  without guessing?

## Contract boundary

Each shipped descriptor records a stable adapter ID, RelayForge contract
version, transport kind (`oneshot-jsonl`, `rpc-jsonl`, `acp-v1`, or a future
separately gated app-server kind), runtime identity, compatibility rules,
fixed invocation policy, capabilities, bounded codec, normalizer version, and
role policy. Provider IDs, adapter IDs, transport kinds, and native session IDs
are different types.

The capability probe is a discriminated union. Availability includes canonical
executable identity, observed/supported version, negotiated or native wire
contract, behavioral checks, capabilities, timestamp, and parser versions.
Unavailability includes a stable code, exact detail, missing/incompatible
evidence, and retryability. The cache keys the complete runtime identity and
consulted configuration; the launcher re-stats trusted executables/helpers for
every launch.

Every normalized record retains frame index, byte offset, byte length, and raw
hash. Unknown non-terminal events are bounded diagnostics. Missing, duplicate,
foreign, or unknown terminals; malformed correlation; protocol drift; or
post-drain authority events make the turn uncertain. Only an exact provider
dialect may emit `explicitLimit`.

Cancellation records request acceptance, one native cancel/abort send, the
correlated terminal/completion race, and exact scope settlement. Failure of a
cooperative stage escalates through the central scope reaper, never an
adapter-owned kill path.

## Failure and conformance matrix

| Evidence/failure | Classification | Required result |
|---|---|---|
| Unknown/duplicate descriptor | Configuration error | Refuse before reservation or spawn |
| Missing or identity-changed executable | Typed unavailable | Refuse and invalidate cached capability |
| Supported version text but failed behavior | Typed unavailable | Never accept version/help alone |
| Unsupported ACP wire / missing required capability | Incompatible/unavailable | Disconnect, reap, and do not send prompt |
| Partial stdin, malformed/oversized frame, early exit | Transport/protocol uncertain | Preserve worst-case reservation; no verdict or fallback |
| Missing/invalid usage | Accounting unknown/malformed | Never synthesize zero/free; preserve native provenance |
| Generic quota-looking prose | Ordinary failure | Never authorize paid fallback |
| Exact versioned limit sequence plus failed terminal | Candidate limit evidence | Settlement kernel must re-derive it from transcript |
| Unknown/duplicate/foreign terminal | Protocol drift | No successful settlement |
| Cancel ignored or races completion | Cancel uncertain or completed | Completion may win; otherwise central reap and exact settlement |
| Reviewer inner policy absent | Role unavailable | Never downgrade to write-capable execution |
| Scope not proven empty | Containment uncertain | Block progression and fallback authority |
| Resume unsupported/corrupt identity | Typed session failure | Never silently create or guess a replacement session |

Conformance has four layers: pure descriptor invariants; independent dialect
characterization at every supported version; shared contained-transport and
settlement integration; and required real OpenCode/Pi jobs. Fixtures cover
chunk and UTF-8 boundaries, CRLF/LF, U+2028/U+2029, malformed/oversized records,
correlation, terminals, usage numerics, misleading limit near misses,
cancellation races, replay equivalence, process death, transcript faults, and
read-only failure.

## Required real-host gates

Test-only gates `RELAYFORGE_TEST_REQUIRE_OPENCODE=1` and
`RELAYFORGE_TEST_REQUIRE_PI=1` select required-capability jobs; production code
must not consult them. The ordinary cross-platform suite may accept one exact
typed unavailable reason, while a designated capable job fails unless
availability and behavior are proved.

- OpenCode must initialize native ACP v1 and complete a deterministic no-write
  prompt inside the actual sandbox/cgroup. Its internal loopback server must
  work with the existing network isolation; RelayForge must not weaken the jail.
- Pi must prove the pinned semver, exact isolation flags, LF framing, and live
  `get_state` plus `get_session_stats` handshakes. A timer/sleep cannot pass.
- Both must preserve truthful unknown accounting, cooperatively cancel a
  bounded long turn, emit a correlated terminal or typed uncertainty, and
  leave the exact process scope empty.
- Both reviewer modes must successfully inspect and deterministically fail a
  write attempt under the normal outer read-only sandbox.
- Live and replay normalization must select the same recorded adapter/wire/
  normalizer versions and exact terminal frame.

P4 is not complete until existing Claude/Codex/Gemini/custom behavior remains
compatible, all focused and full suites/typecheck/build pass, the real adapter
gates pass on designated capable runners, no descriptor creates a second
authority path, and the final implementation reuse entries are updated.

## File-exclusive implementation packet summary

| Packet | Exclusive surfaces | Deliverable |
|---|---|---|
| P4-A | This ADR/reference file and P4-only ledger/watch sections | Freeze contract and legal decisions; no product code |
| P4-B | `src/adapters/types.ts`, `src/adapters/registry.ts`, `tests/adapter-registry.test.ts`, `tests/adapter-contract.test.ts` | Pure immutable types, registration, compatibility, capability and role policy |
| P4-C | `src/adapters/codec.ts`, `src/adapters/acp-v1.ts`, `src/adapters/pi-rpc.ts`, their focused tests and `tests/fixtures/adapters/**` | Bounded total codecs, correlation, normalized events, deterministic cancel state machines |
| P4-D | `src/providers.ts`, `src/normalize.ts`, `src/adapters/builtins/{claude,codex,gemini,custom}.ts`, existing provider/normalizer tests | Byte/result-compatible Claude, Codex, Gemini, and custom migration |
| P4-E | `src/adapters/builtins/opencode.ts`, `tests/adapter-opencode.test.ts`, `tests/fixtures/adapters/opencode/**` | Fixed native ACP recipe, probe, usage, cancel, read-only and required-real gate |
| P4-F | `src/adapters/builtins/pi.ts`, optional `assets/pi-relayforge-reviewer.*`, `tests/adapter-pi.test.ts`, `tests/fixtures/adapters/pi/**` | Exact RPC isolation, probe, prompt/stats/cancel mapping and required-real gate |
| P4-G | `src/orchestrator.ts`, `src/streaming.ts`, `src/settlement-kernel.ts`, `src/ledger.ts`, adapter transport/settlement tests | Bind versions into durable identity and use the sole bounded transport/replay path |
| P4-H | `src/config/schema.ts`, `src/doctor.ts`, `src/index.ts`, optional `src/validate.ts`, selected bootstrap and focused tests | Expose shipped adapters, stable reasons, controlled config, final registry wiring |
| P4-I | `tests/adapter-conformance.test.ts`, `tests/adapter-real-host.test.ts`, `tests/fixtures/adapter-conformance/**`, `docs/adapter-authoring.md` | Adversarial matrix, required jobs, compatibility procedure, no executable plugins |

Owners must not overlap these files. Shared wiring lands only after the pure
descriptors/codecs and provider-specific packets pass their own gates.
