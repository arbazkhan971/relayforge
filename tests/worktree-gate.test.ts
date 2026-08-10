import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCleanWorktree, prepareExecutionTarget } from "../src/worktree.js";
import { registerOwnedTemp } from "./global-teardown.js";

/**
 * The HUMAN GATE: `--execute` requires a git repo with a CLEAN working tree, and refuses otherwise
 * with an actionable message. This is the product's central safety promise — "we never touch your
 * checkout" — and only its non-git half was ever tested. A regression that reordered the clean check
 * after the worktree was created would ship green.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
}

function committedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-gate-"));
  registerOwnedTemp(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "baseline"]);
  return dir;
}

describe("the --execute human gate", () => {
  it("refuses a non-git directory with an actionable message", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-gate-nogit-"));
    registerOwnedTemp(dir);
    expect(() => prepareExecutionTarget(dir, "demo", "r1")).toThrow(/requires a git repository/i);
  });

  it("refuses a DIRTY working tree — and names the fix (commit or stash)", () => {
    const dir = committedRepo();
    writeFileSync(join(dir, "README.md"), "# uncommitted edit\n"); // dirty the tree

    expect(isCleanWorktree(dir)).toBe(false);
    expect(() => prepareExecutionTarget(dir, "demo", "r1")).toThrow(/clean git working tree/i);
    // The message must tell the user what to do AND reaffirm the safety promise.
    expect(() => prepareExecutionTarget(dir, "demo", "r1")).toThrow(/commit or stash/i);
  });

  it("refuses an UNTRACKED file too (a clean tree means clean, not just no tracked changes)", () => {
    const dir = committedRepo();
    writeFileSync(join(dir, "scratch.txt"), "new file\n");
    expect(isCleanWorktree(dir)).toBe(false);
    expect(() => prepareExecutionTarget(dir, "demo", "r1")).toThrow(/clean git working tree/i);
  });

  it("accepts a clean repo and creates the isolated integration worktree on a run branch", () => {
    const dir = committedRepo();
    const target = prepareExecutionTarget(dir, "demo", "r1");
    expect(target.integration.branch).toBe("loop/demo/r1/integration");
    expect(target.integration.isolated).toBe(true);
    // The user's checkout is not the integration path, and the base branch is untouched.
    expect(target.integration.path).not.toBe(dir);
    expect(target.baseBranch).not.toContain("loop/");
  });

  it("refuses when the integration branch IS the checked-out branch (never runs in place)", () => {
    const dir = committedRepo();
    git(dir, ["checkout", "-q", "-b", "loop/demo/r1/integration"]);
    expect(() => prepareExecutionTarget(dir, "demo", "r1")).toThrow(/is the checked-out branch/i);
  });
});
