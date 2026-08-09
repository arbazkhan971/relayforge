import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  applyControlRoomFact,
  emptyControlRoomProjection,
  type ControlRoomAgentStateFactV1,
  type ControlRoomProjectionV1
} from "../src/control-room/projection.js";
import {
  CONTROL_ROOM_QUERY_LIMITS,
  ControlRoomQueryError,
  decodeControlRoomObservationCursor,
  encodeControlRoomObservationCursor,
  queryControlRoomObservations,
  queryControlRoomRows
} from "../src/control-room/query.js";
import { materializeObservationRecord, toPublicObservation } from "../src/observability/public.js";
import { OBSERVATION_SCHEMA_VERSION, type ObservationGenerationV1 } from "../src/observability/types.js";

const EPOCH = "epoch_1234567890123456";
const AT = "2026-08-09T12:00:00.000Z";

function generation(agentId = "worker-1"): ObservationGenerationV1 {
  return {
    runId: "run-1",
    runEpoch: EPOCH,
    taskId: `task-${agentId}`,
    agentId,
    runtimeGeneration: 1,
    attemptGeneration: 1,
    sourceGeneration: 1
  };
}

function state(seq: number, agentId: string, activity: ControlRoomAgentStateFactV1["activity"]): ControlRoomAgentStateFactV1 {
  return {
    schemaVersion: 1,
    kind: "agent_state",
    seq,
    generation: generation(agentId),
    observedAt: AT,
    activity,
    taskStatus: activity === "blocked" ? "blocked" : activity === "exited" ? "done" : "claimed",
    steeringState: "none",
    pendingCommands: 0,
    scmState: "unknown",
    verificationState: "unknown"
  };
}

function addObservation(projection: ControlRoomProjectionV1, seq: number, agentId = "worker-1"): ControlRoomProjectionV1 {
  const record = toPublicObservation(materializeObservationRecord({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seq,
    recordId: `observation-${seq}`,
    generation: generation(agentId),
    observedAt: AT,
    recordedAt: AT,
    category: "provider",
    phase: "executing",
    severity: "info",
    code: "provider.progress",
    details: { kind: "progress", operationCode: "turn.running" },
    sourceIntegrity: "live",
    summary: `record ${seq}`
  }));
  return applyControlRoomFact(projection, { schemaVersion: 1, kind: "observation", seq, record });
}

function projection(): ControlRoomProjectionV1 {
  let value = emptyControlRoomProjection("run-1", EPOCH);
  value = applyControlRoomFact(value, state(1, "worker-1", "active"));
  value = addObservation(value, 2);
  value = addObservation(value, 3);
  value = addObservation(value, 4);
  return value;
}

