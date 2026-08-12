# RelayForge configuration

RelayForge configuration is strict, bounded, and fail closed. The canonical
filename is `relayforge.config.yaml`; `.yml` and `.json` are also accepted.
Existing `loop.config.yaml`, `loop.config.yml`, and `loop.config.json` remain
supported compatibility inputs and are not rewritten on load.

## Discovery

Without `--config`, RelayForge walks from the current directory toward the
filesystem root. At each directory it checks all six supported names. Exactly
one candidate is adopted. More than one candidate in the same discovered
directory raises `CONFIG_AMBIGUOUS`; no filename wins by priority.

Use an exact file when needed:

```bash
relayforge --config /absolute/path/to/relayforge.config.yaml validate
```

An explicit path bypasses discovery but not parsing, schema, or semantic
validation. `relayforge init` creates `relayforge.config.yaml` only when no
supported config is discoverable. `--force` may replace auxiliary starter files;
it never replaces a config or `.loop` state.

## Complete starter-shaped example

```yaml
version: 1

defaults:
  namespace: relayforge
  dashboardPort: 4318
  promptDir: .loop/prompts
  runDir: .loop/runs
  viewport: true

projects:
  - name: demo
    brief: brief.md
    workingDir: .
    intelligence: PROJECT-INTELLIGENCE.md
    safetyMode: workspace-write

    providers:
      primary:
        type: claude
        model: opus
        auth:
          mode: auto
      fallback:
        type: codex
        fallbackFor: primary
        cooldownSeconds: 900
        auth:
          mode: auto

    roles:
      - name: pm
        title: Product planner
        provider: primary
        sme: product-manager
        responsibilities:
          - Decompose the goal into bounded tasks
        guardrails:
          - Do not implement tasks
      - name: engineer
        title: Implementer
        provider: primary
        sme: engineer
      - name: qa
        title: Independent reviewer
        provider: primary
        sme: qa

    loops:
      - name: delivery
        orchestrator: pm
        reviewer: qa
        cadenceMinutes: 30
        pollSeconds: 8
        maxIterations: 8
        maxRepairs: 2
        verifyStabilityRuns: 3
        maxSameFailureCount: 2
        contextTokenBudget: 16000
        postMergeVerify: true
        maxParallel: 1
        budgetMode: unlimited
        budgetUsd: 0
        maxCostPerCallUsd: 0
        allowUnknownCostCalls: 0
        verify:
          - npm test
        provision: []
        stopWhen:
          - all tasks done
          - tests pass
```

The fallback above is the only allowed fallback shape: a Codex route may name a
Claude primary. Unknown, self, non-Codex, and non-Claude-target fallbacks fail
semantic validation.

## Root and defaults

`version` must be the number `1`. Unknown fields are rejected at every object
level.

`defaults` accepts:

- `namespace`: safe identifier used by owned viewport names; default `loop` for
  durable compatibility.
- `dashboardPort`: integer 1–65535; default 4318.
- `promptDir`: path under the config root; default `.loop/prompts`.
- `runDir`: path under the config root; default `.loop/runs`.
- `viewport`: whether the optional tmux viewport may be created; default true.

Configured paths resolve against the directory containing the adopted config
and may not escape it. Absolute outside paths, `..` escapes, NUL bytes, and
invalid identifiers fail before access.

## Projects

Every project has:

- `name`: unique bounded identifier;
- `brief`: project brief path, default `brief.md`;
- `workingDir`: the one repository used by the live execution path, default `.`;
- `intelligence`: generated context path, default
  `PROJECT-INTELLIGENCE.md`;
- `safetyMode`: `workspace-write` or `review`;
- `providers`: named provider routes;
- `roles`: one or more named team roles; and
- `loops`: autonomy-loop policies.

`safetyMode` does not disable the OS sandbox. `review` and
`workspace-write` preserve the same outer containment; reviewers receive an
inner read-only provider policy. There is no `full-auto` or host-unsandboxed
mode.

### Multi-repository fields

The schema retains project `repositories` and role `repositories` only as
bounded typed shapes for forward evolution. In 1.0.0-rc.1, semantic validation
rejects every non-empty use with an actionable error. Configure one repository
using `workingDir`.

Do not treat the presence of multi-repository library/coordinator modules as
permission to bypass this validation. The CLI and central ControlStore route are
not enabled for them.

## Provider routes

Common provider fields are:

- `type`: `claude`, `codex`, `gemini`, `custom`, `opencode`, `pi`, or `grok`;
- `command`: custom/legacy command override where the adapter permits it;
- `args`: bounded argument list;
- `model`: provider model where supported;
- `effort`: Codex reasoning effort where supported;
- `systemPromptFlag`: Claude legacy system-prompt flag override;
- `fallbackFor`: allowed only for Codex → Claude;
- `cooldownSeconds`: fallback recovery delay;
- `preauthorizingGateway`: evidence claim required for `hard-usd`;
- `promptMode`: `interactive`, `stdin`, or `argument` where supported;
- `env`: bounded provider environment overlay where supported; and
- `auth`: mode, selected environment variable, local configured marker, and
  notes.

