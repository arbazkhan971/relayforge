import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlRoomSnapshot } from "../src/control-room/server-adapter.js";
import { parseControlEvent, type ControlEvent } from "../src/control/events.js";
import { DurableSseBroker, type SseSink } from "../src/control/sse.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import {
  PARENT_TRANSCRIPT_RUNTIME_MAX_ACTIVE,
  createParentTranscriptRuntimeAuthority
} from "../src/observability/runtime-authority.js";
import { runHeadlessChild, type RunTranscriptObservationHandle } from "../src/orchestrator.js";
import { pgidScopeBackend } from "../src/scope.js";

const NOW = "2026-08-09T12:00:00.000Z";
const EPOCH = "epoch_1234567890123456";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) try { store.close(); } catch { /* closed */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(type: ControlEvent["type"], id: string, expectedVersion: number, payload: unknown): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId: id,
    runId: "run-1",
    runEpoch: EPOCH,
    taskId: type === "run.started" ? null : "task-1",
    taskGeneration: type === "run.started" ? null : 1,
    expectedVersion,
    occurredAt: NOW,
    actorKind: "control-plane",
    actorId: "parent",
    sourceKind: null,
    sourceId: null,
    sourceGeneration: null,
    sourceEventId: null,
    type,
    payload
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "relayforge-observation-runtime-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const transcripts = join(root, "transcripts");
  mkdirSync(transcripts, { mode: 0o700 });
  const store = openControlStore({ path: join(root, "control.sqlite"), runId: "run-1", runEpoch: EPOCH, now: () => NOW });
  stores.push(store);
  store.appendBatch([
    event("run.started", "run-started", 0, { startedBy: "parent", goal: "observe a real provider transcript" }),
    event("task.created", "task-created", 0, { title: "Observe", assignee: "worker", createdBy: "parent", description: "Observe", acceptanceCriteria: ["durable"], dependsOn: [], priority: 1, createdAt: NOW }),
    event("task.status_changed", "task-claimed", 1, { role: "worker", status: "claimed", summary: "claimed" }),
    event("task.status_changed", "task-active", 2, { role: "worker", status: "in-progress", summary: "active" }),
    event("runtime.observed", "runtime-observed", 0, { sessionId: "worker-1", sessionGeneration: 1, observation: "available" }),
    event("attempt.prompt_prepared", "attempt-prepared", 3, {
      attemptId: "attempt-1", attemptGeneration: 1, sessionId: "worker-1", sessionGeneration: 1,
      artifactLocator: "steering/prompts/attempt-1.prompt", promptSha256: "c".repeat(64), promptBytes: 100,
      rendererVersion: 1, captureCutoffSeq: 5, steeringCommandIds: []
    }),
    event("attempt.launch_planned", "attempt-planned", 4, { attemptId: "attempt-1", attemptGeneration: 1, sessionId: "worker-1", sessionGeneration: 1, launchId: "launch-1" }),
    event("attempt.started", "attempt-started", 5, { attemptId: "attempt-1", attemptGeneration: 1, sessionId: "worker-1", sessionGeneration: 1, launchId: "launch-1", pid: 12345, processStartToken: "42" })
  ]);
  return { root, transcripts, store };
}

