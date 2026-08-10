import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  applyControlRoomFact,
  assertControlRoomProjectionConsistent,
  CONTROL_ROOM_PROJECTION_LIMITS,
  ControlRoomProjectionError,
  emptyControlRoomProjection,
  reduceControlRoomFacts,
  type ControlRoomAgentStateFactV1,
  type ControlRoomFactV1,
  type ControlRoomProjectionV1
} from "../src/control-room/projection.js";
import { materializeObservationRecord, toPublicObservation } from "../src/observability/public.js";
import { OBSERVATION_SCHEMA_VERSION, type ObservationGenerationV1, type PublicObservationV1 } from "../src/observability/types.js";

const EPOCH = "epoch_1234567890123456";
const AT = "2026-08-09T12:00:00.000Z";

function generation(overrides: Partial<ObservationGenerationV1> = {}): ObservationGenerationV1 {
  return {
    runId: "run-1",
    runEpoch: EPOCH,
    taskId: "task-1",
    agentId: "worker-1",
    runtimeGeneration: 1,
    attemptGeneration: 1,
    sourceGeneration: 1,
    ...overrides
  };
}

function agentState(seq: number, overrides: Partial<ControlRoomAgentStateFactV1> = {}): ControlRoomAgentStateFactV1 {
  return {
    schemaVersion: 1,
    kind: "agent_state",
    seq,
    generation: generation(),
    observedAt: AT,
    activity: "active",
    taskStatus: "claimed",
    steeringState: "none",
    pendingCommands: 0,
    scmState: "unpublished",
    verificationState: "not_run",
    ...overrides
  };
}

function observation(seq: number, generationValue = generation(), summary = `record ${seq}`): PublicObservationV1 {
  return toPublicObservation(materializeObservationRecord({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seq,
    recordId: `observation-${seq}`,
    generation: generationValue,
    observedAt: AT,
    recordedAt: AT,
    category: "provider",
    phase: "executing",
    severity: "info",
    code: "provider.progress",
    details: { kind: "progress", operationCode: "turn.running" },
    sourceIntegrity: "live",
    summary
  }));
}

function observationFact(seq: number, generationValue = generation(), tail?: Readonly<{ key: string; state: "partial" | "final" }>): ControlRoomFactV1 {
  return {
    schemaVersion: 1,
    kind: "observation",
    seq,
    record: observation(seq, generationValue),
    ...(tail === undefined ? {} : { tail })
  };
}

