import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.js";
import { finalLoopState, prepareRun, runAutonomyLoop, writeRolePrompts, type LoopRunState } from "../src/orchestrator.js";
import { registerOwnedTemp } from "./global-teardown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_PROVIDER = resolve(HERE, "fixtures/fake-provider.mjs");

export type HarnessOptions = {
  env?: Record<string, string>;
  maxIterations?: number;
  maxRepairs?: number;
  budgetUsd?: number;
  maxCostPerCallUsd?: number;
  allowUnknownCostCalls?: number;
  /** Ordered verifier commands. `[]` means NO verifier is configured (and the fixture repo carries
   *  no manifest for auto-detection) — the "accepted but never verified" case. */
  verify?: string[];
  postMergeVerify?: boolean;
  goal?: string;
  /** Contents of PROJECT-INTELLIGENCE.md, so a test can prove the project intelligence actually
   *  reaches the provider's prompt rather than the "_No PROJECT-INTELLIGENCE.md found_" placeholder. */
  intelligence?: string;
  /**
   * How many IMPLEMENTER roles the team has (`impl1`…`implN`, default 1 named `implementer`).
   * Parallelism is per-ROLE — the dispatcher selects at most one task per role per iteration — so
   * genuinely concurrent dispatch needs several implementer roles, not just several tasks.
   */
  implementers?: number;
  maxParallel?: number;
  /** A role name whose provider is deliberately MISCONFIGURED (a raw `-c` arg, which `assertSafeArgs`
   *  rejects). Its dispatch THROWS, which is how we exercise the dispatch-error path for real. */
  breakRole?: string;
  /** A package.json written into the repo, so the verifier can be AUTO-DETECTED (test then build)
   *  instead of configured. */
  packageJson?: Record<string, unknown>;
};

/** The implementer role names for a given team size. */
export function implementerNames(count: number): string[] {
  return count <= 1 ? ["implementer"] : Array.from({ length: count }, (_, i) => `impl${i + 1}`);
}

const VERIFY_SH = `#!/usr/bin/env bash
# Prints CHANGING timing text every run (token/elapsed/clock) but the pass/fail result depends
# only on whether feature.txt exists — used to prove dynamic timing text is not treated as flaky.
echo "verifier finished in \${RANDOM}ms (elapsed \${RANDOM}.\${RANDOM}s) at \$(date +%H:%M:%S)"
test -f feature.txt
`;

/** Create a disposable git repo with a committed baseline and a loop config wired to the fake. */
export function setupRepo(options: HarnessOptions = {}) {
  const repoDir = mkdtempSync(join(tmpdir(), "loop-e2e-"));
  registerOwnedTemp(repoDir); // explicit, unforgeable ownership so suite teardown may reclaim it
  execSync("git init -q && git config user.email t@t.t && git config user.name t && git config commit.gpgsign false", { cwd: repoDir });
  writeFileSync(join(repoDir, "verify.sh"), VERIFY_SH);
  writeFileSync(join(repoDir, "app.test.js"), "// grader: do not weaken\n");
  writeFileSync(join(repoDir, "README.md"), "# fixture\n");
  writeFileSync(join(repoDir, ".gitignore"), ".loop/\nPROJECT-INTELLIGENCE.md\n");
  if (options.intelligence) writeFileSync(join(repoDir, "PROJECT-INTELLIGENCE.md"), options.intelligence);

  if (options.packageJson) writeFileSync(join(repoDir, "package.json"), `${JSON.stringify(options.packageJson, null, 2)}\n`);

  const envLines = Object.entries(options.env ?? {})
    .map(([k, v]) => `          ${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const verify = options.verify ?? ["bash verify.sh"];
  const implementers = implementerNames(options.implementers ?? 1);

  // A deliberately misconfigured provider: a raw `-c` arg, which `assertSafeArgs` REJECTS by throwing
  // when the command is built — i.e. a throw from inside a dispatch, which is exactly the failure the
  // dispatch handler must convert into a terminal, repairable `blocked` instead of stranding the task.
  const brokenProvider = options.breakRole
    ? `
      broken:
        type: custom
        command: node
        args: [${JSON.stringify(FAKE_PROVIDER)}, "-c"]
        env:
${envLines || "          NOOP: \"1\""}`
    : "";

  const config = `version: 1
defaults:
  runDir: .loop/runs
projects:
  - name: e2e
    workingDir: .
    intelligence: PROJECT-INTELLIGENCE.md
    safetyMode: workspace-write
    providers:
      agent:
        type: custom
        command: node
        args: [${JSON.stringify(FAKE_PROVIDER)}]
        env:
${envLines || "          NOOP: \"1\""}${brokenProvider}
    roles:
      - name: planner
        title: Planner
        provider: agent
        sme: architect
${implementers
  .map(
    (name) => `      - name: ${name}
        title: Implementer ${name}
        provider: ${options.breakRole === name ? "broken" : "agent"}
        sme: fullstack`
  )
  .join("\n")}
      - name: reviewer
        title: Reviewer
        provider: agent
        sme: code-reviewer
    loops:
      - name: delivery
        maxIterations: ${options.maxIterations ?? 6}
        pollSeconds: 1
        cadenceMinutes: 5
        orchestrator: planner
        reviewer: reviewer
        maxRepairs: ${options.maxRepairs ?? 2}
        verifyStabilityRuns: 2
        maxSameFailureCount: 3
        postMergeVerify: ${options.postMergeVerify ?? true}
        maxParallel: ${options.maxParallel ?? 1}
        budgetUsd: ${options.budgetUsd ?? 0}
        maxCostPerCallUsd: ${options.maxCostPerCallUsd ?? 0}
        allowUnknownCostCalls: ${options.allowUnknownCostCalls ?? 0}
        verify: [${verify.map((v) => JSON.stringify(v)).join(", ")}]
        stopWhen:
          - all tasks done
          - tests pass
`;
  writeFileSync(join(repoDir, "loop.config.yaml"), config);
  execSync("git add -A && git commit -qm baseline", { cwd: repoDir });
  return { repoDir };
}

export type RunResult = {
  repoDir: string;
  runId: string;
  state: LoopRunState;
  reports: Awaited<ReturnType<typeof runAutonomyLoop>>;
};

/** Run one full autonomy loop against a fresh disposable repo and return the final state. */
export async function runOnce(options: HarnessOptions & { execute: boolean; runId?: string; repoDir?: string }): Promise<RunResult> {
  const repoDir = options.repoDir ?? setupRepo(options).repoDir;
  const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
  const project = loaded.config.projects[0];
  const runId = options.runId ?? "run-e2e";
  const ctx = prepareRun(loaded, project, runId, options.goal ?? "Deliver the feature");
  writeRolePrompts(ctx);
  // Planning happens INSIDE runAutonomyLoop (after the lease, clean gate, and containment gate) —
  // never pre-planned here, so the loop's fail-closed boundary is exercised faithfully.
  const reports = await runAutonomyLoop(ctx, {}, { execute: options.execute });
  const state = finalLoopState(ctx);
  return { repoDir, runId, state, reports };
}

/** Read the git log of a branch in a repo (subject lines). */
export function gitLog(repoDir: string, ref: string): string[] {
  try {
    return execSync(`git log --format=%s ${ref}`, { cwd: repoDir, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function gitStatusPorcelain(repoDir: string): string {
  return execSync("git status --porcelain", { cwd: repoDir, encoding: "utf8" }).trim();
}

export function currentBranchName(repoDir: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
}

export function headSubject(repoDir: string): string {
  return execSync("git log -1 --format=%s", { cwd: repoDir, encoding: "utf8" }).trim();
}
