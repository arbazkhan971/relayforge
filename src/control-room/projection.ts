import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  OBSERVATION_SCHEMA_VERSION,
  ObservationGenerationV1Schema,
  PublicObservationV1Schema,
  observationActivityStates,
  observationSourceIntegrities,
  type ObservationGenerationV1,
  type ObservationSourceIntegrity,
  type PublicObservationV1
} from "../observability/types.js";
import { toPublicObservation } from "../observability/public.js";

export const CONTROL_ROOM_SCHEMA_VERSION = 1 as const;
export const CONTROL_ROOM_PROJECTION_LIMITS = Object.freeze({
  maximumReplayFacts: 100_000,
  maximumObservationRecords: 4_096,
  maximumObservationBytes: 16 * 1024 * 1024,
  maximumTailSlots: 2_048
});

const SeqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CodeSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/u);
const TimestampSchema = z.string().length(24).refine((value) => {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
});
const TailKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const ControlRoomAgentStateFactV1Schema = z.strictObject({
  schemaVersion: z.literal(CONTROL_ROOM_SCHEMA_VERSION),
  kind: z.literal("agent_state"),
  seq: SeqSchema,
  generation: ObservationGenerationV1Schema,
  observedAt: TimestampSchema,
  activity: z.enum(observationActivityStates),
  taskStatus: z.enum(["planned", "claimed", "done", "blocked", "escalated", "unknown"]),
  steeringState: z.enum(["none", "pending", "included", "refused", "unknown"]),
  pendingCommands: CountSchema,
  scmState: z.enum(["unpublished", "publishing", "ci_pending", "changes_requested", "ready", "blocked", "unknown"]),
  verificationState: z.enum(["not_run", "pending", "passing", "failing", "unknown"])
});

export const ControlRoomObservationFactV1Schema = z.strictObject({
  schemaVersion: z.literal(CONTROL_ROOM_SCHEMA_VERSION),
  kind: z.literal("observation"),
  seq: SeqSchema,
  record: PublicObservationV1Schema,
  tail: z.strictObject({ key: TailKeySchema, state: z.enum(["partial", "final"]) }).optional()
}).superRefine((value, context) => {
  if (value.seq !== value.record.seq) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["record", "seq"], message: "fact and record sequences differ" });
  }
});

export const ControlRoomSourceHealthFactV1Schema = z.strictObject({
  schemaVersion: z.literal(CONTROL_ROOM_SCHEMA_VERSION),
  kind: z.literal("source_health"),
  seq: SeqSchema,
  generation: ObservationGenerationV1Schema,
  observedAt: TimestampSchema,
  integrity: z.enum(observationSourceIntegrities),
  stateCode: CodeSchema,
  droppedRecords: CountSchema,
  droppedBytes: CountSchema
});

export const ControlRoomFactV1Schema = z.discriminatedUnion("kind", [
  ControlRoomAgentStateFactV1Schema,
  ControlRoomObservationFactV1Schema,
  ControlRoomSourceHealthFactV1Schema
]);

export type ControlRoomAgentStateFactV1 = z.infer<typeof ControlRoomAgentStateFactV1Schema>;
export type ControlRoomObservationFactV1 = z.infer<typeof ControlRoomObservationFactV1Schema>;
export type ControlRoomSourceHealthFactV1 = z.infer<typeof ControlRoomSourceHealthFactV1Schema>;
export type ControlRoomFactV1 = z.infer<typeof ControlRoomFactV1Schema>;

export type ControlRoomAttention = "needs_input" | "working" | "settling" | "blocked" | "failed" | "complete" | "idle" | "unknown";
export type ControlRoomActivity = (typeof observationActivityStates)[number] | "unknown";

