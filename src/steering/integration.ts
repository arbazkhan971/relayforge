import { createHash, randomUUID } from "node:crypto";
import { parseControlEvent, type ControlEvent } from "../control/events.js";
import type { AttemptFact, ControlProjection, TaskFact } from "../control/reducer.js";
import type { ControlStore } from "../control/store.js";
import { prepareAttemptPrompt, type PreparedAttemptPrompt } from "./capture.js";
import { SteeringRepository } from "./repository.js";
import { createSteeringCommandId } from "./schema.js";
import { createParentSteeringService } from "./service.js";
import type { SteeringSourceKind } from "./types.js";

export type DispatchSteeringTarget = {
  readonly taskId: string;
  readonly taskGeneration: number;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly attemptId: string;
  readonly attemptGeneration: number;
};

export type PreparedDispatchAttempt = PreparedAttemptPrompt & {
  readonly target: DispatchSteeringTarget;
};

export type AttemptExit = {
  readonly outcome: "succeeded" | "failed" | "cancelled" | "uncertain";
  readonly exitCode?: number;
  readonly summary?: string;
};

export class SteeringIntegrationError extends Error {
  constructor(
    readonly code: "AUTHORITY_UNAVAILABLE" | "TARGET_MISMATCH" | "CONCURRENT_UPDATE" | "INVALID_TRANSITION",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SteeringIntegrationError";
  }
}

function digestId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/** Stable, bounded identity for one role/task session. It contains no path or user-controlled separators. */
export function dispatchSteeringSessionId(role: string, taskId: string): string {
  return `session.${digestId(`${role}\0${taskId}`)}`;
}

/** Deterministic UUIDv7 for one canonical parent feedback fact, safe across crash/retry. */
export function internalSteeringCommandId(options: {
  occurredAt: string;
  runEpoch: string;
  taskId: string;
  taskGeneration: number;
  sourceKind: SteeringSourceKind;
  body: string;
}): string {
  const nowMs = Date.parse(options.occurredAt);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SteeringIntegrationError("TARGET_MISMATCH", "feedback timestamp is invalid");
  const entropy = createHash("sha256")
    .update(`${options.runEpoch}\0${options.taskId}\0${options.taskGeneration}\0${options.sourceKind}\0${options.body}`, "utf8")
    .digest()
    .subarray(0, 10);
  return createSteeringCommandId({ nowMs, random: entropy });
}

function taskOf(projection: ControlProjection, taskId: string): TaskFact {
  const task = projection.tasks[taskId];
  if (!task) throw new SteeringIntegrationError("TARGET_MISMATCH", `canonical task ${taskId} does not exist`);
  return task;
}

function aggregateVersion(projection: ControlProjection, key: string): number {
  return projection.aggregateVersions[key]?.version ?? 0;
}

function common(
  store: ControlStore,
  target: Pick<DispatchSteeringTarget, "taskId" | "taskGeneration">,
  actorId: string,
  occurredAt: string,
  eventId: string,
  expectedVersion: number
) {
  return {
    schemaVersion: 1 as const,
    eventId,
    runId: store.runId,
    runEpoch: store.runEpoch,
    taskId: target.taskId,
    taskGeneration: target.taskGeneration,
    expectedVersion,
    occurredAt,
    actorKind: "control-plane" as const,
    actorId,
    sourceKind: null,
    sourceId: null,
    sourceGeneration: null,
    sourceEventId: null
  };
}

function appendAtCurrentHead(store: ControlStore, event: ControlEvent): void {
  const expectedHeadSeq = store.getProjection().headSeq;
  try {
    store.appendBatchIf({ expectedHeadSeq, events: [event] });
  } catch (error) {
    throw new SteeringIntegrationError("CONCURRENT_UPDATE", `canonical steering lifecycle changed at sequence ${expectedHeadSeq}`, { cause: error as Error });
  }
}

