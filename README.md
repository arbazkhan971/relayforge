# RelayForge

RelayForge coordinates a small team of AI coding agents through planning,
isolated implementation, independent review, deterministic verification, and
bounded settlement. The primary command and npm package are `relayforge`.

> **Release handoff tracker:** see
> **[docs/implementation-status.md](docs/implementation-status.md)** for live
> phase evidence, release blockers vs external actions, resume order, and what
> is still incomplete. Prefer that document over any older “planned” prose.

This source tree targets release candidate **1.0.0-rc.1**. Preparing the source
does **not** mean that an npm package, GitHub release, repository rename, or
remote tag has been published. Last pushed handoff commit on
`agent/loop-engineering-hardening` is `860688c55207be051431d470b44b038025a12e5c`;
the large P0–P7 product integration remains dirty/uncommitted beyond that
checkpoint, so final committed-HEAD gates remain pending and no final
integration SHA exists yet. On the dirty tree, required-cgroup aggregate
(**171** files / **1,925** tests + clean TypeScript build), source smoke, exact
preview tarball, and packed real-browser Chrome gate are green; release
readiness still requires the integration commit and full committed-HEAD
rerun/push, plus real OpenCode/Pi/Grok receipts before any tag or publish.
Those publication steps are explicit operator actions described in
[docs/publishing.md](docs/publishing.md).

## Identity and compatibility

| Surface | Primary identity | Compatibility behavior |
| --- | --- | --- |
| Product and package | RelayForge / `relayforge` | “Loop Orchestrator” is a historical name only |
| Executable | `relayforge` | `loop` and `loop-orchestrator` invoke the same entry point |
| New config | `relayforge.config.yaml` | Existing `loop.config.yaml`, `.yml`, or `.json` remains valid |
| New state | `.loop/` | The durable directory is intentionally unchanged |
| Environment | `RELAYFORGE_*` | Documented `LOOP_*` aliases remain supported |

Config discovery accepts `.yaml`, `.yml`, and `.json` in both naming families.
If more than one candidate exists in the same discovered directory, RelayForge
fails with `CONFIG_AMBIGUOUS`; use `--config <exact-path>` or remove the
ambiguity. `relayforge init` never overwrites any existing config, including
with `--force`.

## What is shipped

- A safe dry run by default; providers launch only with `--execute`.
- One disposable Git worktree per implementation attempt and a separate
  read-only reviewer boundary.
- A Linux containment chain using Bubblewrap and delegated cgroup v2 process
  scopes, with authenticated launch handshakes and fail-closed cleanup.
- A durable run-scoped SQLite control plane with strict migration,
  reconciliation, replay, read models, and a foreground loopback service.
- Parent-owned steering for a future immutable attempt boundary. It cannot
  inject input into a running agent.
