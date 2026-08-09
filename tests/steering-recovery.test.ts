import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent, type ControlEvent } from "../src/control/events.js";
import {
  ControlStore,
  openControlStore,
  type ControlStoreFaultPoint
} from "../src/control/store.js";
import { prepareAttemptPrompt, type PreparedAttemptPrompt } from "../src/steering/capture.js";
import {
  completeExitedSettlement,
  reconcileAttemptRecovery,
  reconcileTerminalPendingCommands,
  SteeringReconcileError
} from "../src/steering/reconcile.js";
import { SteeringRepository } from "../src/steering/repository.js";
import { planSteeringRecovery, type AttemptRecoveryPlan } from "../src/steering/recovery.js";
import {
  createParentSteeringService,
  type ParentSteeringService,
  type SteeringAdmissionRequest
} from "../src/steering/service.js";

const NOW = "2026-08-09T00:00:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* fault and restart tests may already have closed it */ }
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

function seedEvents(): ControlEvent[] {
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
        title: "Durable recovery",
        assignee: "dev",
        createdBy: "parent",
        description: "Recover an exact prompt.",
        acceptanceCriteria: ["never replay"],
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

type Environment = {
  root: string;
  path: string;
  store: ControlStore;
  repository: SteeringRepository;
  service: ParentSteeringService;
};

function setup(fault?: (point: ControlStoreFaultPoint, event?: ControlEvent) => void): Environment {
  const root = mkdtempSync(join(tmpdir(), "relayforge-steering-recovery-"));
  roots.push(root);
  const path = join(root, "control.sqlite");
  const store = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", now: () => NOW, fault });
  stores.push(store);
  store.appendBatch(seedEvents());
  return {
    root,
    path,
    store,
    repository: new SteeringRepository(store),
    service: createParentSteeringService({
      store,
      authority: { principal: "operator-1", sourceKind: "operator" },
      now: () => new Date(NOW)
    })
  };
}

function request(index: number): SteeringAdmissionRequest {
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
    body: `recovery instruction ${index}`
  };
}

function prepare(environment: Environment, basePrompt: Buffer | string = "base prompt\n"): PreparedAttemptPrompt {
  return prepareAttemptPrompt({
    repository: environment.repository,
    runDir: environment.root,
    attemptId: "attempt-1",
    attemptGeneration: 1,
    taskId: "task-1",
    taskGeneration: 1,
    sessionId: "session-1",
    sessionGeneration: 1,
    basePrompt,
    actorId: "parent",
    now: () => new Date(NOW)
  });
}

function taskVersion(store: ControlStore): number {
  return store.getProjection().aggregateVersions["task:task-1:1"]?.version ?? 0;
}

function sessionVersion(store: ControlStore, generation: number): number {
  return store.getProjection().aggregateVersions[`session:session-1:${generation}`]?.version ?? 0;
}

function appendTaskEvent(store: ControlStore, type: string, eventId: string, payload: unknown): void {
  store.append(event(type, eventId, { expectedVersion: taskVersion(store), payload }));
}

function attemptPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: "attempt-1",
    attemptGeneration: 1,
    sessionId: "session-1",
    sessionGeneration: 1,
    ...extra
  };
}

function onlyAttempt(environment: Environment, overrides: Partial<Parameters<typeof planSteeringRecovery>[0]> = {}): AttemptRecoveryPlan {
  const plan = planSteeringRecovery({
    repository: environment.repository,
    runDir: environment.root,
    inspectLaunch: () => ({ state: "absent-proven" }),
    ...overrides
  });
  expect(plan.attempts).toHaveLength(1);
  return plan.attempts[0]!;
}

function makeActive(environment: Environment): PreparedAttemptPrompt {
  const prepared = prepare(environment);
  appendTaskEvent(environment.store, "attempt.launch_planned", "launch-plan", attemptPayload({ launchId: "launch-1" }));
  appendTaskEvent(environment.store, "attempt.started", "attempt-started", attemptPayload({
    launchId: "launch-1",
    pid: 4242,
    processStartToken: "123456"
  }));
  return prepared;
}

