import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlRoomSnapshot } from "../src/control-room/server-adapter.js";
import { parseControlEvent, type ControlEvent } from "../src/control/events.js";
import { ControlStore, openControlStore, type ControlStoreFaultPoint } from "../src/control/store.js";
import { createControlStoreTranscriptCommit, ControlObservationCommitError } from "../src/observability/control-store-adapter.js";
import { redactObservationSummary } from "../src/observability/public.js";
import {
  transcriptIngestorStateDigest,
  type IngestedObservationV1,
  type TranscriptCommitRequestV1,
  type TranscriptIngestorStateV1
} from "../src/observability/transcript-ingestor.js";

const AT = "2026-08-09T12:00:00.000Z";
const EPOCH = "epoch_1234567890123456";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) try { store.close(); } catch { /* intentional fault tests */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controlEvent(
  type: ControlEvent["type"],
  eventId: string,
  options: { expectedVersion: number; payload: unknown; taskId?: string | null; taskGeneration?: number | null }
): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: EPOCH,
    taskId: options.taskId === undefined ? "task-1" : options.taskId,
    taskGeneration: options.taskGeneration === undefined ? 1 : options.taskGeneration,
    expectedVersion: options.expectedVersion,
    occurredAt: AT,
    actorKind: "control-plane",
    actorId: "parent",
    sourceKind: null,
    sourceId: null,
    sourceGeneration: null,
    sourceEventId: null,
    type,
    payload: options.payload
  });
}

function seed(): ControlEvent[] {
  return [
    controlEvent("run.started", "run-started", { taskId: null, taskGeneration: null, expectedVersion: 0, payload: { startedBy: "parent", goal: "P5" } }),
    controlEvent("task.created", "task-created", { expectedVersion: 0, payload: { title: "Observe", assignee: "worker", createdBy: "parent", description: "Observe safely", acceptanceCriteria: ["durable"], dependsOn: [], priority: 1, createdAt: AT } }),
    controlEvent("task.status_changed", "task-claimed", { expectedVersion: 1, payload: { role: "worker", status: "claimed", summary: "claimed" } }),
    controlEvent("task.status_changed", "task-active", { expectedVersion: 2, payload: { role: "worker", status: "in-progress", summary: "active" } }),
    controlEvent("runtime.observed", "runtime-observed", { expectedVersion: 0, payload: { sessionId: "worker-1", sessionGeneration: 1, observation: "available" } }),
    controlEvent("attempt.prompt_prepared", "attempt-prepared", { expectedVersion: 3, payload: { attemptId: "attempt-1", attemptGeneration: 1, sessionId: "worker-1", sessionGeneration: 1, artifactLocator: "steering/prompts/attempt-1.prompt", promptSha256: "c".repeat(64), promptBytes: 128, rendererVersion: 1, captureCutoffSeq: 5, steeringCommandIds: [] } })
  ];
}

function initialState(): TranscriptIngestorStateV1 {
  return {
    schemaVersion: 1,
    sourceId: "a".repeat(64),
    generation: { runId: "run-1", runEpoch: EPOCH, taskId: "task-1", agentId: "worker-1", runtimeGeneration: 1, attemptGeneration: 1, sourceGeneration: 1 },
    parserId: "test.jsonl",
    parserVersion: 1,
    cursor: 0,
    prefixDigest: "b".repeat(64),
    nextRecordOrdinal: 1,
    discardingOversize: false,
    discardedRecordBytes: 0,
    quietPolls: 0,
    lastObservedSize: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    integrity: "live"
  };
}

function request(summary = "token=PRIVATE_SENTINEL /home/worker/private.log"): TranscriptCommitRequestV1 {
  const initial = initialState();
  const nextState: TranscriptIngestorStateV1 = {
    ...initial,
    cursor: 1,
    prefixDigest: "d".repeat(64),
    nextRecordOrdinal: 2,
    lastObservedSize: 1,
    integrity: "degraded"
  };
  const observation: IngestedObservationV1 = {
    schemaVersion: 1,
    recordId: "obs-a-1",
    generation: initial.generation,
    observedAt: AT,
    category: "runtime",
    phase: "executing",
    severity: "warning",
    code: "runtime.untrusted_text",
    details: { kind: "lifecycle", activity: "blocked", stateCode: "provider.claims_blocked" },
    sourceIntegrity: "degraded",
    summary: redactObservationSummary(summary)
  };
  return Object.freeze({
    previousStateDigest: transcriptIngestorStateDigest(initial),
    nextState,
    nextStateDigest: transcriptIngestorStateDigest(nextState),
    observations: Object.freeze([observation])
  });
}

