import { describe, expect, it } from "vitest";
import {
  canAdmitSteeringForFutureAttempt,
  canCaptureSteering,
  deriveSteeringActivity,
  SteeringActivityError
} from "../src/steering/activity.js";
import { emptyControlProjection, type AttemptFact, type ControlProjection, type RuntimeFact, type TaskFact } from "../src/control/reducer.js";
import { steeringActivityStates } from "../src/steering/types.js";

const NOW = Date.parse("2026-08-09T00:00:10.000Z");
const OBSERVED = "2026-08-09T00:00:00.000Z";

function task(overrides: Partial<TaskFact> = {}): TaskFact {
  return {
    id: "task-1",
    generation: 1,
    title: "Task",
    assignee: "dev",
    createdBy: "parent",
    description: "Description",
    acceptanceCriteria: ["passes"],
    dependsOn: [],
    priority: 1,
    createdAt: OBSERVED,
    status: "in-progress",
    claimedBy: "dev",
    lastUpdate: OBSERVED,
    attempts: 0,
    version: 2,
    updatedSeq: 2,
    ...overrides
  };
}

function runtime(overrides: Partial<RuntimeFact> = {}): RuntimeFact {
  return {
    sessionId: "session-1",
    sessionGeneration: 1,
    taskId: "task-1",
    taskGeneration: 1,
    observation: "available",
    observedAt: OBSERVED,
    updatedSeq: 3,
    ...overrides
  };
}

function attempt(state: AttemptFact["state"], generation = 1, overrides: Partial<AttemptFact> = {}): AttemptFact {
  return {
    attemptId: `attempt-${generation}`,
    attemptGeneration: generation,
    taskId: "task-1",
    taskGeneration: 1,
    sessionId: "session-1",
    sessionGeneration: 1,
    steeringCommandIds: [],
    state,
    ...overrides
  };
}

function projection(options: {
  observation?: RuntimeFact["observation"];
  taskStatus?: TaskFact["status"];
  attemptState?: AttemptFact["state"];
  noRuntime?: boolean;
} = {}): ControlProjection {
  const value = emptyControlProjection("run-1", "epoch-1");
  value.headSeq = 10;
  value.tasks["task-1"] = task({ status: options.taskStatus ?? "in-progress" });
  if (!options.noRuntime) value.runtimes["session-1"] = runtime({ observation: options.observation ?? "available" });
  if (options.attemptState) value.attempts["attempt-1"] = attempt(options.attemptState);
  return value;
}

