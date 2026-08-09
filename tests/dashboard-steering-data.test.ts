import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { emptyControlProjection, type AttemptFact, type ControlProjection, type RuntimeFact, type SteeringFact, type TaskFact } from "../src/control/reducer.js";
import type { ControlViewSource } from "../src/control/views.js";
import {
  buildSteeringDashboardData,
  STEERING_DASHBOARD_PREVIEW_MAX_BYTES,
  steeringActivityLabels
} from "../src/dashboard/steering-data.js";

const NOW = Date.parse("2026-08-09T00:10:00.000Z");
const CREATED = "2026-08-09T00:08:00.000Z";
const HASH = "a".repeat(64);

function task(overrides: Partial<TaskFact> = {}): TaskFact {
  return {
    id: "task-1",
    generation: 3,
    title: "Steering dashboard",
    assignee: "dev",
    createdBy: "parent",
    description: "Show truthful facts.",
    acceptanceCriteria: ["read only"],
    dependsOn: [],
    priority: 1,
    createdAt: "2026-08-09T00:00:00.000Z",
    status: "in-progress",
    claimedBy: "dev",
    lastUpdate: CREATED,
    attempts: 1,
    version: 4,
    updatedSeq: 4,
    ...overrides
  };
}

function runtime(overrides: Partial<RuntimeFact> = {}): RuntimeFact {
  return {
    sessionId: "session-1",
    sessionGeneration: 2,
    taskId: "task-1",
    taskGeneration: 3,
    observation: "waiting_input",
    observedAt: "2026-08-09T00:09:30.000Z",
    updatedSeq: 18,
    ...overrides
  };
}

function admittedFact(commandId: string, overrides: Partial<SteeringFact> = {}): SteeringFact {
  return {
    commandId,
    sessionId: "session-1",
    sessionGeneration: 2,
    taskId: "task-1",
    taskGeneration: 3,
    bodySha256: "b".repeat(64),
    status: "pending",
    admittedSeq: 5,
    notBeforeAttemptGeneration: 2,
    kind: "steer_next_boundary",
    sourceKind: "operator",
    parentPrincipal: "operator-1",
    evidenceRefs: [],
    body: "check the repair",
    createdAt: CREATED,
    ...overrides
  };
}

function attempt(state: AttemptFact["state"], overrides: Partial<AttemptFact> = {}): AttemptFact {
  return {
    attemptId: "attempt-1",
    attemptGeneration: 1,
    taskId: "task-1",
    taskGeneration: 3,
    sessionId: "session-1",
    sessionGeneration: 2,
    promptSha256: HASH,
    steeringCommandIds: ["included-1"],
    state,
    preparedSeq: 8,
    ...overrides
  };
}

function projection(): ControlProjection {
  const value = emptyControlProjection("run-1", "epoch-000000000001");
  value.headSeq = 18;
  value.tasks["task-1"] = task();
  value.runtimes["session-1"] = runtime();
  return value;
}

function source(value: ControlProjection, headSeq = value.headSeq, floorSeq = 0): ControlViewSource {
  return {
    runId: value.runId,
    runEpoch: value.runEpoch,
    getProjection: () => structuredClone(value),
    head: () => ({ runId: value.runId, runEpoch: value.runEpoch, floorSeq, headSeq }),
    readRange: () => ({ runId: value.runId, runEpoch: value.runEpoch, floorSeq, headSeq, events: [] })
  };
}

function view(value: ControlProjection, options: { headSeq?: number; floorSeq?: number; maxCommands?: number } = {}) {
  return buildSteeringDashboardData({
    project: "demo",
    source: source(value, options.headSeq, options.floorSeq),
    nowMs: NOW,
    maxCommands: options.maxCommands
  });
}

