import { createHash } from "node:crypto";
import { parseControlEvent, type ControlEvent } from "../control/events.js";
import type { ControlProjection } from "../control/reducer.js";
import type {
  AppendResult,
  ConsumerCursor,
  ControlStore
} from "../control/store.js";
import {
  PromptArtifactError,
  readVerifiedPromptArtifact
} from "./prompt-manifest.js";
import type {
  SteeringRepository,
  SteeringRepositorySnapshot
} from "./repository.js";
import {
  STEERING_SETTLEMENT_CONSUMER_ID,
  type AttemptRecoveryPlan,
  type SteeringRecoveryPlan,
  type TerminalPendingCommandPlan
} from "./recovery.js";
import { steeringCommandSemanticDigest } from "./schema.js";
import type { SteeringCommandRecord, SteeringTerminalRefusedRecord } from "./types.js";

export type SteeringReconcileRepository = Pick<SteeringRepository, "runId" | "runEpoch" | "snapshot" | "appendAtHead">;

export type SteeringReconcileErrorCode =
  | "INVALID_PLAN"
  | "STALE_PLAN"
  | "BLOCKED_ARTIFACT"
  | "BLOCKED_IDENTITY"
  | "BLOCKED_SCHEMA"
  | "DIVERGENT_RECOVERY"
  | "COMMIT_FAILED";

export class SteeringReconcileError extends Error {
  constructor(
    readonly code: SteeringReconcileErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SteeringReconcileError";
  }
}

export type AttemptReconcileResult =
  | {
      readonly status: "ready_to_launch";
      readonly attemptId: string;
      readonly launchId: string;
      readonly content: Buffer;
      readonly artifactSha256: string;
    }
  | {
      readonly status: "launch_planned";
      readonly attemptId: string;
      readonly launchId: string;
      readonly seq: number;
      readonly idempotent: boolean;
      readonly replanRequired: true;
    }
  | {
      readonly status: "reattach_active";
      readonly attemptId: string;
      readonly launchId: string;
      readonly pid: number;
      readonly processStartToken: string;
    }
  | {
      readonly status: "settlement_required";
      readonly attemptId: string;
      readonly exitedSeq: number;
      readonly consumerId: typeof STEERING_SETTLEMENT_CONSUMER_ID;
      readonly expectedCursorSeq: number;
    }
  | {
      readonly status: "already_terminal";
      readonly attemptId: string;
      readonly terminalSeq: number;
      readonly terminalState: "settled" | "abandoned";
    }
  | {
      readonly status: "committed";
      readonly attemptId: string;
      readonly seqs: readonly number[];
      readonly idempotent: boolean;
    };

export type ReconcileAttemptOptions = {
  readonly repository: SteeringReconcileRepository;
  readonly runDir: string;
  readonly plan: AttemptRecoveryPlan;
  readonly actorId: string;
  /** Required only when a resume plan does not yet have a durable launch intent. */
  readonly launchId?: string;
  readonly now?: () => Date;
};

export type TerminalReconcileResult = {
  readonly status: "committed" | "already_terminal";
  readonly commandIds: readonly string[];
  readonly seqs: readonly number[];
  readonly idempotent: boolean;
};

export type ReconcileTerminalOptions = {
  readonly repository: SteeringReconcileRepository;
  readonly plan: SteeringRecoveryPlan;
  readonly actorId: string;
  readonly now?: () => Date;
};

export type SteeringSettlementStore = Pick<
  ControlStore,
  "runId" | "runEpoch" | "readConsumerCursor" | "appendBatchWithCursor"
>;

export type CompleteSettlementOptions = {
  readonly store: SteeringSettlementStore;
  readonly plan: Extract<AttemptRecoveryPlan, { kind: "settle_exited" }>;
  /** Canonical effects derived from the provider result; committed atomically with the cursor. */
  readonly events?: readonly ControlEvent[];
  /** One for a new cursor; increase only after an explicit consumer reset. */
  readonly cursorGeneration?: number;
};

export type SettlementResult = {
  readonly status: "committed" | "already_settled";
  readonly events: readonly AppendResult[];
  readonly cursor: ConsumerCursor;
};

function stableEventId(prefix: string, identity: string): string {
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 40);
  return `${prefix}.${digest}`;
}

function taskVersion(projection: ControlProjection, taskId: string, generation: number): number {
  return projection.aggregateVersions[`task:${taskId}:${generation}`]?.version ?? 0;
}

