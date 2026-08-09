# Configuration

`loop.config.yaml` is the control plane for your team. Everything lives under one or more `projects`; each project has its own `providers`, `roles`, and `loops`, and works on a single repository via `workingDir`.

```yaml
version: 1
defaults:
  namespace: loop
  runDir: .loop/runs
  viewport: true                  # the OPTIONAL tmux viewport (see below)

projects:
  - name: demo-product
    brief: brief.md
    workingDir: .                 # the loop works one repository at a time
    intelligence: PROJECT-INTELLIGENCE.md
    safetyMode: workspace-write
    providers: { ... }
    roles: [ ... ]
    loops: [ ... ]
```

`safetyMode` accepts only `review` and `workspace-write` (default). The former `full-auto` mode has been **removed** — there is no unsandboxed host mode. The schema is **strict**: unknown keys are rejected by `loop validate`.

## The tmux viewport (`defaults.viewport`)

`viewport: true` (the default) lets a run open its optional tmux viewport — one tiled pane per role,
opened with `loop tmux new`. Set it to `false` and Loop never touches tmux: the loop still runs fully
headless, and `loop monitor` and the dashboard still show everything.

The `LOOP_TMUX=off` environment variable disables the viewport for a single invocation. It can only
ever **disable** — it never enables a viewport the config turned off — so a CI job or a test suite can
guarantee "this process opens no tmux sessions" with one variable. `loop doctor` reports both facts
(`tmux` = is the binary installed; `tmux-viewport` = is the viewport switched on), because they need
different fixes.

Session names are derived from `namespace`, project, run id, and role, and are always tmux-safe: `.`
and `:` are rewritten (tmux silently stores them as `_`, which would make two different projects
collide on one session), and a stable identity hash is appended so distinct runs can never share a
session. Every Loop-created session is stamped with `@loop-*` ownership metadata — Loop will not adopt,
capture, or kill a session that lacks it.

## Providers

```yaml
providers:
  frontend:
    type: claude
    auth:
      mode: subscription
      configured: true
    args: []
    promptMode: interactive
  backend:
    type: codex
    effort: medium
    auth:
      mode: subscription
      configured: true
    args: []
```

Models are **unpinned by default for Codex and Gemini** — the provider CLI uses its own default so the config never references a model that may not exist. A **Claude** provider is the one exception: it defaults to the `opus` alias (Opus is the primary implementation executor in the routing design), so a Claude turn runs `--model opus` unless you set `model:` to override it. Set `model:` on any provider to pin a specific model.

Auth modes:

- `auto`: let `loop auth configure --write` detect local setup.
- `subscription`: use locally authenticated CLI state, such as prior OAuth/login.
- `api-key`: use the named env var for API billing.
- `env`: user still needs to install/login/set an env var.

Local setup:

```bash
loop auth status
loop auth configure --write
```

Secret values are never stored. Only the env var name is written.

How providers are invoked (the orchestrator sets these deterministically; it rejects conflicting raw `args`):

- **Claude** runs headless with `--permission-mode acceptEdits` for implementers and `--permission-mode plan` (read-only) for reviewers. `--dangerously-skip-permissions` is **never** added by default.
- **Codex** runs `codex exec --sandbox workspace-write` (implementer) / `--sandbox read-only` (reviewer), with reasoning effort via `-c model_reasoning_effort=<minimal|low|medium|high>` (set `effort:`). It never uses `--full-auto` or `--effort`.
- **Gemini** and **custom** providers carry no provider-native safety claim; their containment is the OS sandbox.

Explicit opt-in switches (discouraged):

- `dangerouslySkipPermissions: true` (Claude) is an explicit opt-in bypass — **no longer added by default**, discouraged, and **requires an OS sandbox** (if none is available the run fails closed rather than bypassing permissions). `loop init` emits it off. Codex has **no** equivalent in this release: `yolo: true` is **not supported** and `loop validate` now **rejects** it (it never had any effect — a config that set it was silently ignored). Codex's boundary is `exec --sandbox workspace-write` (reviewers `read-only`) plus the OS sandbox. See `docs/safety.md`.

Routing:

- `fallbackFor: <providerKey>` marks a provider as the fallback for a primary; it is used only on an explicitly-classified usage/rate/quota limit of the primary.
- `cooldownSeconds` (default 900): how long a rate-limited primary is left in cooldown before it is probed again. `loop init` wires an `opus` (Claude, primary) + `gpt` (Codex, `fallbackFor: opus`) chain when both CLIs are installed.

Prompt modes:

- `interactive`: start the agent and show the prompt file path.
- `stdin`: pipe the generated prompt into the command.
- `argument`: pass a short instruction pointing to the prompt file.

## Repositories

Multi-repository execution is **not supported** in this release and is rejected by `loop validate` (both a project-level `repositories:` list and a `repositories:` field on a role). Run one repo at a time by setting the project's `workingDir` and starting a separate run per repository.

## Roles

Roles define what each session should do. A role references a provider key and, optionally, an `sme:` discipline that seeds its expert system prompt.

```yaml
roles:
  - name: implementer
    title: Implementer
    provider: frontend
    sme: fullstack
```

## Loops

Loop controls live on each project's `loops` entry and are the heart of autonomous execution.

```yaml
loops:
  - name: delivery-loop
    cadenceMinutes: 30
    maxIterations: 8
    stopWhen:
      - all tasks done
      - tests pass
    pollSeconds: 8
    orchestrator: pm
    reviewer: qa
    maxRepairs: 2
    verifyStabilityRuns: 3
    maxSameFailureCount: 2
    contextTokenBudget: 16000
    verify: []
    provision:
      - path: node_modules
        requiredExecutables:
          - .bin/tsc
    postMergeVerify: true
    maxParallel: 2
    budgetUsd: 0
    maxCostPerCallUsd: 0    # REQUIRED when budgetUsd > 0 (> 0 and <= budgetUsd)
    allowUnknownCostCalls: 0
```

