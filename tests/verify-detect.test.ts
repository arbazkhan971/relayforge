import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { detectVerifyCommands, prepareRun } from "../src/orchestrator.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { gitLog, runOnce } from "./e2e-harness.js";
import { registerOwnedTemp } from "./global-teardown.js";

setTrustedRunner(true);

/**
 * The AUTO-DETECTED verifier: when a loop configures no `verify:` list, the gate is derived from the
 * project itself — its real TEST command, then its real BUILD command, in that order.
 *
 * This is the fallback that decides whether an unconfigured project gets a real gate or none at all,
 * and it had no test: `detectVerifyCommands` was never called from the suite (every harness config
 * pinned an explicit `verify:`), so a regression that returned `[]` — silently downgrading every
 * unconfigured run to `unverified` — or that ran BUILD before TEST, would have shipped green.
 */

/** A disposable repo + config whose loop has NO `verify:` list, so detection is what decides. */
function ctxFor(files: Record<string, string>, verify: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "loop-detect-"));
  registerOwnedTemp(dir);
  execSync("git init -q && git config user.email t@t.t && git config user.name t", { cwd: dir });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  writeFileSync(
    join(dir, "loop.config.yaml"),
    `version: 1
projects:
  - name: detect
    workingDir: .
    providers: { agent: { type: custom, command: node } }
    roles:
      - { name: planner, title: Planner, provider: agent }
      - { name: implementer, title: Implementer, provider: agent }
      - { name: reviewer, title: Reviewer, provider: agent }
    loops:
      - name: delivery
        orchestrator: planner
        reviewer: reviewer
        verify: [${verify.map((v) => JSON.stringify(v)).join(", ")}]
`
  );
  execSync("git add -A && git commit -qm baseline", { cwd: dir });
  const loaded = loadConfig(join(dir, "loop.config.yaml"));
  return prepareRun(loaded, loaded.config.projects[0], "r1", "goal");
}

describe("auto-detected verifier (test, then build)", () => {
  it("derives the project's REAL test then build command, in that order", () => {
    const ctx = ctxFor({
      "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } })
    });
    // Order is the contract, not just membership: a build that runs BEFORE the tests can go green on
    // code the tests reject.
    expect(detectVerifyCommands(ctx)).toEqual(["npm run test", "npm run build"]);
  });

  it("a project with only a test script yields only the test command", () => {
    const ctx = ctxFor({ "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: "vitest run" } }) });
    expect(detectVerifyCommands(ctx)).toEqual(["npm run test"]);
  });

  it("detects a non-JS ecosystem's test-then-build too (Go)", () => {
    const ctx = ctxFor({ "go.mod": "module example.com/app\n\ngo 1.22\n" });
    expect(detectVerifyCommands(ctx)).toEqual(["go test ./...", "go build ./..."]);
  });

  it("a project with NO detectable commands yields NO verifier (which is what makes a run `unverified`)", () => {
    // This is the honest outcome, not a bug: nothing was found that could prove the work. The run
    // must then end `unverified` rather than inventing a gate or calling itself `done`.
    const ctx = ctxFor({ "README.md": "# nothing to detect\n" });
    expect(detectVerifyCommands(ctx)).toEqual([]);
  });

  it("an explicit `verify:` list WINS — detection never overrides what the operator configured", () => {
    const ctx = ctxFor(
      { "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: "vitest run", build: "tsc" } }) },
      ["make check"]
    );
    expect(detectVerifyCommands(ctx)).toEqual(["make check"]);
  });
});

describe("the auto-detected verifier really gates the run", () => {
  it("with no `verify:` configured, the project's own npm test/build gate the run to `done`", async () => {
    // No `verify:` anywhere — the gate can only come from detection. Reaching `done` therefore proves
    // the detected commands actually ran as the deterministic gate (with no verifier at all, this same
    // run would end `unverified`, as tests/e2e.test.ts proves).
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      verify: [],
      packageJson: { name: "app", version: "1.0.0", scripts: { test: "test -f feature.txt", build: "true" } },
      env: { FAKE_MODE: "accept" }
    });

    expect(state.status).toBe("done");
    expect(gitLog(repoDir, `loop/e2e/${runId}/integration`).some((s) => s.startsWith("loop: integrate"))).toBe(true);
  }, 90000);

  it("a RED auto-detected BUILD fails the run — the second command in the chain is a real gate", async () => {
    // The detected TEST passes and the detected BUILD fails. If only the first command were ever run
    // (or if the chain stopped mattering after the tests), this run would sail through to `done`.
    const { repoDir, runId, state } = await runOnce({
      execute: true,
      verify: [],
      maxRepairs: 1,
      packageJson: { name: "app", version: "1.0.0", scripts: { test: "test -f feature.txt", build: "false" } },
      env: { FAKE_MODE: "accept" }
    });

    expect(state.status).not.toBe("done");
    // Nothing that fails the build reaches the run branch.
    expect(gitLog(repoDir, `loop/e2e/${runId}/integration`).some((s) => s.startsWith("loop: integrate"))).toBe(false);
  }, 90000);
});
