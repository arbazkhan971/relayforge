# Phase 04 addendum: Grok Build native ACP adapter

Date: 2026-08-09
RelayForge baseline: `73051d510c6473fa763bc7cd81921f65bec00eea`
Canonical source pin: `xai-org/grok-build@8a14c91d88875a831a38b3a066b1683116bcb31c`
Disposition: reference gate complete; implementation is permitted only behind
the existing parent-owned contained transport and settlement replay

## Executive conclusion

Grok Build has a genuine native ACP v1 stdio service and is suitable as a
first-class RelayForge adapter. The canonical process contract is
`grok --no-auto-update --disable-web-search --no-subagents --no-memory agent
--no-leader stdio`. Task and standing-prompt bytes belong on ACP, not argv.
RelayForge must not use Grok's one-shot headless mode, leader/serve modes,
trusted plugin directories, endpoint overrides, or always-approve/yolo flags.

Support is narrower than executable detection. The characterized runtime is
stable Grok `1.0.0`, installed build `3cd0d0cbce`; the public mirror HEAD is a
different source object and is recorded separately. Availability requires an
exact runtime identity, the version/build/channel observation, ACP v1
initialize/session/prompt/cancel behavior, and parent-contained evidence for a
private configuration root, the fixed network/tool policy, and denial of
unapproved telemetry/trace/code upload. `--help`, environment flags by
themselves, or a successful initialize response do not prove readiness.

The privacy restriction is load-bearing. Grok configuration has managed,
environment, local and remote layers, and source contains telemetry, trace,
feedback and update paths. RelayForge therefore uses a private empty HOME and
GROK_HOME, API-key-only authentication, fixed disable switches, no custom
endpoint, and a behavioral no-upload observation. A missing `XAI_API_KEY` is a
truthful `auth-required` outcome, not permission to reuse ambient subscription
or managed configuration.

## Questions asked

1. Which repository and executable are canonical Grok Build, and what exact
   version/source identities were inspected?
2. Is there a native persistent structured protocol rather than TUI scraping
   or one-shot emulation?
3. Which CLI flag scopes select standalone ACP without leader, serve, plugins,
   endpoint overrides, auto-update, memory, subagents, or web tools?
4. How are standing instructions, task bytes, cancellation, permissions,
   usage and terminal evidence represented on the wire?
5. Which configuration, telemetry, trace, feedback and update sources can
   cause data to leave the contained process?
6. Which first-party tests demonstrate framing, EOF shutdown, permissions,
   isolation and session metadata, and which gaps require independent gates?

## Method

The canonical repository, official CLI reference and current product site were
located from the public web, then the source was cloned and inspected locally.
Source, tests, changelogs, commit history, license and third-party notices were
read. The installed host binary was characterized separately with
`version --json`, `--version`, help, agent help, and an unauthenticated ACP v1
initialize exchange under fresh private HOME/GROK_HOME/TMP directories and the
full first-party privacy-disable environment.

