import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addEvent, addTask, initBoard, type BoardTask } from "../src/board.js";
import { initCostLedger, recordCost } from "../src/cost.js";
import { buildAgentCards, buildGraph, buildOverview, criticalPath } from "../src/dashboard/data.js";
import type { ProjectConfig } from "../src/config/schema.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "loop-dash-"));
}

function task(id: string, assignee: string, extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id, title: `task ${id}`, assignee, createdBy: "pm", description: "x",
    acceptanceCriteria: ["ok"], dependsOn: [], priority: 5,
    createdAt: "2026-06-13T09:00:00Z", ...extra
  };
}

const project = {
  name: "demo",
  roles: [
    { name: "be", title: "Backend", provider: "codex", sme: "backend", repositories: [], responsibilities: [], guardrails: [], autoStart: true },
    { name: "qa", title: "QA", provider: "claude", sme: "qa", repositories: [], responsibilities: [], guardrails: [], autoStart: true }
  ],
  loops: [{ name: "l", cadenceMinutes: 30, maxIterations: 8, stopWhen: [], pollSeconds: 8, orchestrator: "pm", maxRepairs: 2, reviewer: "qa", budgetUsd: 1, maxParallel: 2 }]
} as unknown as ProjectConfig;

describe("dashboard overview", () => {
  it("computes progress, blocked, retries, and spend", () => {
    const dir = tmp();
    initBoard(dir);
    initCostLedger(dir);
    addTask(dir, task("t1", "be"));
    addTask(dir, task("t2", "be", { dependsOn: ["t1"] }));
    addEvent(dir, { ts: "2026-06-13T09:01:00Z", role: "be", taskId: "t1", status: "done", summary: "ok" });
    addEvent(dir, { ts: "2026-06-13T09:02:00Z", role: "be", taskId: "t2", status: "blocked", summary: "boom" });
    recordCost(dir, { ts: "2026-06-13T09:01:00Z", role: "be", taskId: "t1", usd: 0.5 });

    const o = buildOverview(dir, project);
    expect(o.totals.total).toBe(2);
    expect(o.totals.done).toBe(1);
    expect(o.totals.blocked).toBe(1);
    expect(o.retries).toBe(1);
    expect(o.spendUsd).toBeCloseTo(0.5);
    expect(o.budgetPct).toBe(50);
    expect(o.progressPct).toBe(50);
  });
});

describe("dashboard graph + critical path", () => {
  it("marks blocking dependencies and the longest chain", () => {
    const dir = tmp();
    initBoard(dir);
    addTask(dir, task("a", "be"));
    addTask(dir, task("b", "be", { dependsOn: ["a"] }));
    addTask(dir, task("c", "qa", { dependsOn: ["b"] }));
    addEvent(dir, { ts: "1", role: "be", taskId: "a", status: "done" });

    const g = buildGraph(dir);
    const b = g.nodes.find((n) => n.id === "b")!;
    expect(b.blockedBy).toEqual([]); // a is done
    expect(b.ready).toBe(true); // open + deps satisfied
    const c = g.nodes.find((n) => n.id === "c")!;
    expect(c.blockedBy).toEqual(["b"]); // b not done
    // critical path is the longest not-done chain: a→b→c folds to b→c (a done) ... includes c
    expect(g.criticalPath).toContain("c");
  });

  it("criticalPath returns the longest dependency chain among unfinished tasks", () => {
    const views = [
      { id: "x", dependsOn: [], status: "open" },
      { id: "y", dependsOn: ["x"], status: "open" },
      { id: "z", dependsOn: ["y"], status: "open" }
    ] as any;
    expect(criticalPath(views)).toEqual(["x", "y", "z"]);
  });
});

describe("dashboard agent cards", () => {
  it("reflects each agent's current task and state", () => {
    const dir = tmp();
    initBoard(dir);
    addTask(dir, task("t1", "be"));
    addEvent(dir, { ts: "1", role: "be", taskId: "t1", status: "claimed" });

    const cards = buildAgentCards(dir, project);
    const be = cards.find((c) => c.role === "be")!;
    expect(be.state).toBe("working");
    expect(be.currentTaskId).toBe("t1");
    const qa = cards.find((c) => c.role === "qa")!;
    expect(qa.state).toBe("idle");
  });
});
