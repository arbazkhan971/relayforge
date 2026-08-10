import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addEvent, addTask, foldBoard } from "../src/board.js";
import { loadConfig } from "../src/config/load.js";
import { finalLoopState, prepareRun, runAutonomyLoop, writeRolePrompts } from "../src/orchestrator.js";
import { setTrustedRunner } from "../src/sandbox.js";
import type { ScopeOs } from "../src/scope.js";
import { gitLog, setupRepo } from "./e2e-harness.js";
import { registerOwnedTemp } from "./global-teardown.js";
import { FakeCgroupFs } from "./fake-cgroup.js";

setTrustedRunner(true);

/**
 * THE ORPHAN GATE, end to end.
 *
 * Killing the orchestrator does NOT kill its agents: each provider runs detached in its own cgroup, so
 * it is orphaned to init and keeps running — still calling the model, still spending, still writing into
 * the attempt worktree the resumed run is about to reclaim. `.loop_scopes` is the only thing that still
 * knows where those ghosts are.
 *
 * The bug these tests pin had two halves, and together they were worse than either:
 *   1. `reapAbandonedScope` returned "killed" even when `rmdir` had failed and the cgroup (with a live,
 *      unkillable task in it) was still standing — it reported an ATTEMPT as a PROOF; and
 *   2. the caller then blanked `.loop_scopes` for EVERY outcome, discharging evidence it had never
 *      collected — destroying the last pointer to the ghost — and let the resume reclaim the board and
 *      re-dispatch the task. Two agents, one task, and nothing left on disk to say so.
 *
 * An unkillable member is not something a test can stage with real processes (that is precisely why the
 * branch shipped wrong), so the gate is driven against an in-memory cgroup tree through `ctx.scopeOs`.
 * The reap itself against real cgroups is proven in tests/resume.test.ts.
 */

const GHOST_NAME = "loop-abcdef01";

type Ghost = { os: FakeCgroupFs; path: string; id: string };

/** A cgroup that a crashed predecessor launched an agent into, still populated. */
function ghostScope(opts: { unkillable?: boolean } = {}): Ghost {
  const os = new FakeCgroupFs();
  const path = `${os.root}/${GHOST_NAME}`;
  os.mkdir(path);
  os.tasks.set(path, 1); // the orphaned agent, still running
  if (opts.unkillable) os.unkillable.add(path); // …and it ignores SIGKILL (uninterruptible sleep)
  return { os, path, id: `cgroup2:${os.inodeOf(path)}:${GHOST_NAME}:4242` };
}

/** A resume of `runId` whose durable scope journal is `journal`, probed against `os`. */
async function resumeWith(opts: { journal: string; os?: ScopeOs; claimed?: boolean }) {
  const captureDir = mkdtempSync(join(tmpdir(), "loop-orphan-cap-"));
  registerOwnedTemp(captureDir); // explicit, unforgeable ownership so the suite teardown reclaims it
  const capture = join(captureDir, "capture");
  const { repoDir } = setupRepo({ env: { FAKE_MODE: "accept", LOOP_CAPTURE: capture } });
  const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
  const ctx = prepareRun(loaded, loaded.config.projects[0], "run-orphan-gate", "Deliver the feature");
  writeRolePrompts(ctx);

  // A predecessor that crashed mid-attempt: the board holds a task it CLAIMED and never finished, and
  // the scope journal records where it launched the agent that is (maybe) still working on it.
  if (opts.claimed) {
    addTask(ctx.boardDir, {
      id: "t1",
      title: "Deliver the feature",
      assignee: "implementer",
      createdBy: "planner",
      description: "Deliver the feature",
      acceptanceCriteria: ["feature.txt exists"],
      dependsOn: [],
      priority: 5,
      createdAt: new Date().toISOString()
    });
    addEvent(ctx.boardDir, { ts: new Date().toISOString(), role: "implementer", taskId: "t1", status: "claimed" });
  }
  writeFileSync(ctx.scopesPath, opts.journal);
  if (opts.os) ctx.scopeOs = opts.os;

  await runAutonomyLoop(ctx, {}, { execute: true });

  const state = finalLoopState(ctx);
  return {
    repoDir,
    ctx,
    state,
    journal: readFileSync(ctx.scopesPath, "utf8"),
    log: readFileSync(ctx.runLog, "utf8"),
    board: foldBoard(ctx.boardDir),
    providerRan: existsSync(capture)
  };
}