function expectReconcileCode(action: () => unknown, code: SteeringReconcileError["code"]): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SteeringReconcileError);
    expect((error as SteeringReconcileError).code).toBe(code);
  }
}

function reopen(environment: Environment): Environment {
  environment.store.close();
  stores.splice(stores.indexOf(environment.store), 1);
  const store = openControlStore({
    path: environment.path,
    runId: "run-1",
    runEpoch: "epoch-1",
    create: false,
    now: () => NOW
  });
  stores.push(store);
  return {
    ...environment,
    store,
    repository: new SteeringRepository(store),
    service: createParentSteeringService({
      store,
      authority: { principal: "operator-1", sourceKind: "operator" },
      now: () => new Date(NOW)
    })
  };
}

function waitForExit(child: ChildProcess, allowHardKill = false): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code && code !== 0 && !(allowHardKill && code === 137)) reject(new Error(stderr || `child exited ${code}`));
      else resolveExit({ code, signal });
    });
  });
}

function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      if (record.type === "error") {
        cleanup();
        reject(new Error(String(record.message)));
      } else if (record.type === type) {
        cleanup();
        resolveMessage(record);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`fixture exited before ${type} (${String(code)})`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

describe("P2 steering crash recovery", () => {
  it("reconstructs an admitted pre-capture queue without inventing an attempt or provider effect", () => {
    const environment = setup();
    environment.service.admit(request(1));
    const recovery = planSteeringRecovery({ repository: environment.repository, runDir: environment.root });
    expect(recovery.attempts).toEqual([]);
    expect(recovery.restoredPendingCommandIds).toEqual([commandId(1)]);
    expect(environment.store.getProjection().attempts).toEqual({});
  });

  it("rebuilds pending state and resumes only the exact verified prepared bytes", () => {
    const environment = setup();
    environment.service.admit(request(1));
    const prepared = prepare(environment, Buffer.from([0x62, 0x61, 0x73, 0x65, 0x0a]));
    environment.service.admit(request(2));

    const recovery = planSteeringRecovery({
      repository: environment.repository,
      runDir: environment.root,
      inspectLaunch: () => ({ state: "absent-proven", detail: "launch ledger has no process" })
    });
    expect(recovery.restoredPendingCommandIds).toEqual([commandId(2)]);
    expect(recovery.terminalPendingCommands).toEqual([]);
    expect(recovery.attempts[0]).toMatchObject({ kind: "resume_prepared", attemptId: "attempt-1" });
    const attempt = recovery.attempts[0]!;
    expect(attempt.kind).toBe("resume_prepared");
    if (attempt.kind !== "resume_prepared") return;
    expect(attempt.content).toEqual(prepared.content);
    expect(environment.store.getProjection().steering[commandId(1)]?.status).toBe("included");
    expect(environment.store.getProjection().steering[commandId(2)]?.status).toBe("pending");

    const launchPlan = reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan: attempt,
      launchId: "launch-recovery-1",
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    expect(launchPlan).toMatchObject({ status: "launch_planned", launchId: "launch-recovery-1", replanRequired: true });
    const replanned = onlyAttempt(environment);
    expect(replanned).toMatchObject({ kind: "resume_prepared", launchId: "launch-recovery-1" });
    const ready = reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan: replanned,
      actorId: "recovery"
    });
    expect(ready).toMatchObject({ status: "ready_to_launch", launchId: "launch-recovery-1" });
    if (ready.status === "ready_to_launch") expect(ready.content).toEqual(prepared.content);
  });

  it.each(["missing", "corrupt", "replaced"] as const)("blocks a %s committed prompt artifact without rerendering", (mutation) => {
    const environment = setup();
    const prepared = prepare(environment);
    if (mutation === "missing") unlinkSync(prepared.artifact.path);
    if (mutation === "corrupt") {
      chmodSync(prepared.artifact.path, 0o600);
      writeFileSync(prepared.artifact.path, "corrupt");
    }
    if (mutation === "replaced") {
      renameSync(prepared.artifact.path, `${prepared.artifact.path}.old`);
      writeFileSync(prepared.artifact.path, "replacement", { mode: 0o400 });
    }
    const plan = onlyAttempt(environment);
    expect(plan).toMatchObject({ kind: "blocked_artifact" });
    expectReconcileCode(() => reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan,
      actorId: "recovery"
    }), "BLOCKED_ARTIFACT");
    expect(environment.store.getProjection().attempts["attempt-1"]?.state).toBe("prepared");
  });

  it("detects artifact replacement between planning and launch", () => {
    const environment = setup();
    const prepared = prepare(environment);
    const plan = onlyAttempt(environment);
    expect(plan.kind).toBe("resume_prepared");
    renameSync(prepared.artifact.path, `${prepared.artifact.path}.old`);
    writeFileSync(prepared.artifact.path, "changed after plan", { mode: 0o400 });
    expectReconcileCode(() => reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan,
      launchId: "launch-1",
      actorId: "recovery"
    }), "BLOCKED_ARTIFACT");
    expect(environment.store.head().headSeq).toBe(plan.expectedHeadSeq);
  });

  it("requires an explicit policy and proven absent launch before abandoning an unrecoverable artifact", () => {
    const environment = setup();
    const prepared = prepare(environment);
    unlinkSync(prepared.artifact.path);
    expect(onlyAttempt(environment)).toMatchObject({ kind: "blocked_artifact", reasonCode: "ARTIFACT_MISSING" });
    const abandon = onlyAttempt(environment, {
      decideArtifactFailure: () => "abandon",
      inspectLaunch: () => ({ state: "absent-proven", detail: "no child exists" })
    });
    expect(abandon).toMatchObject({ kind: "abandon_prepared", reasonCode: "ARTIFACT_UNRECOVERABLE" });
    reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan: abandon,
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    expect(environment.store.getProjection().attempts["attempt-1"]).toMatchObject({
      state: "abandoned",
      abandonReason: "ARTIFACT_UNRECOVERABLE"
    });
    expect(onlyAttempt(environment)).toMatchObject({ kind: "already_abandoned", reasonCode: "ARTIFACT_UNRECOVERABLE" });
  });

  it("fails closed for uncertain spawn and wrong active process incarnation", () => {
    const preparedEnvironment = setup();
    prepare(preparedEnvironment);
    const uncertain = onlyAttempt(preparedEnvironment, {
      inspectLaunch: () => ({ state: "unavailable", detail: "process table unavailable" })
    });
    expect(uncertain).toMatchObject({ kind: "blocked_identity", reasonCode: "LAUNCH_INSPECTION_UNAVAILABLE" });

    const activeEnvironment = setup();
    makeActive(activeEnvironment);
    const mismatch = onlyAttempt(activeEnvironment, {
      inspectLaunch: () => ({
        state: "alive-match",
        launchId: "launch-1",
        pid: 4242,
        processStartToken: "999999"
      })
    });
    expect(mismatch).toMatchObject({ kind: "blocked_identity", reasonCode: "LAUNCH_IDENTITY_MISMATCH" });
    expect(activeEnvironment.store.getProjection().attempts["attempt-1"]?.state).toBe("active");
  });

  it("recovers a matching active launch, records a proven exit once, and settles with a durable cursor", () => {
    let fault: ControlStoreFaultPoint | undefined;
    const environment = setup((point) => {
      if (point === fault) throw new Error(`fault:${point}`);
    });
    makeActive(environment);
    const attached = onlyAttempt(environment, {
      inspectLaunch: () => ({
        state: "alive-match",
        launchId: "launch-1",
        pid: 4242,
        processStartToken: "123456"
      })
    });
    expect(attached.kind).toBe("reattach_active");
    expect(reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan: attached,
      actorId: "recovery"
    })).toMatchObject({ status: "reattach_active", pid: 4242 });

    const exitPlan = onlyAttempt(environment);
    expect(exitPlan).toMatchObject({ kind: "record_active_exit", outcome: "uncertain" });
    const exited = reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan: exitPlan,
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    expect(exited).toMatchObject({ status: "committed", idempotent: false });
    expect(reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan: exitPlan,
      actorId: "recovery",
      now: () => new Date(NOW)
    })).toMatchObject({ status: "committed", idempotent: true });

    const settling = onlyAttempt(environment);
    expect(settling.kind).toBe("settle_exited");
    if (settling.kind !== "settle_exited") return;
    const headBeforeFault = environment.store.head().headSeq;
    const settlementEffect = event("message.posted", "settlement-effect", {
      expectedVersion: taskVersion(environment.store),
      payload: { messageId: "settlement-effect", from: "recovery", to: "parent", body: "provider result reconciled" }
    });
    fault = "after-cursor-write";
    expectReconcileCode(() => completeExitedSettlement({
      store: environment.store,
      plan: settling,
      events: [settlementEffect]
    }), "COMMIT_FAILED");
    expect(environment.store.head().headSeq).toBe(headBeforeFault);
    expect(environment.store.readConsumerCursor(settling.consumerId)).toBeUndefined();
    expect(environment.store.getProjection().messages.some((message) => message.messageId === "settlement-effect")).toBe(false);
    fault = undefined;
    const settled = completeExitedSettlement({ store: environment.store, plan: settling, events: [settlementEffect] });
    expect(settled).toMatchObject({ status: "committed", cursor: { lastSeq: settling.exitedSeq } });
    expect(settled.events).toHaveLength(1);
    expect(environment.store.getProjection().messages.some((message) => message.messageId === "settlement-effect")).toBe(true);
    expect(completeExitedSettlement({ store: environment.store, plan: settling })).toMatchObject({ status: "already_settled" });
    const after = onlyAttempt(environment, { settledThroughSeq: settled.cursor.lastSeq });
    expect(after).toMatchObject({ kind: "already_settled", exitedSeq: settling.exitedSeq });
  });

  it("atomically records start and exit when a planned spawn completed before start was persisted", () => {
    const environment = setup();
    prepare(environment);
    appendTaskEvent(environment.store, "attempt.launch_planned", "launch-plan", attemptPayload({ launchId: "launch-1" }));
    const plan = onlyAttempt(environment, {
      inspectLaunch: () => ({
        state: "exited-match",
        launchId: "launch-1",
        pid: 5151,
        processStartToken: "78910",
        exitCode: 0,
        outcome: "succeeded",
        summary: "provider completed before daemon restart"
      })
    });
    expect(plan.kind).toBe("record_start_and_exit");
    const result = reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan,
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    expect(result).toMatchObject({ status: "committed", idempotent: false });
    if (result.status === "committed") expect(result.seqs).toHaveLength(2);
    expect(environment.store.getProjection().attempts["attempt-1"]).toMatchObject({
      state: "exited",
      launchId: "launch-1",
      pid: 5151,
      processStartToken: "78910",
      outcome: "succeeded",
      exitCode: 0
    });
  });

  it("explicitly abandons a proven-never-started attempt and never manufactures a replacement", () => {
    const environment = setup();
    prepare(environment);
    const plan = onlyAttempt(environment, { decidePrepared: () => "abandon" });
    expect(plan).toMatchObject({ kind: "abandon_prepared", reasonCode: "OPERATOR_ABANDONED" });
    const result = reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan,
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    expect(result).toMatchObject({ status: "committed" });
    const projection = environment.store.getProjection();
    expect(projection.attempts["attempt-1"]).toMatchObject({ state: "abandoned", abandonReason: "OPERATOR_ABANDONED" });
    expect(Object.keys(projection.attempts)).toEqual(["attempt-1"]);
    expect(onlyAttempt(environment)).toMatchObject({ kind: "already_abandoned" });
  });

  it("durably refuses terminal-task pending commands while preserving included history", () => {
    const environment = setup();
    environment.service.admit(request(1));
    prepare(environment);
    environment.service.admit(request(2));
    appendTaskEvent(environment.store, "task.status_changed", "task-review", {
      role: "dev",
      status: "needs-review",
      summary: "ready"
    });
    appendTaskEvent(environment.store, "task.status_changed", "task-done", {
      role: "dev",
      status: "done",
      summary: "completed before next boundary"
    });

    const plan = planSteeringRecovery({
      repository: environment.repository,
      runDir: environment.root,
      inspectLaunch: () => ({ state: "absent-proven" })
    });
    expect(plan.restoredPendingCommandIds).toEqual([]);
    expect(plan.terminalPendingCommands.map((command) => command.commandId)).toEqual([commandId(2)]);
    expect(plan.attempts[0]).toMatchObject({ kind: "abandon_prepared", reasonCode: "VERIFIED_NEVER_STARTED" });
    const refused = reconcileTerminalPendingCommands({
      repository: environment.repository,
      plan,
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    expect(refused).toMatchObject({ status: "committed", commandIds: [commandId(2)] });
    expect(reconcileTerminalPendingCommands({
      repository: environment.repository,
      plan,
      actorId: "recovery",
      now: () => new Date(NOW)
    })).toMatchObject({ status: "already_terminal", idempotent: true });

    const afterRefusal = planSteeringRecovery({
      repository: environment.repository,
      runDir: environment.root,
      inspectLaunch: () => ({ state: "absent-proven" })
    });
    const abandon = afterRefusal.attempts[0]!;
    expect(abandon.kind).toBe("abandon_prepared");
    reconcileAttemptRecovery({
      repository: environment.repository,
      runDir: environment.root,
      plan: abandon,
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    const snapshot = environment.repository.snapshot();
    expect(snapshot.steering.commands[commandId(1)]?.status).toBe("included");
    expect(snapshot.steering.commands[commandId(2)]).toMatchObject({
      status: "refused",
      terminalRefusal: { reasonCode: "TASK_TERMINAL_BEFORE_INCLUSION", observedActivity: "exited" }
    });
    expect(snapshot.control.attempts["attempt-1"]?.state).toBe("abandoned");
  });

  it("terminalizes stored pending targets after task reopen and session-generation advance", () => {
    const reopened = setup();
    reopened.service.admit(request(1));
    appendTaskEvent(reopened.store, "task.status_changed", "task-review", {
      role: "dev", status: "needs-review", summary: "ready"
    });
    appendTaskEvent(reopened.store, "task.status_changed", "task-done", {
      role: "dev", status: "done", summary: "done"
    });
    appendTaskEvent(reopened.store, "task.reopened", "task-reopened", { newGeneration: 2, reason: "new work" });
    const reopenPlan = planSteeringRecovery({ repository: reopened.repository, runDir: reopened.root });
    expect(reopenPlan.terminalPendingCommands.map((command) => command.commandId)).toEqual([commandId(1)]);
    reconcileTerminalPendingCommands({ repository: reopened.repository, plan: reopenPlan, actorId: "recovery", now: () => new Date(NOW) });
    expect(reopened.repository.snapshot().steering.commands[commandId(1)]).toMatchObject({
      status: "refused",
      terminalRefusal: { reasonCode: "TASK_TERMINAL_BEFORE_INCLUSION" }
    });
    expect(reopened.store.getProjection().tasks["task-1"]?.generation).toBe(2);

    const advanced = setup();
    advanced.service.admit(request(2));
    advanced.store.append(event("runtime.observed", "runtime-exited-1", {
      expectedVersion: sessionVersion(advanced.store, 1),
      payload: { sessionId: "session-1", sessionGeneration: 1, observation: "exited", reason: "provider session ended" }
    }));
    advanced.store.append(event("runtime.observed", "runtime-generation-2", {
      expectedVersion: sessionVersion(advanced.store, 2),
      payload: { sessionId: "session-1", sessionGeneration: 2, observation: "waiting_input" }
    }));
    const sessionPlan = planSteeringRecovery({ repository: advanced.repository, runDir: advanced.root });
    expect(sessionPlan.terminalPendingCommands.map((command) => command.commandId)).toEqual([commandId(2)]);
    reconcileTerminalPendingCommands({ repository: advanced.repository, plan: sessionPlan, actorId: "recovery", now: () => new Date(NOW) });
    expect(advanced.repository.snapshot().steering.commands[commandId(2)]).toMatchObject({
      status: "refused",
      terminalRefusal: { reasonCode: "TASK_TERMINAL_BEFORE_INCLUSION", observedActivity: "exited" }
    });
    expect(advanced.store.getProjection().runtimes["session-1"]?.sessionGeneration).toBe(2);
  });

  it("survives a real hard kill after capture and launches a real provider from persisted bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-steering-hard-kill-"));
    roots.push(root);
    const path = join(root, "control.sqlite");
    const marker = join(root, "captured.marker");
    const fixture = resolve("tests/fixtures/steering-crash-run.ts");
    const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), fixture, "prepare-crash", path, root, marker], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    const ended = await waitForExit(child, true);
    expect(ended.signal === "SIGKILL" || ended.code === 137).toBe(true);
    expect(existsSync(marker)).toBe(true);

    const store = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1", create: false, now: () => NOW });
    stores.push(store);
    const repository = new SteeringRepository(store);
    const first = planSteeringRecovery({ repository, runDir: root, inspectLaunch: () => ({ state: "absent-proven" }) }).attempts[0]!;
    expect(first.kind).toBe("resume_prepared");
    const launchPlan = reconcileAttemptRecovery({
      repository,
      runDir: root,
      plan: first,
      launchId: "launch-after-crash",
      actorId: "recovery",
      now: () => new Date(NOW)
    });
    expect(launchPlan.status).toBe("launch_planned");
    const readyPlan = planSteeringRecovery({ repository, runDir: root, inspectLaunch: () => ({ state: "absent-proven" }) }).attempts[0]!;
    const ready = reconcileAttemptRecovery({ repository, runDir: root, plan: readyPlan, actorId: "recovery" });
    expect(ready.status).toBe("ready_to_launch");
    if (ready.status !== "ready_to_launch") return;

    const recordPath = join(root, "provider-result.json");
    const provider = spawnSync(process.execPath, [resolve("tests/fixtures/steering-provider.mjs"), "--record", recordPath], {
      input: ready.content,
      encoding: "buffer"
    });
    expect(provider.status).toBe(0);
    const observed = JSON.parse(readFileSync(recordPath, "utf8")) as {
      pid: number;
      processStartToken: string;
      bytes: number;
      sha256: string;
      contentBase64: string;
    };
    expect(Buffer.from(observed.contentBase64, "base64")).toEqual(ready.content);
    expect(observed.bytes).toBe(ready.content.byteLength);
    expect(observed.sha256).toBe(ready.artifactSha256);

    const finished = planSteeringRecovery({
      repository,
      runDir: root,
      inspectLaunch: () => ({
        state: "exited-match",
        launchId: ready.launchId,
        pid: observed.pid,
        processStartToken: observed.processStartToken,
        outcome: "succeeded",
        exitCode: 0,
        summary: "fixture provider exited"
      })
    }).attempts[0]!;
    expect(finished.kind).toBe("record_start_and_exit");
    reconcileAttemptRecovery({ repository, runDir: root, plan: finished, actorId: "recovery", now: () => new Date(NOW) });
    expect(store.getProjection().attempts["attempt-1"]).toMatchObject({ state: "exited", outcome: "succeeded" });
  });

  it("serializes a real two-process active-exit race into one event and one idempotent result", async () => {
    const environment = setup();
    makeActive(environment);
    const fixture = resolve("tests/fixtures/steering-crash-run.ts");
    const spawnWorker = () => {
      const child = spawn(process.execPath, [
        resolve("node_modules/tsx/dist/cli.mjs"),
        fixture,
        "reconcile-active",
        environment.path,
        environment.root
      ], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      return child;
    };
    const first = spawnWorker();
    const second = spawnWorker();
    await Promise.all([waitForMessage(first, "ready"), waitForMessage(second, "ready")]);
    const firstResult = waitForMessage(first, "result");
    const secondResult = waitForMessage(second, "result");
    first.send("go");
    second.send("go");
    const messages = await Promise.all([firstResult, secondResult]);
    await Promise.all([waitForExit(first), waitForExit(second)]);
    const results = messages.map((message) => message.result as { status: string; idempotent: boolean });
    expect(results.map((result) => result.status)).toEqual(["committed", "committed"]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    const exits = environment.store.readRange({ afterSeq: 0 }).events.filter((item) => item.type === "attempt.exited");
    expect(exits).toHaveLength(1);
    expect(environment.store.getProjection().attempts["attempt-1"]?.state).toBe("exited");
  });
});
