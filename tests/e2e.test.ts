import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { runSucceeded } from "../src/cli/support.js";
import { normalizeVerifyOutput, prepareRun, runAutonomyLoop, runOrderedVerify, writeRolePrompts } from "../src/orchestrator.js";
import { tmpdir } from "node:os";
import { requestCancel } from "../src/runtime.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { currentBranchName, gitLog, gitStatusPorcelain, headSubject, runOnce, setupRepo } from "./e2e-harness.js";
import { registerOwnedTemp } from "./global-teardown.js";

// The e2e provider/verifier commands are TRUSTED disposable fixtures (not adversarial), and this
// nested CI cannot launch bwrap (user-namespace uid_map is denied). Inject the in-process trusted
// runner — an IMPORTED symbol, never an environment variable — so the happy-path behavior is
// exercised. Production has no way to call this: the strict fail-closed default is proven in
// sandbox.test.ts and by the honest fail-closed smoke test.
setTrustedRunner(true);

function integrationBranch(runId: string, project = "e2e"): string {
  return `loop/${project}/${runId}/integration`;
}

/** A UNIQUE capture path under the suite's private TMPDIR root — never a fixed
 *  `node_modules/.loop-e2e-capture-*` path that two concurrent suites sharing this cwd would collide
 *  on (the wave-8b2 concurrent-suite failure). Cleaned via direct fs calls, never a shell `rm -f`. */
function uniqueCapture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `loop-e2e-cap-${name}-`));
  registerOwnedTemp(dir); // …and REGISTER it, or every run of this suite leaves the dir behind forever
  return join(dir, "capture");
}

function showFile(repoDir: string, ref: string, file: string): string | undefined {
  try {
    return execSync(`git show ${ref}:${file}`, { cwd: repoDir, encoding: "utf8" });
  } catch {
    return undefined;
  }
}

/** Effective spend of a COMPLETED run, read through its own durable ledger generation. There is no
 *  pathname authority any more: a reader must present the run's immutable nonce, and the ledger proves
 *  the leaf it opens is the exact inode that generation published to. */
async function spendOf(repoDir: string, runId: string): Promise<number> {
  const { openLedger } = await import("../src/ledger.js");
  const runDir = join(repoDir, ".loop/runs/e2e", runId);
  const runNonce = readFileSync(join(runDir, ".loop_run_nonce"), "utf8").trim();
  return openLedger({ dir: join(runDir, "board"), runNonce }).effectiveSpend();
}

