import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent } from "../src/control/events.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import { createParentSteeringService } from "../src/steering/service.js";

const NOW = "2026-08-09T00:00:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type ChildOutcome = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

const CHILD_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import { openControlStore } from "./src/control/store.ts";
import { createParentSteeringService } from "./src/steering/service.ts";
const [path, encodedRequest, ready, start, operation] = process.argv.slice(1);
const request = JSON.parse(Buffer.from(encodedRequest, "base64url").toString("utf8"));
const store = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false, now: () => "${NOW}" });
const service = createParentSteeringService({
  store,
  authority: { principal: "operator-1", sourceKind: "operator" },
  now: () => new Date("${NOW}")
});
writeFileSync(ready, String(process.pid), { mode: 0o600 });
const waiter = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 60000;
while (!existsSync(start)) {
  if (Date.now() > deadline) throw new Error("start barrier timeout");
  Atomics.wait(waiter, 0, 0, 10);
}
try {
  const result = operation === "withdraw" ? service.withdraw(request) : service.admit(request);
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code, message: error?.message }) + "\\n");
  process.exitCode = 2;
} finally {
  store.close();
}
`;

function child(path: string, request: unknown, ready: string, start: string, operation = "admit"):
  { child: ChildProcess; done: Promise<ChildOutcome> } {
  const processChild = spawn(process.execPath, [
    "--import", "tsx",
    "--input-type=module",
    "--eval", CHILD_SOURCE,
    path,
    Buffer.from(JSON.stringify(request), "utf8").toString("base64url"),
    ready,
    start,
    operation
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  processChild.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  processChild.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return {
    child: processChild,
    done: new Promise((resolve) => processChild.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })))
  };
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!paths.every(existsSync)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${paths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function setup(observation: "waiting_input" | "blocked" = "waiting_input") {
  const root = mkdtempSync(join(tmpdir(), "relayforge-steering-concurrency-"));
  roots.push(root);
  const path = join(root, "control.sqlite");
  const store = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", now: () => NOW });
  stores.push(store);
  store.appendBatch([
    parseControlEvent({
      schemaVersion: 1, eventId: "task-created", runId: "run-1", runEpoch: "epoch-1", taskId: "task-1",
      taskGeneration: 1, expectedVersion: 0, occurredAt: NOW, actorKind: "control-plane", actorId: "parent",
      sourceKind: null, sourceId: null, sourceGeneration: null, sourceEventId: null, type: "task.created",
      payload: { title: "Task", assignee: "dev", createdBy: "parent", description: "D", acceptanceCriteria: ["A"], dependsOn: [], priority: 1, createdAt: NOW }
    }),
    parseControlEvent({
      schemaVersion: 1, eventId: "runtime", runId: "run-1", runEpoch: "epoch-1", taskId: "task-1",
      taskGeneration: 1, expectedVersion: 0, occurredAt: NOW, actorKind: "control-plane", actorId: "parent",
      sourceKind: null, sourceId: null, sourceGeneration: null, sourceEventId: null, type: "runtime.observed",
      payload: { sessionId: "session-1", sessionGeneration: 1, observation }
    })
  ]);
  const request = {
    schemaVersion: 1,
    commandId: "01890f9d-0000-7000-8000-000000000001",
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 1,
    sessionId: "session-1",
    sessionGeneration: 1,
    notBeforeAttemptGeneration: 1,
    kind: "steer_next_boundary",
    evidenceRefs: ["task-created"],
    body: "same instruction"
  };
  return { root, path, store, request };
}

function payload(outcome: ChildOutcome): { ok: boolean; code?: string; result?: { seq: number } } {
  if (!outcome.stdout.trim()) throw new Error(`child produced no JSON: ${outcome.stderr}`);
  return JSON.parse(outcome.stdout.trim()) as { ok: boolean; code?: string; result?: { seq: number } };
}

describe("steering whole-head concurrency", () => {
  it("deduplicates many real-process exact admissions into one canonical decision", async () => {
    const { root, path, store, request } = setup();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const start = join(root, "start");
    const children = Array.from({ length: 12 }, (_, index) => {
      const ready = join(root, `ready-${index}`);
      return { ready, process: child(path, request, ready, start) };
    });
    await waitForFiles(children.map((entry) => entry.ready));
    writeFileSync(start, "go", { mode: 0o600 });
    const outcomes = await Promise.all(children.map((entry) => entry.process.done));
    const results = outcomes.map(payload);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.result?.seq))).toEqual(new Set([3]));

    const reopened = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false, now: () => NOW });
    stores.push(reopened);
    expect(reopened.head().headSeq).toBe(3);
    expect(reopened.getProjection().steering[request.commandId]).toMatchObject({ status: "pending", admittedSeq: 3 });
  }, 60_000);

  it("gives one winner and one stable conflict for divergent real-process reuse", async () => {
    const { root, path, store, request } = setup();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const start = join(root, "start-divergent");
    const firstReady = join(root, "ready-first");
    const secondReady = join(root, "ready-second");
    const first = child(path, request, firstReady, start);
    const second = child(path, { ...request, body: "divergent instruction" }, secondReady, start);
    await waitForFiles([firstReady, secondReady]);
    writeFileSync(start, "go", { mode: 0o600 });
    const results = (await Promise.all([first.done, second.done])).map(payload);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === "COMMAND_ID_CONFLICT")).toHaveLength(1);

    const reopened = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false, now: () => NOW });
    stores.push(reopened);
    expect(reopened.head().headSeq).toBe(3);
  }, 30_000);

  it("deduplicates a durable blocked refusal across real processes", async () => {
    const { root, path, store, request } = setup("blocked");
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const start = join(root, "start-refused");
    const children = Array.from({ length: 6 }, (_, index) => {
      const ready = join(root, `ready-refused-${index}`);
      return { ready, process: child(path, request, ready, start) };
    });
    await waitForFiles(children.map((entry) => entry.ready));
    writeFileSync(start, "go", { mode: 0o600 });
    const results = (await Promise.all(children.map((entry) => entry.process.done))).map(payload);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.result?.seq))).toEqual(new Set([3]));

    const reopened = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false, now: () => NOW });
    stores.push(reopened);
    expect(reopened.head().headSeq).toBe(3);
    expect(reopened.getProjection().steering[request.commandId]).toMatchObject({ status: "refused", reasonCode: "SESSION_BLOCKED" });
  }, 45_000);

  it("serializes divergent withdrawal requests so exactly one terminal reason wins", async () => {
    const { root, path, store, request } = setup();
    createParentSteeringService({
      store,
      authority: { principal: "operator-1", sourceKind: "operator" },
      now: () => new Date(NOW)
    }).admit(request);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const start = join(root, "start-withdraw");
    const firstReady = join(root, "ready-withdraw-first");
    const secondReady = join(root, "ready-withdraw-second");
    const first = child(path, { schemaVersion: 1, commandId: request.commandId, reason: "first" }, firstReady, start, "withdraw");
    const second = child(path, { schemaVersion: 1, commandId: request.commandId, reason: "second" }, secondReady, start, "withdraw");
    await waitForFiles([firstReady, secondReady]);
    writeFileSync(start, "go", { mode: 0o600 });
    const results = (await Promise.all([first.done, second.done])).map(payload);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === "COMMAND_ID_CONFLICT")).toHaveLength(1);

    const reopened = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false, now: () => NOW });
    stores.push(reopened);
    expect(reopened.head().headSeq).toBe(4);
    expect(reopened.getProjection().steering[request.commandId]?.status).toBe("withdrawn");
  }, 30_000);
});
