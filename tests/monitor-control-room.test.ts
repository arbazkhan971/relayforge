import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initBoard } from "../src/board.js";
import type { ControlRoomViewModelV1 } from "../src/control-room/view-model.js";
import { renderFrame } from "../src/monitor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function board(): string {
  const root = mkdtempSync(join(tmpdir(), "relayforge-monitor-room-"));
  roots.push(root);
  const path = join(root, "board");
  initBoard(path);
  return path;
}

function model(): ControlRoomViewModelV1 {
  const row = {
    key: "epoch:worker-1",
    agentId: "worker-1",
    taskId: "task-1",
    attention: "working" as const,
    attentionLabel: "Working",
    activityLabel: "active",
    taskLabel: "task-1 · claimed",
    generationLabel: "runtime 1 · attempt 1 · source 1",
    sourceLabel: "live source",
    steeringLabel: "Steering none",
    scmLabel: "SCM unpublished",
    verificationLabel: "Verification pending",
    lastFactLabel: "Fact #8 · 2026-08-09T12:00:00.000Z",
    latestSummary: "normalized bounded progress"
  };
  const buckets = (["needs_input", "blocked", "failed", "working", "settling", "idle", "complete", "unknown"] as const)
    .map((id) => ({ id, label: id, count: id === "working" ? 1 : 0, rows: id === "working" ? [row] : [] }));
  return {
    schemaVersion: 1,
    mode: "ready",
    runId: "run-1",
    runEpoch: "epoch_1234567890123456",
    title: "RelayForge control room · run-1",
    connectionLabel: "Live and verified",
    headLabel: "Durable head #8 · projection #8",
    rows: [row],
    buckets,
    timeline: [{ key: "one", seq: 8, agentId: "worker-1", categoryLabel: "provider", severity: "info", timeLabel: "2026-08-09T12:00:00.000Z", code: "provider.progress", text: "normalized bounded progress", integrityLabel: "Source live" }],
    notices: [],
    degraded: false
  };
}

describe("legacy monitor P5 cutover", () => {
  it("renders the shared normalized model without exposing or capturing pane/session identifiers", () => {
    const output = renderFrame({
      boardDir: board(),
      session: "PRIVATE_TMUX_SESSION",
      panes: { worker: "%PRIVATE_PANE" },
      tailLines: 500,
      controlRoom: model()
    });
    expect(output).toContain("RelayForge control room · run-1");
    expect(output).toContain("normalized bounded progress");
    expect(output).not.toContain("PRIVATE_TMUX_SESSION");
    expect(output).not.toContain("PRIVATE_PANE");
  });

  it("reports absent normalized evidence as unknown rather than idle or successful", () => {
    const output = renderFrame({ boardDir: board(), session: "ignored", panes: {} });
    expect(output).toContain("No normalized observation snapshot is configured; activity is unknown.");
    expect(output).not.toContain("…idle…");
  });
});
