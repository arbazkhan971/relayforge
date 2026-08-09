import {
  canonicalJson,
  observationCommitSemanticDigest,
  parseControlEvent,
  sha256Text,
  type ControlEvent,
  type ControlObservationRecordDraft
} from "../control/events.js";
import {
  observationSourceProjectionKey,
  type ObservationSourceCheckpointFact
} from "../control/reducer.js";
import {
  ControlStoreError,
  type ControlStore
} from "../control/store.js";
import {
  TranscriptIngestorStateV1Schema,
  transcriptIngestorStateDigest,
  type TranscriptCommitReceiptV1,
  type TranscriptCommitRequestV1,
  type TranscriptCommitTransaction,
  type TranscriptIngestorStateV1
} from "./transcript-ingestor.js";

export type ControlObservationCommitErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_REQUEST"
  | "IDENTITY_MISMATCH"
  | "STALE_STATE"
  | "DIVERGENT_RETRY";

export class ControlObservationCommitError extends Error {
  constructor(readonly code: ControlObservationCommitErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ControlObservationCommitError";
  }
}

export type ControlStoreTranscriptCommitOptions = Readonly<{
  store: Pick<ControlStore, "runId" | "runEpoch" | "getProjection" | "appendBatchIf">;
  initialState: TranscriptIngestorStateV1;
  /** Parent/integration principal. Provider or worker identities are never granted this writer. */
  actorId: string;
  sourceKind?: string;
  now?: () => string;
}>;

const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function canonicalNow(clock: () => string): string {
  const supplied = clock();
  if (typeof supplied !== "string" || Number.isNaN(Date.parse(supplied))) {
    throw new ControlObservationCommitError("INVALID_REQUEST", "commit clock did not return a timestamp");
  }
  const value = new Date(supplied).toISOString();
  if (value !== supplied) {
    throw new ControlObservationCommitError("INVALID_REQUEST", "commit clock must return canonical UTC");
  }
  return value;
}