function observeWaitingBoundary(options: {
  store: ControlStore;
  taskId: string;
  role: string;
  actorId: string;
  occurredAt: string;
}): { task: TaskFact; sessionId: string; sessionGeneration: number } {
  const projection = options.store.getProjection();
  const task = taskOf(projection, options.taskId);
  if (["done", "escalated"].includes(task.status)) {
    throw new SteeringIntegrationError("INVALID_TRANSITION", `task ${task.id} is terminal`);
  }
  const sessionId = dispatchSteeringSessionId(options.role, task.id);
  const prior = projection.runtimes[sessionId];
  if (prior && (
    prior.sessionGeneration !== 1 ||
    prior.taskId !== task.id ||
    prior.taskGeneration !== task.generation ||
    prior.observation === "exited"
  )) {
    throw new SteeringIntegrationError("TARGET_MISMATCH", `session ${sessionId} cannot be rebound to task ${task.id}`);
  }
  const sessionGeneration = 1;
  const expectedVersion = aggregateVersion(projection, `session:${sessionId}:${sessionGeneration}`);
  const event = parseControlEvent({
    ...common(
      options.store,
      { taskId: task.id, taskGeneration: task.generation },
      options.actorId,
      options.occurredAt,
      `runtime.boundary.${randomUUID()}`,
      expectedVersion
    ),
    type: "runtime.observed",
    payload: {
      sessionId,
      sessionGeneration,
      observation: "waiting_input",
      reason: "parent holds the controller lease at an immutable attempt-prompt boundary"
    }
  });
  appendAtCurrentHead(options.store, event);
  return { task, sessionId, sessionGeneration };
}

/**
 * Establish a durable safe boundary, capture one exact command cutoff, publish the immutable
 * prompt artifact, and return only the verified bytes. Generic board messages never enter here.
 */
export function prepareDispatchAttempt(options: {
  store: ControlStore;
  runDir: string;
  taskId: string;
  role: string;
  actorId: string;
  basePrompt: string | Uint8Array;
  feedback?: {
    readonly commandId: string;
    readonly sourceKind: SteeringSourceKind;
    readonly body: string;
    readonly evidenceRefs: readonly string[];
  };
  now?: () => Date;
}): PreparedDispatchAttempt {
  const now = options.now ?? (() => new Date());
  const occurredAt = now().toISOString();
  const boundary = observeWaitingBoundary({ ...options, occurredAt });
  const projection = options.store.getProjection();
  const priorAttempts = Object.values(projection.attempts).filter(
    (attempt) => attempt.taskId === boundary.task.id && attempt.taskGeneration === boundary.task.generation
  );
  const attemptGeneration = Math.max(0, ...priorAttempts.map((attempt) => attempt.attemptGeneration)) + 1;
  const attemptId = `attempt.${boundary.task.generation}.${attemptGeneration}.${digestId(`${boundary.task.id}\0${boundary.sessionId}`)}`;
  const target: DispatchSteeringTarget = {
    taskId: boundary.task.id,
    taskGeneration: boundary.task.generation,
    sessionId: boundary.sessionId,
    sessionGeneration: boundary.sessionGeneration,
    attemptId,
    attemptGeneration
  };
  if (options.feedback) {
    const service = createParentSteeringService({
      store: options.store,
      authority: { principal: options.actorId, sourceKind: options.feedback.sourceKind },
      now
    });
    service.admit({
      schemaVersion: 1,
      commandId: options.feedback.commandId,
      runId: options.store.runId,
      runEpoch: options.store.runEpoch,
      taskId: target.taskId,
      taskGeneration: target.taskGeneration,
      sessionId: target.sessionId,
      sessionGeneration: target.sessionGeneration,
      notBeforeAttemptGeneration: target.attemptGeneration,
      kind: "steer_next_boundary",
      evidenceRefs: [...options.feedback.evidenceRefs],
      body: options.feedback.body
    });
  }
  const prepared = prepareAttemptPrompt({
    repository: new SteeringRepository(options.store),
    runDir: options.runDir,
    ...target,
    basePrompt: options.basePrompt,
    actorId: options.actorId,
    now
  });
  return { ...prepared, target };
}

function requireAttempt(store: ControlStore, target: DispatchSteeringTarget): { projection: ControlProjection; attempt: AttemptFact; version: number } {
  const projection = store.getProjection();
  const attempt = projection.attempts[target.attemptId];
  if (!attempt ||
    attempt.taskId !== target.taskId ||
    attempt.taskGeneration !== target.taskGeneration ||
    attempt.attemptGeneration !== target.attemptGeneration ||
    attempt.sessionId !== target.sessionId ||
    attempt.sessionGeneration !== target.sessionGeneration) {
    throw new SteeringIntegrationError("TARGET_MISMATCH", `attempt ${target.attemptId} identity changed`);
  }
  const version = aggregateVersion(projection, `task:${target.taskId}:${target.taskGeneration}`);
  return { projection, attempt, version };
}

