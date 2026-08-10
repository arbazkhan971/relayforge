import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { probeControlLease } from "../src/control/lease.js";
import { controlPaths, readControlRunFile } from "../src/control/runfile.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "src/cli.ts");
// Keep the lifecycle child as the real owner process. The tsx CLI adds a wrapper whose exit and
// resource lifetime can diverge from the service process under SIGKILL/contention.
const tsxLoaderPath = resolve(repoRoot, "node_modules/tsx/dist/loader.mjs");
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of children) await terminate(child);
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P1 real control-plane lifecycle", () => {
  it("runs serve -> full-handshake status -> exact graceful stop with stable discovery identity", async () => {
    const { root, configPath } = writeConfig(await freePort());
    const child = startServe(root, configPath);
    const health = await waitForReady(child, configPath);

    const statusResult = await runCli(root, ["--config", configPath, "serve", "status", "--json"]);
    expect(statusResult.code).toBe(0);
    const status = JSON.parse(statusResult.stdout);
    expect(status).toMatchObject({
      service: "relayforge-control",
      instanceId: health.instanceId,
      configId: health.configId,
      status: "ok",
      projects: [{ project: "demo", latestRun: null, sessions: [] }]
    });

    const stop = await runCli(root, ["--config", configPath, "serve", "stop", "--json"]);
    expect(stop.code).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({ stopped: true, instanceId: health.instanceId, pid: health.pid });
    await waitForExit(child, 8_000);
    children.delete(child);

    const loaded = loadConfig(configPath);
    const paths = controlPaths(loaded.rootDir, loaded.path);
    expect(readControlRunFile(paths.runFile).kind).toBe("absent");
    expect(probeControlLease(paths.leaseDb).state).toBe("free");
  }, 60_000);

  it("allows exactly one of two contenders and reports the existing owner without a port fallback", async () => {
    const { root, configPath, port } = writeConfig(await freePort());
    const winner = startServe(root, configPath);
    const health = await waitForReady(winner, configPath);
    const contender = await runCli(root, ["--config", configPath, "serve", "--port", String(port)]);
    expect(contender.code).not.toBe(0);
    expect(contender.stderr).toMatch(/stable lifetime lease|another control service/i);

    const blockedRunId = "run-blocked-by-serve";
    const run = await runCli(root, ["--config", configPath, "run", "must not race", "--run", blockedRunId]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/control service|run writer|lifetime lease/i);
    expect(readControlRunFile(controlPaths(loadConfig(configPath).rootDir, configPath).runFile).kind).toBe("present");
    // The outer configuration mutex is acquired before prepareRun creates the run directory.
    const blockedDir = join(root, ".loop", "runs", "demo", blockedRunId);
    expect(() => statSync(blockedDir)).toThrow();

    const status = await runCli(root, ["--config", configPath, "serve", "status", "--json"]);
    expect(JSON.parse(status.stdout).instanceId).toBe(health.instanceId);
    const stop = await runCli(root, ["--config", configPath, "serve", "stop"]);
    expect(stop.code).toBe(0);
    await waitForExit(winner, 8_000);
    children.delete(winner);
  }, 60_000);

  it("recovers the crash-released stable lease after SIGKILL and replaces only stale discovery", async () => {
    const { root, configPath } = writeConfig(await freePort());
    const first = startServe(root, configPath);
    const firstHealth = await waitForReady(first, configPath);
    const loaded = loadConfig(configPath);
    const paths = controlPaths(loaded.rootDir, loaded.path);
    const leaseBefore = statSync(paths.leaseDb);

    process.kill(firstHealth.pid, "SIGKILL");
    await waitForExit(first, 5_000);
    children.delete(first);
    await waitFor(() => probeControlLease(paths.leaseDb).state === "free", 5_000, "crashed lease did not release");
    const stale = readControlRunFile(paths.runFile);
    expect(stale.kind).toBe("present");
    if (stale.kind === "present") expect(stale.value.instanceId).toBe(firstHealth.instanceId);

    const successor = startServe(root, configPath);
    const nextHealth = await waitForReady(successor, configPath);
    expect(nextHealth.instanceId).not.toBe(firstHealth.instanceId);
    const leaseAfter = statSync(paths.leaseDb);
    expect({ dev: leaseAfter.dev, ino: leaseAfter.ino }).toEqual({ dev: leaseBefore.dev, ino: leaseBefore.ino });
    const current = readControlRunFile(paths.runFile);
    expect(current.kind).toBe("present");
    if (current.kind === "present") expect(current.value.instanceId).toBe(nextHealth.instanceId);

    const stop = await runCli(root, ["--config", configPath, "serve", "stop"]);
    expect(stop.code).toBe(0);
    await waitForExit(successor, 8_000);
    children.delete(successor);
  }, 60_000);
});

function writeConfig(port: number): { root: string; configPath: string; port: number } {
  const root = mkdtempSync(join(tmpdir(), "relayforge-control-plane-"));
  roots.push(root);
  const configPath = join(root, "loop.config.yaml");
  writeFileSync(configPath, `version: 1
defaults:
  namespace: control-plane-real
  dashboardPort: ${port}
  runDir: .loop/runs
  promptDir: .loop/prompts
projects:
  - name: demo
    providers:
      dev: { type: codex }
    roles:
      - { name: dev, title: Developer, provider: dev }
`);
  return { root, configPath, port };
}

function startServe(root: string, configPath: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["--import", tsxLoaderPath, cliPath, "--config", configPath, "serve"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  return child;
}

async function waitForReady(child: ChildProcessWithoutNullStreams, configPath: string): Promise<any> {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const loaded = loadConfig(configPath);
  const paths = controlPaths(loaded.rootDir, loaded.path);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve exited ${child.exitCode}: ${stderr}`);
    const record = readControlRunFile(paths.runFile);
    if (record.kind === "present") {
      try {
        const response = await fetch(`http://127.0.0.1:${record.value.port}/api/v1/health`);
        if (response.ok) {
          const health = await response.json() as any;
          if (health.status === "ok" && health.instanceId === record.value.instanceId) return health;
        }
      } catch {
        // Listener/publication can be between states; retry boundedly.
      }
    }
    await delay(50);
  }
  throw new Error(`serve did not become ready: ${stderr}`);
}

async function runCli(root: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", tsxLoaderPath, cliPath, ...args], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolvePromise) => child.once("exit", resolvePromise));
  return { code, stdout, stderr };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(timeoutMs).then(() => { throw new Error("child did not exit within the bound"); })
  ]);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 2_000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000).catch(() => undefined);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}
