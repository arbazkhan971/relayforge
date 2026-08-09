import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  OBSERVATION_SCHEMA_VERSION,
  ObservationDetailsV1Schema,
  ObservationGenerationV1Schema,
  ObservationLossV1Schema,
  ObservationSummaryV1Schema,
  observationCategories,
  observationPhases,
  observationSeverities,
  observationSourceIntegrities,
  type ObservationDetailsV1,
  type ObservationGenerationV1,
  type ObservationLossV1,
  type ObservationSourceIntegrity,
  type ObservationSummaryV1
} from "./types.js";
import { materializeObservationRecord, redactObservationSummary } from "./public.js";
import { PinnedTranscriptSource, TranscriptSourceError } from "./source-context.js";

export const TRANSCRIPT_INGESTOR_SCHEMA_VERSION = 1 as const;
export const TRANSCRIPT_INGESTOR_LIMITS = Object.freeze({
  maximumChunkBytes: 1024 * 1024,
  maximumRecordBytes: 64 * 1024,
  maximumRecordsPerPoll: 256,
  requiredQuietPolls: 2,
  maximumParserIdBytes: 64,
  maximumStateBytes: 16 * 1024
});

const SafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ParserId = z.string().min(1).max(TRANSCRIPT_INGESTOR_LIMITS.maximumParserIdBytes).regex(/^[a-z][a-z0-9._-]*$/u);
const Timestamp = z.string().length(24).refine((value) => {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
});

export const TranscriptIngestorStateV1Schema = z.strictObject({
  schemaVersion: z.literal(TRANSCRIPT_INGESTOR_SCHEMA_VERSION),
  sourceId: Digest,
  generation: ObservationGenerationV1Schema,
  parserId: ParserId,
  parserVersion: PositiveInteger,
  cursor: SafeInteger,
  prefixDigest: Digest,
  nextRecordOrdinal: PositiveInteger,
  discardingOversize: z.boolean(),
  discardedRecordBytes: SafeInteger,
  quietPolls: z.number().int().min(0).max(TRANSCRIPT_INGESTOR_LIMITS.requiredQuietPolls),
  lastObservedSize: SafeInteger,
  droppedRecords: SafeInteger,
  droppedBytes: SafeInteger,
  integrity: z.enum(observationSourceIntegrities)
}).superRefine((value, context) => {
  if (!value.discardingOversize && value.discardedRecordBytes !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["discardedRecordBytes"], message: "discard byte count requires discard mode" });
  }
  if (value.cursor > value.lastObservedSize) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cursor"], message: "cursor is beyond the last observed source size" });
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > TRANSCRIPT_INGESTOR_LIMITS.maximumStateBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ingestor state exceeds its byte cap" });
  }
});
export type TranscriptIngestorStateV1 = z.infer<typeof TranscriptIngestorStateV1Schema>;

export const TranscriptParserObservationV1Schema = z.strictObject({
  observedAt: Timestamp,
  category: z.enum(observationCategories),
  phase: z.enum(observationPhases),
  severity: z.enum(observationSeverities),
  code: z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/u),
  details: ObservationDetailsV1Schema,
  sourceIntegrity: z.enum(observationSourceIntegrities).optional(),
  loss: ObservationLossV1Schema.optional(),
  summary: z.string().superRefine((value, context) => {
    if (Buffer.byteLength(value, "utf8") > 32 * 1024) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "parser summary exceeds the normalization input cap" });
    }
  }).optional()
});
export type TranscriptParserObservationV1 = z.infer<typeof TranscriptParserObservationV1Schema>;

export type TranscriptParserContextV1 = Readonly<{
  sourceId: string;
  sourceGeneration: number;
  recordOrdinal: number;
}>;

export interface TranscriptRecordParserV1 {
  readonly id: string;
  readonly version: number;
  parse(record: Uint8Array, context: TranscriptParserContextV1): unknown;
}