describe("end-to-end (fake provider)", () => {
  it("dry-run launches no provider and never touches the checkout", async () => {
    const capture = uniqueCapture("dryrun");
    const { repoDir } = setupRepo({ env: { FAKE_MODE: "accept", LOOP_CAPTURE: capture } });
    const before = headSubject(repoDir);
    const { state } = await runOnce({ execute: false, repoDir });

    // No provider process ever ran: the fake writes the capture file only when invoked.
    expect(existsSync(capture)).toBe(false);
    // No run branch, no edits, checkout untouched.
    expect(gitLog(repoDir, "--all").some((s) => s.startsWith("loop: integrate"))).toBe(false);
    expect(existsSync(join(repoDir, "feature.txt"))).toBe(false);
    expect(gitStatusPorcelain(repoDir)).toBe("");
    expect(headSubject(repoDir)).toBe(before);
    // A successful dry-run is `planned` — NEVER `done` (which requires a real verified execute).
    expect(state.status).toBe("planned");
  }, 30000);

  it("executes a task: commits the edit to the run branch, leaving the checkout unchanged", async () => {
    const { repoDir, runId, state } = await runOnce({ execute: true, env: { FAKE_MODE: "accept" } });

    expect(state.status).toBe("done");
    expect(state.runBranch).toBe(integrationBranch(runId));
    // Accepted work landed on the run branch...
    expect(showFile(repoDir, integrationBranch(runId), "feature.txt")).toBe("ok\n");
    expect(gitLog(repoDir, integrationBranch(runId)).some((s) => s.startsWith("loop: integrate"))).toBe(true);
    // ...and the human's checkout is completely untouched.
    expect(gitStatusPorcelain(repoDir)).toBe("");
    expect(headSubject(repoDir)).toBe("baseline");
    expect(existsSync(join(repoDir, "feature.txt"))).toBe(false);
    // The current branch was never switched away from the base branch.
    expect(currentBranchName(repoDir)).not.toContain("loop/");
  }, 60000);

  it("reject → repair → accept: a first bad attempt is rejected, then a repair is accepted", async () => {
    const { repoDir, runId, state } = await runOnce({ execute: true, env: { FAKE_MODE: "reject-repair" } });

    expect(state.rejected).toBeGreaterThanOrEqual(1);
    expect(state.accepted).toBeGreaterThanOrEqual(1);
    expect(state.status).toBe("done");
    expect(showFile(repoDir, integrationBranch(runId), "feature.txt")).toBe("fixed and clean\n");
  }, 60000);

  it("changing verifier timing text is not treated as flaky", async () => {
    // verify.sh prints a different token/elapsed/clock every run; the run must still succeed.
    const { state } = await runOnce({ execute: true, env: { FAKE_MODE: "accept" } });
    expect(state.status).toBe("done");
    expect(state.lastStopReason).not.toMatch(/unstable/i);
  }, 60000);

  it("rejected/escalated work can NEVER produce a successful run", async () => {
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      maxRepairs: 1,
      env: { FAKE_MODE: "accept", FAKE_ALWAYS_REJECT: "1" }
    });
    expect(state.status).not.toBe("done");
    expect(state.escalations).toBeGreaterThanOrEqual(1);
    // Nothing was merged to the run branch.
    expect(gitLog(repoDir, integrationBranch(runId)).some((s) => s.startsWith("loop: integrate"))).toBe(false);
    expect(showFile(repoDir, integrationBranch(runId), "feature.txt")).toBeUndefined();
  }, 60000);

  it("malformed reviewer output fails closed (cannot be accepted)", async () => {
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      maxRepairs: 1,
      env: { FAKE_MODE: "accept", FAKE_MALFORMED_REVIEW: "1" }
    });
    expect(state.status).not.toBe("done");
    expect(gitLog(repoDir, integrationBranch(runId)).some((s) => s.startsWith("loop: integrate"))).toBe(false);
  }, 60000);

  // ---------------------------------------------------------------------------------------------
  // `unverified` — the false-success surface that had NO test at all: every task accepted, but the
  // work was never proven green. It must be terminal, MUST NOT be `done`, and must exit non-zero.
  // ---------------------------------------------------------------------------------------------
  it("all tasks accepted but NO verifier configured → `unverified`, never `done`", async () => {
    // `verify: []` and the fixture repo carries no manifest to auto-detect a test/build command from,
    // so nothing ever proves this work. Accepting every task is NOT success.
    const { repoDir, runId, state } = await runOnce({ execute: true, verify: [], env: { FAKE_MODE: "accept" } });

    expect(state.status).toBe("unverified");
    expect(state.status).not.toBe("done");
    expect(state.accepted).toBeGreaterThanOrEqual(1); // the work WAS accepted…
    expect(runSucceeded(state.status)).toBe(false); // …and the run still fails, with a non-zero exit.
    // The accepted work is still delivered to the run branch for a human — it is unproven, not lost.
    expect(showFile(repoDir, integrationBranch(runId), "feature.txt")).toBe("ok\n");
  }, 60000);

  // ---------------------------------------------------------------------------------------------
  // The regression gate (README: "a change that turns a green suite red is reverted"). Both layers
  // were entirely untested; no fixture could even produce a green→red change until FAKE_MODE=regress.
  // ---------------------------------------------------------------------------------------------
  it("a change that turns a GREEN verifier RED is blocked and never reaches the run branch", async () => {
    // The verifier is GREEN at baseline (broken.txt does not exist) and the agent's change creates it.
    // That is a genuine regression — not a red baseline — so the in-attempt gate must block it.
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      maxRepairs: 1,
      verify: ["test ! -f broken.txt"],
      env: { FAKE_MODE: "regress" }
    });

    expect(state.status).not.toBe("done");
    // The regression never became history: the run branch carries no integrate commit at all.
    expect(gitLog(repoDir, integrationBranch(runId)).some((s) => s.startsWith("loop: integrate"))).toBe(false);
    expect(showFile(repoDir, integrationBranch(runId), "broken.txt")).toBeUndefined();
    const log = readFileSync(join(repoDir, ".loop/runs/e2e", runId, ".loop_log.jsonl"), "utf8");
    expect(log).toContain("verify_regression");
  }, 60000);

  it("post-merge verification failure ABANDONS the candidate — the run branch never moves", async () => {
    // This verifier passes in an ATTEMPT worktree (basename `t1-a1`) and fails on the INTEGRATION
    // worktree (basename `integration`) — so the attempt is accepted and merged into a candidate, and
    // only the post-merge check on that candidate goes red. The candidate must be abandoned and the
    // published branch left exactly where it was (the gate is "never published", not "reverted").
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      maxRepairs: 1,
      postMergeVerify: true,
      verify: ['test "$(basename "$PWD")" != integration'],
      env: { FAKE_MODE: "accept" }
    });

    expect(state.status).not.toBe("done");
    const branch = integrationBranch(runId);
    // The branch still points at the untouched baseline: no candidate was ever published.
    expect(gitLog(repoDir, branch).some((s) => s.startsWith("loop: integrate"))).toBe(false);
    expect(gitLog(repoDir, branch)).toEqual(["baseline"]);
    expect(showFile(repoDir, branch, "feature.txt")).toBeUndefined();
    const log = readFileSync(join(repoDir, ".loop/runs/e2e", runId, ".loop_log.jsonl"), "utf8");
    expect(log).toContain("post_merge_verify");
  }, 60000);

  it("grader tampering is rejected (reward-hack guard)", async () => {
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      maxRepairs: 1,
      env: { FAKE_MODE: "tamper" }
    });
    expect(state.status).not.toBe("done");
    // The committed grader on the run branch is unchanged.
    expect(showFile(repoDir, integrationBranch(runId), "app.test.js")).toBe("// grader: do not weaken\n");
  }, 60000);

  it("a non-zero reviewer exit is a rejection even if the verdict body says accept", async () => {
    // The fake reviewer emits {"verdict":"accept"} but exits 1 — the process failing must NOT be
    // an implicit accept (fail closed).
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      maxRepairs: 1,
      env: { FAKE_MODE: "accept", FAKE_REVIEW_EXIT: "1" }
    });
    expect(state.status).not.toBe("done");
    expect(state.accepted).toBe(0);
    // Nothing was merged to the run branch.
    expect(gitLog(repoDir, integrationBranch(runId)).some((s) => s.startsWith("loop: integrate"))).toBe(false);
  }, 60000);

  it("fails CLOSED before the planner when no sandbox is launchable and no trusted runner is injected", async () => {
    // Force "no sandbox available" AND turn off the injected trusted runner: an --execute run must
    // fail closed (blocked) before any provider/verifier launches, so it can never reach `done`.
    const savedSandbox = process.env.LOOP_SANDBOX;
    process.env.LOOP_SANDBOX = "none";
    setTrustedRunner(false);
    try {
      const capture = uniqueCapture("failclosed");
      const { state } = await runOnce({ execute: true, maxRepairs: 0, env: { FAKE_MODE: "accept", LOOP_CAPTURE: capture } });
      expect(state.status).not.toBe("done");
      expect(state.status).toBe("blocked");
      expect(state.lastStopReason ?? "").toMatch(/fail-closed|sandbox/i);
      // The planner never ran: the fake provider writes the capture file only when invoked.
      expect(existsSync(capture)).toBe(false);
    } finally {
      if (savedSandbox === undefined) delete process.env.LOOP_SANDBOX;
      else process.env.LOOP_SANDBOX = savedSandbox;
      setTrustedRunner(true);
    }
  }, 60000);

  it("refuses a positive budget with NO enforceable per-call cap BEFORE planning (fail closed)", async () => {
    // A positive budget with no maxCostPerCallUsd is not a functional budget (reserving the whole
    // budget per call is one-call-only). The run must refuse before the planner ever launches.
    const capture = uniqueCapture("nocap");
    rmSync(capture, { force: true });
    const { state } = await runOnce({ execute: true, budgetUsd: 5, env: { FAKE_MODE: "accept", LOOP_CAPTURE: capture } });
    expect(state.status).toBe("blocked");
    expect(state.lastStopReason ?? "").toMatch(/per-call cap|budget/i);
    // The planner never ran: no provider process wrote the capture file.
    expect(existsSync(capture)).toBe(false);
  }, 60000);

  it("a USEFUL billed multi-call run proceeds under a per-call cap without overshooting the budget", async () => {
    // Budget $5, per-call cap $0.50, each billed call $0.10. A whole-budget-per-call design would
    // have denied the second call; with a real per-call cap the planner + implementer + reviewer
    // all run, the task is accepted, and the ledger never exceeds the budget.
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      budgetUsd: 5,
      maxCostPerCallUsd: 0.5,
      // The reviewer fixture reports no cost (UNKNOWN); allow that bounded so the multi-call
      // completion path is exercised. The billed planner + implementer still prove multi-call
      // billing under a per-call cap.
      allowUnknownCostCalls: 3,
      env: { FAKE_MODE: "accept", FAKE_COST: "0.1" }
    });
    expect(state.status).toBe("done");
    // Multiple physical calls were billed (planner $0.10 + implementer $0.10 = 2 billed calls) —
    // a whole-budget-per-call design would have denied the second call.
    const spend = await spendOf(repoDir, runId);
    expect(spend).toBeGreaterThan(0.1); // more than a single billed call
    expect(spend).toBeLessThanOrEqual(5); // never overshot the budget
    expect(showFile(repoDir, integrationBranch(runId), "feature.txt")).toBe("ok\n");
  }, 60000);

  it("an UNLIMITED run keeps making PAID calls — a paid settle is not a false budget violation", async () => {
    // Regression for the wave-7 live P0: under budgetUsd 0 (unlimited) each call reserved a
    // placeholder worstCase 0; a normal PAID settle ($0.10) then read as actual > reserve and tripped
    // the terminal `budgetViolation` tripwire, stopping an unlimited run after its FIRST paid call.
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      budgetUsd: 0, // unlimited
      env: { FAKE_MODE: "accept", FAKE_COST: "0.1" }
    });
    expect(state.status).toBe("done");
    // Several physical calls were billed and the run completed rather than stopping on a phantom
    // "actual > reserve" violation.
    expect(await spendOf(repoDir, runId)).toBeGreaterThan(0.1); // more than one paid call
    expect(showFile(repoDir, integrationBranch(runId), "feature.txt")).toBe("ok\n");
  }, 60000);

  it("fails CLOSED under a positive budget + cap when provider cost is UNKNOWN", async () => {
    // The fake reports NO cost (FAKE_COST unset) → every turn is UNKNOWN. Even with a valid per-call
    // cap, unknown cost beyond the bounded-call allowance means we can no longer prove we are under
    // budget, so the run must stop rather than spend blindly.
    const { state } = await runOnce({ execute: true, budgetUsd: 5, maxCostPerCallUsd: 0.5, env: { FAKE_MODE: "accept" } });
    expect(state.status).not.toBe("done");
    expect(state.unknownCostCalls).toBeGreaterThan(0);
    expect(state.lastStopReason ?? "").toMatch(/budget/i);
  }, 60000);

  it("delivers role, guardrails, and project context to every provider turn", async () => {
    const capture = uniqueCapture("context");
    rmSync(capture, { force: true });
    await runOnce({ execute: true, env: { FAKE_MODE: "accept", LOOP_CAPTURE: capture } });
    const text = readFileSync(capture, "utf8");
    // Implementer turn carried the role identity + guardrails + acceptance criteria.
    expect(text).toContain("=== implementer");
    expect(text).toContain("Acceptance criteria");
    expect(text.toLowerCase()).toContain("guardrail");
    // Reviewer turn carried the diff to review.
    expect(text).toContain("=== reviewer");
    expect(text).toContain("```diff");
  }, 60000);

  it("delivers PROJECT-INTELLIGENCE to every provider turn (not the 'not found' placeholder)", async () => {
    // The whole "trained on your project" claim rests on this: `loop learn` writes
    // PROJECT-INTELLIGENCE.md and every role's prompt is grounded in it, so agents never invent
    // commands. Nothing proved the text actually REACHED a provider — and it could not, because the
    // harness never wrote the file, so every turn silently shipped the "_No PROJECT-INTELLIGENCE.md
    // found_" placeholder and the assertion would have passed just the same.
    const capture = uniqueCapture("intel");
    rmSync(capture, { force: true });
    const marker = "ACME-STACK-MARKER-7f3a";
    await runOnce({
      execute: true,
      env: { FAKE_MODE: "accept", LOOP_CAPTURE: capture },
      intelligence: `# Project Intelligence\n\nStack: ${marker}\n\n## Commands\n- test: \`${marker}-test\`\n`
    });
    const text = readFileSync(capture, "utf8");

    expect(text).toContain(marker); // the real intelligence text reached the provider…
    expect(text).not.toContain("_No PROJECT-INTELLIGENCE.md found_"); // …and not the placeholder.
    // Every role is grounded in it — implementer AND the independent reviewer.
    const implementerTurn = text.slice(text.indexOf("=== implementer"), text.indexOf("=== reviewer"));
    expect(implementerTurn).toContain(marker);
    expect(text.slice(text.indexOf("=== reviewer"))).toContain(marker);
  }, 60000);

  it("a verdict literal PLANTED in the diff cannot outrank the reviewer's own rejection", async () => {
    // The implementer's diff is quoted verbatim into the reviewer's prompt. The reviewer here does
    // its job perfectly — it QUOTES the accept-shaped literal it found in the source as the very
    // reason it is REJECTING. The old first-match verdict scanner picked the quoted literal (it came
    // first) and merged the change over the reviewer's objection: the implementer, not the reviewer,
    // was deciding acceptance. A quoted verdict is evidence, never authority.
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      maxRepairs: 1,
      env: { FAKE_MODE: "accept", FAKE_REVIEW_QUOTES_DIFF: "1" }
    });

    expect(state.status).not.toBe("done");
    expect(state.accepted).toBe(0);
    expect(gitLog(repoDir, integrationBranch(runId)).some((s) => s.startsWith("loop: integrate"))).toBe(false);
    expect(showFile(repoDir, integrationBranch(runId), "feature.txt")).toBeUndefined();
  }, 60000);

  it("cancellation (parent-owned) terminates a hung run", async () => {
    const { repoDir } = setupRepo({ env: { FAKE_MODE: "hang" } });
    const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
    const project = loaded.config.projects[0];
    const runId = "run-cancel";
    const ctx = prepareRun(loaded, project, runId, "hang forever");
    writeRolePrompts(ctx);
    const timer = setTimeout(() => requestCancel(ctx.runDir, "test cancel"), 2500);
    const reports = await runAutonomyLoop(ctx, {}, { execute: true });
    clearTimeout(timer);
    const state = JSON.parse(readFileSync(ctx.statePath, "utf8"));
    expect(state.status).toBe("cancelled");
    void reports;
  }, 60000);
});

