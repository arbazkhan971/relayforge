# Configuration

`loop.config.yaml` is the control plane for your team.

## Providers

```yaml
providers:
  frontend:
    type: claude
    model: claude-sonnet-4-6
    auth:
      mode: subscription
      configured: true
    dangerouslySkipPermissions: true
    args: []
    promptMode: interactive
  backend:
    type: codex
    model: gpt-5.4
    effort: medium
    auth:
      mode: subscription
      configured: true
    yolo: true
    args: []
```

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

Unsafe execution switches:

- `dangerouslySkipPermissions: true` adds `--dangerously-skip-permissions` for Claude providers.
- `yolo: true` adds `--yolo` for Codex providers.
- Raw `args` still work and are not duplicated when the typed switch is also enabled.

Prompt modes:

- `interactive`: start the agent and show the prompt file path.
- `stdin`: pipe the generated prompt into the command.
- `argument`: pass a short instruction pointing to the prompt file.

## Repositories

```yaml
repositories:
  - name: frontend-app
    path: ~/work/frontend-app
    role: frontend
    defaultBranch: main
    protectedBranches: [main, production]
```

## Roles

Roles define what each session should do.

```yaml
roles:
  - name: fe1
    title: Frontend engineer
    provider: frontend
    repositories: [frontend-app]
    responsibilities:
      - Implement accessible responsive UI changes.
      - Run browser smoke tests and capture screenshots.
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
    idleSeconds: 20
    pollSeconds: 8
    orchestrator: pm
    reviewer: qa
    maxRepairs: 2
    verifyStabilityRuns: 3
    maxSameFailureCount: 2
    contextTokenBudget: 16000
    postMergeVerify: true
    maxParallel: 2
    isolate: true
    budgetUsd: 0
```

Field reference:

- `cadenceMinutes`: per-task headless timeout
- `maxIterations`: hard cap on loop rounds
- `stopWhen`: accepted stop conditions (`all tasks done`, `tests pass`, `review complete`, `pull request opened`)
- `idleSeconds`: quiescence timeout used by the monitor
- `pollSeconds`: delay between iterations
- `orchestrator`: role used for decomposition and orchestrator duties
- `reviewer`: role used as independent reviewer
- `maxRepairs`: max failed attempts before escalation
- `verifyStabilityRuns`: repeat verifier runs required to confirm stable green state
- `maxSameFailureCount`: stop when the same failure signature repeats this many times
- `contextTokenBudget`: budget for each iteration's context snapshot (characters)
- `postMergeVerify`: re-run verifier immediately after accepted merge
- `maxParallel`: max simultaneous role dispatches per round
- `isolate`: enable per-role git worktrees for collision-free parallelism
- `budgetUsd`: stop if total estimated USD spend reaches this limit (0 = unlimited)