export type IngestedObservationV1 = Readonly<{
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  recordId: string;
  generation: ObservationGenerationV1;
  observedAt: string;
  category: (typeof observationCategories)[number];
  phase: (typeof observationPhases)[number];
  severity: (typeof observationSeverities)[number];
  code: string;
  details: ObservationDetailsV1;
  sourceIntegrity: ObservationSourceIntegrity;
  loss?: ObservationLossV1;
  summary?: ObservationSummaryV1;
}>;

export type TranscriptCommitRequestV1 = Readonly<{
  previousStateDigest: string;
  nextState: TranscriptIngestorStateV1;
  nextStateDigest: string;
  observations: readonly IngestedObservationV1[];
}>;

export type TranscriptCommitReceiptV1 = Readonly<{
  stateDigest: string;
  observationCount: number;
}>;

export type TranscriptCommitTransaction = (request: TranscriptCommitRequestV1) => Promise<TranscriptCommitReceiptV1>;

export type TranscriptPollRequest = Readonly<{
  source: PinnedTranscriptSource;
  state: TranscriptIngestorStateV1;
  parser: TranscriptRecordParserV1;
  commit: TranscriptCommitTransaction;
  now: string;
  quiescent: boolean;
  allowPinnedReplacement?: boolean;
}>;

export type TranscriptPollResult = Readonly<{
  state: TranscriptIngestorStateV1;
  observations: readonly IngestedObservationV1[];
  committed: boolean;
  sourcePathState: "current" | "replaced" | "missing" | "unsafe";
}>;

export type TranscriptIngestorErrorCode =
  | "INVALID_STATE"
  | "INVALID_PARSER"
  | "SOURCE_MISMATCH"
  | "PARSER_MISMATCH"
  | "PREFIX_MISMATCH"
  | "SOURCE_REPLACED"
  | "SOURCE_MUTATED"
  | "COMMIT_REJECTED";

export class TranscriptIngestorError extends Error {
  constructor(readonly code: TranscriptIngestorErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TranscriptIngestorError";
  }
}

function canonicalStateValue(value: TranscriptIngestorStateV1): TranscriptIngestorStateV1 {
  return Object.freeze({
    schemaVersion: TRANSCRIPT_INGESTOR_SCHEMA_VERSION,
    sourceId: value.sourceId,
    generation: Object.freeze({
      runId: value.generation.runId,
      runEpoch: value.generation.runEpoch,
      ...(value.generation.taskId === undefined ? {} : { taskId: value.generation.taskId }),
      agentId: value.generation.agentId,
      runtimeGeneration: value.generation.runtimeGeneration,
      attemptGeneration: value.generation.attemptGeneration,
      sourceGeneration: value.generation.sourceGeneration
    }),
    parserId: value.parserId,
    parserVersion: value.parserVersion,
    cursor: value.cursor,
    prefixDigest: value.prefixDigest,
    nextRecordOrdinal: value.nextRecordOrdinal,
    discardingOversize: value.discardingOversize,
    discardedRecordBytes: value.discardedRecordBytes,
    quietPolls: value.quietPolls,
    lastObservedSize: value.lastObservedSize,
    droppedRecords: value.droppedRecords,
    droppedBytes: value.droppedBytes,
    integrity: value.integrity
  });
}

export function transcriptIngestorStateDigest(value: TranscriptIngestorStateV1): string {
  const parsed = TranscriptIngestorStateV1Schema.parse(value);
  return createHash("sha256")
    .update("relayforge-transcript-state-v1\0", "utf8")
    .update(JSON.stringify(canonicalStateValue(parsed)), "utf8")
    .digest("hex");
}

function assertParser(parser: TranscriptRecordParserV1): void {
  const parsed = z.strictObject({ id: ParserId, version: PositiveInteger }).safeParse({ id: parser.id, version: parser.version });
  if (!parsed.success || typeof parser.parse !== "function") throw new TranscriptIngestorError("INVALID_PARSER", "parser descriptor is invalid");
}

