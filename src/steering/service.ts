import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  parseControlEvent,
  type ControlActorKind,
  type ControlEvent
} from "../control/events.js";
import type { ControlProjection } from "../control/reducer.js";
import { ControlStoreError, type AppendResult, type ControlStore } from "../control/store.js";
import { deriveSteeringActivity } from "./activity.js";
import {
  SteeringBodySchema,
  SteeringBoundedIdSchema,
  SteeringCommandIdSchema,
  SteeringPositiveGenerationSchema,
  SteeringTimestampSchema,
  compareSteeringCommandSemantics,
  materializeSteeringCommand,
  sameSteeringTarget,
  steeringCommandSemanticDigest
} from "./schema.js";
import {
  SteeringRepository,
  SteeringRepositoryError,
  type SteeringRepositorySnapshot
} from "./repository.js";
import {
  STEERING_EVIDENCE_MAX_REFS
} from "./schema.js";
import {
  STEERING_SCHEMA_VERSION,
  steeringSourceKinds,
  type SteeringCommandRecord,
  type SteeringCommandV1,
  type SteeringRefusalReasonCode,
  type SteeringRefusalV1,
  type SteeringActivityState,
  type SteeringSourceKind
} from "./types.js";

const DEFAULT_CAS_RETRIES = 32;
const REQUEST_SOURCE_KIND = "steering-request";
const REQUEST_SOURCE_GENERATION = 1;

const admissionRequestSchema = z.strictObject({
  schemaVersion: z.literal(STEERING_SCHEMA_VERSION),
  commandId: SteeringCommandIdSchema,
  runId: SteeringBoundedIdSchema,
  runEpoch: SteeringBoundedIdSchema,
  taskId: SteeringBoundedIdSchema,
  taskGeneration: SteeringPositiveGenerationSchema,
  sessionId: SteeringBoundedIdSchema,
  sessionGeneration: SteeringPositiveGenerationSchema,
  notBeforeAttemptGeneration: SteeringPositiveGenerationSchema,
  kind: z.literal("steer_next_boundary"),
  evidenceRefs: z.array(SteeringBoundedIdSchema).max(STEERING_EVIDENCE_MAX_REFS).refine(
    (refs) => new Set(refs).size === refs.length,
    "evidence references must be unique"
  ),
  body: SteeringBodySchema,
  expiresAt: SteeringTimestampSchema.optional(),
  supersedesCommandId: SteeringCommandIdSchema.optional()
});

const withdrawalRequestSchema = z.strictObject({
  schemaVersion: z.literal(STEERING_SCHEMA_VERSION),
  commandId: SteeringCommandIdSchema,
  reason: z.string().min(1).max(4_096).optional()
});

const expiryRequestSchema = z.strictObject({
  schemaVersion: z.literal(STEERING_SCHEMA_VERSION),
  commandId: SteeringCommandIdSchema
});

export type SteeringAdmissionRequest = z.infer<typeof admissionRequestSchema>;
export type SteeringWithdrawalRequest = z.infer<typeof withdrawalRequestSchema>;
export type SteeringExpiryRequest = z.infer<typeof expiryRequestSchema>;

export type ParentSteeringAuthority = {
  /** Authenticated identity assigned by the parent control plane, never copied from request JSON. */
  readonly principal: string;
  /** Trusted provenance assigned by the parent control plane, never copied from request JSON. */
  readonly sourceKind: SteeringSourceKind;
};

export type ParentSteeringServiceOptions = {
  readonly store: ControlStore;
  readonly authority: ParentSteeringAuthority;
  readonly now?: () => Date;
  readonly maxCasRetries?: number;
};

export type SteeringAdmissionResult =
  | {
      readonly decision: "admitted";
      readonly commandId: string;
      readonly seq: number;
      readonly command: SteeringCommandV1;
    }
  | {
      readonly decision: "refused";
      readonly commandId: string;
      readonly seq: number;
      readonly refusal: SteeringRefusalV1;
    };

export type SteeringWithdrawalResult = {
  readonly status: "withdrawn";
  readonly commandId: string;
  readonly seq: number;
  readonly reason?: string;
};