export type ControlRoomAgentRowV1 = Readonly<{
  agentId: string;
  taskId?: string;
  runtimeGeneration: number;
  attemptGeneration: number;
  sourceGeneration: number;
  activity: ControlRoomActivity;
  attention: ControlRoomAttention;
  taskStatus: ControlRoomAgentStateFactV1["taskStatus"];
  steeringState: ControlRoomAgentStateFactV1["steeringState"];
  pendingCommands: number;
  scmState: ControlRoomAgentStateFactV1["scmState"];
  verificationState: ControlRoomAgentStateFactV1["verificationState"];
  sourceIntegrity: ObservationSourceIntegrity;
  sourceStateCode: string;
  sourceDroppedRecords: number;
  sourceDroppedBytes: number;
  lastFactSeq: number;
  lastObservedAt?: string;
  lastObservation?: PublicObservationV1;
}>;

export type ControlRoomTailSlotV1 = Readonly<{
  key: string;
  agentId: string;
  runtimeGeneration: number;
  attemptGeneration: number;
  sourceGeneration: number;
  state: "partial" | "final";
  recordSeq: number;
}>;

export type ControlRoomProjectionV1 = Readonly<{
  schemaVersion: typeof CONTROL_ROOM_SCHEMA_VERSION;
  runId: string;
  runEpoch: string;
  headSeq: number;
  firstAvailableSeq: number;
  observationBytes: number;
  droppedRecords: number;
  droppedBytes: number;
  staleFacts: number;
  rows: readonly ControlRoomAgentRowV1[];
  observations: readonly PublicObservationV1[];
  tailSlots: readonly ControlRoomTailSlotV1[];
}>;

export type ControlRoomProjectionErrorCode =
  | "INVALID_IDENTITY"
  | "INVALID_FACT"
  | "SEQUENCE_CONFLICT"
  | "GENERATION_CONFLICT"
  | "TAIL_CONFLICT"
  | "REPLAY_LIMIT";

export class ControlRoomProjectionError extends Error {
  constructor(readonly code: ControlRoomProjectionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ControlRoomProjectionError";
  }
}

function attention(activity: ControlRoomActivity, taskStatus: ControlRoomAgentRowV1["taskStatus"]): ControlRoomAttention {
  if (activity === "waiting_input") return "needs_input";
  if (activity === "dispatching" || activity === "active") return "working";
  if (activity === "settling") return "settling";
  if (activity === "blocked") return "blocked";
  if (activity === "idle") return "idle";
  if (activity === "exited") {
    if (taskStatus === "done") return "complete";
    if (taskStatus === "blocked" || taskStatus === "escalated") return "failed";
    return "idle";
  }
  return "unknown";
}

function generationOf(row: ControlRoomAgentRowV1): ObservationGenerationV1 {
  return {
    runId: "unused",
    runEpoch: "unused_unused_unused",
    ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
    agentId: row.agentId,
    runtimeGeneration: row.runtimeGeneration,
    attemptGeneration: row.attemptGeneration,
    sourceGeneration: row.sourceGeneration
  };
}