describe("steering dashboard data", () => {
  it("projects every pure activity state with exact generations and truthful labels", () => {
    const cases = [
      ["idle", { observation: "available" }],
      ["waiting_input", { observation: "waiting_input" }],
      ["dispatching", { observation: "available", attemptState: "prepared" }],
      ["active", { observation: "available", attemptState: "active" }],
      ["settling", { observation: "available", attemptState: "exited" }],
      ["blocked", { observation: "blocked" }],
      ["exited", { observation: "exited" }]
    ] as const;

    for (const [expected, setup] of cases) {
      const value = projection();
      value.runtimes["session-1"] = runtime({ observation: setup.observation });
      if ("attemptState" in setup) {
        const state = setup.attemptState;
        value.attempts["attempt-1"] = attempt(state, {
          ...(state === "active" ? { launchPlannedSeq: 9, startedSeq: 10 } : {}),
          ...(state === "exited" ? { launchPlannedSeq: 9, startedSeq: 10, exitedSeq: 11, outcome: "failed", exitCode: 1 } : {})
        });
      }
      const session = view(value).sessions[0]!;
      expect(session, expected).toMatchObject({
        sessionId: "session-1",
        sessionGeneration: 2,
        taskId: "task-1",
        taskGeneration: 3,
        activity: expected,
        activityLabel: steeringActivityLabels[expected],
        observedSeq: 18,
        headSeq: 18
      });
    }
  });

  it("reports queue age, next eligibility, freshness, redacted previews, and immutable attempt facts", () => {
    const value = projection();
    value.runtimes["session-1"] = runtime({ observation: "available", updatedSeq: 15 });
    value.attempts["attempt-1"] = attempt("exited", {
      launchPlannedSeq: 10,
      startedSeq: 11,
      exitedSeq: 12,
      outcome: "failed",
      exitCode: 7
    });
    value.steering["pending-1"] = admittedFact("pending-1", {
      admittedSeq: 13,
      notBeforeAttemptGeneration: 4,
      body: `Authorization: Bearer secret-token-value\n${"😀".repeat(400)}`,
      createdAt: CREATED
    });
    value.steering["included-1"] = admittedFact("included-1", {
      status: "included",
      admittedSeq: 5,
      terminalSeq: 9,
      attemptId: "attempt-1",
      attemptGeneration: 1,
      promptSha256: HASH
    });

    const data = view(value, { headSeq: 20, floorSeq: 3 });
    expect(data).toMatchObject({
      project: "demo",
      run: "run-1",
      runEpoch: "epoch-000000000001",
      observedSeq: 18,
      headSeq: 20,
      floorSeq: 3,
      stale: true,
      queue: { pendingCount: 1, oldestPendingAgeMs: 120_000 },
      commandCount: 2,
      commandsTruncated: false
    });
    expect(data.sessions[0]).toMatchObject({
      activity: "settling",
      activityLabel: "Reconciling",
      stale: true,
      queue: {
        pendingCount: 1,
        oldestPendingAgeMs: 120_000,
        nextEligibleAttemptGeneration: 4,
        boundaryReason: "reconciliation-pending"
      }
    });

    const pending = data.commands.find((command) => command.commandId === "pending-1")!;
    expect(pending).toMatchObject({
      status: "pending",
      statusLabel: "Pending",
      statusDetail: "Pending; eligible for attempt 4",
      sourceKind: "operator",
      admittedSeq: 13,
      admittedAt: CREATED,
      eligibleAttemptGeneration: 4,
      attempt: null
    });
    expect(pending.preview).toContain("Authorization: [redacted]");
    expect(pending.preview).not.toContain("secret-token-value");
    expect(Buffer.byteLength(pending.preview!, "utf8")).toBeLessThanOrEqual(STEERING_DASHBOARD_PREVIEW_MAX_BYTES);

    const included = data.commands.find((command) => command.commandId === "included-1")!;
    expect(included).toMatchObject({
      status: "included",
      statusLabel: "Included",
      statusDetail: `Included in attempt 1; prompt sha256:${HASH}`,
      terminalSeq: 9,
      attempt: {
        attemptId: "attempt-1",
        attemptGeneration: 1,
        promptSha256: HASH,
        includedSeq: 9,
        state: "exited",
        preparedSeq: 8,
        launchPlannedSeq: 10,
        providerStartedSeq: 11,
        providerExitedSeq: 12,
        providerExitCode: 7,
        outcome: "failed"
      }
    });
    expect(JSON.stringify(data)).not.toContain("artifactLocator");
    expect(JSON.stringify(data)).not.toContain("promptBytes");
  });

  it("uses exact Pending, Included, and Refused lifecycle language for all terminal outcomes", () => {
    const value = projection();
    value.steering["pending-1"] = admittedFact("pending-1", { admittedSeq: 5 });
    value.steering["refused-1"] = {
      commandId: "refused-1",
      sessionId: "missing-session",
      sessionGeneration: 1,
      taskId: "task-1",
      taskGeneration: 3,
      bodySha256: "c".repeat(64),
      requestSemanticDigest: "d".repeat(64),
      observedSeq: 5,
      observedActivity: "blocked",
      status: "refused",
      terminalSeq: 6,
      reasonCode: "SESSION_BLOCKED"
    };
    value.steering["replacement-1"] = admittedFact("replacement-1", { admittedSeq: 7 });
    value.steering["superseded-1"] = admittedFact("superseded-1", {
      status: "superseded",
      admittedSeq: 8,
      terminalSeq: 9,
      byCommandId: "replacement-1"
    });
    value.steering["withdrawn-1"] = admittedFact("withdrawn-1", { status: "withdrawn", admittedSeq: 10, terminalSeq: 11 });
    value.steering["expired-1"] = admittedFact("expired-1", { status: "expired", admittedSeq: 12, terminalSeq: 13 });

    const data = view(value);
    expect(data.commands.map((command) => [command.commandId, command.statusLabel])).toEqual([
      ["pending-1", "Pending"],
      ["refused-1", "Refused"],
      ["replacement-1", "Pending"],
      ["superseded-1", "Superseded"],
      ["withdrawn-1", "Withdrawn"],
      ["expired-1", "Expired"]
    ]);
    expect(data.commands.find((command) => command.commandId === "refused-1")).toMatchObject({
      sourceKind: null,
      admittedSeq: null,
      admittedAt: null,
      preview: null,
      reasonCode: "SESSION_BLOCKED",
      statusDetail: "Refused; reason SESSION_BLOCKED"
    });
    const rendered = JSON.stringify(data);
    for (const claim of ["Sent", "Delivered", "Read", "Processed"]) expect(rendered).not.toContain(claim);
  });

  it("keeps pending commands visible ahead of recent terminal history when the view is bounded", () => {
    const value = projection();
    value.steering["pending-1"] = admittedFact("pending-1", { admittedSeq: 5 });
    value.steering["terminal-1"] = admittedFact("terminal-1", { status: "withdrawn", admittedSeq: 6, terminalSeq: 7 });
    value.steering["terminal-2"] = admittedFact("terminal-2", { status: "expired", admittedSeq: 8, terminalSeq: 9 });
    const data = view(value, { maxCommands: 2 });
    expect(data).toMatchObject({ commandCount: 3, commandsTruncated: true, queue: { pendingCount: 1 } });
    expect(data.commands.map((command) => command.commandId)).toEqual(["pending-1", "terminal-2"]);
  });

  it("does not claim a pending command is eligible while its session is blocked", () => {
    const value = projection();
    value.runtimes["session-1"] = runtime({ observation: "blocked" });
    value.steering["pending-1"] = admittedFact("pending-1", { admittedSeq: 5 });
    const data = view(value);
    expect(data.sessions[0]!.queue).toMatchObject({
      pendingCount: 1,
      nextEligibleAttemptGeneration: null,
      boundaryReason: "session-blocked"
    });
    expect(data.commands[0]).toMatchObject({
      statusLabel: "Pending",
      eligibleAttemptGeneration: null,
      statusDetail: "Pending; no eligible prompt boundary (session-blocked)"
    });
  });

  it("normalizes valid offset timestamps into the canonical dashboard wire form", () => {
    const value = projection();
    value.runtimes["session-1"] = runtime({ observedAt: "2026-08-09T00:09:30.000+00:00" });
    value.steering["pending-1"] = admittedFact("pending-1", {
      admittedSeq: 5,
      createdAt: "2026-08-09T00:08:00.000+00:00"
    });
    const data = view(value);
    expect(data.sessions[0]!.observedAt).toBe("2026-08-09T00:09:30.000Z");
    expect(data.commands[0]!.admittedAt).toBe(CREATED);
  });

  it("keeps session-generation staleness distinct from a caught-up run cursor", () => {
    const value = projection();
    value.tasks["task-1"]!.generation = 4;
    const data = view(value);
    expect(data.stale).toBe(false);
    expect(data.sessions[0]).toMatchObject({
      taskGeneration: 3,
      activity: "idle",
      certainty: "indeterminate",
      stale: true,
      queue: { nextEligibleAttemptGeneration: null, boundaryReason: "activity-indeterminate" }
    });
  });

  it("fails closed on stale pending targets and corrupt included-attempt identity", () => {
    const stale = projection();
    stale.steering["pending-1"] = admittedFact("pending-1", { sessionGeneration: 1 });
    expect(() => view(stale)).toThrow(/exact live queue target/i);

    const corrupt = projection();
    corrupt.attempts["attempt-1"] = attempt("prepared");
    corrupt.steering["included-1"] = admittedFact("included-1", {
      status: "included",
      terminalSeq: 9,
      attemptId: "attempt-1",
      attemptGeneration: 2,
      promptSha256: HASH
    });
    expect(() => view(corrupt)).toThrow(/exact attempt binding/i);
  });
});
