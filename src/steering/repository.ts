import type { ControlEvent, PersistedControlEvent } from "../control/events.js";
import type { ControlProjection } from "../control/reducer.js";
import {
  ControlStoreError,
  type AppendResult,
  type ControlStore
} from "../control/store.js";
import { reduceSteeringEvents } from "./reducer.js";
import type { SteeringProjection } from "./types.js";

const SNAPSHOT_PAGE_SIZE = 10_000;

export type SteeringRepositorySnapshot = {
  readonly headSeq: number;
  readonly control: ControlProjection;
  readonly steering: SteeringProjection;
  readonly events: readonly PersistedControlEvent[];
};

export type SteeringRepositoryErrorCode =
  | "INCONSISTENT_SNAPSHOT"
  | "EVENT_NOT_FOUND"
  | "CONTROL_STORE_UNAVAILABLE";

export class SteeringRepositoryError extends Error {
  constructor(
    readonly code: SteeringRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SteeringRepositoryError";
  }
}

/**
 * The deliberately narrow P2 storage adapter. It owns no database handle of its own and can mutate
 * only through P1's canonical whole-head CAS. In particular, it cannot create a second projection,
 * side table, JSONL queue, or provider-facing writer capability.
 */
export class SteeringRepository {
  constructor(private readonly store: ControlStore) {}

  get runId(): string {
    return this.store.runId;
  }

  get runEpoch(): string {
    return this.store.runEpoch;
  }

  snapshot(): SteeringRepositorySnapshot {
    try {
      // Read the materialized view first. Later commits may advance the range head, but filtering the
      // immutable full history through this exact view head yields one coherent replay snapshot. The
      // later appendBatchIf call rejects if anything committed after this read.
      const control = this.store.getProjection();
      const headSeq = control.headSeq;
      const events: PersistedControlEvent[] = [];
      let cursor = 0;
      while (cursor < headSeq) {
        const range = this.store.readRange({ afterSeq: cursor, limit: SNAPSHOT_PAGE_SIZE, runEpoch: this.store.runEpoch });
        const page = range.events.filter((event) => event.seq <= headSeq);
        if (page.length === 0) {
          throw new SteeringRepositoryError(
            "INCONSISTENT_SNAPSHOT",
            `canonical history ended at ${cursor} before projected head ${headSeq}`
          );
        }
        events.push(...page);
        cursor = page.at(-1)!.seq;
      }
      if (events.length !== headSeq || events.some((event, index) => event.seq !== index + 1)) {
        throw new SteeringRepositoryError(
          "INCONSISTENT_SNAPSHOT",
          "canonical steering replay is not a contiguous genesis-through-head history"
        );
      }
      const steering = reduceSteeringEvents(this.store.runId, this.store.runEpoch, events);
      if (steering.observedSeq !== headSeq) {
        throw new SteeringRepositoryError("INCONSISTENT_SNAPSHOT", "steering replay did not reach the control projection head");
      }
      assertP1AndP2SteeringAgree(control, steering);
      return { headSeq, control, steering, events };
    } catch (error) {
      if (error instanceof SteeringRepositoryError) throw error;
      if (error instanceof ControlStoreError) {
        throw new SteeringRepositoryError("CONTROL_STORE_UNAVAILABLE", error.message, { cause: error });
      }
      throw error;
    }
  }

  appendAtHead(expectedHeadSeq: number, events: readonly ControlEvent[]): AppendResult[] {
    return this.store.appendBatchIf({ expectedHeadSeq, events });
  }

  eventAt(snapshot: SteeringRepositorySnapshot, seq: number): PersistedControlEvent {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > snapshot.headSeq) {
      throw new SteeringRepositoryError("EVENT_NOT_FOUND", `canonical event sequence ${seq} is outside this snapshot`);
    }
    const event = snapshot.events[seq - 1];
    if (!event || event.seq !== seq) {
      throw new SteeringRepositoryError("EVENT_NOT_FOUND", `canonical event sequence ${seq} is missing`);
    }
    return event;
  }

  hasEventId(snapshot: SteeringRepositorySnapshot, eventId: string): boolean {
    return snapshot.events.some((event) => event.eventId === eventId);
  }
}

function assertP1AndP2SteeringAgree(control: ControlProjection, steering: SteeringProjection): void {
  const p1Ids = Object.keys(control.steering).sort();
  const p2Ids = Object.keys(steering.commands).sort();
  if (p1Ids.length !== p2Ids.length || p1Ids.some((id, index) => id !== p2Ids[index])) {
    throw new SteeringRepositoryError("INCONSISTENT_SNAPSHOT", "P1 and P2 steering command identities disagree");
  }
  for (const commandId of p1Ids) {
    const p1 = control.steering[commandId]!;
    const p2 = steering.commands[commandId]!;
    const initialRefusal = p2.status === "refused" && "refusal" in p2;
    const p2Task = initialRefusal ? p2.refusal : p2.command;
    if (
      p1.status !== p2.status ||
      p1.sessionId !== p2Task.sessionId ||
      p1.sessionGeneration !== p2Task.sessionGeneration ||
      p1.taskId !== p2Task.taskId ||
      p1.taskGeneration !== p2Task.taskGeneration ||
      p1.bodySha256 !== (initialRefusal ? p2.refusal.bodySha256 : p2.command.bodySha256)
    ) {
      throw new SteeringRepositoryError("INCONSISTENT_SNAPSHOT", `P1 and P2 projections disagree for ${commandId}`);
    }
    if (initialRefusal) {
      if (
        p1.terminalSeq !== p2.terminalSeq ||
        p1.requestSemanticDigest !== p2.refusal.requestSemanticDigest ||
        p1.observedSeq !== p2.refusal.observedSeq ||
        p1.observedActivity !== p2.refusal.observedActivity ||
        p1.reasonCode !== p2.refusal.reasonCode
      ) {
        throw new SteeringRepositoryError("INCONSISTENT_SNAPSHOT", `P1 and P2 refusal sequences disagree for ${commandId}`);
      }
    } else if (p2.status === "refused") {
      if (
        p1.admittedSeq !== p2.admittedSeq ||
        p1.terminalSeq !== p2.terminalSeq ||
        p1.requestSemanticDigest !== p2.terminalRefusal.requestSemanticDigest ||
        p1.observedSeq !== p2.terminalRefusal.observedSeq ||
        p1.observedActivity !== p2.terminalRefusal.observedActivity ||
        p1.reasonCode !== p2.terminalRefusal.reasonCode
      ) {
        throw new SteeringRepositoryError("INCONSISTENT_SNAPSHOT", `P1 and P2 terminal refusal sequences disagree for ${commandId}`);
      }
    } else if (
      p1.admittedSeq !== p2.admittedSeq ||
      (p2.status !== "pending" && p1.terminalSeq !== p2.terminalSeq)
    ) {
      throw new SteeringRepositoryError("INCONSISTENT_SNAPSHOT", `P1 and P2 lifecycle sequences disagree for ${commandId}`);
    }
  }
}
