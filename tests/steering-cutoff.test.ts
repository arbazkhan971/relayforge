import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent, sha256Text } from "../src/control/events.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import { prepareAttemptPrompt, SteeringCaptureError } from "../src/steering/capture.js";
import { SteeringRepository } from "../src/steering/repository.js";
import { createParentSteeringService } from "../src/steering/service.js";
import { readVerifiedPromptArtifact } from "../src/steering/prompt-manifest.js";

const NOW = "2026-08-09T12:00:00.000Z";
const roots: string[] = [];

function commandId(index: number): string {
  return `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function event(type: string, eventId: string, expectedVersion: number, payload: Record<string, unknown>, task = true) {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: task ? "task-1" : null,
    taskGeneration: task ? 1 : null,
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

function fixture(): { root: string; store: ControlStore; repository: SteeringRepository; admit: ReturnType<typeof createParentSteeringService>["admit"] } {
  const root = mkdtempSync(join(tmpdir(), "relayforge-steering-capture-"));
  roots.push(root);
  const store = openControlStore({ path: join(root, "control.db"), runId: "run-1", runEpoch: "epoch-1", create: true });
  store.appendBatch([
    event("run.started", "run-started", 0, { startedBy: "parent", goal: "test" }, false),
    event("task.created", "task-created", 0, {
      title: "Task",
      assignee: "dev",
      createdBy: "parent",
      description: "Do it",
      acceptanceCriteria: ["passes"],
      dependsOn: [],
      priority: 1,
      createdAt: NOW
    }),
    event("runtime.observed", "runtime-waiting", 0, {
      sessionId: "session-1",
      sessionGeneration: 1,
      observation: "waiting_input",
      reason: "initial boundary"
    })
  ]);
  const service = createParentSteeringService({
    store,
    authority: { principal: "parent", sourceKind: "control_plane" },
    now: () => new Date(NOW)
  });
  return { root, store, repository: new SteeringRepository(store), admit: service.admit.bind(service) };
}

function request(index: number) {
  return {
    schemaVersion: 1 as const,
    commandId: commandId(index),
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 1,
    sessionId: "session-1",
    sessionGeneration: 1,
    notBeforeAttemptGeneration: 1,
    kind: "steer_next_boundary" as const,
    evidenceRefs: [],
    body: `instruction ${index}`
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P2 atomic prompt cutoff and inclusion", () => {
  it("publishes exact bytes, then atomically commits one manifest followed by ordered inclusions", () => {
    const item = fixture();
    try {
      item.admit(request(1));
      item.admit(request(2));
      const prepared = prepareAttemptPrompt({
        repository: item.repository,
        runDir: item.root,
        attemptId: "attempt-1",
        attemptGeneration: 1,
        taskId: "task-1",
        taskGeneration: 1,
        sessionId: "session-1",
        sessionGeneration: 1,
        basePrompt: "base prompt",
        actorId: "parent",
        now: () => new Date(NOW)
      });
      expect(prepared.manifest.steeringCommandIds).toEqual([commandId(1), commandId(2)]);
      expect(prepared.receipts.map((receipt) => receipt.seq)).toEqual([
        prepared.manifest.captureCutoffSeq + 1,
        prepared.manifest.captureCutoffSeq + 2,
        prepared.manifest.captureCutoffSeq + 3
      ]);
      expect(prepared.content.toString("utf8")).toContain("RelayForge parent steering");
      expect(sha256Text(prepared.content.toString("utf8"))).toBe(prepared.manifest.promptSha256);
      const projection = item.store.getProjection();
      expect(projection.attempts["attempt-1"]).toMatchObject({ state: "prepared", artifactLocator: prepared.manifest.artifactLocator });
      expect(projection.steering[commandId(1)]).toMatchObject({ status: "included", attemptId: "attempt-1" });
      expect(projection.steering[commandId(2)]).toMatchObject({ status: "included", attemptId: "attempt-1" });
    } finally {
      item.store.close();
    }
  });

  it("preserves exact legacy prompt bytes when the steering queue is empty", () => {
    const item = fixture();
    try {
      const base = Buffer.from("legacy bytes\n");
      const prepared = prepareAttemptPrompt({
        repository: item.repository,
        runDir: item.root,
        attemptId: "attempt-empty",
        attemptGeneration: 1,
        taskId: "task-1",
        taskGeneration: 1,
        sessionId: "session-1",
        sessionGeneration: 1,
        basePrompt: base,
        actorId: "parent",
        now: () => new Date(NOW)
      });
      expect(prepared.content).toEqual(base);
      expect(prepared.manifest.steeringCommandIds).toEqual([]);
    } finally {
      item.store.close();
    }
  });

  it("rejects a command admitted after the captured head and removes the unbound artifact", () => {
    const item = fixture();
    try {
      item.admit(request(1));
      const repository = {
        runId: item.repository.runId,
        runEpoch: item.repository.runEpoch,
        snapshot: () => item.repository.snapshot(),
        appendAtHead: (head: number, events: Parameters<SteeringRepository["appendAtHead"]>[1]) => {
          item.admit(request(2));
          return item.repository.appendAtHead(head, events);
        }
      };
      expect(() => prepareAttemptPrompt({
        repository,
        runDir: item.root,
        attemptId: "attempt-race",
        attemptGeneration: 1,
        taskId: "task-1",
        taskGeneration: 1,
        sessionId: "session-1",
        sessionGeneration: 1,
        basePrompt: "base",
        actorId: "parent",
        now: () => new Date(NOW)
      })).toThrowError(expect.objectContaining({ code: "CONCURRENT_UPDATE" }));
      expect(existsSync(join(item.root, "steering", "prompts", "attempt-race.prompt"))).toBe(false);
      expect(item.repository.snapshot().steering.commands[commandId(2)]?.status).toBe("pending");
    } finally {
      item.store.close();
    }
  });

  it("leaves a complete recoverable artifact and canonical manifest at an after-commit crash point", () => {
    const item = fixture();
    const crash = new Error("simulated hard crash");
    try {
      item.admit(request(1));
      expect(() => prepareAttemptPrompt({
        repository: item.repository,
        runDir: item.root,
        attemptId: "attempt-crash",
        attemptGeneration: 1,
        taskId: "task-1",
        taskGeneration: 1,
        sessionId: "session-1",
        sessionGeneration: 1,
        basePrompt: "base",
        actorId: "parent",
        now: () => new Date(NOW),
        fault: (point) => { if (point === "after-canonical-commit") throw crash; }
      })).toThrow(crash);
      const attempt = item.store.getProjection().attempts["attempt-crash"]!;
      expect(attempt.state).toBe("prepared");
      const verified = readVerifiedPromptArtifact(item.root, attempt.artifactLocator!, attempt.promptBytes!, attempt.promptSha256!);
      expect(verified.content.byteLength).toBe(attempt.promptBytes);
    } finally {
      item.store.close();
    }
  });

  it("fails before publication when the complete prompt exceeds the canonical artifact ceiling", () => {
    const item = fixture();
    try {
      expect(() => prepareAttemptPrompt({
        repository: item.repository,
        runDir: item.root,
        attemptId: "attempt-huge",
        attemptGeneration: 1,
        taskId: "task-1",
        taskGeneration: 1,
        sessionId: "session-1",
        sessionGeneration: 1,
        basePrompt: Buffer.alloc(16 * 1024 * 1024 + 1),
        actorId: "parent",
        now: () => new Date(NOW)
      })).toThrowError(expect.objectContaining({ code: "PROMPT_TOO_LARGE" }));
    } finally {
      item.store.close();
    }
  });
});
