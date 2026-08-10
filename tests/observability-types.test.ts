import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  OBSERVATION_LIMITS,
  OBSERVATION_SCHEMA_VERSION,
  ObservationPageV1Schema,
  ObservationRecordV1Schema,
  ObservationSummaryV1Schema,
  parseObservationPage,
  parseObservationRecord,
  type ObservationRecordV1
} from "../src/observability/types.js";

const OBSERVED = "2026-08-09T12:00:00.000Z";
const RECORDED = "2026-08-09T12:00:01.000Z";
const EPOCH = "epoch_1234567890123456";

function record(overrides: Partial<ObservationRecordV1> = {}): ObservationRecordV1 {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seq: 7,
    recordId: "observation-7",
    generation: {
      runId: "run-1",
      runEpoch: EPOCH,
      taskId: "task-1",
      agentId: "implementer-1",
      runtimeGeneration: 2,
      attemptGeneration: 3,
      sourceGeneration: 4
    },
    observedAt: OBSERVED,
    recordedAt: RECORDED,
    category: "runtime",
    phase: "executing",
    severity: "info",
    code: "runtime.active",
    details: { kind: "lifecycle", activity: "active", stateCode: "turn.running" },
    sourceIntegrity: "live",
    ...overrides
  };
}

describe("closed observation v1 schemas", () => {
  it("accepts a fully fenced normalized record and preserves its exact generation tuple", () => {
    const parsed = parseObservationRecord(record());
    expect(parsed.generation).toEqual({
      runId: "run-1",
      runEpoch: EPOCH,
      taskId: "task-1",
      agentId: "implementer-1",
      runtimeGeneration: 2,
      attemptGeneration: 3,
      sourceGeneration: 4
    });
  });

  it("rejects unknown fields at every closed boundary", () => {
    expect(() => parseObservationRecord({ ...record(), cwd: "/secret" })).toThrow();
    expect(() => parseObservationRecord({
      ...record(),
      generation: { ...record().generation, pane: "%7" }
    })).toThrow();
    expect(() => parseObservationRecord({
      ...record(),
      details: { ...record().details, raw: "provider payload" }
    })).toThrow();
  });

  it("enforces category-specific detail unions", () => {
    expect(() => parseObservationRecord(record({
      category: "scm",
      details: { kind: "lifecycle", activity: "active", stateCode: "turn.running" }
    }))).toThrow(/detail kind/u);
    expect(parseObservationRecord(record({
      category: "scm",
      phase: "publishing",
      details: { kind: "scm", factKind: "publication", stateCode: "branch.published", evidenceCount: 1 }
    })).details.kind).toBe("scm");
  });

  it("rejects invalid generations, time reversal, inconsistent progress, and zero loss", () => {
    expect(() => parseObservationRecord(record({
      generation: { ...record().generation, sourceGeneration: 0 }
    }))).toThrow();
    expect(() => parseObservationRecord(record({ observedAt: RECORDED, recordedAt: OBSERVED }))).toThrow(/after durable/u);
    expect(() => parseObservationRecord(record({
      details: { kind: "progress", operationCode: "files.scanned", completed: 2 }
    }))).toThrow(/supplied together/u);
    expect(() => parseObservationRecord(record({
      details: { kind: "loss", droppedRecords: 0, droppedBytes: 0, reasonCode: "none" },
      loss: { droppedRecords: 0, droppedBytes: 0, reasonCode: "none" }
    }))).toThrow(/nonzero/u);
  });

  it("counts summary and record limits in UTF-8 bytes", () => {
    const text = "🙂".repeat((OBSERVATION_LIMITS.maximumSummaryBytes / 4) + 1);
    expect(ObservationSummaryV1Schema.safeParse({
      text,
      redacted: false,
      truncated: false,
      originalBytes: Buffer.byteLength(text),
      retainedBytes: Buffer.byteLength(text)
    }).success).toBe(false);

    const hugeCodeRecord = record({
      summary: {
        text: "x".repeat(OBSERVATION_LIMITS.maximumSummaryBytes),
        redacted: false,
        truncated: false,
        originalBytes: OBSERVATION_LIMITS.maximumSummaryBytes,
        retainedBytes: OBSERVATION_LIMITS.maximumSummaryBytes
      }
    });
    expect(Buffer.byteLength(JSON.stringify(hugeCodeRecord))).toBeLessThan(OBSERVATION_LIMITS.maximumRecordBytes);
    expect(ObservationRecordV1Schema.safeParse(hugeCodeRecord).success).toBe(true);
  });

  it("requires strictly ordered, run-bound page records and exact next cursor", () => {
    const first = record({ seq: 7, recordId: "observation-7" });
    const second = record({ seq: 9, recordId: "observation-9" });
    const page = {
      schemaVersion: 1,
      runId: "run-1",
      runEpoch: EPOCH,
      snapshotSeq: 9,
      projectionSeq: 9,
      firstAvailableSeq: 7,
      nextAfter: 9,
      truncated: false,
      droppedRecords: 0,
      droppedBytes: 0,
      freshness: "fresh",
      records: [first, second],
      sources: [{
        agentId: "implementer-1",
        runtimeGeneration: 2,
        attemptGeneration: 3,
        sourceGeneration: 4,
        integrity: "live",
        lastObservedAt: OBSERVED,
        droppedRecords: 0,
        droppedBytes: 0
      }]
    } as const;
    expect(parseObservationPage(page).nextAfter).toBe(9);
    expect(ObservationPageV1Schema.safeParse({ ...page, nextAfter: 8 }).success).toBe(false);
    expect(ObservationPageV1Schema.safeParse({ ...page, records: [second, first] }).success).toBe(false);
    expect(ObservationPageV1Schema.safeParse({
      ...page,
      records: [record({ generation: { ...record().generation, runEpoch: "different_123456789012" } })]
    }).success).toBe(false);
  });

  it("distinguishes stale projection state from a falsely fresh page", () => {
    const base = {
      schemaVersion: 1,
      runId: "run-1",
      runEpoch: EPOCH,
      snapshotSeq: 9,
      projectionSeq: 8,
      firstAvailableSeq: 10,
      nextAfter: 9,
      truncated: false,
      droppedRecords: 0,
      droppedBytes: 0,
      freshness: "stale",
      records: [],
      sources: []
    } as const;
    expect(parseObservationPage(base).freshness).toBe("stale");
    expect(ObservationPageV1Schema.safeParse({ ...base, freshness: "fresh" }).success).toBe(false);
  });
});
