import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertOrdinaryExecuteNativeAdapterPreflight,
  NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE,
  NativeAdapterProductPreflightError,
  nativeAdapterCredentialGate,
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

/** No native CLI is resolvable (no personal subscription) and no key is set. */
const NO_CREDENTIAL: { source: Record<string, string | undefined>; cliAvailable: () => boolean } = {
  source: {},
  cliAvailable: () => false
};

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

function runCli(root: string, configPath: string, extra: string[] = [], env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [TSX, CLI, "--config", configPath, "run", "goal", ...extra, "--run", "must-not-exist"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: env.PATH ?? "/usr/bin:/bin",
        // No fake "provider available" flags — the gate honors only real CLI/credential state.
        RELAYFORGE_ALLOW_NATIVE: "1",
        OPENCODE_AVAILABLE: "1",
        PI_AVAILABLE: "1",
        GROK_AVAILABLE: "1",
        ...env
      },
      timeout: 30_000
    }
  );
}

/** A PATH with NO native adapter CLI resolveable — deterministic regardless of the dev machine. */
function emptyBinPath(root: string): string {
  const dir = join(root, "empty-bin");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Canonical temp root: macOS /var is a symlink to /private/var which defeats repo identity probes. */
function tempRoot(label: string): string {
  return mkdtempSync(join(realpathSync(tmpdir()), label));
}

describe("ordinary execute native adapter product preflight (credential gate)", () => {
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

  it("allows opencode/pi/grok execute when a linked API key is present", () => {
    for (const [type, key] of [
      ["opencode", "OPENAI_API_KEY"],
      ["pi", "ANTHROPIC_API_KEY"],
      ["grok", "XAI_API_KEY"]
    ] as const) {
      const project = baseProject({ worker: provider(type), review: provider("claude") });
      const result = nativeAdapterCredentialGate(type, project.providers.worker!, { [key]: "test-key" }, () => false);
      expect(result).toEqual({ ok: true, mode: "api-key", env: key });
      expect(() =>
        assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true, {
          source: { [key]: "test-key" },
          cliAvailable: () => false
        })
      ).not.toThrow();
    }
  });

  it("allows execute when the operator linked a personal subscription (CLI login), with no key", () => {
    for (const type of ["opencode", "pi", "grok"] as const) {
      const project = baseProject({ worker: provider(type), review: provider("claude") });
      const gate = nativeAdapterCredentialGate(type, project.providers.worker!, {}, () => true);
      expect(gate).toEqual({ ok: true, mode: "subscription" });
      expect(() =>
        assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true, {
          source: {},
          cliAvailable: () => true
        })
      ).not.toThrow();
    }
  });

  it("honors an explicit api-key mode even when a CLI login exists (fail closed on absent key)", () => {
    const project = baseProject({
      worker: { ...provider("grok"), auth: { mode: "api-key", configured: true } },
      review: provider("claude")
    });
    expect(() =>
      assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true, {
        source: {},
        cliAvailable: () => true
      })
    ).toThrow(NativeAdapterProductPreflightError);
  });

  it("refuses opencode/pi/grok routes with a stable code before any mutation when nothing is linked", () => {
    for (const type of ["opencode", "pi", "grok"] as const) {
      const project = baseProject({
        worker: provider(type),
        review: provider("claude")
      });
      expect(() =>
        assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true, {
          source: NO_CREDENTIAL.source,
          cliAvailable: NO_CREDENTIAL.cliAvailable
        })
      ).toThrow(NativeAdapterProductPreflightError);
      try {
        assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true, {
          source: NO_CREDENTIAL.source,
          cliAvailable: NO_CREDENTIAL.cliAvailable
        });
      } catch (error) {
        expect(error).toBeInstanceOf(NativeAdapterProductPreflightError);
        expect((error as NativeAdapterProductPreflightError).code).toBe(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE);
        expect((error as Error).message).toMatch(new RegExp(`${NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE}:.*${type}`, "u"));
        expect((error as Error).message).toMatch(/before run directory, control plane, or worktree creation/u);
        expect((error as Error).message).toMatch(/link a personal subscription|matching API key/iu);
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
    expect(() =>
      assertOrdinaryExecuteNativeAdapterPreflight(project, loopOf(project), true, {
        source: NO_CREDENTIAL.source,
        cliAvailable: NO_CREDENTIAL.cliAvailable
      })
    ).toThrow(/p6 \(type pi\)/u);
  });
});

