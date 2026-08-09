import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertOrdinaryExecuteNativeAdapterPreflight,
  NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE,
  NativeAdapterProductPreflightError,
  reachableProviderKeysForLoop
} from "../src/adapters/native-product-preflight.js";
import type { LoopConfig, ProjectConfig } from "../src/config/schema.js";
import { registerOwnedTemp } from "./global-teardown.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");
const TSX = resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

function provider(type: ProjectConfig["providers"][string]["type"], command?: string): ProjectConfig["providers"][string] {
  return {
    type,
    ...(command ? { command } : {}),
    args: [],
    dangerouslySkipPermissions: false,
    yolo: false,
    cooldownSeconds: 900,
    preauthorizingGateway: false,
    auth: { mode: "auto", configured: false },
    promptMode: "interactive",
    env: {}
  };
}

function baseProject(
  providers: Record<string, ProjectConfig["providers"][string]>,
  multi?: ProjectConfig["multiRepository"]
): ProjectConfig {
  return {
    name: "product",
    workingDir: ".",
    providers,
    repositories: [],
    roles: [
      { name: "implementer", title: "Implementer", provider: "worker", repositories: [] },
      { name: "reviewer", title: "Reviewer", provider: "review", repositories: [] }
    ],
    loops: [
      {
        name: "delivery",
        cadenceMinutes: 30,
        maxIterations: 2,
        stopWhen: [],
        pollSeconds: 1,
        orchestrator: "implementer",
        reviewer: "reviewer",
        maxRepairs: 1,
        budgetUsd: 0,
        maxCostPerCallUsd: 0,
        allowUnknownCostCalls: 0,
        verifyStabilityRuns: 1,
        maxSameFailureCount: 1,
        contextTokenBudget: 1_000,
        verify: [],
        provision: [],
        postMergeVerify: false,
        maxParallel: 1
      }
    ],
    ...(multi ? { multiRepository: multi } : {})
  } as ProjectConfig;
}

function loopOf(project: ProjectConfig): LoopConfig {
  return project.loops[0]!;
}

function singleRepoConfig(root: string, providerType: string): string {
  const path = join(root, "loop.config.yaml");
  writeFileSync(path, `version: 1
defaults:
  runDir: .loop/runs
  viewport: false
projects:
  - name: product
    workingDir: .
    providers:
      worker: { type: ${providerType} }
    roles:
      - { name: implementer, title: Implementer, provider: worker }
    loops:
      - { name: delivery, orchestrator: implementer, reviewer: implementer, maxIterations: 1, budgetUsd: 0, maxCostPerCallUsd: 0 }
`, { mode: 0o600 });
  return path;
}

function multiRepoConfig(root: string, providerType: string): string {
  const path = join(root, "loop.config.yaml");
  writeFileSync(path, `version: 1
defaults:
  runDir: .loop/runs
  viewport: false
projects:
  - name: product
    workingDir: alpha
    providers:
      worker: { type: ${providerType} }
    repositories:
      - { name: alpha, path: alpha, defaultBranch: main, protectedBranches: [main] }
    multiRepository:
      providerRepositories: { worker: [alpha] }
      tasks:
        - id: change
          role: implementer
          provider: worker
          repositories: [alpha]
          entries:
            - { repository: alpha, branch: rf-change, targetRef: refs/heads/integration }
          verifyCommands: ["true"]
          commitMessage: bounded change
    roles:
      - { name: implementer, title: Implementer, provider: worker, repositories: [alpha] }
    loops:
      - { name: delivery, orchestrator: implementer, reviewer: implementer, maxIterations: 1, budgetUsd: 0, maxCostPerCallUsd: 0 }
`, { mode: 0o600 });
  return path;
}

function runCli(root: string, configPath: string, extra: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [TSX, CLI, "--config", configPath, "run", "goal", ...extra, "--run", "must-not-exist"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        // No fake "provider available" flags — preflight must not honor unauthenticated booleans.
        RELAYFORGE_ALLOW_NATIVE: "1",
        OPENCODE_AVAILABLE: "1",
        PI_AVAILABLE: "1",
        GROK_AVAILABLE: "1"
      },
      timeout: 30_000
    }
  );
}