describe("bounded control-room queries", () => {
  it("encodes canonical epoch-qualified cursors and rejects tampering", () => {
    const encoded = encodeControlRoomObservationCursor({ schemaVersion: 1, runEpoch: EPOCH, afterSeq: 42 });
    expect(decodeControlRoomObservationCursor(encoded)).toEqual({ schemaVersion: 1, runEpoch: EPOCH, afterSeq: 42 });
    expect(() => decodeControlRoomObservationCursor(`${encoded.slice(0, -1)}A`))
      .toThrowError(expect.objectContaining<Partial<ControlRoomQueryError>>({ code: "MALFORMED_CURSOR" }));
    expect(() => decodeControlRoomObservationCursor("v1.***")).toThrowError(expect.objectContaining({ code: "MALFORMED_CURSOR" }));
  });

  it("paginates durable observations without timestamp authority", () => {
    const first = queryControlRoomObservations(projection(), { afterSeq: 0, limit: 2 });
    expect(first.page.records.map((record) => record.seq)).toEqual([2, 3]);
    expect(first).toMatchObject({ hasMore: true, page: { nextAfter: 3, truncated: true, freshness: "fresh" } });
    const second = queryControlRoomObservations(projection(), { cursor: first.nextCursor, limit: 2 });
    expect(second.page.records.map((record) => record.seq)).toEqual([4]);
    expect(second.hasMore).toBe(false);
    expect(second.page.nextAfter).toBe(4);
  });

  it("distinguishes projection lag, rebuild, and unavailability", () => {
    expect(queryControlRoomObservations(projection(), { eventHeadSeq: 7 }).page.freshness).toBe("stale");
    expect(queryControlRoomObservations(projection(), { eventHeadSeq: 7, availability: "rebuilding" }).page.freshness).toBe("rebuilding");
    expect(queryControlRoomObservations(projection(), { eventHeadSeq: 7, availability: "unavailable" }).page.freshness).toBe("unavailable");
    expect(() => queryControlRoomObservations(projection(), { eventHeadSeq: 3 }))
      .toThrowError(expect.objectContaining({ code: "HEAD_MISMATCH" }));
  });

  it("rejects wrong-epoch, future, expired, conflicting, and over-limit cursors", () => {
    const value = projection();
    const wrong = encodeControlRoomObservationCursor({ schemaVersion: 1, runEpoch: "epoch_9999999999999999", afterSeq: 1 });
    expect(() => queryControlRoomObservations(value, { cursor: wrong })).toThrowError(expect.objectContaining({ code: "WRONG_EPOCH" }));
    expect(() => queryControlRoomObservations(value, { afterSeq: 5 })).toThrowError(expect.objectContaining({ code: "FUTURE_CURSOR" }));
    expect(() => queryControlRoomObservations(value, { cursor: encodeControlRoomObservationCursor({ schemaVersion: 1, runEpoch: EPOCH, afterSeq: 1 }), afterSeq: 1 }))
      .toThrowError(expect.objectContaining({ code: "MALFORMED_CURSOR" }));
    expect(() => queryControlRoomObservations(value, { limit: CONTROL_ROOM_QUERY_LIMITS.maximumObservationLimit + 1 }))
      .toThrowError(expect.objectContaining({ code: "INVALID_LIMIT" }));
    const removed = value.observations[0]!;
    const expired = {
      ...value,
      firstAvailableSeq: 3,
      observations: value.observations.slice(1),
      observationBytes: value.observationBytes - Buffer.byteLength(JSON.stringify(removed), "utf8"),
      droppedRecords: 1,
      droppedBytes: Buffer.byteLength(JSON.stringify(removed), "utf8")
    };
    expect(() => queryControlRoomObservations(expired, { afterSeq: 1 })).toThrowError(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
  });

  it("returns valid empty pages at an already-current cursor", () => {
    const result = queryControlRoomObservations(projection(), { afterSeq: 4 });
    expect(result.page.records).toEqual([]);
    expect(result.page.nextAfter).toBe(4);
    expect(result.hasMore).toBe(false);
  });

  it("groups attention deterministically while keeping a stable agent cursor", () => {
    let value = projection();
    value = applyControlRoomFact(value, state(5, "worker-z", "idle"));
    value = applyControlRoomFact(value, state(6, "worker-a", "waiting_input"));
    value = applyControlRoomFact(value, state(7, "worker-b", "blocked"));
    value = applyControlRoomFact(value, state(8, "worker-c", "exited"));
    const first = queryControlRoomRows(value, { limit: 2 });
    expect(first.rows.map((row) => [row.agentId, row.attention])).toEqual([
      ["worker-a", "needs_input"],
      ["worker-b", "blocked"]
    ]);
    expect(first.nextAfterAgentId).toBe("worker-b");
    const second = queryControlRoomRows(value, { limit: 10, afterAgentId: first.nextAfterAgentId });
    expect(second.rows.map((row) => row.attention)).toEqual(["working", "idle", "complete"]);
    expect(queryControlRoomRows(value, { attention: ["blocked", "needs_input"] }).rows.map((row) => row.agentId))
      .toEqual(["worker-a", "worker-b"]);
  });

  it("refuses malformed row cursors and duplicate filters", () => {
    expect(() => queryControlRoomRows(projection(), { afterAgentId: "missing" })).toThrowError(expect.objectContaining({ code: "MALFORMED_CURSOR" }));
    expect(() => queryControlRoomRows(projection(), { attention: ["working", "working"] }))
      .toThrowError(expect.objectContaining({ code: "INVALID_LIMIT" }));
  });
});
