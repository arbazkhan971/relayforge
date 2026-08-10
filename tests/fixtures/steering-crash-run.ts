import { writeFileSync } from "node:fs";
import { parseControlEvent, type ControlEvent } from "../../src/control/events.js";
import { openControlStore } from "../../src/control/store.js";
import { prepareAttemptPrompt } from "../../src/steering/capture.js";
import { reconcileAttemptRecovery } from "../../src/steering/reconcile.js";
import { SteeringRepository } from "../../src/steering/repository.js";
import { planSteeringRecovery } from "../../src/steering/recovery.js";

const NOW = "2026-08-09T00:00:00.000Z";

function event(type: string, eventId: string, options: {
  taskId?: string | null;
  taskGeneration?: number | null;
  expectedVersion: number;
  payload: unknown;
}): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: options.taskId === undefined ? "task-1" : options.taskId,
    taskGeneration: options.taskGeneration === undefined ? 1 : options.taskGeneration,
    expectedVersion: options.expectedVersion,
    occurredAt: NOW,
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

function seed(): ControlEvent[] {
  return [
    event("run.started", "run-started", {
      taskId: null,
      taskGeneration: null,
      expectedVersion: 0,
      payload: { startedBy: "parent", goal: "P2 recovery" }
    }),
    event("task.created", "task-created", {
      expectedVersion: 0,
      payload: {
        title: "Recover steering",
        assignee: "dev",
        createdBy: "parent",
        description: "Recover exact prompt bytes.",
        acceptanceCriteria: ["no replay"],
        dependsOn: [],
        priority: 1,
        createdAt: NOW
      }
    }),
    event("task.status_changed", "task-claimed", {
      expectedVersion: 1,
      payload: { role: "dev", status: "claimed" }
    }),
    event("task.status_changed", "task-active", {
      expectedVersion: 2,
      payload: { role: "dev", status: "in-progress" }
    }),
    event("runtime.observed", "runtime-waiting", {
      expectedVersion: 0,
      payload: { sessionId: "session-1", sessionGeneration: 1, observation: "waiting_input" }
    })
  ];
}

async function main(): Promise<void> {
  const [mode, databasePath, runDir, marker] = process.argv.slice(2);
  if (!mode || !databasePath || !runDir) throw new Error("mode, database path, and run directory are required");
  if (mode === "prepare-crash") {
    const store = openControlStore({ path: databasePath, runId: "run-1", runEpoch: "epoch-1", now: () => NOW });
    store.appendBatch(seed());
    prepareAttemptPrompt({
      repository: new SteeringRepository(store),
      runDir,
      attemptId: "attempt-1",
      attemptGeneration: 1,
      taskId: "task-1",
      taskGeneration: 1,
      sessionId: "session-1",
      sessionGeneration: 1,
      basePrompt: Buffer.from("provider prompt from crashed parent\n"),
      actorId: "parent",
      now: () => new Date(NOW),
      fault: (point) => {
        if (point !== "after-canonical-commit") return;
        if (marker) writeFileSync(marker, "committed-before-verify");
        process.kill(process.pid, "SIGKILL");
      }
    });
    throw new Error("capture fault did not terminate the fixture");
    return;
  }
  if (mode === "reconcile-active") {
    const store = openControlStore({
      path: databasePath,
      runId: "run-1",
      runEpoch: "epoch-1",
      create: false,
      now: () => NOW
    });
    const repository = new SteeringRepository(store);
    const plan = planSteeringRecovery({
      repository,
      runDir,
      inspectLaunch: () => ({ state: "absent-proven", detail: "fixture proved child absent" })
    }).attempts.find((attempt) => attempt.attemptId === "attempt-1");
    if (!plan || plan.kind !== "record_active_exit") throw new Error(`unexpected recovery plan ${plan?.kind ?? "missing"}`);
    process.send?.({ type: "ready" });
    await new Promise<void>((resolve, reject) => {
      process.once("message", (message) => {
        if (message !== "go") reject(new Error("unexpected parent message"));
        else resolve();
      });
    });
    const result = reconcileAttemptRecovery({
      repository,
      runDir,
      plan,
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    process.send?.({ type: "result", result });
    store.close();
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

void main().catch((error) => {
  process.send?.({ type: "error", message: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