function sessionVersion(projection: ControlProjection, sessionId: string, generation: number): number {
  return projection.aggregateVersions[`session:${sessionId}:${generation}`]?.version ?? 0;
}

function common(
  repository: SteeringReconcileRepository,
  plan: Pick<AttemptRecoveryPlan, "taskId" | "taskGeneration">,
  actorId: string,
  occurredAt: string
) {
  return {
    schemaVersion: 1 as const,
    runId: repository.runId,
    runEpoch: repository.runEpoch,
    taskId: plan.taskId,
    taskGeneration: plan.taskGeneration,
    occurredAt,
    actorKind: "system" as const,
    actorId,
    sourceKind: null,
    sourceId: null,
    sourceGeneration: null,
    sourceEventId: null
  };
}

function assertRunIdentity(repository: SteeringReconcileRepository, plan: SteeringRecoveryPlan | AttemptRecoveryPlan): void {
  if (plan.runId !== repository.runId || plan.runEpoch !== repository.runEpoch) {
    throw new SteeringReconcileError("INVALID_PLAN", "recovery plan belongs to another run identity");
  }
}

function verifyArtifactNow(runDir: string, plan: Extract<AttemptRecoveryPlan, { artifact: unknown }>): Buffer {
  try {
    const verified = readVerifiedPromptArtifact(
      runDir,
      plan.artifact.locator,
      plan.artifact.bytes,
      plan.artifact.sha256
    );
    if (verified.dev !== plan.artifact.dev || verified.ino !== plan.artifact.ino) {
      throw new SteeringReconcileError("BLOCKED_ARTIFACT", "prompt artifact inode changed after recovery planning");
    }
    return Buffer.from(verified.content);
  } catch (error) {
    if (error instanceof SteeringReconcileError) throw error;
    if (error instanceof PromptArtifactError) {
      throw new SteeringReconcileError("BLOCKED_ARTIFACT", error.message, { cause: error });
    }
    throw new SteeringReconcileError("BLOCKED_ARTIFACT", "prompt artifact verification failed", { cause: error as Error });
  }
}

function assertAttemptPlan(snapshot: SteeringRepositorySnapshot, plan: AttemptRecoveryPlan): void {
  const attempt = snapshot.control.attempts[plan.attemptId];
  if (
    !attempt ||
    attempt.attemptGeneration !== plan.attemptGeneration ||
    attempt.taskId !== plan.taskId ||
    attempt.taskGeneration !== plan.taskGeneration ||
    attempt.sessionId !== plan.sessionId ||
    attempt.sessionGeneration !== plan.sessionGeneration ||
    attempt.preparedSeq !== plan.preparedSeq
  ) {
    throw new SteeringReconcileError("DIVERGENT_RECOVERY", "canonical attempt identity differs from the recovery plan");
  }
}

function exactAttemptOutcome(snapshot: SteeringRepositorySnapshot, plan: AttemptRecoveryPlan): AttemptReconcileResult | undefined {
  const attempt = snapshot.control.attempts[plan.attemptId];
  if (!attempt) return undefined;
  if (plan.kind === "abandon_prepared" && attempt.state === "abandoned") {
    if (attempt.abandonReason !== plan.reasonCode || !attempt.abandonedSeq) {
      throw new SteeringReconcileError("DIVERGENT_RECOVERY", "attempt was abandoned with another reason");
    }
    return { status: "committed", attemptId: attempt.attemptId, seqs: [attempt.abandonedSeq], idempotent: true };
  }
  if (plan.kind === "record_started" && (attempt.state === "active" || attempt.state === "exited")) {
    if (
      attempt.launchId !== plan.launch.launchId ||
      attempt.pid !== plan.launch.pid ||
      attempt.processStartToken !== plan.launch.processStartToken ||
      !attempt.startedSeq
    ) {
      throw new SteeringReconcileError("DIVERGENT_RECOVERY", "attempt start identity differs from recovery evidence");
    }
    return { status: "committed", attemptId: attempt.attemptId, seqs: [attempt.startedSeq], idempotent: true };
  }
  if (plan.kind === "record_start_and_exit" && attempt.state === "exited") {
    const outcome = plan.launch.outcome ?? "uncertain";
    if (
      attempt.launchId !== plan.launch.launchId ||
      attempt.pid !== plan.launch.pid ||
      attempt.processStartToken !== plan.launch.processStartToken ||
      attempt.outcome !== outcome ||
      attempt.exitCode !== plan.launch.exitCode ||
      attempt.summary !== plan.launch.summary ||
      !attempt.startedSeq ||
      !attempt.exitedSeq
    ) {
      throw new SteeringReconcileError("DIVERGENT_RECOVERY", "canonical start/exit facts differ from recovery evidence");
    }
    return { status: "committed", attemptId: attempt.attemptId, seqs: [attempt.startedSeq, attempt.exitedSeq], idempotent: true };
  }
  if (plan.kind === "record_active_exit" && attempt.state === "exited") {
    if (
      attempt.launchId !== plan.launchId ||
      attempt.outcome !== plan.outcome ||
      attempt.exitCode !== plan.exitCode ||
      attempt.summary !== plan.summary ||
      !attempt.exitedSeq
    ) {
      throw new SteeringReconcileError("DIVERGENT_RECOVERY", "canonical exit fact differs from recovery evidence");
    }
    return { status: "committed", attemptId: attempt.attemptId, seqs: [attempt.exitedSeq], idempotent: true };
  }
  return undefined;
}