describe("non-success runs preserve recovery evidence (item 11)", () => {
  it("a blocked/escalated run keeps its owned worktree root and patch artifacts (no cleanup)", async () => {
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      maxRepairs: 1,
      runId: "evidence",
      goal: "Deliver z",
      env: { FAKE_MODE: "accept", FAKE_ALWAYS_REJECT: "1" }
    });
    expect(state.status).not.toBe("done");
    // The private per-run owned worktree root is NOT deleted (evidence for reconciliation).
    const { worktreeRoot } = await import("../src/worktree.js");
    expect(existsSync(worktreeRoot(repoDir, "e2e", runId))).toBe(true);
    // The run's durable artifacts/state survive too.
    const runDir = join(repoDir, ".loop/runs/e2e", runId);
    expect(existsSync(join(runDir, ".loop_state.json"))).toBe(true);
    expect(existsSync(join(runDir, "artifacts"))).toBe(true);
  }, 60000);
});

describe("run manifest binds a run id to its immutable identity", () => {
  const manifestPath = (repoDir: string, runId: string) => join(repoDir, ".loop/runs/e2e", runId, ".loop_manifest.json");

  it("rejects reusing a run id with a DIFFERENT goal (never returns the old done)", async () => {
    const { repoDir } = setupRepo({ env: { FAKE_MODE: "accept" } });
    const first = await runOnce({ execute: true, repoDir, runId: "reuseid", goal: "Deliver alpha" });
    expect(first.state.status).toBe("done");
    await expect(runOnce({ execute: true, repoDir, runId: "reuseid", goal: "Deliver beta" })).rejects.toThrow(/DIFFERENT|FRESH run id/);
  }, 60000);

  it("rejects promoting a dry-run id to --execute (dry-run→execute reuse)", async () => {
    const { repoDir } = setupRepo({ env: { FAKE_MODE: "accept" } });
    const dry = await runOnce({ execute: false, repoDir, runId: "promoteid", goal: "Deliver x" });
    expect(dry.state.status).toBe("planned");
    await expect(runOnce({ execute: true, repoDir, runId: "promoteid", goal: "Deliver x" })).rejects.toThrow(/DIFFERENT|mode/);
  }, 60000);

  it("fails closed on a corrupt manifest", async () => {
    const { repoDir } = setupRepo({ env: { FAKE_MODE: "accept" } });
    await runOnce({ execute: true, repoDir, runId: "corruptid", goal: "Deliver y" });
    writeFileSync(manifestPath(repoDir, "corruptid"), "{ not valid json");
    await expect(runOnce({ execute: true, repoDir, runId: "corruptid", goal: "Deliver y" })).rejects.toThrow(/corrupt/i);
  }, 60000);
});