export type SteeringExpiryResult = {
  readonly status: "expired";
  readonly commandId: string;
  readonly seq: number;
};

export type SteeringServiceErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_AUTHORITY"
  | "COMMAND_ID_CONFLICT"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_TERMINAL"
  | "NOT_EXPIRED"
  | "RUN_IDENTITY_MISMATCH"
  | "CONTROL_STORE_UNAVAILABLE"
  | "CONCURRENT_UPDATE";

export class SteeringServiceError extends Error {
  constructor(
    readonly code: SteeringServiceErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SteeringServiceError";
  }
}

/**
 * Parent-only durable admission service. The authority is constructor state and the strict request
 * schemas contain no principal/source/actor fields, so provider output cannot self-declare control
 * authority. Keep this object in the daemon parent; provider children receive prompt bytes only.
 */
export class ParentSteeringService {
  private readonly repository: SteeringRepository;
  private readonly authority: Readonly<ParentSteeringAuthority>;
  private readonly now: () => Date;
  private readonly maxCasRetries: number;

  constructor(options: ParentSteeringServiceOptions) {
    let principal: string;
    try {
      principal = SteeringBoundedIdSchema.parse(options.authority.principal);
    } catch (error) {
      throw new SteeringServiceError("INVALID_AUTHORITY", "parent steering principal is invalid", undefined, { cause: asError(error) });
    }
    if (!(steeringSourceKinds as readonly string[]).includes(options.authority.sourceKind)) {
      throw new SteeringServiceError("INVALID_AUTHORITY", "parent steering source kind is invalid");
    }
    const maxCasRetries = options.maxCasRetries ?? DEFAULT_CAS_RETRIES;
    if (!Number.isSafeInteger(maxCasRetries) || maxCasRetries < 1 || maxCasRetries > 1_024) {
      throw new SteeringServiceError("INVALID_AUTHORITY", "maxCasRetries must be an integer from 1 through 1024");
    }
    this.repository = new SteeringRepository(options.store);
    this.authority = Object.freeze({ principal, sourceKind: options.authority.sourceKind });
    this.now = options.now ?? (() => new Date());
    this.maxCasRetries = maxCasRetries;
  }

  admit(value: unknown): SteeringAdmissionResult {
    const request = parseAdmissionRequest(value);
    const firstCreatedAt = this.timestamp();
    return this.casLoop<SteeringAdmissionResult>((snapshot) => {
      const existing = snapshot.steering.commands[request.commandId];
      if (existing) return { result: this.resolveExistingAdmission(snapshot, existing, request) };
      this.assertRunIdentity(request);

      const command = this.materialize(request, firstCreatedAt);
      const refusal = this.refusalDecision(snapshot, command, firstCreatedAt);
      const expectedVersion = sessionVersion(snapshot.control, command.sessionId, command.sessionGeneration);
      if (refusal) {
        const event = decisionEvent(command, refusal, snapshot.headSeq, expectedVersion, this.actorKind());
        return {
          events: [event],
          finish: (receipts) => refusalResult(command, refusal, snapshot.headSeq, requireReceipt(receipts, 0).seq)
        };
      }

      const events: ControlEvent[] = [admissionEvent(command, expectedVersion, this.actorKind())];
      if (command.supersedesCommandId) {
        events.push(supersessionEvent(command, command.supersedesCommandId, expectedVersion + 1, this.actorKind()));
      }
      return {
        events,
        finish: (receipts) => ({
          decision: "admitted" as const,
          commandId: command.commandId,
          seq: requireReceipt(receipts, 0).seq,
          command: structuredClone(command)
        })
      };
    });
  }

