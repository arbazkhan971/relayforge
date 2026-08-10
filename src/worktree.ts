import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isGitRepo, runGit } from "./git.js";
import { assertId, containedJoin, containsSymlink, isOwned, markOwned } from "./ids.js";

/**
 * Git-worktree isolation — the human gate.
 *
 * Execution NEVER touches the human's checkout. Two kinds of loop-owned worktrees exist,
 * both created with `git worktree` (shared object store, isolated checkout) and living OUTSIDE
 * the repo under a PRIVATE, per-repo, per-PROJECT, per-run root in the OS temp dir. Every run
 * root carries an ownership manifest; recursive cleanup refuses to delete anything that does not
 * carry it, and refuses to follow a symlink out of the root.
 *
 * A git worktree is NOT a host sandbox — it only isolates the working tree and branch. Untrusted
 * command execution (verifiers) is separately confined by the OS sandbox (src/sandbox.ts).
 *
 * We only ever run mutating git commands (`reset`/`clean`/`merge`/`commit`) inside these
 * loop-owned worktrees — never in the human's checkout.
 */

export type Worktree = {
  role: string;
  path: string;
  branch: string;
  isolated: boolean;
  reason?: string;
};

export type ExecutionTarget = {
  integration: Worktree;
  baseSha: string;
  baseBranch: string;
};

/**
 * Every git command here runs on the HOST, outside the sandbox that contains the agents — and these
 * are the hook-running verbs (`merge`, `checkout`, `worktree add`, `commit`). They go through the
 * hardened runner so no git CONFIG can name a program for git to execute on our behalf. See the
 * `HARDENED_CONFIG` comment in src/git.ts for the escape this closes.
 */
function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  return runGit(cwd, args);
}

export function worktreesSupported(mainCwd: string): boolean {
  return isGitRepo(mainCwd);
}

/** A git ref built ONLY from pre-validated identifiers (project, runId, taskId). */
export function integrationBranchName(project: string, runId: string): string {
  return `loop/${assertId("project", project)}/${assertId("run", runId)}/integration`;
}

function attemptBranchName(project: string, runId: string, taskId: string, attempt: number): string {
  return `loop/${assertId("project", project)}/${assertId("run", runId)}/${assertId("task", taskId)}/a${attempt}`;
}

/**
 * PRIVATE per-repo/per-project/per-run worktree root. Keyed by a hash of the (resolved) repo
 * path so worktrees never nest in the repo, and namespaced by project so two projects that share
 * a run id can never collide on disk. Marked with an ownership manifest on creation.
 */
export function worktreeRoot(mainCwd: string, project: string, runId: string): string {
  assertId("project", project);
  assertId("run", runId);
  const key = createHash("sha1").update(resolve(mainCwd)).digest("hex").slice(0, 12);
  return resolve(tmpdir(), "loop-orchestrator-wt", `${basename(mainCwd)}-${key}`, project, runId);
}

export function currentBranch(cwd: string): string {
  const r = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.out : "HEAD";
}