export function createTranscriptIngestorState(input: Readonly<{
  source: PinnedTranscriptSource;
  generation: ObservationGenerationV1;
  parser: TranscriptRecordParserV1;
}>): TranscriptIngestorStateV1 {
  assertParser(input.parser);
  const generation = ObservationGenerationV1Schema.parse(input.generation);
  const value = TranscriptIngestorStateV1Schema.parse({
    schemaVersion: TRANSCRIPT_INGESTOR_SCHEMA_VERSION,
    sourceId: input.source.identity.sourceId,
    generation,
    parserId: input.parser.id,
    parserVersion: input.parser.version,
    cursor: 0,
    prefixDigest: input.source.hashPrefix(0),
    nextRecordOrdinal: 1,
    discardingOversize: false,
    discardedRecordBytes: 0,
    quietPolls: 0,
    lastObservedSize: input.source.size(),
    droppedRecords: 0,
    droppedBytes: 0,
    integrity: "live"
  });
  return canonicalStateValue(value);
}

function ingestedRecordId(sourceId: string, sourceGeneration: number, ordinal: number): string {
  return `obs-${sourceId.slice(0, 24)}-${sourceGeneration}-${ordinal}`;
}

function normalizedObservation(
  value: TranscriptParserObservationV1,
  state: TranscriptIngestorStateV1,
  ordinal: number,
  recordedAt: string,
  forcedIntegrity?: ObservationSourceIntegrity
): IngestedObservationV1 {
  const record = materializeObservationRecord({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seq: 0,
    recordId: ingestedRecordId(state.sourceId, state.generation.sourceGeneration, ordinal),
    generation: state.generation,
    observedAt: value.observedAt,
    recordedAt,
    category: value.category,
    phase: value.phase,
    severity: value.severity,
    code: value.code,
    details: value.details,
    sourceIntegrity: forcedIntegrity ?? value.sourceIntegrity ?? "live",
    ...(value.loss === undefined ? {} : { loss: value.loss }),
    ...(value.summary === undefined ? {} : { summary: value.summary })
  });
  return Object.freeze({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    recordId: record.recordId,
    generation: record.generation,
    observedAt: record.observedAt,
    category: record.category,
    phase: record.phase,
    severity: record.severity,
    code: record.code,
    details: record.details,
    sourceIntegrity: record.sourceIntegrity,
    ...(record.loss === undefined ? {} : { loss: record.loss }),
    ...(record.summary === undefined ? {} : { summary: record.summary })
  });
}

function lossObservation(
  state: TranscriptIngestorStateV1,
  ordinal: number,
  now: string,
  code: "source.record_oversize" | "source.record_malformed",
  bytes: number
): IngestedObservationV1 {
  const loss = Object.freeze({ droppedRecords: 1, droppedBytes: bytes, reasonCode: code });
  return normalizedObservation({
    observedAt: now,
    category: "system",
    phase: "executing",
    severity: "warning",
    code,
    details: { kind: "loss", droppedRecords: 1, droppedBytes: bytes, reasonCode: code },
    sourceIntegrity: "degraded",
    loss,
    summary: code === "source.record_oversize" ? "Oversized transcript record was discarded." : "Malformed transcript record was discarded."
  }, state, ordinal, now, "degraded");
}

function parseOne(
  parser: TranscriptRecordParserV1,
  bytes: Buffer,
  state: TranscriptIngestorStateV1,
  ordinal: number,
  now: string,
  integrity: ObservationSourceIntegrity
): IngestedObservationV1 {
  let candidate: unknown;
  try {
    candidate = parser.parse(Buffer.from(bytes), Object.freeze({
      sourceId: state.sourceId,
      sourceGeneration: state.generation.sourceGeneration,
      recordOrdinal: ordinal
    }));
  } catch {
    throw new TranscriptIngestorError("INVALID_PARSER", "parser rejected a complete record");
  }
  const parsed = TranscriptParserObservationV1Schema.safeParse(candidate);
  if (!parsed.success) throw new TranscriptIngestorError("INVALID_PARSER", "parser returned an invalid normalized observation");
  return normalizedObservation(parsed.data, state, ordinal, now, integrity);
}

function nextState(input: Omit<TranscriptIngestorStateV1, "schemaVersion">): TranscriptIngestorStateV1 {
  return canonicalStateValue(TranscriptIngestorStateV1Schema.parse({ schemaVersion: TRANSCRIPT_INGESTOR_SCHEMA_VERSION, ...input }));
}

