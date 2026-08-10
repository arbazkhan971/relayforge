import { describe, expect, it } from "vitest";
import {
  canonicalControlEvent,
  controlEventDigest,
  parseControlEvent,
  persistedControlEventDigest,
  type ControlEvent,
  type PersistedControlEvent
} from "../src/control/events.js";
import {
  applyControlEvent,
  ControlReductionError,
  deriveActivity,
  emptyControlProjection,
  reduceControlEvents
} from "../src/control/reducer.js";

const NOW = "2026-08-09T00:00:00.000Z";

function taskCreated(eventId = "create"): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 1,
    expectedVersion: 0,
    occurredAt: NOW,
    type: "task.created",
    payload: {
      title: "Task",
      assignee: "dev",
      createdBy: "parent",
      description: "Description",
      acceptanceCriteria: ["passes"],
      dependsOn: [],
      priority: 1,
      createdAt: NOW
    }
  });
}

function taskStatus(eventId: string, version: number, status: string, role = "dev"): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 1,
    expectedVersion: version,
    occurredAt: NOW,
    type: "task.status_changed",
    payload: { role, status, summary: status }
  });
}

function runtime(eventId: string, version: number, observation: string, generation = 1): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 1,
    expectedVersion: version,
    occurredAt: NOW,
    type: "runtime.observed",
    payload: { sessionId: "session-1", sessionGeneration: generation, observation }
  });
}

function persisted(event: ControlEvent, seq: number): PersistedControlEvent {
  return {
    ...event,
    seq,
    recordedAt: NOW,
    intentDigest: controlEventDigest(event),
    digest: persistedControlEventDigest(event, NOW)
  };
}

