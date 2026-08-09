import { describe, expect, it } from "vitest";
import type { SteeringDashboardData } from "../src/dashboard/steering-data.js";
import { DASHBOARD_CLIENT_JS, renderDashboard } from "../src/dashboard/render.js";
import { renderSteeringMonitor } from "../src/monitor.js";

describe("steering dashboard rendering", () => {
  it("includes one observational next-prompt panel and the seven truthful activity labels", () => {
    const html = renderDashboard("demo");
    expect(html).toContain("Next-prompt steering");
    expect(html).toContain('id="steering-count"');
    expect(html).toContain('id="steering"');
    for (const label of [
      "Idle",
      "Waiting for next prompt",
      "Preparing attempt",
      "Active",
      "Reconciling",
      "Blocked",
      "Exited"
    ]) {
      expect(DASHBOARD_CLIENT_JS).toContain(label);
    }
  });

  it("renders only read-side lifecycle language and no prompt artifact or terminal-input path", () => {
    expect(DASHBOARD_CLIENT_JS).toContain("Pending; eligible for attempt");
    expect(DASHBOARD_CLIENT_JS).toContain("Included in attempt");
    expect(DASHBOARD_CLIENT_JS).toContain("Refused; reason");
    expect(DASHBOARD_CLIENT_JS).toContain("/steering");

    for (const forbidden of [
      /\bSent\b/u,
      /\bDelivered\b/u,
      /\bRead\b/u,
      /\bProcessed\b/u,
      /send-keys/iu,
      /stdin\.write/iu,
      /artifactLocator/u,
      /promptBytes/u,
      /method:\s*["']POST["']/u
    ]) {
      expect(DASHBOARD_CLIENT_JS).not.toMatch(forbidden);
    }
    expect(renderDashboard("demo")).not.toContain("<form");
  });

  it("keeps the terminal monitor output-only while showing freshness, generations, and attempt linkage", () => {
    const hash = "a".repeat(64);
    const view = {
      schemaVersion: 1,
      project: "demo",
      run: "run-1",
      runEpoch: "epoch-000000000001",
      observedSeq: 10,
      headSeq: 12,
      floorSeq: 1,
      stale: true,
      queue: { pendingCount: 1, oldestPendingAgeMs: 65_000 },
      sessions: [{
        sessionId: "session-1",
        sessionGeneration: 2,
        taskId: "task-1",
        taskGeneration: 3,
        activity: "settling",
        activityLabel: "Reconciling",
        certainty: "proven",
        reason: "parent reconciliation pending",
        observedAt: "2026-08-09T00:00:00.000Z",
        observedAgeMs: 1_000,
        observedSeq: 10,
        headSeq: 12,
        stale: true,
        queue: {
          pendingCount: 1,
          oldestPendingAgeMs: 65_000,
          nextEligibleAttemptGeneration: 4,
          boundaryReason: "reconciliation-pending"
        }
      }],
      commandCount: 2,
      commandsTruncated: false,
      commands: [
        {
          commandId: "command-1",
          status: "pending",
          statusLabel: "Pending",
          statusDetail: "Pending; eligible for attempt 4",
          sourceKind: "operator",
          admittedSeq: 8,
          admittedAt: "2026-08-09T00:00:00.000Z",
          terminalSeq: null,
          sessionId: "session-1",
          sessionGeneration: 2,
          taskId: "task-1",
          taskGeneration: 3,
          notBeforeAttemptGeneration: 4,
          eligibleAttemptGeneration: 4,
          bodySha256: "b".repeat(64),
          preview: "private preview must not appear in monitor",
          reasonCode: null,
          supersededByCommandId: null,
          attempt: null
        },
        {
          commandId: "command-2",
          status: "included",
          statusLabel: "Included",
          statusDetail: `Included in attempt 3; prompt sha256:${hash}`,
          sourceKind: "verifier",
          admittedSeq: 5,
          admittedAt: "2026-08-08T23:59:00.000Z",
          terminalSeq: 7,
          sessionId: "session-1",
          sessionGeneration: 2,
          taskId: "task-1",
          taskGeneration: 3,
          notBeforeAttemptGeneration: 3,
          eligibleAttemptGeneration: null,
          bodySha256: "c".repeat(64),
          preview: "another private preview",
          reasonCode: null,
          supersededByCommandId: null,
          attempt: {
            attemptId: "attempt-3",
            attemptGeneration: 3,
            promptSha256: hash,
            includedSeq: 7,
            state: "exited",
            preparedSeq: 6,
            launchPlannedSeq: 8,
            providerStartedSeq: 9,
            providerExitedSeq: 10,
            providerExitCode: 1,
            outcome: "failed",
            abandonedSeq: null
          }
        }
      ]
    } satisfies SteeringDashboardData;

    const output = renderSteeringMonitor(view, 200).join("\n");
    expect(output).toContain("1 pending · oldest 1m · stale 10/12");
    expect(output).toContain("Reconciling · session-1 gen 2 · task-1 gen 3 · next attempt 4");
    expect(output).toContain("Pending; eligible for attempt 4");
    expect(output).toContain(`Included in attempt 3; prompt sha256:${hash}`);
    expect(output).not.toContain("private preview");
  });
});