describe("the orphan gate: a scope that cannot be PROVEN dead blocks the resume", () => {
  it("an UNKILLABLE ghost blocks the run, stays on the record, and nothing is reclaimed or dispatched", async () => {
    const ghost = ghostScope({ unkillable: true });
    const r = await resumeWith({ journal: `${ghost.id}\n`, os: ghost.os, claimed: true });

    // 1. FAIL CLOSED — never `done`, and the reason names the scope and what to do about it.
    expect(r.state.status).toBe("blocked");
    expect(r.state.lastStopReason ?? "").toContain(ghost.id);
    expect(r.state.lastStopReason ?? "").toMatch(/cannot be proven dead/i);
    expect(r.state.lastStopReason ?? "").toMatch(/cgroup\.procs/); // actionable, not just "blocked"
    expect(r.log).toContain("fail_closed_orphan_scope");
    expect(r.log).toContain("orphan_scope_unresolved");
    expect(r.log).not.toContain("orphan_scope_reaped"); // it was NOT reaped, and never says it was

    // 2. THE EVIDENCE SURVIVES. The journal still names the ghost — it is the only pointer to it.
    expect(r.journal).toContain(ghost.id);

    // 3. NOTHING WAS RECLAIMED OR DISPATCHED. The crashed task is still `claimed` (not re-opened and
    //    handed to a second agent), and no provider process was launched at all — not even the planner.
    expect(r.board.map((t) => t.status)).toEqual(["claimed"]);
    expect(r.log).not.toContain("attempt_reclaimed");
    expect(r.providerRan).toBe(false);

    // 4. THE GHOST'S CGROUP IS UNTOUCHED-BUT-TRIED: we did write cgroup.kill, and it survived.
    expect(ghost.os.kills).toContain(ghost.path);
    expect(ghost.os.dirs.has(ghost.path)).toBe(true);

    // 5. And the human's repo was never even opened for business: no run branch exists.
    expect(gitLog(r.repoDir, "loop/e2e/run-orphan-gate/integration")).toEqual([]);
  }, 60000);

  it("a FOREIGN cgroup (recycled name, different inode) is never killed — it blocks instead", async () => {
    // Someone else's kernel object now wears our old name. Killing it would SIGKILL an unrelated run,
    // and it tells us nothing about the fate of OUR scope. So: do not touch, do not clear, do not run.
    const os = new FakeCgroupFs();
    const path = `${os.root}/${GHOST_NAME}`;
    os.mkdir(path);
    os.tasks.set(path, 1);
    const stranger = `cgroup2:999999:${GHOST_NAME}:4242`; // OUR dead run's inode — not the one on disk

    const r = await resumeWith({ journal: `${stranger}\n`, os, claimed: true });

    expect(r.state.status).toBe("blocked");
    expect(r.state.lastStopReason ?? "").toMatch(/foreign/i);
    expect(os.kills).toEqual([]); // the stranger's agents were NOT killed…
    expect(os.dirs.has(path)).toBe(true); // …and its cgroup is intact.
    expect(r.journal).toContain(stranger); // still owed a proof
    expect(r.providerRan).toBe(false);
    expect(r.board.map((t) => t.status)).toEqual(["claimed"]);
  }, 60000);

  it("a MALFORMED journal line fails closed — it is not silently skipped", async () => {
    // The old reaper did `if (!ref) continue`, then wiped the file anyway. But a line we cannot READ is
    // not a line we can prove is harmless: a truncated record may be the last pointer to a live agent.
    const r = await resumeWith({ journal: "cgroup2:1003:loop-cccc\n", claimed: true });

    expect(r.state.status).toBe("blocked");
    expect(r.state.lastStopReason ?? "").toMatch(/not a readable scope id/i);
    expect(r.journal).toContain("cgroup2:1003:loop-cccc"); // retained, not discarded
    expect(r.providerRan).toBe(false);
    expect(r.board.map((t) => t.status)).toEqual(["claimed"]); // never re-dispatched
  }, 60000);

  it("ONE unproven scope is enough: a successful reap beside it does not open the gate", async () => {
    const ghost = ghostScope({ unkillable: true });
    // A second scope in the same journal that IS reapable.
    const dead = `${ghost.os.root}/loop-beefbeef`;
    ghost.os.mkdir(dead);
    ghost.os.tasks.set(dead, 1);
    const deadId = `cgroup2:${ghost.os.inodeOf(dead)}:loop-beefbeef:4243`;

    const r = await resumeWith({ journal: `${deadId}\n${ghost.id}\n`, os: ghost.os, claimed: true });

    expect(r.state.status).toBe("blocked");
    expect(ghost.os.dirs.has(dead)).toBe(false); // the reapable one WAS killed and removed…
    expect(r.log).toContain("orphan_scope_reaped");
    expect(r.journal).not.toContain(deadId); // …and discharged from the record…
    expect(r.journal).toContain(ghost.id); // …while the unprovable one keeps the gate shut.
    expect(r.providerRan).toBe(false);
  }, 60000);
});

describe("the orphan gate opens only on a PROOF", () => {
  it("a ghost that is reaped (killed AND removed) is discharged, and the resume proceeds to done", async () => {
    const ghost = ghostScope(); // populated, but killable — the ordinary crash case
    const r = await resumeWith({ journal: `${ghost.id}\n`, os: ghost.os, claimed: true });

    // The agent the crash orphaned was killed, and its cgroup removed — removal IS the emptiness proof.
    expect(ghost.os.kills).toContain(ghost.path);
    expect(ghost.os.dirs.has(ghost.path)).toBe(false);
    expect(r.log).toContain("orphan_scope_reaped");

    // Only now may the board be reclaimed and the task re-dispatched — and the run finishes.
    expect(r.log).toContain("attempt_reclaimed");
    expect(r.providerRan).toBe(true);
    expect(r.state.status).toBe("done");
    expect(r.board.every((t) => t.status === "done")).toBe(true);
    expect(gitLog(r.repoDir, "loop/e2e/run-orphan-gate/integration").some((s) => s.startsWith("loop: integrate"))).toBe(true);

    // The discharged line is gone from the journal (only THIS run's own new scopes remain).
    expect(r.journal).not.toContain(ghost.id);
  }, 120000);

});

// NOTE ON COST: exactly ONE test above drives a full loop (real provider + verifier subprocesses), and
// deliberately so. This suite asserts WALL-CLOCK product budgets elsewhere (the streaming pipeline
// digests 6M newlines in <60s), and those budgets measure the product only while the box is not
// oversubscribed — every extra full-loop test in the pool is contention that makes them measure the
// LOAD instead. The `gone` outcome (an absent cgroup is proof enough: rmdir succeeds only on an empty
// cgroup) and the empty-journal case are therefore proven where they cost nothing — in the pure
// `recoverAbandonedScopes` / `reapAbandonedScope` unit tests in tests/scope.test.ts — rather than by
// booting two more disposable repos to re-derive what those already establish.