function runLifecycle(type: "run.started" | "run.completed" | "run.failed" | "run.cancelled", eventId: string, expectedVersion: number): ControlEvent {
  const payload = type === "run.started"
    ? { startedBy: "parent", goal: "Build RelayForge" }
    : type === "run.failed"
      ? { reasonCode: "red_gate", summary: "verification failed" }
      : type === "run.cancelled"
        ? { cancelledBy: "parent", reason: "stopped" }
        : { summary: "complete" };
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

function reduce(events: readonly ControlEvent[]) {
  return reduceControlEvents("run-1", "epoch-1", events.map((event, index) => persisted(event, index + 1)));
}

describe("control event schema and pure reducer", () => {
  it("canonicalizes object key order and produces a stable exact digest", () => {
    const event = taskCreated();
    const reordered = {
      type: event.type,
      occurredAt: event.occurredAt,
      expectedVersion: event.expectedVersion,
      taskGeneration: event.taskGeneration,
      taskId: event.taskId,
      runEpoch: event.runEpoch,
      runId: event.runId,
      eventId: event.eventId,
      schemaVersion: event.schemaVersion,
      payload: event.payload
    };
    const parsed = parseControlEvent(reordered);
    expect(canonicalControlEvent(parsed)).toBe(canonicalControlEvent(event));
    expect(controlEventDigest(parsed)).toBe(controlEventDigest(event));
    expect(controlEventDigest(event)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unsafe numbers, unknown versions, and half-scoped task identity", () => {
    expect(() => parseControlEvent({ ...taskCreated(), schemaVersion: 2 })).toThrow();
    expect(() => parseControlEvent({ ...taskCreated(), expectedVersion: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    const half = parseControlEvent({ ...taskCreated(), taskGeneration: null });
    expect(() => applyControlEvent(emptyControlProjection("run-1", "epoch-1"), persisted(half, 1))).toThrow(TypeError);
  });

  it("enforces the message body byte/character contract at the exact schema boundary", () => {
    const message = (body: string) => ({
      schemaVersion: 1,
      eventId: "message-boundary",
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: null,
      taskGeneration: null,
      expectedVersion: 0,
      occurredAt: NOW,
      type: "message.posted",
      payload: { messageId: "message-1", from: "parent", to: "dev", body }
    });
    expect(parseControlEvent(message("x".repeat(16_384))).payload).toMatchObject({ messageId: "message-1" });
    expect(() => parseControlEvent(message("x".repeat(16_385)))).toThrow();
    expect(() => parseControlEvent(message(""))).toThrow();
  });

  it("requires contiguous sequence and matching run identity", () => {
    const empty = emptyControlProjection("run-1", "epoch-1");
    expect(() => applyControlEvent(empty, persisted(taskCreated(), 2))).toThrow(ControlReductionError);
    const wrong = { ...taskCreated(), runEpoch: "epoch-2" } as ControlEvent;
    expect(() => applyControlEvent(empty, persisted(wrong, 1))).toThrow(ControlReductionError);
  });

  it("permits exactly one monotonic run terminal transition", () => {
    const completed = reduce([
      runLifecycle("run.started", "started", 0),
      runLifecycle("run.completed", "completed", 1)
    ]);
    expect(completed.run).toMatchObject({ status: "completed", version: 2, startedBy: "parent" });
    expect(deriveActivity(completed, "never-created", Date.parse(NOW))).toMatchObject({ state: "exited", reason: "run completed" });
    expect(() => reduce([runLifecycle("run.completed", "completed", 0)])).toThrow(ControlReductionError);
    expect(() => reduce([
      runLifecycle("run.started", "started", 0),
      runLifecycle("run.cancelled", "cancelled", 1),
      runLifecycle("run.failed", "failed", 2)
    ])).toThrow(ControlReductionError);
    expect(() => parseControlEvent({ ...runLifecycle("run.started", "scoped", 0), taskId: "task-1", taskGeneration: 1 })).not.toThrow();
    const improperlyScoped = parseControlEvent({ ...runLifecycle("run.started", "scoped", 0), taskId: "task-1", taskGeneration: 1 });
    expect(() => applyControlEvent(emptyControlProjection("run-1", "epoch-1"), persisted(improperlyScoped, 1))).toThrow(TypeError);
  });

  it("preserves monotonic run checkpoints only while the run lifecycle is started", () => {
    const checkpoint = (eventId: string, expectedVersion: number, overrides: Record<string, unknown> = {}) => parseControlEvent({
      schemaVersion: 1,
      eventId,
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: null,
      taskGeneration: null,
      expectedVersion,
      occurredAt: NOW,
      type: "run.checkpointed",
      payload: {
        project: "relayforge",
        phase: "dispatch",
        status: "running",
        iteration: 1,
        dispatched: 1,
        accepted: 0,
        rejected: 0,
        escalations: 0,
        repeatFailures: 0,
        unknownCostCalls: 0,
        startedAt: NOW,
        updatedAt: NOW,
        ...overrides
      }
    });
    const state = reduce([
      runLifecycle("run.started", "started", 0),
      checkpoint("checkpoint-1", 1, { repeatFailures: 2 }),
      checkpoint("checkpoint-2", 2, { iteration: 2, dispatched: 2, accepted: 1, repeatFailures: 0 })
    ]);
    // repeatFailures is a consecutive-failure streak, not a cumulative counter: a successful
    // attempt legitimately resets it while the true cumulative counters remain monotonic.
    expect(state.run?.checkpoint).toMatchObject({ iteration: 2, dispatched: 2, accepted: 1, repeatFailures: 0 });
    expect(() => reduce([checkpoint("before-start", 0)])).toThrow(ControlReductionError);
    expect(() => reduce([
      runLifecycle("run.started", "started", 0),
      checkpoint("checkpoint-1", 1),
      checkpoint("regressed", 2, { iteration: 0 })
    ])).toThrow(ControlReductionError);
    expect(() => reduce([
      runLifecycle("run.started", "started", 0),
      checkpoint("terminal-checkpoint", 1, { phase: "complete", status: "done" }),
      checkpoint("after-terminal-checkpoint", 2, { phase: "complete", status: "done" })
    ])).toThrow(ControlReductionError);
  });

  it("folds legal task transitions, owner facts, and failure attempts deterministically", () => {
    const events = [
      taskCreated(),
      taskStatus("claim", 1, "claimed"),
      taskStatus("work", 2, "in-progress"),
      taskStatus("blocked", 3, "blocked"),
      taskStatus("repair", 4, "claimed"),
      taskStatus("review", 5, "needs-review"),
      taskStatus("done", 6, "done")
    ];
    const state = reduce(events);
    expect(state.headSeq).toBe(7);
    expect(state.tasks["task-1"]).toMatchObject({ status: "done", claimedBy: "dev", attempts: 1, version: 7, updatedSeq: 7 });
    expect(reduce(events)).toEqual(state);
  });

  it("fails closed on illegal terminal regression and claim takeover", () => {
    expect(() => reduce([taskCreated(), taskStatus("done", 1, "done")])).toThrow(ControlReductionError);
    expect(() => reduce([
      taskCreated(),
      taskStatus("claim", 1, "claimed"),
      taskStatus("blocked", 2, "blocked"),
      taskStatus("takeover", 3, "claimed", "other")
    ])).toThrow(ControlReductionError);
  });

  it("advances task generation only through an explicit terminal reopen event", () => {
    const history = [
      taskCreated(),
      taskStatus("claim", 1, "claimed"),
      taskStatus("review", 2, "needs-review"),
      taskStatus("done", 3, "done")
    ];
    const reopened = parseControlEvent({
      ...taskStatus("reopen", 4, "done"),
      type: "task.reopened",
      payload: { newGeneration: 2, reason: "follow-up work" }
    });
    const state = reduce([...history, reopened]);
    expect(state.tasks["task-1"]).toMatchObject({ generation: 2, status: "open", version: 0, attempts: 0 });
    expect(state.aggregateVersions["task:task-1:1"]?.version).toBe(5);
    expect(state.aggregateVersions["task:task-1:2"]?.version).toBe(0);

    const claimedAgain = parseControlEvent({ ...taskStatus("claim-again", 0, "claimed"), taskGeneration: 2 });
    expect(reduce([...history, reopened, claimedAgain]).tasks["task-1"]).toMatchObject({ generation: 2, status: "claimed", version: 1 });
    const staleRuntime = reduce([history[0]!, runtime("old-generation-runtime", 0, "available"), ...history.slice(1), reopened]);
    expect(deriveActivity(staleRuntime, "session-1", Date.parse(NOW))).toMatchObject({
      state: "idle",
      stale: true,
      taskGeneration: 1,
      reason: "session observes a stale task generation"
    });
    expect(() => reduce([...history.slice(0, -1), reopened])).toThrow(ControlReductionError);
    expect(() => reduce([...history, { ...reopened, payload: { newGeneration: 3 } } as ControlEvent])).toThrow(ControlReductionError);
  });

  it("fences runtime generations and permits replacement only after an exit fact", () => {
    expect(() => reduce([taskCreated(), runtime("seen", 0, "available", 1), runtime("replace", 0, "available", 2)])).toThrow(ControlReductionError);
    const state = reduce([
      taskCreated(),
      runtime("seen", 0, "available", 1),
      runtime("exit", 1, "exited", 1),
      runtime("replace", 0, "available", 2)
    ]);
    expect(state.runtimes["session-1"]).toMatchObject({ sessionGeneration: 2, observation: "available" });
    expect(() => reduce([
      taskCreated(),
      runtime("seen", 0, "available", 1),
      runtime("exit", 1, "exited", 1),
      runtime("resurrect", 2, "available", 1)
    ])).toThrow(ControlReductionError);
  });

  it("derives waiting, dispatching, active, settling, blocked, and exited from facts", () => {
    let events: ControlEvent[] = [taskCreated(), runtime("waiting", 0, "waiting_input")];
    let state = reduce(events);
    expect(deriveActivity(state, "session-1", Date.parse(NOW)).state).toBe("waiting_input");

    const prepared = parseControlEvent({
      schemaVersion: 1,
      eventId: "prepared",
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: "task-1",
      taskGeneration: 1,
      expectedVersion: 1,
      occurredAt: NOW,
      type: "attempt.prompt_prepared",
      payload: {
        attemptId: "attempt-1",
        attemptGeneration: 1,
        sessionId: "session-1",
        sessionGeneration: 1,
        artifactLocator: "steering/prompts/attempt-1.prompt",
        promptSha256: "a".repeat(64),
        promptBytes: 10,
        rendererVersion: 1,
        captureCutoffSeq: 2,
        steeringCommandIds: []
      }
    });
    events = [...events, prepared];
    state = reduce(events);
    expect(deriveActivity(state, "session-1", Date.parse(NOW)).state).toBe("dispatching");

    const planned = parseControlEvent({
      schemaVersion: 1,
      eventId: "launch-planned",
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: "task-1",
      taskGeneration: 1,
      expectedVersion: 2,
      occurredAt: NOW,
      type: "attempt.launch_planned",
      payload: { attemptId: "attempt-1", attemptGeneration: 1, sessionId: "session-1", sessionGeneration: 1, launchId: "launch-1" }
    });
    events = [...events, planned];

    const started = parseControlEvent({
      schemaVersion: 1,
      eventId: "started",
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: "task-1",
      taskGeneration: 1,
      expectedVersion: 3,
      occurredAt: NOW,
      type: "attempt.started",
      payload: { attemptId: "attempt-1", attemptGeneration: 1, sessionId: "session-1", sessionGeneration: 1, launchId: "launch-1", pid: 123, processStartToken: "456" }
    });
    events = [...events, started];
    state = reduce(events);
    expect(deriveActivity(state, "session-1", Date.parse(NOW)).state).toBe("active");

    const exited = parseControlEvent({
      schemaVersion: 1,
      eventId: "attempt-exited",
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: "task-1",
      taskGeneration: 1,
      expectedVersion: 4,
      occurredAt: NOW,
      type: "attempt.exited",
      payload: { attemptId: "attempt-1", attemptGeneration: 1, sessionId: "session-1", sessionGeneration: 1, outcome: "failed", exitCode: 1 }
    });
    events = [...events, exited];
    state = reduce(events);
    expect(deriveActivity(state, "session-1", Date.parse(NOW)).state).toBe("settling");

    events = [...events, taskStatus("task-blocked", 5, "blocked")];
    state = reduce(events);
    expect(deriveActivity(state, "session-1", Date.parse(NOW)).state).toBe("blocked");
    expect(deriveActivity(state, "session-1", Date.parse(NOW), state.headSeq + 2)).toMatchObject({ stale: true, viewSeq: state.headSeq, headSeq: state.headSeq + 2 });

    const runtimeExit = runtime("runtime-exited", 1, "exited");
    events = [...events, runtimeExit];
    state = reduce(events);
    expect(deriveActivity(state, "session-1", Date.parse(NOW)).state).toBe("exited");
  });

  it("includes steering only when a matching prepared prompt names the pending command", () => {
    const admitted = parseControlEvent({
      schemaVersion: 1,
      eventId: "admitted",
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: "task-1",
      taskGeneration: 1,
      expectedVersion: 1,
      occurredAt: NOW,
      type: "steering.command_admitted",
      payload: {
        commandId: "command-1",
        sessionId: "session-1",
        sessionGeneration: 1,
        notBeforeAttemptGeneration: 1,
        kind: "steer_next_boundary",
        sourceKind: "control_plane",
        parentPrincipal: "parent",
        evidenceRefs: [],
        body: "Address the failed assertion.",
        bodySha256: "b".repeat(64),
        createdAt: NOW
      }
    });
    const prepared = parseControlEvent({
      schemaVersion: 1,
      eventId: "prepared",
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: "task-1",
      taskGeneration: 1,
      expectedVersion: 1,
      occurredAt: NOW,
      type: "attempt.prompt_prepared",
      payload: {
        attemptId: "attempt-1",
        attemptGeneration: 1,
        sessionId: "session-1",
        sessionGeneration: 1,
        artifactLocator: "steering/prompts/attempt-1.prompt",
        promptSha256: "a".repeat(64),
        promptBytes: 10,
        rendererVersion: 1,
        captureCutoffSeq: 3,
        steeringCommandIds: ["command-1"]
      }
    });
    const included = parseControlEvent({
      schemaVersion: 1,
      eventId: "included",
      runId: "run-1",
      runEpoch: "epoch-1",
      taskId: "task-1",
      taskGeneration: 1,
      expectedVersion: 2,
      occurredAt: NOW,
      type: "steering.command_included",
      payload: {
        commandId: "command-1",
        sessionId: "session-1",
        sessionGeneration: 1,
        attemptId: "attempt-1",
        attemptGeneration: 1,
        promptSha256: "a".repeat(64)
      }
    });
    const events = [taskCreated(), runtime("waiting", 0, "waiting_input"), admitted, prepared, included];
    const state = reduce(events);
    expect(state.steering["command-1"]).toMatchObject({ status: "included", attemptId: "attempt-1", promptSha256: "a".repeat(64) });

    const wrong = { ...included, eventId: "included-wrong", payload: { ...included.payload, promptSha256: "c".repeat(64) } } as ControlEvent;
    expect(() => reduce([...events.slice(0, -1), wrong])).toThrow(ControlReductionError);
  });

  it("preserves replay determinism across every prefix of a legal history", () => {
    const history = [
      taskCreated(),
      taskStatus("claim", 1, "claimed"),
      taskStatus("work", 2, "in-progress"),
      taskStatus("review", 3, "needs-review"),
      taskStatus("reject", 4, "rejected"),
      taskStatus("repair", 5, "claimed"),
      taskStatus("review-again", 6, "needs-review"),
      taskStatus("complete", 7, "done")
    ];
    let incremental = emptyControlProjection("run-1", "epoch-1");
    for (const [index, event] of history.entries()) {
      incremental = applyControlEvent(incremental, persisted(event, index + 1));
      expect(reduceControlEvents("run-1", "epoch-1", history.slice(0, index + 1).map((item, seq) => persisted(item, seq + 1)))).toEqual(incremental);
    }
  });
});