`auth.mode` is one of `auto`, `subscription`, `api-key`, or `env`. RelayForge
does not place secrets in the durable control plane or public observations.
Use `relayforge auth status` and `relayforge doctor` to inspect readiness.

Bring-your-own-subscription works for every provider type:

- `subscription` (default when the CLI is installed): RelayForge uses the
  operator's personal login state under the caller's home directory — the same
  local trust model for claude/codex/gemini and for opencode/pi/grok, whose
  contained routes additionally keep their private per-run state (Grok seeds a
  bounded copy of `~/.grok` into its isolated home).
- `api-key`: set the selected environment variable (`auth.env`), e.g.
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `XAI_API_KEY`. OpenCode always
  synthesizes the parent-controlled `OPENCODE_CONFIG_CONTENT` overlay from a
  linked key; the raw key never reaches the child.
- `env`: a named environment variable the provider reads directly.

On ordinary `run --execute`, a structured native adapter (opencode/pi/grok)
is refused **before any mutation** when neither a subscription login nor a
linked API key exists — zero-mutation, fail-closed. Linking one of them is what
enables the route; nothing is probed or uploaded by the check.

### Combining models (multi-model teams)

RelayForge runs **several models together** in one loop — each role binds its
own provider route, and strategies combine freely:

1. **Per-role models**: every `projects[].roles[]` selects one `provider`, so a
   planner can run on Claude/Opus while implementers run on Codex and QA on
   Gemini — all in the same run, each in its own isolated worktree.
2. **Independent reviewer**: the loop `reviewer` role is a separate route (and
   process) from the implementer, so review can use a different model than the
   worker that wrote the change.
3. **Fallback chains**: a provider with `fallbackFor: <primary>` is tried ONLY
   when the primary reports a classified usage/rate/quota limit (start with
   `cooldownSeconds` for a rate-limited route). `src/routing.ts` builds the
   exact primary → fallback chain.
4. **Multi-repository**: P6 `multiRepository.tasks[]` bind their own `provider`
   per task.

A complete, working starter is shipped at
[examples/multi-model-team.config.yaml](../examples/multi-model-team.config.yaml)
(Claude planner+reviewer, Codex implementer with a Codex-mini fallback, Gemini
QA).

### Viewport (tmux)

The tmux viewport is **on by default** (`defaults.viewport: true`): every
`relayforge run --execute` opens its own detached tmux viewport so
`relayforge attach` and `relayforge monitor` work immediately. Disable it with
`defaults.viewport: false` or `RELAYFORGE_TMUX=off` (or by not installing
tmux) — the loop always runs headless regardless; the viewport is a view.

### Claude, Codex, Gemini, and custom

These adapters preserve their established non-interactive builders and output
normalizers while running through one contained transport and settlement path.

- Claude supports the exact audited 2.1.207 contract.
- Codex supports `>=0.144 <0.145`. `yolo: true` is rejected because it is not
  an implemented safety contract. Reviewer calls are read-only.
- Gemini is a legacy contract for supported versions below 1.0.
- A custom provider must identify a real non-interactive executable contract.
  Its behavior and truthful usage reporting remain operator responsibility.

`dangerouslySkipPermissions` is a deprecated Claude-only opt-in retained for
compatibility; it does not remove Bubblewrap/cgroup containment. Prefer the
default false value.

### OpenCode native ACP

The OpenCode descriptor is fixed to the audited 1.18.15 executable behavior and
ACP wire v1. Its configuration is data-only. The following are forbidden:

- command, raw argument, or environment overrides;
- prompt-mode, wire, or protocol changes;
- permission-bypass switches;
- fallback authority;
- `effort` and system-prompt flag overrides; and
- model selection until ACP model-option negotiation is proven.

Readiness requires parent-contained proof of the exact executable, version,
behavior, wire contract, and role policy. A reviewer additionally requires
proven inner deny-mutation policy. The ordinary CLI currently has no injection
surface for this probe evidence; therefore an OpenCode route fails closed as
unavailable before reservation in normal operation. Required release tests use
real contained evidence.

### Pi native RPC

The Pi descriptor is fixed to 0.84.1 and RPC JSONL. It also rejects command,
raw argument, environment, prompt-mode, permission-bypass, and fallback
overrides. Authentication environment names are closed to the audited provider
set.

Readiness requires exact parent-contained executable/version/protocol/behavior
evidence. Reviewer mode requires a content-bound copy of the bundled
`pi-relayforge-reviewer.mjs` helper and inner read-only behavior. Installation
or a version string alone is not enough. As with OpenCode, normal CLI execution
currently reports unavailable before reservation because it does not inject the
required evidence.

### Grok Build native ACP