Adjacent evidence included the existing P4 corpus (ACP, OpenCode, Pi, AO and
acpx), Grok plugin issues around stdio/permissions/cancellation, an independent
privacy analysis fork, a third-party ACP integration, and both user-requested
RelayForge branches. README claims alone were not used as proof.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| [xai-org/grok-build](https://github.com/xai-org/grok-build) `8a14c91d88875a831a38b3a066b1683116bcb31c` | Canonical CLI parser, native ACP server/session, config/privacy paths, hermetic support, built-binary/ACP/session/permission tests, and changelogs | Only canonical Grok Build implementation; proves persistent ACP v1 and the installed product's relevant controls | Public source pin and installed stable build are distinct; config precedence and auxiliary egress require independent behavioral proof | Apache-2.0; `third_party/NOTICE` present | `ARCHITECTURAL_INSPIRATION`; independently implement the descriptor/binding |
| [xAI CLI reference](https://docs.x.ai/build/cli/reference), live 2026-08-09 | Canonical command, public flag, and authentication descriptions | Normative user-facing syntax reference | Documentation cannot prove runtime containment, privacy, or lifecycle behavior | Documentation terms | `IDEA_ONLY`; no text copied |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) `1fc9d6ce50263b08e8d52847138ec249209b06f2` | ACP v1 negotiation, sessions, cancellation, permissions, and schema/tests | Stable protocol contract shared with the existing RelayForge codec | Protocol explicitly is not a sandbox or process authority | Apache-2.0 | `ARCHITECTURAL_INSPIRATION`; reuse only RelayForge's independently written codec |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) `38e10eb1408feb700021b8e8766fb0ab41bf84e2` | Native ACP transport and lifecycle comparison | Proven adjacent native-ACP provider path | Provider semantics and safety controls differ from Grok | MIT | `ARCHITECTURAL_INSPIRATION` |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) `f65c48e296e20a816221a4003c75a5f0387967ec` | Registry, role separation, native-ACP driver, and single-launch-authority comparison | Strong adapter decomposition and provider-role comparison | Its runtime authority and evidence model are weaker than RelayForge's existing containment/settlement path | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| `xai-org/grok-build-plugin-cc` issue corpus, searched 2026-08-09 | Reports of stdio hangs, permission events, readonly coupling, symlink leakage, and cancellation races | Valuable adversarial regression inventory | Issue reports are not implementation proof and terms vary by referenced material | Repository-specific terms inspected; no code used | `IDEA_ONLY` |
| `thedavidweng/gork-build` privacy-hard-off fork, searched 2026-08-09 | Independent warning about earlier trace/repository-upload surfaces | Useful negative privacy corroboration | Fork provenance/terms are not approved as a copying basis | Terms not approved for copying | `IDEA_ONLY`; zero source/test copying |
| `NousResearch/hermes-agent#65343` and Xenodium Agent Shell docs, searched 2026-08-09 | Corroborate persistent `grok agent stdio` integration and expose ambient always-approve behavior | Independent transport confirmation | Third-party integration does not prove RelayForge containment or permission policy | No code used; repository terms inspected where applicable | `IDEA_ONLY`; ambient always-approve is rejected |
| `origin/claude/agent-orchestrator-ref-i63kd1` `f0914c092157b7d63ba98481ce313b2d53abcfe2` | JSON/live terminal mission-control branch | Useful comparison against the current parent-authority boundary | Raw/live design is not adapter code and is superseded by P1/P3/P5 | MIT | `NOT_USED` |
| RelayForge local baseline `73051d510c6473fa763bc7cd81921f65bec00eea` | Closed registry and single contained parent-authority path | Integration authority the Grok adapter must preserve | Not an external comparator or reuse source | MIT | `NOT_USED` as an upstream; local implementation baseline |

## Canonical source and runtime evidence

The inspected public source is `xai-org/grok-build`, commit
`8a14c91d88875a831a38b3a066b1683116bcb31c` dated 2026-08-09. Recent history
contains synchronized monorepo drops on August 3, 4, 5, 6, 7 and 9. The root
license is Apache-2.0, Copyright 2023–2026 SpaceXAI, and the repository carries
`third_party/NOTICE`; no third-party source is copied into RelayForge.

The principal first-party paths inspected were:

- `crates/codegen/xai-grok-pager/src/app/cli.rs` and `src/app/mod.rs`;
- `crates/codegen/xai-grok-pager/src/acp/mod.rs` and agent-mode docs;
- `crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs`;
- `crates/codegen/xai-grok-shell/src/agent/config.rs` and configuration docs;
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/*`;
- `crates/codegen/xai-grok-test-support/src/{acp_client,sandbox}.rs`;
- ACP harness, built-binary, session-setup, permission-persistence, EOF,
  cancellation, auth and telemetry/trace tests; and
- the 1.0.0 changelog plus historical stdio hang fixes.

The host executable resolves from `/home/arbaz/.local/bin/grok` to
`/home/arbaz/.grok/downloads/grok-linux-x86_64` and reports
`{"currentVersion":"1.0.0 (3cd0d0cbce)","channel":"stable"}`. This is
runtime evidence, not a claim that build commit `3cd0d0cbce` equals public
mirror HEAD `8a14c91`. RelayForge binds the physical executable identity and
observed build separately.

## Protocol and invocation findings

The parser exposes `AgentCmd::Stdio`; first-party test support launches
`grok agent stdio` and speaks newline-delimited JSON-RPC ACP v1. An isolated
real-host initialize produced protocol version 1 and advertised session,
prompt, model and cancellation metadata without requiring authentication.
Authentication and a real prompt roundtrip remain distinct gates.

The supported recipe fixes these decisions:

- global update, web-search/web-fetch, subagent and memory disables precede
  `agent`;
- `agent --no-leader stdio` selects a fresh local persistent ACP process;
- optional model is the only exposed runtime selector initially;
- task text goes in `session/prompt` and the standing prompt goes in bounded
  `session/new._meta.systemPromptOverride`;
- initialize metadata requests non-interactive startup and no project-layout
  scan; and
- the worker uses native `default` permission mode and the parent answers only
  an exact ACP `allow_once` option; reviewers use `plan` and the parent cancels
  permission requests. No persistent approval is selectable; and
- protocol cancellation is sent once and central scope reaping remains the
  fallback.

Forbidden surfaces include `--always-approve`/`--yolo`, `--plugin-dir`,
`--leader`, `--leader-socket`, `agent serve`, `agent headless`, top-level
one-shot headless flags, `--trust`, raw command/args/env, custom API/relay URLs,
and ambient config or subscription reuse.

## Privacy and containment findings

The first-party hermetic harness sets private HOME, USERPROFILE, GROK_HOME and
temporary directories and disables product telemetry, telemetry trace upload,
feedback, trace upload, instrumentation, OpenTelemetry, updater, prompt
suggestions and turn-summary side calls. RelayForge adopts those values as a
fixed parent policy rather than user configuration.

Environment precedence is not by itself a proof: a managed requirement can
outrank an environment choice. The safe supported profile therefore also uses
a new empty configuration root and API-key-only authentication, rejects all
managed/ambient config and endpoint inputs, disables web tools/subagents/memory
at the parser, and requires behavioral hashes for:

1. configuration isolation;
2. the fixed network/tool policy; and
3. denial of unapproved telemetry, trace and repository/code upload.

These hashes are additional Grok availability evidence and are bound into the
same parent-produced probe observation as the ACP handshake. They do not grant
network, containment, cost, fallback or settlement authority. Provider model
traffic still uses the existing network-enabled contained provider sandbox;
the proof concerns unapproved auxiliary egress, not the approved xAI inference
request.

## Chosen design

### Best implementation discovered

Canonical Grok Build is the best and only authoritative implementation of its
CLI and native ACP surface. The strongest complete RelayForge design combines
that source/runtime characterization with the existing P4 ACP codec, registry,
contained launcher, transcript replay, cancellation, and settlement authority.

### Why

The public source proves protocol and configuration behavior, while the exact
installed stable binary proves the executable actually launched. Neither
alone proves private state, fixed tools/network policy, no auxiliary upload,
role permissions, cancellation cleanup, or durable settlement; those facts
must come from the parent-owned RelayForge path.

### What RelayForge will reuse

`ARCHITECTURAL_INSPIRATION` from canonical Grok Build, ACP, OpenCode, and Agent
Orchestrator; `IDEA_ONLY` negative regressions from issues/forks/integrations.
No Rust, generated schema, tests, comments, prompts, or third-party code is
copied.

### What RelayForge will change

RelayForge exposes only one immutable `grok` descriptor with a fixed safe ACP
recipe, API-key-only private state, closed worker/reviewer policy, behavioral
evidence, exact executable/build identity, and no raw command/env/plugin/
endpoint controls. The descriptor cannot spawn or settle.

### How RelayForge will improve it

The adapter is bound into one pre-existing contained execution authority with
byte-exact initialize/prompt evidence, versioned normalization/replay,
permission mediation, cooperative cancellation plus scope reaping, private
configuration, active egress denial proof, and terminal settlement that no
provider component can mint.

RelayForge adds a pure immutable `grok` descriptor and a pure probe evaluator.
The descriptor selects installed `grok`, exact stable 1.0.0/build evidence,
ACP v1, a fixed safe invocation, API-key-only environment, a Grok-normalizer
identity and closed worker/reviewer policies. It does not import process,
filesystem, sandbox, ledger or settlement modules.

The existing ACP codec gains bounded JSON session metadata sufficient for the
Grok standing prompt. Live and replay parsing continue through the same ACP v1
state machine. Provider construction forces the private state and safety
environment. The central orchestrator must select and revalidate the descriptor
before reservation, bind all serialized initialize/session/prompt bytes, and
route the child through the existing contained spawn/transcript/cancel/scope
settlement path. No Grok-specific spawn, one-shot emulation or settlement path
is permitted.

Doctor output may report executable/version/initialize characterization, but
readiness is `available` only when the complete evidence set, API key, exact
runtime identity, safe config hash and required role capabilities match.

## Required real gate

The release job sets `RELAYFORGE_TEST_REQUIRE_GROK=1` and runs:

```sh
RELAYFORGE_TEST_REQUIRE_GROK=1 npx vitest run tests/adapter-grok.test.ts tests/adapter-grok-routing.test.ts
```

That mode may not skip. It must prove the exact stable executable/version/help,
private configuration, ACP v1 lifecycle, safe invocation, prompt/cancel or a
truthful authentication refusal, read-only denial, durable replay and empty
scope through the single contained transport. `XAI_API_KEY` is required for a
real prompt roundtrip; when absent, the gate fails with `auth-required` rather
than reusing ambient login state.

## Rejected alternatives

- Grok TUI or top-level headless output scraping;
- treating initialize or `--help` as behavioral readiness;
- using leader, serve, relay, plugin, trust or always-approve modes;
- inheriting `~/.grok`, subscription auth, managed config or custom endpoints;
- claiming environment telemetry flags alone override every configuration
  layer;
- using model prose or generic ACP errors as limit/cost/fallback evidence; and
- adding a Grok launcher, network authority or settlement implementation.
