import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requestControlJson, requireControlService } from "../src/control/client.js";
import { probeControlLease } from "../src/control/lease.js";
import { controlPaths } from "../src/control/runfile.js";
import { parseVerifierCgroupJournalLine } from "../src/cgroup-delegation.js";
import { detectSandbox, verifierNetworkIsolationAvailable } from "../src/sandbox.js";
import { detectScopeCapability, parseScopeId, realScopeOs } from "../src/scope.js";
import { STEERING_DASHBOARD_MAX_BYTES, type SteeringDashboardData } from "../src/dashboard/steering-data.js";
import { STEERING_IPC_LOCATOR_LEAF } from "../src/steering/ipc.js";
import { cleanupRun, worktreeRoot } from "../src/worktree.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "src/cli.ts");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
const providerPath = resolve(repoRoot, "tests/fixtures/steering-cli-run-provider.mjs");
const trustedCliPath = resolve(repoRoot, "tests/fixtures/steering-cli-trusted-run.ts");
const project = "p2-live";
const runId = "steering-live-e2e";
const body = "Boundary instruction bytes: αβγ café 🙂; keep this exact byte sequence.";
const roots: string[] = [];
const running = new Set<RunningChild>();

type RunningChild = {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  done: Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
};

type Fixture = {
  repoDir: string;
  configPath: string;
  runDir: string;
  worktreeDir: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function eventually<T>(label: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await delay(25);
  }
  const detail = last instanceof Error ? `; last error: ${last.message}` : "";
  throw new Error(`timed out waiting for ${label}${detail}`);
}

function availablePort(): number {
  const script = [
    "const net=require('node:net')",
    "const s=net.createServer()",
    "s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"
  ].join(";");
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  const value = Number(result.stdout);
  if (result.status !== 0 || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`could not reserve a fixture control port: ${result.stderr}`);
  }
  return value;
}

