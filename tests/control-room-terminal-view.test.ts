import { describe, expect, it } from "vitest";
import { renderControlRoomTerminal } from "../src/control-room/terminal-view.js";
import type { ControlRoomViewModelV1 } from "../src/control-room/view-model.js";

function view(): ControlRoomViewModelV1 {
  const row = { key: "e:a", agentId: "worker-界", attention: "unknown" as const, attentionLabel: "Unknown", activityLabel: "unknown", taskLabel: "No assigned task · unknown", generationLabel: "runtime 1", sourceLabel: "Source not yet known", steeringLabel: "Steering unknown", scmLabel: "SCM unknown", verificationLabel: "Verification unknown", lastFactLabel: "Fact #0", latestSummary: "bounded summary" };
  const buckets = (["needs_input", "blocked", "failed", "working", "settling", "idle", "complete", "unknown"] as const).map((id) => ({ id, label: id === "unknown" ? "Unknown" : id, count: id === "unknown" ? 1 : 0, rows: id === "unknown" ? [row] : [] }));
  return { schemaVersion: 1, mode: "degraded", title: "RelayForge control room", connectionLabel: "Degraded", headLabel: "No durable snapshot", rows: [row], buckets, timeline: [], notices: [{ code: "source_unknown", severity: "info", text: "Source not yet known." }], degraded: true };
}

describe("control-room terminal renderer", () => {
  it("renders the same degradation and unknown labels without terminal capture", () => {
    const output = renderControlRoomTerminal(view(), { width: 80, height: 30 });
    expect(output).toContain("Degraded | No durable snapshot");
    expect(output).toContain("Source not yet known");
    expect(output).toContain("No normalized observations");
  });

  it("caps Unicode by display width and output height deterministically", () => {
    const output = renderControlRoomTerminal(view(), { width: 32, height: 6 });
    const lines = output.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.every((line) => [...line].length <= 32)).toBe(true);
    expect(lines.at(-1)).toMatch(/lines omitted/u);
  });

  it("rejects dimensions outside closed bounds", () => {
    expect(() => renderControlRoomTerminal(view(), { width: 31 })).toThrow(RangeError);
    expect(() => renderControlRoomTerminal(view(), { height: 201 })).toThrow(RangeError);
  });
});
