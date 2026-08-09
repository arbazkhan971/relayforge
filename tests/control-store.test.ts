import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, parseControlEvent, sha256Text, type ControlEvent } from "../src/control/events.js";
import {
  ControlStore,
  ControlStoreError,
  controlStoreInternals,
  openControlStore,
  type ControlStoreFaultPoint
} from "../src/control/store.js";

const NOW = "2026-08-09T00:00:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may intentionally have replaced the backing path.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function location(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "relayforge-control-store-"));
  roots.push(root);
  return { root, path: join(root, "control.sqlite") };
}

function open(path: string, overrides: Partial<Parameters<typeof openControlStore>[0]> = {}): ControlStore {
  const store = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", now: () => NOW, ...overrides });
  stores.push(store);
  return store;
}

function taskCreated(eventId = "event-task-created", taskId = "task-1"): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId,
    taskGeneration: 1,
    expectedVersion: 0,
    occurredAt: NOW,
    type: "task.created",
    payload: {
      title: "Implement durable state",
      assignee: "backend",
      createdBy: "parent",
      description: "Build the authority.",
      acceptanceCriteria: ["replays exactly"],
      dependsOn: [],
      priority: 10,
      createdAt: NOW,
      files: ["src/control/store.ts"]
    }
  });
}

function taskStatus(eventId: string, expectedVersion: number, status: string, role = "backend"): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 1,
    expectedVersion,
    occurredAt: NOW,
    type: "task.status_changed",
    payload: { role, status, summary: `${status} summary` }
  });
}

function runMessage(eventId: string, expectedVersion: number, messageId = eventId): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: null,
    taskGeneration: null,
    expectedVersion,
    occurredAt: NOW,
    type: "message.posted",
    payload: { messageId, from: "parent", to: "backend", body: `body ${messageId}` }
  });
}

function runLifecycle(type: "run.started" | "run.completed" | "run.failed" | "run.cancelled", eventId: string, expectedVersion: number): ControlEvent {
  const payload = type === "run.started"
    ? { startedBy: "parent", goal: "Complete RelayForge" }
    : type === "run.failed"
      ? { reasonCode: "verification_failed", summary: "red gate" }
      : type === "run.cancelled"
        ? { cancelledBy: "parent", reason: "operator requested" }
        : { summary: "all work complete" };
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: null,
    taskGeneration: null,
    expectedVersion,
    occurredAt: NOW,
    type,
    payload
  });
}

function raw(path: string, action: (db: Database.Database) => void): void {
  const db = new Database(path);
  try {
    db.pragma("busy_timeout = 5000");
    action(db);
  } finally {
    db.close();
  }
}

function expectCode(action: () => unknown, code: ControlStoreError["code"]): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ControlStoreError);
    expect((error as ControlStoreError).code).toBe(code);
  }
}