export function planDispatchLaunch(options: {
  store: ControlStore;
  target: DispatchSteeringTarget;
  launchId: string;
  actorId: string;
  now?: () => Date;
}): void {
  const { projection, attempt, version } = requireAttempt(options.store, options.target);
  if (attempt.state !== "prepared" || attempt.launchId !== undefined) {
    throw new SteeringIntegrationError("INVALID_TRANSITION", `attempt ${attempt.attemptId} cannot plan another launch`);
  }
  const occurredAt = (options.now ?? (() => new Date()))().toISOString();
  const event = parseControlEvent({
    ...common(options.store, options.target, options.actorId, occurredAt, `attempt.plan.${randomUUID()}`, version),
    type: "attempt.launch_planned",
    payload: {
      attemptId: options.target.attemptId,
      attemptGeneration: options.target.attemptGeneration,
      sessionId: options.target.sessionId,
      sessionGeneration: options.target.sessionGeneration,
      launchId: options.launchId
    }
  });
  try {
    options.store.appendBatchIf({ expectedHeadSeq: projection.headSeq, events: [event] });
  } catch (error) {
    throw new SteeringIntegrationError("CONCURRENT_UPDATE", "attempt launch plan lost its canonical head", { cause: error as Error });
  }
}

export function markDispatchStarted(options: {
  store: ControlStore;
  target: DispatchSteeringTarget;
  launchId: string;
  pid: number;
  processStartToken: string;
  actorId: string;
  now?: () => Date;
}): void {
  const { projection, attempt, version } = requireAttempt(options.store, options.target);
  if (attempt.state !== "prepared" || attempt.launchId !== options.launchId || attempt.launchPlannedSeq === undefined) {
    throw new SteeringIntegrationError("INVALID_TRANSITION", `attempt ${attempt.attemptId} has no matching launch plan`);
  }
  const event = parseControlEvent({
    ...common(options.store, options.target, options.actorId, (options.now ?? (() => new Date()))().toISOString(), `attempt.started.${randomUUID()}`, version),
    type: "attempt.started",
    payload: {
      attemptId: options.target.attemptId,
      attemptGeneration: options.target.attemptGeneration,
      sessionId: options.target.sessionId,
      sessionGeneration: options.target.sessionGeneration,
      launchId: options.launchId,
      pid: options.pid,
      processStartToken: options.processStartToken
    }
  });
  try {
    options.store.appendBatchIf({ expectedHeadSeq: projection.headSeq, events: [event] });
  } catch (error) {
    throw new SteeringIntegrationError("CONCURRENT_UPDATE", "attempt start lost its canonical head", { cause: error as Error });
  }
}

export function settleDispatchAttempt(options: {
  store: ControlStore;
  target: DispatchSteeringTarget;
  actorId: string;
  result: AttemptExit;
  now?: () => Date;
}): void {
  const { projection, attempt, version } = requireAttempt(options.store, options.target);
  const occurredAt = (options.now ?? (() => new Date()))().toISOString();
  let event: ControlEvent;
  if (attempt.state === "prepared") {
    event = parseControlEvent({
      ...common(options.store, options.target, options.actorId, occurredAt, `attempt.abandoned.${randomUUID()}`, version),
      type: "attempt.abandoned",
      payload: {
        attemptId: options.target.attemptId,
        attemptGeneration: options.target.attemptGeneration,
        sessionId: options.target.sessionId,
        sessionGeneration: options.target.sessionGeneration,
        reasonCode: "VERIFIED_NEVER_STARTED",
        summary: options.result.summary ?? "provider launch was refused before execution"
      }
    });
  } else if (attempt.state === "active") {
    event = parseControlEvent({
      ...common(options.store, options.target, options.actorId, occurredAt, `attempt.exited.${randomUUID()}`, version),
      type: "attempt.exited",
      payload: {
        attemptId: options.target.attemptId,
        attemptGeneration: options.target.attemptGeneration,
        sessionId: options.target.sessionId,
        sessionGeneration: options.target.sessionGeneration,
        outcome: options.result.outcome,
        ...(options.result.exitCode === undefined ? {} : { exitCode: options.result.exitCode }),
        ...(options.result.summary === undefined ? {} : { summary: options.result.summary })
      }
    });
  } else if (attempt.state === "exited" || attempt.state === "abandoned") {
    return;
  } else {
    throw new SteeringIntegrationError("INVALID_TRANSITION", `attempt ${attempt.attemptId} cannot be settled from ${attempt.state}`);
  }
  try {
    options.store.appendBatchIf({ expectedHeadSeq: projection.headSeq, events: [event] });
  } catch (error) {
    throw new SteeringIntegrationError("CONCURRENT_UPDATE", "attempt settlement lost its canonical head", { cause: error as Error });
  }
}
