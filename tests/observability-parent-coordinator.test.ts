import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlRoomSnapshot } from "../src/control-room/server-adapter.js";
import { parseControlEvent, type ControlEvent } from "../src/control/events.js";
import { DurableSseBroker, type SseSink } from "../src/control/sse.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import {
  createParentTranscriptObservationCoordinator,
  createProviderTranscriptObservationParser,
  transcriptRelativePath
} from "../src/observability/parent-coordinator.js";
import type { ObservationGenerationV1 } from "../src/observability/types.js";

const NOW = "2026-08-09T12:00:00.000Z";
const EPOCH = "epoch_1234567890123456";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) try { store.close(); } catch { /* restart test */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(type: ControlEvent["type"], id: string, expectedVersion: number, payload: unknown): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1, eventId: id, runId: "run-1", runEpoch: EPOCH,
    taskId: type === "run.started" ? null : "task-1", taskGeneration: type === "run.started" ? null : 1,
    expectedVersion, occurredAt: NOW, actorKind: "control-plane", actorId: "parent",
    sourceKind: null, sourceId: null, sourceGeneration: null, sourceEventId: null, type, payload
  });
}

function seed(store: ControlStore): void {
  store.appendBatch([
    event("run.started", "run-started", 0, { startedBy: "parent", goal: "observe provider output" }),
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
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "relayforge-observation-parent-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const transcripts = join(root, "transcripts");
  mkdirSync(transcripts, { mode: 0o700 });
  const path = join(transcripts, "provider.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  const storePath = join(root, "control.sqlite");
  const store = openControlStore({ path: storePath, runId: "run-1", runEpoch: EPOCH, now: () => NOW });
  stores.push(store);
  seed(store);
  return { root: resolve(root), path: resolve(path), storePath, store };
}

function generation(sourceGeneration = 1): ObservationGenerationV1 {
  return { runId: "run-1", runEpoch: EPOCH, taskId: "task-1", agentId: "worker-1", runtimeGeneration: 1, attemptGeneration: 1, sourceGeneration };
}

function coordinator(value: ReturnType<typeof setup>, sourceGeneration = 1) {
  return createParentTranscriptObservationCoordinator({
    store: value.store,
    transcriptRoot: value.root,
    relativePath: transcriptRelativePath(value.root, value.path),
    generation: generation(sourceGeneration),
    actorId: "observation-parent",
    now: () => new Date(NOW)
  });
}

async function spinUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for live SSE observation");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

class Sink implements SseSink {
  readonly frames: string[] = [];
  write(frame: string): boolean { this.frames.push(frame); return true; }
  async waitForDrain(): Promise<void> { return Promise.resolve(); }
  end(): void { /* no-op */ }
}

describe("parent transcript observation coordinator", () => {
  it("turns live provider output into canonical redacted observations and metadata-only SSE wakes", async () => {
    const value = setup();
    const startHead = value.store.head().headSeq;
    const sink = new Sink();
    const abort = new AbortController();
    const stream = new DurableSseBroker({ limits: { heartbeatMs: 15_000 } }).stream({
      source: value.store, sink, project: "demo", run: "run-1",
      cursor: { runEpoch: EPOCH, after: String(startHead) }, signal: abort.signal
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    const parent = coordinator(value);
    appendFileSync(value.path, '{"message":"token=PRIVATE_SENTINEL /home/worker/private.log","activity":"blocked","success":true}\n');
    const progress = await parent.pollProgress();
    expect(progress).toMatchObject({ committed: true, observations: [{ category: "provider", details: { kind: "progress", operationCode: "provider.output" } }] });
    expect(value.store.getProjection().tasks["task-1"]).toMatchObject({ status: "in-progress" });
    expect(value.store.getProjection().attempts["attempt-1"]).toMatchObject({ state: "active" });
    const canonical = value.store.getProjection().observability.room.observations[0]!;
    expect(canonical.summary?.text).toContain("[credential]");
    expect(canonical.summary?.text).toContain("[path]");
    expect(JSON.stringify(canonical)).not.toContain("PRIVATE_SENTINEL");
    expect(buildControlRoomSnapshot(value.store).observationPage.records).toHaveLength(1);
    await spinUntil(() => sink.frames.some((frame) => frame.includes(`id: ${progress.headSeq}`)));
    abort.abort();
    await stream;
    const frames = sink.frames.join("");
    expect(frames).toContain("event: control.changed");
    expect(frames).not.toMatch(/PRIVATE_SENTINEL|provider\.output|summary/iu);
    parent.close();
  });

  it("loads the durable cursor after store restart and advances the same pinned source exactly once", async () => {
    const value = setup();
    appendFileSync(value.path, "first\n");
    const first = coordinator(value);
    await first.pollProgress();
    const firstSource = first.sourceId;
    const firstHead = value.store.head().headSeq;
    first.close();
    value.store.close();
    stores.splice(stores.indexOf(value.store), 1);
    const reopened = openControlStore({ path: value.storePath, runId: "run-1", runEpoch: EPOCH, create: false, now: () => NOW });
    stores.push(reopened);
    const restartedValue = { ...value, store: reopened };
    appendFileSync(value.path, "second\n");
    const restarted = coordinator(restartedValue);
    expect(restarted.sourceId).toBe(firstSource);
    const progress = await restarted.pollProgress();
    expect(progress.observations).toHaveLength(1);
    expect(progress.observations[0]!.summary?.text).toBe("second");
    expect(reopened.head().headSeq).toBe(firstHead + 2);
    expect(reopened.getProjection().observability.room.observations.map((record) => record.summary?.text)).toEqual(["first", "second"]);
    restarted.close();
  });

  it("drains an unterminated terminal record only after bounded quiescence", async () => {
    const value = setup();
    const parent = coordinator(value);
    appendFileSync(value.path, "final response without newline");
    const live = await parent.pollProgress();
    expect(live.observations).toEqual([]);
    const final = await parent.finalize();
    expect(final.observationCount).toBe(1);
    expect(final.state.cursor).toBe(Buffer.byteLength("final response without newline"));
    expect(value.store.getProjection().observability.room.observations[0]).toMatchObject({ sourceIntegrity: "quiescent_final" });
    parent.close();
  });

  it("fails closed on truncation and separates a rotated pathname behind a new source generation", async () => {
    const truncated = setup();
    appendFileSync(truncated.path, "first\n");
    const first = coordinator(truncated);
    await first.pollProgress();
    truncateSync(truncated.path, 0);
    await expect(first.pollProgress()).rejects.toMatchObject({ code: "SOURCE_MUTATED" });
    first.close();

    const rotated = setup();
    appendFileSync(rotated.path, "old generation\n");
    const old = coordinator(rotated);
    renameSync(rotated.path, `${rotated.path}.old`);
    writeFileSync(rotated.path, "new generation\n", { mode: 0o600 });
    await expect(old.pollProgress()).rejects.toMatchObject({ code: "SOURCE_REPLACED" });
    const drained = await old.finalize({ allowPinnedReplacement: true });
    expect(drained.sourcePathState).toBe("replaced");
    expect(rotated.store.getProjection().observability.room.observations.at(-1)).toMatchObject({ sourceIntegrity: "replaced" });
    old.close();
    expect(() => coordinator(rotated, 1)).toThrowError(expect.objectContaining({ code: "STALE_GENERATION" }));
    const next = coordinator(rotated, 2);
    await next.pollProgress();
    expect(rotated.store.getProjection().observability.room.observations.at(-1)?.summary?.text).toBe("new generation");
    next.close();
  });

  it("exposes only the non-semantic provider progress parser contract", () => {
    const parser = createProviderTranscriptObservationParser(NOW);
    const parsed = parser.parse(Buffer.from('{"status":"done","activity":"exited"}'), { sourceId: "a".repeat(64), sourceGeneration: 1, recordOrdinal: 1 });
    expect(parsed).toMatchObject({ category: "provider", phase: "executing", code: "provider.transcript.record", details: { kind: "progress" } });
    expect(JSON.stringify(parsed)).not.toMatch(/"kind":"lifecycle"|"activity":"exited"/u);
  });
});
