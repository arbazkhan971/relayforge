import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { parseControlEvent, type PersistedControlEvent } from "../src/control/events.js";
import {
  CONTROL_ACTIVITY_MAX_LIMIT,
  CONTROL_BOARD_MAX_BYTES,
  CONTROL_DIAGNOSTIC_MAX_LINES,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RUNS_MAX_LIMIT,
  serializeControlResponse,
  type ControlDiagnosticCheck
} from "../src/control/protocol.js";
import { emptyControlProjection, type ControlProjection, type TaskFact } from "../src/control/reducer.js";
import { ControlStoreError, type EventRange } from "../src/control/store.js";
import {
  ControlViewError,
  authorizeDiagnosticSession,
  buildControlActivity,
  buildControlBoard,
  buildControlDiagnostics,
  buildControlRun,
  buildControlRuns,
  buildControlStatus,
  decodeControlRunsCursor,
  encodeControlRunsCursor,
  readControlViewSnapshot,
  type ControlViewSource,
  type OwnedControlSession
} from "../src/control/views.js";

const NOW = "2026-08-09T12:00:00.000Z";
const LATER = "2026-08-09T13:00:00.000Z";
const INSTANCE_ID = "a".repeat(64);
const CONFIG_ID = "b".repeat(64);
const EPOCH_1 = "epoch_000000000001";
const EPOCH_2 = "epoch_000000000002";

class FakeSource implements ControlViewSource {
  projectionError?: Error;
  rangeError?: Error;

  constructor(
    readonly runId: string,
    readonly runEpoch: string,
    readonly projection: ControlProjection,
    readonly events: readonly PersistedControlEvent[] = [],
    readonly durableHead = projection.headSeq,
    readonly floorSeq = 1
  ) {}

  getProjection(): ControlProjection {
    if (this.projectionError) throw this.projectionError;
    return this.projection;
  }

  head(): { runId: string; runEpoch: string; floorSeq: number; headSeq: number } {
    return { runId: this.runId, runEpoch: this.runEpoch, floorSeq: this.floorSeq, headSeq: this.durableHead };
  }

  readRange(options: { afterSeq: number; limit?: number; runEpoch?: string }): EventRange {
    if (this.rangeError) throw this.rangeError;
    if (options.runEpoch !== undefined && options.runEpoch !== this.runEpoch) {
      throw new ControlStoreError("RUN_IDENTITY_MISMATCH", "foreign epoch");
    }
    const limit = options.limit ?? 1_000;
    const available = this.events.filter((event) => event.seq > options.afterSeq && event.seq <= this.durableHead);
    const events = available.slice(0, limit);
    return {
      runEpoch: this.runEpoch,
      floorSeq: this.floorSeq,
      headSeq: this.durableHead,
      afterSeq: options.afterSeq,
      events,
      hasMore: available.length > events.length
    };
  }
}

function projection(
  runId: string,
  runEpoch: string,
  options: {
    headSeq?: number;
    startedAt?: string;
    status?: "started" | "completed" | "failed" | "cancelled";
    terminalAt?: string;
  } = {}
): ControlProjection {
  const value = emptyControlProjection(runId, runEpoch);
  value.headSeq = options.headSeq ?? 1;
  value.run = {
    status: options.status ?? "started",
    startedBy: "parent",
    startedAt: options.startedAt ?? NOW,
    terminalAt: options.terminalAt,
    reasonCode: options.status === "failed" ? "VERIFICATION:FAILED" : undefined,
    summary: options.status === "completed" ? "All work completed." : undefined,
    cancelledBy: options.status === "cancelled" ? "parent" : undefined,
    version: options.status === undefined || options.status === "started" ? 1 : 2,
    updatedSeq: value.headSeq
  };
  return value;
}

function task(overrides: Partial<TaskFact> = {}): TaskFact {
  return {
    id: "task-1",
    generation: 1,
    title: "Build the control view",
    assignee: "backend",
    createdBy: "parent",
    description: "private description",
    acceptanceCriteria: ["private criterion"],
    dependsOn: [],
    priority: 10,
    createdAt: NOW,
    files: ["/private/worktree/src/control/views.ts"],
    status: "open",
    lastUpdate: NOW,
    attempts: 0,
    version: 1,
    updatedSeq: 2,
    ...overrides
  };
}

