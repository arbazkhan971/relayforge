# Phase 04 research: provider adapter registry and structured transports

Date: 2026-08-09
RelayForge baseline: `73051d510c6473fa763bc7cd81921f65bec00eea`
Disposition: mandatory reference gate complete; no product code was changed by
this audit

## Executive conclusion

RelayForge should not model an adapter as a function that can spawn an arbitrary
process. The shipped registry should hold immutable, pure descriptions of:

- the provider/runtime identity that the trusted launcher must resolve and
  revalidate;
- a compatibility probe and the capabilities proven by that probe;
- prompt serialization;
- a bounded, total frame decoder;
- provider-event and terminal-evidence normalization;
- exact usage, cost and limit evidence rules; and
- cancellation and read-only requirements.

Only the existing parent-owned contained transport may resolve, journal, gate,
spawn, time out, cancel, reap, transcript and settle a provider. An adapter may
not supply a shell command, choose a weaker launcher, bypass the cgroup/sandbox,
or mint cost/fallback authority. The settlement kernel must replay the same
shipped parser over the durable transcript before accepting any result.

The two recommended new real adapters are:

1. **OpenCode through its native `opencode acp` stdio service.** It has a
   current native ACP implementation, structured session/cancel/permission and
   usage behavior, and unusually strong source-level tests. Do not scrape its
   TUI or substitute `opencode run`.
2. **Pi through its native `pi --mode rpc` JSONL service.** It provides a
   provider-independent structured RPC surface, strict JSONL framing, request
   IDs, prompt/steer/follow-up/abort, cumulative session statistics, and a
   different transport family from ACP. It is the best second adapter for
   proving the registry is not merely an ACP wrapper.

Qwen Code is the strongest deferred alternative: its current `qwen --acp` and
stream-JSON implementations are substantial and very well tested. It is not the
second recommendation because it overlaps the existing Gemini-family provider
and the OpenCode ACP transport, while Pi forces the abstraction and conformance
suite to support a genuinely independent JSONL RPC contract. Qwen should be the
next ACP conformance target after P4.

## Questions asked

This audit treated each subproblem independently rather than asking which
repository is best overall:

1. Which implementation best separates registry identity, process launch,
   session behavior and output normalization?
2. Which prompt transport avoids process-table disclosure, truncation and TUI
   timing heuristics?
3. Which parser most reliably turns an untrusted event stream into one total,
   replayable result?
4. Which implementation preserves the provenance and uncertainty of usage,
   context, cost and rate-limit evidence?
5. Which capability/version mechanism detects real behavioral compatibility
   instead of trusting a README, `--help`, or package version alone?
6. Which cancellation implementation handles cancellation before start,
   during permissions, during execution and racing with completion?
7. Which read-only implementation is a useful inner control without being
   mistaken for RelayForge's outer containment boundary?
8. Which tests are strong enough to become independently written RelayForge
   characterization and conformance cases?

## Method and search record

The required Untrivial Agent Orchestrator repository was inspected first.
GitHub was then searched for current repositories and recently changed code
using combinations of:

- `coding agent adapter registry`
- `coding agent ACP adapter`
- `coding agent app-server JSON-RPC`
- `coding agent stream json stdin stdout`
- `OpenCode ACP`
- `Codex app-server ACP`
- `coding agent cancellation conformance`
- `coding agent usage tokens rate limit`
- `coding agent read only reviewer`
- `agent protocol conformance tests`

Source, tests, design/RFD material, recent history and relevant bug-fix PRs were
inspected locally with `rg`, `git log`, `git show` and direct file reads. README
claims were used only to locate code. GitHub search and current repository
metadata were used to confirm canonical repositories and recent activity.

`https://github.com/AgentWrapper/agent-orchestrator.git` currently resolves to
the same HEAD and tree as Untrivial (`f65c48e...`), so it is recorded as an alias
and is not counted as an independent implementation.

### Exact repository pins

