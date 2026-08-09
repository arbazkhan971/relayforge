import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent, type ControlEvent } from "../src/control/events.js";
import { ControlStore, ControlStoreError, openControlStore, type ControlStoreFaultPoint } from "../src/control/store.js";
import { SteeringRepository } from "../src/steering/repository.js";
import {
  createParentSteeringService,
  SteeringServiceError,
  type ParentSteeringService,
  type SteeringAdmissionRequest
} from "../src/steering/service.js";

const NOW = "2026-08-09T00:00:00.000Z";
const LATER = "2026-08-09T00:02:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* intentional replacement/fault tests may already close */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function commandId(index: number): string {
  return `01890f9d-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function event(type: string, eventId: string, options: {
  taskId?: string | null;
  taskGeneration?: number | null;
  expectedVersion: number;
  payload: unknown;
  occurredAt?: string;
}): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: options.taskId === undefined ? "task-1" : options.taskId,
    taskGeneration: options.taskGeneration === undefined ? 1 : options.taskGeneration,
    expectedVersion: options.expectedVersion,
    occurredAt: options.occurredAt ?? NOW,
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

function seedEvents(observation: "available" | "waiting_input" | "blocked" | "exited" | "probe_failed" = "waiting_input"): ControlEvent[] {
  return [
    event("run.started", "run-started", {
      taskId: null,
      taskGeneration: null,
      expectedVersion: 0,
      payload: { startedBy: "parent", goal: "P2" }
    }),
    event("task.created", "task-created", {
      expectedVersion: 0,
      payload: {
        title: "Durable steering",
        assignee: "dev",
        createdBy: "parent",
        description: "Implement steering.",
        acceptanceCriteria: ["durable"],
        dependsOn: [],
        priority: 1,
        createdAt: NOW
      }
    }),
    event("task.status_changed", "task-claimed", {
      expectedVersion: 1,
      payload: { role: "dev", status: "claimed", summary: "claimed" }
    }),
    event("task.status_changed", "task-active", {
      expectedVersion: 2,
      payload: { role: "dev", status: "in-progress", summary: "active" }
    }),
    event("runtime.observed", "runtime-observed", {
      expectedVersion: 0,
      payload: { sessionId: "session-1", sessionGeneration: 1, observation }
    })
  ];
}

function setup(options: {
  observation?: "available" | "waiting_input" | "blocked" | "exited" | "probe_failed";
  fault?: (point: ControlStoreFaultPoint, event?: ControlEvent) => void;
  now?: string;
} = {}): { root: string; path: string; store: ControlStore; service: ParentSteeringService } {
  const root = mkdtempSync(join(tmpdir(), "relayforge-steering-service-"));
  roots.push(root);
  const path = join(root, "control.sqlite");
  const store = openControlStore({
    path,
    runId: "run-1",
    runEpoch: "epoch-1",
    now: () => NOW,
    fault: options.fault
  });
  stores.push(store);
  store.appendBatch(seedEvents(options.observation));
  const service = createParentSteeringService({
    store,
    authority: { principal: "operator-1", sourceKind: "operator" },
    now: () => new Date(options.now ?? NOW)
  });
  return { root, path, store, service };
}

function request(index: number, overrides: Partial<SteeringAdmissionRequest> = {}): SteeringAdmissionRequest {
  return {
    schemaVersion: 1,
    commandId: commandId(index),
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 1,
    sessionId: "session-1",
    sessionGeneration: 1,
    notBeforeAttemptGeneration: 1,
    kind: "steer_next_boundary",
    evidenceRefs: ["task-created"],
    body: `instruction ${index}`,
    ...overrides
  };
}

function expectServiceCode(action: () => unknown, code: SteeringServiceError["code"]): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SteeringServiceError);
    expect((error as SteeringServiceError).code).toBe(code);
  }
}

describe("parent steering admission service", () => {
  it("durably admits normalized parent intent and returns the original result across restart", () => {
    const { path, store, service } = setup();
    const first = service.admit(request(1, { body: "first\r\nsecond  " }));
    expect(first).toMatchObject({
      decision: "admitted",
      commandId: commandId(1),
      seq: 6,
      command: {
        body: "first\nsecond  ",
        sourceKind: "operator",
        parentPrincipal: "operator-1"
      }
    });
    expect(store.getProjection().steering[commandId(1)]).toMatchObject({ status: "pending", admittedSeq: 6 });
    const canonical = store.readRange({ afterSeq: 5 }).events[0]!;
    expect(canonical).toMatchObject({
      type: "steering.command_admitted",
      actorKind: "operator",
      actorId: "operator-1",
      sourceKind: "steering-request",
      sourceId: commandId(1)
    });

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false, now: () => NOW });
    stores.push(reopened);
    const afterRestart = createParentSteeringService({
      store: reopened,
      authority: { principal: "operator-1", sourceKind: "operator" },
      now: () => new Date(LATER)
    }).admit(request(1, { body: "first\nsecond  " }));
    expect(afterRestart).toEqual(first);
    expect(reopened.head().headSeq).toBe(6);
    expect(new SteeringRepository(reopened).snapshot().steering.commands[commandId(1)]).toMatchObject({ status: "pending" });
  });

  it("conflicts every divergent immutable field while leaving the original unchanged", () => {
    const { store, service } = setup();
    const original = request(1);
    service.admit(original);
    const variants: unknown[] = [
      { ...original, body: "changed" },
      { ...original, taskGeneration: 2 },
      { ...original, sessionGeneration: 2 },
      { ...original, evidenceRefs: [] },
      { ...original, notBeforeAttemptGeneration: 2 },
      { ...original, expiresAt: "2026-08-09T00:10:00.000Z" }
    ];
    for (const variant of variants) expectServiceCode(() => service.admit(variant), "COMMAND_ID_CONFLICT");
    expect(store.head().headSeq).toBe(6);
    expect(store.getProjection().steering[commandId(1)]?.body).toBe("instruction 1");
  });

  it.each([
    ["blocked", "SESSION_BLOCKED", "blocked"],
    ["exited", "SESSION_EXITED", "exited"],
    ["probe_failed", "STALE_GENERATION", "indeterminate"]
  ] as const)("durably refuses %s activity as %s", (observation, reasonCode, observedActivity) => {
    const { store, service } = setup({ observation });
    const result = service.admit(request(1));
    expect(result).toMatchObject({
      decision: "refused",
      seq: 6,
      refusal: {
        reasonCode,
        observedSeq: 5,
        observedActivity,
        requestSemanticDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
    expect(store.getProjection().steering[commandId(1)]).toMatchObject({
      status: "refused",
      reasonCode,
      observedSeq: 5,
      observedActivity,
      terminalSeq: 6
    });
  });

  it.each(["idle", "waiting_input", "dispatching", "active", "settling"] as const)(
    "admits at a proven %s state without mutating an already-prepared/live attempt",
    (state) => {
      const { store, service } = setup({ observation: state === "waiting_input" ? "waiting_input" : "available" });
      if (state === "dispatching" || state === "active" || state === "settling") {
        store.append(event("attempt.prompt_prepared", `attempt-prepared-${state}`, {
          expectedVersion: 3,
          payload: {
            attemptId: "attempt-1",
            attemptGeneration: 1,
            sessionId: "session-1",
            sessionGeneration: 1,
            artifactLocator: "steering/prompts/attempt-1.prompt",
            promptSha256: "a".repeat(64),
            promptBytes: 12,
            rendererVersion: 1,
            captureCutoffSeq: 5,
            steeringCommandIds: []
          }
        }));
      }
      if (state === "active" || state === "settling") {
        store.append(event("attempt.launch_planned", `attempt-launch-planned-${state}`, {
          expectedVersion: 4,
          payload: {
            attemptId: "attempt-1",
            attemptGeneration: 1,
            sessionId: "session-1",
            sessionGeneration: 1,
            launchId: "launch-1"
          }
        }));
        store.append(event("attempt.started", `attempt-started-${state}`, {
          expectedVersion: 5,
          payload: {
            attemptId: "attempt-1",
            attemptGeneration: 1,
            sessionId: "session-1",
            sessionGeneration: 1,
            launchId: "launch-1",
            pid: 123,
            processStartToken: "456"
          }
        }));
      }
      if (state === "settling") {
        store.append(event("attempt.exited", "attempt-exited-settling", {
          expectedVersion: 6,
          payload: {
            attemptId: "attempt-1",
            attemptGeneration: 1,
            sessionId: "session-1",
            sessionGeneration: 1,
            outcome: "failed",
            exitCode: 1
          }
        }));
      }
      const result = service.admit(request(1));
      expect(result).toMatchObject({ decision: "admitted", command: { notBeforeAttemptGeneration: 1 } });
      expect(store.getProjection().attempts["attempt-1"]?.steeringCommandIds ?? []).toEqual([]);
    }
  );

  it("durably refuses stale/missing/mismatched/terminal targets and missing evidence", () => {
    const cases: Array<[Partial<SteeringAdmissionRequest>, string, string]> = [
      [{ taskId: "missing-task" }, "TARGET_MISMATCH", "indeterminate"],
      [{ taskGeneration: 2 }, "STALE_GENERATION", "indeterminate"],
      [{ sessionId: "missing-session" }, "TARGET_MISMATCH", "indeterminate"],
      [{ sessionGeneration: 2 }, "STALE_GENERATION", "indeterminate"],
      [{ evidenceRefs: ["missing-evidence"] }, "INVALID_REQUEST", "waiting_input"]
    ];
    for (const [overrides, reason, observedActivity] of cases) {
      const { service } = setup();
      expect(service.admit(request(1, overrides))).toMatchObject({
        decision: "refused",
        refusal: { reasonCode: reason, observedActivity }
      });
    }

    const { store, service } = setup();
    store.append(event("task.status_changed", "task-review", {
      expectedVersion: 3,
      payload: { role: "dev", status: "needs-review", summary: "ready" }
    }));
    store.append(event("task.status_changed", "task-done", {
      expectedVersion: 4,
      payload: { role: "dev", status: "done", summary: "done" }
    }));
    expect(service.admit(request(2))).toMatchObject({ decision: "refused", refusal: { reasonCode: "TASK_TERMINAL" } });
  });

  it("returns the original refused decision after restart/state change and conflicts every divergent refused retry", () => {
    const { path, store, service } = setup({ observation: "blocked" });
    const original = service.admit(request(1));
    expect(original).toMatchObject({ decision: "refused", refusal: { reasonCode: "SESSION_BLOCKED" } });
    store.append(event("runtime.observed", "runtime-unblocked", {
      expectedVersion: 2,
      payload: { sessionId: "session-1", sessionGeneration: 1, observation: "waiting_input" },
      occurredAt: LATER
    }));
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false, now: () => NOW });
    stores.push(reopened);
    const retryService = createParentSteeringService({
      store: reopened,
      authority: { principal: "operator-1", sourceKind: "operator" },
      now: () => new Date(LATER)
    });
    expect(retryService.admit(request(1))).toEqual(original);
    for (const divergent of [
      request(1, { body: "different" }),
      request(1, { taskGeneration: 2 }),
      request(1, { sessionGeneration: 2 }),
      request(1, { evidenceRefs: [] }),
      request(1, { notBeforeAttemptGeneration: 2 }),
      request(1, { expiresAt: "2026-08-09T00:10:00.000Z" })
    ]) {
      expectServiceCode(() => retryService.admit(divergent), "COMMAND_ID_CONFLICT");
    }
    const otherPrincipal = createParentSteeringService({
      store: reopened,
      authority: { principal: "operator-2", sourceKind: "operator" },
      now: () => new Date(LATER)
    });
    expectServiceCode(() => otherPrincipal.admit(request(1)), "COMMAND_ID_CONFLICT");
    expect(reopened.head().headSeq).toBe(7);
  });

  it("retries at a new whole-history head when a different aggregate blocks the task during admission", () => {
    const { store, service } = setup();
    const originalAppend = store.appendBatchIf.bind(store);
    let interpose = true;
    store.appendBatchIf = ((options: Parameters<ControlStore["appendBatchIf"]>[0]) => {
      if (interpose) {
        interpose = false;
        store.append(event("task.status_changed", "task-blocked-during-admission", {
          expectedVersion: 3,
          payload: { role: "dev", status: "blocked", summary: "parent decision required" }
        }));
      }
      return originalAppend(options);
    }) as ControlStore["appendBatchIf"];

    expect(service.admit(request(1))).toMatchObject({
      decision: "refused",
      seq: 7,
      refusal: { reasonCode: "SESSION_BLOCKED" }
    });
    expect(store.getProjection().steering[commandId(1)]).toMatchObject({ status: "refused" });
    expect(store.readRange({ afterSeq: 0 }).events.filter((candidate) => candidate.type === "steering.command_admitted")).toEqual([]);
  });

  it("atomically admits a replacement and supersedes the old command with no dual-pending gap", () => {
    const { store, service } = setup();
    service.admit(request(1));
    const replacement = service.admit(request(2, { supersedesCommandId: commandId(1) }));
    expect(replacement).toMatchObject({ decision: "admitted", seq: 7 });
    expect(store.head().headSeq).toBe(8);
    const snapshot = new SteeringRepository(store).snapshot();
    expect(snapshot.steering.commands[commandId(1)]).toMatchObject({ status: "superseded", byCommandId: commandId(2) });
    expect(snapshot.steering.commands[commandId(2)]).toMatchObject({ status: "pending" });
  });

  it("rolls an entire replacement transaction back at an injected commit failure", () => {
    let armed = false;
    const { store, service } = setup({
      fault: (point, current) => {
        if (armed && point === "before-commit" && current?.type === "steering.command_superseded") {
          throw new Error("replacement commit fault");
        }
      }
    });
    service.admit(request(1));
    armed = true;
    expectServiceCode(() => service.admit(request(2, { supersedesCommandId: commandId(1) })), "CONTROL_STORE_UNAVAILABLE");
    expect(store.head().headSeq).toBe(6);
    const projection = store.getProjection();
    expect(projection.steering[commandId(1)]?.status).toBe("pending");
    expect(projection.steering[commandId(2)]).toBeUndefined();
  });

  it("fails closed when the P1 authority is unavailable and never falls back to memory", () => {
    const { store, service } = setup();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expectServiceCode(() => service.admit(request(1)), "CONTROL_STORE_UNAVAILABLE");
  });

  it("bounds whole-head retry contention instead of livelocking", () => {
    const { store } = setup();
    let attempts = 0;
    store.appendBatchIf = (() => {
      attempts += 1;
      throw new ControlStoreError("STALE_VERSION", "forced contention");
    }) as ControlStore["appendBatchIf"];
    const bounded = createParentSteeringService({
      store,
      authority: { principal: "operator-1", sourceKind: "operator" },
      now: () => new Date(NOW),
      maxCasRetries: 3
    });
    expectServiceCode(() => bounded.admit(request(1)), "CONCURRENT_UPDATE");
    expect(attempts).toBe(3);
    expect(store.head().headSeq).toBe(5);
  });

  it("withdraws pending commands idempotently, conflicts changed reasons, and expires only when due", () => {
    const { store, service } = setup({ now: NOW });
    service.admit(request(1));
    const withdrawn = service.withdraw({ schemaVersion: 1, commandId: commandId(1), reason: "obsolete" });
    expect(service.withdraw({ schemaVersion: 1, commandId: commandId(1), reason: "obsolete" })).toEqual(withdrawn);
    expectServiceCode(
      () => service.withdraw({ schemaVersion: 1, commandId: commandId(1), reason: "different" }),
      "COMMAND_ID_CONFLICT"
    );
    const otherAuthority = createParentSteeringService({
      store,
      authority: { principal: "operator-2", sourceKind: "operator" },
      now: () => new Date(NOW)
    });
    expectServiceCode(
      () => otherAuthority.withdraw({ schemaVersion: 1, commandId: commandId(1), reason: "obsolete" }),
      "COMMAND_ID_CONFLICT"
    );

    service.admit(request(2, { expiresAt: "2026-08-09T00:01:00.000Z" }));
    expectServiceCode(() => service.expire({ schemaVersion: 1, commandId: commandId(2) }), "NOT_EXPIRED");
    const laterService = createParentSteeringService({
      store,
      authority: { principal: "operator-1", sourceKind: "operator" },
      now: () => new Date(LATER)
    });
    const expired = laterService.expire({ schemaVersion: 1, commandId: commandId(2) });
    expect(laterService.expire({ schemaVersion: 1, commandId: commandId(2) })).toEqual(expired);
    expectServiceCode(() => laterService.withdraw({ schemaVersion: 1, commandId: commandId(2) }), "COMMAND_TERMINAL");
  });
});
