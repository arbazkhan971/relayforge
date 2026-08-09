import { detectScopeCapability } from "../src/scope.js";

// The gated suites below manufacture REAL settlement evidence, which pre-creates process
// scopes (delegated cgroup subtrees). Inside the verifier jail /sys/fs/cgroup is read-only,
// so the environment cannot provide a scope at all — the same honest skip containment.test.ts
// uses. On a delegated host nothing is skipped. P0 debt: delegate the verifier's own scope
// subtree into the jail, then remove these guards.
const SCOPE_CAPABILITY = detectScopeCapability();

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldBoard } from "../src/board.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { gitLog, gitStatusPorcelain, headSubject, runOnce, setupRepo } from "./e2e-harness.js";
import { registerOwnedTemp } from "./global-teardown.js";

setTrustedRunner(true);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
// Import the TS loader into the child itself instead of starting the `tsx` CLI wrapper, which
// creates another process. Crash tests must wait for (and signal) the process that actually owns
// the SQLite/run leases; waiting for a wrapper can race the real owner's final SIGKILL teardown.
const TSX_LOADER = resolve(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");
const CRASH_RUN = resolve(HERE, "fixtures/crash-run.ts");

/**
 * STRONG RESTART / RESUME: a run whose process is KILLED mid-attempt must be finishable by simply
 * running it again — without replanning, without forgetting spend, and without stranding the attempt
 * that was in flight when the lights went out.
 *
 * The defect this pins: a dispatch emits `claimed` before launching the agent and a terminal event
 * after it. Kill the process in between and the board keeps that task at `claimed` FOREVER — and
 * `claimed` is in neither selector (`openTasksFor` wants `open`, `retryableTasksFor` wants
 * `blocked`/`rejected`). The resumed run therefore saw no dispatchable work for it, `allAccepted`
 * could never become true, and the goal was permanently unfinishable with nothing on the board to
 * say why. An in-process throw was already handled — but a dead process cannot handle anything, so
 * the reclaim has to happen on the way back IN.
 */

/** Wait until `predicate()` holds, or throw. Polls — the child is a real process, not a mock. */
async function until(predicate: () => boolean, what: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function countPlannerTurns(capturePath: string): number {
  if (!existsSync(capturePath)) return 0;
  return readFileSync(capturePath, "utf8").split("\n").filter((l) => l.startsWith("=== planner")).length;
}

/** Effective spend of a run, read through its own durable ledger generation (nonce-authenticated). */
async function spendOf(repoDir: string, runId: string): Promise<number> {
  const { openLedger } = await import("../src/ledger.js");
  const runDir = join(repoDir, ".loop/runs/e2e", runId);
  const runNonce = readFileSync(join(runDir, ".loop_run_nonce"), "utf8").trim();
  return openLedger({ dir: join(runDir, "board"), runNonce }).effectiveSpend();
}

describe.skipIf(!SCOPE_CAPABILITY.strong)("restart/resume after a hard crash", () => {
  it("a run KILLED mid-attempt resumes: no replan, the abandoned attempt is reclaimed, and it finishes", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "loop-resume-"));
    registerOwnedTemp(scratch);
    const onceFile = join(scratch, "hanging"); // the fake creates this, then hangs, on attempt #1 only
    const capture = join(scratch, "capture"); // every provider turn appends here (planner included)

    // No budget here: a positive budgetUsd with a provider that reports no cost fails closed before
    // dispatch (allowUnknownCostCalls defaults to 0) — correct, but it would stop this run before it
    // ever reached the attempt we need to crash. Spend continuity is proven in the next test instead.
    const runId = "run-resume";
    const { repoDir } = setupRepo({
      env: { FAKE_MODE: "hang-once", FAKE_ONCE_FILE: onceFile, LOOP_CAPTURE: capture },
      maxRepairs: 2
    });
    const baseHead = headSubject(repoDir);

    // ---- 1. Start a REAL run in a child process and hard-kill it mid-attempt. -------------------
    const child = spawn(process.execPath, ["--import", TSX_LOADER, CRASH_RUN, repoDir, runId], {
      cwd: repoDir,
      detached: true, // its own process group, so we can kill the agent it spawned along with it
      stdio: "ignore",
      env: { ...process.env, LOOP_TMUX: "off" }
    });

    // The fake implementer signals it is mid-attempt (and then hangs forever).
    await until(() => existsSync(onceFile), "the first attempt to start");
    process.kill(-child.pid!, "SIGKILL"); // SIGKILL the whole group: no unwinding, no cleanup, no lease release
    await new Promise((r) => child.on("exit", r));

    // ---- 2. Crash evidence: the board is frozen mid-attempt. ------------------------------------
    const boardDir = join(repoDir, ".loop/runs/e2e", runId, "board");
    const runDir = join(repoDir, ".loop/runs/e2e", runId);
    const crashed = foldBoard(boardDir);
    expect(crashed.length).toBeGreaterThanOrEqual(1);
    expect(crashed.some((t) => t.status === "claimed")).toBe(true); // ← exactly the state that used to strand
    const crashedIds = crashed.map((t) => t.id).sort();
    const nonceBefore = readFileSync(join(runDir, ".loop_run_nonce"), "utf8").trim();
    const plannerTurnsBefore = countPlannerTurns(capture);
    expect(plannerTurnsBefore).toBe(1); // the planner ran exactly once, in the crashed run

    // ---- 3. Resume: same repo, same run id, no special flags. -----------------------------------
    // (This also proves the stale LEASE held by the dead pid is reclaimable — otherwise the resumed
    // run would refuse to start at all.)
    const { state } = await runOnce({ execute: true, repoDir, runId });

    // ---- 4. It finished the job. ----------------------------------------------------------------
    expect(state.status).toBe("done");
    expect(gitLog(repoDir, `loop/e2e/${runId}/integration`).some((s) => s.startsWith("loop: integrate"))).toBe(true);

    // ---- 5. …by RESUMING, not by starting over. -------------------------------------------------
    const after = foldBoard(boardDir);
    expect(after.map((t) => t.id).sort()).toEqual(crashedIds); // same tasks, no new plan
    expect(countPlannerTurns(capture)).toBe(1); // the planner NEVER ran again
    expect(readFileSync(join(runDir, ".loop_run_nonce"), "utf8").trim()).toBe(nonceBefore); // same run identity

    // The abandoned attempt was reclaimed (and charged as an attempt — a crash may have cost money,
    // and a crash that repeats must escalate rather than relaunch forever).
    const log = readFileSync(join(runDir, ".loop_log.jsonl"), "utf8");
    expect(log).toContain("attempt_reclaimed");
    expect(after.some((t) => t.status === "claimed")).toBe(false);
    expect(after.every((t) => t.status === "done")).toBe(true);
    // The crashed attempt was CHARGED as an attempt (only failures increment the counter): the agent
    // may have burned real spend before dying, so a crash consumes a repair and a repeating crash
    // escalates to a human instead of relaunching forever.
    expect(after[0].attempts).toBe(1);

    // ---- 6. The human's checkout is untouched by all of this. -----------------------------------
    expect(gitStatusPorcelain(repoDir)).toBe("");
    expect(headSubject(repoDir)).toBe(baseHead);
  }, 180000);

  it("the resumed run KILLS the agent the crash orphaned (it does not leave a ghost typing)", async () => {
    // Killing the orchestrator does NOT kill its agents: each provider runs detached, in its own
    // cgroup, so it is orphaned to init and keeps running — still calling the model, still spending,
    // still writing into the attempt worktree the resumed run is about to reclaim. Reclaiming the
    // board without reaping that ghost would put two agents on one task.
    const scratch = mkdtempSync(join(tmpdir(), "loop-resume-orphan-"));
    registerOwnedTemp(scratch);
    const onceFile = join(scratch, "hanging");

    const runId = "run-orphan";
    const { repoDir } = setupRepo({ env: { FAKE_MODE: "hang-once", FAKE_ONCE_FILE: onceFile }, maxRepairs: 2 });
    const runDir = join(repoDir, ".loop/runs/e2e", runId);

    const child = spawn(process.execPath, ["--import", TSX_LOADER, CRASH_RUN, repoDir, runId], {
      cwd: repoDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LOOP_TMUX: "off" }
    });
    await until(() => existsSync(onceFile), "the first attempt to start");
    process.kill(-child.pid!, "SIGKILL");
    await new Promise((r) => child.on("exit", r));

    // The run durably recorded the scopes it launched into — that record is the ONLY thing that still
    // knows where the orphan is, now that the process holding it in memory is gone.
    const scopeIds = readFileSync(join(runDir, ".loop_scopes"), "utf8").split("\n").filter(Boolean);
    expect(scopeIds.length).toBeGreaterThanOrEqual(1);
    const leaderPids = scopeIds.map((id) => Number(id.split(":").pop()));

    // The hung agent really did SURVIVE the kill of the orchestrator's process group (this is the
    // whole premise — if it died on its own there would be nothing to reap).
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => leaderPids.some(alive), "an orphaned agent to still be running");

    // Resume. The orphan must be dead before its task is re-dispatched.
    const { state } = await runOnce({ execute: true, repoDir, runId });
    expect(state.status).toBe("done");

    for (const pid of leaderPids) {
      expect(alive(pid), `agent ${pid} was orphaned by the crash and is STILL running`).toBe(false);
    }
    const log = readFileSync(join(runDir, ".loop_log.jsonl"), "utf8");
    expect(log).toContain("orphan_scope_reaped");
  }, 180000);

  it("the resumed run does not FORGET the crashed attempt's spend", async () => {
    // The crashed call reserved budget and never settled — nobody was alive to settle it. A ledger
    // that "recovered" by forgetting it would let a crash-loop spend the same budget over and over.
    // The resumed board must still account for it, conservatively, at the reservation's WORST CASE
    // ($1.00 = maxCostPerCallUsd), because nothing can prove what the dead call actually cost.
    //
    // The fake reviewer reports no cost, so every run retains one uncertain reviewer reservation.
    // To prove the CRASHED call specifically is remembered — and not just point at a number that a
    // reviewer retention would produce anyway — we measure a clean CONTROL run with identical config
    // and require the crashed run to carry a full extra worst case on top of it.
    const budget = { maxRepairs: 2, budgetUsd: 5, maxCostPerCallUsd: 1, allowUnknownCostCalls: 3 } as const;

    const control = await runOnce({ execute: true, runId: "run-control", env: { FAKE_MODE: "accept", FAKE_COST: "0.01" }, ...budget });
    expect(control.state.status).toBe("done");
    const controlSpend = await spendOf(control.repoDir, "run-control");

    const scratch = mkdtempSync(join(tmpdir(), "loop-resume-spend-"));
    registerOwnedTemp(scratch);
    const onceFile = join(scratch, "hanging");

    const runId = "run-spend";
    const { repoDir } = setupRepo({ env: { FAKE_MODE: "hang-once", FAKE_ONCE_FILE: onceFile, FAKE_COST: "0.01" }, ...budget });

    const child = spawn(process.execPath, ["--import", TSX_LOADER, CRASH_RUN, repoDir, runId], {
      cwd: repoDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LOOP_TMUX: "off" }
    });
    await until(() => existsSync(onceFile), "the first attempt to start");
    process.kill(-child.pid!, "SIGKILL");
    await new Promise((r) => child.on("exit", r));

    const { state } = await runOnce({ execute: true, repoDir, runId });
    expect(state.status).toBe("done");
    const resumedSpend = await spendOf(repoDir, runId);

    // The killed call's worst case ($1.00) is still on the books, on top of everything the control
    // run also paid for. It is never rounded down to the $0.01 the *surviving* calls reported, and
    // never to zero: the board never opens having forgotten spend.
    expect(resumedSpend).toBeGreaterThanOrEqual(controlSpend + 0.9);
    expect(resumedSpend).toBeLessThanOrEqual(5); // …and it still never exceeds the budget.
  }, 240000);
});
