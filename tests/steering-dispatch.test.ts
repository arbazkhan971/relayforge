import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent } from "../src/control/events.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import {
  dispatchSteeringSessionId,
  internalSteeringCommandId,
  markDispatchStarted,
  planDispatchLaunch,
  prepareDispatchAttempt,
  settleDispatchAttempt
} from "../src/steering/integration.js";

const NOW = "2026-08-09T12:00:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];

function fixture(): { root: string; store: ControlStore } {
  const root = mkdtempSync(join(tmpdir(), "relayforge-steering-dispatch-"));
  roots.push(root);
  const store = openControlStore({ path: join(root, "control.db"), runId: "run-1", runEpoch: "epoch-1", create: true, now: () => NOW });
  stores.push(store);
  store.appendBatch([
    parseControlEvent({
      schemaVersion: 1, eventId: "run-started", runId: "run-1", runEpoch: "epoch-1",
      taskId: null, taskGeneration: null, expectedVersion: 0, occurredAt: NOW,
      type: "run.started", payload: { startedBy: "parent" }
    }),
    parseControlEvent({
      schemaVersion: 1, eventId: "task-created", runId: "run-1", runEpoch: "epoch-1",
      taskId: "task-1", taskGeneration: 1, expectedVersion: 0, occurredAt: NOW,
      type: "task.created", payload: {
        title: "Task", assignee: "dev", createdBy: "parent", description: "Do it",
        acceptanceCriteria: ["passes"], dependsOn: [], priority: 1, createdAt: NOW
      }
    })
  ]);
  return { root, store };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* test may have closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P2 dispatch boundary integration", () => {
  it("binds exact prompt bytes before a launch plan and process incarnation", () => {
    const item = fixture();
    const prepared = prepareDispatchAttempt({
      store: item.store,
      runDir: item.root,
      taskId: "task-1",
      role: "dev",
      actorId: "parent",
      basePrompt: Buffer.from("exact base prompt\n"),
      now: () => new Date(NOW)
    });
    expect(prepared.content).toEqual(Buffer.from("exact base prompt\n"));
    expect(prepared.target).toMatchObject({ attemptGeneration: 1, sessionGeneration: 1 });
    expect(prepared.target.sessionId).toBe(dispatchSteeringSessionId("dev", "task-1"));

    planDispatchLaunch({ store: item.store, target: prepared.target, launchId: "launch-1", actorId: "parent", now: () => new Date(NOW) });
    expect(item.store.getProjection().attempts[prepared.target.attemptId]).toMatchObject({
      state: "prepared", launchId: "launch-1", launchPlannedSeq: expect.any(Number)
    });

    markDispatchStarted({
      store: item.store,
      target: prepared.target,
      launchId: "launch-1",
      pid: 123,
      processStartToken: "456",
      actorId: "parent",
      now: () => new Date(NOW)
    });
    expect(item.store.getProjection().attempts[prepared.target.attemptId]).toMatchObject({
      state: "active", pid: 123, processStartToken: "456"
    });

    settleDispatchAttempt({
      store: item.store,
      target: prepared.target,
      actorId: "parent",
      result: { outcome: "succeeded", exitCode: 0, summary: "done" },
      now: () => new Date(NOW)
    });
    expect(item.store.getProjection().attempts[prepared.target.attemptId]).toMatchObject({
      state: "exited", outcome: "succeeded", exitCode: 0
    });
  });

  it("opens a later repair boundary only after a newer durable waiting observation", () => {
    const item = fixture();
    const first = prepareDispatchAttempt({ store: item.store, runDir: item.root, taskId: "task-1", role: "dev", actorId: "parent", basePrompt: "first", now: () => new Date(NOW) });
    planDispatchLaunch({ store: item.store, target: first.target, launchId: "launch-1", actorId: "parent", now: () => new Date(NOW) });
    markDispatchStarted({ store: item.store, target: first.target, launchId: "launch-1", pid: 123, processStartToken: "456", actorId: "parent", now: () => new Date(NOW) });
    settleDispatchAttempt({ store: item.store, target: first.target, actorId: "parent", result: { outcome: "failed", exitCode: 1 }, now: () => new Date(NOW) });

    const feedbackBody = "Reviewer rejected the unsafe retry.";
    const feedbackId = internalSteeringCommandId({
      occurredAt: NOW,
      runEpoch: "epoch-1",
      taskId: "task-1",
      taskGeneration: 1,
      sourceKind: "review_gate",
      body: feedbackBody
    });
    const second = prepareDispatchAttempt({
      store: item.store,
      runDir: item.root,
      taskId: "task-1",
      role: "dev",
      actorId: "parent",
      basePrompt: "repair",
      feedback: { commandId: feedbackId, sourceKind: "review_gate", body: feedbackBody, evidenceRefs: ["task-created"] },
      now: () => new Date(NOW)
    });
    expect(second.target.attemptGeneration).toBe(2);
    expect(second.content.toString("utf8")).toContain("repair\n\n## RelayForge parent steering (v1)");
    expect(second.content.toString("utf8")).toContain(feedbackId);
    expect(second.content.toString("utf8")).toContain(feedbackBody);
    expect(item.store.getProjection().steering[feedbackId]).toMatchObject({
      status: "included", attemptId: second.target.attemptId, attemptGeneration: 2
    });
  });

  it("never promotes generic board messages into executable attempt bytes", () => {
    const item = fixture();
    item.store.append(parseControlEvent({
      schemaVersion: 1, eventId: "legacy-message", runId: "run-1", runEpoch: "epoch-1",
      taskId: "task-1", taskGeneration: 1, expectedVersion: 1, occurredAt: NOW,
      type: "message.posted", payload: { messageId: "message-1", from: "parent", to: "dev", body: "DO NOT EXECUTE THIS LEGACY MESSAGE" }
    }));
    const prepared = prepareDispatchAttempt({ store: item.store, runDir: item.root, taskId: "task-1", role: "dev", actorId: "parent", basePrompt: "canonical task", now: () => new Date(NOW) });
    expect(prepared.content.toString("utf8")).toBe("canonical task");
    expect(prepared.content.toString("utf8")).not.toContain("DO NOT EXECUTE");
  });

  it("records a pre-exec refusal as an explicit abandoned attempt", () => {
    const item = fixture();
    const prepared = prepareDispatchAttempt({ store: item.store, runDir: item.root, taskId: "task-1", role: "dev", actorId: "parent", basePrompt: "task", now: () => new Date(NOW) });
    planDispatchLaunch({ store: item.store, target: prepared.target, launchId: "launch-1", actorId: "parent", now: () => new Date(NOW) });
    settleDispatchAttempt({ store: item.store, target: prepared.target, actorId: "parent", result: { outcome: "uncertain", summary: "gate refused" }, now: () => new Date(NOW) });
    expect(item.store.getProjection().attempts[prepared.target.attemptId]).toMatchObject({
      state: "abandoned", abandonReason: "VERIFIED_NEVER_STARTED", summary: "gate refused"
    });
  });
});