function setupFixture(): Fixture {
  const repoDir = mkdtempSync(join(tmpdir(), "rf-steering-cli-live-"));
  roots.push(repoDir);
  const port = availablePort();
  writeFileSync(join(repoDir, ".gitignore"), ".loop/\n.fixture-*\n");
  writeFileSync(join(repoDir, "README.md"), "# steering CLI production-path fixture\n");
  writeFileSync(
    join(repoDir, "verify.sh"),
    '#!/bin/sh\ntest "$(cat feature.txt 2>/dev/null)" = "fixed" && test -s provider-prompt.json\n'
  );
  const configPath = join(repoDir, "loop.config.yaml");
  writeFileSync(configPath, `version: 1
defaults:
  runDir: .loop/runs
  dashboardPort: ${port}
projects:
  - name: ${project}
    workingDir: .
    safetyMode: workspace-write
    providers:
      fixture:
        type: custom
        command: node
        args: [${JSON.stringify(providerPath)}]
    roles:
      - { name: planner, title: Planner, provider: fixture, sme: architect }
      - { name: implementer, title: Implementer, provider: fixture, sme: fullstack }
      - { name: reviewer, title: Reviewer, provider: fixture, sme: code-reviewer }
    loops:
      - name: delivery
        maxIterations: 4
        pollSeconds: 1
        cadenceMinutes: 5
        orchestrator: planner
        reviewer: reviewer
        maxRepairs: 2
        verifyStabilityRuns: 2
        maxSameFailureCount: 3
        postMergeVerify: true
        maxParallel: 1
        budgetUsd: 0
        maxCostPerCallUsd: 0
        allowUnknownCostCalls: 0
        verify: ["sh verify.sh"]
        stopWhen: ["all tasks done", "tests pass"]
`);
  const initialized = spawnSync("git", ["init", "-q"], { cwd: repoDir, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  for (const [key, value] of [["user.email", "fixture@example.test"], ["user.name", "Fixture"], ["commit.gpgsign", "false"]]) {
    const configured = spawnSync("git", ["config", key, value], { cwd: repoDir, encoding: "utf8" });
    if (configured.status !== 0) throw new Error(configured.stderr);
  }
  const committed = spawnSync("git", ["add", "-A"], { cwd: repoDir, encoding: "utf8" });
  if (committed.status !== 0) throw new Error(committed.stderr);
  const baseline = spawnSync("git", ["commit", "-qm", "baseline"], { cwd: repoDir, encoding: "utf8" });
  if (baseline.status !== 0) throw new Error(baseline.stderr);
  return {
    repoDir,
    configPath,
    runDir: join(repoDir, ".loop", "runs", project, runId),
    worktreeDir: worktreeRoot(repoDir, project, runId)
  };
}

function realContainmentAvailable(): boolean {
  return detectSandbox() === "bwrap" && verifierNetworkIsolationAvailable() && detectScopeCapability().strong;
}

function startCli(cwd: string, args: string[], trustedFallback = false): RunningChild {
  const entry = trustedFallback ? trustedCliPath : cliPath;
  const child = spawn(process.execPath, [tsxPath, entry, ...args], {
    cwd,
    env: { ...process.env, LOOP_TMUX: "off" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result: RunningChild = {
    child,
    stdout: "",
    stderr: "",
    done: new Promise((resolveDone, rejectDone) => {
      child.once("error", rejectDone);
      child.once("exit", (status, signal) => resolveDone({ status, signal }));
    })
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { result.stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { result.stderr += chunk; });
  running.add(result);
  void result.done.finally(() => running.delete(result));
  return result;
}

async function completedCli(cwd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const runningChild = startCli(cwd, args);
  const terminal = await Promise.race([
    runningChild.done,
    delay(30_000).then(() => { throw new Error(`CLI timed out: ${args.join(" ")}`); })
  ]);
  return { status: terminal.status, stdout: runningChild.stdout, stderr: runningChild.stderr };
}

function markerPath(root: string, leaf: string): string | undefined {
  const attempts = join(root, "attempts");
  if (!existsSync(attempts)) return undefined;
  for (const name of readdirSync(attempts).sort()) {
    const candidate = join(attempts, name, leaf);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function release(marker: string, leaf: string): void {
  writeFileSync(join(dirname(marker), leaf), "release\n");
}

async function steeringView(fixture: Fixture, baseUrl: string): Promise<SteeringDashboardData> {
  const raw = await requestControlJson(
    `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/steering?project=${encodeURIComponent(project)}`,
    STEERING_DASHBOARD_MAX_BYTES,
    2_000
  );
  return JSON.parse(Buffer.from(raw).toString("utf8")) as SteeringDashboardData;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function stopChild(item: RunningChild): Promise<void> {
  if (item.child.exitCode !== null || item.child.signalCode !== null) return;
  try { process.kill(-item.child.pid!, "SIGTERM"); } catch { /* already gone */ }
  await Promise.race([item.done, delay(3_000)]);
  if (item.child.exitCode === null && item.child.signalCode === null) {
    try { process.kill(-item.child.pid!, "SIGKILL"); } catch { /* already gone */ }
    await Promise.race([item.done, delay(3_000)]);
  }
}

function releaseFixtureWaiters(repoDir: string): void {
  const attempts = join(worktreeRoot(repoDir, project, runId), "attempts");
  if (!existsSync(attempts)) return;
  for (const name of readdirSync(attempts)) {
    const attempt = join(attempts, name);
    for (const leaf of [".fixture-release-first", ".fixture-release-repair"]) {
      try { writeFileSync(join(attempt, leaf), "cleanup release\n"); } catch { /* attempt was concurrently reclaimed */ }
    }
  }
}

afterEach(async () => {
  for (const root of roots) releaseFixtureWaiters(root);
  if (running.size > 0) await Promise.race([Promise.allSettled([...running].map((item) => item.done)), delay(10_000)]);
  for (const item of [...running]) await stopChild(item);
  for (const root of roots.splice(0)) {
    if (existsSync(join(root, ".git"))) cleanupRun(root, project, runId);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("executing CLI parent steering lifecycle", () => {
  it("admits through the live locator during attempt 1 and includes the exact bytes only at repair attempt 2", async () => {
    const fixture = setupFixture();
    const direct = realContainmentAvailable();
    if (process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1") {
      expect(
        direct,
        "RELAYFORGE_TEST_REQUIRE_CGROUP=1 forbids the trusted fixture fallback; real Bubblewrap, network namespaces, and delegated cgroup-v2 are required"
      ).toBe(true);
    }
    const run = startCli(fixture.repoDir, [
      "--json",
      "run",
      "Exercise live parent steering across a repair boundary",
      "--run",
      runId,
      "--execute"
    ], !direct);

    const firstMarker = await eventually("the first contained provider attempt", () => markerPath(fixture.worktreeDir, ".fixture-first-active"), 120_000);
    const attachment = await eventually("the borrowed live control service", async () => {
      try {
        return await requireControlService(controlPaths(fixture.repoDir, fixture.configPath), { timeoutMs: 1_000 });
      } catch {
        return undefined;
      }
    });
    const active = await eventually("the canonical active attempt-1 target", async () => {
      const view = await steeringView(fixture, attachment.baseUrl);
      const session = view.sessions.find((candidate) => candidate.activity === "active" && candidate.taskId !== null);
      return session?.reason.includes("attempt 1") ? { view, session } : undefined;
    });
    expect(active.view.runEpoch).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
    expect(active.session).toMatchObject({
      sessionGeneration: 1,
      taskGeneration: 1,
      activity: "active",
      certainty: "proven"
    });
    const locatorPath = join(fixture.runDir, STEERING_IPC_LOCATOR_LEAF);
    const locator = JSON.parse(readFileSync(locatorPath, "utf8")) as {
      runId: string;
      runEpoch: string;
      socketPath: string;
    };
    expect(locator).toMatchObject({ runId, runEpoch: active.view.runEpoch });
    const socket = lstatSync(locator.socketPath);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);

    const minted = await completedCli(fixture.repoDir, ["--json", "steer", "new-id"]);
    expect(minted.status, minted.stderr).toBe(0);
    const commandId = (JSON.parse(minted.stdout) as { commandId: string }).commandId;
    const admitted = await completedCli(fixture.repoDir, [
      "--json",
      "steer",
      "admit",
      "--run",
      runId,
      "--run-epoch",
      active.view.runEpoch,
      "--command-id",
      commandId,
      "--task-id",
      active.session.taskId!,
      "--task-generation",
      String(active.session.taskGeneration),
      "--session-id",
      active.session.sessionId,
      "--session-generation",
      String(active.session.sessionGeneration),
      "--not-before-attempt",
      "2",
      "--body",
      body
    ]);
    expect(admitted.status, `${admitted.stderr}\n${admitted.stdout}`).toBe(0);
    expect(JSON.parse(admitted.stdout)).toMatchObject({
      ok: true,
      commandId,
      decision: "admitted",
      label: "Pending"
    });

    const pending = await eventually("the canonical pending steering command", async () => {
      const view = await steeringView(fixture, attachment.baseUrl);
      const command = view.commands.find((candidate) => candidate.commandId === commandId);
      return command?.status === "pending" ? { view, command } : undefined;
    });
    expect(pending.command).toMatchObject({
      sessionId: active.session.sessionId,
      taskId: active.session.taskId,
      notBeforeAttemptGeneration: 2,
      preview: body
    });
    expect(pending.view.sessions.find((candidate) => candidate.sessionId === active.session.sessionId)?.activity).toBe("active");

    const firstPromptPath = await eventually("the immutable attempt-1 prompt", () => {
      const directory = join(fixture.runDir, "steering", "prompts");
      if (!existsSync(directory)) return undefined;
      const prompts = readdirSync(directory).filter((leaf) => leaf.endsWith(".prompt"));
      return prompts.length === 1 ? join(directory, prompts[0]!) : undefined;
    });
    const firstPrompt = readFileSync(firstPromptPath);
    const firstPromptSha256 = sha256(firstPrompt);
    expect(firstPrompt.indexOf(Buffer.from(body, "utf8"))).toBe(-1);

    release(firstMarker, ".fixture-release-first");
    const repairMarker = await eventually("the contained repair provider attempt", () => markerPath(fixture.worktreeDir, ".fixture-repair-active"), 120_000);
    const included = await eventually("the canonical Included lifecycle state", async () => {
      const view = await steeringView(fixture, attachment.baseUrl);
      const command = view.commands.find((candidate) => candidate.commandId === commandId);
      return command?.status === "included" && command.attempt?.state === "active" ? { view, command } : undefined;
    });
    expect(included.command.attempt).toMatchObject({ attemptGeneration: 2, state: "active" });
    expect(included.view.sessions.find((candidate) => candidate.sessionId === active.session.sessionId)?.activity).toBe("active");

    const captured = JSON.parse(readFileSync(join(dirname(repairMarker), "provider-prompt.json"), "utf8")) as {
      schemaVersion: number;
      encoding: string;
      contentBase64: string;
    };
    expect(captured).toMatchObject({ schemaVersion: 1, encoding: "base64" });
    const providerPrompt = Buffer.from(captured.contentBase64, "base64");
    const promptArtifact = readFileSync(
      join(fixture.runDir, "steering", "prompts", `${included.command.attempt!.attemptId}.prompt`)
    );
    // Custom one-shot providers receive the role system prompt, a closed delimiter, then the exact
    // immutable attempt artifact. Prove the delivered argv suffix byte-for-byte, not by searching a
    // reconstructed string or trusting the fixture's claim about what it received.
    expect(providerPrompt.subarray(-(promptArtifact.byteLength + 7)).equals(
      Buffer.concat([Buffer.from("\n\n---\n\n", "utf8"), promptArtifact])
    )).toBe(true);
    expect(sha256(promptArtifact)).toBe(included.command.attempt!.promptSha256);
    expect(promptArtifact.indexOf(Buffer.from(body, "utf8"))).toBeGreaterThanOrEqual(0);
    const steeringLine = promptArtifact.toString("utf8").split("\n").find((line) => line.includes(commandId));
    expect(steeringLine).toBeDefined();
    expect(JSON.parse(steeringLine!)).toEqual({
      body,
      commandId,
      evidenceRefs: [],
      sourceKind: "operator"
    });
    expect(readFileSync(firstPromptPath).equals(firstPrompt)).toBe(true);
    expect(sha256(readFileSync(firstPromptPath))).toBe(firstPromptSha256);

    release(repairMarker, ".fixture-release-repair");
    const terminal = await Promise.race([
      run.done,
      delay(180_000).then(() => { throw new Error(`executing CLI run did not finish; stderr:\n${run.stderr}`); })
    ]);
    expect(terminal, `${run.stderr}\n${run.stdout}`).toMatchObject({ status: 0, signal: null });
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ run: runId, project, execute: true, status: "done", success: true, accepted: 1, rejected: 1 });

    // The successful CLI return is after borrowed-authority drain and scope/worktree cleanup. Read
    // those exact owned identities back: no discovery endpoint, socket, cgroup journal entry,
    // process incarnation or disposable worktree may survive the result it just reported.
    const control = controlPaths(fixture.repoDir, fixture.configPath);
    expect(existsSync(locatorPath)).toBe(false);
    expect(existsSync(locator.socketPath)).toBe(false);
    expect(existsSync(control.runFile)).toBe(false);
    expect(probeControlLease(control.leaseDb)).toEqual({ state: "free" });
    const scopeLines = readFileSync(join(fixture.runDir, ".loop_scopes"), "utf8").split("\n").filter(Boolean);
    expect(scopeLines.length).toBeGreaterThan(0);
    const cgroupRoot = realScopeOs.selfCgroupDir();
    for (const line of scopeLines) {
      const providerScope = parseScopeId(line);
      if (providerScope) {
        expect(processAlive(providerScope.pid)).toBe(false);
        if (providerScope.backend === "cgroup2") {
          expect(cgroupRoot).toBeDefined();
          expect(existsSync(join(cgroupRoot!, providerScope.name))).toBe(false);
        }
        continue;
      }
      const verifierScope = parseVerifierCgroupJournalLine(line);
      expect(verifierScope.kind).not.toBe("invalid");
      if (verifierScope.kind === "invalid") continue;
      const identity = verifierScope.kind === "v2" ? verifierScope.identity : verifierScope;
      expect(processAlive(identity.pid)).toBe(false);
      expect(cgroupRoot).toBeDefined();
      expect(existsSync(join(cgroupRoot!, identity.name))).toBe(false);
      if (verifierScope.kind === "v2") expect(verifierScope.record.runId).toBe(runId);
    }
    expect(existsSync(fixture.worktreeDir)).toBe(false);
    expect(processAlive(run.child.pid!)).toBe(false);

    const branch = `loop/${project}/${runId}/integration`;
    const branchCapture = spawnSync("git", ["show", `${branch}:provider-prompt.json`], {
      cwd: fixture.repoDir,
      encoding: "utf8"
    });
    expect(branchCapture.status, branchCapture.stderr).toBe(0);
    expect(Buffer.from((JSON.parse(branchCapture.stdout) as { contentBase64: string }).contentBase64, "base64").equals(providerPrompt)).toBe(true);
  }, 300_000);
});