class Sink implements SseSink {
  readonly frames: string[] = [];
  write(frame: string): boolean { this.frames.push(frame); return true; }
  async waitForDrain(): Promise<void> { return; }
  end(): void { /* no-op */ }
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for observation wake");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("provider transport to P5 runtime authority", () => {
  it("turns actual child stdout progress/finalization into canonical observations and metadata-only live wakes", async () => {
    const value = setup();
    const authority = createParentTranscriptRuntimeAuthority({
      store: value.store,
      runDir: value.root,
      actorId: "observation-parent",
      now: () => new Date(NOW)
    });
    const startHead = value.store.head().headSeq;
    const sink = new Sink();
    const abort = new AbortController();
    const stream = new DurableSseBroker({ limits: { heartbeatMs: 15_000 } }).stream({
      source: value.store,
      sink,
      project: "product",
      run: "run-1",
      cursor: { runEpoch: EPOCH, after: String(startHead) },
      signal: abort.signal
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    let observation: RunTranscriptObservationHandle | undefined;
    const ctx = {
      children: new Set(),
      ownedGroups: new Set(),
      ownedScopes: new Set(),
      loop: { cadenceMinutes: 1 },
      scopesPath: join(value.root, ".loop_scopes")
    } as any;
    const privateValue = "PRIVATE_PROVIDER_SENTINEL";
    const result = await runHeadlessChild(
      ctx,
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(`progress token=${privateValue} /home/worker/private.log\n`)}); process.stdout.write(${JSON.stringify("final provider response\n")});`],
      { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      "",
      value.root,
      undefined,
      value.transcripts,
      20_000,
      undefined,
      undefined,
      {
        scopeBackend: pgidScopeBackend(),
        onTranscriptOpened(path) {
          observation = authority.open({
            target: {
              taskId: "task-1",
              taskGeneration: 1,
              sessionId: "worker-1",
              sessionGeneration: 1,
              attemptId: "attempt-1",
              attemptGeneration: 1
            },
            transcriptPath: path,
            sourceGeneration: 1
          });
        },
        onTranscriptProgress() { observation?.progress(); }
      }
    );
    expect(result.transcriptDurable).toBe(true);
    await observation!.finalize({ transcriptDurable: result.transcriptDurable === true });
    await waitUntil(() => value.store.getProjection().observability.room.observations.length >= 2);
    const snapshot = buildControlRoomSnapshot(value.store);
    expect(snapshot.observationPage.records.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(snapshot)).not.toContain(privateValue);
    expect(JSON.stringify(snapshot)).toContain("[credential]");
    expect(JSON.stringify(snapshot)).toContain("[path]");
    await waitUntil(() => sink.frames.some((frame) => frame.includes("event: control.changed")));
    abort.abort();
    await stream;
    expect(sink.frames.join("\n")).not.toMatch(/PRIVATE_PROVIDER_SENTINEL|final provider response|provider\.transcript\.record/u);
    await authority.closeAndDrain();
  }, 30_000);

  it("contains repeated ingestion failures, exposes only bounded status, and always releases capacity", async () => {
    const value = setup();
    const privateFailure = "PRIVATE_OBSERVATION_FAILURE /home/worker/secret.txt";
    let failProjectionReads = false;
    const failingStore = new Proxy(value.store, {
      get(target, property) {
        if (property === "getProjection") {
          return () => {
            if (failProjectionReads) throw new Error(privateFailure);
            return target.getProjection();
          };
        }
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      }
    });
    const authority = createParentTranscriptRuntimeAuthority({
      store: failingStore,
      runDir: value.root,
      actorId: "observation-parent",
      now: () => new Date(NOW)
    });
    expect(authority.status()).toEqual({
      schemaVersion: 1,
      lifecycle: "open",
      health: "ready",
      activeSources: 0,
      failureCount: 0
    });

    const attempts = PARENT_TRANSCRIPT_RUNTIME_MAX_ACTIVE + 8;
    for (let index = 0; index < attempts; index += 1) {
      const transcriptPath = join(value.transcripts, `failure-${index}.log`);
      writeFileSync(transcriptPath, `provider progress ${index}\n`, { mode: 0o600 });
      const handle = authority.open({
        target: {
          taskId: "task-1",
          taskGeneration: 1,
          sessionId: "worker-1",
          sessionGeneration: 1,
          attemptGeneration: 1
        },
        transcriptPath,
        sourceGeneration: index + 1
      });
      failProjectionReads = true;
      handle.progress();
      await expect(handle.finalize({ transcriptDurable: true })).resolves.toBeUndefined();
      failProjectionReads = false;
      expect(authority.status().activeSources).toBe(0);
    }

    const degraded = authority.status();
    expect(degraded).toMatchObject({
      schemaVersion: 1,
      lifecycle: "open",
      health: "degraded",
      activeSources: 0,
      lastFailureCode: "FINALIZE_INGEST_FAILED"
    });
    expect(degraded.failureCount).toBeGreaterThanOrEqual(attempts);
    expect(degraded.failureCount).toBeLessThanOrEqual(attempts * 2);
    expect(JSON.stringify(degraded)).not.toMatch(/PRIVATE_OBSERVATION_FAILURE|secret\.txt|worker/u);
    await expect(authority.closeAndDrain()).resolves.toBeUndefined();
    await expect(authority.closeAndDrain()).resolves.toBeUndefined();
    expect(authority.status()).toMatchObject({ lifecycle: "closed", health: "degraded", activeSources: 0 });
  });
});