type ChildOutcome = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function writerChild(
  path: string,
  event: ControlEvent,
  ready = "",
  start = "",
  crashPoint = "",
  expectedHead = ""
): { child: ChildProcess; done: Promise<ChildOutcome> } {
  const fixture = resolve("tests/fixtures/control-store-writer.ts");
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    fixture,
    path,
    Buffer.from(JSON.stringify(event), "utf8").toString("base64url"),
    ready,
    start,
    crashPoint,
    expectedHead
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const done = new Promise<ChildOutcome>((resolvePromise) => {
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!paths.every(existsSync)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${paths.join(", ")}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function lockHolderChild(path: string, ready: string, holdMs = 6_500): { child: ChildProcess; done: Promise<ChildOutcome> } {
  const fixture = resolve("tests/fixtures/control-store-writer.ts");
  const child = spawn(process.execPath, ["--import", "tsx", fixture, path, "--hold-lock", ready, "", String(holdMs)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return {
    child,
    done: new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr })))
  };
}

describe("ControlStore canonical authority", () => {
  it("creates a physically identified WAL store, commits event and projection, and reopens", () => {
    const { path } = location();
    const store = open(path);
    const result = store.append(taskCreated());
    expect(result).toMatchObject({ seq: 1, idempotent: false, aggregateVersion: 1 });
    expect(store.head()).toEqual({ runId: "run-1", runEpoch: "epoch-1", floorSeq: 1, headSeq: 1 });
    expect(store.getProjection().tasks["task-1"]).toMatchObject({ status: "open", version: 1, updatedSeq: 1 });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    raw(path, (db) => {
      expect(db.pragma("application_id", { simple: true })).toBe(controlStoreInternals.applicationId);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("user_version", { simple: true })).toBe(controlStoreInternals.databaseSchemaVersion);
    });
    const reopened = open(path, { create: false });
    expect(reopened.readRange({ afterSeq: 0 }).events.map((event) => event.eventId)).toEqual(["event-task-created"]);
    expect(reopened.getProjection().tasks["task-1"]?.title).toBe("Implement durable state");
  });

  it("makes an exact eventId retry idempotent and rejects divergent reuse", () => {
    const { path } = location();
    const store = open(path);
    const event = taskCreated();
    const first = store.append(event);
    const retry = store.append(structuredClone(event));
    expect(retry).toEqual({ ...first, idempotent: true });
    expect(store.head().headSeq).toBe(1);

    const divergent = structuredClone(event) as Record<string, unknown>;
    divergent.occurredAt = "2026-08-09T00:00:01.000Z";
    expectCode(() => store.append(divergent), "EVENT_ID_CONFLICT");
    expect(store.head().headSeq).toBe(1);
  });

  it("atomically fences a cross-aggregate decision by the canonical head and preserves exact retry", () => {
    const { path } = location();
    const store = open(path);
    store.append(taskCreated());
    const observedHead = store.getProjection().headSeq;
    store.append(runMessage("intervening-run-message", 0));

    expectCode(() => store.appendBatchIf({
      expectedHeadSeq: observedHead,
      events: [taskStatus("head-fenced-claim", 1, "claimed")]
    }), "STALE_VERSION");
    expect(store.getProjection().tasks["task-1"]?.status).toBe("open");

    const currentHead = store.head().headSeq;
    const first = store.appendBatchIf({
      expectedHeadSeq: currentHead,
      events: [taskStatus("head-fenced-claim", 1, "claimed")]
    });
    const retry = store.appendBatchIf({
      expectedHeadSeq: currentHead,
      events: [taskStatus("head-fenced-claim", 1, "claimed")]
    });
    expect(first).toHaveLength(1);
    expect(retry).toEqual([{ ...first[0]!, idempotent: true }]);
    expect(store.head().headSeq).toBe(currentHead + 1);
    expectCode(() => store.appendBatchIf({ expectedHeadSeq: -1, events: [] }), "INVALID_EVENT");
  });

  it("rolls back a head-fenced batch at every existing event/projection fault boundary", () => {
    for (const point of [
      "before-event-insert",
      "after-event-insert",
      "before-projection-write",
      "after-projection-write",
      "before-commit"
    ] as const satisfies readonly ControlStoreFaultPoint[]) {
      const { path } = location();
      const store = open(path, { fault: (seen) => { if (seen === point) throw new Error(`head-fault:${point}`); } });
      expect(() => store.appendBatchIf({ expectedHeadSeq: 0, events: [taskCreated()] })).toThrow(`head-fault:${point}`);
      expect(store.head().headSeq).toBe(0);
      expect(store.getProjection().tasks).toEqual({});
      store.close();
      stores.splice(stores.indexOf(store), 1);
    }
  });

  it("allocates canonical recordedAt, persists normalized authorship, and keeps retry time stable", () => {
    const { path } = location();
    const createdAt = "2026-08-09T00:00:00.000Z";
    const recordedAt = "2026-08-09T00:00:01.000Z";
    const times = [createdAt, recordedAt];
    const store = open(path, { now: () => times.shift() ?? "not-a-time" });
    const first = store.append(taskCreated());
    const retry = store.append(taskCreated());
    expect(first).toMatchObject({ recordedAt, intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(retry).toEqual({ ...first, idempotent: true });
    const persisted = store.readRange({ afterSeq: 0 }).events[0]!;
    expect(persisted).toMatchObject({ recordedAt, actorKind: "control-plane", actorId: "parent" });
    expect(persisted.digest).not.toBe(persisted.intentDigest);
    raw(path, (db) => {
      expect(db.prepare("SELECT recorded_at, actor_kind, actor_id FROM control_events WHERE seq = 1").get()).toEqual({
        recorded_at: recordedAt,
        actor_kind: "control-plane",
        actor_id: "parent"
      });
    });
  });

  it("binds all-or-none external source identity and rejects tuple reuse", () => {
    const { path } = location();
    const store = open(path);
    const sourced = parseControlEvent({
      ...runMessage("source-event-1", 0),
      actorKind: "integration",
      actorId: "github-adapter",
      sourceKind: "github",
      sourceId: "installation-1",
      sourceGeneration: 3,
      sourceEventId: "delivery-42"
    });
    expect(store.append(sourced)).toMatchObject({ seq: 1, idempotent: false });
    expect(store.append(structuredClone(sourced))).toMatchObject({ seq: 1, idempotent: true });
    expectCode(() => store.append(parseControlEvent({
      ...runMessage("source-event-2", 1),
      actorKind: "integration",
      actorId: "github-adapter",
      sourceKind: "github",
      sourceId: "installation-1",
      sourceGeneration: 3,
      sourceEventId: "delivery-42"
    })), "EVENT_ID_CONFLICT");
    expect(() => parseControlEvent({ ...runMessage("partial-source", 1), sourceKind: "github" })).toThrow();
    raw(path, (db) => {
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'control_events_external_source'").get() as { sql: string }).sql;
      expect(sql).toContain("UNIQUE INDEX");
    });
  });

  it("mints one stable storeId and binds snapshots to verified metadata", () => {
    const { path } = location();
    const store = open(path);
    const identity = store.identity();
    expect(identity.storeId).toMatch(/^[0-9a-f-]{36}$/i);
    store.append(taskCreated());
    const snapshot = store.createSnapshot();
    expect(snapshot).toMatchObject({ storeId: identity.storeId, createdAt: NOW, verifiedAt: NOW });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(open(path, { create: false }).identity()).toEqual(identity);
  });

  it("persists a monotonic run lifecycle as a first-class projection", () => {
    const { path } = location();
    const store = open(path);
    store.append(runLifecycle("run.started", "run-started", 0));
    store.append(runMessage("run-message", 1));
    store.append(runLifecycle("run.completed", "run-completed", 2));
    expect(store.getProjection().run).toMatchObject({ status: "completed", startedBy: "parent", version: 3, updatedSeq: 3 });
    expect(store.getActivity("missing-session").state).toBe("exited");
    expectCode(() => store.append(runLifecycle("run.failed", "late-failure", 3)), "INVALID_EVENT");
    expect(store.head().headSeq).toBe(3);
  });

  it("persists exact loop checkpoints and rolls back invalid checkpoint histories", () => {
    const { path } = location();
    const store = open(path);
    const checkpoint = (eventId: string, expectedVersion: number, iteration: number) => parseControlEvent({
      ...runMessage(eventId, expectedVersion),
      type: "run.checkpointed",
      payload: {
        project: "relayforge",
        phase: "dispatch",
        status: "running",
        iteration,
        dispatched: iteration,
        accepted: 0,
        rejected: 0,
        escalations: 0,
        repeatFailures: 0,
        unknownCostCalls: 0,
        startedAt: NOW,
        updatedAt: NOW
      }
    });
    store.append(runLifecycle("run.started", "started", 0));
    store.append(checkpoint("checkpoint-1", 1, 1));
    expect(store.getProjection().run?.checkpoint).toMatchObject({ iteration: 1, project: "relayforge" });
    expectCode(() => store.append(checkpoint("checkpoint-regressed", 2, 0)), "INVALID_EVENT");
    expect(store.head().headSeq).toBe(2);
  });

  it("handles exact retries inside one batch without advancing sequence twice", () => {
    const { path } = location();
    const store = open(path);
    const event = taskCreated();
    const results = store.appendBatch([event, structuredClone(event)]);
    expect(results).toEqual([
      expect.objectContaining({ seq: 1, idempotent: false }),
      expect.objectContaining({ seq: 1, idempotent: true })
    ]);
    expect(store.head().headSeq).toBe(1);
  });

  it("rejects unknown envelope and payload fields before writing", () => {
    const { path } = location();
    const store = open(path);
    expectCode(() => store.append({ ...taskCreated(), unexpected: true }), "INVALID_EVENT");
    const nested = structuredClone(taskCreated()) as unknown as { payload: Record<string, unknown> };
    nested.payload.unexpected = true;
    expectCode(() => store.append(nested), "INVALID_EVENT");
    expect(store.head().headSeq).toBe(0);
  });

  it("fences stale aggregate versions and task generations without appending", () => {
    const { path } = location();
    const store = open(path);
    store.append(taskCreated());
    expectCode(() => store.append(taskStatus("status-stale", 0, "claimed")), "STALE_VERSION");
    const staleGeneration = { ...taskStatus("status-generation", 1, "claimed"), taskGeneration: 2 };
    expectCode(() => store.append(staleGeneration), "STALE_GENERATION");
    expect(store.head().headSeq).toBe(1);
  });

  it("allows only an explicit terminal task reopen to create the next generation", () => {
    const { path } = location();
    const store = open(path);
    store.appendBatch([
      taskCreated(),
      taskStatus("claim", 1, "claimed"),
      taskStatus("review", 2, "needs-review"),
      taskStatus("done", 3, "done")
    ]);
    const reopened = parseControlEvent({
      ...taskStatus("reopened", 4, "done"),
      type: "task.reopened",
      payload: { newGeneration: 2, reason: "new acceptance criterion" }
    });
    store.append(reopened);
    expect(store.getProjection().tasks["task-1"]).toMatchObject({ generation: 2, status: "open", version: 0 });
    expectCode(() => store.append({ ...taskStatus("stale-old", 5, "claimed"), taskGeneration: 1 }), "STALE_GENERATION");
    expect(store.append({ ...taskStatus("claim-new", 0, "claimed"), taskGeneration: 2 })).toMatchObject({ aggregateVersion: 1 });
    expect(store.getProjection().tasks["task-1"]).toMatchObject({ generation: 2, status: "claimed", version: 1 });
  });

  it("couples event effects and consumer cursor advancement in one fenced transaction", () => {
    const { path } = location();
    const store = open(path);
    store.append(taskCreated());
    const committed = store.appendBatchWithCursor([runMessage("cursor-effect", 0)], {
      consumerId: "projection-worker",
      generation: 1,
      expectedLastSeq: 0,
      nextLastSeq: 1
    });
    expect(committed.events).toHaveLength(1);
    expect(committed.cursor).toMatchObject({ consumerId: "projection-worker", generation: 1, lastSeq: 1 });
    expect(store.readConsumerCursor("projection-worker")).toEqual(committed.cursor);
    expectCode(() => store.advanceConsumerCursor({
      consumerId: "projection-worker",
      generation: 1,
      expectedLastSeq: 0,
      nextLastSeq: 2
    }), "STALE_VERSION");
    expectCode(() => store.advanceConsumerCursor({
      consumerId: "projection-worker",
      generation: 2,
      expectedLastSeq: 1,
      nextLastSeq: 2
    }), "STALE_GENERATION");
    expect(store.advanceConsumerCursor({
      consumerId: "projection-worker",
      generation: 1,
      expectedLastSeq: 1,
      nextLastSeq: 2
    })).toMatchObject({ lastSeq: 2 });
  });

  it("rolls back both an appended effect and cursor at cursor fault boundaries", () => {
    for (const point of ["before-cursor-write", "after-cursor-write"] as const satisfies readonly ControlStoreFaultPoint[]) {
      const { path } = location();
      const store = open(path, { fault: (seen) => { if (seen === point) throw new Error(`fault:${point}`); } });
      store.append(taskCreated());
      expect(() => store.appendBatchWithCursor([runMessage(`effect-${point}`, 0)], {
        consumerId: `consumer-${point}`,
        generation: 1,
        expectedLastSeq: 0,
        nextLastSeq: 1
      })).toThrow(`fault:${point}`);
      expect(store.head().headSeq).toBe(1);
      expect(store.readConsumerCursor(`consumer-${point}`)).toBeUndefined();
      store.close();
      stores.splice(stores.indexOf(store), 1);
    }
  });

  it("rolls back an entire batch when a later event violates the state machine", () => {
    const { path } = location();
    const store = open(path);
    expectCode(() => store.appendBatch([taskCreated(), taskStatus("illegal-done", 1, "done")]), "INVALID_EVENT");
    expect(store.head().headSeq).toBe(0);
    expect(store.getProjection().tasks).toEqual({});
    expect(store.readRange({ afterSeq: 0 }).events).toEqual([]);
  });

  for (const point of [
    "before-event-insert",
    "after-event-insert",
    "before-projection-write",
    "after-projection-write",
    "before-commit"
  ] as const satisfies readonly ControlStoreFaultPoint[]) {
    it(`rolls back event and projection at injected ${point}`, () => {
      const { path } = location();
      const store = open(path, { fault: (seen) => { if (seen === point) throw new Error(`fault:${point}`); } });
      expect(() => store.append(taskCreated())).toThrow(`fault:${point}`);
      expect(store.head().headSeq).toBe(0);
      expect(store.getProjection()).toMatchObject({ headSeq: 0, tasks: {}, aggregateVersions: {} });
    });
  }

  it("serializes independent writers so one competing expected version becomes stale", () => {
    const { path } = location();
    const first = open(path);
    const second = open(path, { create: false });
    first.append(taskCreated());
    expect(second.append(taskCreated())).toMatchObject({ seq: 1, idempotent: true });
    first.append(taskStatus("claim-first", 1, "claimed"));
    expectCode(() => second.append(taskStatus("claim-second", 1, "claimed")), "STALE_VERSION");
    expect(second.getProjection().tasks["task-1"]).toMatchObject({ status: "claimed", version: 2 });
  });

  it("serializes two real processes at one expected-version boundary", async () => {
    const { root, path } = location();
    const seed = open(path);
    seed.append(taskCreated());
    seed.close();
    stores.splice(stores.indexOf(seed), 1);
    const ready1 = join(root, "ready-1");
    const ready2 = join(root, "ready-2");
    const start = join(root, "start");
    const first = writerChild(path, taskStatus("process-claim-1", 1, "claimed"), ready1, start);
    const second = writerChild(path, taskStatus("process-claim-2", 1, "claimed"), ready2, start);
    await waitForFiles([ready1, ready2]);
    writeFileSync(start, "go", { mode: 0o600 });
    const outcomes = await Promise.all([first.done, second.done]);
    const payloads = outcomes.map((outcome) => JSON.parse(outcome.stdout.trim()) as { ok: boolean; code?: string });
    expect(payloads.filter((payload) => payload.ok)).toHaveLength(1);
    expect(payloads.filter((payload) => payload.code === "STALE_VERSION")).toHaveLength(1);
    const reopened = open(path, { create: false });
    expect(reopened.head().headSeq).toBe(2);
    expect(reopened.getProjection().tasks["task-1"]).toMatchObject({ status: "claimed", version: 2 });
  }, 20_000);

  it("lets exactly one real process win a whole-head CAS across independent aggregates", async () => {
    const { root, path } = location();
    const seed = open(path);
    seed.append(taskCreated());
    seed.close();
    stores.splice(stores.indexOf(seed), 1);
    const ready1 = join(root, "head-ready-1");
    const ready2 = join(root, "head-ready-2");
    const start = join(root, "head-start");
    const taskWriter = writerChild(path, taskStatus("head-process-task", 1, "claimed"), ready1, start, "", "1");
    const runWriter = writerChild(path, runMessage("head-process-run", 0), ready2, start, "", "1");
    await waitForFiles([ready1, ready2]);
    writeFileSync(start, "go", { mode: 0o600 });
    const outcomes = await Promise.all([taskWriter.done, runWriter.done]);
    const payloads = outcomes.map((outcome) => JSON.parse(outcome.stdout.trim()) as { ok: boolean; code?: string });
    expect(payloads.filter((payload) => payload.ok)).toHaveLength(1);
    expect(payloads.filter((payload) => payload.code === "STALE_VERSION")).toHaveLength(1);

    const reopened = open(path, { create: false });
    const eventIds = reopened.readRange({ afterSeq: 0 }).events.map((event) => event.eventId);
    expect(eventIds).toHaveLength(2);
    expect(eventIds.filter((id) => id === "head-process-task" || id === "head-process-run")).toHaveLength(1);
  }, 20_000);

  it("fences 64 real processes at one CAS boundary with exactly one winner", async () => {
    const { root, path } = location();
    const seed = open(path);
    seed.append(taskCreated());
    seed.close();
    stores.splice(stores.indexOf(seed), 1);
    const start = join(root, "start-64");
    const children = Array.from({ length: 64 }, (_, index) => {
      const ready = join(root, `ready-64-${index}`);
      return {
        ready,
        writer: writerChild(path, taskStatus(`process-claim-${index}`, 1, "claimed"), ready, start)
      };
    });
    await waitForFiles(children.map((entry) => entry.ready));
    writeFileSync(start, "go", { mode: 0o600 });
    const outcomes = await Promise.all(children.map((entry) => entry.writer.done));
    const payloads = outcomes.map((outcome) => {
      if (!outcome.stdout.trim()) throw new Error(`writer produced no result: ${outcome.stderr}`);
      return JSON.parse(outcome.stdout.trim()) as { ok: boolean; code?: string };
    });
    expect(payloads.filter((payload) => payload.ok)).toHaveLength(1);
    expect(payloads.filter((payload) => payload.code === "STALE_VERSION")).toHaveLength(63);
    const reopened = open(path, { create: false });
    expect(reopened.head().headSeq).toBe(2);
    expect(reopened.getProjection().tasks["task-1"]).toMatchObject({ status: "claimed", version: 2 });
  }, 120_000);

  it("bounds a contended writer wait and returns typed STORE_BUSY without partial mutation", async () => {
    const { root, path } = location();
    const store = open(path);
    const ready = join(root, "lock-ready");
    const holder = lockHolderChild(path, ready, 6_500);
    await waitForFiles([ready]);
    const started = Date.now();
    expectCode(() => store.append(taskCreated()), "STORE_BUSY");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(6_500);
    expect(store.head().headSeq).toBe(0);
    const outcome = await holder.done;
    expect(outcome).toMatchObject({ code: 0, signal: null });
  }, 15_000);

  it.each(["after-event-insert", "after-projection-write", "before-commit"] as const)(
    "recovers an empty authority after SIGKILL at %s",
    async (point) => {
      const { path } = location();
      const seed = open(path);
      seed.close();
      stores.splice(stores.indexOf(seed), 1);
      const child = writerChild(path, taskCreated(), "", "", point);
      const outcome = await child.done;
      expect(outcome.signal).toBe("SIGKILL");
      const recovered = open(path, { create: false });
      expect(recovered.head().headSeq).toBe(0);
      expect(recovered.getProjection()).toMatchObject({ tasks: {}, aggregateVersions: {}, headSeq: 0 });
    },
    20_000
  );

  it("captures floor and head with a typed expired-cursor response", () => {
    const { path } = location();
    const store = open(path);
    store.appendBatch([taskCreated(), runMessage("message-event", 0)]);
    expect(store.readRange({ afterSeq: 0, limit: 1 })).toMatchObject({ floorSeq: 1, headSeq: 2, hasMore: true });
    expect(store.readRange({ afterSeq: 1, limit: 10 })).toMatchObject({ headSeq: 2, hasMore: false });
    raw(path, (db) => db.prepare("UPDATE control_meta SET retained_floor = 2 WHERE singleton = 1").run());
    expectCode(() => store.readRange({ afterSeq: 0 }), "CURSOR_EXPIRED");
    expectCode(() => store.readRange({ afterSeq: 99 }), "RECOVERY_REQUIRED");
    expectCode(() => store.readRange({ afterSeq: 1, runEpoch: "other" }), "RUN_IDENTITY_MISMATCH");
    expectCode(() => store.readRange({ afterSeq: 1, limit: 0 }), "INVALID_EVENT");
    expectCode(() => store.readRange({ afterSeq: 1, limit: controlStoreInternals.maxRangeLimit + 1 }), "INVALID_EVENT");
  });

  it("coalesces post-commit wakes, reports the latest head, and isolates throwing subscribers", () => {
    const callbacks: Array<() => void> = [];
    const { path } = location();
    const store = open(path, { scheduleWake: (callback) => callbacks.push(callback) });
    const seen: number[] = [];
    store.subscribe(() => { throw new Error("listener defect"); });
    store.subscribe((wake) => seen.push(wake.headSeq));
    store.append(taskCreated());
    store.append(runMessage("message-event", 0));
    expect(callbacks).toHaveLength(1);
    expect(seen).toEqual([]);
    callbacks[0]!();
    expect(seen).toEqual([2]);
    expect(store.head().headSeq).toBe(2);
  });

  it("does not let a post-commit wake scheduler defect change append success", () => {
    const { path } = location();
    const store = open(path, { scheduleWake: () => { throw new Error("wake unavailable"); } });
    expect(store.append(taskCreated())).toMatchObject({ seq: 1, idempotent: false });
    expect(store.head().headSeq).toBe(1);
    expect(store.getProjection().tasks["task-1"]?.status).toBe("open");
  });

  it("detects canonical event corruption on restart", () => {
    const { path } = location();
    const store = open(path);
    store.append(taskCreated());
    store.close();
    stores.splice(stores.indexOf(store), 1);
    raw(path, (db) => db.prepare("UPDATE control_events SET digest = ? WHERE seq = 1").run("0".repeat(64)));
    expectCode(() => openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false }), "RECOVERY_REQUIRED");
  });

  it("detects a logically forged projection and can rebuild only from canonical history", () => {
    const { path } = location();
    const store = open(path);
    store.append(taskCreated());
    store.close();
    stores.splice(stores.indexOf(store), 1);

    raw(path, (db) => {
      const row = db.prepare("SELECT fact_json FROM task_projection WHERE task_id = 'task-1'").get() as { fact_json: string };
      const fact = JSON.parse(row.fact_json) as Record<string, unknown>;
      fact.title = "forged but internally checksummed";
      const forged = canonicalJson(fact);
      db.prepare("UPDATE task_projection SET fact_json = ?, digest = ? WHERE task_id = 'task-1'").run(forged, sha256Text(forged));
    });
    expectCode(() => openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false }), "RECOVERY_REQUIRED");
    const repaired = open(path, { create: false, recoveryMode: "rebuild" });
    expect(repaired.getProjection().tasks["task-1"]?.title).toBe("Implement durable state");
  });

  it("creates a verified snapshot, proves replay equivalence, and rejects snapshot corruption", () => {
    const { path } = location();
    const store = open(path);
    store.appendBatch([taskCreated(), taskStatus("claim", 1, "claimed"), runMessage("message-event", 0)]);
    const receipt = store.createSnapshot();
    expect(receipt).toMatchObject({ seq: 3, schemaVersion: 1, reducerVersion: 1 });
    expect(store.createSnapshot()).toEqual(receipt);
    expect(store.verifySnapshot()).toEqual(receipt);
    store.append(runMessage("message-after-snapshot", 1));
    expect(store.rebuildProjections()).toEqual(store.getProjection());
    raw(path, (db) => db.prepare("UPDATE control_snapshots SET digest = ? WHERE seq = 3").run("f".repeat(64)));
    expectCode(() => store.verifySnapshot(3), "RECOVERY_REQUIRED");
  });

  it("refuses snapshot creation unless the current projection equals a genesis replay", () => {
    const { path } = location();
    const store = open(path);
    store.append(taskCreated());
    raw(path, (db) => {
      const row = db.prepare("SELECT fact_json FROM task_projection WHERE task_id = 'task-1'").get() as { fact_json: string };
      const fact = JSON.parse(row.fact_json) as Record<string, unknown>;
      fact.title = "forged projection";
      const forged = canonicalJson(fact);
      db.prepare("UPDATE task_projection SET fact_json = ?, digest = ? WHERE task_id = 'task-1'").run(forged, sha256Text(forged));
    });
    expectCode(() => store.createSnapshot(), "RECOVERY_REQUIRED");
    expect(store.rebuildProjections().tasks["task-1"]?.title).toBe("Implement durable state");
  });

  it("updates only event-local projection rows and handles a sizeable board batch", () => {
    const { path } = location();
    const store = open(path);
    store.append(taskCreated());
    store.append(runMessage("unrelated-message", 0));
    raw(path, (db) => {
      // TEMP triggers are connection-local, so use a durable probe for the characterization below.
      db.exec(`
        CREATE TABLE projection_probe(updates INTEGER NOT NULL) STRICT;
        INSERT INTO projection_probe VALUES (0);
        CREATE TRIGGER task_update_probe_durable AFTER UPDATE ON task_projection
        BEGIN UPDATE projection_probe SET updates = updates + 1; END;
        CREATE TRIGGER task_delete_probe_durable AFTER DELETE ON task_projection
        BEGIN UPDATE projection_probe SET updates = updates + 1; END;
      `);
    });
    store.append(runMessage("another-unrelated-message", 1));
    raw(path, (db) => {
      expect((db.prepare("SELECT updates FROM projection_probe").get() as { updates: number }).updates).toBe(0);
    });

    const bulk = Array.from({ length: 256 }, (_, index) => taskCreated(`bulk-event-${index}`, `bulk-task-${index}`));
    store.appendBatch(bulk);
    expect(Object.keys(store.getProjection().tasks)).toHaveLength(257);
  }, 20_000);

  it("performs controlled full integrity verification and returns exact typed failures", () => {
    const { path } = location();
    const store = open(path);
    store.append(taskCreated());
    store.createSnapshot();
    expect(store.verifyIntegrity("full")).toMatchObject({
      level: "full",
      storeId: store.storeId,
      runId: "run-1",
      runEpoch: "epoch-1",
      headSeq: 1,
      verifiedAt: NOW
    });
    raw(path, (db) => db.prepare("UPDATE control_events SET actor_id = 'forged' WHERE seq = 1").run());
    expectCode(() => store.verifyIntegrity("full"), "RECOVERY_REQUIRED");
  });

  it.each([
    ["application id", (db: Database.Database) => db.pragma("application_id = 7")],
    ["migration checksum", (db: Database.Database) => db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("bad")],
    ["physical schema", (db: Database.Database) => db.exec("DROP TABLE task_projection")]
  ])("fails closed on corrupt %s", (_label, corrupt) => {
    const { path } = location();
    const store = open(path);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    raw(path, corrupt);
    expectCode(() => openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false }), "RECOVERY_REQUIRED");
  });

  it("refuses the wrong run identity and a replaced database pathname", () => {
    const { root, path } = location();
    const store = open(path);
    store.append(taskCreated());
    expectCode(() => openControlStore({ path, runId: "run-2", runEpoch: "epoch-1", create: false }), "RUN_IDENTITY_MISMATCH");

    const moved = join(root, "moved.sqlite");
    renameSync(path, moved);
    copyFileSync(moved, path);
    chmodSync(path, 0o600);
    expectCode(() => store.head(), "RECOVERY_REQUIRED");
  });

  it("does not create a parent for create:false and rejects symlinked ancestor aliases", () => {
    const { root } = location();
    const missingParent = join(root, "missing", "nested");
    expectCode(() => openControlStore({
      path: join(missingParent, "control.sqlite"),
      runId: "run-1",
      runEpoch: "epoch-1",
      create: false
    }), "RECOVERY_REQUIRED");
    expect(existsSync(join(root, "missing"))).toBe(false);

    const realParent = join(root, "real-parent");
    const aliasParent = join(root, "alias-parent");
    mkdirSync(realParent, { mode: 0o700 });
    symlinkSync(realParent, aliasParent, "dir");
    expectCode(() => openControlStore({
      path: join(aliasParent, "control.sqlite"),
      runId: "run-1",
      runEpoch: "epoch-1"
    }), "RECOVERY_REQUIRED");
    expect(existsSync(join(realParent, "control.sqlite"))).toBe(false);
  });

  it("makes close idempotent and refuses all later reads", () => {
    const { path } = location();
    const store = open(path);
    store.close();
    store.close();
    expectCode(() => store.head(), "STORE_CLOSED");
  });
});