describe("pure control-room projection", () => {
  it("derives parent-owned attention while observation prose remains non-authoritative", () => {
    let projection = emptyControlRoomProjection("run-1", EPOCH);
    projection = applyControlRoomFact(projection, agentState(1, { activity: "waiting_input", steeringState: "pending", pendingCommands: 2 }));
    expect(projection.rows[0]).toMatchObject({ activity: "waiting_input", attention: "needs_input", pendingCommands: 2 });
    projection = applyControlRoomFact(projection, observationFact(2));
    expect(projection.rows[0]).toMatchObject({ activity: "waiting_input", attention: "needs_input", lastFactSeq: 2 });
    expect(projection.rows[0]?.lastObservation?.summary?.text).toBe("record 2");
  });

  it("rejects stale generations without reviving the live row", () => {
    let projection = reduceControlRoomFacts("run-1", EPOCH, [
      agentState(1),
      agentState(2, { generation: generation({ attemptGeneration: 2 }), activity: "settling" })
    ]);
    projection = applyControlRoomFact(projection, observationFact(3, generation({ attemptGeneration: 1 })));
    expect(projection.rows[0]).toMatchObject({ attemptGeneration: 2, activity: "settling", attention: "settling" });
    expect(projection.observations).toEqual([]);
    expect(projection.staleFacts).toBe(1);
    expect(projection.headSeq).toBe(3);
  });

  it("preserves lifecycle on a newer source generation but clears stale source presentation", () => {
    let projection = reduceControlRoomFacts("run-1", EPOCH, [agentState(1), observationFact(2)]);
    projection = applyControlRoomFact(projection, {
      schemaVersion: 1,
      kind: "source_health",
      seq: 3,
      generation: generation({ sourceGeneration: 2 }),
      observedAt: AT,
      integrity: "replaced",
      stateCode: "source.replaced",
      droppedRecords: 0,
      droppedBytes: 0
    });
    expect(projection.rows[0]).toMatchObject({
      activity: "active",
      attention: "working",
      sourceGeneration: 2,
      sourceIntegrity: "replaced"
    });
    expect(projection.rows[0]?.lastObservation).toBeUndefined();
    expect(projection.observations).toHaveLength(1);
  });

  it("refuses task identity changes inside the same attempt generation", () => {
    const projection = applyControlRoomFact(emptyControlRoomProjection("run-1", EPOCH), agentState(1));
    expect(() => applyControlRoomFact(projection, agentState(2, {
      generation: generation({ taskId: "task-2", sourceGeneration: 2 })
    }))).toThrowError(expect.objectContaining<Partial<ControlRoomProjectionError>>({ code: "GENERATION_CONFLICT" }));
  });

  it("replaces partial tails by stable generation key and closes them exactly once", () => {
    let projection = applyControlRoomFact(emptyControlRoomProjection("run-1", EPOCH), agentState(1));
    projection = applyControlRoomFact(projection, observationFact(2, generation(), { key: "assistant-tail", state: "partial" }));
    projection = applyControlRoomFact(projection, observationFact(3, generation(), { key: "assistant-tail", state: "partial" }));
    expect(projection.observations.map((record) => record.seq)).toEqual([3]);
    expect(projection.tailSlots[0]).toMatchObject({ state: "partial", recordSeq: 3 });
    projection = applyControlRoomFact(projection, observationFact(4, generation(), { key: "assistant-tail", state: "final" }));
    expect(projection.observations.map((record) => record.seq)).toEqual([4]);
    expect(projection.tailSlots[0]).toMatchObject({ state: "final", recordSeq: 4 });
    expect(() => applyControlRoomFact(projection, observationFact(5, generation(), { key: "assistant-tail", state: "partial" })))
      .toThrowError(expect.objectContaining<Partial<ControlRoomProjectionError>>({ code: "TAIL_CONFLICT" }));
  });

  it("keeps deterministic row order independent of input agent names", () => {
    const facts = [
      agentState(1, { generation: generation({ agentId: "worker-z" }) }),
      agentState(2, { generation: generation({ agentId: "worker-a" }), activity: "blocked", taskStatus: "blocked" }),
      agentState(3, { generation: generation({ agentId: "worker-m" }), activity: "idle" })
    ];
    const projection = reduceControlRoomFacts("run-1", EPOCH, facts);
    expect(projection.rows.map((row) => row.agentId)).toEqual(["worker-a", "worker-m", "worker-z"]);
    expect(projection.rows.map((row) => row.attention)).toEqual(["blocked", "idle", "working"]);
  });

  it("rejects sequence conflicts, wrong epochs, malformed facts, and replay overflow", () => {
    const projection = applyControlRoomFact(emptyControlRoomProjection("run-1", EPOCH), agentState(1));
    expect(() => applyControlRoomFact(projection, agentState(1))).toThrowError(expect.objectContaining({ code: "SEQUENCE_CONFLICT" }));
    expect(() => applyControlRoomFact(projection, agentState(2, {
      generation: generation({ runEpoch: "epoch_9999999999999999" })
    }))).toThrowError(expect.objectContaining({ code: "INVALID_IDENTITY" }));
    expect(() => applyControlRoomFact(projection, { kind: "raw_terminal", seq: 2, raw: "done" }))
      .toThrowError(expect.objectContaining({ code: "INVALID_FACT" }));
    expect(() => reduceControlRoomFacts("run-1", EPOCH, new Array(CONTROL_ROOM_PROJECTION_LIMITS.maximumReplayFacts + 1)))
      .toThrowError(expect.objectContaining({ code: "REPLAY_LIMIT" }));
  });

  it("detects corrupted projection byte accounting", () => {
    const projection = reduceControlRoomFacts("run-1", EPOCH, [agentState(1), observationFact(2)]);
    expect(projection.observationBytes).toBe(Buffer.byteLength(JSON.stringify(projection.observations[0])));
    expect(() => assertControlRoomProjectionConsistent({ ...projection, observationBytes: projection.observationBytes + 1 }))
      .toThrowError(expect.objectContaining({ code: "INVALID_FACT" }));
  });
});