function sameGeneration(left: TranscriptIngestorStateV1["generation"], right: TranscriptIngestorStateV1["generation"]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function exactReceipt(
  source: ObservationSourceCheckpointFact | undefined,
  requestSemanticDigest: string,
  nextStateDigest: string,
  recordIds: readonly string[]
): TranscriptCommitReceiptV1 | undefined {
  if (source?.stateDigest !== nextStateDigest) return undefined;
  if (
    source.requestSemanticDigest !== requestSemanticDigest ||
    source.observationCount !== recordIds.length ||
    canonicalJson(source.observationRecordIds) !== canonicalJson(recordIds)
  ) {
    throw new ControlObservationCommitError(
      "DIVERGENT_RETRY",
      "the requested next source state already exists with different normalized observations"
    );
  }
  return Object.freeze({ stateDigest: nextStateDigest, observationCount: recordIds.length });
}

function normalizeRequest(request: TranscriptCommitRequestV1): Readonly<{
  previousStateDigest: string;
  nextState: TranscriptIngestorStateV1;
  nextStateDigest: string;
  observations: readonly ControlObservationRecordDraft[];
  recordIds: readonly string[];
  requestSemanticDigest: string;
}> {
  let nextState: TranscriptIngestorStateV1;
  try {
    nextState = TranscriptIngestorStateV1Schema.parse(request.nextState);
  } catch {
    throw new ControlObservationCommitError("INVALID_REQUEST", "next transcript source state is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(request.previousStateDigest) || !/^[a-f0-9]{64}$/u.test(request.nextStateDigest)) {
    throw new ControlObservationCommitError("INVALID_REQUEST", "source state digests are invalid");
  }
  if (transcriptIngestorStateDigest(nextState) !== request.nextStateDigest) {
    throw new ControlObservationCommitError("INVALID_REQUEST", "next source state digest is inconsistent");
  }
  if (!Array.isArray(request.observations)) {
    throw new ControlObservationCommitError("INVALID_REQUEST", "normalized observations must be an array");
  }
  const observations = request.observations.map((record): ControlObservationRecordDraft => ({ ...record }));
  const recordIds = observations.map((record) => record.recordId);
  if (new Set(recordIds).size !== recordIds.length) {
    throw new ControlObservationCommitError("INVALID_REQUEST", "normalized observation identities are duplicated");
  }
  let requestSemanticDigest: string;
  try {
    requestSemanticDigest = observationCommitSemanticDigest({
      previousStateDigest: request.previousStateDigest,
      nextState,
      nextStateDigest: request.nextStateDigest,
      observations
    });
  } catch (error) {
    throw new ControlObservationCommitError(
      "INVALID_REQUEST",
      error instanceof Error ? error.message : "normalized observation transaction is invalid"
    );
  }
  return Object.freeze({
    previousStateDigest: request.previousStateDigest,
    nextState,
    nextStateDigest: request.nextStateDigest,
    observations: Object.freeze(observations),
    recordIds: Object.freeze(recordIds),
    requestSemanticDigest
  });
}

/**
 * Adapt the transcript ingestor's callback to the one canonical ControlStore writer transaction.
 * Source state is a CAS fence; exact ambiguous retries are acknowledged from durable projection
 * facts, while same-state/different-record retries fail closed.
 */
export function createControlStoreTranscriptCommit(
  options: ControlStoreTranscriptCommitOptions
): TranscriptCommitTransaction {
  if (!BOUNDED_ID.test(options.actorId) || !BOUNDED_ID.test(options.sourceKind ?? "transcript")) {
    throw new ControlObservationCommitError("INVALID_CONFIGURATION", "actor/source kind is not a bounded canonical identifier");
  }
  let initialState: TranscriptIngestorStateV1;
  try {
    initialState = TranscriptIngestorStateV1Schema.parse(options.initialState);
  } catch {
    throw new ControlObservationCommitError("INVALID_CONFIGURATION", "initial transcript source state is invalid");
  }
  const initialTaskId = initialState.generation.taskId;
  if (
    initialState.generation.runId !== options.store.runId ||
    initialState.generation.runEpoch !== options.store.runEpoch ||
    initialTaskId === undefined
  ) {
    throw new ControlObservationCommitError("IDENTITY_MISMATCH", "initial source state does not belong to the task-scoped store identity");
  }
  const initialStateDigest = transcriptIngestorStateDigest(initialState);
  const sourceKind = options.sourceKind ?? "transcript";
  const clock = options.now ?? (() => new Date().toISOString());

  return async (request): Promise<TranscriptCommitReceiptV1> => {
    const normalized = normalizeRequest(request);
    if (
      normalized.nextState.sourceId !== initialState.sourceId ||
      normalized.nextState.parserId !== initialState.parserId ||
      normalized.nextState.parserVersion !== initialState.parserVersion ||
      !sameGeneration(normalized.nextState.generation, initialState.generation) ||
      normalized.observations.some((record) => canonicalJson(record.generation) !== canonicalJson(initialState.generation))
    ) {
      throw new ControlObservationCommitError("IDENTITY_MISMATCH", "commit changed immutable source/parser/generation identity");
    }

    const projection = options.store.getProjection();
    if (projection.runId !== options.store.runId || projection.runEpoch !== options.store.runEpoch) {
      throw new ControlObservationCommitError("IDENTITY_MISMATCH", "control projection belongs to another run identity");
    }
    const sourceKey = observationSourceProjectionKey(initialState.generation);
    const current = projection.observability.sources[sourceKey];
    const retry = exactReceipt(
      current,
      normalized.requestSemanticDigest,
      normalized.nextStateDigest,
      normalized.recordIds
    );
    if (retry) return retry;
    const expectedPrevious = current?.stateDigest ?? initialStateDigest;
    if (normalized.previousStateDigest !== expectedPrevious) {
      throw new ControlObservationCommitError("STALE_STATE", "source cursor/parser state advanced before this commit");
    }

    const taskId = initialTaskId;
    const task = projection.tasks[taskId];
    const runtime = projection.runtimes[initialState.generation.agentId];
    if (!task || !runtime || runtime.taskId !== taskId || runtime.taskGeneration !== task.generation ||
        runtime.sessionGeneration !== initialState.generation.runtimeGeneration) {
      throw new ControlObservationCommitError("STALE_STATE", "task/runtime generation is no longer current");
    }
    const attempt = Object.values(projection.attempts).find((candidate) =>
      candidate.taskId === taskId && candidate.taskGeneration === task.generation &&
      candidate.sessionId === initialState.generation.agentId &&
      candidate.sessionGeneration === initialState.generation.runtimeGeneration &&
      candidate.attemptGeneration === initialState.generation.attemptGeneration
    );
    if (!attempt) throw new ControlObservationCommitError("STALE_STATE", "attempt generation is no longer current");

    const occurredAt = canonicalNow(clock);
    const aggregateVersion = projection.aggregateVersions[`source:${initialState.generation.agentId}:${initialState.generation.runtimeGeneration}:${initialState.generation.attemptGeneration}:${initialState.generation.sourceGeneration}`]?.version ?? 0;
    const eventStem = normalized.requestSemanticDigest.slice(0, 48);
    const common = {
      schemaVersion: 1 as const,
      runId: options.store.runId,
      runEpoch: options.store.runEpoch,
      taskId,
      taskGeneration: task.generation,
      occurredAt,
      actorKind: "integration" as const,
      actorId: options.actorId,
      sourceKind,
      sourceId: initialState.sourceId,
      sourceGeneration: initialState.generation.sourceGeneration
    };
    const events: ControlEvent[] = [];
    events.push(parseControlEvent({
      ...common,
      eventId: `obs-cp-${eventStem}`,
      expectedVersion: aggregateVersion,
      sourceEventId: `checkpoint-${eventStem}`,
      type: "observation.source_checkpointed",
      payload: {
        previousStateDigest: normalized.previousStateDigest,
        ...(current === undefined ? { previousState: initialState } : {}),
        nextState: normalized.nextState,
        nextStateDigest: normalized.nextStateDigest,
        requestSemanticDigest: normalized.requestSemanticDigest,
        observationRecordIds: normalized.recordIds,
        observationCount: normalized.recordIds.length
      }
    }));
    normalized.observations.forEach((record, index) => {
      const recordDigest = sha256Text(canonicalJson(record)).slice(0, 32);
      events.push(parseControlEvent({
        ...common,
        eventId: `obs-rec-${eventStem}-${index + 1}`,
        expectedVersion: aggregateVersion + index + 1,
        sourceEventId: `record-${index + 1}-${recordDigest}`,
        type: "observation.recorded",
        payload: { record }
      }));
    });

    try {
      options.store.appendBatchIf({ expectedHeadSeq: projection.headSeq, events });
      return Object.freeze({
        stateDigest: normalized.nextStateDigest,
        observationCount: normalized.observations.length
      });
    } catch (error) {
      if (error instanceof ControlStoreError && (error.code === "STALE_VERSION" || error.code === "EVENT_ID_CONFLICT")) {
        const refreshed = options.store.getProjection().observability.sources[sourceKey];
        const recovered = exactReceipt(
          refreshed,
          normalized.requestSemanticDigest,
          normalized.nextStateDigest,
          normalized.recordIds
        );
        if (recovered) return recovered;
      }
      throw error;
    }
  };
}
