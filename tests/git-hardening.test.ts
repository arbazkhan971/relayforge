import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitAll, prepareExecutionTarget } from "../src/worktree.js";
import { providerWritableRoots } from "../src/orchestrator.js";
import { registerOwnedTemp } from "./global-teardown.js";

/**
 * GIT IS A CONFIGURABLE CODE EXECUTOR, and the parent runs it on the HOST — outside the sandbox that
 * contains the agents.
 *
 * The escape these tests lock shut needed no sandbox break at all. Provider turns used to get
 * `~/.gitconfig` (and all of `~/.config`, which holds git's XDG config) as WRITABLE sandbox binds. An
 * agent could therefore write
 *
 *     [core] hooksPath = <a directory inside its own worktree>
 *
 * and simply wait: the parent later runs `git merge --no-ff` / `git checkout` / `git worktree add` in
 * the integration worktree, on the host, and git obediently executes the agent's "hook" — uncontained,
 * with the parent's full environment and every secret the provider env-scrub exists to withhold.
 * `diff.external` (we run `git diff` to build the reviewer's patch) and `core.fsmonitor` are the same
 * story with different knobs.
 *
 * Two independent defences, and we test both:
 *   1. agents cannot write git configuration at all — it is not in the writable set; and
 *   2. every parent git call neutralizes the config knobs that can name a program to run, so a
 *      hostile git config is INERT even when one arrives some other way (a pre-existing global config,
 *      a repo the user cloned, a future regression in (1)).
 *
 * Defence (2) is tested by planting exactly the config an attacker wants and proving the hook never
 * fires. HOME is redirected to a temp dir for the duration, which is where git reads global config.
 */

const HOME = process.env.HOME;

afterEach(() => {
  if (HOME === undefined) delete process.env.HOME;
  else process.env.HOME = HOME;
});

/** Raw, UNHARDENED git — what any naive caller runs. Used to prove the trap actually fires. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Git for FIXTURE setup only. Hooks are off, so the scaffolding can never plant the marker itself
 *  (git fires `post-index-change` on a plain `git add`, which would frame the product for the
 *  fixture's own hook execution). Anything that trips the marker after setup is the PRODUCT. */