  withdraw(value: unknown): SteeringWithdrawalResult {
    const request = parseWithdrawalRequest(value);
    const occurredAt = this.timestamp();
    return this.casLoop<SteeringWithdrawalResult>((snapshot) => {
      const record = snapshot.steering.commands[request.commandId];
      if (!record) throw new SteeringServiceError("COMMAND_NOT_FOUND", `steering command ${request.commandId} does not exist`);
      if (record.status === "withdrawn") {
        const event = this.repository.eventAt(snapshot, record.terminalSeq);
        const expectedDigest = withdrawalRequestDigest(
          request.commandId,
          request.reason,
          this.authority.principal,
          this.authority.sourceKind
        );
        if (
          event.type !== "steering.command_withdrawn" ||
          event.payload.reason !== request.reason ||
          event.actorId !== this.authority.principal ||
          event.sourceEventId !== expectedDigest
        ) {
          throw new SteeringServiceError("COMMAND_ID_CONFLICT", `withdrawal retry for ${request.commandId} changed its reason`);
        }
        return { result: { status: "withdrawn", commandId: request.commandId, seq: record.terminalSeq, reason: record.reason } };
      }
      if (record.status !== "pending") {
        throw terminalError(request.commandId, record.status);
      }
      if (isManifestReserved(snapshot, request.commandId)) {
        throw new SteeringServiceError("COMMAND_TERMINAL", `steering command ${request.commandId} is already bound to a prepared prompt`);
      }
      const command = record.command;
      const expectedVersion = sessionVersion(snapshot.control, command.sessionId, command.sessionGeneration);
      const event = withdrawalEvent(
        command,
        request.reason,
        occurredAt,
        expectedVersion,
        this.actorKind(),
        this.authority.sourceKind
      );
      return {
        events: [event],
        finish: (receipts) => ({
          status: "withdrawn" as const,
          commandId: command.commandId,
          seq: requireReceipt(receipts, 0).seq,
          reason: request.reason
        })
      };
    });
  }

  expire(value: unknown): SteeringExpiryResult {
    const request = parseExpiryRequest(value);
    const occurredAt = this.timestamp();
    return this.casLoop<SteeringExpiryResult>((snapshot) => {
      const record = snapshot.steering.commands[request.commandId];
      if (!record) throw new SteeringServiceError("COMMAND_NOT_FOUND", `steering command ${request.commandId} does not exist`);
      if (record.status === "expired") {
        return { result: { status: "expired", commandId: request.commandId, seq: record.terminalSeq } };
      }
      if (record.status !== "pending") throw terminalError(request.commandId, record.status);
      if (isManifestReserved(snapshot, request.commandId)) {
        throw new SteeringServiceError("COMMAND_TERMINAL", `steering command ${request.commandId} is already bound to a prepared prompt`);
      }
      if (!record.command.expiresAt || Date.parse(occurredAt) < Date.parse(record.command.expiresAt)) {
        throw new SteeringServiceError("NOT_EXPIRED", `steering command ${request.commandId} has not reached its explicit expiry`);
      }
      const expectedVersion = sessionVersion(snapshot.control, record.command.sessionId, record.command.sessionGeneration);
      const event = expiryEvent(record.command, occurredAt, expectedVersion);
      return {
        events: [event],
        finish: (receipts) => ({
          status: "expired" as const,
          commandId: request.commandId,
          seq: requireReceipt(receipts, 0).seq
        })
      };
    });
  }