describe("pure seven-state steering activity", () => {
  it("derives every closed activity state and its truthful admission/capture contract", () => {
    const cases = [
      ["idle", projection({ noRuntime: true }), "initial_boundary_only", false],
      ["waiting_input", projection({ observation: "waiting_input" }), "next_boundary", true],
      ["dispatching", projection({ attemptState: "prepared" }), "future_attempt", false],
      ["active", projection({ attemptState: "active" }), "future_attempt", false],
      ["settling", projection({ attemptState: "exited" }), "future_attempt", false],
      ["blocked", projection({ observation: "blocked" }), "refused", false],
      ["exited", projection({ observation: "exited" }), "refused", false]
    ] as const;
    const observed = new Set<string>();
    for (const [state, input, admission, capture] of cases) {
      const derived = deriveSteeringActivity(input, { sessionId: "session-1", nowMs: NOW });
      observed.add(derived.state);
      expect(derived, state).toMatchObject({
        state,
        admission,
        captureEligible: capture,
        certainty: "proven",
        nextAttemptGeneration: Object.keys(input.attempts).length === 0 ? 1 : 2
      });
      expect(canCaptureSteering(derived), state).toBe(capture);
      expect(canAdmitSteeringForFutureAttempt(derived), state).toBe(admission === "next_boundary" || admission === "future_attempt");
    }
    expect([...observed].sort()).toEqual([...steeringActivityStates].sort());
  });

  it("gives explicit blocked/exited facts precedence over a previously live attempt", () => {
    const blocked = projection({ observation: "blocked", attemptState: "active" });
    expect(deriveSteeringActivity(blocked, { sessionId: "session-1", nowMs: NOW })).toMatchObject({
      state: "blocked",
      admission: "refused",
      refusalReason: "SESSION_BLOCKED"
    });
    const exited = projection({ observation: "exited", attemptState: "active" });
    expect(deriveSteeringActivity(exited, { sessionId: "session-1", nowMs: NOW })).toMatchObject({
      state: "exited",
      admission: "refused",
      refusalReason: "SESSION_EXITED"
    });
  });

  it("maps terminal task/run facts without pretending provider cognition", () => {
    expect(deriveSteeringActivity(projection({ taskStatus: "done" }), { sessionId: "session-1", nowMs: NOW })).toMatchObject({
      state: "exited",
      reason: "task completed"
    });
    expect(deriveSteeringActivity(projection({ taskStatus: "escalated" }), { sessionId: "session-1", nowMs: NOW })).toMatchObject({
      state: "exited",
      reason: expect.stringContaining("escalated")
    });
    const completed = projection();
    completed.run = {
      status: "completed",
      startedBy: "parent",
      startedAt: OBSERVED,
      terminalAt: OBSERVED,
      version: 2,
      updatedSeq: 10
    };
    expect(deriveSteeringActivity(completed, { sessionId: "session-1", nowMs: NOW })).toMatchObject({
      state: "exited",
      reason: "run completed"
    });
  });

  it("keeps probe failures and stale generations idle-but-indeterminate", () => {
    const failedProbe = projection({ observation: "probe_failed" });
    expect(deriveSteeringActivity(failedProbe, { sessionId: "session-1", nowMs: NOW })).toMatchObject({
      state: "idle",
      certainty: "indeterminate",
      admission: "indeterminate",
      captureEligible: false
    });
    const stale = projection({ observation: "waiting_input" });
    stale.tasks["task-1"]!.generation = 2;
    expect(deriveSteeringActivity(stale, { sessionId: "session-1", nowMs: NOW })).toMatchObject({
      state: "idle",
      certainty: "indeterminate",
      stale: true,
      captureEligible: false,
      reason: expect.stringContaining("stale")
    });
  });

  it("reports view freshness, age, and the exact next generation without mutating input", () => {
    const input = projection({ attemptState: "exited" });
    const before = structuredClone(input);
    const derived = deriveSteeringActivity(input, { sessionId: "session-1", nowMs: NOW, headSeq: 14 });
    expect(derived).toMatchObject({
      state: "settling",
      viewSeq: 10,
      headSeq: 14,
      stale: true,
      ageMs: 10_000,
      nextAttemptGeneration: 2
    });
    expect(input).toEqual(before);
  });

  it("fails closed on malformed clocks, freshness, session targets, and attempt lineages", () => {
    expect(() => deriveSteeringActivity(projection(), { sessionId: "session-1", nowMs: Number.NaN })).toThrow(SteeringActivityError);
    expect(() => deriveSteeringActivity(projection(), { sessionId: "session-1", nowMs: NOW, headSeq: 9 })).toThrow(/precede/i);

    const missingTask = projection();
    delete missingTask.tasks["task-1"];
    expect(() => deriveSteeringActivity(missingTask, { sessionId: "session-1", nowMs: NOW })).toThrow(/missing task/i);

    const orphanAttempt = projection({ noRuntime: true });
    orphanAttempt.attempts["attempt-1"] = attempt("active");
    expect(() => deriveSteeringActivity(orphanAttempt, { sessionId: "session-1", nowMs: NOW })).toThrow(/no durable runtime/i);

    const invalidObservedAt = projection();
    invalidObservedAt.runtimes["session-1"]!.observedAt = "not-a-time";
    expect(() => deriveSteeringActivity(invalidObservedAt, { sessionId: "session-1", nowMs: NOW })).toThrow(/timestamp/i);

    const halfScoped = projection();
    delete halfScoped.runtimes["session-1"]!.taskGeneration;
    expect(() => deriveSteeringActivity(halfScoped, { sessionId: "session-1", nowMs: NOW })).toThrow(/half-scoped/i);

    const duplicateGeneration = projection({ attemptState: "exited" });
    duplicateGeneration.attempts["different-id"] = attempt("exited", 1, { attemptId: "different-id" });
    expect(() => deriveSteeringActivity(duplicateGeneration, { sessionId: "session-1", nowMs: NOW })).toThrow(/duplicate attempt generation/i);

    const wrongTask = projection({ attemptState: "active" });
    wrongTask.attempts["attempt-1"]!.taskId = "task-2";
    expect(() => deriveSteeringActivity(wrongTask, { sessionId: "session-1", nowMs: NOW })).toThrow(/does not match/i);

    const multipleLive = projection({ attemptState: "active" });
    multipleLive.attempts["attempt-2"] = attempt("prepared", 2);
    expect(() => deriveSteeringActivity(multipleLive, { sessionId: "session-1", nowMs: NOW })).toThrow(/multiple live/i);
  });
});
