import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type LoadedConfig } from "../src/config/load.js";
import { parseControlEvent, type ControlEvent } from "../src/control/events.js";
import { probeControlLease } from "../src/control/lease.js";
import { controlPaths, readControlRunFile } from "../src/control/runfile.js";
import {
  ControlServiceError,
  acquireControlServiceOwnership,
  startControlService,
  stopControlService,
  type ControlServiceHandle
} from "../src/control/service.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";

const NOW = "2026-08-09T12:00:00.000Z";
const EPOCH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const roots: string[] = [];
const handles: ControlServiceHandle[] = [];
const stores: ControlStore[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) {
    try { await handle.shutdown(); } catch { /* asserted failure */ }
  }
  for (const store of stores.splice(0).reverse()) {
    try { store.close(); } catch { /* may already be closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P1 control-service composition", () => {
  it("serves dashboard, REST and durable SSE from one exact origin without lending mutation authority", async () => {
    const loaded = fixtureConfig();
    const store = createStore(loaded);
    store.append(runStarted());
    const handle = await startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      dashboardProject: "demo",
      borrowedSources: { projects: () => [{ project: "demo", runs: [store] }] },
      now: () => new Date(NOW),
      instanceId: "a".repeat(64)
    });
    handles.push(handle);
    const base = handle.address.url;

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    const html = await root.text();
    expect(html).toContain("RelayForge");
    expect(html).toContain('data-project="demo"');
    const csp = root.headers.get("content-security-policy") ?? "";
    expect(csp).not.toContain("unsafe-inline");
    const nonce = /script-src 'nonce-([^']+)'/u.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);

    const health = await fetch(`${base}/api/v1/health`);
    expect(health.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(health.headers.get("content-security-policy")).not.toContain("nonce-");
    await expect(health.json()).resolves.toMatchObject({
      service: "relayforge-control",
      instanceId: "a".repeat(64),
      status: "ok"
    });

    const status = await fetch(`${base}/api/v1/status`).then((response) => response.json()) as any;
    expect(status.projects[0].latestRun).toMatchObject({ project: "demo", run: "run-1", headSeq: 1 });
    const boardBefore = await fetch(`${base}/api/v1/runs/run-1/board?project=demo`).then((response) => response.json()) as any;
    expect(boardBefore.tasks).toEqual([]);

    const stream = await fetch(`${base}/api/v1/runs/run-1/events?project=demo&runEpoch=${EPOCH}&after=1`);
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    store.append(taskCreated());
    const frame = await readUntil(reader, "event: control.changed", 2_000);
    expect(frame).toContain("id: 2");
    expect(frame).toContain(`\"runEpoch\":\"${EPOCH}\"`);
    await reader.cancel();

    const boardAfter = await fetch(`${base}/api/v1/runs/run-1/board?project=demo`).then((response) => response.json()) as any;
    expect(boardAfter).toMatchObject({ viewSeq: 2, headSeq: 2 });
    expect(boardAfter.tasks[0]).toMatchObject({ id: "task-1", title: "Compose service" });

    const headBeforeMutationAttempt = store.head().headSeq;
    const mutation = await fetch(`${base}/api/v1/runs/run-1/board?project=demo`, { method: "POST", body: "{}" });
    expect(mutation.status).toBe(400); // bodies are rejected before the method route; either way no mutation is admitted
    expect(store.head().headSeq).toBe(headBeforeMutationAttempt);

    const headRoot = await fetch(`${base}/`, { method: "HEAD" });
    expect(headRoot.status).toBe(200);
    expect(Number(headRoot.headers.get("content-length"))).toBeGreaterThan(1_000);
    expect((await headRoot.arrayBuffer()).byteLength).toBe(0);

    await handle.shutdown();
    expect(() => store.head()).not.toThrow(); // borrowed store lifetime remains with the run owner
  });

  it("discovers closed run stores only after the service lease and fails closed on an active run writer", async () => {
    const loaded = fixtureConfig();
    const store = createStore(loaded);
    store.append(runStarted());
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const handle = await startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      now: () => new Date(NOW),
      instanceId: "b".repeat(64)
    });
    handles.push(handle);
    const board = await fetch(`${handle.address.url}/api/v1/runs/run-1/board?project=demo`);
    expect(board.status).toBe(200);
    await handle.shutdown();
    handles.splice(handles.indexOf(handle), 1);

    writeFileSync(join(runDir(loaded), ".loop.lease"), `${process.pid} deadbeefdeadbeef ${NOW}`, { mode: 0o600 });
    await expect(startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      now: () => new Date(NOW),
      instanceId: "c".repeat(64)
    })).rejects.toMatchObject<Partial<ControlServiceError>>({ code: "ACTIVE_RUN_WRITER" });
    expect(probeControlLease(controlPaths(loaded.rootDir, loaded.path).leaseDb).state).toBe("free");
    expect(readControlRunFile(controlPaths(loaded.rootDir, loaded.path).runFile).kind).toBe("absent");
  });

  it("rejects a corrupt discovered store, releases ownership, and never publishes plausible readiness", async () => {
    const loaded = fixtureConfig();
    const directory = runDir(loaded);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, ".loop_run_nonce"), `${EPOCH}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "control.db"), "not sqlite", { mode: 0o600 });

    await expect(startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      now: () => new Date(NOW),
      instanceId: "d".repeat(64)
    })).rejects.toMatchObject<Partial<ControlServiceError>>({ code: "DISCOVERY_FAILED" });
    const paths = controlPaths(loaded.rootDir, loaded.path);
    expect(probeControlLease(paths.leaseDb).state).toBe("free");
    expect(readControlRunFile(paths.runFile).kind).toBe("absent");
  });

  it("serializes contenders on the stable configuration lease", async () => {
    const loaded = fixtureConfig();
    const first = await startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      now: () => new Date(NOW),
      instanceId: "e".repeat(64)
    });
    handles.push(first);
    await expect(startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      now: () => new Date(NOW),
      instanceId: "f".repeat(64)
    })).rejects.toMatchObject<Partial<ControlServiceError>>({ code: "OWNER_HELD" });
  });

  it("borrows a pre-acquired run-parent ownership without allowing early external release", async () => {
    const loaded = fixtureConfig();
    const ownership = acquireControlServiceOwnership(loaded, {
      now: () => new Date(NOW),
      instanceId: "1".repeat(64)
    });
    try {
      const handle = await startControlService(loaded, {
        port: 0,
        allowEphemeralPortForTests: true,
        controlOwnership: ownership,
        borrowedSources: { projects: () => [{ project: "demo", runs: [] }] }
      });
      handles.push(handle);
      expect(() => ownership.release()).toThrow(/service is still active/u);
      expect("finishService" in ownership).toBe(false);
      expect("claimForService" in ownership).toBe(false);
      expect(probeControlLease(ownership.paths.leaseDb).state).toBe("held");

      await handle.shutdown();
      handles.splice(handles.indexOf(handle), 1);
      // Borrowed ownership remains with the run parent after the HTTP/SSE lifetime ends.
      expect(probeControlLease(ownership.paths.leaseDb).state).toBe("held");
      ownership.release();
      expect(probeControlLease(ownership.paths.leaseDb).state).toBe("free");
    } finally {
      try { ownership.release(); } catch { /* active handle cleanup above remains authoritative */ }
    }
  });

  it("stop double-collects ownership and rechecks process incarnation immediately before SIGTERM", async () => {
    const loaded = fixtureConfig();
    const runFile = {
      schemaVersion: 1 as const,
      service: "relayforge-control" as const,
      instanceId: "a".repeat(64),
      configId: controlPaths(loaded.rootDir, loaded.path).configId,
      pid: 1234,
      processStartToken: "linux:token:1",
      host: "127.0.0.1" as const,
      port: 4318,
      startedAt: NOW
    };
    let inspections = 0;
    let processChecks = 0;
    let signals = 0;
    let now = 0;
    const result = await stopControlService(loaded, {
      timeoutMs: 100,
      adapters: {
        inspect: async () => {
          inspections += 1;
          return { state: "ready", attachment: { baseUrl: "http://127.0.0.1:4318", runFile, health: { ...runFile, status: "ok" as const } } };
        },
        inspectProcess: () => {
          processChecks += 1;
          return processChecks <= 2 ? { state: "alive-match", token: runFile.processStartToken } : { state: "dead" };
        },
        signal: (_pid, sent) => {
          expect(sent).toBe("SIGTERM");
          signals += 1;
        },
        readRunFile: () => ({ kind: "absent" }),
        probeLease: () => ({ state: "free" }),
        now: () => now,
        sleep: async (ms) => { now += ms; }
      }
    });
    expect(result).toEqual({ stopped: true, instanceId: runFile.instanceId, pid: runFile.pid });
    expect(inspections).toBe(2);
    expect(processChecks).toBe(3);
    expect(signals).toBe(1);
  });

  it("does not signal when the second ownership collection changes", async () => {
    const loaded = fixtureConfig();
    const base = {
      schemaVersion: 1 as const,
      service: "relayforge-control" as const,
      instanceId: "a".repeat(64),
      configId: controlPaths(loaded.rootDir, loaded.path).configId,
      pid: 1234,
      processStartToken: "linux:token:1",
      host: "127.0.0.1" as const,
      port: 4318,
      startedAt: NOW
    };
    let calls = 0;
    let signaled = false;
    await expect(stopControlService(loaded, {
      timeoutMs: 100,
      adapters: {
        inspect: async () => {
          calls += 1;
          const runFile = calls === 1 ? base : { ...base, instanceId: "b".repeat(64) };
          return { state: "ready", attachment: { baseUrl: "http://127.0.0.1:4318", runFile, health: { ...runFile, status: "ok" as const } } };
        },
        inspectProcess: () => ({ state: "alive-match", token: base.processStartToken }),
        signal: () => { signaled = true; }
      }
    })).rejects.toMatchObject<Partial<ControlServiceError>>({ code: "IDENTITY_MISMATCH" });
    expect(signaled).toBe(false);
  });
});