function event(
  seq: number,
  type:
    | "run.started"
    | "task.created"
    | "task.status_changed"
    | "message.posted"
    | "runtime.observed"
): PersistedControlEvent {
  const base = {
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    eventId: `event-${seq}`,
    runId: "run-1",
    runEpoch: EPOCH_1,
    expectedVersion: 0,
    occurredAt: new Date(Date.parse(NOW) + seq * 1_000).toISOString()
  } as const;
  const value = type === "run.started"
    ? { ...base, taskId: null, taskGeneration: null, type, payload: { startedBy: "parent", goal: "private goal" } }
    : type === "task.created"
      ? {
          ...base,
          taskId: "task-1",
          taskGeneration: 1,
          type,
          payload: {
            title: "Public task title",
            assignee: "backend",
            createdBy: "parent",
            description: "private description",
            acceptanceCriteria: ["private criterion"],
            dependsOn: [],
            priority: 10,
            createdAt: NOW,
            files: ["/private/source.ts"]
          }
        }
      : type === "task.status_changed"
        ? {
            ...base,
            taskId: "task-1",
            taskGeneration: 1,
            type,
            payload: { role: "backend", status: "in-progress" as const, summary: "Public progress" }
          }
        : type === "message.posted"
          ? {
              ...base,
              taskId: null,
              taskGeneration: null,
              type,
              payload: { messageId: `message-${seq}`, from: "parent", to: "backend", body: "private message body" }
            }
          : {
              ...base,
              taskId: "task-1",
              taskGeneration: 1,
              type,
              payload: {
                sessionId: "loop-demo-backend",
                sessionGeneration: 1,
                observation: "probe_failed" as const,
                reason: "private probe output"
              }
            };
  const parsed = parseControlEvent(value);
  return { ...parsed, seq, digest: "c".repeat(64) };
}

function owned(overrides: Partial<OwnedControlSession> = {}): OwnedControlSession {
  return {
    name: "loop-demo-backend",
    project: "demo",
    run: "run-1",
    role: "backend",
    sessionGeneration: 1,
    taskId: "task-1",
    ...overrides
  };
}

function expectViewCode(action: () => unknown, code: ControlViewError["code"]): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ControlViewError);
    expect((error as ControlViewError).code).toBe(code);
  }
}

