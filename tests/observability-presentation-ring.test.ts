import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  createObservationPresentationRing,
  ObservationPresentationRing,
  PRESENTATION_RING_LIMITS,
  PresentationRingError
} from "../src/observability/presentation-ring.js";
import { materializeObservationRecord, toPublicObservation } from "../src/observability/public.js";
import { OBSERVATION_LIMITS, OBSERVATION_SCHEMA_VERSION, type PublicObservationV1 } from "../src/observability/types.js";

const EPOCH = "epoch_1234567890123456";
const AT = "2026-08-09T12:00:00.000Z";

function observation(seq: number, summary = `record ${seq}`, overrides: Partial<PublicObservationV1> = {}): PublicObservationV1 {
  return toPublicObservation(materializeObservationRecord({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seq,
    recordId: `observation-${seq}`,
    generation: {
      runId: "run-1",
      runEpoch: EPOCH,
      taskId: "task-1",
      agentId: "worker-1",
      runtimeGeneration: 1,
      attemptGeneration: 1,
      sourceGeneration: 1
    },
    observedAt: AT,
    recordedAt: AT,
    category: "provider",
    phase: "executing",
    severity: "info",
    code: "provider.progress",
    details: { kind: "progress", operationCode: "turn.running" },
    sourceIntegrity: "live",
    summary,
    ...overrides
  }));
}

function bytes(value: PublicObservationV1): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function ring(maximumItems = 4, maximumBytes = 64 * 1024): ObservationPresentationRing {
  return createObservationPresentationRing({ runId: "run-1", runEpoch: EPOCH, maximumItems, maximumBytes });
}