  private casLoop<T>(
    decide: (snapshot: SteeringRepositorySnapshot) =>
      | { readonly result: T }
      | { readonly events: readonly ControlEvent[]; readonly finish: (receipts: readonly AppendResult[]) => T }
  ): T {
    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      let snapshot: SteeringRepositorySnapshot;
      try {
        snapshot = this.repository.snapshot();
      } catch (error) {
        throw unavailable(error);
      }
      const decision = decide(snapshot);
      if ("result" in decision) return decision.result;
      try {
        const receipts = this.repository.appendAtHead(snapshot.headSeq, decision.events);
        return decision.finish(receipts);
      } catch (error) {
        if (error instanceof ControlStoreError && (error.code === "STALE_VERSION" || error.code === "EVENT_ID_CONFLICT")) {
          continue;
        }
        throw unavailable(error);
      }
    }
    throw new SteeringServiceError(
      "CONCURRENT_UPDATE",
      `steering decision did not reach a stable canonical head after ${this.maxCasRetries} attempts`
    );
  }

  private resolveExistingAdmission(
    snapshot: SteeringRepositorySnapshot,
    record: SteeringCommandRecord,
    request: SteeringAdmissionRequest
  ): SteeringAdmissionResult {
    if (record.status === "refused" && "refusal" in record) {
      const event = this.repository.eventAt(snapshot, record.terminalSeq);
      if (event.type !== "steering.command_refused" || event.payload.commandId !== request.commandId) {
        throw unavailable(new Error(`refusal event for ${request.commandId} is missing or has the wrong type`));
      }
      const candidate = this.materialize(request, event.occurredAt);
      const candidateDigest = steeringCommandSemanticDigest(candidate);
      if (record.refusal.requestSemanticDigest !== candidateDigest || event.payload.requestSemanticDigest !== candidateDigest) {
        throw new SteeringServiceError(
          "COMMAND_ID_CONFLICT",
          `steering command ${request.commandId} was retried with divergent immutable fields`
        );
      }
      return {
        decision: "refused",
        commandId: record.refusal.commandId,
        seq: record.terminalSeq,
        refusal: structuredClone(record.refusal)
      };
    }

    if (record.status === "refused") {
      const candidate = this.materialize(request, record.command.createdAt);
      const comparison = compareSteeringCommandSemantics(record.command, candidate);
      if (comparison.result === "conflict") {
        throw new SteeringServiceError(
          "COMMAND_ID_CONFLICT",
          `steering command ${request.commandId} was retried with divergent immutable fields`,
          { changedFields: comparison.changedFields }
        );
      }
      return {
        decision: "refused",
        commandId: record.command.commandId,
        seq: record.terminalSeq,
        refusal: {
          schemaVersion: STEERING_SCHEMA_VERSION,
          commandId: record.command.commandId,
          runId: record.command.runId,
          runEpoch: record.command.runEpoch,
          taskId: record.command.taskId,
          taskGeneration: record.command.taskGeneration,
          sessionId: record.command.sessionId,
          sessionGeneration: record.command.sessionGeneration,
          bodySha256: record.command.bodySha256,
          requestSemanticDigest: record.terminalRefusal.requestSemanticDigest,
          observedSeq: record.terminalRefusal.observedSeq,
          observedActivity: record.terminalRefusal.observedActivity,
          reasonCode: record.terminalRefusal.reasonCode
        }
      };
    }

    const candidate = this.materialize(request, record.command.createdAt);
    const comparison = compareSteeringCommandSemantics(record.command, candidate);
    if (comparison.result === "conflict") {
      throw new SteeringServiceError(
        "COMMAND_ID_CONFLICT",
        `steering command ${request.commandId} was retried with divergent immutable fields`,
        { changedFields: comparison.changedFields }
      );
    }
    return {
      decision: "admitted",
      commandId: record.command.commandId,
      seq: record.admittedSeq,
      command: structuredClone(record.command)
    };
  }

  private materialize(request: SteeringAdmissionRequest, createdAt: string): SteeringCommandV1 {
    try {
      return materializeSteeringCommand({
        ...request,
        sourceKind: this.authority.sourceKind,
        parentPrincipal: this.authority.principal,
        createdAt
      });
    } catch (error) {
      throw new SteeringServiceError("INVALID_REQUEST", "steering request violates the command contract", undefined, { cause: asError(error) });
    }
  }

  private assertRunIdentity(request: SteeringAdmissionRequest): void {
    if (request.runId !== this.repository.runId || request.runEpoch !== this.repository.runEpoch) {
      throw new SteeringServiceError(
        "RUN_IDENTITY_MISMATCH",
        "steering request belongs to a different run identity",
        {
          expectedRunId: this.repository.runId,
          expectedRunEpoch: this.repository.runEpoch,
          suppliedRunId: request.runId,
          suppliedRunEpoch: request.runEpoch
        }
      );
    }
  }

  private refusalDecision(
    snapshot: SteeringRepositorySnapshot,
    command: SteeringCommandV1,
    occurredAt: string
  ): RefusalDecision | undefined {
    const observedActivity = this.observedActivity(snapshot, command, occurredAt);
    const refuse = (reasonCode: SteeringRefusalReasonCode): RefusalDecision => ({ reasonCode, observedActivity });
    if (command.expiresAt && Date.parse(command.expiresAt) <= Date.parse(occurredAt)) return refuse("EXPIRED");
    if (command.evidenceRefs.some((eventId) => !this.repository.hasEventId(snapshot, eventId))) return refuse("INVALID_REQUEST");

    const task = snapshot.control.tasks[command.taskId];
    if (!task) return refuse("TARGET_MISMATCH");
    if (task.generation !== command.taskGeneration) return refuse("STALE_GENERATION");
    if (task.status === "done" || task.status === "escalated") return refuse("TASK_TERMINAL");

    const runtime = snapshot.control.runtimes[command.sessionId];
    if (!runtime) return refuse("TARGET_MISMATCH");
    if (runtime.sessionGeneration !== command.sessionGeneration) return refuse("STALE_GENERATION");
    if (runtime.taskId !== command.taskId || runtime.taskGeneration !== command.taskGeneration) return refuse("TARGET_MISMATCH");

    if (command.supersedesCommandId) {
      const old = snapshot.steering.commands[command.supersedesCommandId];
      if (!old || old.status !== "pending" || isManifestReserved(snapshot, command.supersedesCommandId)) return refuse("INVALID_REQUEST");
      if (!sameSteeringTarget(command, old.command)) return refuse("TARGET_MISMATCH");
    }

    if (observedActivity === "indeterminate") return refuse("STALE_GENERATION");
    if (observedActivity === "blocked") return refuse("SESSION_BLOCKED");
    if (observedActivity === "exited") return refuse("SESSION_EXITED");
    if (observedActivity === "idle") {
      // Idle is admissible only for an explicitly assigned, nonterminal task's first boundary.
      const nextAttempt = nextAttemptGeneration(snapshot.control, command.sessionId, command.sessionGeneration);
      if (!runtime.taskId || nextAttempt !== 1) return refuse("TARGET_MISMATCH");
    }
    return undefined;
  }

  private observedActivity(
    snapshot: SteeringRepositorySnapshot,
    command: SteeringCommandV1,
    occurredAt: string
  ): SteeringActivityState | "indeterminate" {
    const task = snapshot.control.tasks[command.taskId];
    const runtime = snapshot.control.runtimes[command.sessionId];
    if (
      !task ||
      task.generation !== command.taskGeneration ||
      !runtime ||
      runtime.sessionGeneration !== command.sessionGeneration ||
      runtime.taskId !== command.taskId ||
      runtime.taskGeneration !== command.taskGeneration
    ) {
      return "indeterminate";
    }
    try {
      const activity = deriveSteeringActivity(snapshot.control, {
        sessionId: command.sessionId,
        nowMs: Date.parse(occurredAt),
        headSeq: snapshot.headSeq
      });
      return activity.certainty === "proven" ? activity.state : "indeterminate";
    } catch (error) {
      throw unavailable(error);
    }
  }

  private actorKind(): ControlActorKind {
    return this.authority.sourceKind === "operator" ? "operator" : "control-plane";
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new SteeringServiceError("INVALID_AUTHORITY", "parent steering clock returned an invalid Date");
    }
    return value.toISOString();
  }
}