function appendOrResolve(
  options: ReconcileAttemptOptions,
  events: readonly ControlEvent[]
): AttemptReconcileResult {
  try {
    const receipts = options.repository.appendAtHead(options.plan.expectedHeadSeq, events);
    return {
      status: "committed",
      attemptId: options.plan.attemptId,
      seqs: receipts.map((receipt) => receipt.seq),
      idempotent: receipts.every((receipt) => receipt.idempotent)
    };
  } catch (error) {
    let snapshot: SteeringRepositorySnapshot;
    try {
      snapshot = options.repository.snapshot();
    } catch {
      throw new SteeringReconcileError("COMMIT_FAILED", "canonical recovery write failed", { cause: error as Error });
    }
    const exact = exactAttemptOutcome(snapshot, options.plan);
    if (exact) return exact;
    throw new SteeringReconcileError(
      snapshot.headSeq === options.plan.expectedHeadSeq ? "COMMIT_FAILED" : "STALE_PLAN",
      "canonical history changed before recovery could commit",
      { cause: error as Error }
    );
  }
}

function launchPlannedOutcome(
  snapshot: SteeringRepositorySnapshot,
  plan: Extract<AttemptRecoveryPlan, { kind: "resume_prepared" }>,
  launchId: string
): AttemptReconcileResult | undefined {
  const attempt = snapshot.control.attempts[plan.attemptId];
  if (attempt?.launchId !== launchId) return undefined;
  if (!attempt.launchPlannedSeq) {
    throw new SteeringReconcileError("DIVERGENT_RECOVERY", "attempt has a launch ID without a launch-planned sequence");
  }
  return {
    status: "launch_planned",
    attemptId: attempt.attemptId,
    launchId,
    seq: attempt.launchPlannedSeq,
    idempotent: true,
    replanRequired: true
  };
}

function appendLaunchPlan(
  options: ReconcileAttemptOptions,
  plan: Extract<AttemptRecoveryPlan, { kind: "resume_prepared" }>,
  snapshot: SteeringRepositorySnapshot,
  launchId: string,
  occurredAt: string
): AttemptReconcileResult {
  const event = parseControlEvent({
    ...common(options.repository, plan, options.actorId, occurredAt),
    eventId: stableEventId("attempt.launch-plan", `${plan.attemptId}:${launchId}`),
    expectedVersion: taskVersion(snapshot.control, plan.taskId, plan.taskGeneration),
    type: "attempt.launch_planned",
    payload: {
      attemptId: plan.attemptId,
      attemptGeneration: plan.attemptGeneration,
      sessionId: plan.sessionId,
      sessionGeneration: plan.sessionGeneration,
      launchId
    }
  });
  try {
    const receipt = options.repository.appendAtHead(plan.expectedHeadSeq, [event])[0];
    if (!receipt) throw new Error("launch-plan transaction returned no receipt");
    return {
      status: "launch_planned",
      attemptId: plan.attemptId,
      launchId,
      seq: receipt.seq,
      idempotent: receipt.idempotent,
      replanRequired: true
    };
  } catch (error) {
    const current = options.repository.snapshot();
    const exact = launchPlannedOutcome(current, plan, launchId);
    if (exact) return exact;
    throw new SteeringReconcileError(
      current.headSeq === plan.expectedHeadSeq ? "COMMIT_FAILED" : "STALE_PLAN",
      "launch intent did not commit at the planned canonical head",
      { cause: error as Error }
    );
  }
}

