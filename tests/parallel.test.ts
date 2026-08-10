import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { foldBoard } from "../src/board.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { gitLog, runOnce } from "./e2e-harness.js";
import { registerOwnedTemp } from "./global-teardown.js";

setTrustedRunner(true);

/**
 * `maxParallel` — the "true parallelism" claim: several SMEs work concurrently, each in its own git
 * worktree, and the run stays correct.
 *
 * Every existing test pinned `maxParallel: 1`, so NOTHING proved that raising it does anything at
 * all (a `maxParallel` silently ignored, or a `for await` that serialized the batch, would have kept
 * the whole suite green), nor that it stays BOUNDED (an unbounded fan-out would sail past the cap and
 * oversubscribe the box), nor that one failing dispatch cannot take its concurrent siblings down.
 *
 * So we do not assert on configuration — we MEASURE. Each fake implementer records a real wall-clock
 * `start`/`end` interval, and we reconstruct the concurrency profile from the overlaps.
 */

function timelinePath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `loop-timeline-${name}-`));
  registerOwnedTemp(dir);
  return join(dir, "timeline");
}

type Interval = { task: string; start: number; end: number };

/** Reconstruct each task's execution interval from the fake providers' own timestamps. */
function intervals(path: string): Interval[] {
  const open = new Map<string, number>();
  const out: Interval[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const [kind, task, ms] = line.split(" ");
    if (kind === "start") open.set(task, Number(ms));
    else if (kind === "end" && open.has(task)) {
      out.push({ task, start: open.get(task)!, end: Number(ms) });
      open.delete(task);
    }
  }
  return out;
}

/** The greatest number of intervals overlapping at any instant — the concurrency actually reached. */
function peakConcurrency(list: Interval[]): number {
  const edges = list.flatMap((i) => [
    { at: i.start, delta: 1 },
    { at: i.end, delta: -1 }
  ]);
  // An `end` at exactly the same millisecond as a `start` is NOT an overlap — process the -1 first,
  // so a serialized run whose tasks abut cannot be miscounted as concurrent.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let live = 0;
  let peak = 0;
  for (const e of edges) {
    live += e.delta;
    peak = Math.max(peak, live);
  }
  return peak;
}

describe("maxParallel: real concurrency, really bounded", () => {
  it("maxParallel 2 with two SMEs OVERLAPS them (and both land on the run branch)", async () => {
    const timeline = timelinePath("overlap");
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      implementers: 2,
      maxParallel: 2,
      verify: ["ls feature-*.txt"],
      env: { FAKE_MODE: "parallel", FAKE_ASSIGNEES: "impl1,impl2", FAKE_WORK_MS: "700", FAKE_TIMELINE: timeline }
    });

    expect(state.status).toBe("done");
    const runs = intervals(timeline);
    expect(runs.length).toBe(2); // two distinct tasks really ran…
    expect(peakConcurrency(runs)).toBe(2); // …at the SAME TIME. This is the whole claim.

    // Both SMEs' work is on the run branch — concurrency did not lose or clobber a change.
    const merged = gitLog(repoDir, `loop/e2e/${runId}/integration`).filter((s) => s.startsWith("loop: integrate"));
    expect(merged.length).toBe(2);
  }, 90000);

  it("maxParallel 1 with two SMEs SERIALIZES them (the cap is what creates the overlap, not the fixture)", async () => {
    // The negative control. Without it, an "overlap" test can pass on a machine that overlaps for some
    // other reason, and would keep passing if maxParallel stopped being honoured.
    const timeline = timelinePath("serial");
    const { state } = await runOnce({
      execute: true,
      implementers: 2,
      maxParallel: 1,
      verify: ["ls feature-*.txt"],
      env: { FAKE_MODE: "parallel", FAKE_ASSIGNEES: "impl1,impl2", FAKE_WORK_MS: "400", FAKE_TIMELINE: timeline }
    });

    expect(state.status).toBe("done");
    const runs = intervals(timeline);
    expect(runs.length).toBe(2);
    expect(peakConcurrency(runs)).toBe(1); // never two at once
  }, 90000);

  it("maxParallel 2 with THREE SMEs is BOUNDED at 2 — it fans out, but never past the cap", async () => {
    const timeline = timelinePath("bound");
    const { state } = await runOnce({
      execute: true,
      implementers: 3,
      maxParallel: 2,
      verify: ["ls feature-*.txt"],
      env: { FAKE_MODE: "parallel", FAKE_ASSIGNEES: "impl1,impl2,impl3", FAKE_WORK_MS: "600", FAKE_TIMELINE: timeline }
    });

    expect(state.status).toBe("done");
    const runs = intervals(timeline);
    expect(runs.length).toBe(3);
    const peak = peakConcurrency(runs);
    expect(peak).toBeGreaterThanOrEqual(2); // it really does fan out…
    expect(peak).toBeLessThanOrEqual(2); // …and never exceeds the cap the operator set.
  }, 120000);

  it("a dispatch that THROWS blocks only ITS task — the concurrent sibling still delivers", async () => {
    // `impl2` runs on a misconfigured provider, so building its command THROWS inside the dispatch.
    // The throw must become a terminal, repairable `blocked` for t2 alone: the task must never be
    // stranded mid-flight (a `claimed` task is invisible to both selectors and can never finish), and
    // it must not take its concurrently-dispatched sibling t1 down with it.
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      implementers: 2,
      maxParallel: 2,
      maxRepairs: 1,
      verify: ["ls feature-*.txt"],
      breakRole: "impl2",
      env: { FAKE_MODE: "parallel", FAKE_ASSIGNEES: "impl1,impl2", FAKE_WORK_MS: "50" }
    });

    const board = foldBoard(join(repoDir, ".loop/runs/e2e", runId, "board"));
    const byRole = (role: string) => board.find((t) => t.assignee === role)!;

    // The sibling completed and merged despite the failure next to it.
    expect(byRole("impl1").status).toBe("done");
    expect(gitLog(repoDir, `loop/e2e/${runId}/integration`).some((s) => s.startsWith("loop: integrate"))).toBe(true);

    // The failing task is TERMINAL and OWNED — escalated to a human after its repairs, never left
    // `claimed`, and never silently dropped.
    const failed = byRole("impl2");
    expect(failed.status).toBe("escalated");
    expect(board.some((t) => t.status === "claimed")).toBe(false);

    // The failure was surfaced, with the reason, not swallowed.
    const log = readFileSync(join(repoDir, ".loop/runs/e2e", runId, ".loop_log.jsonl"), "utf8");
    expect(log).toContain("dispatch_error");

    // A run with an escalated task is NOT a success.
    expect(state.status).not.toBe("done");
    // …and the half-built attempt left no worktree behind for the failed task.
    expect(existsSync(join(repoDir, "feature-t2.txt"))).toBe(false);
  }, 120000);
});