export function createParentSteeringService(options: ParentSteeringServiceOptions): ParentSteeringService {
  return new ParentSteeringService(options);
}

function parseAdmissionRequest(value: unknown): SteeringAdmissionRequest {
  try {
    return admissionRequestSchema.parse(value);
  } catch (error) {
    throw new SteeringServiceError("INVALID_REQUEST", "steering admission request is invalid", undefined, { cause: asError(error) });
  }
}

function parseWithdrawalRequest(value: unknown): SteeringWithdrawalRequest {
  try {
    return withdrawalRequestSchema.parse(value);
  } catch (error) {
    throw new SteeringServiceError("INVALID_REQUEST", "steering withdrawal request is invalid", undefined, { cause: asError(error) });
  }
}

function parseExpiryRequest(value: unknown): SteeringExpiryRequest {
  try {
    return expiryRequestSchema.parse(value);
  } catch (error) {
    throw new SteeringServiceError("INVALID_REQUEST", "steering expiry request is invalid", undefined, { cause: asError(error) });
  }
}

function sessionVersion(projection: ControlProjection, sessionId: string, sessionGeneration: number): number {
  return projection.aggregateVersions[`session:${sessionId}:${sessionGeneration}`]?.version ?? 0;
}

function nextAttemptGeneration(projection: ControlProjection, sessionId: string, sessionGeneration: number): number {
  const generations = Object.values(projection.attempts)
    .filter((attempt) => attempt.sessionId === sessionId && attempt.sessionGeneration === sessionGeneration)
    .map((attempt) => attempt.attemptGeneration);
  return Math.max(0, ...generations) + 1;
}