| Repository | Canonical URL | Audited commit | Latest commit at audit | Package/version where applicable |
|---|---|---|---|---|
| Untrivial Agent Orchestrator | `https://github.com/Untrivial-ai/agent-orchestrator` | `f65c48e296e20a816221a4003c75a5f0387967ec` | 2026-08-09, review-feedback injection toggle (#3709) | Go application |
| OpenCode | `https://github.com/anomalyco/opencode` | `38e10eb1408feb700021b8e8766fb0ab41bf84e2` | 2026-08-08, ignore unknown config fields (#41312) | `opencode` 1.18.15 |
| Agent Client Protocol | `https://github.com/agentclientprotocol/agent-client-protocol` | `1fc9d6ce50263b08e8d52847138ec249209b06f2` | 2026-08-09, registry docs (#1890) | stable wire protocol v1; schema artifact 1.20.0 |
| codex-acp | `https://github.com/agentclientprotocol/codex-acp` | `145ebba5d2030b4aa6d19cbb89d190b7b498d454` | 2026-08-07, Windows cwd normalization (#377) | `@agentclientprotocol/codex-acp` 1.1.14 |
| Pi | `https://github.com/badlogic/pi-mono` | `936aff00918de1187f085f123c2812d8f2d67745` | 2026-08-09, explicit-state harness design | `@earendil-works/pi-coding-agent` 0.84.1 |
| acpx | `https://github.com/openclaw/acpx` | `5ef9b5849e137310a1c6f6e06d82ca606c2d8fb3` | 2026-08-08, settle turns after lifecycle cleanup | `acpx` 0.13.0 |
| Qwen Code | `https://github.com/QwenLM/qwen-code` | `f3ba99f545e97cff48ecb6af7ea1ea7971d8a6e4` | 2026-08-09, hide ACP usage updates from transcripts (#8790) | `@qwen-code/qwen-code` 0.21.8 |

The pins matter because every audited project is moving quickly. RelayForge
must record a new pin and rerun characterization tests whenever an adapter's
supported version range changes.

### Issue and PR tradeoff evidence

The source/history findings were cross-checked against current issues rather
than assuming a healthy standalone CLI proves a healthy orchestration path:

- OpenCode issue
  [#22795](https://github.com/anomalyco/opencode/issues/22795) reports
  `opencode acp` exiting immediately when it was invoked as though it were a
  port-listening daemon. The audited source shows a stdio ACP service whose
  lifetime is bound to stdin. RelayForge's conformance test must therefore hold
  a real stdio connection open and initialize it; a background `--port` smoke
  would test the wrong contract.
- OpenClaw issues
  [#28708](https://github.com/openclaw/openclaw/issues/28708) and
  [#51345](https://github.com/openclaw/openclaw/issues/51345) record cases where
  direct acpx/provider execution succeeded but the enclosing ACP bridge failed
  or hung. This is direct evidence that executable health, adapter handshake,
  parent handoff, permission configuration, terminal delivery and lifecycle
  settlement require separate failure codes and end-to-end tests.
- OpenClaw issue
  [#48136](https://github.com/openclaw/openclaw/issues/48136) identifies a
  concrete identity-routing bug: an application agent ID was passed where an
  ACP harness ID was required. RelayForge must type configuration provider IDs,
  shipped adapter IDs and provider-native session IDs separately.
- Important implementation PRs inspected through their commits include AO
  #3484/#3386/#3358, OpenCode #40422/#40450, codex-acp #377, Pi #7394, acpx
  #407 and Qwen #8790/#8762. Their concrete changes and tests are discussed in
  the repository sections below.

## RelayForge baseline

Source inspected:

- `src/config/schema.ts`
- `src/providers.ts`
- `src/normalize.ts`
- `src/streaming.ts`
- `src/orchestrator.ts`
- `src/sandbox.ts`
- `src/scope.ts`
- `src/settlement-kernel.ts`
- `tests/providers.test.ts`
- `tests/normalize.test.ts`
- `tests/streaming-authority.test.ts`
- relevant provider, cancellation, containment and settlement fixtures

### Existing strengths that P4 must preserve

- `ProviderSchema` is strict and supports only Claude, Codex, Gemini and
  custom today.
- `buildProviderEnv` creates a complete scrubbed environment instead of
  merging the parent's secrets into a child.
- Provider control flags are rejected in both space and `--flag=value` forms.
- Claude and Codex prompt bytes use stdin; prompt delivery completeness is a
  transport precondition.
- Reviewer requests become provider-native plan/read-only modes where those
  exist, while the OS sandbox remains the actual containment boundary.
- One bounded stdout pipeline frames raw bytes once, feeds the display tail and
  normalizer from the same frames, rejects overlong frames, limits total output,
  and retains no unbounded `Buffer[]`.
- A terminal verdict is derived from complete top-level records only. Missing,
  malformed, duplicated or drifted evidence is uncertain rather than guessed.
- Durable transcripts are created privately, written in the same raw-byte
  pass, fsynced, reread and hash-checked.
- The settlement kernel replays the durable transcript using the production
  normalizer and compares exact frame references. Provider code cannot mint a
  spend or fallback receipt.
- A gated, journaled cgroup scope precedes provider exec; every close, timeout
  and cancellation path awaits identity-safe settlement.
- Claude fallback is authorized only by its exact, session-correlated rejected
  rate-limit frame followed by a compatible failed terminal. Model prose or a
  generic error never authorizes another paid call.

### Current gaps

- Command construction, prompt transport and provider-specific policy are one
  switch in `src/providers.ts`.
- `ProviderKind` and normalizer selection are another switch in
  `src/normalize.ts`; the schema, builder, normalizer and routing can drift.
- Compatibility is documented against installed Claude 2.1.207 and Codex
  0.144.0 shapes but is not represented by an explicit adapter compatibility
  result or cached behavioral probe.
- Capability discovery, session semantics, cancellation protocol and usage
  provenance have no provider-neutral type.
- Gemini and custom do not provide a proven structured streaming terminal
  contract equivalent to Claude/Codex.
- The `custom` surface can choose a command but cannot safely contribute
  executable adapter code or new settlement rules. P4 must retain that limit.
- There is no registry-wide conformance suite for worker/reviewer parity,
  read-only behavior, prompt byte binding, process death, cancellation races,
  rate-limit classification or transcript replay.

P4 is therefore an extraction and compatibility project, not permission to
replace the proven transport.

## Primary reference: Untrivial Agent Orchestrator

### Source and design inspected

- `backend/internal/adapters/registry.go`
- `backend/internal/adapters/agent/registry/registry.go`
- `backend/internal/adapters/agent/registry/registry_test.go`
- `backend/internal/ports/agent.go`
- `backend/internal/ports/reviewer.go`
- `backend/internal/adapters/reviewer/opencode/*`
- `backend/internal/adapters/reviewer/pi/*`
- `backend/internal/adapters/chatdriver/acp/*`
- `backend/internal/adapters/chatdriver/nativeacp/*`
- `backend/internal/adapters/chatdriver/opencodeacp/*`
- `backend/internal/adapters/chatdriver/codexappserver/*`
- `backend/internal/adapters/chatdriver/registry/*`
- `docs/backend-code-structure.md`
- associated unit, fake-driver and live tests

### What the implementation proves

AO has two useful layers rather than one universal adapter:

- `ports.Agent` owns CLI/TUI configuration, launch argv, prompt-delivery
  strategy, hooks, restore argv and native session metadata. Optional interfaces
  add binary resolution, auth status, model discovery, prompt readiness, exit
  detection, terminal activity and active-turn steering.
- `ports.Reviewer` is deliberately separate. It owns fresh review invocation,
  follow-up text and optional restore/reuse/readiness/cancellation behavior.
  `ReviewCancelSpec` explicitly represents interrupt, message, raw input,
  repeated inputs and inter-input delay.

Its stable constructor list is one source of truth for shipped harnesses.
Registry tests impose cross-adapter invariants that individual adapters would
otherwise miss: hook files must be ignored so worktrees remain removable,
production harnesses must report auth except documented exemptions, every
harness must expose model/mode configuration, and the fake harness must not
become selectable.

AO also contains three transport lessons directly applicable to P4:

1. Its reusable ACP driver separates provider-specific launch/configuration
   from protocol handling, performs `initialize`, records negotiated
   capabilities and refuses resume when unsupported.
2. Its native ACP binding resolves the exact existing provider binary and has
   deliberately no command override, package download or substitute fallback.
3. Its Codex app-server driver keeps a provider-specific JSON-RPC mapper behind
   a provider-neutral chat contract rather than forcing app-server events into
   a CLI abstraction.

The OpenCode ACP binding uses exactly `opencode acp`, preserves a user's inline
configuration, creates a session-specific agent prompt through
`OPENCODE_CONFIG_CONTENT`, and selects models through the provider-advertised
ACP option. The Pi reviewer preflight checks the actual required isolation
flags and runs with built-ins, skills, prompt templates, themes and context
files disabled, then reintroduces only the reviewer extension/tools.

### Tests and bug history

- `d15fd82` / PR #3484 fixed reviewer terminal lifecycle across Claude,
  Codex and OpenCode and added extensive launcher/session tests. It is evidence
  that launch, reuse, restore and cancel belong in explicit contracts.
- `4babacf` / PR #3386 added adapter-aware model selection, discovery cache and
  configuration tests. It demonstrates why model discovery is a capability,
  not a hard-coded registry field.
- `6823303` / PR #3358 fixed OpenCode/Kilo free-model auth detection. It shows
  that local auth probing is advisory and provider handshakes remain
  authoritative.
- Registry tests cover the cross-adapter invariants described above; ACP tests
  cover initialize, capability absence, session new/load/resume, output,
  permissions, rate-limit extensions and cancellation races.

### Strength and weakness

AO is the strongest reference for registry decomposition, distinct worker and
reviewer semantics, exact native executable reuse and optional capability
interfaces. Its weakness for RelayForge is that much of the original worker
surface is an interactive terminal adapter: launch argv, prompt readiness and
terminal inspection are not themselves a structured, replayable headless
result. Its generic manifest version is metadata, not a supported provider
binary/protocol range. RelayForge should adapt the separation, not copy the
runtime assumptions.

## OpenCode native ACP

### Source inspected

- `packages/opencode/src/cli/cmd/acp.ts`
- `packages/opencode/src/acp/service.ts`
- `packages/opencode/src/acp/event.ts`
- `packages/opencode/src/acp/session.ts`
- `packages/opencode/src/acp/permission.ts`
- `packages/opencode/src/acp/usage.ts`
- all `packages/opencode/test/acp/*.test.ts` relevant to sessions, events,
  permissions, usage, content, directories and errors

`opencode acp` is a real newline-delimited ACP service over stdin/stdout. It
starts OpenCode's internal application server and speaks to it through the
typed SDK; a RelayForge adapter does not need a PTY or terminal scraping.

Its `initialize` response advertises protocol v1, agent information, load,
resume/list/close/fork, MCP HTTP/SSE, image and embedded-context capabilities.
Session creation returns structured model/variant/mode options. Prompt handling
converts ACP content into SDK parts, waits for the session to become idle and
emits a final prompt response. Cancellation aborts the backing OpenCode session
without deleting its ACP identity; close is a distinct lifecycle operation.

`permission.ts` serializes permission requests per session, rejects when the
client has no permission capability, rejects unknown or cancelled outcomes,
and maps edit requests to structured diffs. `usage.ts` separately maps input,
output, reasoning, cache-read and cache-write tokens, calculates context use,
looks up the model's context limit and totals actual assistant-message cost.
Missing usage/limit inputs cause the update to be omitted rather than reported
as zero.

### Tests and bug history

- Tests exercise live ACP child-process EOF/close behavior, create/load/list/
  resume, cancellation, abort failure, error redaction, permission queueing,
  edit metadata and usage omission/caching.
- `44614c7` / PR #40422 fixed a real ordering bug by draining queued updates
  before ending a turn and added session tests for the race.
- `9f38562` / PR #40450 fixed context accounting to include cache writes and
  changed the usage tests.
- The audited head `38e10eb` / PR #41312 ignores unknown configuration fields,
  relevant to forward-compatible adapter overlays.

### Strength and weakness

OpenCode is the best implementation for a new OpenCode adapter because it is
the provider's own structured protocol surface. Its code and tests are stronger
evidence than orchestration wrappers. Weaknesses:

- the agent returns protocol v1 directly; RelayForge still must compare the
  negotiated value and refuse unsupported versions;
- usage collection failures are logged/omitted, so RelayForge must preserve
  `unknown` and cannot infer free usage;
- ACP permissions are an inner workflow, not OS containment;
- the internal application server uses loopback. A required real probe must
  prove that `opencode acp` starts and connects inside RelayForge's actual
  network-isolated provider sandbox. If the current sandbox leaves loopback
  unusable, P4 must report the adapter unavailable rather than enable host
  networking.

## Agent Client Protocol specification

### Source, schema and design inspected

- root `README.md`
- `schema/v1/schema.json`, `schema/v1/meta.json` and changelog
- versioned v1 initialization, prompt, cancellation, usage, permission and
  transport documents
- v2 migration, prompt lifecycle, cancellation, session setup and RFDs
- additional-directories and client-filesystem/terminal RFDs
- schema generation/tests and recent history

The most important compatibility rule is explicit: crate/schema artifact
versions are not wire versions. Wire compatibility is the value exchanged in
`initialize.protocolVersion`; optional behavior is selected from negotiated
capabilities. Stable ACP is currently v1. The v2 schema exists and its stable
baseline documentation is useful, but the complete v2 surface continues to
evolve; v1 and v2 types/fixtures must remain separate.

For v1, `session/new`, `session/prompt`, `session/cancel` and `session/update`
are baseline behavior. Optional features must be advertised. After
`session/cancel`, clients continue accepting final updates and the prompt must
complete with a cancelled stop reason. Generic `$/cancel_request` has its own
request-ID race semantics: if normal completion wins, the late cancellation is
ignored rather than rewriting history.

Usage updates require `used` and `size`; detailed per-turn usage can be present
on the prompt response. Absence of optional cost or detailed fields means
unknown. Additional-directory design text explicitly says roots are not a
sandbox and OS/runtime enforcement remains necessary.

The v2 migration material provides useful future-proofing:

- prompt acceptance and turn completion are separate;
- running/idle/requires-action state is carried by `state_update`;
- messages and tool calls use IDs and upsert semantics;
- cancellation is confirmed by an idle cancelled state; and
- v1/v2 schemas and fixtures stay separate behind an explicit gate.

### Strength and weakness

ACP wins protocol negotiation and capability semantics. It does not win process
identity, containment, cost authority or provider limit classification. It is a
protocol specification and generated-schema source, not a RelayForge adapter
registry or a complete runtime conformance implementation.

## codex-acp: app-server mapping and cancellation

### Source inspected

- `src/CodexJsonRpcConnection.ts`
- `src/CodexAppServerClient.ts`
- `src/CodexAcpClient.ts`
- `src/CodexAcpServer.ts`
- `src/CodexEventHandler.ts`
- `src/CodexApprovalHandler.ts`
- `src/AgentMode.ts`
- `src/TokenCount.ts`, `src/RateLimitsMap.ts`, `src/QuotaMeta.ts`
- generated app-server v2 types
- the broad `src/__tests__/CodexACPAgent/*` fixture and E2E suite

This bridge maps Codex app-server JSON-RPC into ACP and is the strongest source
found for app-server event normalization. It models the native read-only mode as
`SandboxPolicy { type: "readOnly", networkAccess: false }`, keeps workspace
write and danger modes distinct, and maps app-server tool, message, plan,
approval, token, quota and error events into protocol updates.

Its token mapper is deliberately explicit: cached input is separated from
upstream input totals, reasoning maps to thought tokens, detailed values are
omitted when their source is absent, and context usage is not emitted without a
known context window.

Cancellation is unusually thorough. The server tracks the active prompt,
separate cancel/close signals and whether a native turn has started. It handles
cancel before turn start, while starting, during execution, during slash
commands and when the turn starts after the ACP request has already returned.
Late-started turns are still interrupted and notifications are drained before a
cancelled result.

### Tests and bug history

Tests cover initialize/capabilities, authentication, list/load/close/delete,
configuration, tool/plan/reasoning/file-change normalization, approval and
permission decisions, token/rate-limit updates, process exit, steering and the
full cancellation race matrix. Real Codex E2E tests cover persistence and
approval cancellation.

The audited head `145ebba` / PR #377 fixed cross-platform session cwd filtering
and added focused path/session tests, evidence that session identity includes
canonical workspace semantics rather than just an opaque provider ID.

### Strength and weakness

codex-acp wins app-server mapping, cancellation behavior and provider-specific
fixture depth. RelayForge must not copy its bundled/download fallback or the
Windows `shell: true` explicit-path spawn behavior. The trusted launcher, not
the adapter, must resolve and spawn an already installed binary. P4 should also
avoid replacing RelayForge's current proven Codex CLI behavior during the
registry migration; a native app-server transport can be a separately gated
follow-up once characterized against the settlement grammar.

## Pi native RPC

### Source inspected

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/coding-agent/src/modes/rpc/jsonl.ts`
- session statistics in the coding-agent core
- `rpc-jsonl`, `rpc-prompt-response-semantics`, `rpc-client-process-exit`,
  `rpc` and regression tests
- CLI option and isolation documentation/source

Pi RPC is a bidirectional JSONL protocol with request IDs and explicit commands
for prompt, steer, follow-up, abort, state, model/thinking selection, queue
modes, compaction, retry, session operations and session statistics. Events and
command responses are distinct. A prompt success response is emitted only
after prompt preflight accepted or queued the request; a preflight failure
emits exactly one failure response.

The JSONL implementation splits only on LF, uses `StringDecoder` across chunk
boundaries, accepts CRLF by removing the terminal CR, and preserves U+2028/
U+2029 inside JSON strings. The client rejects all pending requests if the
child, stdin or spawn fails. `get_session_stats` reports cumulative input,
output, cache-read, cache-write, total and cost data, and preserves uncertainty
around context use after compaction.

The CLI exposes the isolation controls needed for a bounded adapter invocation:
no built-in tools, an exact tool list, no extensions/skills/prompt templates/
themes/context files, and an explicit session directory. These are valuable
inner controls. Reviewer mode should start from everything disabled and add a
RelayForge-owned read-only extension/tool set; it must still run in the normal
read-only OS sandbox.

### Tests and bug history

- JSONL tests cover chunk boundaries, CRLF and non-LF Unicode separators.
- Prompt-response tests cover immediate, queued and rejected prompts.
- Child-exit tests prove pending calls reject.
- `a447534` / PR #7394 made JSON streaming linear and added a regression case.
- `8eda4f5` rejects prompts during manual compaction and adds RPC regression
  coverage.
- `0524d68` fixed a flaky RPC prompt semantic test, showing the timing surface
  is under active maintenance.

### Strength and weakness

Pi wins the non-ACP structured CLI/RPC candidate and strict JSONL framing. Its
main weakness is compatibility discovery: its reference client waits 100 ms
for startup and has no initialize/version/capability handshake. RelayForge must
not copy that readiness heuristic. It should run an exact executable/version
probe, start RPC under the normal gate, send a bounded `get_state` and
`get_session_stats` behavioral handshake, and treat missing/unknown fields as
unavailable. Pi has no provider-native permission dialog that proves read-only;
outer containment and the exact disabled/reintroduced tool configuration are
required.

## acpx: public runtime contract and conformance corpus

### Source and design inspected

- `src/agent-registry.ts`
- `src/acp/client.ts`, `client-process.ts` and JSON-RPC handling
- `src/runtime/public/contract.ts`, `events.ts`, `probe.ts`
- runtime engine lifecycle, prompt-turn and manager code
- `conformance/spec/v1.md`, profile, 21 JSON cases and runner
- registry, runtime, events, errors, permissions, cancellation, process and
  conformance-runner tests

The strongest acpx idea is its public turn contract: live events are an
`AsyncIterable`, while the canonical terminal result is a separate Promise
that resolves only after persistence and lifecycle cleanup settle. This avoids
making a consumer infer terminal state from whether an event iterator happened
to end.

Its event normalizer has a registry by update tag, preserves unknown/missing
usage as absent, normalizes camel/snake token aliases and exposes tool details
without treating display summaries as authority. `probeRuntime` performs a real
start/initialize/close rather than trusting `--help`.

The data-driven conformance corpus covers initialize, new session, prompt,
updates, active and idle cancellation, invalid parameters, permission denial,
read/write root behavior, unknown sessions, multi-turn behavior, structured
content, background completion and post-success update draining. The runner
contains useful root-bounded client filesystem behavior and stable per-case
timeouts/reports.

### Tests and bug history

- `5ef9b58` changed the turn result to settle only after lifecycle cleanup and
  added 185 lines of runtime-manager regression tests.
- `77715c8` hardened queue/process handling, structured argv, broken-pipe and
  lease behavior across 24 files.
- `06ef8af` / PR #407 fixed persistence of prompt-response usage and added
  integration/runtime tests.
- Current registry tests keep display commands and structured argv in sync and
  test installed-package vs package-exec resolution.

### Strength and weakness

acpx wins public event/result separation and the starting conformance corpus.
It is still alpha and its own conformance document calls the profile a draft.
The profile says cancellation may be acknowledged by a response even though
ACP `session/cancel` is a notification; RelayForge must use the official ACP
semantics instead. Real-adapter jobs are opt-in and may continue on error, so
the suite is not proof that every listed adapter conforms. Its runtime can fall
back to network package execution and its registry accepts command overrides;
both conflict with RelayForge launch authority and must not be adopted.

## Qwen Code: deferred candidate

### Source inspected

- `packages/cli/src/acp-integration/acpAgent.ts`
- ACP session, emitters, permissions, history replay and worktree tests
- `packages/acp-bridge/src/*`, including spawn, process registry, NDJSON,
  permission mediation and transcript replay
- non-interactive stream-JSON input/output adapters and tests
- CLI configuration, sandbox selection and ACP integration tests

Qwen currently exposes both `qwen --acp` and paired `--input-format
stream-json --output-format stream-json` modes. Its ACP implementation is
feature-rich: initialization/capabilities, sessions, history, usage, permissions,
models, cancellation and extensive daemon/bridge behavior. It also has strong
bounded-output and process-registry tests and file-level Apache SPDX headers.

The current head itself is relevant bug evidence: PR #8790 hides ACP usage
updates from user transcripts, while PR #8762 prevents usage events from
flooding a demo event log. These show why normalized usage evidence must be a
typed side channel/event, not accidental model-visible transcript text. Recent
history also includes environment scrubbing and explicit-trust fixes.

Qwen is a stronger immediate ACP target than many wrappers, but not the best
second P4 adapter. OpenCode already exercises native ACP; choosing Pi adds an
independent protocol and reduces the chance that a nominally generic registry
hard-codes ACP assumptions. Qwen should be added to required ACP conformance
once the first two adapters are green.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| Untrivial Agent Orchestrator | Worker/reviewer ports, stable registries, native ACP, Codex app-server, OpenCode/Pi reviewers | Best adapter decomposition and cross-registry invariants; exact installed binary reuse | Many worker adapters are TUI-oriented; manifest version is not a compatibility contract | Apache-2.0; no NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| OpenCode | Native `opencode acp`, sessions/events/permissions/usage | Best provider-owned OpenCode surface; excellent tests; structured usage and cancellation | Loopback internal server needs real contained probe; omitted usage is unknown; ACP is not containment | MIT, Copyright 2025 opencode; no NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| Agent Client Protocol | Versioned schemas, negotiation, capabilities, cancellation, usage and v2 migration | Best protocol/version/capability semantics and design record | Specification, not launch/containment or provider-limit implementation | Apache-2.0; no NOTICE found | `ARCHITECTURAL_INSPIRATION`; SDK dependency only after normal dependency review |
| codex-acp | Codex app-server JSON-RPC to ACP mapper | Best app-server normalization, cancellation race handling and provider fixture depth | Provider-specific; bundled/download and Windows shell launch paths do not fit RelayForge | Apache-2.0, Copyright 2025 JetBrains; no NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| Pi | Native RPC JSONL types/client/server, session stats, isolation flags | Best non-ACP structured CLI adapter; strict framing; simple typed commands | No negotiation/ready handshake; inner read-only must be constructed; API-key live tests are conditional | MIT, Copyright 2025 Mario Zechner; no NOTICE found | `PORTED_IMPLEMENTATION` only for independently implemented wire behavior; no code copy |
| acpx | Public runtime contract, normalized events, registry, data-driven ACP conformance | Best event/result separation and seed conformance corpus | Alpha/draft; real adapters optional; network install fallback and command overrides violate launch authority | MIT, Copyright 2025 OpenClaw Team; no NOTICE found | `ARCHITECTURAL_INSPIRATION` |
| Qwen Code | Native ACP, stream-JSON, process registry, usage/history/permission tests | Strongest deferred adapter; very active and broad behavioral coverage | Large/high-churn surface; overlaps existing Gemini and recommended OpenCode ACP paths | Apache-2.0 with file SPDX headers; no NOTICE found | `IDEA_ONLY` for P4; future independent adapter |

No `DIRECT_COPY` or `MODIFIED_COPY` is recommended. If implementation later
copies any source or fixture rather than independently reproducing behavior,
the implementer must stop, update `docs/upstream-sources.md`, preserve the
applicable license/copyright/NOTICE requirements and get that specific reuse
reviewed. Test cases should be re-authored from observed behavior, not copied.

## Reference quality score

Scores use the requested weights: correctness 25, test quality 20, failure
handling 15, architecture 15, maintainability 10, activity 5, performance 5,
license suitability 5. These are subsystem-fit scores, not popularity scores.

| Repository | Correctness | Tests | Failure | Architecture | Maintainability | Activity | Performance | License | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Agent Orchestrator | 22 | 18 | 13 | 15 | 8 | 5 | 3 | 5 | 89 |
| OpenCode ACP | 23 | 19 | 13 | 13 | 8 | 5 | 4 | 5 | 90 |
| ACP specification | 24 | 16 | 13 | 15 | 9 | 5 | 3 | 5 | 90 |
| codex-acp | 23 | 20 | 15 | 13 | 7 | 5 | 3 | 5 | 91 |
| Pi RPC | 20 | 16 | 11 | 12 | 8 | 5 | 4 | 5 | 81 |
| acpx | 19 | 17 | 13 | 14 | 8 | 5 | 4 | 5 | 85 |
| Qwen Code | 22 | 19 | 14 | 12 | 7 | 5 | 4 | 5 | 88 |

## Which implementation wins each subproblem?

| Subproblem | Winner | Why | RelayForge decision |
|---|---|---|---|
| Worker/reviewer contract separation | Agent Orchestrator | Distinct lifecycles, optional capabilities and registry-wide tests | Keep one shared evidence contract, with role-specific invocation/read-only requirements rather than pretending reviewer reuse/cancel equals worker behavior |
| Public turn lifecycle | acpx | Events separated from a terminal result that waits for cleanup/persistence | Expose bounded events plus one settlement Promise; iterator EOF alone is never success |
| ACP compatibility | ACP specification | Wire version negotiated separately from artifact version; optional features are capabilities | Stable ACP v1 only initially; refuse other versions; v2 types/fixtures separate and feature-gated |
| Native OpenCode adapter | OpenCode | Provider-owned `opencode acp` and direct tests | Use native ACP; no TUI scraping or `run` fallback |
| App-server mapping | codex-acp | Deep mapping and race tests against current Codex types | Use as design/fixture inspiration for a later gated Codex app-server adapter, not during compatibility migration |
| Non-ACP JSONL RPC | Pi | Typed request IDs, commands/events and strict LF framing | Implement a dedicated Pi RPC dialect over the same bounded transport |
| Prompt transport | ACP for ACP adapters; Pi RPC for Pi | Structured stdin framing and explicit request identity | Never put task/system content in argv where a native stdin protocol exists |
| Output normalization | codex-acp for provider depth; acpx for public grammar | Deep native mapping plus clean public event/result split | Shipped pure dialect parsers emit one RelayForge grammar and exact terminal frame refs |
| Usage/context evidence | OpenCode for context/cost; codex-acp for cache correction; Pi for cumulative RPC stats | Each preserves different provider facts | Normalize with provenance and optional fields; missing is unknown, never zero |
| Limit evidence | RelayForge current Claude state machine | None of the generic protocols proves the exact paid fallback condition as strongly | Keep fallback authorization provider/version-specific and transcript-replayed; ACP `usage_update` is not limit authority |
| Cancellation races | codex-acp | Covers pre-start, active, permission, late-start and completion races | Model requested, acknowledged/terminal and force-reaped separately; completion may win a race without being relabeled |
| Read-only inner mode | Codex app-server for typed policy; AO Pi reviewer for disabled/reintroduced tools | Explicit policies with tests | Require provider-native inner mode when proven, plus immutable outer read-only sandbox for every reviewer |
| Registry invariants | Agent Orchestrator | Central shipped constructors plus cross-adapter tests | Immutable compile-time descriptors, duplicate rejection and required conformance metadata |
| Conformance corpus | acpx | Data-driven cases and machine reports | Independently author a stricter corpus; require real-adapter jobs rather than optional smoke |
| Deferred second ACP provider | Qwen Code | Current native ACP and broad test/history surface | Add after OpenCode + Pi prove the registry is transport-neutral |

## Chosen design

### Best implementation discovered

No single implementation wins the whole subsystem. The strongest coherent
synthesis is:

- Agent Orchestrator's registry/capability and worker/reviewer separation;
- ACP's version/capability rules;
- acpx's event-stream/terminal-result split and conformance data model;
- codex-acp's native mapping and cancellation race handling;
- OpenCode's provider-owned ACP surface;
- Pi's strict JSONL RPC and cumulative usage surface; and
- RelayForge's existing bounded transcript, contained launcher and settlement
  replay, which are stronger authority boundaries than any candidate registry.

### Why

This combination keeps the adapter abstraction narrow and testable without
distorting RelayForge around an upstream runtime. Protocol code can evolve
without gaining launch authority. New providers can reuse transport families
without inheriting another provider's limit or usage semantics. The trusted
kernel continues to decide whether bytes are authoritative.

### What RelayForge will reuse

`ARCHITECTURAL_INSPIRATION`:

- compile-time shipped descriptors and cross-registry conformance;
- optional, evidence-bearing capabilities;
- negotiated protocol versions and capability absence semantics;
- separate events and terminal settlement;
- request-ID and session-ID correlation;
- cancellation race states;
- exact token/cache/context/cost provenance;
- data-driven conformance cases; and
- separate worker/reviewer invocation policy.

`PORTED_IMPLEMENTATION` in the legal ledger should mean an independently
implemented Pi wire-compatible dialect based on public behavior/types, not
copied source.

### What RelayForge will change

- Adapters describe a launch recipe but cannot call `spawn`, select a shell,
  download packages or bypass the central launcher.
- The registry accepts structured descriptors, never command strings or
  executable JavaScript plugins.
- Every descriptor has an explicit compatibility policy and behavioral probe.
- Every frame parser is bounded, total, deterministic and replayable by stable
  adapter/dialect version.
- Capability availability carries probe evidence and an exact unavailable
  reason. It is not a boolean inferred from `--help`.
- Usage/cost/limit facts carry source and confidence; absence remains unknown.
- Read-only is a conjunction of outer sandbox proof and any provider-native
  inner policy, never a provider flag alone.
- Cancellation completes only after the provider scope is settled. A protocol
  acknowledgement cannot substitute for process death.
- Real-adapter conformance is required on designated capable runners; it is not
  an optional continue-on-error smoke test.

### How RelayForge will improve it

1. **One authority path.** Registry growth cannot create a second, weaker
   spawn/transcript/settlement implementation.
2. **Replayable dialect version.** Durable call records bind adapter ID,
   adapter contract version, wire version and normalizer version, allowing the
   settlement kernel to replay the exact grammar after upgrades.
3. **Evidence-bearing capability probe.** Executable identity, version output,
   behavioral handshake, negotiated protocol, capabilities and parser range
   are recorded together and revalidated at launch.
4. **Truthful accounting.** Unknown cost or context remains unknown and cannot
   become zero; provider limit events do not authorize fallback unless a
   versioned provider grammar says so and the kernel re-derives it.
5. **Cancellation settlement.** Cooperative cancel, terminal response, process
   exit and cgroup emptiness are distinct facts with bounded escalation.
6. **Required real conformance.** OpenCode and Pi each get a real pinned
   capability job plus deterministic fake/adversarial cases.

## Proposed contract

Names below are design guidance, not code committed by this audit.

### Immutable adapter descriptor

Each shipped adapter descriptor should contain:

- `id`: stable configuration ID (`claude`, `codex`, `gemini`, `custom`,
  `opencode`, `pi`);
- `contractVersion`: RelayForge's descriptor/normalizer schema version;
- `transportKind`: `oneshot-jsonl`, `rpc-jsonl`, `acp-v1`, or a future
  `app-server-jsonrpc`;
- `runtimeIdentity`: the executable name/config identity the trusted resolver
  must locate, canonicalize, identity-pin and re-stat;
- `compatibility`: supported executable semver range, wire versions,
  behavioral probe and required capabilities;
- `invocationPolicy`: fixed provider arguments, controlled option slots,
  allowed environment names and prompt transport mode;
- `capabilities`: discovered models/modes, session support, streaming,
  cancellation, usage/cost/context, inner read-only, attachments and steering;
- `codec`: prompt/control serialization and a bounded incremental decoder;
- `normalizerVersion`: stable parser identifier used by live transport and
  settlement replay; and
- `rolePolicy`: worker/reviewer requirements and explicit refusal reasons.

Descriptors are code shipped with RelayForge. Configuration may select a
descriptor and controlled values, but cannot register executable code. A
`custom` configuration remains data-only and receives no new cost/fallback
authority.

### Capability evidence

A probe should return a discriminated union, not `true/false`:

- available: canonical executable identity, observed executable version,
  supported range, transport/wire version, negotiated/native capabilities,
  behavioral checks, probe timestamp and adapter/normalizer version;
- unavailable: stable code, exact detail, which evidence was absent or
  incompatible, and whether retry after installation/auth/config change is
  meaningful.

Probe cache keys must include runtime identity and all adapter-consulted config.
The launcher re-stats the executable and any trusted helper before each launch.
A version string can narrow compatibility but cannot replace a live
initialize/get-state behavior probe.

### Prompt contract

The provider-neutral request retains RelayForge's current role, exact task,
system-prompt text/file and read-only intent. Each adapter serializes those
inputs once and returns exact stdin/protocol bytes before budget reservation so
the call binding can hash them.

- Claude/Codex behavior remains byte-for-byte compatible during migration.
- Gemini/custom behavior remains compatible until separate characterization
  authorizes a transport improvement.
- OpenCode launches ACP, initializes, creates a session using a parent-created
  inline config for standing instructions, then sends the task as ACP content.
- Pi launches RPC with all ambient content/tools disabled, performs a bounded
  state handshake, then sends a request-ID-bound prompt command.

System prompt material must not be silently downgraded into model-visible task
text if the selected adapter contract claims a distinct standing-instruction
channel. If the native surface cannot prove the distinction, the capability is
unavailable or the descriptor truthfully declares combined-prompt semantics.

### Normalized event and terminal grammar

The internal grammar should distinguish:

- assistant output delta/final text;
- thought/reasoning delta (never terminal authority);
- tool proposed/started/progress/completed/failed;
- permission requested/selected/rejected/cancelled;
- usage/context/cost snapshot with provenance;
- provider quota/rate snapshot with provider-specific evidence;
- session/model/mode/capability update;
- warning/retry/auth/policy/model/context/overload errors;
- cancel requested, cooperative cancel observed and terminal cancelled;
- terminal success/failure/cancelled; and
- protocol/process/transport uncertainty.

Every accepted record retains exact raw frame offset, byte length, frame index
and hash. Unknown well-framed event kinds may be preserved as bounded
diagnostics but cannot affect success, cost or fallback. Unknown terminal kinds,
duplicate terminals, events after the allowed drain boundary, malformed
correlation IDs, protocol drift or an absent terminal make the turn uncertain.

Usage fields are optional and tagged with source:

- terminal response;
- usage update;
- session statistics request;
- provider rate/quota extension; or
- estimated/unknown.

Only an exact provider dialect may set `explicitLimit`. Generic strings,
HTTP-like error text, ACP usage ratios or model-authored prose never do.

### Cancellation contract

Cancellation must record and test four separate stages:

1. RelayForge accepted a cancellation request.
2. The adapter sent the protocol-native cancel/abort/interrupt exactly once.
3. A correlated cancelled terminal or a normal completion won the race.
4. The parent settled the owned process scope and proved it empty.

If stage 2 or 3 times out, the central transport escalates to the existing
scope reap. It does not call an adapter-owned kill command. If normal completion
was already durable before cancellation, the completed result wins; a late
cancel does not rewrite it. Any survivor or unproven scope makes settlement
uncertain.

### Read-only contract

For a reviewer, availability requires:

- the existing outer read-only filesystem/network sandbox and scope;
- no user-controlled adapter argument that can change permission mode;
- a proven provider-native read-only/plan mode when one exists; and
- an exact disabled/reintroduced tool policy for Pi or another provider without
  a native read-only sandbox.

An ACP permission callback is not a filesystem boundary. A provider that can
act without requesting permission remains confined by the outer sandbox.

## Failure matrix

| Failure/evidence shape | Required classification | Required action | Conformance proof |
|---|---|---|---|
| Adapter ID unknown or duplicate | configuration error | Refuse before reservation/spawn | Registry construction test |
| Executable missing | unavailable | Refuse before reservation/spawn; stable doctor code | Injected resolver + real doctor test |
| Executable canonical identity changes after probe | unavailable/uncertain | Refuse launch; do not reuse cached capability | Before/after identity race test |
| Version outside supported range | incompatible | Refuse; print observed and supported range | Boundary semver fixtures |
| Version parses but behavioral handshake fails | unavailable | Refuse; `--help`/version alone cannot pass | Fake executable with plausible version |
| ACP returns unsupported wire version | incompatible protocol | Disconnect/reap; no session/prompt | Fake initialize response |
| Required capability absent | unavailable for requested role/feature | Refuse before prompt; no silent downgrade | Capability matrix tests |
| Optional capability absent | available with capability false | Do not call method; preserve unknown | ACP/Pi fake tests |
| Partial stdin write/EPIPE | uncertain transport | Reap; retain worst-case reservation | Existing transport fault test for every adapter |
| Malformed JSON or non-object frame | protocol drift | No verdict; reap and settle uncertain | Adversarial frame corpus |
| Frame or total-output limit exceeded | typed framing fatal | Stop parsing, reap, no terminal/cost authority | Exact cap/cap+1 tests |
| Unknown non-terminal event | bounded diagnostic | Preserve/ignore for authority; continue | Forward-compat fixture |
| Unknown or duplicate terminal | protocol drift | Uncertain; no cost/fallback | Terminal state-machine tests |
| Child exits before terminal | uncertain | Reap and retain worst case | Real child exit fixture |
| Terminal arrives with foreign session/request ID | ignored/drift | Cannot complete current turn | Correlation adversary tests |
| Updates arrive after prompt response | drain according to versioned contract | Include only within the defined drain boundary; otherwise drift/diagnostic | OpenCode #40422-style race fixture |
| Transcript write/fsync/reread fails | uncertain evidence | No settlement authority | Existing transcript fault suite across descriptors |
| Usage absent | `costReported=false`, fields absent | Never record zero/free; budget policy decides | Per-adapter omission test |
| Usage contains NaN, negative, fractional-invalid or overflow values | malformed accounting | Ignore accounting and settle uncertain if cost needed | Numeric adversary table |
| Cache token convention differs | provider-specific mapping | Apply versioned mapper; retain native provenance | codex-acp/OpenCode shaped fixtures |
| ACP context `used/size` present | informational usage | Never alone authorize fallback | Explicit no-limit test |
| Generic error says rate/quota in text | ordinary failure | Never fallback | Prose/nested-error adversary |
| Exact versioned provider limit frame + failed terminal | candidate limit evidence | Settlement kernel replays before fallback receipt | Positive and mutation tests |
| Auth probe inconclusive | unknown advisory | Permit behavioral handshake only if no credential disclosure; handshake decides | AO #3358-style fixture |
| Auth explicitly missing | unavailable/auth-required | Refuse prompt and expose stable reason | Provider fake/live test |
| Reviewer inner read-only unavailable | role unavailable | Refuse reviewer; never downgrade to write mode | Role capability test |
| Permission callback missing or errors | reject | Never auto-allow | OpenCode/ACP permission tests |
| Cancel before prompt accepted | cancelled if protocol confirms; otherwise uncertain | Do not start later turn; reap on timeout | codex-acp pre-start race fixture |
| Cancel during permission | permission cancelled + turn cancelled | Respond cancelled and drain | Permission race fixture |
| Cancel during active turn | cancelled | Send once, await terminal, then settle scope | Real fake-provider test |
| Normal completion wins cancel race | completed | Preserve completed terminal; ignore late cancel | Deterministic clock/barrier test |
| Provider ignores cooperative cancel | uncertain timeout | Central scope reap; no adapter fallback kill | Hung-child fixture |
| Scope not proven empty | uncertain containment | Block progress/recovery; no settlement/fallback authority | Existing scope survivor suite |
| Session resume requested but unsupported | unavailable operation | Refuse; do not silently create a fresh session | Capability + no-new-session assertion |
| Persistent session corrupt/missing | typed session failure | No guessed provider identity; explicit new-session policy only | Recovery fixtures |

## Conformance suite recommendation

The suite should be descriptor-driven and run in four layers.

### 1. Pure contract tests

- duplicate/unknown registration;
- all shipped adapters declare transport, normalizer and compatibility version;
- every adapter declares prompt transport, role behavior, usage provenance and
  cancellation support;
- every selectable adapter has a doctor probe and conformance fixture;
- no descriptor imports `node:child_process`, shell helpers, sandbox or
  settlement minting code;
- no descriptor supplies a path outside its typed runtime identity.

### 2. Dialect characterization

For every supported version, independently authored fixtures cover:

- first/last/duplicate/missing terminals;
- chunk boundaries, CRLF/LF, UTF-8 split points, U+2028/U+2029 and empty lines;
- malformed objects, arrays/primitives, unknown events and oversized records;
- request/session correlation;
- usage/cost/context absent, zero, valid and invalid numeric shapes;
- exact known provider-limit sequences and all misleading near misses;
- cancel-before-start, permission, active, late-start and completion races; and
- replay equivalence between live frames and durable transcript.

Fixtures should record their observed upstream version and source path/behavior
in this audit/ledger, but not copy licensed upstream fixture contents.

### 3. Shared contained-transport integration

Every adapter, including fake descriptors, must use the same production
transport and prove:

- prompt bytes were fully delivered;
- stdout/stderr and transcript bounds hold;
- timeout/cancellation reaps the exact cgroup;
- provider descendants cannot survive;
- read-only reviewer cannot modify the checkout;
- a transport failure retains worst-case budget and cannot authorize fallback;
- settlement replay selects the same adapter/normalizer version; and
- current Claude/Codex/Gemini/custom behavior is byte/result compatible.

### 4. Required real adapters

Provide separate gates such as
`RELAYFORGE_TEST_REQUIRE_OPENCODE=1` and `RELAYFORGE_TEST_REQUIRE_PI=1` only in
test code. The ordinary cross-platform suite accepts one exact typed unavailable
reason. Designated capable jobs fail unless the real adapter:

- passes executable/version/behavioral compatibility;
- launches inside the actual sandbox and scope;
- completes a deterministic no-write prompt;
- emits the expected structured terminal;
- reports usage truthfully or explicitly unknown;
- cooperatively cancels a bounded long turn and leaves no scope; and
- in reviewer mode, fails a deterministic write attempt while still allowing
  read-only inspection.

For OpenCode, the required job must specifically prove its internal loopback
application server works without weakening RelayForge's network isolation. For
Pi, it must prove the exact isolation flags and behavioral RPC handshake, not a
100 ms sleep.

## Recommended adapters

### OpenCode (`opencode`)

Transport: native ACP v1 over stdio.
Executable: canonical installed OpenCode binary, resolved and revalidated by
the trusted parent.
Launch fragment: fixed `acp` only; controlled environment overlay for a
session-specific standing prompt and permission policy.
Prompt: ACP session/new followed by session/prompt with exact request/session
correlation.
Read-only: outer read-only sandbox plus a generated OpenCode permission config
that denies mutation; no user raw-arg override.
Cancel: `session/cancel`, continue draining updates, require correlated
cancelled terminal or let already-completed terminal win, then settle scope.
Usage: ACP usage/context/cost fields with absence preserved.
Limit: no fallback authority initially; OpenCode usage/context updates are not a
versioned quota-rejection proof.
Compatibility: executable semver range + ACP v1 initialize + required baseline
methods + real contained prompt.

### Pi (`pi`)

Transport: native `--mode rpc` strict JSONL over stdin/stdout.
Executable: canonical installed Pi binary/entrypoint, resolved and revalidated
by the trusted parent.
Launch fragment: fixed RPC mode, explicit session directory, ambient
extensions/tools/skills/prompts/themes/context disabled; role policy adds only
allowed tools.
Prompt: request-ID-bound `prompt`; success response acknowledges acceptance,
events drive progress, idle/terminal behavior and `get_last_assistant_text`/
stats produce the final normalized evidence under a versioned contract.
Read-only: outer read-only sandbox plus zero built-ins and a RelayForge-owned
read-only tool extension/allowlist.
Cancel: one `abort` command, correlated response/event settlement, then central
scope reap if bounded cooperative cancellation fails.
Usage: `get_session_stats`; missing/new fields remain unknown and session totals
must be converted to per-turn deltas only when start/end snapshots share the
same session generation.
Limit: no fallback authority initially; error text cannot classify a quota.
Compatibility: executable semver range + live `get_state` and
`get_session_stats` RPC handshake + exact framing behavior. Never use startup
sleep as readiness evidence.

## File-exclusive implementation packets

These packets are intentionally separated so concurrent owners cannot edit the
same product file. The integrator applies shared wiring only after each packet's
tests are green. File names are proposed P4 surfaces; if the integrator changes
a name, ownership exclusivity must remain.

### Packet P4-A — contract ADR and legal record

Exclusive files:

- `docs/adr/005-adapter-registry.md`
- `docs/reference/phase-04-adapter-registry-audit.md`
- P4 sections only in `docs/upstream-sources.md`

Deliverables: freeze the contract/version/read-only/cancellation/authority
rules from this audit; record all exact pins and legal classifications. No
product code.

### Packet P4-B — pure registry and types

Exclusive files:

- `src/adapters/types.ts`
- `src/adapters/registry.ts`
- `tests/adapter-registry.test.ts`
- `tests/adapter-contract.test.ts`

Deliverables: immutable descriptor types, duplicate/unknown rejection,
capability evidence, compatibility and role policy. No spawn, filesystem,
sandbox, ledger or settlement imports.

### Packet P4-C — structured protocol codecs

Exclusive files:

- `src/adapters/codec.ts`
- `src/adapters/acp-v1.ts`
- `src/adapters/pi-rpc.ts`
- `tests/adapter-codec.test.ts`
- `tests/adapter-acp-v1.test.ts`
- `tests/adapter-pi-rpc.test.ts`
- `tests/fixtures/adapters/**`

Deliverables: bounded total framing/serialization, request/session correlation,
event normalization and deterministic cancel state machines. These codecs
consume frames supplied by the central transport and cannot spawn.

### Packet P4-D — migrate existing providers without behavior change

Exclusive files:

- `src/providers.ts`
- `src/normalize.ts`
- `src/adapters/builtins/claude.ts`
- `src/adapters/builtins/codex.ts`
- `src/adapters/builtins/gemini.ts`
- `src/adapters/builtins/custom.ts`
- `tests/providers.test.ts`
- `tests/normalize.test.ts`

Deliverables: move current builder/normalizer state machines behind descriptors
with byte-for-byte command/prompt and verdict compatibility. Preserve every
existing adversarial limit/usage test. Do not change transport or routing.

### Packet P4-E — OpenCode descriptor

Exclusive files:

- `src/adapters/builtins/opencode.ts`
- `tests/adapter-opencode.test.ts`
- `tests/fixtures/adapters/opencode/**`

Deliverables: fixed native ACP launch recipe, config overlay, capability and
version rules, usage mapping, cancellation and read-only requirements. Include
fake/adversarial characterization and a test-only required-real gate. No shared
registry edit.

### Packet P4-F — Pi descriptor

Exclusive files:

- `src/adapters/builtins/pi.ts`
- `assets/pi-relayforge-reviewer.*` only if an independently written restricted
  extension is required
- `tests/adapter-pi.test.ts`
- `tests/fixtures/adapters/pi/**`

Deliverables: exact isolation arguments, RPC behavioral probe, prompt/event/
stats/cancel mapping, read-only tool policy and required-real gate. No readiness
sleep and no shared registry edit.

### Packet P4-G — central transport/settlement integration

Exclusive files:

- `src/orchestrator.ts`
- `src/streaming.ts`
- `src/settlement-kernel.ts`
- `src/ledger.ts`
- `tests/adapter-transport.test.ts`
- `tests/adapter-settlement.test.ts`
- affected existing streaming/settlement tests

Deliverables: select the descriptor before reservation, bind adapter/wire/
normalizer versions into durable call identity, feed all codecs through the one
bounded raw-byte/transcript pipeline, expose event stream + settled result, and
replay the exact descriptor grammar in the kernel. Preserve current authority
behavior; no descriptor-provided spawn or mint.

### Packet P4-H — config, doctor and final wiring

Exclusive files:

- `src/config/schema.ts`
- `src/doctor.ts`
- `src/index.ts`
- `src/validate.ts` if schema validation requires it
- registry construction/bootstrap file selected by the integrator
- focused config/doctor/validation tests

Deliverables: expose `opencode` and `pi`, construct the shipped registry,
surface stable capability/compatibility reasons, retain controlled custom
configuration, and reject unsafe raw control flags. This is the only packet
that adds descriptors to the production registry.

### Packet P4-I — conformance and authoring guide

Exclusive files:

- `tests/adapter-conformance.test.ts`
- `tests/adapter-real-host.test.ts`
- `tests/fixtures/adapter-conformance/**`
- `docs/adapter-authoring.md`

Deliverables: shared fake/adversarial matrix, required-real OpenCode/Pi jobs,
authoring checklist, compatibility-update procedure and no-code-copy guidance.
The guide must state that third-party adapters cannot be loaded as executable
plugins in P4.

## Empirical gates before P4 can be declared complete

1. Existing Claude, Codex, Gemini and custom provider tests, normalized
   transcripts, budget settlement, fallback and reviewer behavior pass without
   fixture changes that weaken assertions.
2. The current full typecheck/build and test suite is green at committed HEAD.
3. OpenCode ACP proves its internal loopback service works inside the real
   network-isolated provider jail; otherwise it remains typed unavailable.
4. Pi RPC proves the pinned executable range and live state/stats handshake;
   otherwise it remains typed unavailable.
5. Both real adapters prove cancellation and exact cgroup settlement with no
   leaked scope.
6. Both reviewer modes prove a write attempt fails under the normal outer
   read-only sandbox.
7. Every live normalized terminal is byte-for-byte replayable from the durable
   transcript using the recorded adapter/normalizer version.
8. Missing usage remains unknown through event, state, ledger and UI paths.
9. No new adapter path can invoke `spawn`, a shell, `npx`, package download or a
   provider-owned sandbox fallback outside the trusted launcher.
10. `docs/upstream-sources.md` records the final implementation reuse class and
    exact files studied before any P4 commit.

## Final decision

The audit gate is complete. The best design is not Agent Orchestrator alone,
ACP alone, or an off-the-shelf meta-client. RelayForge should synthesize AO's
registry separation, ACP negotiation, acpx lifecycle/conformance, codex-acp
cancellation/mapping, OpenCode native ACP and Pi native RPC while retaining
RelayForge's stronger contained transport and settlement replay as the single
authority path.

Implementation may begin only from the file-exclusive packets above and must
stop rather than weaken containment, transcript durability, read-only policy,
compatibility evidence or settlement authority when a real provider does not
prove the required behavior.