export function reconcileAttemptRecovery(options: ReconcileAttemptOptions): AttemptReconcileResult {
  assertRunIdentity(options.repository, options.plan);
  if (options.plan.kind === "blocked_artifact") {
    throw new SteeringReconcileError("BLOCKED_ARTIFACT", options.plan.detail);
  }
  if (options.plan.kind === "blocked_identity") {
    throw new SteeringReconcileError("BLOCKED_IDENTITY", options.plan.detail);
  }
  if (options.plan.kind === "blocked_schema") {
    throw new SteeringReconcileError("BLOCKED_SCHEMA", options.plan.detail);
  }

  const snapshot = options.repository.snapshot();
  assertAttemptPlan(snapshot, options.plan);
  const exact = exactAttemptOutcome(snapshot, options.plan);
  if (exact) return exact;
  if (snapshot.headSeq !== options.plan.expectedHeadSeq) {
    throw new SteeringReconcileError("STALE_PLAN", "recovery plan no longer observes the canonical head");
  }

  if (options.plan.kind === "already_settled") {
    return {
      status: "already_terminal",
      attemptId: options.plan.attemptId,
      terminalSeq: options.plan.exitedSeq,
      terminalState: "settled"
    };
  }
  if (options.plan.kind === "already_abandoned") {
    return {
      status: "already_terminal",
      attemptId: options.plan.attemptId,
      terminalSeq: options.plan.abandonedSeq,
      terminalState: "abandoned"
    };
  }
  if (options.plan.kind === "settle_exited") {
    return {
      status: "settlement_required",
      attemptId: options.plan.attemptId,
      exitedSeq: options.plan.exitedSeq,
      consumerId: options.plan.consumerId,
      expectedCursorSeq: options.plan.expectedCursorSeq
    };
  }

  if (options.plan.kind === "abandon_prepared") {
    const occurredAt = (options.now ?? (() => new Date()))().toISOString();
    const event = parseControlEvent({
      ...common(options.repository, options.plan, options.actorId, occurredAt),
      eventId: stableEventId("attempt.abandon", `${options.plan.attemptId}:${options.plan.reasonCode}`),
      expectedVersion: taskVersion(snapshot.control, options.plan.taskId, options.plan.taskGeneration),
      type: "attempt.abandoned",
      payload: {
        attemptId: options.plan.attemptId,
        attemptGeneration: options.plan.attemptGeneration,
        sessionId: options.plan.sessionId,
        sessionGeneration: options.plan.sessionGeneration,
        reasonCode: options.plan.reasonCode,
        summary: options.plan.reasonCode === "VERIFIED_NEVER_STARTED"
          ? "task became terminal before the prepared attempt started"
          : options.plan.reasonCode === "ARTIFACT_UNRECOVERABLE"
            ? "prepared prompt artifact failed immutable recovery verification"
            : "prepared attempt explicitly abandoned during recovery"
      }
    });
    return appendOrResolve(options, [event]);
  }

  const content = verifyArtifactNow(options.runDir, options.plan);
  if (options.plan.kind === "resume_prepared") {
    const launchId = options.plan.launchId ?? options.launchId;
    if (!launchId) {
      throw new SteeringReconcileError("INVALID_PLAN", "a fresh durable launch ID is required before provider spawn");
    }
    if (!options.plan.launchId) {
      return appendLaunchPlan(options, options.plan, snapshot, launchId, (options.now ?? (() => new Date()))().toISOString());
    }
    return {
      status: "ready_to_launch",
      attemptId: options.plan.attemptId,
      launchId,
      content,
      artifactSha256: options.plan.artifact.sha256
    };
  }
  if (options.plan.kind === "reattach_active") {
    return {
      status: "reattach_active",
      attemptId: options.plan.attemptId,
      launchId: options.plan.launch.launchId,
      pid: options.plan.launch.pid,
      processStartToken: options.plan.launch.processStartToken
    };
  }

  const occurredAt = (options.now ?? (() => new Date()))().toISOString();
  const taskAggregateVersion = taskVersion(snapshot.control, options.plan.taskId, options.plan.taskGeneration);
  const eventBase = common(options.repository, options.plan, options.actorId, occurredAt);
  let events: ControlEvent[];
  if (options.plan.kind === "record_started") {
    events = [parseControlEvent({
      ...eventBase,
      eventId: stableEventId("attempt.recover-start", `${options.plan.attemptId}:${options.plan.launch.launchId}`),
      expectedVersion: taskAggregateVersion,
      type: "attempt.started",
      payload: {
        attemptId: options.plan.attemptId,
        attemptGeneration: options.plan.attemptGeneration,
        sessionId: options.plan.sessionId,
        sessionGeneration: options.plan.sessionGeneration,
        launchId: options.plan.launch.launchId,
        pid: options.plan.launch.pid,
        processStartToken: options.plan.launch.processStartToken
      }
    })];
  } else if (options.plan.kind === "record_start_and_exit") {
    if (options.plan.launch.pid === undefined || options.plan.launch.processStartToken === undefined) {
      throw new SteeringReconcileError("BLOCKED_IDENTITY", "an exited pre-record process lacks exact pid/start-token identity");
    }
    events = [
      parseControlEvent({
        ...eventBase,
        eventId: stableEventId("attempt.recover-start", `${options.plan.attemptId}:${options.plan.launch.launchId}`),
        expectedVersion: taskAggregateVersion,
        type: "attempt.started",
        payload: {
          attemptId: options.plan.attemptId,
          attemptGeneration: options.plan.attemptGeneration,
          sessionId: options.plan.sessionId,
          sessionGeneration: options.plan.sessionGeneration,
          launchId: options.plan.launch.launchId,
          pid: options.plan.launch.pid,
          processStartToken: options.plan.launch.processStartToken
        }
      }),
      parseControlEvent({
        ...eventBase,
        eventId: stableEventId("attempt.recover-exit", `${options.plan.attemptId}:${options.plan.launch.launchId}`),
        expectedVersion: taskAggregateVersion + 1,
        type: "attempt.exited",
        payload: {
          attemptId: options.plan.attemptId,
          attemptGeneration: options.plan.attemptGeneration,
          sessionId: options.plan.sessionId,
          sessionGeneration: options.plan.sessionGeneration,
          outcome: options.plan.launch.outcome ?? "uncertain",
          exitCode: options.plan.launch.exitCode,
          summary: options.plan.launch.summary
        }
      })
    ];
  } else {
    events = [parseControlEvent({
      ...eventBase,
      eventId: stableEventId("attempt.recover-exit", `${options.plan.attemptId}:${options.plan.launchId}`),
      expectedVersion: taskAggregateVersion,
      type: "attempt.exited",
      payload: {
        attemptId: options.plan.attemptId,
        attemptGeneration: options.plan.attemptGeneration,
        sessionId: options.plan.sessionId,
        sessionGeneration: options.plan.sessionGeneration,
        outcome: options.plan.outcome,
        exitCode: options.plan.exitCode,
        summary: options.plan.summary
      }
    })];
  }
  return appendOrResolve(options, events);
}

