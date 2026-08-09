import { describe, expect, it } from "vitest";
import { buildControlRoomSnapshot, serializeControlRoomSnapshot, type ControlRoomReadSource } from "../src/control-room/server-adapter.js";
import { reduceControlRoomFacts } from "../src/control-room/projection.js";

const epoch = "epoch_abcdefghijklmnop";
function source(overrides: Partial<ControlRoomReadSource> = {}): ControlRoomReadSource {
  const projection = reduceControlRoomFacts("run-1", epoch, [{ schemaVersion: 1, kind: "agent_state", seq: 1, generation: { runId: "run-1", runEpoch: epoch, taskId: "task-1", agentId: "agent-1", runtimeGeneration: 1, attemptGeneration: 1, sourceGeneration: 1 }, observedAt: "2026-08-09T12:00:00.000Z", activity: "active", taskStatus: "claimed", steeringState: "none", pendingCommands: 0, scmState: "unpublished", verificationState: "pending" }]);
  return { runId: "run-1", runEpoch: epoch, controlRoomProjection: () => projection, controlRoomEventHead: () => 1, ...overrides };
}

describe("control-room server adapter", () => {
  it("builds a strict same-head snapshot with a verified cursor", () => {
    const snapshot = buildControlRoomSnapshot(source());
    expect(snapshot).toMatchObject({ runId: "run-1", runEpoch: epoch, eventHeadSeq: 1, rows: [{ agentId: "agent-1" }], observationPage: { snapshotSeq: 1, projectionSeq: 1, freshness: "fresh" } });
    expect(snapshot.nextCursor).toMatch(/^v1\./u);
  });

  it("shows stale/rebuilding without inventing authority", () => {
    const snapshot = buildControlRoomSnapshot(source({ controlRoomEventHead: () => 2, controlRoomAvailability: () => "rebuilding" }));
    expect(snapshot.observationPage).toMatchObject({ snapshotSeq: 2, projectionSeq: 1, freshness: "rebuilding" });
  });

  it("rejects identity/head mismatches and caps encoded UTF-8 before writing", () => {
    expect(() => buildControlRoomSnapshot(source({ runId: "other" }))).toThrowError(expect.objectContaining({ code: "IDENTITY_MISMATCH" }));
    expect(() => buildControlRoomSnapshot(source({ controlRoomEventHead: () => 0 }))).toThrowError(expect.objectContaining({ code: "HEAD_MISMATCH" }));
    const snapshot = buildControlRoomSnapshot(source());
    expect(() => serializeControlRoomSnapshot(snapshot, 10)).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
    expect(serializeControlRoomSnapshot(snapshot).body.toString("utf8")).not.toContain("worktree");
  });
});