The Grok descriptor is fixed to stable 1.0.0 build `3cd0d0cbce` and ACP wire
v1. Its supported configuration is data-only: optional `model` and
`auth: { mode: api-key, env: XAI_API_KEY }`. Raw command/argv/env, permission,
leader/socket, serve/headless, plugin, endpoint, trust/yolo, prompt-mode,
effort, and fallback overrides are rejected.

The contained parent uses a private empty HOME/GROK_HOME and fixed disables for
auto-update, web tools, subagents, memory, telemetry, traces, feedback,
instrumentation, prompt suggestions, and summary side calls. Standing
instructions use bounded `session/new._meta.systemPromptOverride`; task text
uses `session/prompt`. Workers remain unattended through parent-controlled ACP
permission replies that select only a provider-offered `allow_once`; reviewers
run in `plan` and permission requests are cancelled. RelayForge never emits
Grok `--yolo`/`--always-approve` or selects a persistent approval. Availability
additionally requires exact executable,
stable version/build/channel, ACP lifecycle, configuration isolation,
network/tool policy, unapproved-upload denial, cancellation, accounting and
role evidence. An installed executable or initialize response alone is not
readiness. See the [Grok P4 audit](reference/phase-04-grok-build-addendum.md).

## Roles

Each role declares:

- unique safe `name`;
- human-readable `title`;
- an existing provider key;
- optional built-in `sme` discipline;
- bounded `responsibilities` and `guardrails`; and
- `autoStart`, default true.

The built-in SME set spans product, architecture, engineering, QA, security,
operations, release, writing, and other disciplines. Unknown disciplines are
rejected by the schema.

Role `repositories` must remain empty in this release. The reviewer must exist;
when a project has multiple roles, it must differ from the loop orchestrator so
review is independent.

## Loops

Important loop controls include:

- `orchestrator`: planning role;
- `reviewer`: independent review role;
- `maxIterations`: 1–1000;
- `maxRepairs`: bounded redispatch count;
- `verify`: ordered verifier commands;
- `verifyStabilityRuns`: consecutive green runs required before dispatch;
- `maxSameFailureCount`: repeated-signature stop threshold;
- `contextTokenBudget`: bounded approximate context characters;
- `postMergeVerify`: verify after each accepted integration;
- `maxParallel`: at most 64 isolated attempts;
- `pollSeconds` and `cadenceMinutes`: bounded loop timing; and
- `stopWhen`: planner hints, not acceptance authority.

The binding completion contract is accepted tasks plus deterministic green
verification. `stopWhen` strings cannot override review or verification.

## Budget modes

| Mode | Contract |
| --- | --- |
| `unlimited` | No USD ceiling; other stop rules still apply |
| `estimated-usd` | Soft post-response accounting; the final in-flight call can overshoot |
| `hard-usd` | Provable ceiling; every possible route must prove a preauthorizing gateway |
| `subscription-quota` | Provider quota state without USD accounting |

If `budgetMode` is omitted, normalization selects `estimated-usd` for a positive
`budgetUsd` and `unlimited` otherwise. A positive budget requires
`maxCostPerCallUsd > 0` and `maxCostPerCallUsd <= budgetUsd`; RelayForge reserves
that maximum before each physical call. Direct Claude/Codex-style CLIs are
post-response and cannot truthfully satisfy `hard-usd` merely by accepting a
soft budget flag.

If cost is missing, the call remains unknown-cost. A positive budget refuses
further unknown spending unless `allowUnknownCostCalls` explicitly permits a
bounded count.

## Offline provisioning

A loop may configure up to 32 provisioning specifications:

```yaml
provision:
  - path: .toolchain
    requiredExecutables:
      - bin/project-tool
```

The parent validates source and destination identities and copies an existing
local tree into integration, attempt, and review worktrees before readiness.
Paths, aliases, overlap, symlinks, special files, size, entry count, depth, and
required executable identity are checked by the same validator used by config,
doctor, and execution.

Provisioning never downloads, runs a package manager, executes lifecycle
scripts, or mutates the source tree. Empty `provision` disables the copy gate.
Large valid trees can still cost time and disk.

## Environment compatibility

Use the public names in new automation:

| Public | Legacy alias | Meaning |
| --- | --- | --- |
| `RELAYFORGE_TMUX=off` | `LOOP_TMUX=off` | Disable the optional viewport for one invocation |
| `RELAYFORGE_TMUX_SOCKET` | `LOOP_TMUX_SOCKET` | Select the tmux socket name |
| `RELAYFORGE_SANDBOX` | `LOOP_SANDBOX` | Select the supported sandbox backend policy |

The tmux override can disable, never enable, a config-disabled viewport. If
both names in a pair are set, their values must agree or startup fails. Other
internal test and release variables are not public runtime configuration.

## Validation workflow

```bash
relayforge validate
relayforge doctor
relayforge run "Check configuration" --json
```

The run command remains a no-provider dry run unless `--execute` is present.
`doctor` reports unavailable capabilities rather than treating a skipped probe
as success. Fix every error before authorizing execution; warnings should be
understood and recorded.