export async function pollTranscript(request: TranscriptPollRequest): Promise<TranscriptPollResult> {
  assertParser(request.parser);
  const parsedState = TranscriptIngestorStateV1Schema.safeParse(request.state);
  if (!parsedState.success) throw new TranscriptIngestorError("INVALID_STATE", parsedState.error.issues[0]?.message ?? "state is invalid");
  const state = canonicalStateValue(parsedState.data);
  if (state.sourceId !== request.source.identity.sourceId) throw new TranscriptIngestorError("SOURCE_MISMATCH", "state and pinned source identities differ");
  if (state.parserId !== request.parser.id || state.parserVersion !== request.parser.version) {
    throw new TranscriptIngestorError("PARSER_MISMATCH", "persisted parser identity is incompatible");
  }
  if (!Timestamp.safeParse(request.now).success) throw new TranscriptIngestorError("INVALID_STATE", "poll timestamp is invalid");
  const pathState = request.source.pathState();
  if (pathState !== "current" && request.allowPinnedReplacement !== true) {
    throw new TranscriptIngestorError("SOURCE_REPLACED", `source path state is ${pathState}`);
  }
  const sourceSize = request.source.size();
  if (sourceSize < state.cursor) throw new TranscriptIngestorError("SOURCE_MUTATED", "source truncated behind the durable cursor");
  let currentPrefix: string;
  try { currentPrefix = request.source.hashPrefix(state.cursor); }
  catch (error) {
    if (error instanceof TranscriptSourceError) throw new TranscriptIngestorError("SOURCE_MUTATED", error.code);
    throw error;
  }
  if (currentPrefix !== state.prefixDigest) throw new TranscriptIngestorError("PREFIX_MISMATCH", "committed source prefix was rewritten");

  const bytes = request.source.read(state.cursor, Math.min(TRANSCRIPT_INGESTOR_LIMITS.maximumChunkBytes, sourceSize - state.cursor));
  request.source.verifyExtension(state.cursor, bytes);
  const observations: IngestedObservationV1[] = [];
  let position = 0;
  let ordinal = state.nextRecordOrdinal;
  let discarding = state.discardingOversize;
  let discardedBytes = state.discardedRecordBytes;
  let droppedRecords = state.droppedRecords;
  let droppedBytes = state.droppedBytes;
  let integrity: ObservationSourceIntegrity = pathState === "current" ? state.integrity : "replaced";
  let quietPolls = 0;

  while (position < bytes.byteLength && observations.length < TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll) {
    const newline = bytes.indexOf(0x0a, position);
    if (discarding) {
      if (newline < 0) {
        discardedBytes += bytes.byteLength - position;
        position = bytes.byteLength;
        break;
      }
      const consumed = newline + 1 - position;
      discardedBytes += consumed;
      observations.push(lossObservation(state, ordinal, request.now, "source.record_oversize", discardedBytes));
      ordinal += 1;
      droppedRecords += 1;
      droppedBytes += discardedBytes;
      discardedBytes = 0;
      discarding = false;
      integrity = "degraded";
      position = newline + 1;
      continue;
    }

    if (newline < 0) {
      const remaining = bytes.byteLength - position;
      const atEnd = state.cursor + bytes.byteLength === sourceSize;
      if (remaining > TRANSCRIPT_INGESTOR_LIMITS.maximumRecordBytes) {
        discarding = true;
        discardedBytes = remaining;
        position = bytes.byteLength;
      } else if (remaining > 0 && atEnd && request.quiescent) {
        quietPolls = state.lastObservedSize === sourceSize ? Math.min(TRANSCRIPT_INGESTOR_LIMITS.requiredQuietPolls, state.quietPolls + 1) : 1;
        if (quietPolls >= TRANSCRIPT_INGESTOR_LIMITS.requiredQuietPolls) {
          let record = bytes.subarray(position);
          if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
          try {
            observations.push(parseOne(request.parser, record, state, ordinal, request.now, "quiescent_final"));
            integrity = "quiescent_final";
          }
          catch {
            observations.push(lossObservation(state, ordinal, request.now, "source.record_malformed", record.byteLength));
            droppedRecords += 1;
            droppedBytes += record.byteLength;
            integrity = "degraded";
          }
          ordinal += 1;
          position = bytes.byteLength;
          quietPolls = 0;
        }
      }
      break;
    }

    let record = bytes.subarray(position, newline);
    const consumedBytes = newline + 1 - position;
    if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
    if (record.byteLength === 0) {
      position = newline + 1;
      continue;
    }
    if (record.byteLength > TRANSCRIPT_INGESTOR_LIMITS.maximumRecordBytes) {
      observations.push(lossObservation(state, ordinal, request.now, "source.record_oversize", consumedBytes));
      droppedRecords += 1;
      droppedBytes += consumedBytes;
      integrity = "degraded";
    } else {
      try { observations.push(parseOne(request.parser, record, state, ordinal, request.now, integrity)); }
      catch {
        observations.push(lossObservation(state, ordinal, request.now, "source.record_malformed", consumedBytes));
        droppedRecords += 1;
        droppedBytes += consumedBytes;
        integrity = "degraded";
      }
    }
    ordinal += 1;
    position = newline + 1;
  }

  const cursor = state.cursor + position;
  if (
    discarding && cursor === sourceSize && request.quiescent &&
    observations.length < TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll
  ) {
    quietPolls = state.lastObservedSize === sourceSize
      ? Math.min(TRANSCRIPT_INGESTOR_LIMITS.requiredQuietPolls, state.quietPolls + 1)
      : 1;
    if (quietPolls >= TRANSCRIPT_INGESTOR_LIMITS.requiredQuietPolls) {
      observations.push(lossObservation(state, ordinal, request.now, "source.record_oversize", discardedBytes));
      ordinal += 1;
      droppedRecords += 1;
      droppedBytes += discardedBytes;
      discardedBytes = 0;
      discarding = false;
      quietPolls = 0;
      integrity = "degraded";
    }
  }
  const prefixDigest = request.source.verifyExtension(state.cursor, bytes.subarray(0, position));
  const pathStateAfterRead = request.source.pathState();
  if (pathStateAfterRead !== "current" && request.allowPinnedReplacement !== true) {
    throw new TranscriptIngestorError("SOURCE_REPLACED", `source path state changed to ${pathStateAfterRead} during polling`);
  }
  if (pathStateAfterRead !== "current") integrity = "replaced";
  const updated = nextState({
    sourceId: state.sourceId,
    generation: state.generation,
    parserId: state.parserId,
    parserVersion: state.parserVersion,
    cursor,
    prefixDigest,
    nextRecordOrdinal: ordinal,
    discardingOversize: discarding,
    discardedRecordBytes: discardedBytes,
    quietPolls,
    lastObservedSize: sourceSize,
    droppedRecords,
    droppedBytes,
    integrity
  });
  const previousDigest = transcriptIngestorStateDigest(state);
  const updatedDigest = transcriptIngestorStateDigest(updated);
  if (updatedDigest === previousDigest && observations.length === 0) {
    return Object.freeze({ state, observations: Object.freeze([]), committed: false, sourcePathState: pathStateAfterRead });
  }
  let receipt: TranscriptCommitReceiptV1;
  try {
    receipt = await request.commit(Object.freeze({
      previousStateDigest: previousDigest,
      nextState: updated,
      nextStateDigest: updatedDigest,
      observations: Object.freeze(observations)
    }));
  } catch {
    throw new TranscriptIngestorError("COMMIT_REJECTED", "observation/state transaction failed");
  }
  if (receipt.stateDigest !== updatedDigest || receipt.observationCount !== observations.length) {
    throw new TranscriptIngestorError("COMMIT_REJECTED", "transaction receipt does not bind the requested state and observations");
  }
  return Object.freeze({ state: updated, observations: Object.freeze(observations), committed: true, sourcePathState: pathStateAfterRead });
}

export function parserSummary(value: string): ObservationSummaryV1 {
  return ObservationSummaryV1Schema.parse(redactObservationSummary(value));
}