describe("ordinary execute native adapter product preflight", () => {
  it("is inert for dry-run and for non-native providers on execute", () => {
    const native = baseProject({
      worker: provider("opencode"),
      review: provider("claude")
    });
    expect(() => assertOrdinaryExecuteNativeAdapterPreflight(native, loopOf(native), false)).not.toThrow();

    const supported = baseProject({
      worker: provider("custom", process.execPath),
      review: provider("gemini")
    });
    expect(() => assertOrdinaryExecuteNativeAdapterPreflight(supported, loopOf(supported), true)).not.toThrow();
  });

  it("refuses opencode/pi/grok routes with a stable code before any mutation", () => {
    for (const type of ["opencode", "pi", "grok"] as const) {
      const project = baseProject({
        worker: provider(type),
        review: provider("claude")
      });
      expect(() => assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true)).toThrow(NativeAdapterProductPreflightError);
      try {
        assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true);
      } catch (error) {
        expect(error).toBeInstanceOf(NativeAdapterProductPreflightError);
        expect((error as NativeAdapterProductPreflightError).code).toBe(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE);
        expect((error as Error).message).toMatch(new RegExp(`${NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE}:.*${type}`, "u"));
        expect((error as Error).message).toMatch(/before run directory, control plane, or worktree creation/u);
        expect((error as Error).message).toMatch(/explicit paid characterization collector/u);
      }
    }
  });

  it("includes P6 task providers in the reachable route set", () => {
    const project = baseProject(
      {
        worker: provider("claude"),
        review: provider("claude"),
        p6: provider("pi")
      },
      {
        providerRepositories: { p6: ["alpha"] },
        tasks: [
          {
            id: "change",
            role: "implementer",
            provider: "p6",
            repositories: ["alpha"],
            entries: [{ repository: "alpha", branch: "rf-change", targetRef: "refs/heads/integration" }],
            verifyCommands: ["true"],
            commitMessage: "bounded change"
          }
        ]
      } as ProjectConfig["multiRepository"]
    );
    expect(reachableProviderKeysForLoop(project, loopOf(project))).toEqual(expect.arrayContaining(["p6", "worker", "review"]));
    expect(() => assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true)).toThrow(/p6 \(type pi\)/u);
  });
});

describe("CLI subprocess: zero-mutation native execute refusal", () => {
  it.each(["opencode", "pi", "grok"] as const)(
    "refuses single-repo %s before creating .loop and without starting a provider",
    (type) => {
      const root = mkdtempSync(join(tmpdir(), `relayforge-native-preflight-${type}-`));
      registerOwnedTemp(root);
      writeFileSync(join(root, "README.md"), "fixture\n");
      const configPath = singleRepoConfig(root, type);
      const marker = join(root, "provider-must-not-start");
      // If any provider binary were spawned with this PATH entry, the marker would appear.
      const trap = join(root, "bin");
      mkdirSync(trap, { mode: 0o700 });
      for (const name of ["opencode", "pi", "grok", type]) {
        writeFileSync(join(trap, name), `#!/bin/sh\necho started > ${marker}\nexit 0\n`, { mode: 0o700 });
      }
      const result = runCli(root, configPath, ["--execute"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE, "u"));
      expect(result.stderr).toMatch(new RegExp(type, "u"));
      expect(existsSync(join(root, ".loop"))).toBe(false);
      expect(existsSync(join(root, ".loop", "runs", "must-not-exist"))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    }
  );

  it("accepts dry-run for a structured native provider without the evidence refusal", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-native-preflight-dry-"));
    registerOwnedTemp(root);
    writeFileSync(join(root, "README.md"), "fixture\n");
    // Dry-run still needs a git worktree for prepareRun; init a minimal repo.
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "relayforge@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "RelayForge fixture"], { cwd: root });
    execFileSync("git", ["add", "--all"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    const configPath = singleRepoConfig(root, "opencode");
    const result = runCli(root, configPath, []);
    // Dry-run must not hit the native evidence refusal. It may still fail later for unrelated
    // reasons (missing sandbox, etc.); the critical invariant is the preflight is inert.
    expect(result.stderr ?? "").not.toMatch(new RegExp(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE, "u"));
  });

  it("refuses a P6 multi-repository pi route before .loop exists", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-native-preflight-p6-"));
    registerOwnedTemp(root);
    const alpha = join(root, "alpha");
    execFileSync("git", ["init", "-q", "-b", "main", alpha]);
    execFileSync("git", ["config", "user.email", "relayforge@example.invalid"], { cwd: alpha });
    execFileSync("git", ["config", "user.name", "RelayForge fixture"], { cwd: alpha });
    writeFileSync(join(alpha, "README.md"), "alpha\n");
    execFileSync("git", ["add", "--all"], { cwd: alpha });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: alpha });
    execFileSync("git", ["branch", "integration"], { cwd: alpha });
    const configPath = multiRepoConfig(root, "pi");
    const marker = join(root, "provider-must-not-start");
    const trap = join(root, "bin");
    mkdirSync(trap, { mode: 0o700 });
    writeFileSync(join(trap, "pi"), `#!/bin/sh\necho started > ${marker}\nexit 0\n`, { mode: 0o700 });
    const result = runCli(root, configPath, ["--execute"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(new RegExp(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE, "u"));
    expect(result.stderr).toMatch(/pi/u);
    expect(existsSync(join(root, ".loop"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