describe("verifier normalization", () => {
  it("folds changing timing text so identical results fingerprint the same", () => {
    const a = normalizeVerifyOutput("verifier finished in 41ms (elapsed 0.9s) at 12:00:01\nPASS");
    const b = normalizeVerifyOutput("verifier finished in 9ms (elapsed 1.2s) at 23:59:59\nPASS");
    expect(a).toBe(b);
  });

  it("coverage % and pass/fail COUNTS still change the fingerprint (not erased as timing)", () => {
    // Timing differs only → identical (flaky-proof).
    expect(normalizeVerifyOutput("done in 5ms")).toBe(normalizeVerifyOutput("done in 900ms"));
    // Coverage percentage differs → MUST differ (a coverage regression must be visible).
    expect(normalizeVerifyOutput("coverage 85%")).not.toBe(normalizeVerifyOutput("coverage 70%"));
    // Pass/fail counts differ → MUST differ.
    expect(normalizeVerifyOutput("12 passed, 0 failed")).not.toBe(normalizeVerifyOutput("11 passed, 1 failed"));
  });
});

describe("ordered verifiers", () => {
  it("runs commands in order and stops the chain at the first failure", () => {
    const both = runOrderedVerify(tmpdir(), ["true", "echo SECOND_RAN"]);
    expect(both.ok).toBe(true);
    expect(both.output).toContain("SECOND_RAN");

    const stop = runOrderedVerify(tmpdir(), ["false", "echo SECOND_RAN"]);
    expect(stop.ok).toBe(false);
    expect(stop.output).not.toContain("SECOND_RAN");
  });
});
