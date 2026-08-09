import { describe, expect, it } from "vitest";
import { renderControlRoomHtml } from "../src/control-room/render.js";
import type { ControlRoomViewModelV1 } from "../src/control-room/view-model.js";

function view(): ControlRoomViewModelV1 {
  const row = { key: "epoch:agent", agentId: "agent<script>", attention: "blocked" as const, attentionLabel: "Blocked", activityLabel: "blocked", taskLabel: "task & blocked", generationLabel: "runtime 1", sourceLabel: "Source not yet known", steeringLabel: "Steering none", scmLabel: "SCM unknown", verificationLabel: "Verification failing", lastFactLabel: "Fact #1", latestSummary: "<img src=x>" };
  const buckets = (["needs_input", "blocked", "failed", "working", "settling", "idle", "complete", "unknown"] as const).map((id) => ({ id, label: id, count: id === "blocked" ? 1 : 0, rows: id === "blocked" ? [row] : [] }));
  return { schemaVersion: 1, mode: "degraded", runId: "run", runEpoch: "epoch", title: "RelayForge <control>", connectionLabel: "Degraded", headLabel: "head #1", rows: [row], buckets, timeline: [{ key: "one", seq: 1, agentId: "agent", categoryLabel: "tool", severity: "warning", timeLabel: "now", code: "tool", text: "& done", integrityLabel: "Source degraded" }], notices: [{ code: "source_unknown", severity: "info", text: "Unknown <source>" }], degraded: true };
}

describe("control-room HTML renderer", () => {
  it("renders semantic accessible sections and escapes every public scalar", () => {
    const html = renderControlRoomHtml(view());
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Agent attention"');
    expect(html).toContain("RelayForge &lt;control&gt;");
    expect(html).toContain("agent&lt;script&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
  });

  it("renders all fixed attention buckets, including empty buckets", () => {
    const html = renderControlRoomHtml(view());
    expect((html.match(/class="attention-bucket"/gu) ?? [])).toHaveLength(8);
    expect(html).toContain("No agents");
  });
});
