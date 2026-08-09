import type { ControlEvent } from "../control/events.js";
import { ControlStore, ControlStoreError } from "../control/store.js";
import {
  MultiRepositoryCanonicalJournalConflictError,
  parseMultiRepositoryCanonicalFact,
  projectMultiRepositoryCanonicalFacts,
  type MultiRepositoryCanonicalFactV1,
  type MultiRepositoryCanonicalJournalSnapshotV1,
  type MultiRepositoryCanonicalJournalV1
} from "./orchestration.js";

export type MultiRepositoryControlStoreJournalOptions = Readonly<{
  store: ControlStore;
  runId: string;
  runEpoch: string;
  actorId?: string;
}>;

function factTaskScope(fact: MultiRepositoryCanonicalFactV1): Readonly<{ taskId: string | null; taskGeneration: number | null }> {
  if (fact.kind === "multirepo.plan_registered") return Object.freeze({ taskId: null, taskGeneration: null });
  if (fact.kind === "multirepo.scheduler_transitioned") {
    return Object.freeze({ taskId: fact.event.taskId, taskGeneration: fact.event.taskGeneration });
  }
  return Object.freeze({ taskId: fact.taskId, taskGeneration: fact.taskGeneration });
}

function snapshot(store: ControlStore, runId: string, runEpoch: string): MultiRepositoryCanonicalJournalSnapshotV1 {
  const projection = store.getProjection();
  if (projection.runId !== runId || projection.runEpoch !== runEpoch) {
    throw new ControlStoreError("RUN_IDENTITY_MISMATCH", "multi-repository journal borrowed a store for another run");
  }
  if (
    projection.multirepo.schemaVersion !== 1 ||
    projection.multirepo.headVersion !== projection.multirepo.facts.length
  ) {
    throw new ControlStoreError("RECOVERY_REQUIRED", "multi-repository projection head is inconsistent");
  }
  // Replaying here is intentional: every journal read is an integrity boundary, not a blind view.
  projectMultiRepositoryCanonicalFacts(projection.multirepo.facts);
  return Object.freeze({
    schemaVersion: 1,
    runId,
    runEpoch,
    controlHeadSeq: projection.headSeq,
    headVersion: projection.multirepo.headVersion,
    facts: Object.freeze(structuredClone(projection.multirepo.facts))
  });
}

/**
 * Borrow the already-open sole run ControlStore as P6's canonical CAS journal. This adapter never
 * opens SQLite and never owns or closes the supplied store.
 */
export function createMultiRepositoryControlStoreJournal(
  options: MultiRepositoryControlStoreJournalOptions
): MultiRepositoryCanonicalJournalV1 {
  const { store, runId, runEpoch } = options;
  const actorId = options.actorId ?? "multirepo-parent";
  return Object.freeze({
    read(): MultiRepositoryCanonicalJournalSnapshotV1 {
      return snapshot(store, runId, runEpoch);
    },
    append(input: Parameters<MultiRepositoryCanonicalJournalV1["append"]>[0]): MultiRepositoryCanonicalJournalSnapshotV1 {
      const fact = parseMultiRepositoryCanonicalFact(input.fact);
      const before = snapshot(store, runId, runEpoch);
      if (
        before.controlHeadSeq !== input.expectedControlHeadSeq ||
        before.headVersion !== input.expectedHeadVersion
      ) {
        throw new MultiRepositoryCanonicalJournalConflictError(
          `expected control/P6 heads ${input.expectedControlHeadSeq}/${input.expectedHeadVersion}, current ${before.controlHeadSeq}/${before.headVersion}`
        );
      }
      const task = factTaskScope(fact);
      const occurredAt = store.getProjection().run?.startedAt;
      if (occurredAt === undefined) {
        throw new ControlStoreError("RECOVERY_REQUIRED", "multi-repository facts require a durable run.started fact");
      }
      const event: ControlEvent = {
        schemaVersion: 1,
        eventId: fact.factId,
        runId,
        runEpoch,
        taskId: task.taskId,
        taskGeneration: task.taskGeneration,
        expectedVersion: input.expectedHeadVersion,
        occurredAt,
        actorKind: "integration",
        actorId,
        sourceKind: null,
        sourceId: null,
        sourceGeneration: null,
        sourceEventId: null,
        type: fact.kind,
        payload: { fact }
      } as ControlEvent;
      let receipt;
      try {
        [receipt] = store.appendBatchIf({ expectedHeadSeq: input.expectedControlHeadSeq, events: [event] });
      } catch (error) {
        if (error instanceof ControlStoreError && error.code === "STALE_VERSION") {
          throw new MultiRepositoryCanonicalJournalConflictError(error.message);
        }
        throw error;
      }
      if (
        receipt === undefined || receipt.eventId !== fact.factId ||
        receipt.seq !== input.expectedControlHeadSeq + 1 ||
        receipt.aggregateVersion !== input.expectedHeadVersion + 1
      ) {
        throw new ControlStoreError("RECOVERY_REQUIRED", "multi-repository append receipt does not prove the exact global and aggregate heads");
      }
      const after = snapshot(store, runId, runEpoch);
      if (
        after.headVersion !== input.expectedHeadVersion + 1 ||
        after.facts.length !== after.headVersion ||
        after.facts.at(-1)?.factId !== fact.factId
      ) {
        throw new ControlStoreError("RECOVERY_REQUIRED", "multi-repository projection did not reopen at the appended fact");
      }
      // Unrelated canonical facts may advance after our transaction. The receipt proves this exact
      // event occupied expectedHead+1, which is the append result the coordinator must validate.
      return Object.freeze({ ...after, controlHeadSeq: receipt.seq });
    }
  });
}
