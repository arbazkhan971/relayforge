import { spawnSync } from "node:child_process";
import { isValidId } from "./ids.js";

export type StarterProvider = "claude" | "codex" | "gemini" | "custom";

/**
 * Turn a repository/package name into the canonical identifier RelayForge needs for run paths,
 * branches, and tmux sessions. Starter generation is the one place where normalization is useful:
 * the value is discovered locally rather than supplied as an authoritative config identifier.
 */
export function normalizeStarterProjectName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/^@+/u, "")
    .replace(/[\\/]+/gu, "-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/\.{2,}/gu, ".")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 64)
    .replace(/[^A-Za-z0-9]+$/u, "");
  return isValidId(normalized) ? normalized : "project";
}

const PROVIDER_CLIS: Record<Exclude<StarterProvider, "custom">, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini"
};

function cliInstalled(command: string): boolean {
  // Non-login shell so process.env.PATH is authoritative (login shells reload profile PATH).
  return spawnSync("bash", ["-c", `command -v '${command.replaceAll("'", "'\\''")}'`], {
    stdio: "ignore",
    env: process.env
  }).status === 0;
}

/** Which provider CLIs are installed locally (used to auto-pick and to inform the user). */
export function detectInstalledProviders(): Exclude<StarterProvider, "custom">[] {
  return (Object.keys(PROVIDER_CLIS) as Exclude<StarterProvider, "custom">[]).filter((p) =>
    cliInstalled(PROVIDER_CLIS[p])
  );
}

/**
 * Choose the provider `relayforge init` should wire the starter to: the caller's explicit override
 * if given, else the first installed CLI in preference order, else claude as a safe default
 * the user can adjust. Returns the choice plus whether it was actually detected as installed.
 */
export function chooseStarterProvider(override?: StarterProvider): { provider: StarterProvider; installed: boolean; detected: Exclude<StarterProvider, "custom">[] } {
  const detected = detectInstalledProviders();
  if (override) return { provider: override, installed: override === "custom" ? false : detected.includes(override), detected };
  const order: Exclude<StarterProvider, "custom">[] = ["claude", "codex", "gemini"];
  const picked = order.find((p) => detected.includes(p)) ?? "claude";
  return { provider: picked, installed: detected.includes(picked), detected };
}

/**
 * Build the `providers:` block and the provider key the roles reference. When the user did NOT
 * force a provider and BOTH the Claude and Codex CLIs are installed, auto-wire the routing chain:
 * `opus` (Claude, primary) + `gpt` (Codex) declared `fallbackFor: opus` — Codex is used ONLY on
 * an explicit Claude usage/rate/quota limit. When only one CLI is present a single provider is
 * emitted and the config stays valid.
 */
function providersSection(picked: StarterProvider, detected: string[], override: boolean): { block: string; providerKey: string } {
  if (picked === "custom") {
    return {
      providerKey: "agent",
      block: `      agent:
        type: custom
        # A custom provider must resolve to a non-interactive command that reads a prompt.
        command: ./my-agent.sh
        args: []`
    };
  }

  if (!override && detected.includes("claude") && detected.includes("codex")) {
    return {
      providerKey: "opus",
      block: `      opus:
        type: claude
        model: opus            # Claude Opus is the PRIMARY implementation executor
        auth:
          mode: auto
      gpt:
        type: codex
        fallbackFor: opus      # used ONLY on an explicit Claude usage/rate/quota limit
        cooldownSeconds: 900   # after which Opus is probed again
        auth:
          mode: auto`
    };
  }

  const key = picked === "claude" ? "opus" : picked === "codex" ? "gpt" : "agent";
  const modelLine = picked === "claude" ? "\n        model: opus" : "";
  return {
    providerKey: key,
    block: `      ${key}:
        type: ${picked}${modelLine}
        auth:
          mode: auto`
  };
}

export function starterConfig(
  provider: StarterProvider = "claude",
  detected: string[] = [],
  override = false,
  projectName = "demo-product"
): string {
  const { block, providerKey } = providersSection(provider, detected, override);
  const canonicalProjectName = normalizeStarterProjectName(projectName);
  return `version: 1
defaults:
  namespace: loop
  dashboardPort: 4318
  promptDir: .loop/prompts
  runDir: .loop/runs

projects:
  - name: ${canonicalProjectName}
    brief: brief.md
    workingDir: .
    intelligence: PROJECT-INTELLIGENCE.md
    # review = reviewer read-only; workspace-write = agents write inside their sandboxed worktree.
    safetyMode: workspace-write
    providers:
${block}
    # A lean, effective team: one planner, one implementer, one independent reviewer.
    roles:
      - name: planner
        title: Planner / Orchestrator
        provider: ${providerKey}
        sme: architect
      - name: implementer
        title: Implementer
        provider: ${providerKey}
        sme: fullstack
      - name: reviewer
        title: Independent Reviewer
        provider: ${providerKey}
        sme: code-reviewer
    loops:
      - name: delivery-loop
        maxIterations: 6
        orchestrator: planner   # decomposes the goal into board tasks
        reviewer: reviewer      # independent critic that reviews diffs and can reject
        maxRepairs: 2           # failed tasks are retried with error context before escalating
        verifyStabilityRuns: 3  # run the verifier this many times before trusting green
        maxSameFailureCount: 2  # stop when the same failure repeats this many times
        postMergeVerify: true   # rerun the verifier after each accepted merge
        maxParallel: 1          # raise for concurrency (each task gets its own git worktree)
        budgetUsd: 0            # set a USD cap to bound autonomous spend (0 = unlimited)
        # maxCostPerCallUsd: 0.50  # REQUIRED whenever budgetUsd > 0 (must be > 0 and <= budgetUsd).
        #                          # A positive budget with no per-call cap fails closed before the
        #                          # planner: every call would reserve the whole budget.
        stopWhen:                 # advisory "done" hints for the planner. The BINDING gates are
          - all tasks done        # independent review + the deterministic verifier — never these.
          - tests pass
`;
}

export function starterBrief(projectName = "Demo Product"): string {
  return `# ${projectName} Brief

You are a small, self-organizing engineering team building and maintaining a
software product through small, reviewable, test-backed changes.

## Mission

Take a goal, decompose it into tasks, and drive it to "done" — plan, build,
review, and verify against acceptance criteria until every task is accepted and
the verifier is green.

## How the team operates

- The Planner turns the goal into well-scoped, independent tasks.
- The Implementer claims a task and delivers it in an isolated git worktree.
- The Reviewer independently reviews the diff and can reject; the parent
  orchestrator runs a deterministic verifier as the final gate.

## Operating principles

- Keep every task scoped to the goal; defer out-of-scope work.
- Read PROJECT-INTELLIGENCE.md first and reuse existing patterns and commands.
- Prefer the smallest reversible change; keep changes backward-compatible unless
  the task explicitly allows a break.
- Never modify test files or CI config to make checks pass.
- Never run destructive operations against real data or commit secrets.
`;
}