describe("control read-model adapter", () => {
  it("orders run pages deterministically and round-trips project-bound opaque cursors", () => {
    const earlier = new FakeSource("run-a", EPOCH_1, projection("run-a", EPOCH_1, { startedAt: NOW }));
    const later = new FakeSource("run-b", EPOCH_2, projection("run-b", EPOCH_2, { startedAt: LATER }));

    const first = buildControlRuns({ project: "demo", sources: [earlier, later], limit: 1 });
    expect(first.runs.map((run) => run.run)).toEqual(["run-b"]);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeControlRunsCursor(first.nextCursor!)).toEqual({
      project: "demo",
      startedAt: LATER,
      run: "run-b",
      runEpoch: EPOCH_2
    });

    const second = buildControlRuns({ project: "demo", sources: [later, earlier], limit: 1, cursor: first.nextCursor });
    expect(second.runs.map((run) => run.run)).toEqual(["run-a"]);
    expect(second.nextCursor).toBeNull();
    expectViewCode(
      () => buildControlRuns({ project: "other", sources: [later, earlier], cursor: first.nextCursor }),
      "INVALID_CURSOR"
    );
  });

  it("accepts exact page bounds, rejects plus one, and refuses missing cursor identities", () => {
    const sources = Array.from({ length: CONTROL_RUNS_MAX_LIMIT }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return new FakeSource(`run-${suffix}`, `epoch_000000000${suffix}`, projection(`run-${suffix}`, `epoch_000000000${suffix}`));
    });
    expect(buildControlRuns({ project: "demo", sources, limit: CONTROL_RUNS_MAX_LIMIT }).runs).toHaveLength(100);
    expectViewCode(
      () => buildControlRuns({ project: "demo", sources, limit: CONTROL_RUNS_MAX_LIMIT + 1 }),
      "INVALID_INPUT"
    );
    const foreign = encodeControlRunsCursor({ project: "demo", startedAt: NOW, run: "not-loaded", runEpoch: EPOCH_1 });
    expectViewCode(() => buildControlRuns({ project: "demo", sources, cursor: foreign }), "INVALID_CURSOR");
    expectViewCode(() => decodeControlRunsCursor("v1.bm90LWN1cnNvcg"), "INVALID_CURSOR");
  });

  it("maps lifecycle, freshness, task counts, and public board fields without internal spreads", () => {
    const value = projection("run-1", EPOCH_1, { headSeq: 4, status: "failed", terminalAt: LATER });
    value.tasks["task-z"] = task({
      id: "task-z",
      status: "done",
      priority: 1_000_000,
      attempts: 101,
      lastSummary: "done"
    });
    value.tasks["task-a"] = task({
      id: "task-a",
      status: "in-progress",
      priority: -1_000_000,
      claimedBy: "backend",
      lastUpdate: "2026-08-09T12:30:00+00:00"
    });
    const source = new FakeSource("run-1", EPOCH_1, value, [], 5);

    const run = buildControlRun({ project: "demo", run: "run-1", source });
    expect(run.run).toMatchObject({
      status: "failed",
      reason: "verification-failed",
      completedAt: LATER,
      desiredGeneration: 2,
      observedGeneration: 2,
      viewSeq: 4,
      headSeq: 5,
      floorSeq: 1,
      stale: true,
      tasks: { total: 2, active: 1, done: 1 }
    });

    const board = buildControlBoard({ project: "demo", run: "run-1", source });
    expect(board.tasks.map((entry) => entry.id)).toEqual(["task-a", "task-z"]);
    expect(board.tasks[0]).toEqual({
      id: "task-a",
      title: "Build the control view",
      status: "in-progress",
      assignee: "backend",
      claimedBy: "backend",
      priority: 0,
      dependsOn: [],
      attempts: 0,
      createdAt: NOW,
      updatedAt: "2026-08-09T12:30:00.000Z",
      summary: null
    });
    expect(board.tasks[1]!.priority).toBe(100);
    expect(board.tasks[1]!.attempts).toBe(100);
    expect(Object.keys(board.tasks[0]!)).not.toContain("description");
    expect(Object.keys(board.tasks[0]!)).not.toContain("files");
    expect(Object.keys(board.tasks[0]!)).not.toContain("generation");
    const serialized = serializeControlResponse("board", board);
    expect(serialized.bytes).toBe(Buffer.byteLength(serialized.json, "utf8"));
    expect(serialized.bytes).toBeLessThan(CONTROL_BOARD_MAX_BYTES);
    expect(serialized.json).not.toContain("private description");
    expect(serialized.json).not.toContain("/private/worktree");
  });

  it("maps only allowlisted canonical events and advances across filtered private events", () => {
    const events = [
      event(1, "run.started"),
      event(2, "message.posted"),
      event(3, "task.created"),
      event(4, "task.status_changed"),
      event(5, "runtime.observed")
    ];
    const value = projection("run-1", EPOCH_1, { headSeq: 5 });
    const source = new FakeSource("run-1", EPOCH_1, value, events);

    const first = buildControlActivity({ project: "demo", run: "run-1", source, after: 0, limit: 2 });
    expect(first.activity.map((entry) => [entry.seq, entry.kind])).toEqual([
      [1, "run.started"],
      [3, "task.created"]
    ]);
    expect(first.nextAfter).toBe(3);
    expect(JSON.stringify(first)).not.toContain("private message body");
    expect(JSON.stringify(first)).not.toContain("private goal");
    expect(JSON.stringify(first)).not.toContain("private description");

    const second = buildControlActivity({ project: "demo", run: "run-1", source, after: first.nextAfter!, limit: 2 });
    expect(second.activity.map((entry) => [entry.seq, entry.kind, entry.summary])).toEqual([
      [4, "task.started", "Public progress"],
      [5, "runtime.probe-failed", "Runtime probe failed."]
    ]);
    expect(second.nextAfter).toBeNull();
  });

  it("validates activity exact limits and preserves typed cursor/store failures", () => {
    const source = new FakeSource("run-1", EPOCH_1, projection("run-1", EPOCH_1));
    expect(buildControlActivity({ project: "demo", run: "run-1", source, limit: CONTROL_ACTIVITY_MAX_LIMIT }).activity).toEqual([]);
    expectViewCode(
      () => buildControlActivity({ project: "demo", run: "run-1", source, limit: CONTROL_ACTIVITY_MAX_LIMIT + 1 }),
      "INVALID_INPUT"
    );
    const cursorError = new ControlStoreError("CURSOR_EXPIRED", "expired", { floorSeq: 4, headSeq: 9 });
    source.rangeError = cursorError;
    expect(() => buildControlActivity({ project: "demo", run: "run-1", source })).toThrow(cursorError);
  });

  it("builds deterministic status with exact stamped owned sessions and an injected clock", () => {
    const value = projection("run-1", EPOCH_1, { headSeq: 3 });
    value.tasks["task-1"] = task({ status: "in-progress", claimedBy: "backend" });
    value.runtimes["loop-demo-backend"] = {
      sessionId: "loop-demo-backend",
      sessionGeneration: 1,
      taskId: "task-1",
      taskGeneration: 1,
      observation: "available",
      observedAt: NOW,
      updatedSeq: 3
    };
    const source = new FakeSource("run-1", EPOCH_1, value);
    const status = buildControlStatus({
      instanceId: INSTANCE_ID,
      configId: CONFIG_ID,
      startedAt: "2026-08-09T11:00:00+00:00",
      now: Date.parse(NOW) + 5_000,
      projects: [
        { project: "zeta", runs: [], sessions: [] },
        { project: "demo", runs: [source], sessions: [owned()] }
      ]
    });
    expect(status.projects.map((project) => project.project)).toEqual(["demo", "zeta"]);
    expect(status.projects[0]!.latestRun?.run).toBe("run-1");
    expect(status.projects[0]!.sessions).toEqual([
      {
        name: "loop-demo-backend",
        project: "demo",
        run: "run-1",
        role: "backend",
        state: "running",
        taskId: "task-1",
        lastActivity: NOW
      }
    ]);
    expect(status.startedAt).toBe("2026-08-09T11:00:00.000Z");

    expectViewCode(
      () => buildControlStatus({
        instanceId: INSTANCE_ID,
        configId: CONFIG_ID,
        startedAt: NOW,
        now: Date.parse(NOW),
        projects: [{ project: "demo", runs: [source], sessions: [owned({ project: "demo-prefix" })] }]
      }),
      "SESSION_OWNERSHIP_MISMATCH"
    );
  });

  it("authorizes diagnostic capture before callback and refuses prefix, run, generation, and task mismatches", () => {
    const value = projection("run-1", EPOCH_1, { headSeq: 3 });
    value.tasks["task-1"] = task();
    value.runtimes["loop-demo-backend"] = {
      sessionId: "loop-demo-backend",
      sessionGeneration: 1,
      taskId: "task-1",
      taskGeneration: 1,
      observation: "available",
      observedAt: NOW,
      updatedSeq: 3
    };
    const source = new FakeSource("run-1", EPOCH_1, value);
    const snapshot = readControlViewSnapshot(source);
    expect(authorizeDiagnosticSession("demo", snapshot, [owned()], "loop-demo-backend")).toEqual(owned());

    const capture = vi.fn(() => ({ tail: ["one", "two", "three"], truncated: false }));
    const mismatches: OwnedControlSession[] = [
      owned({ name: "loop-demo-backend-prefix" }),
      owned({ run: "run-2" }),
      owned({ sessionGeneration: 2 }),
      owned({ taskId: "task-2" })
    ];
    for (const ownership of mismatches) {
      expectViewCode(
        () => buildControlDiagnostics({
          project: "demo",
          run: "run-1",
          source,
          sessions: [ownership],
          session: "loop-demo-backend",
          capture,
          now: Date.parse(NOW)
        }),
        ownership.name === "loop-demo-backend-prefix" ? "SESSION_NOT_FOUND" : "SESSION_OWNERSHIP_MISMATCH"
      );
    }
    expectViewCode(
      () => buildControlDiagnostics({
        project: "demo",
        run: "run-1-prefix",
        source,
        sessions: [owned()],
        session: "loop-demo-backend",
        capture,
        now: Date.parse(NOW)
      }),
      "RUN_NOT_FOUND"
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("bounds diagnostic lines, sorts checks, and uses only the authorized callback request", () => {
    const value = projection("run-1", EPOCH_1, { headSeq: 3 });
    value.tasks["task-1"] = task();
    value.runtimes["loop-demo-backend"] = {
      sessionId: "loop-demo-backend",
      sessionGeneration: 1,
      taskId: "task-1",
      taskGeneration: 1,
      observation: "probe_failed",
      observedAt: NOW,
      updatedSeq: 3
    };
    const source = new FakeSource("run-1", EPOCH_1, value);
    const supplied: ControlDiagnosticCheck = {
      code: "adapter-check",
      status: "ok",
      message: "The adapter input is bounded.",
      fix: null
    };
    const capture = vi.fn((request) => ({
      tail: ["old", "new"],
      truncated: false,
      checks: [supplied],
      ignored: "not public"
    }));
    const diagnostics = buildControlDiagnostics({
      project: "demo",
      run: "run-1",
      source,
      sessions: [owned()],
      session: "loop-demo-backend",
      lines: 1,
      capture,
      now: Date.parse(NOW) + 250
    });
    expect(capture).toHaveBeenCalledWith({
      project: "demo",
      run: "run-1",
      session: "loop-demo-backend",
      sessionGeneration: 1,
      taskId: "task-1",
      lines: 1
    });
    expect(diagnostics.tail).toEqual(["new"]);
    expect(diagnostics.truncated).toBe(true);
    expect(diagnostics.checks.map((check) => check.code)).toEqual([
      "adapter-check",
      "run-lifecycle",
      "session-runtime",
      "store-view"
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("ignored");

    expect(buildControlDiagnostics({
      project: "demo",
      run: "run-1",
      source,
      sessions: [owned()],
      session: "loop-demo-backend",
      lines: CONTROL_DIAGNOSTIC_MAX_LINES,
      capture: () => ({ tail: [] }),
      now: Date.parse(NOW)
    }).tail).toEqual([]);
    expectViewCode(
      () => buildControlDiagnostics({
        project: "demo",
        run: "run-1",
        source,
        sessions: [owned()],
        session: "loop-demo-backend",
        lines: CONTROL_DIAGNOSTIC_MAX_LINES + 1,
        capture: () => ({ tail: [] }),
        now: Date.parse(NOW)
      }),
      "INVALID_INPUT"
    );
  });

  it("propagates recovery failures by identity and rejects inconsistent or unstarted projections", () => {
    const recovery = new ControlStoreError("RECOVERY_REQUIRED", "projection digest mismatch");
    const source = new FakeSource("run-1", EPOCH_1, projection("run-1", EPOCH_1));
    source.projectionError = recovery;
    expect(() => buildControlBoard({ project: "demo", run: "run-1", source })).toThrow(recovery);

    const unstarted = emptyControlProjection("run-1", EPOCH_1);
    unstarted.headSeq = 1;
    expectViewCode(
      () => buildControlRun({ project: "demo", run: "run-1", source: new FakeSource("run-1", EPOCH_1, unstarted) }),
      "RUN_NOT_STARTED"
    );

    const inconsistent = projection("run-1", EPOCH_1, { headSeq: 4 });
    expectViewCode(
      () => readControlViewSnapshot(new FakeSource("run-1", EPOCH_1, inconsistent, [], 3)),
      "INCONSISTENT_SNAPSHOT"
    );

    const foreign = projection("run-2", EPOCH_1);
    expectViewCode(
      () => readControlViewSnapshot(new FakeSource("run-1", EPOCH_1, foreign)),
      "IDENTITY_MISMATCH"
    );
  });
});