function decisionBase(
  command: SteeringCommandV1,
  eventId: string,
  expectedVersion: number,
  actorKind: ControlActorKind,
  occurredAt = command.createdAt
): Omit<ControlEvent, "type" | "payload"> {
  return {
    schemaVersion: 1,
    eventId,
    runId: command.runId,
    runEpoch: command.runEpoch,
    taskId: command.taskId,
    taskGeneration: command.taskGeneration,
    expectedVersion,
    occurredAt,
    actorKind,
    actorId: command.parentPrincipal,
    sourceKind: REQUEST_SOURCE_KIND,
    sourceId: command.commandId,
    sourceGeneration: REQUEST_SOURCE_GENERATION,
    sourceEventId: steeringCommandSemanticDigest(command)
  };
}

function admissionEvent(command: SteeringCommandV1, expectedVersion: number, actorKind: ControlActorKind): ControlEvent {
  return parseControlEvent({
    ...decisionBase(command, `steering.decision:${command.commandId}`, expectedVersion, actorKind),
    type: "steering.command_admitted",
    payload: {
      commandId: command.commandId,
      sessionId: command.sessionId,
      sessionGeneration: command.sessionGeneration,
      notBeforeAttemptGeneration: command.notBeforeAttemptGeneration,
      kind: command.kind,
      sourceKind: command.sourceKind,
      parentPrincipal: command.parentPrincipal,
      evidenceRefs: command.evidenceRefs,
      body: command.body,
      bodySha256: command.bodySha256,
      createdAt: command.createdAt,
      expiresAt: command.expiresAt,
      supersedesCommandId: command.supersedesCommandId
    }
  });
}

function decisionEvent(
  command: SteeringCommandV1,
  refusal: RefusalDecision,
  observedSeq: number,
  expectedVersion: number,
  actorKind: ControlActorKind
): ControlEvent {
  return parseControlEvent({
    ...decisionBase(command, `steering.decision:${command.commandId}`, expectedVersion, actorKind),
    type: "steering.command_refused",
    payload: {
      commandId: command.commandId,
      sessionId: command.sessionId,
      sessionGeneration: command.sessionGeneration,
      bodySha256: command.bodySha256,
      requestSemanticDigest: steeringCommandSemanticDigest(command),
      observedSeq,
      observedActivity: refusal.observedActivity,
      reasonCode: refusal.reasonCode
    }
  });
}

function supersessionEvent(
  replacement: SteeringCommandV1,
  oldCommandId: string,
  expectedVersion: number,
  actorKind: ControlActorKind
): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId: `steering.supersede:${oldCommandId}:${replacement.commandId}`,
    runId: replacement.runId,
    runEpoch: replacement.runEpoch,
    taskId: replacement.taskId,
    taskGeneration: replacement.taskGeneration,
    expectedVersion,
    occurredAt: replacement.createdAt,
    actorKind,
    actorId: replacement.parentPrincipal,
    sourceKind: "steering-supersession",
    sourceId: oldCommandId,
    sourceGeneration: 1,
    sourceEventId: replacement.commandId,
    type: "steering.command_superseded",
    payload: {
      commandId: oldCommandId,
      sessionId: replacement.sessionId,
      sessionGeneration: replacement.sessionGeneration,
      byCommandId: replacement.commandId
    }
  });
}

