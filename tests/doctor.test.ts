import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { RootConfigSchema } from "../src/config/schema.js";
import { runDoctor } from "../src/doctor.js";
import { starterConfig } from "../src/starter.js";
import { registerOwnedTemp } from "./global-teardown.js";

/**
 * `loop doctor` is the product's entire diagnostic surface, and its ONE job is to be ACTIONABLE:
 * every problem it reports must come with the fix. It had no real coverage — a single assertion that
 * the `node` check said "ok" — so deleting every `fix:` string, or the `process.exitCode = 1` on a
 * failed report, broke nothing in the suite.
 *
 * These tests pin the contract, not the host: which checks EXIST, that a failure always carries a
 * fix, and that `ok` is false iff some check failed. They never assert that this particular machine
 * has a sandbox — that is a property of the host, and asserting it would make the suite lie on the
 * next box.
 */

function repo(dirty: boolean, config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-doctor-"));
  registerOwnedTemp(dir);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  if (config) writeFileSync(join(dir, "loop.config.yaml"), config);
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
  if (dirty) writeFileSync(join(dir, "README.md"), "# dirty\n");
  return dir;
}

function loadedFrom(dir: string, yaml: string) {
  return { config: RootConfigSchema.parse(YAML.parse(yaml)), path: join(dir, "loop.config.yaml"), rootDir: dir };
}

const checkOf = (report: ReturnType<typeof runDoctor>, name: string) => report.checks.find((c) => c.name === name);

describe("loop doctor", () => {
  it("reports every check `loop run --execute` actually depends on", () => {
    const dir = repo(false, starterConfig("claude"));
    const report = runDoctor(loadedFrom(dir, starterConfig("claude")), dir);

    // The two checks that GATE --execute (both fail closed) must be visible to the user. They were
    // absent from the README's own description of doctor for exactly as long as they gated the run.
    for (const name of ["node", "git", "tmux", "git-target", "sandbox", "process-scope", "config", "workingDir", "providers"]) {
      expect(checkOf(report, name), `doctor is missing the "${name}" check`).toBeDefined();
    }
    expect(checkOf(report, "node")?.status).toBe("ok"); // the suite cannot run on < 20
  });

  it("EVERY non-ok check carries an actionable fix (that is the whole point of doctor)", () => {
    // Run against the least healthy environment we can build: not a git repo, no config at all.
    const empty = mkdtempSync(join(tmpdir(), "loop-doctor-empty-"));
    registerOwnedTemp(empty);
    for (const report of [runDoctor(undefined, empty), runDoctor(loadedFrom(repo(true), starterConfig("claude")), repo(true))]) {
      for (const check of report.checks) {
        if (check.status === "ok") continue;
        expect(check.fix, `check "${check.name}" is ${check.status} with no fix`).toBeTruthy();
        expect(check.fix!.length).toBeGreaterThan(20);
      }
    }
  });

  it("a DIRTY working tree is called out (the human gate for --execute)", () => {
    const dir = repo(true, starterConfig("claude"));
    const target = checkOf(runDoctor(loadedFrom(dir, starterConfig("claude")), dir), "git-target");
    expect(target?.status).toBe("warn");
    expect(target?.detail).toMatch(/uncommitted/i);
    expect(target?.fix).toMatch(/commit or stash/i);
  });

  it("a clean repo passes the git-target gate; a non-repo is called out", () => {
    const clean = repo(false, starterConfig("claude"));
    expect(checkOf(runDoctor(loadedFrom(clean, starterConfig("claude")), clean), "git-target")?.status).toBe("ok");

    const notRepo = mkdtempSync(join(tmpdir(), "loop-doctor-nogit-"));
    registerOwnedTemp(notRepo);
    const check = checkOf(runDoctor(undefined, notRepo), "git-target");
    expect(check?.status).toBe("warn");
    expect(check?.fix).toMatch(/git init/i);
  });

  it("no config → warn with `relayforge init`; a config with SEMANTIC errors → fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-doctor-cfg-"));
    registerOwnedTemp(dir);
    const missing = checkOf(runDoctor(undefined, dir), "config");
    expect(missing?.status).toBe("warn"); // "no config yet" is not a broken environment
    expect(missing?.fix).toMatch(/relayforge init/);

    // A reviewer that IS the orchestrator destroys review independence — doctor must fail on it.
    const bad = `version: 1
projects:
  - name: demo
    providers: { dev: { type: codex } }
    roles:
      - { name: dev, title: Dev, provider: dev }
      - { name: other, title: Other, provider: dev }
    loops:
      - { name: build, orchestrator: dev, reviewer: dev }
`;
    const report = runDoctor(loadedFrom(dir, bad), dir);
    const cfg = checkOf(report, "config");
    expect(cfg?.status).toBe("fail");
    expect(cfg?.detail).toMatch(/reviewer must differ/i);
    expect(report.ok).toBe(false); // and a failing check fails the whole report → CLI exits 1
  });

  it("report.ok is false if and only if some check FAILED (a warn never fails the report)", () => {
    const dir = repo(true, starterConfig("claude")); // dirty tree ⇒ at least one `warn`
    const report = runDoctor(loadedFrom(dir, starterConfig("claude")), dir);
    const failed = report.checks.some((c) => c.status === "fail");
    expect(report.ok).toBe(!failed);
    expect(report.checks.some((c) => c.status === "warn")).toBe(true);
  });

  it("the sandbox check fails when it cannot isolate the NETWORK, not just when it is missing", () => {
    // Verifier commands are AI-chosen and must run with no network. A sandbox that launches but
    // cannot remove the network cannot contain a verifier, so doctor must not report it as `ok` —
    // it used to say "ok (no network isolation — filesystem+env only)" while `--execute` happily ran
    // verifiers online.
    const dir = repo(false, starterConfig("claude"));
    const sandbox = checkOf(runDoctor(loadedFrom(dir, starterConfig("claude")), dir), "sandbox");
    expect(sandbox).toBeDefined();
    if (sandbox!.status === "ok") {
      // On a fully capable host, `ok` must mean network isolation is included.
      expect(sandbox!.detail).toMatch(/network isolation/i);
    } else {
      expect(sandbox!.status).toBe("fail"); // never a `warn`: this gates --execute
      expect(sandbox!.fix).toMatch(/FAILS CLOSED/);
    }
  });
});