function fixtureConfig(): LoadedConfig {
  const root = mkdtempSync(join(tmpdir(), "relayforge-control-service-"));
  roots.push(root);
  const port = 4318;
  const path = join(root, "loop.config.yaml");
  writeFileSync(path, `version: 1
defaults:
  namespace: control-service-test
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
  return loadConfig(path);
}

function runDir(loaded: LoadedConfig): string {
  return join(loaded.rootDir, ".loop", "runs", "demo", "run-1");
}

function createStore(loaded: LoadedConfig): ControlStore {
  const directory = runDir(loaded);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, ".loop_run_nonce"), `${EPOCH}\n`, { mode: 0o600 });
  const store = openControlStore({ path: join(directory, "control.db"), runId: "run-1", runEpoch: EPOCH, now: () => NOW });
  stores.push(store);
  return store;
}

function runStarted(): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId: "run-started",
    runId: "run-1",
    runEpoch: EPOCH,
    taskId: null,
    taskGeneration: null,
    expectedVersion: 0,
    occurredAt: NOW,
    type: "run.started",
    payload: { startedBy: "parent", goal: "Compose control service" }
  });
}

function taskCreated(): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId: "task-created",
    runId: "run-1",
    runEpoch: EPOCH,
    taskId: "task-1",
    taskGeneration: 1,
    expectedVersion: 0,
    occurredAt: NOW,
    type: "task.created",
    payload: {
      title: "Compose service",
      assignee: "dev",
      createdBy: "parent",
      description: "Wire service ownership.",
      acceptanceCriteria: ["one origin"],
      dependsOn: [],
      priority: 10,
      createdAt: NOW
    }
  });
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeoutMs: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(needle) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("SSE read timed out")), remaining))
    ]);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}