function terminalRefusal(record: SteeringCommandRecord | undefined): SteeringTerminalRefusedRecord | undefined {
  return record?.status === "refused" && "terminalRefusal" in record ? record : undefined;
}

function exactTerminalPlans(
  snapshot: SteeringRepositorySnapshot,
  plans: readonly TerminalPendingCommandPlan[]
): number[] | undefined {
  const seqs: number[] = [];
  for (const plan of plans) {
    const record = terminalRefusal(snapshot.steering.commands[plan.commandId]);
    if (!record) return undefined;
    if (
      record.command.taskId !== plan.taskId ||
      record.command.taskGeneration !== plan.taskGeneration ||
      record.command.sessionId !== plan.sessionId ||
      record.command.sessionGeneration !== plan.sessionGeneration ||
      record.terminalRefusal.reasonCode !== plan.reasonCode ||
      record.terminalRefusal.observedSeq !== plan.observedSeq ||
      record.terminalRefusal.observedActivity !== plan.observedActivity
    ) {
      throw new SteeringReconcileError("DIVERGENT_RECOVERY", `terminal refusal for ${plan.commandId} differs from the plan`);
    }
    seqs.push(record.terminalSeq);
  }
  return seqs;
}

function buildTerminalEvents(
  options: ReconcileTerminalOptions,
  snapshot: SteeringRepositorySnapshot,
  occurredAt: string
): ControlEvent[] {
  const nextVersions = new Map<string, number>();
  return options.plan.terminalPendingCommands.map((plan) => {
    const record = snapshot.steering.commands[plan.commandId];
    if (record?.status !== "pending") {
      throw new SteeringReconcileError("STALE_PLAN", `steering command ${plan.commandId} is no longer pending`);
    }
    const key = `${plan.sessionId}:${plan.sessionGeneration}`;
    const expectedVersion = nextVersions.get(key) ?? sessionVersion(snapshot.control, plan.sessionId, plan.sessionGeneration);
    nextVersions.set(key, expectedVersion + 1);
    return parseControlEvent({
      schemaVersion: 1,
      eventId: stableEventId("steering.terminal-refuse", plan.commandId),
      runId: options.repository.runId,
      runEpoch: options.repository.runEpoch,
      taskId: plan.taskId,
      taskGeneration: plan.taskGeneration,
      expectedVersion,
      occurredAt,
      actorKind: "control-plane",
      actorId: options.actorId,
      sourceKind: null,
      sourceId: null,
      sourceGeneration: null,
      sourceEventId: null,
      type: "steering.command_terminal_refused",
      payload: {
        commandId: plan.commandId,
        sessionId: plan.sessionId,
        sessionGeneration: plan.sessionGeneration,
        requestSemanticDigest: steeringCommandSemanticDigest(record.command),
        observedSeq: plan.observedSeq,
        observedActivity: plan.observedActivity,
        reasonCode: plan.reasonCode
      }
    });
  });
}

