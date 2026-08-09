#!/usr/bin/env node
// Disposable-repo smoke test: drive the REAL production `loop` CLI against a throwaway git repo
// with NO test injection and NO sandbox-bypass environment variable, and prove the CLI behaves
// HONESTLY for the containment this host actually has.
//
// The host's containment is not a constant, so neither is the expected outcome. We ask the
// PRODUCT itself (`loop doctor --json`) which boundary it can launch, and then assert the
// STRONGEST guarantee that boundary permits:
//
//   * always — a dry run reaches `planned`, launches no provider, and never touches the checkout;
//   * CONTAINED host (a launchable OS sandbox AND a strong process scope) — a real `--execute`
//     reaches `done`, and the verified work lands on the RUN BRANCH while the original checkout
//     stays byte-for-byte untouched and nothing is auto-merged into it;
//   * UNCONTAINED host (e.g. this nested CI, where bwrap's uid_map write is denied) — a real
//     `--execute` FAILS CLOSED (blocked, non-zero) BEFORE any provider/verifier runs. It can never
//     reach `done` without containment, and it still leaves the checkout untouched.
//
// Hard-coding either outcome would be a lie on the other kind of host: asserting fail-closed on a
// sandboxed dev machine fails a CORRECT product, and asserting `done` here would demand the
// product breach its own safety boundary. Both branches assert the same invariant — the human's
// checkout is never touched — which is the guarantee the smoke exists to defend.
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FAKE = resolve(REPO, "tests/fixtures/fake-provider.mjs");
const CLI = resolve(REPO, "src/cli.ts");
const TSX = resolve(REPO, "node_modules/tsx/dist/cli.mjs");

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}
function assert(cond, msg) {
  if (!cond) {
    console.error(`SMOKE FAIL: ${msg}`);
    process.exit(1);
  }
}
/** Run the CLI without inheriting a non-zero-exit throw; return {code, stdout, stderr}. */
function cli(args, cwd) {
  const r = spawnSync("node", [TSX, CLI, ...args], { cwd, encoding: "utf8", env: process.env });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
/** Parse a `--json` CLI payload. */
function json(res, what) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    assert(false, `${what} did not emit parseable JSON (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
  }
}
/** True if `git <cmd>` succeeds in `cwd` (used for predicate queries like merge-base). */
function gitOk(cmd, cwd) {
  return spawnSync("bash", ["-lc", `git ${cmd}`], { cwd, stdio: "ignore" }).status === 0;
}

const dir = mkdtempSync(join(tmpdir(), "loop-smoke-"));
try {
  // 1. Baseline disposable repo.
  sh("git init -q && git config user.email t@t.t && git config user.name t && git config commit.gpgsign false", dir);
  // The release smoke requests two stable verifier runs, so its own fixture
  // output must be deterministic. Nondeterministic-verifier refusal is covered
  // separately; putting wall-clock and random output here made the strong-path smoke probabilistic.
  writeFileSync(join(dir, "verify.sh"), '#!/usr/bin/env bash\necho "verification: feature present"\ntest -f feature.txt\n');
  writeFileSync(join(dir, "app.test.js"), "// grader\n");
  writeFileSync(join(dir, ".gitignore"), ".loop/\nPROJECT-INTELLIGENCE.md\n");
  writeFileSync(
    join(dir, "loop.config.yaml"),
    `version: 1
projects:
  - name: smoke
    workingDir: .
    safetyMode: workspace-write
    providers:
      agent:
        type: custom
        command: node
        args: [${JSON.stringify(FAKE)}]
        env:
          FAKE_MODE: "accept"
    roles:
      - { name: planner, title: Planner, provider: agent, sme: architect }
      - { name: implementer, title: Implementer, provider: agent, sme: fullstack }
      - { name: reviewer, title: Reviewer, provider: agent, sme: code-reviewer }
    loops:
      - name: delivery
        maxIterations: 4
        pollSeconds: 1
        cadenceMinutes: 5
        orchestrator: planner
        reviewer: reviewer
        verifyStabilityRuns: 2
        verify: ["bash verify.sh"]
        stopWhen: [all tasks done, tests pass]
`
  );
  sh("git add -A && git commit -qm baseline", dir);

  const origBranch = sh("git rev-parse --abbrev-ref HEAD", dir);
  const origHead = sh("git rev-parse HEAD", dir);

  // The invariant BOTH branches must uphold: the human's checkout is byte-for-byte untouched — same
  // branch, same HEAD, clean tree. This is the guarantee the smoke exists to defend.
  const assertCheckoutUntouched = () => {
    assert(sh("git rev-parse --abbrev-ref HEAD", dir) === origBranch, `branch changed (was ${origBranch})`);
    assert(sh("git rev-parse HEAD", dir) === origHead, "HEAD moved on the user's branch");
    const porcelain = sh("git status --porcelain", dir);
    assert(porcelain === "", `working tree not clean:\n${porcelain}`);
  };

  // 2. A DRY RUN reaches `planned` (exit 0) and launches no provider / touches nothing.
  const dry = cli(["run", "Deliver the feature", "--run", "smokedry", "--json"], dir);
  assert(dry.code === 0, `dry-run exit ${dry.code} (expected 0):\n${dry.stderr}`);
  assert(/"status":\s*"planned"/.test(dry.stdout), `dry-run status not planned:\n${dry.stdout}`);
  assert(sh("git status --porcelain", dir) === "", "dry-run mutated the checkout");

  // 3. Ask the PRODUCT which containment this host can actually launch. `--execute` is contained by
  //    two independent boundaries and needs BOTH: an OS sandbox (what a provider may touch) and a
  //    strong process scope (what may OUTLIVE it). Either one missing ⇒ the run must fail closed.
  const report = json(cli(["doctor", "--json"], dir), "doctor --json");
  const checkOf = (name) => report.checks.find((c) => c.name === name);
  const sandbox = checkOf("sandbox");
  const scope = checkOf("process-scope");
  assert(sandbox && scope, `doctor reported no sandbox/process-scope check:\n${JSON.stringify(report.checks, null, 2)}`);
  const contained = sandbox.status === "ok" && scope.status === "ok";

  const exec = cli(["run", "Deliver the feature", "--execute", "--run", "smoke", "--json"], dir);

  if (contained) {
    // 4a. CONTAINED host: the run must actually DELIVER — every task accepted and the final
    //     verifier green (`done`, exit 0) — with the work on the run branch, not in the checkout.
    const out = json(exec, "run --execute --json");
    assert(exec.code === 0, `--execute exit ${exec.code} on a contained host (expected 0):\n${exec.stdout}\n${exec.stderr}`);
    assert(out.status === "done", `--execute status ${JSON.stringify(out.status)} (expected "done"):\n${exec.stdout}`);
    assert(out.success === true, `--execute reported success=${out.success}`);
    const branch = out.runBranch;
    assert(typeof branch === "string" && branch.startsWith("loop/"), `no run branch reported: ${JSON.stringify(branch)}`);

    // The verified work exists ON THE RUN BRANCH...
    assert(gitOk(`rev-parse --verify ${branch}`, dir), `run branch ${branch} does not exist`);
    assert(sh(`git show ${branch}:feature.txt`, dir).length > 0, `run branch ${branch} does not carry the delivered feature.txt`);
    // ...and was NOT auto-merged into the human's branch: it must not be an ancestor of HEAD.
    assert(!gitOk(`merge-base --is-ancestor ${branch} HEAD`, dir), `run branch ${branch} was auto-merged into ${origBranch}`);

    assertCheckoutUntouched();
    assert(!existsSync(join(dir, "feature.txt")), "the delivered file leaked into the human's checkout");

    console.log("\nSMOKE PASS (contained host — verified delivery on the run branch):");
    console.log(`  containment:      sandbox=${sandbox.detail} · scope ok`);
    console.log(`  dry-run status:   planned (exit 0)`);
    console.log(`  --execute status: done (exit 0) — every task accepted, final verifier green`);
    console.log(`  run branch:       ${branch} carries feature.txt, NOT merged into ${origBranch}`);
    console.log(`  original checkout unchanged  (branch ${origBranch} @ ${origHead.slice(0, 10)})`);
  } else {
    // 4b. UNCONTAINED host: `--execute` must FAIL CLOSED before any provider/verifier runs. It exits
    //     non-zero, reports blocked/fail-closed, is NEVER `done`, and creates no run branch at all.
    const why = [sandbox.status !== "ok" ? "no OS sandbox" : null, scope.status !== "ok" ? "no strong process scope" : null].filter(Boolean).join(" + ");
    assert(exec.code !== 0, `--execute unexpectedly exited 0 (must fail closed: ${why}):\n${exec.stdout}`);
    assert(!/"status":\s*"done"/.test(exec.stdout), `--execute reached "done" without containment:\n${exec.stdout}`);
    assert(/"status":\s*"blocked"/.test(exec.stdout), `--execute status not blocked:\n${exec.stdout}`);
    assert(/fail-closed|sandbox|scope/i.test(exec.stdout), `--execute reason not fail-closed:\n${exec.stdout}`);

    assertCheckoutUntouched();
    const branches = sh("git branch --list 'loop/*'", dir);
    assert(branches === "", `a run branch was created despite fail-closed:\n${branches}`);
    assert(!existsSync(join(dir, "feature.txt")), "feature.txt was written despite fail-closed");

    console.log(`\nSMOKE PASS (honest fail-closed on a host without containment: ${why}):`);
    console.log(`  original checkout unchanged  (branch ${origBranch} @ ${origHead.slice(0, 10)})`);
    console.log(`  dry-run status:   planned (exit 0)`);
    console.log(`  --execute status: blocked, fail-closed, exit ${exec.code} — never "done"`);
    console.log(`  (the verified-delivery branch of this smoke runs on a host with a launchable sandbox)`);
  }
} finally {
  try {
    execSync("git worktree prune", { cwd: dir, stdio: "ignore" });
  } catch {}
  // Leave no tmux viewport sessions behind (the loop may open loop-smoke-* sessions).
  try {
    const listed = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
    if (listed.status === 0) {
      for (const name of (listed.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (name.startsWith("loop-smoke-")) spawnSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
      }
    }
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}