Field reference:

- `cadenceMinutes`: per-task headless timeout
- `maxIterations`: hard cap on loop rounds
- `stopWhen`: **advisory** free-text "done" hints, surfaced to the planner when it decomposes the goal. They are NOT loop gates — completion is decided by independent review plus the deterministic verifier, which no hint can weaken or substitute for. There are no reserved/special values (an earlier draft listed `review complete` / `pull request opened`; no such conditions are interpreted, and there is no pull-request integration in this release).
- `pollSeconds`: delay between iterations
- `orchestrator`: role used for decomposition and orchestrator duties
- `reviewer`: role used as independent reviewer (must differ from the orchestrator when the project has more than one role)
- `maxRepairs`: max failed attempts before escalation
- `verifyStabilityRuns`: repeat verifier runs required to confirm stable green state
- `maxSameFailureCount`: stop when the same failure signature repeats this many times
- `contextTokenBudget`: budget for each iteration's context snapshot (characters)
- `verify`: ordered list of verifier commands (run in sequence; all must pass). Empty = auto-detect the project's test then build command from PROJECT-INTELLIGENCE.
- `provision`: bounded offline dependency trees copied from the selected project's `workingDir`
  into every loop-owned worktree before it can become ready. See [Offline worktree
  provisioning](#offline-worktree-provisioning).
- `postMergeVerify`: re-run verifier immediately after accepted merge
- `maxParallel`: max simultaneous role dispatches per round. Each task always runs in its own git worktree; isolation is mandatory and cannot be disabled.
- `budgetUsd`: stop if total estimated USD spend reaches this limit (0 = unlimited). Budgets are checked before every planner/worker/reviewer call; when a provider reports no cost, spend is recorded as unknown, never silently zero.
- `maxCostPerCallUsd`: the per-call reservation cap. **Required whenever `budgetUsd > 0`** — it must be `> 0` and `<= budgetUsd`. A positive budget with no per-call cap **fails closed before the planner** (the run ends `blocked`), because without a cap every call would have to reserve the entire budget, making the budget a one-call limit rather than a real ceiling. Leave it `0` only when `budgetUsd` is `0` (unlimited).
- `allowUnknownCostCalls` (default 0): under a positive `budgetUsd`, the run **fails closed** when providers report unknown cost more than this many times, so an unmetered provider can't silently blow past the budget.
- `budgetMode` (default `estimated-usd`): `estimated-usd` is a soft post-response ledger (the direct CLIs report cost only after each turn); `subscription-quota` meters no USD (do not set `budgetUsd`); `unlimited` disables the USD budget. `hard-usd` — a provable pre-authorized ceiling — is **not available in this release**: it requires a real preauthorizing billing-gateway adapter (server-side cap, idempotency key, authoritative receipt), which is not integrated, so selecting it **fails closed**. The `preauthorizingGateway` flag is reserved for that future adapter and does not by itself enable `hard-usd`.

## Offline worktree provisioning

`provision` makes an already-installed local dependency tree available inside isolated Git
worktrees without running an installer. It is configured per loop as a list of strict objects:

```yaml
loops:
  - name: delivery-loop
    provision:
      - path: node_modules
        requiredExecutables:
          - .bin/tsc
          - .bin/vitest
      - path: vendor
```

An absent or empty list disables provisioning. A loop may contain at most 32 specs; each spec has
one canonical repository-relative `path` and an optional bounded `requiredExecutables` list. Those
executable paths are relative to that spec, so `.bin/tsc` above means
`node_modules/.bin/tsc`. Validation rejects absolute, rooted, backslash, traversal, duplicate,
case-alias, overlapping, and Git/Loop control paths rather than normalizing ambiguous input.

Provisioning is a parent-owned readiness gate for **all three worktree roles**:

- the integration worktree used for accepted merges and deterministic verification;
- each isolated implementation-attempt worktree;
- each independent review checkout.

A worktree is not runnable while its dependencies are being staged. RelayForge builds a private
staging tree, validates it completely, and only then publishes it into the worktree. A provider,
reviewer, or verifier may start only after the worktree is ready. A configured source that is
missing, unreadable, not a real directory, unsafe, or lacks a `requiredExecutables` marker blocks
the run; it is never downgraded to a warning. `loop doctor` reports the affected loop and path and
performs only this same read-only source inspection—it does not create staging or destination
state, and an eligible result is not a promise that a later filesystem copy cannot fail.

The operation is deliberately offline and inert:

- it does not run package managers, lifecycle hooks, setup scripts, or any child process;
- it performs no network access and uses no package-registry credentials;
- it never uses hardlinks or shares a writable dependency directory with the human checkout;
- it prefers filesystem copy-on-write clones and otherwise copies bytes into distinct files;
- it accepts only constrained relative symlinks whose lexical and physical targets remain inside
  the configured source tree; absolute, dangling, cyclic, or escaping links block readiness.

Current limitations are intentional. Provisioning copies existing local bytes; it does not resolve
or install dependencies, refresh lockfiles, deduplicate copies across worktrees, or execute trusted
repository setup hooks. Large trees can therefore consume copy time and, where filesystem reflinks
are unavailable, additional disk space. `requiredExecutables` is a readiness marker for a contained
executable file—it is not a general command probe and doctor never executes it. Prepare the source
tree in the selected `workingDir` before starting the loop, then use `loop doctor` to verify its
eligibility.
