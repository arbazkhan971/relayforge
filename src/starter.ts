export function starterConfig(): string {
  return `version: 1
defaults:
  namespace: loop
  dashboardPort: 4318
  promptDir: .loop/prompts
  runDir: .loop/runs

projects:
  - name: demo-product
    brief: brief.md
    workingDir: .
    intelligence: PROJECT-INTELLIGENCE.md
    safetyMode: workspace-write
    providers:
      planner-claude:
        type: claude
        model: claude-opus-4-8
        auth:
          mode: auto
        dangerouslySkipPermissions: true
        args: []
        promptMode: interactive
      impl-claude:
        type: claude
        model: claude-sonnet-4-6
        auth:
          mode: auto
        dangerouslySkipPermissions: true
        args: []
        promptMode: interactive
      impl-codex:
        type: codex
        model: gpt-5.1-codex
        effort: medium
        auth:
          mode: auto
        yolo: true
        args: []
        promptMode: interactive
      scout-gemini:
        type: gemini
        model: gemini-3-pro
        auth:
          mode: auto
        args: []
        promptMode: interactive
    roles:
      - name: pm
        title: Product Manager
        provider: planner-claude
        sme: product-manager
      - name: architect
        title: Architect / CTO
        provider: planner-claude
        sme: architect
      - name: fe
        title: Frontend Engineer
        provider: impl-claude
        sme: frontend
      - name: be
        title: Backend Engineer
        provider: impl-codex
        sme: backend
      - name: qa
        title: QA Engineer
        provider: impl-claude
        sme: qa
      - name: ct
        title: Test Automation Engineer
        provider: impl-codex
        sme: ct
      - name: security
        title: Security Engineer
        provider: impl-claude
        sme: security
      loops:
      - name: delivery-loop
        cadenceMinutes: 30
        maxIterations: 6
        idleSeconds: 20
        pollSeconds: 8
        orchestrator: pm
        reviewer: qa          # independent critic that reviews diffs and can reject
        maxRepairs: 2          # failed tasks are retried with error context before escalating
        verifyStabilityRuns: 3  # run verifier this many times before trusting green
        maxSameFailureCount: 2  # stop when same failure repeats this many times
        contextTokenBudget: 16000 # per-iteration context snapshot budget (characters)
        postMergeVerify: true   # rerun verifier after each accepted merge
        maxParallel: 2         # SMEs work concurrently (each in its own git worktree)
        isolate: true          # git-worktree isolation so parallel edits never collide
        budgetUsd: 0           # set a USD cap to bound autonomous spend (0 = unlimited)
        stopWhen:
          - all tasks done
          - tests pass
`;
}

export function starterBrief(): string {
  return `# Demo Product Brief

You are an autonomous, self-organizing SME team building and maintaining a
full-stack web product through small, reviewable, test-backed changes.

## Mission

Take a goal, decompose it on the shared board, and drive it to "done" with no
human in the loop — plan, build, test, review, and verify against acceptance
criteria until every task is complete and the test suite is green.

## How the team operates

- The PM owns the board: it turns the goal into user stories with explicit,
  testable acceptance criteria and is the accept/reject authority.
- The Architect decomposes work into independent, well-scoped tasks and owns
  cross-cutting risk; it delegates rather than implements.
- FE, BE, CT, and Security SMEs claim tasks from the board and deliver them to
  their definition of done, leaving the codebase better than they found it.
- QA verifies every acceptance criterion with evidence before anything is
  marked merge-ready.

## Operating principles

- Keep every task scoped to the goal; defer out-of-scope work, don't absorb it.
- Read PROJECT-INTELLIGENCE.md first and reuse existing patterns, commands,
  and conventions — match the project, don't reinvent it.
- Prefer the smallest reversible change; keep API and UI changes
  backward-compatible unless the task explicitly allows a break.
- Never run destructive operations against real data or commit secrets.
- Run the project's tests and include evidence before requesting review.
- Do not mention private customer or repository names in public artifacts.
`;
}