export function reconcileTerminalPendingCommands(options: ReconcileTerminalOptions): TerminalReconcileResult {
  assertRunIdentity(options.repository, options.plan);
  const commandIds = options.plan.terminalPendingCommands.map((plan) => plan.commandId);
  if (commandIds.length === 0) return { status: "already_terminal", commandIds, seqs: [], idempotent: true };
  let snapshot = options.repository.snapshot();
  const existing = exactTerminalPlans(snapshot, options.plan.terminalPendingCommands);
  if (existing) return { status: "already_terminal", commandIds, seqs: existing, idempotent: true };
  if (snapshot.headSeq !== options.plan.headSeq) {
    throw new SteeringReconcileError("STALE_PLAN", "terminal-command plan no longer observes the canonical head");
  }
  const events = buildTerminalEvents(options, snapshot, (options.now ?? (() => new Date()))().toISOString());
  try {
    const receipts = options.repository.appendAtHead(options.plan.headSeq, events);
    return {
      status: "committed",
      commandIds,
      seqs: receipts.map((receipt) => receipt.seq),
      idempotent: receipts.every((receipt) => receipt.idempotent)
    };
  } catch (error) {
    snapshot = options.repository.snapshot();
    const exact = exactTerminalPlans(snapshot, options.plan.terminalPendingCommands);
    if (exact) return { status: "already_terminal", commandIds, seqs: exact, idempotent: true };
    throw new SteeringReconcileError(
      snapshot.headSeq === options.plan.headSeq ? "COMMIT_FAILED" : "STALE_PLAN",
      "terminal pending commands did not commit atomically",
      { cause: error as Error }
    );
  }
}

export function completeExitedSettlement(options: CompleteSettlementOptions): SettlementResult {
  if (options.store.runId !== options.plan.runId || options.store.runEpoch !== options.plan.runEpoch) {
    throw new SteeringReconcileError("INVALID_PLAN", "settlement plan belongs to another run identity");
  }
  const generation = options.cursorGeneration ?? 1;
  const current = options.store.readConsumerCursor(options.plan.consumerId);
  if (current && current.generation === generation && current.lastSeq >= options.plan.exitedSeq) {
    return { status: "already_settled", events: [], cursor: current };
  }
  if (current && current.generation !== generation) {
    throw new SteeringReconcileError("STALE_PLAN", "settlement cursor generation changed");
  }
  const expectedLastSeq = current?.lastSeq ?? options.plan.expectedCursorSeq;
  if (expectedLastSeq !== options.plan.expectedCursorSeq) {
    throw new SteeringReconcileError("STALE_PLAN", "settlement cursor advanced since recovery planning");
  }
  try {
    const result = options.store.appendBatchWithCursor(options.events ?? [], {
      consumerId: options.plan.consumerId,
      generation,
      expectedLastSeq,
      nextLastSeq: options.plan.exitedSeq
    });
    return { status: "committed", events: result.events, cursor: result.cursor };
  } catch (error) {
    const after = options.store.readConsumerCursor(options.plan.consumerId);
    if (after && after.generation === generation && after.lastSeq >= options.plan.exitedSeq) {
      return { status: "already_settled", events: [], cursor: after };
    }
    throw new SteeringReconcileError("COMMIT_FAILED", "settlement effects and cursor did not commit atomically", { cause: error as Error });
  }
}