function gitSetup(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A disposable repo, plus a hostile HOME whose global git config runs `hook` on every git verb. */
function repoWithHostileGlobalConfig(): { repoDir: string; fakeHome: string; marker: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "loop-githard-"));
  registerOwnedTemp(repoDir);
  const fakeHome = mkdtempSync(join(tmpdir(), "loop-githome-"));
  registerOwnedTemp(fakeHome);

  const hookDir = join(fakeHome, "evil-hooks");
  mkdirSync(hookDir, { recursive: true });
  const marker = join(fakeHome, "PWNED");

  // One script, installed under EVERY hook name git might run for our verbs. If any of them ever
  // executes, it drops the marker — the proof of host code execution.
  for (const hook of ["pre-commit", "post-commit", "prepare-commit-msg", "commit-msg", "post-checkout", "pre-merge-commit", "post-merge", "post-index-change", "reference-transaction"]) {
    const path = join(hookDir, hook);
    writeFileSync(path, `#!/usr/bin/env bash\necho pwned > ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(path, 0o755);
  }

  // Exactly what a hostile agent would write with a writable ~/.gitconfig.
  writeFileSync(
    join(fakeHome, ".gitconfig"),
    ["[user]", "  name = t", "  email = t@t.t", "[core]", `  hooksPath = ${hookDir}`, "[commit]", "  gpgsign = false", ""].join("\n")
  );

  process.env.HOME = fakeHome;

  gitSetup(repoDir, ["init", "-q"]);
  gitSetup(repoDir, ["config", "user.email", "t@t.t"]);
  gitSetup(repoDir, ["config", "user.name", "t"]);
  gitSetup(repoDir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoDir, "README.md"), "# fixture\n");
  gitSetup(repoDir, ["add", "-A"]);
  gitSetup(repoDir, ["commit", "-qm", "baseline"]);

  // The scaffolding above must leave the trap UNSPRUNG, or every assertion below is meaningless.
  expect(existsSync(marker)).toBe(false);

  return { repoDir, fakeHome, marker };
}

describe("parent git is hardened against config-driven code execution", () => {
  it("a hostile global core.hooksPath cannot execute a hook through the loop's git calls", () => {
    const { repoDir, marker } = repoWithHostileGlobalConfig();

    // Sanity: the trap is real. Plain git (as any unhardened caller would run it) DOES fire the hook.
    // Without this, a hardening bug and a broken fixture look identical — both just never fire.
    writeFileSync(join(repoDir, "bait.txt"), "bait\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-qm", "bait"]);
    expect(existsSync(marker)).toBe(true); // ← the attack works against unhardened git
    rmSync(marker, { force: true });

    // Now the product's own path: create the integration worktree (git worktree add + checkout) and
    // commit into it (git add -A + commit) — the exact verbs the loop runs on the host.
    const target = prepareExecutionTarget(repoDir, "hard", "run1");
    writeFileSync(join(target.integration.path, "feature.txt"), "ok\n");
    const committed = commitAll(target.integration.path, "loop: attempt");

    expect(committed).toBe(true); // the loop's git still WORKS (identity from global config intact)…
    expect(existsSync(marker)).toBe(false); // …and not one hook ran.
  }, 30000);

  it("still commits when the global config is the ONLY source of user identity", () => {
    // The hardening must not nuke the global config wholesale: a real user's user.name/user.email
    // live there, and commits into loop-owned worktrees have to keep working.
    const { repoDir, marker } = repoWithHostileGlobalConfig();
    // Remove the repo-local identity so ONLY the (hostile) global config can supply it.
    gitSetup(repoDir, ["config", "--unset", "user.email"]);
    gitSetup(repoDir, ["config", "--unset", "user.name"]);

    const target = prepareExecutionTarget(repoDir, "hard", "run2");
    writeFileSync(join(target.integration.path, "feature.txt"), "ok\n");

    expect(commitAll(target.integration.path, "loop: attempt")).toBe(true);
    expect(git(target.integration.path, ["log", "-1", "--format=%ae"])).toBe("t@t.t");
    expect(existsSync(marker)).toBe(false);
  }, 30000);
});

describe("agents are never given writable git configuration", () => {
  it("the provider's writable roots contain no git config path (~/.gitconfig, ~/.config)", () => {
    const home = mkdtempSync(join(tmpdir(), "loop-home-"));
    registerOwnedTemp(home);
    // Create every candidate the old list bound writable, so `existsSync` cannot hide a regression.
    for (const dir of [".claude", ".codex", ".gemini", ".cache", ".config", ".config/git"]) {
      mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
    }
    writeFileSync(join(home, ".gitconfig"), "[user]\n  name = t\n");
    process.env.HOME = home;

    const work = mkdtempSync(join(tmpdir(), "loop-work-"));
    registerOwnedTemp(work);
    const { writableRoot, extraWritable } = providerWritableRoots(work, "claude");

    expect(writableRoot).toBe(work);
    // Nothing git can read configuration from may be writable by an agent.
    expect(extraWritable).not.toContain(resolve(home, ".gitconfig"));
    expect(extraWritable).not.toContain(resolve(home, ".config")); // holds ~/.config/git/config
    for (const root of extraWritable) {
      expect(root.endsWith(".gitconfig")).toBe(false);
      expect(root).not.toBe(resolve(home, ".config"));
      // …and no bind may CONTAIN git's XDG config dir.
      expect(resolve(home, ".config/git").startsWith(`${root}/`)).toBe(false);
    }
    // Only the selected provider's exact state is present; cross-provider state and a broad cache
    // are not capabilities of a Claude turn.
    expect(extraWritable).toContain(resolve(home, ".claude"));
    expect(extraWritable).not.toContain(resolve(home, ".codex"));
    expect(extraWritable).not.toContain(resolve(home, ".gemini"));
    expect(extraWritable).not.toContain(resolve(home, ".cache"));
  });
});

describe("the destructive git primitives are gone from the package surface", () => {
  it("exports no resetHard/revertWorkingTree (nothing can hard-reset an arbitrary checkout)", async () => {
    const gitModule = await import("../src/git.js");
    expect("resetHard" in gitModule).toBe(false);
    expect("revertWorkingTree" in gitModule).toBe(false);

    // And the public package barrel does not smuggle them out either.
    const index = await import("../src/index.js");
    expect("resetHard" in index).toBe(false);
    expect("revertWorkingTree" in index).toBe(false);

    // The source carries no `reset --hard` / `clean -fd` against a caller-supplied path at all.
    const src = readFileSync(resolve(import.meta.dirname, "../src/git.ts"), "utf8");
    expect(src).not.toMatch(/"reset",\s*"--hard"/);
    expect(src).not.toMatch(/"clean",\s*"-fd"/);
  });
});
