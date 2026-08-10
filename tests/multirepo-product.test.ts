import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { assertConfigSemantics } from "../src/config/validate.js";
import { openControlStore } from "../src/control/store.js";
import { buildMultiRepositoryControlView } from "../src/control/views.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { registerOwnedTemp } from "./global-teardown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDER = resolve(HERE, "fixtures/multirepo-product-provider.mjs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(root: string, name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, "config", "user.email", "relayforge@example.invalid");
  git(path, "config", "user.name", "RelayForge fixture");
  git(path, "config", "commit.gpgsign", "false");
  writeFileSync(join(path, ".gitignore"), ".loop/\n");
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git(path, "add", "--all");
  git(path, "commit", "-qm", "baseline");
  git(path, "branch", "integration");
  return path;
}

function config(root: string): string {
  const path = join(root, "loop.config.yaml");
  writeFileSync(path, `version: 1
defaults:
  runDir: .loop/runs
  viewport: false
projects:
  - name: product
    workingDir: alpha
    providers:
      worker:
        type: custom
        command: ${JSON.stringify(process.execPath)}
        args: [${JSON.stringify(PROVIDER)}]
    repositories:
      - name: alpha
        path: alpha
        defaultBranch: main
        protectedBranches: [main]
      - name: beta
        path: beta
        defaultBranch: main
        protectedBranches: [main]
    multiRepository:
      providerRepositories:
        worker: [alpha, beta]
      scheduler:
        global: 1
        perProvider: 1
        perRepository: 1
        perTask: 1
      tasks:
        - id: product-change
          generation: 1
          role: implementer
          provider: worker
          repositories: [alpha, beta]
          dependsOn: []
          priority: 10
          entries:
            - repository: alpha
              branch: rf-product-alpha
              targetRef: refs/heads/integration
            - repository: beta
              branch: rf-product-beta
              targetRef: refs/heads/integration
          verifyCommands:
            - test -f "$RELAYFORGE_REPO_0_PATH/relayforge-p6.txt" && test -f "$RELAYFORGE_REPO_1_PATH/relayforge-p6.txt"
          commitMessage: relayforge multi-repository product change
    roles:
      - name: implementer
        title: Implementer
        provider: worker
        repositories: [alpha, beta]
    loops:
      - name: delivery
        orchestrator: implementer
        reviewer: implementer
        maxIterations: 1
        cadenceMinutes: 1
        verify: ["true"]
`, { mode: 0o600 });
  return path;
}

afterEach(() => setTrustedRunner(false));

describe("P6 product authority", () => {
  it("executes the real CLI product factory through the parent settlement kernel and atomically advances two integration refs", async () => {
    setTrustedRunner(true);
    const root = mkdtempSync(join(tmpdir(), "relayforge-p6-product-"));
    registerOwnedTemp(root);
    const alpha = repository(root, "alpha");
    const beta = repository(root, "beta");
    const alphaMain = git(alpha, "rev-parse", "main");
    const betaMain = git(beta, "rev-parse", "main");
    const configPath = config(root);
    const loaded = loadConfig(configPath);
    assertConfigSemantics(loaded);
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    const originalLog = console.log;
    process.argv = [
      process.execPath,
      "relayforge",
      "--config",
      configPath,
      "--json",
      "run",
      "update both repositories",
      "--project",
      "product",
      "--run",
      "product-execute",
      "--execute"
    ];
    console.log = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
    process.exitCode = undefined;
    try {
      // cli.ts owns the exact production hook. Running its Commander action in-process preserves
      // the trusted-runner test seam while exercising config preflight, prepare/cutover, the real
      // ControlStore-backed P6 factory, provider settlement, verification and final drain.
      await import("../src/cli.js");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      console.log = originalLog;
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
    }

    expect(output.join("\n")).toContain('"status": "done"');
    expect(git(alpha, "rev-parse", "main")).toBe(alphaMain);
    expect(git(beta, "rev-parse", "main")).toBe(betaMain);
    const alphaIntegrated = git(alpha, "rev-parse", "integration");
    const betaIntegrated = git(beta, "rev-parse", "integration");
    expect(alphaIntegrated).not.toBe(alphaMain);
    expect(betaIntegrated).not.toBe(betaMain);
    expect(git(alpha, "show", `${alphaIntegrated}:relayforge-p6.txt`)).toBe("updated:alpha");
    expect(git(beta, "show", `${betaIntegrated}:relayforge-p6.txt`)).toBe("updated:beta");

    const runDir = join(root, ".loop/runs/product/product-execute");
    const ledger = readFileSync(join(runDir, "board/reservations.jsonl"), "utf8");
    expect(ledger).toContain('"type":"reserve"');
    expect(ledger).toContain('"type":"settle"');
    expect(ledger).not.toContain("missing-settlement-receipt");

    const runEpoch = readFileSync(join(runDir, ".loop_run_nonce"), "utf8").trim();
    const store = openControlStore({
      path: join(runDir, "control.db"),
      runId: "product-execute",
      runEpoch,
      create: false,
      recoveryMode: "verify",
      integrityCheck: "full"
    });
    try {
      const view = buildMultiRepositoryControlView({ project: "product", run: "product-execute", source: store });
      expect(view).toMatchObject({ configured: true, stale: false, recoveryRequired: false });
      expect(view.repositories.map((repository) => repository.repositoryId)).toEqual(["alpha", "beta"]);
      expect(view.tasks).toEqual([
        expect.objectContaining({
          taskId: "product-change",
          taskGeneration: 1,
          state: "completed",
          worktreeState: "reclaimed",
          workerSettled: true,
          integrationState: "applied",
          publicationState: null,
          recoveryReason: null
        })
      ]);
    } finally {
      store.close();
    }
  }, 60_000);
});
