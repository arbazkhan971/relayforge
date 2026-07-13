import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Git checkpoint / rollback / diff helpers for the verification gate.
 *
 * The autonomy loop snapshots HEAD before an agent works, captures the diff for the
 * critic, reverts the working tree if the change regresses the test suite, and hashes the
 * project's test files to detect reward-hacking (an agent weakening its own grader to
 * pass). All commands degrade to no-ops when the working dir is not a git repo.
 */

/**
 * Git is a CONFIGURABLE CODE EXECUTOR, and the parent runs it on the host, OUTSIDE the sandbox that
 * contains the agents — so every parent git call is hardened against config-driven execution.
 *
 * The attack this closes: an agent turn is sandboxed, but a sandbox only says WHERE it may write.
 * Give it a writable `~/.gitconfig` (we used to) and it needs no escape at all — it just writes
 *
 *     [core] hooksPath = /path/inside/its/own/worktree
 *
 * and waits. The parent later runs `git merge --no-ff` / `git checkout` / `git worktree add` in the
 * integration worktree ON THE HOST, git dutifully executes the agent's "hook", and the agent is now
 * running uncontained with the parent's full environment — every secret the provider env-scrub was
 * built to withhold. `git diff` (which we run to build the reviewer's patch) is the same story via
 * `diff.external`, and `core.fsmonitor` is a third.
 *
 * Two independent defences, either of which alone closes it:
 *   1. agents cannot write git configuration at all (see `providerWritableRoots`), and
 *   2. these flags — the parent neutralizes every config knob that can name a program to run, so a
 *      hostile git config is inert even if one arrives some other way (a pre-existing global config,
 *      a future regression in (1), a repo the user cloned).
 *
 * `-c` beats every config file, so this cannot be overridden by global/system/repo config. We do NOT
 * null the global config wholesale: a real user's `user.name`/`user.email` live there, and commits
 * made in loop-owned worktrees must keep working.
 */
const HARDENED_CONFIG = [
  "-c", "core.hooksPath=/dev/null",   // no hook may ever run — repo, global, or planted
  "-c", "core.fsmonitor=false",       // fsmonitor names a program to exec
  "-c", "diff.external=",             // `git diff` must not shell out to an external differ
  "-c", "credential.helper=",         // no credential helper may exec on our behalf
  "-c", "core.pager=cat"              // never hand output to a pager program
];

/** The environment for a parent git call: the env knobs that mirror the config knobs above. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // never block waiting on a terminal prompt
    GIT_EXTERNAL_DIFF: "",    // env twin of diff.external
    GIT_PAGER: "cat"
  };
}

/** Run a hardened parent git command. Every parent git call in the product goes through here or
 *  its worktree.ts twin — never a bare `spawnSync("git", …)`. */
export function runGit(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync("git", [...HARDENED_CONFIG, ...args], { cwd, encoding: "utf8", env: gitEnv() });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim()
  };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = runGit(cwd, args);
  return { ok: r.ok, out: r.out };
}


export function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

export function headSha(cwd: string): string | undefined {
  const r = git(cwd, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : undefined;
}

/** The canonical top-level of the working tree (its absolute path), for repo identity. */
export function gitTopLevel(cwd: string): string | undefined {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.out ? r.out : undefined;
}

/** The repository's root (parentless) commit — a stable identity that survives branch/HEAD moves. */
export function repoRootCommit(cwd: string): string | undefined {
  const r = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]);
  if (!r.ok || !r.out) return undefined;
  return r.out.split("\n").map((l) => l.trim()).filter(Boolean).sort()[0];
}

/** Diff of the working tree (staged + unstaged) since a base sha, capped for prompt size. */
export function workingDiff(cwd: string, baseSha: string | undefined, maxChars = 16_000): string {
  const args = baseSha ? ["diff", baseSha, "--"] : ["diff", "HEAD", "--"];
  const r = git(cwd, args);
  // Include untracked files' presence so the reviewer knows new files exist.
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).out;
  let diff = r.out;
  if (untracked) diff += `\n\n# New untracked files:\n${untracked}`;
  return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…(diff truncated)…` : diff;
}

/** List changed files (tracked and untracked) in porcelain format. */
export function changedFiles(cwd: string, baseSha?: string): string[] {
  const status = git(cwd, baseSha ? ["diff", "--name-only", baseSha, "--"] : ["status", "--porcelain"]);
  if (!status.out) return [];

  if (!baseSha) {
    return status.out
      .split("\n")
      .map((line) => line.trim())
      .map((line) => line.replace(/^\s*[MADRCU?]{1,2}\s+/, ""))
      .filter((line) => line.length > 0)
      .map((line) => line.split(" -> ")[1] ?? line)
      .filter(Boolean);
  }

  return status.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// REMOVED: `resetHard(cwd, ref)` and `revertWorkingTree(cwd)`.
//
// Both ran `git reset --hard` / `git checkout -- .` + `git clean -fd` against an ARBITRARY caller-
// supplied cwd. They had zero callers in the product — the regression gate never reverts anything;
// it declines to PUBLISH a bad candidate, which is strictly stronger (the branch never moves). But
// `src/index.ts` re-exports this module, so they shipped in the package's public API: two functions
// whose whole job is to irrecoverably destroy uncommitted work, one import away from a user's
// checkout, in a product whose central promise is "we never touch your working tree".
//
// The safest destructive primitive is the one that does not exist. If a future feature genuinely
// needs to reset a LOOP-OWNED worktree, it should take a Worktree (an ownership-proving type), not a
// bare path.

/** Has the working tree changed since the snapshot? (Did the agent actually do anything?) */
export function hasChanges(cwd: string): boolean {
  const tracked = git(cwd, ["status", "--porcelain"]).out;
  return tracked.length > 0;
}

/**
 * Hash the project's test/CI files so we can detect if an agent modified its own grader.
 * Returns a single digest over the named files' contents (missing files contribute "").
 */
export function hashFiles(cwd: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const full = resolve(cwd, file);
    hash.update(file);
    hash.update("\0");
    hash.update(existsSync(full) ? readFileSync(full) : Buffer.from(""));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Best-effort discovery of the files that constitute the "grader" — test files and CI
 * config. We forbid agents from changing these during implementation tasks so a passing
 * verification actually means something.
 */
export function discoverTestFiles(cwd: string): string[] {
  const tracked = git(cwd, ["ls-files"]).out;
  if (!tracked) return [];
  const patterns = [
    /(^|\/)tests?\//i,
    /(^|\/)__tests__\//,
    /\.(test|spec)\.[jt]sx?$/,
    /_test\.go$/,
    /(^|\/)test_.*\.py$/,
    /\.(yml|yaml)$/i // CI workflows
  ];
  return tracked
    .split("\n")
    .map((l) => l.trim())
    .filter((f) => f && patterns.some((p) => p.test(f)))
    .filter((f) => !f.includes("node_modules"))
    .slice(0, 400);
}