describe("bounded public observation presentation ring", () => {
  it("allocates lazily and accepts an exact byte-boundary record", () => {
    const record = observation(1, "🙂");
    const value = ring(1, bytes(record));
    expect(value.allocated).toBe(false);
    expect(value.append(record)).toEqual({ accepted: true, duplicate: false, evictedRecords: 0, evictedBytes: 0 });
    expect(value.allocated).toBe(true);
    expect(value.snapshot()).toMatchObject({
      retainedBytes: bytes(record),
      firstRetainedSeq: 1,
      lastRetainedSeq: 1,
      droppedRecords: 0,
      truncated: false
    });
  });

  it("drops a single oversized public record without allocating the ring", () => {
    const record = observation(1, "x".repeat(500));
    const value = ring(4, bytes(record) - 1);
    expect(value.append(record)).toEqual({
      accepted: false,
      duplicate: false,
      reason: "record_too_large",
      evictedRecords: 0,
      evictedBytes: 0
    });
    expect(value.allocated).toBe(false);
    expect(value.snapshot()).toMatchObject({
      records: [],
      lastSeenSeq: 1,
      droppedRecords: 1,
      droppedBytes: bytes(record),
      truncated: true
    });
    expect(value.append(record)).toMatchObject({ accepted: false, duplicate: true });
    expect(value.snapshot().droppedRecords).toBe(1);
  });

  it("evicts only whole oldest records under the item limit", () => {
    const value = ring(2);
    const first = observation(1);
    const second = observation(2);
    const third = observation(3);
    value.appendMany([first, second]);
    expect(value.append(third)).toEqual({ accepted: true, duplicate: false, evictedRecords: 1, evictedBytes: bytes(first) });
    expect(value.snapshot()).toMatchObject({
      records: [second, third],
      firstRetainedSeq: 2,
      lastRetainedSeq: 3,
      droppedRecords: 1,
      droppedBytes: bytes(first),
      truncated: true
    });
  });

  it("evicts whole records under the UTF-8 byte limit", () => {
    const first = observation(1, "🙂".repeat(10));
    const second = observation(2, "🙂".repeat(10));
    const third = observation(3, "🙂".repeat(10));
    const value = ring(10, bytes(second) + bytes(third));
    value.append(first);
    value.append(second);
    expect(value.append(third)).toMatchObject({ accepted: true, evictedRecords: 1, evictedBytes: bytes(first) });
    const snapshot = value.snapshot();
    expect(snapshot.records).toEqual([second, third]);
    expect(snapshot.retainedBytes).toBe(bytes(second) + bytes(third));
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(value.maximumBytes);
  });

  it("deduplicates exact last-sequence bytes and refuses conflicts or backwards input", () => {
    const value = ring();
    const first = observation(1);
    expect(value.append(first).duplicate).toBe(false);
    expect(value.append(first)).toEqual({ accepted: true, duplicate: true, evictedRecords: 0, evictedBytes: 0 });
    expect(() => value.append(observation(1, "different")))
      .toThrowError(expect.objectContaining<Partial<PresentationRingError>>({ code: "CONFLICTING_DUPLICATE" }));
    value.append(observation(3));
    expect(() => value.append(observation(2)))
      .toThrowError(expect.objectContaining<Partial<PresentationRingError>>({ code: "OUT_OF_ORDER" }));
  });

  it("supports durable sequence zero without confusing it with an empty ring", () => {
    const value = ring();
    const zero = observation(0);
    expect(value.append(zero).duplicate).toBe(false);
    expect(value.append(zero).duplicate).toBe(true);
    expect(value.snapshot()).toMatchObject({ firstRetainedSeq: 0, lastRetainedSeq: 0, lastSeenSeq: 0 });
  });

  it("refuses records from a different run or epoch", () => {
    const value = ring();
    expect(() => value.append(observation(1, "other", {
      generation: { ...observation(1).generation, runId: "run-2" }
    }))).toThrowError(expect.objectContaining<Partial<PresentationRingError>>({ code: "WRONG_RUN" }));
    expect(() => value.append(observation(1, "other", {
      generation: { ...observation(1).generation, runEpoch: "epoch_9999999999999999" }
    }))).toThrowError(expect.objectContaining<Partial<PresentationRingError>>({ code: "WRONG_RUN" }));
  });

  it("returns the pre-reset snapshot and restores the lazy empty state", () => {
    const value = ring();
    value.appendMany([observation(1), observation(2)]);
    const previous = value.reset();
    expect(previous.records).toHaveLength(2);
    expect(value.allocated).toBe(false);
    expect(value.snapshot()).toEqual({
      runId: "run-1",
      runEpoch: EPOCH,
      records: [],
      retainedBytes: 0,
      lastSeenSeq: 0,
      droppedRecords: 0,
      droppedBytes: 0,
      truncated: false
    });
    expect(value.append(observation(1)).accepted).toBe(true);
  });

  it("enforces closed constructor and batch limits", () => {
    expect(() => ring(0)).toThrowError(expect.objectContaining({ code: "INVALID_LIMITS" }));
    expect(() => ring(PRESENTATION_RING_LIMITS.maximumItems + 1)).toThrowError(expect.objectContaining({ code: "INVALID_LIMITS" }));
    expect(() => ring(1, PRESENTATION_RING_LIMITS.maximumBytes + 1)).toThrowError(expect.objectContaining({ code: "INVALID_LIMITS" }));
    const value = ring();
    expect(() => value.appendMany(new Array(OBSERVATION_LIMITS.maximumPageRecords + 1).fill(observation(1))))
      .toThrowError(expect.objectContaining({ code: "INVALID_LIMITS" }));
  });

  it("maintains both bounds and exact loss accounting across deterministic wrap matrices", () => {
    for (let maximumItems = 1; maximumItems <= 8; maximumItems += 1) {
      const sample = observation(1, "🙂".repeat(maximumItems));
      const maximumBytes = bytes(sample) * Math.max(1, Math.ceil(maximumItems / 2));
      const value = ring(maximumItems, maximumBytes);
      for (let seq = 1; seq <= 40; seq += 1) {
        value.append(observation(seq, "🙂".repeat(maximumItems)));
        const snapshot = value.snapshot();
        expect(snapshot.records.length).toBeLessThanOrEqual(maximumItems);
        expect(snapshot.retainedBytes).toBeLessThanOrEqual(maximumBytes);
        expect(snapshot.retainedBytes).toBe(snapshot.records.reduce((sum, item) => sum + bytes(item), 0));
        expect(snapshot.droppedRecords + snapshot.records.length).toBe(seq);
      }
    }
  });

  it("accepts only the closed public DTO and never terminal byte buffers", () => {
    const value = ring();
    expect(() => value.append(Buffer.from("raw terminal bytes") as unknown as PublicObservationV1)).toThrow();
    expect(value.allocated).toBe(false);
  });
});
