import { describe, expect, it } from "vitest";
import type { ControlRoomClientState, ControlRoomSnapshotV1 } from "../src/control-room/client.js";
import { encodeControlRoomObservationCursor } from "../src/control-room/query.js";
import { buildControlRoomViewModel, controlRoomAttentionBuckets } from "../src/control-room/view-model.js";

const epoch = "epoch_abcdefghijklmnop";
function state(overrides: Partial<ControlRoomClientState> = {}): ControlRoomClientState {
  const record = {
    schemaVersion: 1 as const, seq: 4, recordId: "record-4",
    generation: { runId: "run-1", runEpoch: epoch, taskId: "task-1", agentId: "agent-1", runtimeGeneration: 1, attemptGeneration: 2, sourceGeneration: 3 },
    observedAt: "2026-08-09T12:00:00.000Z", recordedAt: "2026-08-09T12:00:01.000Z",
    category: "progress" as const, phase: "implementation" as const, severity: "info" as const, code: "progress.updated",
    details: { kind: "progress" as const, operationCode: "tests", completed: 2, total: 3 }, sourceIntegrity: "replaced" as const,
    summary: { text: "verified & bounded", redacted: true, truncated: false, originalBytes: 18, retainedBytes: 18 }
  };
  const snapshot: ControlRoomSnapshotV1 = {
    schemaVersion: 1, runId: "run-1", runEpoch: epoch, eventHeadSeq: 5,
    rows: [{ agentId: "agent-1", taskId: "task-1", runtimeGeneration: 1, attemptGeneration: 2, sourceGeneration: 3, activity: "waiting_input", attention: "needs_input", taskStatus: "claimed", steeringState: "pending", pendingCommands: 2, scmState: "changes_requested", verificationState: "failing", sourceIntegrity: "replaced", sourceStateCode: "source.replaced", sourceDroppedRecords: 2, sourceDroppedBytes: 10, lastFactSeq: 4, lastObservedAt: record.observedAt, lastObservation: record }],
    observationPage: { schemaVersion: 1, runId: "run-1", runEpoch: epoch, snapshotSeq: 5, projectionSeq: 4, firstAvailableSeq: 2, nextAfter: 4, truncated: true, droppedRecords: 2, droppedBytes: 10, freshness: "stale", records: [record], sources: [{ agentId: "agent-1", runtimeGeneration: 1, attemptGeneration: 2, sourceGeneration: 3, integrity: "replaced", lastObservedAt: record.observedAt, droppedRecords: 2, droppedBytes: 10 }] },
    nextCursor: encodeControlRoomObservationCursor({ schemaVersion: 1, runEpoch: epoch, afterSeq: 4 })
  };
  return { mode: "degraded", snapshot, reasonCode: "subscription_unavailable", refreshCount: 1, coalescedNotifications: 0, ...overrides };
}

describe("control-room view model", () => {
  it("keeps a fixed attention spine and derives labels only from verified parent facts", () => {
    const view = buildControlRoomViewModel(state());
    expect(view.buckets.map((bucket) => bucket.id)).toEqual(controlRoomAttentionBuckets);
    expect(view.buckets.find((bucket) => bucket.id === "needs_input")?.rows[0]).toMatchObject({ key: `${epoch}:agent-1`, activityLabel: "waiting input", sourceLabel: "Source replaced", steeringLabel: "2 steering commands pending" });
    expect(view.timeline[0]).toMatchObject({ text: "verified & bounded", integrityLabel: "Source replaced" });
  });

  it("distinguishes degraded, stale, replaced, truncated, dropped, empty, and unknown states", () => {
    const codes = buildControlRoomViewModel(state()).notices.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(["subscription_unavailable", "projection_stale", "history_truncated", "records_dropped", "source_replaced"]));
    const empty = buildControlRoomViewModel({ mode: "loading", refreshCount: 0, coalescedNotifications: 0 });
    expect(empty).toMatchObject({ connectionLabel: "Loading", headLabel: "No durable snapshot", rows: [], timeline: [] });
    expect(empty.notices.map((item) => item.code)).toEqual(["loading"]);
  });

  it("retains the last verified snapshot when the client reports a refresh failure", () => {
    const view = buildControlRoomViewModel(state({ reasonCode: "snapshot_failed" }));
    expect(view.rows).toHaveLength(1);
    expect(view.notices[0]).toMatchObject({ code: "snapshot_failed", severity: "error" });
  });
});