- Seven closed provider adapter types: Claude, Codex, Gemini, custom, OpenCode,
  Pi, and Grok Build. OpenCode, Pi, and Grok require exact native-protocol
  evidence; ordinary product runs currently refuse before mutation when product
  evidence injection is not available (see [Current boundaries](#current-boundaries)).
- Bounded normalized control-room observations. Public status never exposes raw
  provider transcripts, terminal buffers, prompts, environment values, or
  credentials.
- Durable SCM components and **product-integrated multi-repository** execution
  (strict config/validation, CLI run route, ControlStore facts/views, authority,
  DAG/scheduler, worktree groups, contained transport/settlement, publication
  bridge, read isolation, crash recovery). Explicit SCM/publication config drives
  recoverable branch/PR publication, parent polling, and reaction-to-steering;
  RelayForge never invents a remote publication plan.

## Requirements

- Node.js 20.x or 22+
- Git
- A clean Git repository before an executing run
- Linux for the strongest supported Bubblewrap + delegated-cgroup containment
- At least one configured provider CLI for `--execute`

The package has no post-install provisioning. Provider CLIs, Bubblewrap, cgroup
delegation, credentials, and project dependencies remain operator-managed.

## Start from this source tree

```bash
npm ci
npm run build
npm link

cd /path/to/your-git-project
relayforge init
relayforge validate
relayforge doctor
relayforge learn
relayforge run "Ship the smallest verified change"
```

The last command is a dry run: it plans run state but launches no provider. To
authorize execution:

```bash
relayforge run "Ship the smallest verified change" --execute
```

After an authorized operator has verified and published this exact release to
npm, a clean installation is:

```bash
npm install --global relayforge@1.0.0-rc.1
relayforge --version
```

Do not assume the registry version exists merely because this source tree has
that version.

## The execution path

An executing run follows one authority path:

1. Validate strict configuration and cross-references before mutation.
2. Require a clean repository and acquire the configuration and run leases.
3. Create the integration worktree and durable control store.
4. Select a compatible provider descriptor and prove its executable, version,
   protocol, wire behavior, role capability, and containment readiness before
   reserving a call.
5. Plan tasks, then launch each worker through the parent-owned contained
   transport. Descriptors and codecs cannot spawn processes.
6. Review a content-bound candidate through an independent read-only role.
7. Run deterministic verifier commands in the verifier sandbox, requiring the
   configured stability count.
8. Settle the exact reserved call scope once, record receipts, and accept or
   reject the candidate.

RelayForge succeeds only when every task is accepted and the final verifier is
green. Cancelled, blocked, budget-exhausted, unverified, and unreadable terminal
states exit non-zero.

## Configuration

`relayforge init` writes a strict starter config. A compact valid example is:

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
      agent:
        type: claude
        model: opus
        auth:
          mode: auto
    roles:
      - name: pm
        title: Planner
        provider: agent
      - name: engineer
        title: Implementer
        provider: agent
      - name: qa
        title: Reviewer
        provider: agent
    loops:
      - name: delivery
        orchestrator: pm
        reviewer: qa
        verify:
          - npm test
        maxIterations: 8
        verifyStabilityRuns: 3
        maxParallel: 1
        budgetUsd: 0
```

Unknown keys are rejected. Identifiers are bounded, paths must remain under the
config root, role and provider references must resolve, and an ambiguous config
name fails closed. See [docs/configuration.md](docs/configuration.md) for the
full operator contract, budgets, provisioning, adapters, and compatibility
environment variables.

## Providers and adapters

| Type | Contract | Important readiness rule |
| --- | --- | --- |
| `claude` | Claude headless adapter, exact supported build | OS containment remains the outer boundary |
| `codex` | Codex exec adapter, `>=0.144 <0.145` | Reviewer runs read-only; `yolo: true` is rejected |
| `gemini` | Legacy Gemini adapter, supported versions below 1.0 | Uses the same contained transport and settlement |
| `custom` | Operator-supplied non-interactive command | Command behavior and usage reporting remain operator responsibility |
| `opencode` | OpenCode 1.18.15, ACP wire v1 | Exact executable/version/behavior evidence and role policy required |
| `pi` | Pi 0.84.1, RPC JSONL | Exact evidence plus the content-bound bundled reviewer helper required |
| `grok` | Grok Build stable 1.0.0 build `3cd0d0cbce`, ACP wire v1 | API-key-only private config plus exact behavior/network-tool/no-upload evidence required |

OpenCode, Pi, and Grok configuration is deliberately closed: raw command, argument,
environment, protocol, permission-bypass, and fallback overrides are rejected.
An installed executable or successful `--help`/`--version` probe is not enough.

**Truthful native-adapter limitations (current product):**

- OpenCode production characterization exists and has hardened
  fixture/required-host tests, but a real release receipt needs the designated
  runner, exact installed binary, and live credential.
- Pi and Grok production characterizations are still **typed unavailable** and
  emit **no** release receipt.
- Ordinary OpenCode/Pi/Grok product execution currently **refuses before**
  run/control/worktree mutation because product evidence injection is
  intentionally not supported yet.
- The publishable release workflow requires distinct same-runner OpenCode, Pi,
  and Grok receipts and remains **fail-closed**.

Grok additionally refuses ambient subscription or managed configuration: the
supported profile requires `XAI_API_KEY`, a private empty HOME/GROK_HOME, fixed
telemetry/trace/update disables, no leader, plugins, endpoint overrides,
always-approve/yolo, subagents, memory, or web tools, and a real contained
no-upload observation.

Every accepted call identity binds the adapter, contract, transport, wire
version, codec, normalizer, executable evidence, and role policy. Framing,
transcripts, correlation, cancellation, and settlement are bounded. Missing
usage remains unknown; it is never converted into a fabricated zero.

## Durable local control

Start the foreground service in the repository containing the config:

```bash
relayforge serve
relayforge serve status --json
relayforge serve stop
```

`relayforge dashboard` is a compatibility alias for the foreground service.
The service binds literal `127.0.0.1`, writes a bounded private discovery file,
and exposes a read-only HTTP API:

- `GET`/`HEAD /api/v1/health`
- `GET`/`HEAD /api/v1/status`
- `GET`/`HEAD /api/v1/runs`
- `GET`/`HEAD /api/v1/runs/:run`
- `GET`/`HEAD /api/v1/runs/:run/board`
- `GET`/`HEAD /api/v1/runs/:run/activity`
- `GET`/`HEAD /api/v1/runs/:run/steering`
- `GET`/`HEAD /api/v1/runs/:run/observations`
- `GET`/`HEAD /api/v1/runs/:run/diagnostics`
- `GET /api/v1/runs/:run/events` for durable SSE invalidation

The server rejects request bodies, credentials, foreign Host/Origin values,
unknown routes and query parameters, malformed IDs, oversized requests, and
unsupported methods. HTTP is observational: there is no mutation API.
Responses are schema-versioned, allowlisted, redacted, and byte-capped.

SQLite is the canonical post-cutover run history and projection source.
Legacy JSONL state can be migrated once through strict, receipted recovery; it
does not remain a second authority. Event retention and canonical event
deletion are not yet an operator feature.

## Steering a live run

Steering is not terminal injection. Generate an id, then admit or withdraw an
exact command against an active run and epoch:

```bash
relayforge --json steer new-id
relayforge steer admit \
  --project <project-name> \
  --run <run-id> \
  --run-epoch <run-epoch> \
  --command-id <command-id> \
  --task-id <task-id> \
  --task-generation <task-generation> \
  --session-id <session-id> \
  --session-generation <session-generation> \
  --not-before-attempt <attempt-generation> \
  --body "Prioritize the regression before the next attempt"

relayforge steer withdraw \
  --project <project-name> \
  --run <run-id> \
  --run-epoch <run-epoch> \
  --command-id <command-id>
```

Admission means only that the parent accepted a durable command for a future
attempt prompt boundary. It does not prove inclusion, delivery, provider read,
or compliance. A command can become pending, included, refused, withdrawn,
superseded, or expired. Already running processes and immutable prompt files are
never changed. The mutation channel is a private run-scoped Unix socket held by
the active parent, not HTTP or tmux. See
[docs/session-steering.md](docs/session-steering.md).

## Monitor and control room

```bash
relayforge monitor --run <run-id>
relayforge attach --run <run-id>
relayforge status
relayforge logs <owned-tmux-session> --lines 160
```

`monitor` is run-scoped. `logs` is only an optional tmux pane capture and takes
the exact RelayForge-owned session name reported by `status`; it has no
`--run` option. Tmux is not an execution or control authority. Disabling it
does not disable the run, monitor, durable control store, or dashboard.

Control-room observations use normalized, bounded records with source
continuity and cursor semantics. Raw PTY bytes and raw provider transcripts are
not part of the public DTO. Missing projections, stale cursors, identity
mismatches, and over-size responses produce typed errors instead of partial or
unsafe output.

## Budgets

- `unlimited`: no USD ceiling.
- `estimated-usd`: post-response accounting and reservation tripwire. The last
  in-flight call can overshoot; this is not a hard cap.
- `hard-usd`: accepted only when every route proves a preauthorizing gateway.
  Direct provider CLIs do not satisfy this contract.
- `subscription-quota`: provider quota/limit state machine without USD
  metering.

A positive `budgetUsd` requires a positive `maxCostPerCallUsd` no greater than
the budget. Unknown cost fails closed unless the bounded
`allowUnknownCostCalls` policy explicitly permits it.

## Offline provisioning

A loop may list parent-side dependency trees under `provision`. RelayForge
validates and copies existing local trees into every integration, attempt, and
review worktree before an agent or verifier can observe them. Provisioning does
not download packages, invoke installers, execute lifecycle scripts, or modify
the original tree. It can consume substantial time and disk and must fit the
configured bounds. See [docs/safety.md](docs/safety.md).

## Current boundaries

The following distinctions are deliberate release claims:

- **Single-repository execution is live.** Use `workingDir` for one repository.
- **Multi-repository execution is product-integrated.** Strict config/validation,
  actual CLI run route, canonical ControlStore facts/views, exact repository-set
  authority, DAG and scheduler, all-or-nothing worktree groups, worker and
  verification through the canonical contained transport and settlement path,
  vector integration, publication bridge, exact read isolation, durable crash
  recovery, and real product E2Es are landed. Focused counts: authority
  **21/21**, orchestration **12/12**, product/recovery/verifier **6/6**,
  publication/SCM/integration **13/13**.
- **SCM behavior is explicit and config-driven.** With `project.scm` and a P6
  task publication plan, the run parent owns recoverable branch/PR publication,
  bounded CI/review polling, durable observations, and reaction-to-P2 steering.
  A run without that explicit plan performs no remote publication.
- **Native OpenCode/Pi/Grok ordinary runs refuse before mutation** until real
  product evidence is available; Pi/Grok characterizations remain typed
  unavailable; publishable release requires distinct same-runner receipts.
- **The loopback control service is local and read-only.** It is not a remote
  multi-user service, a terminal gateway, or a write API.
- **Provisioning is offline copying, not dependency installation.**
- **No tag, npm publish, GitHub Release, repository rename, or real native
  receipt has been performed.**

## Useful commands

```text
relayforge init                         create canonical starter files
relayforge validate                     validate strict config and semantics
relayforge doctor                       inspect host/config/provider readiness
relayforge learn                        write PROJECT-INTELLIGENCE.md
relayforge run <goal>                   dry-run by default
relayforge run <goal> --execute         authorize contained provider execution
relayforge monitor --run <id>           terminal mission-control view
relayforge serve                        foreground local control service
relayforge serve status|stop            inspect/stop the exact service owner
relayforge steer new-id|admit|withdraw  future-boundary steering
relayforge stop <run>                   request parent-owned run cancellation
relayforge tmux pre|new|show|kill|prune manage optional owned viewports
```

Run `relayforge --help` for the complete command surface.

## Documentation

- **[Implementation status and release handoff](docs/implementation-status.md)** — current capabilities, evidence counts, blockers, resume order
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Safety model](docs/safety.md)
- [Session steering](docs/session-steering.md)
- [Autonomous team operations](docs/autonomous-team.md)
- [Branding and compatibility](docs/branding.md)
- [Release and publishing runbook](docs/publishing.md)
- [Changelog](CHANGELOG.md)

The design evidence and ADRs under `docs/reference/` and `docs/adr/` are packed
with the release candidate so an operator can audit the claims made here.

## License

MIT. See [LICENSE](LICENSE).
