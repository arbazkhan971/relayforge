import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  assertObservationSafeGraph,
  materializeObservationRecord,
  ObservationPrivacyError,
  redactObservationSummary,
  serializeObservationPage,
  toPublicObservation
} from "../src/observability/public.js";
import { OBSERVATION_LIMITS, OBSERVATION_SCHEMA_VERSION, type ObservationRecordV1 } from "../src/observability/types.js";

const EPOCH = "epoch_1234567890123456";
const AT = "2026-08-09T12:00:00.000Z";

function draft(overrides: Partial<ObservationRecordV1> = {}) {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seq: 1,
    recordId: "observation-1",
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
    category: "provider" as const,
    phase: "executing" as const,
    severity: "info" as const,
    code: "provider.progress",
    details: { kind: "progress" as const, operationCode: "turn.running" },
    sourceIntegrity: "live" as const,
    ...overrides
  };
}

describe("observation privacy boundary", () => {
  it("redacts credentials, paths, URLs, ANSI controls, and opaque tokens before materialization", () => {
    const opaque = "A".repeat(80);
    const summary = `\u001b[31mTOKEN=super-secret /home/alice/private https://alice:pw@example.com/x ${opaque}\u001b[0m`;
    const record = materializeObservationRecord({ ...draft(), summary });
    const encoded = JSON.stringify(record);
    expect(record.summary?.redacted).toBe(true);
    expect(encoded).not.toContain("super-secret");
    expect(encoded).not.toContain("/home/alice");
    expect(encoded).not.toContain("alice:pw");
    expect(encoded).not.toContain(opaque);
    expect(encoded).not.toContain("\u001b");
    expect(encoded).toContain("[credential]");
    expect(encoded).toContain("[path]");
    expect(encoded).toContain("[url]");
    expect(encoded).toContain("[opaque]");
  });

  it("truncates by UTF-8 scalar without splitting multibyte text", () => {
    const value = "🙂".repeat(1_000);
    const summary = redactObservationSummary(value);
    expect(summary.truncated).toBe(true);
    expect(summary.retainedBytes).toBe(OBSERVATION_LIMITS.maximumSummaryBytes);
    expect(Buffer.byteLength(summary.text, "utf8")).toBe(summary.retainedBytes);
    expect(summary.text.endsWith("🙂")).toBe(true);
  });

  it("can replace a short secret with a longer fixed placeholder without falsifying truncation", () => {
    const record = materializeObservationRecord({ ...draft(), summary: "token=x" });
    expect(record.summary).toEqual({
      text: "[credential]",
      redacted: true,
      truncated: false,
      originalBytes: 7,
      retainedBytes: 12
    });
  });

  it("rejects forbidden keys recursively before a strict parser sees them", () => {
    expect(() => assertObservationSafeGraph({ safe: { prompt: "do not expose" } }))
      .toThrowError(expect.objectContaining<Partial<ObservationPrivacyError>>({ code: "FORBIDDEN_KEY" }));
    expect(() => toPublicObservation({ ...draft(), cwd: "/tmp/private" }))
      .toThrowError(expect.objectContaining<Partial<ObservationPrivacyError>>({ code: "FORBIDDEN_KEY" }));
  });

  it("never invokes accessors while inspecting untrusted objects", () => {
    let invoked = 0;
    const value = {} as Record<string, unknown>;
    Object.defineProperty(value, "safe", { enumerable: true, get() { invoked += 1; return "secret"; } });
    expect(() => assertObservationSafeGraph(value))
      .toThrowError(expect.objectContaining<Partial<ObservationPrivacyError>>({ code: "ACCESSOR_PROPERTY" }));
    expect(invoked).toBe(0);
  });

  it("rejects cycles, symbols, class prototypes, depth, and array fanout", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertObservationSafeGraph(cycle)).toThrowError(expect.objectContaining({ code: "CYCLIC_VALUE" }));
    expect(() => assertObservationSafeGraph({ [Symbol("secret")]: 1 })).toThrowError(expect.objectContaining({ code: "SYMBOL_PROPERTY" }));
    expect(() => assertObservationSafeGraph(new Date())).toThrowError(expect.objectContaining({ code: "UNSAFE_PROTOTYPE" }));
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < OBSERVATION_LIMITS.maximumGraphDepth + 2; index += 1) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    expect(() => assertObservationSafeGraph(root)).toThrowError(expect.objectContaining({ code: "GRAPH_LIMIT" }));
    expect(() => assertObservationSafeGraph(new Array(OBSERVATION_LIMITS.maximumArrayItems + 1).fill(0)))
      .toThrowError(expect.objectContaining({ code: "GRAPH_LIMIT" }));
  });

  it("uses an explicit public allowlist and preserves truthful redaction metadata", () => {
    const internal = materializeObservationRecord({ ...draft(), summary: "password=hunter2 work continues" });
    const publicRecord = toPublicObservation(internal);
    expect(publicRecord).toEqual(internal);
    expect(publicRecord.summary?.redacted).toBe(true);
    expect(publicRecord.summary?.originalBytes).toBeGreaterThan(publicRecord.summary?.retainedBytes ?? 0);
    const encoded = JSON.stringify(publicRecord);
    for (const forbidden of ["cwd", "worktree", "tmux", "pane", "socket", "prompt", "command", "argv", "environment", "raw", "stdout", "stderr"]) {
      expect(encoded).not.toContain(`\"${forbidden}\"`);
    }
  });

  it("serializes a bounded public page with no raw privacy sentinel", () => {
    const sentinel = "OBSERVABILITY_PRIVATE_SENTINEL";
    const internal = materializeObservationRecord({ ...draft(), summary: `secret=${sentinel}` });
    const page = {
      schemaVersion: 1,
      runId: "run-1",
      runEpoch: EPOCH,
      snapshotSeq: 1,
      projectionSeq: 1,
      firstAvailableSeq: 1,
      nextAfter: 1,
      truncated: false,
      droppedRecords: 0,
      droppedBytes: 0,
      freshness: "fresh",
      records: [toPublicObservation(internal)],
      sources: [{
        agentId: "worker-1",
        runtimeGeneration: 1,
        attemptGeneration: 1,
        sourceGeneration: 1,
        integrity: "live",
        lastObservedAt: AT,
        droppedRecords: 0,
        droppedBytes: 0
      }]
    };
    const encoded = serializeObservationPage(page);
    expect(encoded).not.toContain(sentinel);
    expect(Buffer.byteLength(encoded)).toBeLessThan(OBSERVATION_LIMITS.maximumPageBytes);
    expect(JSON.parse(encoded)).toEqual(page);
  });

  it("refuses an invalid public page instead of writing a partial response", () => {
    const internal = materializeObservationRecord(draft());
    expect(() => serializeObservationPage({
      schemaVersion: 1,
      runId: "run-1",
      runEpoch: EPOCH,
      snapshotSeq: 0,
      projectionSeq: 0,
      firstAvailableSeq: 1,
      nextAfter: 1,
      truncated: false,
      droppedRecords: 0,
      droppedBytes: 0,
      freshness: "fresh",
      records: [internal],
      sources: []
    })).toThrowError(expect.objectContaining<Partial<ObservationPrivacyError>>({ code: "INVALID_PAGE" }));
  });
});