function dirtyPaths(cwd: string, ignore: string[]): string[] {
  const norm = ignore.map((p) => p.replace(/\/+$/, ""));
  return git(cwd, ["status", "--porcelain"]).out
    .split("\n")
    .map((l) => l.slice(3).trim())
    .map((p) => p.replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .filter((p) => !norm.some((ig) => p === ig || p.startsWith(`${ig}/`)));
}

export function isCleanWorktree(cwd: string, ignore: string[] = []): boolean {
  return dirtyPaths(cwd, ignore).length === 0;
}

/**
 * Validate the human gate and set up the integration worktree. Throws with an actionable
 * message when the target is not safe to execute against. NEVER mutates `mainCwd`.
 */
export function prepareExecutionTarget(mainCwd: string, project: string, runId: string, ignore: string[] = []): ExecutionTarget {
  if (!worktreesSupported(mainCwd)) {
    throw new Error(
      "Execution requires a git repository. Run `git init` and commit a baseline before `loop run --execute`."
    );
  }
  if (!isCleanWorktree(mainCwd, ignore)) {
    throw new Error(
      "Execution requires a clean git working tree. Commit or stash your changes first — the loop will never touch your checked-out branch."
    );
  }
  const baseSha = git(mainCwd, ["rev-parse", "HEAD"]).out;
  if (!baseSha) {
    throw new Error("Execution requires at least one commit. Create an initial commit first.");
  }
  const baseBranch = currentBranch(mainCwd);
  const branch = integrationBranchName(project, runId);
  if (branch === baseBranch) {
    throw new Error(`Refusing to run: the integration branch ${branch} is the checked-out branch.`);
  }

  const root = worktreeRoot(mainCwd, project, runId);
  mkdirSync(root, { recursive: true });
  markOwned(root, { project, runId, repo: resolve(mainCwd) });
  const path = containedJoin(root, "integration");

  if (existsSync(resolve(path, ".git"))) {
    return { integration: { role: "integration", path, branch, isolated: true }, baseSha, baseBranch };
  }

  let res = git(mainCwd, ["worktree", "add", "-b", branch, path, baseSha]);
  if (!res.ok && /already exists|already used|already checked out/i.test(res.err)) {
    res = git(mainCwd, ["worktree", "add", path, branch]);
  }
  if (!res.ok) {
    throw new Error(`Could not create the integration worktree: ${res.err || "git worktree add failed"}`);
  }
  return { integration: { role: "integration", path, branch, isolated: true }, baseSha, baseBranch };
}

export function integrationTip(integration: Worktree): string | undefined {
  const r = git(integration.path, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : undefined;
}

/**
 * Create a fresh attempt worktree for a task attempt, branched from the current integration tip.
 * Each attempt gets its own branch so nothing collides. No shared dependency directories are
 * linked in — the attempt tree is self-contained, and verifiers read the repo's deps read-only
 * through the OS sandbox rather than via a writable symlink.
 */
export function createAttemptWorktree(
  mainCwd: string,
  project: string,
  runId: string,
  integration: Worktree,
  taskId: string,
  attempt: number
): Worktree {
  const branch = attemptBranchName(project, runId, taskId, attempt);
  const root = worktreeRoot(mainCwd, project, runId);
  mkdirSync(containedJoin(root, "attempts"), { recursive: true });
  const path = containedJoin(root, "attempts", `${assertId("task", taskId)}-a${attempt}`);
  if (existsSync(path)) removeWorktree(mainCwd, { role: taskId, path, branch, isolated: true }, project, runId);

  const base = integrationTip(integration) ?? integration.branch;
  let res = git(mainCwd, ["worktree", "add", "-b", branch, path, base]);
  if (!res.ok && /already exists|already used/i.test(res.err)) {
    git(mainCwd, ["branch", "-D", branch]);
    res = git(mainCwd, ["worktree", "add", "-b", branch, path, base]);
  }
  if (!res.ok) {
    return { role: taskId, path: mainCwd, branch, isolated: false, reason: res.err || "git worktree add failed" };
  }
  return { role: taskId, path, branch, isolated: true };
}

/**
 * Create a SEPARATE, detached, read-only-intent checkout pinned to a specific immutable commit
 * OID — used to review the exact artifact. Because HEAD is detached at the OID, any writes the
 * reviewer makes stay in this throwaway checkout and can never alter the attempt branch or what
 * ships (we merge the OID, not this checkout).
 */
export function createReviewCheckout(mainCwd: string, project: string, runId: string, taskId: string, oid: string): Worktree {
  const root = worktreeRoot(mainCwd, project, runId);
  mkdirSync(containedJoin(root, "review"), { recursive: true });
  const path = containedJoin(root, "review", `${assertId("task", taskId)}-${oid.slice(0, 12)}`);
  if (existsSync(path)) removeWorktree(mainCwd, { role: `review-${taskId}`, path, branch: "", isolated: true }, project, runId);
  const res = git(mainCwd, ["worktree", "add", "--detach", path, oid]);
  if (!res.ok) return { role: `review-${taskId}`, path: mainCwd, branch: "", isolated: false, reason: res.err || "review checkout failed" };
  return { role: `review-${taskId}`, path, branch: "", isolated: true };
}

export function commitAll(worktreePath: string, message: string): boolean {
  git(worktreePath, ["add", "-A"]);
  const pending = git(worktreePath, ["status", "--porcelain"]).out;
  if (!pending) return false;
  return git(worktreePath, ["commit", "--no-verify", "-m", message]).ok;
}

/** The immutable OID at the tip of an attempt branch (what review/merge pin to). */
export function attemptCommitOid(attempt: Worktree): string | undefined {
  const r = git(attempt.path, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : undefined;
}

export type PatchArtifact = { ok: boolean; sha256: string; bytes: number; patch: string; path?: string; reason?: string };

/**
 * Capture the COMPLETE `base..HEAD` patch by STREAMING git's stdout straight to `outPath` — no
 * in-memory buffer that could silently truncate a multi-megabyte diff (the wave-2 bug: a 2.5 MB
 * diff captured as 1.1 MB and hashed as "full"). Requires git to exit 0, includes BINARY patches
 * (`--binary`), and hashes the EXACT bytes on disk. A capture failure returns `ok:false` so callers
 * fail closed — the persisted artifact is a prerequisite for review/acceptance, never best-effort.
 */
export function captureAttemptPatch(attempt: Worktree, baseRef: string, outPath: string): PatchArtifact {
  let fd: number;
  try {
    fd = openSync(outPath, "w", 0o600);
  } catch (error) {
    return { ok: false, sha256: "", bytes: 0, patch: "", reason: `cannot open artifact ${outPath}: ${(error as Error).message}` };
  }
  let status: number | null;
  let err = "";
  try {
    // stdout → file descriptor (streamed, unbounded on disk); only stderr uses a (small) buffer.
    const r = spawnSync("git", ["-C", attempt.path, "diff", "--binary", baseRef, "HEAD", "--"], {
      stdio: ["ignore", fd, "pipe"],
      maxBuffer: 4 * 1024 * 1024
    });
    status = r.status;
    err = (r.stderr ?? Buffer.from("")).toString();
    if (r.error) err = `${err} ${r.error.message}`.trim();
  } finally {
    closeSync(fd);
  }
  if (status !== 0) {
    return { ok: false, sha256: "", bytes: 0, patch: "", reason: err || `git diff exited ${status}` };
  }
  const buf = readFileSync(outPath); // exact bytes, binary-safe
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { ok: true, sha256, bytes: buf.length, patch: buf.toString("utf8"), path: outPath };
}

/**
 * The COMPLETE base-SHA patch string for an attempt, with `maxChars` truncating ONLY the value
 * handed to a reviewer PROMPT (for token budget). Integrity is preserved separately via the
 * immutable commit OID and the exact-byte hash of the on-disk artifact (see captureAttemptPatch).
 */
export function attemptDiff(attempt: Worktree, baseRef: string, maxChars = 20_000): string {
  const art = attemptPatchArtifact(attempt, baseRef);
  const diff = art.ok ? art.patch || "(no changes)" : `(diff unavailable: ${art.reason})`;
  return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…(diff truncated for prompt; full patch hashed in the artifact)…` : diff;
}

/** The FULL (untruncated) patch plus its exact-byte sha256, captured via a streamed temp file. */
export function attemptPatchArtifact(attempt: Worktree, baseRef: string): PatchArtifact {
  const tmp = resolve(tmpdir(), `loop-patch-${process.pid}-${randomBytes(6).toString("hex")}.patch`);
  const art = captureAttemptPatch(attempt, baseRef, tmp);
  try {
    unlinkSync(tmp);
  } catch {
    // best-effort
  }
  return { ...art, path: undefined };
}

export type MergeCandidate = { ok: boolean; candidate?: string; reason?: string };

/**
 * Build an IMMUTABLE merge candidate WITHOUT moving the integration branch, so it can be verified
 * before it is ever published.
 *
 * The integration worktree is DETACHED at `expectedOld` (the integration tip we read and intend to
 * replace) and the reviewed immutable `oid` is merged onto it (`--no-ff`). This produces a new merge
 * commit that HEAD points at, but the integration BRANCH REF is left untouched at `expectedOld`. We
 * merge the OID (not a branch name) so a reviewer that mutated the attempt branch after review cannot
 * change what ships. On conflict we abort and reattach the worktree, leaving the branch unmoved.
 *
 * The returned `candidate` is a plain object OID that never changes; verification runs against it in
 * the (still detached) worktree, and only `publishCandidate` can make it the integration tip — via an
 * atomic compare-and-swap. This is NOT a check-then-merge: nothing about the live branch is mutated
 * here, so there is no window in which an unverified change is the integration tip.
 */
export function buildMergeCandidate(
  integration: Worktree,
  attempt: Worktree,
  oid: string | undefined,
  expectedOld: string,
  message: string
): MergeCandidate {
  if (!attempt.isolated) return { ok: false, reason: "attempt was not isolated" };
  if (!oid) return { ok: false, reason: "no immutable oid to merge" };
  if (!expectedOld) return { ok: false, reason: "cannot read integration tip to build candidate on" };
  // Detach exactly at the tip we intend to replace. If the worktree cannot detach there, fail closed.
  const detach = git(integration.path, ["checkout", "--detach", expectedOld]);
  if (!detach.ok) return { ok: false, reason: detach.err || `cannot detach at ${expectedOld.slice(0, 12)}` };
  const merge = git(integration.path, ["merge", "--no-ff", "-m", message, oid]);
  if (!merge.ok) {
    git(integration.path, ["merge", "--abort"]);
    reattachIntegration(integration); // leave the branch (unmoved) checked out
    return { ok: false, reason: merge.err || "merge conflict" };
  }
  const candidate = git(integration.path, ["rev-parse", "HEAD"]).out;
  if (!/^[0-9a-f]{40}$/.test(candidate)) {
    reattachIntegration(integration);
    return { ok: false, reason: "could not resolve candidate commit oid" };
  }
  return { ok: true, candidate };
}

/**
 * Publish a verified candidate as the integration tip via an ATOMIC compare-and-swap:
 * `git update-ref refs/heads/<integration> <candidate> <expectedOld>`. update-ref takes the lock and
 * refuses the move if the ref is not EXACTLY `expectedOld` — so ANY external movement of the
 * integration branch since we read `expectedOld` (a rewind, a reset, OR a strictly-forward advance by
 * another writer) fails the swap. On failure NOTHING is clobbered and the external state is preserved
 * as evidence; the caller reattaches via `abandonCandidate`. On success the worktree is reattached to
 * the (now advanced) branch so its checkout matches the published tip.
 */
export function publishCandidate(integration: Worktree, candidate: string, expectedOld: string): { ok: boolean; reason?: string } {
  if (!/^[0-9a-f]{40}$/.test(candidate)) return { ok: false, reason: "invalid candidate oid" };
  if (!/^[0-9a-f]{40}$/.test(expectedOld)) return { ok: false, reason: "invalid expected-old oid" };
  const ref = `refs/heads/${integration.branch}`;
  const swap = git(integration.path, ["update-ref", ref, candidate, expectedOld]);
  if (!swap.ok) {
    return { ok: false, reason: swap.err || `CAS refused: ${integration.branch} is not at ${expectedOld.slice(0, 12)}` };
  }
  // Point the worktree back at the branch, which now equals the candidate — a clean fast-forward of
  // the checkout, never a rewind of published history.
  reattachIntegration(integration);
  return { ok: true };
}

/**
 * Abandon a built-but-unpublished candidate: reattach the worktree to the integration branch, which
 * was never moved. This is NON-destructive — it discards only the detached candidate commit (still
 * reachable via reflog) and leaves the integration branch (and any external advance of it) exactly as
 * it was. It replaces the old `resetIntegrationTo`, which force-rewound published history.
 */
export function abandonCandidate(integration: Worktree): void {
  reattachIntegration(integration);
}

/** Reattach the integration worktree to its branch (from a detached candidate HEAD). */
function reattachIntegration(integration: Worktree): void {
  // `--force` discards the detached candidate's working-tree state so the checkout matches the branch
  // tip; it never moves the branch ref, so no published history is lost.
  git(integration.path, ["checkout", "--force", integration.branch]);
}

/**
 * Remove a single worktree. Refuses to touch the human's checkout, anything outside the run's
 * private owned root, or a path reached through a symlink.
 */
export function removeWorktree(mainCwd: string, wt: Worktree, project: string, runId: string): void {
  if (!worktreesSupported(mainCwd) || wt.path === mainCwd) return;
  const root = worktreeRoot(mainCwd, project, runId);
  const rel = relative(root, resolve(wt.path));
  if (rel.startsWith("..") || rel === "") return; // outside the owned root — never delete
  if (!isOwned(root)) return; // no ownership manifest — refuse
  if (containsSymlink(wt.path)) return; // don't follow a planted symlink out
  git(mainCwd, ["worktree", "remove", "--force", wt.path]);
  if (existsSync(wt.path)) {
    try {
      rmSync(wt.path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Tear down every worktree created for a run, but LEAVE the integration branch in the repo so
 * the human can inspect and merge accepted work. Attempt branches are deleted. Only ever removes
 * paths under the run's private OWNED root, and never follows a symlink out of it.
 */
export function cleanupRun(mainCwd: string, project: string, runId: string): void {
  if (!worktreesSupported(mainCwd)) return;
  const root = worktreeRoot(mainCwd, project, runId);
  if (!isOwned(root)) return; // refuse to delete anything we did not create
  const list = git(mainCwd, ["worktree", "list", "--porcelain"]).out;
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wtPath = line.slice("worktree ".length).trim();
    const rel = relative(root, resolve(wtPath));
    if (!rel.startsWith("..") && rel !== "" && !containsSymlink(wtPath)) {
      git(mainCwd, ["worktree", "remove", "--force", wtPath]);
    }
  }
  git(mainCwd, ["worktree", "prune"]);
  const prefix = `loop/${project}/${runId}/`;
  const branches = git(mainCwd, ["branch", "--list", `${prefix}*`]).out;
  const integration = integrationBranchName(project, runId);
  for (const raw of branches.split("\n")) {
    const b = raw.replace(/^[*+]?\s*/, "").trim();
    if (b && b !== integration) git(mainCwd, ["branch", "-D", b]);
  }
  if (existsSync(root) && !containsSymlink(root)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