describe("CLI subprocess: credential-gated native execute", () => {
  it.each(["opencode", "pi", "grok"] as const)(
    "refuses single-repo %s without a linked credential, before creating .loop and without starting a provider",
    (type) => {
      const root = mkdtempSync(join(tmpdir(), `relayforge-native-preflight-${type}-`));
      registerOwnedTemp(root);
      writeFileSync(join(root, "README.md"), "fixture\n");
      const configPath = singleRepoConfig(root, type);
      const marker = join(root, "provider-must-not-start");
      // Trap binaries exist but are NOT on PATH — the gate must not invent a CLI login.
      const trap = join(root, "bin");
      mkdirSync(trap, { mode: 0o700 });
      for (const name of ["opencode", "pi", "grok", type]) {
        writeFileSync(join(trap, name), `#!/bin/sh\necho started > ${marker}\nexit 0\n`, { mode: 0o700 });
      }
      const result = runCli(root, configPath, ["--execute"], { PATH: emptyBinPath(root) });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE, "u"));
      expect(result.stderr).toMatch(new RegExp(type, "u"));
      expect(existsSync(join(root, ".loop"))).toBe(false);
      expect(existsSync(join(root, ".loop", "runs", "must-not-exist"))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    }
  );

  it("passes the preflight when an API key is linked and fails later for unrelated reasons", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-native-preflight-key-"));
    registerOwnedTemp(root);
    writeFileSync(join(root, "README.md"), "fixture\n");
    const configPath = singleRepoConfig(root, "opencode");
    const result = runCli(root, configPath, ["--execute"], {
      PATH: emptyBinPath(root),
      OPENAI_API_KEY: "test-key"
    });
    // The credential gate is satisfied; any failure now must NOT be the preflight refusal.
    expect(result.stderr ?? "").not.toMatch(new RegExp(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE, "u"));
    expect(result.stderr ?? "").not.toMatch(/Refusing before run directory/u);
  });

  it("passes the preflight for a personal subscription (CLI on PATH) route and never uses the refusal", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-native-preflight-sub-"));
    registerOwnedTemp(root);
    writeFileSync(join(root, "README.md"), "fixture\n");
    const configPath = singleRepoConfig(root, "grok");
    const trap = join(root, "bin");
    mkdirSync(trap, { mode: 0o700 });
    writeFileSync(join(trap, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(trap, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(trap, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const result = runCli(root, configPath, ["--execute"], { PATH: `${trap}:${emptyBinPath(root)}:/usr/bin:/bin` });
    expect(result.stderr ?? "").not.toMatch(new RegExp(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE, "u"));
    expect(result.stderr ?? "").not.toMatch(/Refusing before run directory/u);
  });

  it("accepts dry-run for a structured native provider without the credential refusal", () => {
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
    // Dry-run must not hit the credential refusal. It may still fail later for unrelated
    // reasons (missing sandbox, host ledger anchors, etc.); the critical invariant is that
    // the preflight is inert.
    expect(result.stderr ?? "").not.toMatch(new RegExp(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE, "u"));
  });

  it("refuses a P6 multi-repository pi route before .loop exists when nothing is linked", () => {
    const root = tempRoot("relayforge-native-preflight-p6-");
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
    // PATH keeps git for the repository identity probe but exposes NO native CLI to scan.
    const result = runCli(root, configPath, ["--execute"], { PATH: `${emptyBinPath(root)}:/usr/bin:/bin` });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(new RegExp(NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE, "u"));
    expect(result.stderr).toMatch(/pi/u);
    expect(existsSync(join(root, ".loop"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
