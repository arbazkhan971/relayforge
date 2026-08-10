import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { finalLoopState, prepareRun, runAutonomyLoop, writeRolePrompts } from "../src/orchestrator.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { worktreeRoot } from "../src/worktree.js";
import { gitStatusPorcelain, runOnce, setupRepo } from "./e2e-harness.js";

beforeAll(() => setTrustedRunner(true));
afterAll(() => setTrustedRunner(false));

function configureProvision(repoDir: string, path: string, requiredExecutables: string[] = []): void {
  const configPath = join(repoDir, "loop.config.yaml");
  const config = readFileSync(configPath, "utf8");
  const marker = /^(        verify: .*\n)/m;
  const executableYaml = requiredExecutables.length
    ? `            requiredExecutables:\n${requiredExecutables.map((entry) => `              - ${entry}\n`).join("")}`
    : "";
  const withProvision = config.replace(
    marker,
    `$1        provision:\n          - path: ${path}\n${executableYaml}`
  );
  if (withProvision === config) throw new Error("could not add provision fixture config");
  writeFileSync(configPath, withProvision);

  const ignorePath = join(repoDir, ".gitignore");
  const ignore = readFileSync(ignorePath, "utf8");
  if (!ignore.split("\n").includes("node_modules/")) writeFileSync(ignorePath, `${ignore}node_modules/\n`);
  execFileSync("git", ["add", ".gitignore", "loop.config.yaml"], { cwd: repoDir });
  execFileSync("git", ["commit", "--amend", "--no-edit", "-q"], { cwd: repoDir });
}

function createIgnoredToolchain(repoDir: string): { tool: string; shim: string; sourceBytes: Buffer } {
  const tool = join(repoDir, "node_modules", "relay-tool", "bin", "ready.mjs");
  const shim = join(repoDir, "node_modules", ".bin", "relay-ready");
  mkdirSync(join(repoDir, "node_modules", "relay-tool", "bin"), { recursive: true });
  mkdirSync(join(repoDir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(tool, "#!/usr/bin/env node\nprocess.stdout.write('relay-ready\\n');\n");
  chmodSync(tool, 0o755);
  symlinkSync("../relay-tool/bin/ready.mjs", shim);
  return { tool, shim, sourceBytes: readFileSync(tool) };
}

function provisionEvents(repoDir: string, runId: string): Array<{ event: string; detail: string }> {
  const log = readFileSync(join(repoDir, ".loop", "runs", "e2e", runId, ".loop_log.jsonl"), "utf8");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; detail: string })
    .filter((event) => event.event.startsWith("provision_"));
}

describe("worktree provisioning readiness barrier E2E", () => {
  it("gates planner, implementer, reviewer, and verifier on a complete isolated toolchain", async () => {
    const { repoDir } = setupRepo();
    const capture = join(repoDir, ".loop", "provider-capture.log");
    const verifierSideEffect = join(repoDir, ".loop", "verifier-ran.log");

    // Rebuild the provider/verifier fixture before amending the baseline so the run manifest sees
    // the exact configuration that will execute.
    const configPath = join(repoDir, "loop.config.yaml");
    let config = readFileSync(configPath, "utf8");
    config = config.replace(
      "          NOOP: \"1\"",
      `          FAKE_MODE: \"accept\"\n          LOOP_CAPTURE: ${JSON.stringify(capture)}\n          FAKE_REQUIRE_FILE: \"node_modules/.bin/relay-ready\"`
    );
    config = config.replace(
      /        verify: .*\n/,
      `        verify: [${JSON.stringify(`test -f feature.txt && node_modules/.bin/relay-ready >> ${JSON.stringify(verifierSideEffect)}`)}]\n`
    );
    writeFileSync(configPath, config);
    configureProvision(repoDir, "node_modules", [".bin/relay-ready"]);
    const source = createIgnoredToolchain(repoDir);
    const sourceMode = statSync(source.tool).mode;

    const runId = "run-provision-ready";
    const result = await runOnce({ execute: true, repoDir, runId });
    expect(result.state.status).toBe("done");

    const invocations = readFileSync(capture, "utf8");
    expect(invocations).toContain("=== planner readOnly=true");
    expect(invocations).toContain("=== implementer readOnly=false");
    expect(invocations).toContain("=== reviewer readOnly=true");
    expect(readFileSync(verifierSideEffect, "utf8")).toContain("relay-ready");

    const events = provisionEvents(repoDir, runId);
    expect(events.map((event) => event.event)).toEqual([
      "provision_ready",
      "provision_ready",
      "provision_ready"
    ]);
    expect(events.map((event) => event.detail)).toEqual([
      expect.stringContaining("purpose=integration"),
      expect.stringContaining("purpose=attempt"),
      expect.stringContaining("purpose=review")
    ]);

    // Neither the byte source, executable mode, internal symlink nor human checkout was changed.
    expect(readFileSync(source.tool)).toEqual(source.sourceBytes);
    expect(statSync(source.tool).mode).toBe(sourceMode);
    expect(existsSync(source.shim)).toBe(true);
    expect(gitStatusPorcelain(repoDir)).toBe("");
  }, 60_000);

  it("refuses a missing configured source before planner or verifier execution", async () => {
    const { repoDir } = setupRepo();
    const capture = join(repoDir, ".loop", "provider-capture.log");
    const verifierSideEffect = join(repoDir, ".loop", "verifier-ran.log");
    const configPath = join(repoDir, "loop.config.yaml");
    let config = readFileSync(configPath, "utf8");
    config = config.replace(
      "          NOOP: \"1\"",
      `          FAKE_MODE: \"accept\"\n          LOOP_CAPTURE: ${JSON.stringify(capture)}`
    );
    config = config.replace(
      /        verify: .*\n/,
      `        verify: [${JSON.stringify(`touch ${JSON.stringify(verifierSideEffect)}`)}]\n`
    );
    writeFileSync(configPath, config);
    configureProvision(repoDir, "node_modules");

    const loaded = loadConfig(configPath);
    const runId = "run-provision-missing";
    const ctx = prepareRun(loaded, loaded.config.projects[0], runId, "Deliver the feature");
    writeRolePrompts(ctx);
    await expect(runAutonomyLoop(ctx, {}, { execute: true })).rejects.toThrow(/MISSING_SOURCE/);

    const state = finalLoopState(ctx);
    expect(state.status).toBe("blocked");
    expect(state.phase).toBe("stopped");
    expect(existsSync(capture)).toBe(false);
    expect(existsSync(verifierSideEffect)).toBe(false);
    const events = provisionEvents(repoDir, runId);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("provision_failed");
    expect(events[0].detail).toContain("code=MISSING_SOURCE");
    expect(events[0].detail.length).toBeLessThanOrEqual(240);
  }, 30_000);

  it("keeps an empty provision plan behaviorally inert and writes no transaction state", async () => {
    const { repoDir } = setupRepo({ verify: [], env: { FAKE_MODE: "accept" } });
    const runId = "run-provision-disabled";
    const result = await runOnce({ execute: true, repoDir, runId });
    expect(result.state.status).toBe("unverified");

    const root = worktreeRoot(repoDir, "e2e", runId);
    expect(existsSync(root)).toBe(true); // non-success preserves its integration evidence
    expect(existsSync(join(root, ".provision"))).toBe(false);
    expect(provisionEvents(repoDir, runId)).toEqual([]);
    expect(gitStatusPorcelain(repoDir)).toBe("");
  }, 60_000);
});
