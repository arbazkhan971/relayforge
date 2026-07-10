import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isGitRepo } from "./git.js";

/**
 * Git-worktree isolation per role.
 *
 * For the SME team to work in TRUE parallel without clobbering each other, each role
 * implements on its own branch in its own working directory. We use `git worktree` so
 * every agent shares the same object store (cheap, fast) but has an isolated checkout.
 * node_modules is symlinked from the main checkout so installs aren't duplicated.
 *
 * Worktrees live under `.loop/wt/<runId>/<role>` on branch `loop/<runId>/<role>`. They are
 * removed when their work merges back. If the working dir is not a git repo, isolation is
 * a no-op and every role shares the main cwd (parallelism must then stay disabled).
 */

export type Worktree = {
  role: string;
  path: string;
  branch: string;
  /** false means fallback to `mainCwd` because isolation is not possible this run */
  isolated: boolean;
  reason?: string;
};

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function worktreesSupported(mainCwd: string): boolean {
  return isGitRepo(mainCwd);
}

function branchName(runId: string, role: string): string {
  return `loop/${runId}/${role}`.replace(/[^a-zA-Z0-9_./-]/g, "-");
}

/**
 * Worktrees live OUTSIDE the repo (under the OS temp dir, keyed by a hash of the repo
 * path) so they never nest inside the repo's own `.loop/` dir or get picked up by git
 * status. The `.loop` blackboard is symlinked back in so agents share one board.
 */
function worktreeRoot(mainCwd: string, runId: string): string {
  const key = createHash("sha1").update(resolve(mainCwd)).digest("hex").slice(0, 12);
  return resolve(tmpdir(), "loop-orchestrator-wt", `${basename(mainCwd)}-${key}`, runId);
}

/**
 * Create (or reuse) a worktree for a role. Returns the isolated path the agent should run
 * in. Falls back to the main cwd when worktrees aren't supported.
 */
export function ensureWorktree(mainCwd: string, runId: string, role: string): Worktree {
  const branch = branchName(runId, role);
  const path = resolve(worktreeRoot(mainCwd, runId), role);

  if (!worktreesSupported(mainCwd)) {
    return { role, path: mainCwd, branch, isolated: false, reason: "worktrees unsupported" };
  }
  if (existsSync(resolve(path, ".git"))) {
    return { role, path, branch, isolated: true };
  }

  mkdirSync(worktreeRoot(mainCwd, runId), { recursive: true });

  // Create the branch from current HEAD, then add the worktree. If the branch exists
  // (re-run), add without -b.
  const base = git(mainCwd, ["rev-parse", "HEAD"]).out || "HEAD";
  let res = git(mainCwd, ["worktree", "add", "-b", branch, path, base]);
  if (!res.ok && /already exists|already used/i.test(res.err)) {
    res = git(mainCwd, ["worktree", "add", path, branch]);
  }
  if (!res.ok) {
    // Could not isolate — degrade to the main cwd so the run still proceeds.
    return {
      role,
      path: mainCwd,
      branch,
      isolated: false,
      reason: res.err || "git worktree add failed"
    };
  }

  linkSharedDirs(mainCwd, path);
  return { role, path, branch, isolated: true };
}

/**
 * Symlink shared dirs into the worktree so agents resolve them at the same relative path:
 *  - node_modules: avoid duplicating installs.
 *  - .loop: the shared blackboard lives here; an agent that writes board events from its
 *    worktree must hit the SAME board the orchestrator reads.
 */
function linkSharedDirs(mainCwd: string, worktreePath: string): void {
  for (const dir of ["node_modules", ".loop"]) {
    const src = resolve(mainCwd, dir);
    const dest = resolve(worktreePath, dir);
    if (existsSync(src) && !existsSync(dest)) {
      try {
        symlinkSync(src, dest, "dir");
      } catch {
        // best-effort: a missing symlink just means the worktree installs its own deps
      }
    }
  }
}

/**
 * Merge a role's worktree branch back into the main branch with --no-ff. Returns whether
 * the merge applied cleanly; on conflict we abort so a human/critic can resolve rather
 * than leaving the tree half-merged.
 */
export function mergeWorktree(mainCwd: string, wt: Worktree): { ok: boolean; reason?: string } {
  if (!worktreesSupported(mainCwd) || !wt.isolated || wt.path === mainCwd) return { ok: true };
  // Commit any pending work in the worktree first (agents may not have committed).
  git(wt.path, ["add", "-A"]);
  const pending = git(wt.path, ["status", "--porcelain"]).out;
  if (pending) git(wt.path, ["commit", "-m", `loop: ${wt.role} work`]);

  const merge = git(mainCwd, ["merge", "--no-ff", "-m", `Merge ${wt.branch}`, wt.branch]);
  if (!merge.ok) {
    git(mainCwd, ["merge", "--abort"]);
    return { ok: false, reason: merge.err || "merge conflict" };
  }
  return { ok: true };
}

export function removeWorktree(mainCwd: string, wt: Worktree): void {
  if (!worktreesSupported(mainCwd) || wt.path === mainCwd) return;
  git(mainCwd, ["worktree", "remove", "--force", wt.path]);
}

/** Tear down every worktree created for a run (cleanup at the end / on stop). */
export function cleanupRunWorktrees(mainCwd: string, runId: string, roles: string[]): void {
  if (!worktreesSupported(mainCwd)) return;
  for (const role of roles) {
    const path = resolve(worktreeRoot(mainCwd, runId), role);
    if (existsSync(path)) git(mainCwd, ["worktree", "remove", "--force", path]);
  }
  git(mainCwd, ["worktree", "prune"]);
}