function compareGeneration(left: ObservationGenerationV1, right: ObservationGenerationV1): number {
  if (left.agentId !== right.agentId) throw new ControlRoomProjectionError("GENERATION_CONFLICT", "cannot compare different agents");
  if (
    left.runtimeGeneration === right.runtimeGeneration &&
    left.attemptGeneration === right.attemptGeneration &&
    left.taskId !== right.taskId
  ) throw new ControlRoomProjectionError("GENERATION_CONFLICT", "same attempt generation changed task identity");
  for (const key of ["runtimeGeneration", "attemptGeneration", "sourceGeneration"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

function unknownRow(generation: ObservationGenerationV1, seq: number, observedAt?: string): ControlRoomAgentRowV1 {
  return Object.freeze({
    agentId: generation.agentId,
    ...(generation.taskId === undefined ? {} : { taskId: generation.taskId }),
    runtimeGeneration: generation.runtimeGeneration,
    attemptGeneration: generation.attemptGeneration,
    sourceGeneration: generation.sourceGeneration,
    activity: "unknown",
    attention: "unknown",
    taskStatus: "unknown",
    steeringState: "unknown",
    pendingCommands: 0,
    scmState: "unknown",
    verificationState: "unknown",
    sourceIntegrity: "unknown",
    sourceStateCode: "source.unknown",
    sourceDroppedRecords: 0,
    sourceDroppedBytes: 0,
    lastFactSeq: seq,
    ...(observedAt === undefined ? {} : { lastObservedAt: observedAt })
  });
}

function advancedSourceRow(
  previous: ControlRoomAgentRowV1,
  generation: ObservationGenerationV1,
  seq: number
): ControlRoomAgentRowV1 {
  return Object.freeze({
    agentId: generation.agentId,
    ...(generation.taskId === undefined ? {} : { taskId: generation.taskId }),
    runtimeGeneration: generation.runtimeGeneration,
    attemptGeneration: generation.attemptGeneration,
    sourceGeneration: generation.sourceGeneration,
    activity: previous.activity,
    attention: previous.attention,
    taskStatus: previous.taskStatus,
    steeringState: previous.steeringState,
    pendingCommands: previous.pendingCommands,
    scmState: previous.scmState,
    verificationState: previous.verificationState,
    sourceIntegrity: "unknown",
    sourceStateCode: "source.replaced",
    sourceDroppedRecords: 0,
    sourceDroppedBytes: 0,
    lastFactSeq: seq
  });
}

function replaceRow(rows: readonly ControlRoomAgentRowV1[], row: ControlRoomAgentRowV1): readonly ControlRoomAgentRowV1[] {
  return Object.freeze([...rows.filter((candidate) => candidate.agentId !== row.agentId), row]
    .sort((left, right) => left.agentId.localeCompare(right.agentId)));
}

function tailIdentity(record: PublicObservationV1, key: string): string {
  const generation = record.generation;
  return `${generation.agentId}:${generation.runtimeGeneration}:${generation.attemptGeneration}:${generation.sourceGeneration}:${key}`;
}

function canonicalProjection(input: ControlRoomProjectionV1): ControlRoomProjectionV1 {
  const observations = [...input.observations].sort((left, right) => left.seq - right.seq || left.recordId.localeCompare(right.recordId));
  return Object.freeze({
    schemaVersion: CONTROL_ROOM_SCHEMA_VERSION,
    runId: input.runId,
    runEpoch: input.runEpoch,
    headSeq: input.headSeq,
    firstAvailableSeq: input.firstAvailableSeq,
    observationBytes: input.observationBytes,
    droppedRecords: input.droppedRecords,
    droppedBytes: input.droppedBytes,
    staleFacts: input.staleFacts,
    rows: Object.freeze([...input.rows].sort((left, right) => left.agentId.localeCompare(right.agentId))),
    observations: Object.freeze(observations),
    tailSlots: Object.freeze([...input.tailSlots].sort((left, right) => left.key.localeCompare(right.key)))
  });
}

export function emptyControlRoomProjection(runId: string, runEpoch: string): ControlRoomProjectionV1 {
  const generationCheck = ObservationGenerationV1Schema.safeParse({
    runId,
    runEpoch,
    agentId: "identity-check",
    runtimeGeneration: 1,
    attemptGeneration: 1,
    sourceGeneration: 1
  });
  if (!generationCheck.success) throw new ControlRoomProjectionError("INVALID_IDENTITY", "run identity is invalid");
  return canonicalProjection({
    schemaVersion: CONTROL_ROOM_SCHEMA_VERSION,
    runId,
    runEpoch,
    headSeq: 0,
    firstAvailableSeq: 1,
    observationBytes: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    staleFacts: 0,
    rows: [],
    observations: [],
    tailSlots: []
  });
}

function factGeneration(fact: ControlRoomFactV1): ObservationGenerationV1 {
  return fact.kind === "observation" ? fact.record.generation : fact.generation;
}

export function applyControlRoomFact(projection: ControlRoomProjectionV1, input: unknown): ControlRoomProjectionV1 {
  const parsed = ControlRoomFactV1Schema.safeParse(input);
  if (!parsed.success) throw new ControlRoomProjectionError("INVALID_FACT", parsed.error.issues[0]?.message ?? "fact is invalid");
  const fact = parsed.data;
  const generation = factGeneration(fact);
  if (generation.runId !== projection.runId || generation.runEpoch !== projection.runEpoch) {
    throw new ControlRoomProjectionError("INVALID_IDENTITY", "fact belongs to a different run identity");
  }
  if (fact.seq <= projection.headSeq) {
    throw new ControlRoomProjectionError("SEQUENCE_CONFLICT", "fact sequence is not after the projection head");
  }

  let rows = projection.rows;
  let observations = projection.observations;
  let tailSlots = projection.tailSlots;
  let observationBytes = projection.observationBytes;
  let droppedRecords = projection.droppedRecords;
  let droppedBytes = projection.droppedBytes;
  let staleFacts = projection.staleFacts;
  let firstAvailableSeq = projection.firstAvailableSeq;
  const existing = rows.find((row) => row.agentId === generation.agentId);
  const comparison = existing === undefined ? 1 : compareGeneration(generation, generationOf(existing));
  if (comparison < 0) {
    staleFacts += 1;
    return canonicalProjection({
      schemaVersion: CONTROL_ROOM_SCHEMA_VERSION,
      runId: projection.runId,
      runEpoch: projection.runEpoch,
      headSeq: fact.seq,
      firstAvailableSeq,
      observationBytes,
      droppedRecords,
      droppedBytes,
      staleFacts,
      rows,
      observations,
      tailSlots
    });
  }

  const sourceOnlyAdvance = existing !== undefined &&
    generation.runtimeGeneration === existing.runtimeGeneration &&
    generation.attemptGeneration === existing.attemptGeneration &&
    generation.sourceGeneration > existing.sourceGeneration;
  let row = existing === undefined
    ? unknownRow(generation, fact.seq)
    : sourceOnlyAdvance
      ? advancedSourceRow(existing, generation, fact.seq)
      : comparison > 0 ? unknownRow(generation, fact.seq) : existing;

  if (fact.kind === "agent_state") {
    row = Object.freeze({
      ...unknownRow(generation, fact.seq, fact.observedAt),
      activity: fact.activity,
      attention: attention(fact.activity, fact.taskStatus),
      taskStatus: fact.taskStatus,
      steeringState: fact.steeringState,
      pendingCommands: fact.pendingCommands,
      scmState: fact.scmState,
      verificationState: fact.verificationState,
      sourceIntegrity: row.sourceIntegrity,
      sourceStateCode: row.sourceStateCode,
      sourceDroppedRecords: row.sourceDroppedRecords,
      sourceDroppedBytes: row.sourceDroppedBytes,
      ...(row.lastObservation === undefined ? {} : { lastObservation: row.lastObservation })
    });
  } else if (fact.kind === "source_health") {
    row = Object.freeze({
      ...row,
      sourceIntegrity: fact.integrity,
      sourceStateCode: fact.stateCode,
      sourceDroppedRecords: fact.droppedRecords,
      sourceDroppedBytes: fact.droppedBytes,
      lastFactSeq: fact.seq,
      lastObservedAt: fact.observedAt
    });
  } else {
    const record = toPublicObservation(fact.record);
    const encodedBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (fact.tail !== undefined) {
      const identity = tailIdentity(record, fact.tail.key);
      const currentSlot = tailSlots.find((slot) => slot.key === identity);
      if (currentSlot?.state === "final") {
        throw new ControlRoomProjectionError("TAIL_CONFLICT", "a finalized observation tail cannot be replaced");
      }
      if (currentSlot !== undefined) {
        const previous = observations.find((candidate) => candidate.seq === currentSlot.recordSeq);
        if (previous !== undefined) observationBytes -= Buffer.byteLength(JSON.stringify(previous), "utf8");
        observations = observations.filter((candidate) => candidate.seq !== currentSlot.recordSeq);
      }
      tailSlots = Object.freeze([
        ...tailSlots.filter((slot) => slot.key !== identity),
        Object.freeze({
          key: identity,
          agentId: generation.agentId,
          runtimeGeneration: generation.runtimeGeneration,
          attemptGeneration: generation.attemptGeneration,
          sourceGeneration: generation.sourceGeneration,
          state: fact.tail.state,
          recordSeq: record.seq
        })
      ]);
      if (tailSlots.length > CONTROL_ROOM_PROJECTION_LIMITS.maximumTailSlots) {
        throw new ControlRoomProjectionError("REPLAY_LIMIT", "tail slot limit exceeded");
      }
    }
    observations = Object.freeze([...observations, record]);
    observationBytes += encodedBytes;
    row = Object.freeze({
      ...row,
      sourceIntegrity: record.sourceIntegrity,
      lastFactSeq: fact.seq,
      lastObservedAt: record.observedAt,
      lastObservation: record
    });
    while (
      observations.length > CONTROL_ROOM_PROJECTION_LIMITS.maximumObservationRecords ||
      observationBytes > CONTROL_ROOM_PROJECTION_LIMITS.maximumObservationBytes
    ) {
      const oldest = observations[0]!;
      const oldestBytes = Buffer.byteLength(JSON.stringify(oldest), "utf8");
      observations = Object.freeze(observations.slice(1));
      observationBytes -= oldestBytes;
      droppedRecords += 1;
      droppedBytes += oldestBytes;
      firstAvailableSeq = Math.max(firstAvailableSeq, oldest.seq + 1);
      tailSlots = Object.freeze(tailSlots.filter((slot) => slot.recordSeq !== oldest.seq));
    }
  }
  rows = replaceRow(rows, row);
  return canonicalProjection({
    schemaVersion: CONTROL_ROOM_SCHEMA_VERSION,
    runId: projection.runId,
    runEpoch: projection.runEpoch,
    headSeq: fact.seq,
    firstAvailableSeq,
    observationBytes,
    droppedRecords,
    droppedBytes,
    staleFacts,
    rows,
    observations,
    tailSlots
  });
}

export function reduceControlRoomFacts(runId: string, runEpoch: string, facts: readonly unknown[]): ControlRoomProjectionV1 {
  if (facts.length > CONTROL_ROOM_PROJECTION_LIMITS.maximumReplayFacts) {
    throw new ControlRoomProjectionError("REPLAY_LIMIT", "fact replay exceeds the closed bound");
  }
  let projection = emptyControlRoomProjection(runId, runEpoch);
  for (const fact of facts) projection = applyControlRoomFact(projection, fact);
  return projection;
}

export function assertControlRoomProjectionConsistent(projection: ControlRoomProjectionV1): void {
  const canonical = reduceControlRoomFacts(projection.runId, projection.runEpoch, []);
  if (
    projection.schemaVersion !== canonical.schemaVersion ||
    !Number.isSafeInteger(projection.headSeq) || projection.headSeq < 0 ||
    !Number.isSafeInteger(projection.firstAvailableSeq) || projection.firstAvailableSeq < 1 || projection.firstAvailableSeq > projection.headSeq + 1 ||
    !Number.isSafeInteger(projection.observationBytes) || projection.observationBytes < 0 ||
    !Number.isSafeInteger(projection.droppedRecords) || projection.droppedRecords < 0 ||
    !Number.isSafeInteger(projection.droppedBytes) || projection.droppedBytes < 0 ||
    !Number.isSafeInteger(projection.staleFacts) || projection.staleFacts < 0
  ) {
    throw new ControlRoomProjectionError("INVALID_FACT", "projection envelope is invalid");
  }
  if (projection.droppedRecords === 0 && projection.droppedBytes === 0 && projection.firstAvailableSeq !== 1) {
    throw new ControlRoomProjectionError("INVALID_FACT", "projection floor advanced without recorded loss");
  }
  if (new Set(projection.rows.map((row) => row.agentId)).size !== projection.rows.length) {
    throw new ControlRoomProjectionError("INVALID_FACT", "projection contains duplicate agent rows");
  }
  if (projection.rows.length > 1 && projection.rows.some((row, index) => index > 0 && projection.rows[index - 1]!.agentId.localeCompare(row.agentId) >= 0)) {
    throw new ControlRoomProjectionError("INVALID_FACT", "projection rows are not canonically ordered");
  }
  for (const row of projection.rows) {
    const parsedGeneration = ObservationGenerationV1Schema.safeParse({
      runId: projection.runId,
      runEpoch: projection.runEpoch,
      ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
      agentId: row.agentId,
      runtimeGeneration: row.runtimeGeneration,
      attemptGeneration: row.attemptGeneration,
      sourceGeneration: row.sourceGeneration
    });
    if (
      !parsedGeneration.success ||
      ![...observationActivityStates, "unknown"].includes(row.activity) ||
      row.attention !== attention(row.activity, row.taskStatus) ||
      !observationSourceIntegrities.includes(row.sourceIntegrity) ||
      !Number.isSafeInteger(row.lastFactSeq) || row.lastFactSeq < 0 || row.lastFactSeq > projection.headSeq ||
      !Number.isSafeInteger(row.pendingCommands) || row.pendingCommands < 0 ||
      !Number.isSafeInteger(row.sourceDroppedRecords) || row.sourceDroppedRecords < 0 ||
      !Number.isSafeInteger(row.sourceDroppedBytes) || row.sourceDroppedBytes < 0
    ) throw new ControlRoomProjectionError("INVALID_FACT", "projection agent row is invalid");
    if (row.lastObservation !== undefined) {
      const record = toPublicObservation(row.lastObservation);
      if (
        record.generation.agentId !== row.agentId ||
        record.generation.runtimeGeneration !== row.runtimeGeneration ||
        record.generation.attemptGeneration !== row.attemptGeneration ||
        record.generation.sourceGeneration !== row.sourceGeneration
      ) throw new ControlRoomProjectionError("INVALID_FACT", "row observation generation is stale");
    }
  }
  if (projection.observationBytes !== projection.observations.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), "utf8"), 0)) {
    throw new ControlRoomProjectionError("INVALID_FACT", "projection observation byte count is inconsistent");
  }
  let previous = -1;
  const observationSeqs = new Set<number>();
  for (const record of projection.observations) {
    toPublicObservation(record);
    if (
      record.generation.runId !== projection.runId || record.generation.runEpoch !== projection.runEpoch ||
      record.seq <= previous || record.seq < projection.firstAvailableSeq || record.seq > projection.headSeq
    ) {
      throw new ControlRoomProjectionError("INVALID_FACT", "projection observation ordering or identity is invalid");
    }
    observationSeqs.add(record.seq);
    previous = record.seq;
  }
  if (projection.observations.length > CONTROL_ROOM_PROJECTION_LIMITS.maximumObservationRecords || projection.observationBytes > CONTROL_ROOM_PROJECTION_LIMITS.maximumObservationBytes) {
    throw new ControlRoomProjectionError("INVALID_FACT", "projection observation retention exceeds its bound");
  }
  if (projection.tailSlots.length > CONTROL_ROOM_PROJECTION_LIMITS.maximumTailSlots || new Set(projection.tailSlots.map((slot) => slot.key)).size !== projection.tailSlots.length) {
    throw new ControlRoomProjectionError("INVALID_FACT", "projection tail slots are duplicated or over bound");
  }
  for (const slot of projection.tailSlots) {
    const record = projection.observations.find((candidate) => candidate.seq === slot.recordSeq);
    if (
      record === undefined || !observationSeqs.has(slot.recordSeq) ||
      record.generation.agentId !== slot.agentId ||
      record.generation.runtimeGeneration !== slot.runtimeGeneration ||
      record.generation.attemptGeneration !== slot.attemptGeneration ||
      record.generation.sourceGeneration !== slot.sourceGeneration ||
      (slot.state !== "partial" && slot.state !== "final")
    ) throw new ControlRoomProjectionError("INVALID_FACT", "projection tail slot is inconsistent");
  }
}

export function controlRoomAttentionOrder(value: ControlRoomAttention): number {
  return ({ needs_input: 0, failed: 1, blocked: 2, settling: 3, working: 4, unknown: 5, idle: 6, complete: 7 } as const)[value];
}
