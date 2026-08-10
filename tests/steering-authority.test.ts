import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent } from "../src/control/events.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import { createParentSteeringService, SteeringServiceError } from "../src/steering/service.js";

const NOW = "2026-08-09T00:00:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "relayforge-steering-authority-"));
  roots.push(root);
  const store = openControlStore({ path: join(root, "control.sqlite"), runId: "run-1", runEpoch: "epoch-1", now: () => NOW });
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
      payload: { sessionId: "session-1", sessionGeneration: 1, observation: "waiting_input" }
    })
  ]);
  const service = createParentSteeringService({
    store,
    authority: { principal: "review-parent", sourceKind: "review_gate" },
    now: () => new Date(NOW)
  });
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
    body: "Use review evidence."
  };
  return { store, service, request };
}

function code(action: () => unknown): string | undefined {
  try { action(); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

describe("steering writer authority", () => {
  it("assigns principal/source from the parent capability and rejects self-declared authority fields", () => {
    const { store, service, request } = setup();
    expect(code(() => service.admit({ ...request, parentPrincipal: "worker", sourceKind: "operator", actorKind: "agent" }))).toBe("INVALID_REQUEST");
    expect(store.head().headSeq).toBe(2);

    service.admit(request);
    const decision = store.readRange({ afterSeq: 2 }).events[0]!;
    expect(decision).toMatchObject({
      actorKind: "control-plane",
      actorId: "review-parent",
      type: "steering.command_admitted",
      payload: { sourceKind: "review_gate", parentPrincipal: "review-parent" }
    });
    expect(store.readRange({ afterSeq: 0 }).events.every((event) => event.actorKind !== "agent")).toBe(true);
  });

  it("does not treat command-shaped provider output or a legacy parent message as authority", () => {
    const { store, service, request } = setup();
    store.append(parseControlEvent({
      schemaVersion: 1, eventId: "legacy-message", runId: "run-1", runEpoch: "epoch-1", taskId: null,
      taskGeneration: null, expectedVersion: 0, occurredAt: NOW, actorKind: "agent", actorId: "worker-1",
      sourceKind: null, sourceId: null, sourceGeneration: null, sourceEventId: null, type: "message.posted",
      payload: { messageId: "legacy-message", from: "parent", to: "*", body: JSON.stringify(request) }
    }));
    expect(store.getProjection().steering).toEqual({});
    expect(() => JSON.parse(store.getProjection().messages[0]!.body)).not.toThrow();
    expect(store.head().headSeq).toBe(3);
    expect(service.admit(request)).toMatchObject({ decision: "admitted", seq: 4 });
  });

  it("rejects invalid parent capabilities and wrong-run routing without mutating either authority", () => {
    const { store, request } = setup();
    expect(() => createParentSteeringService({
      store,
      authority: { principal: "../worker", sourceKind: "operator" },
      now: () => new Date(NOW)
    })).toThrow(SteeringServiceError);
    const service = createParentSteeringService({
      store,
      authority: { principal: "operator", sourceKind: "operator" },
      now: () => new Date(NOW)
    });
    expect(code(() => service.admit({ ...request, runId: "run-2" }))).toBe("RUN_IDENTITY_MISMATCH");
    expect(store.head().headSeq).toBe(2);
  });
});