function withdrawalEvent(
  command: SteeringCommandV1,
  reason: string | undefined,
  occurredAt: string,
  expectedVersion: number,
  actorKind: ControlActorKind,
  authoritySourceKind: SteeringSourceKind
): ControlEvent {
  const requestDigest = withdrawalRequestDigest(
    command.commandId,
    reason,
    command.parentPrincipal,
    authoritySourceKind
  );
  return parseControlEvent({
    schemaVersion: 1,
    eventId: `steering.withdraw:${command.commandId}`,
    runId: command.runId,
    runEpoch: command.runEpoch,
    taskId: command.taskId,
    taskGeneration: command.taskGeneration,
    expectedVersion,
    occurredAt,
    actorKind,
    actorId: command.parentPrincipal,
    sourceKind: "steering-withdrawal",
    sourceId: command.commandId,
    sourceGeneration: 1,
    sourceEventId: requestDigest,
    type: "steering.command_withdrawn",
    payload: {
      commandId: command.commandId,
      sessionId: command.sessionId,
      sessionGeneration: command.sessionGeneration,
      reason
    }
  });
}

function withdrawalRequestDigest(
  commandId: string,
  reason: string | undefined,
  principal: string,
  sourceKind: SteeringSourceKind
): string {
  return hash({ kind: "steering-withdrawal", commandId, reason, principal, sourceKind });
}

function expiryEvent(command: SteeringCommandV1, occurredAt: string, expectedVersion: number): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId: `steering.expire:${command.commandId}`,
    runId: command.runId,
    runEpoch: command.runEpoch,
    taskId: command.taskId,
    taskGeneration: command.taskGeneration,
    expectedVersion,
    occurredAt,
    actorKind: "system",
    actorId: "steering-expiry",
    sourceKind: "steering-expiry",
    sourceId: command.commandId,
    sourceGeneration: 1,
    sourceEventId: hash({ kind: "steering-expiry", commandId: command.commandId, expiresAt: command.expiresAt }),
    type: "steering.command_expired",
    payload: {
      commandId: command.commandId,
      sessionId: command.sessionId,
      sessionGeneration: command.sessionGeneration
    }
  });
}

function refusalResult(
  command: SteeringCommandV1,
  refusal: RefusalDecision,
  observedSeq: number,
  seq: number
): SteeringAdmissionResult {
  return {
    decision: "refused",
    commandId: command.commandId,
    seq,
    refusal: {
      schemaVersion: STEERING_SCHEMA_VERSION,
      commandId: command.commandId,
      runId: command.runId,
      runEpoch: command.runEpoch,
      taskId: command.taskId,
      taskGeneration: command.taskGeneration,
      sessionId: command.sessionId,
      sessionGeneration: command.sessionGeneration,
      bodySha256: command.bodySha256,
      requestSemanticDigest: steeringCommandSemanticDigest(command),
      observedSeq,
      observedActivity: refusal.observedActivity,
      reasonCode: refusal.reasonCode
    }
  };
}

function requireReceipt(receipts: readonly AppendResult[], index: number): AppendResult {
  const receipt = receipts[index];
  if (!receipt) throw unavailable(new Error(`canonical append omitted receipt ${index}`));
  return receipt;
}

function isManifestReserved(snapshot: SteeringRepositorySnapshot, commandId: string): boolean {
  return Object.values(snapshot.steering.manifests).some((manifest) => manifest.steeringCommandIds.includes(commandId));
}

type RefusalDecision = {
  readonly reasonCode: SteeringRefusalReasonCode;
  readonly observedActivity: SteeringActivityState | "indeterminate";
};

function terminalError(commandId: string, status: SteeringCommandRecord["status"]): SteeringServiceError {
  return new SteeringServiceError(
    "COMMAND_TERMINAL",
    `steering command ${commandId} is terminal (${status})`,
    { status }
  );
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function unavailable(error: unknown): SteeringServiceError {
  if (error instanceof SteeringServiceError) return error;
  if (error instanceof SteeringRepositoryError || error instanceof ControlStoreError) {
    return new SteeringServiceError("CONTROL_STORE_UNAVAILABLE", error.message, undefined, { cause: error });
  }
  return new SteeringServiceError(
    "CONTROL_STORE_UNAVAILABLE",
    error instanceof Error ? error.message : "control store operation failed",
    undefined,
    { cause: asError(error) }
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