function setup(fault?: (point: ControlStoreFaultPoint, event?: ControlEvent) => void): { root: string; path: string; store: ControlStore } {
  const root = mkdtempSync(join(tmpdir(), "relayforge-observation-store-"));
  roots.push(root);
  const path = join(root, "control.sqlite");
  const store = openControlStore({ path, runId: "run-1", runEpoch: EPOCH, now: () => AT, fault });
  stores.push(store);
  store.appendBatch(seed());
  return { root, path, store };
}

function adapter(store: ControlStore) {
  return createControlStoreTranscriptCommit({ store, initialState: initialState(), actorId: "observation-parent", now: () => AT });
}

describe("ControlStore normalized observation integration", () => {
  it("atomically commits a checkpoint and sanitized record, projects an exact-head control room, and survives restart", async () => {
    const value = setup();
    const receipt = await adapter(value.store)(request());
    expect(receipt).toEqual({ stateDigest: request().nextStateDigest, observationCount: 1 });
    expect(value.store.head().headSeq).toBe(8);
    const projection = value.store.getProjection();
    expect(Object.values(projection.observability.sources)[0]).toMatchObject({ observationCount: 1, stateDigest: receipt.stateDigest, updatedSeq: 7 });
    expect(projection.observability.room.observations).toHaveLength(1);
    expect(projection.observability.room.observations[0]).toMatchObject({ seq: 8, summary: { redacted: true } });
    expect(projection.tasks["task-1"]?.status).toBe("in-progress");
    expect(projection.observability.room.rows[0]).toMatchObject({ activity: "dispatching", attention: "working" });
    const snapshot = buildControlRoomSnapshot(value.store);
    expect(snapshot).toMatchObject({ runId: "run-1", eventHeadSeq: 8, observationPage: { freshness: "fresh", projectionSeq: 8 } });

    const db = new Database(value.path, { readonly: true });
    const durableText = JSON.stringify(db.prepare("SELECT canonical_json, payload_json FROM control_events ORDER BY seq").all());
    db.close();
    expect(durableText).not.toContain("PRIVATE_SENTINEL");
    expect(durableText).not.toContain("/home/worker/private.log");
    expect(durableText).toContain("[credential]");
    expect(durableText).toContain("[path]");

    value.store.close(); stores.splice(stores.indexOf(value.store), 1);
    const reopened = openControlStore({ path: value.path, runId: "run-1", runEpoch: EPOCH, create: false, now: () => AT });
    stores.push(reopened);
    expect(reopened.getProjection().observability).toEqual(projection.observability);
    expect(reopened.verifyIntegrity("full")).toMatchObject({ headSeq: 8 });
    expect(reopened.createSnapshot()).toMatchObject({ seq: 8 });
    expect(reopened.verifySnapshot()).toMatchObject({ seq: 8 });
  });

  it("acknowledges exact ambiguous retries and rejects same-state divergent records", async () => {
    const value = setup();
    const commit = adapter(value.store);
    const first = request("first");
    await expect(commit(first)).resolves.toEqual({ stateDigest: first.nextStateDigest, observationCount: 1 });
    await expect(commit(structuredClone(first))).resolves.toEqual({ stateDigest: first.nextStateDigest, observationCount: 1 });
    expect(value.store.head().headSeq).toBe(8);
    await expect(commit(request("divergent"))).rejects.toMatchObject<Partial<ControlObservationCommitError>>({ code: "DIVERGENT_RETRY" });
    expect(value.store.head().headSeq).toBe(8);
  });

  it.each(["after-event-insert", "after-projection-write", "before-commit"] as const)("rolls back checkpoint and records together at %s", async (point) => {
    let armed = false;
    const value = setup((seen, event) => { if (armed && seen === point && event?.type.startsWith("observation.")) throw new Error(`fault:${point}`); });
    armed = true;
    await expect(adapter(value.store)(request())).rejects.toThrow(`fault:${point}`);
    expect(value.store.head().headSeq).toBe(6);
    expect(value.store.getProjection().observability.sources).toEqual({});
    expect(value.store.getProjection().observability.room.observations).toEqual([]);
  });

  it("rejects stale runtime generations and lets terminal task facts remain absorbing", async () => {
    const value = setup();
    value.store.appendBatch([
      controlEvent("runtime.observed", "runtime-old-exited", { expectedVersion: 1, payload: { sessionId: "worker-1", sessionGeneration: 1, observation: "exited" } }),
      controlEvent("runtime.observed", "runtime-replaced", { expectedVersion: 0, payload: { sessionId: "worker-1", sessionGeneration: 2, observation: "available" } })
    ]);
    await expect(adapter(value.store)(request())).rejects.toMatchObject<Partial<ControlObservationCommitError>>({ code: "STALE_STATE" });
    expect(value.store.head().headSeq).toBe(8);

    const terminal = setup().store;
    terminal.appendBatch([
      controlEvent("task.status_changed", "task-review", { expectedVersion: 4, payload: { role: "worker", status: "needs-review", summary: "review" } }),
      controlEvent("task.status_changed", "task-done", { expectedVersion: 5, payload: { role: "worker", status: "done", summary: "done" } })
    ]);
    await adapter(terminal)(request("provider falsely claims blocked"));
    expect(terminal.getProjection().tasks["task-1"]?.status).toBe("done");
    expect(terminal.getProjection().observability.room.rows[0]).toMatchObject({ taskStatus: "done", activity: "exited", attention: "complete" });
  });

  it("serializes two real store handles so one divergent source transaction wins without partial facts", async () => {
    const value = setup();
    const second = openControlStore({ path: value.path, runId: "run-1", runEpoch: EPOCH, create: false, now: () => AT });
    stores.push(second);
    const outcomes = await Promise.allSettled([adapter(value.store)(request("writer-one")), adapter(second)(request("writer-two"))]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(value.store.head().headSeq).toBe(8);
    expect(value.store.getProjection().observability.room.observations).toHaveLength(1);
    expect(value.store.verifyIntegrity("full")).toMatchObject({ headSeq: 8 });
  });

  it("serializes two real processes at one source-state boundary with one complete winner", async () => {
    const value = setup();
    const readyOne = join(value.root, "ready-one");
    const readyTwo = join(value.root, "ready-two");
    const start = join(value.root, "start");
    const fixture = resolve("tests/fixtures/observability-store-writer.ts");
    const initialEncoded = Buffer.from(JSON.stringify(initialState()), "utf8").toString("base64url");
    const launch = (input: TranscriptCommitRequestV1, ready: string) => {
      const child = spawn(process.execPath, ["--import", "tsx", fixture, value.path, initialEncoded, Buffer.from(JSON.stringify(input), "utf8").toString("base64url"), ready, start], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
      });
    };
    const one = launch(request("process-one"), readyOne);
    const two = launch(request("process-two"), readyTwo);
    const deadline = Date.now() + 30_000;
    while (!existsSync(readyOne) || !existsSync(readyTwo)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for observation writer processes");
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    writeFileSync(start, "go", { mode: 0o600 });
    const outcomes = await Promise.all([one, two]);
    expect(outcomes.every((outcome) => outcome.code === 0), JSON.stringify(outcomes)).toBe(true);
    const payloads = outcomes.map((outcome) => JSON.parse(outcome.stdout) as { ok: boolean; code?: string });
    expect(payloads.filter((payload) => payload.ok)).toHaveLength(1);
    expect(payloads.filter((payload) => !payload.ok)).toEqual([{ ok: false, name: "ControlObservationCommitError", code: "DIVERGENT_RETRY" }]);
    expect(value.store.head().headSeq).toBe(8);
    expect(value.store.getProjection().observability.room.observations).toHaveLength(1);
    expect(value.store.verifyIntegrity("full")).toMatchObject({ headSeq: 8 });
  }, 60_000);
});
